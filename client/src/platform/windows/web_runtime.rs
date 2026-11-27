//! Native WebView2 automation. Progress belongs to a block, never a document.
use super::*;
use crate::bundle::{SmartUrlConfig, SmartUrlStep, WebActions};
use crate::core::{
    commands::WebActionRequest,
    smart_url::{SmartUrlProgress, login_url_matches},
};
use std::ops::Deref;

#[derive(Debug)]
pub(super) enum Event {
    Navigating(String),
    Loaded,
    Document(u64, Option<Document>),
    Result(u64, u64, usize, bool),
}
#[derive(Debug, Deserialize)]
pub(super) struct Document {
    #[serde(default)]
    id: Option<String>,
    uri: String,
    ready: String,
}

pub(super) type Events = Arc<Mutex<Vec<Event>>>;

struct Sequence {
    id: u64,
    steps: Vec<SmartUrlStep>,
    progress: SmartUrlProgress,
    flight: Option<(u64, Instant, usize)>,
    request: Option<WebActionRequest>,
    resume_after: Option<Instant>,
}
impl Sequence {
    fn new(id: u64, steps: Vec<SmartUrlStep>) -> Self {
        Self {
            id,
            steps,
            progress: SmartUrlProgress::default(),
            flight: None,
            request: None,
            resume_after: None,
        }
    }
    fn navigation(&mut self, elapsed: Duration) {
        self.progress.load_started_for_steps(&self.steps, elapsed);
        self.flight = None;
        self.resume_after = None;
    }
}

