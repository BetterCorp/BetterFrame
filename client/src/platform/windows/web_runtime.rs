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
    Loading,
    Loaded,
    Document(u64, Option<String>),
    Result(u64, u64, usize, bool),
}
pub(super) type Events = Arc<Mutex<Vec<Event>>>;

struct Sequence {
    id: u64,
    steps: Vec<SmartUrlStep>,
    progress: SmartUrlProgress,
    flight: Option<(u64, Instant, usize)>,
    request: Option<WebActionRequest>,
}
impl Sequence {
    fn new(id: u64, steps: Vec<SmartUrlStep>) -> Self {
        Self {
            id,
            steps,
            progress: SmartUrlProgress::default(),
            flight: None,
            request: None,
        }
    }
    fn navigation(&mut self, elapsed: Duration) {
        self.progress.load_started_for_steps(&self.steps, elapsed);
        self.flight = None;
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
    pending_load: bool,
    loaded: bool,
    failed: bool,
    epoch: u64,
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
            pending_load: true,
            loaded: false,
            failed: false,
            epoch: 0,
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
        self.visible = visible;
        let _ = self.view.set_visible(visible);
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
    fn tick(&mut self) {
        let now = self.started.elapsed();
        let events = std::mem::take(&mut *self.events.lock().unwrap());
        for event in events {
            match event {
                Event::Loading => {
                    self.loaded = false;
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
                Event::Loaded => {
                    let events = self.events.clone();
                    let epoch = self.epoch;
                    let result = self.view.evaluate_script_with_callback(
                        "document.documentURI",
                        move |json| {
                            let uri = serde_json::from_str::<String>(&json).ok();
                            events.lock().unwrap().push(Event::Document(epoch, uri));
                        },
                    );
                    if result.is_err() {
                        self.failed = true;
                    }
                }
                Event::Document(epoch, uri) if epoch == self.epoch => {
                    self.failed = uri.is_none_or(|u| {
                        u.starts_with("chrome-error:") || u.starts_with("edge-error:")
                    });
                    self.loaded = !self.failed;
                    self.last_check = None;
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
                            s.progress.finish_step(generation, success, now);
                            s.flight = None;
                        }
                    }
                }
                _ => {}
            }
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
        if self.manual.is_none() && self.loaded && !self.failed {
            let interval = Duration::from_millis(
                self.config
                    .as_ref()
                    .and_then(|c| c.session_check_interval_ms)
                    .unwrap_or(5000)
                    .max(200) as u64,
            );
            if self.last_check.is_none_or(|at| at.elapsed() >= interval) {
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
            if self.visible && self.pending_load && self.ready(&url) {
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
        if let Some(s) = self.manual.as_mut() {
            if self.loaded && !self.failed {
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
        let script = format!(
            "window.__bfStep?.id === '{id}:{generation}:{index}' ? window.__bfStep.result : null"
        );
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
    let Some((index, generation)) = sequence.progress.take_step(sequence.steps.len(), now) else {
        return;
    };
    let step = &sequence.steps[index];
    if step.step_type == "navigate" {
        let target = view
            .url()
            .ok()
            .and_then(|u| url::Url::parse(&u).ok())
            .and_then(|u| u.join(step.url.as_deref()?).ok());
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
        // Load-start invalidates this acknowledgment and resumes on its destination.
        events.lock().unwrap().push(Event::Result(
            sequence.id,
            generation,
            index,
            result.is_ok(),
        ));
        sequence.flight = Some((generation, Instant::now() + Duration::from_secs(30), index));
        return;
    }
    let id = sequence.id;
    let script = format!(
        "(()=>{{ const state={{id:'{id}:{generation}:{index}',result:null}}; window.__bfStep=state; (async()=>{{ {} }})().then(result=>state.result=!!result,()=>state.result=false); }})()",
        crate::core::web_steps::step_javascript(step)
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
    for file in files.flatten().take(32) {
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