pub(super) struct Entry {
    view: WebView,
    pub events: Events,
    auth: Option<Sequence>,
    config: Option<SmartUrlConfig>,
    actions: Option<WebActions>,
    manual: Option<Sequence>,
    pub display: String,
    pub layout: String,
    pub cell: String,
    server: String,
    key: String,
    visible: bool,
    bounds: WebRect,
    pending_load: bool,
    loaded: bool,
    failed: bool,
    epoch: u64,
    document_id: Option<String>,
    awaiting_document: bool,
    navigation_deadline: Option<Instant>,
    next_id: u64,
    started: Instant,
    last_check: Option<Instant>,
    settled: Option<(String, Instant)>,
}
impl Deref for Entry {
    type Target = WebView;
    fn deref(&self) -> &WebView {
        &self.view
    }
}
impl Drop for Entry {
    fn drop(&mut self) {
        if let Some(request) = self.manual.as_mut().and_then(|s| s.request.take()) {
            report(
                &self.server,
                &self.key,
                request,
                Err("View disposed".into()),
            );
        }
    }
}
impl Entry {
    pub fn new(
        view: WebView,
        events: Events,
        cell: Option<&BundleCell>,
        layout: &str,
        display: &str,
        state: &ClientState,
        bounds: WebRect,
    ) -> Self {
        let config = cell.and_then(|c| c.smart_url.clone());
        Self {
            view,
            events,
            auth: config.as_ref().map(|c| Sequence::new(0, c.steps.clone())),
            config,
            actions: cell.and_then(|c| c.web_actions.clone()),
            manual: None,
            display: display.into(),
            layout: layout.into(),
            cell: cell.and_then(|c| c.view_id.clone()).unwrap_or_default(),
            server: state.server_url.clone(),
            key: state.kiosk_key.clone().unwrap_or_default(),
            visible: true,
            bounds,
            pending_load: true,
            loaded: false,
            failed: false,
            epoch: 0,
            document_id: None,
            awaiting_document: true,
            navigation_deadline: None,
            next_id: 1,
            started: Instant::now(),
            last_check: None,
            settled: None,
        }
    }
    pub fn show(&mut self, visible: bool) {
        if visible && !self.visible {
            self.pending_load = true;
            self.last_check = None;
        }
        if self.visible != visible {
            self.visible = visible;
            let _ = self.view.set_visible(visible);
        }
    }
    pub fn resize(&mut self, bounds: WebRect) {
        if self.bounds != bounds {
            self.bounds = bounds;
            let _ = self.view.set_bounds(bounds);
        }
    }
    fn ready(&self, url: &str) -> bool {
        self.loaded
            && !self.failed
            && self.settled.as_ref().is_some_and(|(settled, at)| {
                settled == url && at.elapsed() >= Duration::from_secs(1)
            })
            && self
                .auth
                .as_ref()
                .is_none_or(|s| !s.progress.is_running() && !s.progress.has_failed())
            && !self
                .config
                .as_ref()
                .and_then(|c| c.login_detect_url.as_deref())
                .is_some_and(|p| login_url_matches(url, p))
    }
    fn start(&mut self, steps: Vec<SmartUrlStep>, request: Option<WebActionRequest>) {
        let mut sequence = Sequence::new(self.next_id, steps);
        self.next_id += 1;
        sequence.progress.start_sequence();
        sequence.request = request;
        self.manual = Some(sequence);
    }
    pub fn invoke(&mut self, request: WebActionRequest) -> Result<(), String> {
        let url = self.view.url().unwrap_or_default();
        let config = self
            .actions
            .as_ref()
            .ok_or("Block has no web action groups")?;
        if request.revision != config.revision {
            return Err("Block configuration changed; waiting for bundle refresh".into());
        }
        if !self.visible || !self.ready(&url) {
            return Err("Block is not ready".into());
        }
        if self.pending_load || self.manual.is_some() {
            return Err("Another sequence is pending or running in this block".into());
        }
        let steps = config
            .groups
            .get(&request.group)
            .ok_or("Group not found")?
            .clone();
        self.start(steps, Some(request));
        Ok(())
    }
    fn load_started(&mut self, now: Duration) {
        // Redirects invalidate document callbacks, but must not
        // discard the accepted action's bounded navigation wait.
        self.navigation_deadline = self
            .navigation_deadline
            .into_iter()
            .chain(
                self.auth
                    .as_ref()
                    .and_then(|s| s.flight.map(|(_, deadline, _)| deadline)),
            )
            .chain(
                self.manual
                    .as_ref()
                    .and_then(|s| s.flight.map(|(_, deadline, _)| deadline)),
            )
            .min();
        self.loaded = false;
        self.awaiting_document = true;
        self.failed = false;
        self.epoch += 1;
        self.settled = None;
        if let Some(s) = self.auth.as_mut() {
            s.navigation(now);
        }
        if let Some(s) = self.manual.as_mut() {
            s.navigation(now);
        }
    }
    fn tick(&mut self) {
        let now = self.started.elapsed();
        let events = std::mem::take(&mut *self.events.lock().unwrap());
        for event in events {
            #[cfg(test)]
            if self.cell == "block0" {
                eprintln!(
                    "Browser event {event:?}; loaded={}, failed={}, document={:?}, awaiting={}, navigation_deadline={:?}, manual_flight={:?}",
                    self.loaded,
                    self.failed,
                    self.document_id,
                    self.awaiting_document,
                    self.navigation_deadline
                        .map(|d| d.saturating_duration_since(Instant::now())),
                    self.manual.as_ref().and_then(|s| s.flight)
                );
            }
            match event {
                Event::Navigating(target) => {
                    let fragment = self
                        .settled
                        .as_ref()
                        .is_some_and(|(source, _)| fragment_navigation(source, &target));
                    if !fragment {
                        self.load_started(now);
                    }
                }
                Event::Loaded => {
                    self.epoch += 1; // Ignore probes from an earlier completed/canceled navigation.
                    let events = self.events.clone();
                    let epoch = self.epoch;
                    let result = self.view.evaluate_script_with_callback(
                        "({id:window.__betterframe_document_id,uri:document.documentURI,ready:document.readyState})",
                        move |json| {
                            let uri = serde_json::from_str::<Document>(&json).ok();
                            events.lock().unwrap().push(Event::Document(epoch, uri));
                        },
                    );
                    if result.is_err() {
                        self.failed = true;
                    }
                }
                Event::Document(epoch, Some(document)) if epoch == self.epoch => {
                    if document.uri.starts_with("chrome-error:")
                        || document.uri.starts_with("edge-error:")
                    {
                        self.failed = true;
                        self.loaded = false;
                        self.navigation_deadline = None;
                    } else {
                        let new_document = document.id.is_some() && document.id != self.document_id;
                        if document.ready == "complete"
                            && document.id.is_some()
                            && (!self.awaiting_document || new_document)
                        {
                            let changed = new_document || !self.loaded;
                            self.document_id = document.id;
                            self.loaded = true;
                            self.failed = false;
                            self.awaiting_document = false;
                            self.navigation_deadline = None;
                            if changed {
                                self.last_check = None;
                            }
                        }
                    }
                    // Canceled script probes and an old completed document can
                    // arrive during a new load. Same-document SPA URL changes
                    // must never downgrade a healthy page to "loading".
                }
                Event::Result(id, generation, index, success) => {
                    let sequence = if id == 0 {
                        self.auth.as_mut()
                    } else {
                        self.manual.as_mut().filter(|s| s.id == id)
                    };
                    if let Some(s) = sequence {
                        if s.progress.generation() == generation
                            && s.flight
                                .is_some_and(|(g, _, i)| g == generation && i == index)
                        {
                            let _ = self.view.evaluate_script(&format!(
                                "delete window.__bfSteps?.['{id}:{generation}:{index}']"
                            ));
                            s.progress.finish_step(generation, success, now);
                            s.flight = None;
                            // Click/script navigation can emit Started after its
                            // JS completion. Match Linux's deferred continuation.
                            s.resume_after = Some(Instant::now() + Duration::from_millis(50));
                        }
                    }
                }
                _ => {}
            }
        }
        if self
            .navigation_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            self.navigation_deadline = None;
            self.loaded = false;
            self.failed = true;
            warn!(block = %self.cell, "web automation navigation timed out");
        }
        if self.failed {
            if let Some(s) = self.auth.as_mut() {
                s.progress.reset_after_page_failure();
            }
            if let Some(s) = self.manual.as_mut() {
                s.progress.fail(now);
            }
        }
        let url = self.view.url().unwrap_or_default();
        if !self.loaded || self.failed {
            self.settled = None;
        } else if self.settled.as_ref().is_none_or(|(u, _)| u != &url) {
            self.settled = Some((url.clone(), Instant::now()));
        }
        // Named groups own the page until completion. On-load actions instead
        // wait for entity auth, including a login redirect during their run.
        let auth_paused = self.manual.as_ref().is_some_and(|s| s.request.is_some());
        if !auth_paused && self.loaded && !self.failed {
            let interval_ms = self
                .config
                .as_ref()
                .and_then(|c| c.session_check_interval_ms)
                .unwrap_or(5000);
            let periodic_due = interval_ms > 0
                && self.last_check.is_some_and(|at| {
                    at.elapsed() >= Duration::from_millis(interval_ms.max(200) as u64)
                });
            // Loading, remapping and action completion explicitly clear the
            // last check, even when periodic observation is disabled.
            let action_login = self.manual.as_ref().is_some_and(|s| s.request.is_none())
                && self
                    .config
                    .as_ref()
                    .and_then(|c| c.login_detect_url.as_deref())
                    .is_some_and(|prefix| login_url_matches(&url, prefix));
            if self.last_check.is_none() || periodic_due || action_login {
                self.last_check = Some(Instant::now());
                if let Some(s) = self.auth.as_mut() {
                    s.progress.observe_url(
                        &url,
                        self.config
                            .as_ref()
                            .and_then(|c| c.login_detect_url.as_deref()),
                        now,
                    );
                }
            }
            if let Some(s) = self.auth.as_mut() {
                drive(&self.view, &self.events, s, &self.server, &self.key, now);
            }
            if self.ready(&url) {
                if let Some(s) = self.auth.as_mut() {
                    s.progress.confirm_authenticated();
                }
            }
            if self.manual.is_none() && self.visible && self.pending_load && self.ready(&url) {
                self.pending_load = false;
                if let Some(steps) = self
                    .actions
                    .as_ref()
                    .map(|a| a.on_load.clone())
                    .filter(|s| !s.is_empty())
                {
                    self.start(steps, None);
                }
            }
        }
        let auth_ready = self.ready(&url);
        if let Some(s) = self.manual.as_mut() {
            if self.loaded
                && !self.failed
                && (s.request.is_some() || auth_ready || s.flight.is_some())
            {
                drive(&self.view, &self.events, s, &self.server, &self.key, now);
            }
            if s.progress.is_complete() || s.progress.has_failed() {
                let mut sequence = self.manual.take().unwrap();
                let result = if sequence.progress.is_complete() {
                    Ok(())
                } else {
                    Err("Web action step failed".into())
                };
                if let Some(request) = sequence.request.take() {
                    report(&self.server, &self.key, request, result);
                }
                self.last_check = None;
            }
        }
    }
}

fn fragment_navigation(source: &str, target: &str) -> bool {
    url::Url::parse(source)
        .ok()
        .zip(url::Url::parse(target).ok())
        .is_some_and(|(source, target)| {
            let mut from = source.clone();
            let mut to = target.clone();
            from.set_fragment(None);
            to.set_fragment(None);
            from == to && source.fragment() != target.fragment()
        })
}

fn drive(
    view: &WebView,
    events: &Events,
    sequence: &mut Sequence,
    server: &str,
    key: &str,
    now: Duration,
) {
    if let Some((generation, deadline, index)) = sequence.flight {
        if deadline <= Instant::now() {
            sequence.progress.fail(now);
            sequence.flight = None;
            return;
        }
        let id = sequence.id;
        let events = events.clone();
        // The async body reports a plain boolean when complete. WebView2's
        // ExecuteScript does not await a returned Promise.
        let script = format!("window.__bfSteps?.['{id}:{generation}:{index}']?.result ?? null");
        let _ = view.evaluate_script_with_callback(&script, move |json| {
            if let Ok(success) = serde_json::from_str::<bool>(&json) {
                events
                    .lock()
                    .unwrap()
                    .push(Event::Result(id, generation, index, success));
            }
        });
        return;
    }
    if sequence
        .resume_after
        .is_some_and(|deadline| Instant::now() < deadline)
    {
        return;
    }
    let Some((index, generation)) = sequence.progress.take_step(sequence.steps.len(), now) else {
        return;
    };
    let step = &sequence.steps[index];
    let body = if step.step_type == "navigate" {
        let source = view.url().ok().and_then(|u| url::Url::parse(&u).ok());
        let target = source
            .as_ref()
            .and_then(|u| u.join(step.url.as_deref()?).ok());
        let fragment_only = source
            .as_ref()
            .zip(target.as_ref())
            .is_some_and(|(source, target)| {
                let mut from = source.clone();
                let mut to = target.clone();
                from.set_fragment(None);
                to.set_fragment(None);
                from == to && source.fragment() != target.fragment()
            });
        if fragment_only {
            format!(
                "location.hash = {}; return true;",
                serde_json::to_string(target.unwrap().fragment().unwrap_or("")).unwrap()
            )
        } else {
            let result = target
                .ok_or_else(|| "Invalid navigation".to_string())
                .and_then(|target| {
                    if same_origin(target.as_str(), server) && !key.is_empty() {
                        let mut headers = wry::http::HeaderMap::new();
                        headers.insert(
                            wry::http::header::AUTHORIZATION,
                            wry::http::HeaderValue::from_str(&format!("Bearer {key}"))
                                .map_err(|e| e.to_string())?,
                        );
                        view.load_url_with_headers(target.as_str(), headers)
                            .map_err(|e| e.to_string())
                    } else {
                        view.load_url(target.as_str()).map_err(|e| e.to_string())
                    }
                });
            // Keep the step busy until Started invalidates its generation.
            // Submission of Navigate is not completion: WebView2 may emit its
            // load events well after this call returns. Resume on Finished.
            if result.is_ok() {
                sequence.flight =
                    Some((generation, Instant::now() + Duration::from_secs(30), index));
            } else {
                sequence.progress.finish_step(generation, false, now);
            }
            return;
        }
    } else {
        crate::core::web_steps::step_javascript(step)
    };
    let id = sequence.id;
    let script = format!(
        "(()=>{{ const state={{result:null}}; window.__bfSteps ||= Object.create(null); window.__bfSteps['{id}:{generation}:{index}']=state; (async()=>{{ {} }})().then(result=>state.result=!!result,()=>state.result=false); }})()",
        body
    );
    let timeout = if step.step_type == "wait" {
        step.delay_ms.unwrap_or(1000)
    } else {
        step.timeout_ms.unwrap_or(30000)
    };
    sequence.flight = Some((
        generation,
        Instant::now() + Duration::from_millis(timeout as u64) + Duration::from_secs(5),
        index,
    ));
    if view.evaluate_script(&script).is_err() {
        sequence.progress.finish_step(generation, false, now);
        sequence.flight = None;
    }
}

#[derive(Serialize, Deserialize)]
struct PendingAction {
    request: WebActionRequest,
    renderer_id: u32,
    created_at: u64,
}
fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
pub(super) fn enqueue(
    request: WebActionRequest,
    app: &Arc<Mutex<Option<Child>>>,
) -> Result<(), String> {
    let renderer_id = {
        let mut app = app.lock().unwrap();
        let child = app.as_mut().ok_or("Renderer is unavailable")?;
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            return Err("Renderer is unavailable".into());
        }
        child.id()
    };
    let path = state_dir()
        .join("web-action-inbox")
        .join(format!("{}.json", safe_request_id(&request.request_id)?));
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let envelope = PendingAction {
        request,
        renderer_id,
        created_at: timestamp(),
    };
    write_protected(
        &path,
        &serde_json::to_vec(&envelope).map_err(|e| e.to_string())?,
    )
}

pub(super) fn safe_request_id(id: &str) -> Result<&str, String> {
    if id.is_empty()
        || id.len() > 100
        || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("Invalid web action request ID".into());
    }
    Ok(id)
}
pub(super) fn report(
    server: &str,
    key: &str,
    request: WebActionRequest,
    result: Result<(), String>,
) {
    let server = server.to_owned();
    let key = key.to_owned();
    std::thread::spawn(move || {
        let _ = crate::network::blocking_client().post(format!("{server}/api/kiosk/web-actions/result"))
            .bearer_auth(key).json(&serde_json::json!({"request_id":request.request_id,"display_id":request.display_id,
                "cell_id":request.cell_id,"group":request.group,"ok":result.is_ok(),"error":result.err()}))
            .timeout(Duration::from_secs(10)).send();
    });
}
pub(super) fn tick() {
    WEBVIEWS.with(|views| {
        for entry in views.borrow_mut().values_mut() {
            entry.tick();
        }
    });
    let directory = state_dir().join("web-action-inbox");
    let Ok(files) = fs::read_dir(directory) else {
        return;
    };
    for file in files
        .flatten()
        .filter(|file| file.path().extension().is_some_and(|ext| ext == "json"))
        .take(32)
    {
        let path = file.path();
        let request = read_protected_or_plain(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PendingAction>(&bytes).ok());
        let _ = fs::remove_file(path);
        let Some(envelope) = request else {
            continue;
        };
        let request = envelope.request;
        let state = load_state();
        let expired = envelope.renderer_id != std::process::id()
            || timestamp().saturating_sub(envelope.created_at) > 5000;
        let result = if expired {
            Err("Renderer restarted or request expired".into())
        } else {
            WEBVIEWS.with(|views| {
                let mut views = views.borrow_mut();
                let entry = views
                    .values_mut()
                    .find(|v| {
                        v.display == request.display_id
                            && v.layout == request.layout_id
                            && v.cell == request.cell_id
                            && v.visible
                    })
                    .ok_or("Block is not active on the requested display".to_string())?;
                entry.invoke(request.clone())
            })
        };
        if let Err(error) = result {
            report(
                &state.server_url,
                state.kiosk_key.as_deref().unwrap_or(""),
                request,
                Err(error),
            );
        }
    }
}

#[cfg(test)]
#[path = "web_runtime_tests.rs"]
mod tests;
