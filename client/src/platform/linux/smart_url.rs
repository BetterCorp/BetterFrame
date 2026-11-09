use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use gtk4::{gio, glib, prelude::*};
use webkit6::prelude::*;

use crate::bundle::{SmartUrlConfig, SmartUrlStep};
use crate::core::smart_url::{SmartUrlProgress, login_url_matches};

struct Runner {
    config: SmartUrlConfig,
    progress: RefCell<SmartUrlProgress>,
    server_url: String,
    kiosk_key: String,
}

pub(super) struct Controller(Rc<Runner>);

impl Controller {
    pub(super) fn stop(&self) {
        self.0.progress.borrow_mut().stop();
    }
}

impl Drop for Controller {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Installed exactly once, before the first load, on a newly created WebView.
/// The native cursor survives navigation; the page never owns sequence state.
pub(super) fn install(
    webview: &webkit6::WebView,
    config: SmartUrlConfig,
    server_url: &str,
    kiosk_key: &str,
) -> Option<Controller> {
    if config.steps.is_empty()
        || config
            .login_detect_url
            .as_deref()
            .is_none_or(|s| s.trim().is_empty())
    {
        return None;
    }
    let runner = Rc::new(Runner {
        config,
        progress: RefCell::new(SmartUrlProgress::default()),
        server_url: server_url.into(),
        kiosk_key: kiosk_key.into(),
    });
    let controller = Controller(runner.clone());
    let state = runner.clone();
    webview.connect_load_changed(move |wv, event| match event {
        webkit6::LoadEvent::Started => state.progress.borrow_mut().load_started(),
        webkit6::LoadEvent::Finished => {
            observe_url(wv, &state);
            drive(wv, &state);
        }
        _ => {}
    });
    let state = runner.clone();
    webview.connect_load_failed(move |_, _, _, error| {
        if !error.matches(webkit6::NetworkError::Cancelled) {
            state.progress.borrow_mut().stop();
        }
        false
    });

    // Also detect client-side routing/session expiry without a full page load.
    // One transition into the login prefix permits one retry. Staying on auth
    // (including changed OAuth query parameters) never loops the automation.
    let interval = runner.config.session_check_interval_ms.unwrap_or(5000);
    if interval > 0
        && runner
            .config
            .login_detect_url
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
    {
        let weak = webview.downgrade();
        glib::timeout_add_local(
            Duration::from_millis(u64::from(interval.max(200))),
            move || {
                let Some(wv) = weak.upgrade() else {
                    return glib::ControlFlow::Break;
                };
                if !wv.is_loading() {
                    observe_url(&wv, &runner);
                    drive(&wv, &runner);
                }
                glib::ControlFlow::Continue
            },
        );
    }
    Some(controller)
}

fn observe_url(webview: &webkit6::WebView, runner: &Runner) {
    if let Some(url) = webview.uri() {
        runner
            .progress
            .borrow_mut()
            .observe_url(&url, runner.config.login_detect_url.as_deref());
    }
}

fn confirm_settled_page(webview: &webkit6::WebView, runner: &Rc<Runner>) {
    if !runner.progress.borrow().is_complete() {
        return;
    }
    let Some(url) = webview.uri() else {
        return;
    };
    let prefix = runner.config.login_detect_url.as_deref().unwrap_or("");
    if login_url_matches(&url, prefix) {
        return;
    }
    let generation = runner.progress.borrow().generation();
    let weak = webview.downgrade();
    let runner = runner.clone();
    // Client-side redirects can report Finished for an intermediate page.
    // Never arm retries until the final non-login URL has actually settled.
    glib::timeout_add_local_once(Duration::from_secs(1), move || {
        if let Some(wv) = weak.upgrade() {
            if !wv.is_loading()
                && wv.uri().as_ref() == Some(&url)
                && runner.progress.borrow().generation() == generation
            {
                runner.progress.borrow_mut().confirm_authenticated();
            }
        }
    });
}

fn drive(webview: &webkit6::WebView, runner: &Rc<Runner>) {
    if webview.is_loading() {
        return;
    }
    let next = runner
        .progress
        .borrow_mut()
        .take_step(runner.config.steps.len());
    let Some((index, generation)) = next else {
        confirm_settled_page(webview, runner);
        return;
    };
    let step = &runner.config.steps[index];
    if step.step_type == "navigate" {
        let target = step.url.as_deref().and_then(|target| {
            webview
                .uri()
                .and_then(|current| url::Url::parse(&current).ok())
                .and_then(|base| base.join(target).ok())
        });
        if let Some(target) = target {
            // Advance before navigation, resume only on the destination's load.
            super::load_webview_url(
                webview,
                target.as_str(),
                &runner.server_url,
                &runner.kiosk_key,
            );
            // A fragment-only navigation may not produce load signals.
            let weak = webview.downgrade();
            let runner = runner.clone();
            glib::timeout_add_local_once(Duration::from_millis(50), move || {
                if let Some(wv) = weak.upgrade() {
                    if !wv.is_loading()
                        && runner.progress.borrow_mut().finish_step(generation, true)
                    {
                        observe_url(&wv, &runner);
                        drive(&wv, &runner);
                    }
                }
            });
        } else {
            runner.progress.borrow_mut().stop();
            tracing::warn!(
                "smart URL step {} has an invalid navigation target",
                index + 1
            );
        }
        return;
    }

    let body = step_javascript(step);
    let weak = webview.downgrade();
    let runner = runner.clone();
    webview.call_async_javascript_function(
        &body,
        None,
        None,
        None,
        None::<&gio::Cancellable>,
        move |result| {
            // Give a click/script-triggered navigation time to emit Started.
            // A stale callback then cannot execute steps in the old document.
            glib::timeout_add_local_once(Duration::from_millis(50), move || {
                let Some(wv) = weak.upgrade() else { return };
                let success = result.as_ref().is_ok_and(|value| value.to_boolean());
                if runner
                    .progress
                    .borrow_mut()
                    .finish_step(generation, success)
                {
                    drive(&wv, &runner);
                } else if !success && !wv.is_loading() {
                    // Never log scripts, field values, or URLs containing tokens.
                    tracing::warn!("smart URL step {} did not complete", index + 1);
                }
            });
        },
    );
}

fn js_string(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize")
}

fn step_javascript(step: &SmartUrlStep) -> String {
    let selector = step
        .selector
        .as_deref()
        .map(js_string)
        .unwrap_or_else(|| "null".into());
    let action = match step.step_type.as_str() {
        "fill" => {
            let Some(value) = step.value.as_deref() else {
                return "return false;".into();
            };
            format!(
                r#"
                const el = findElement({selector});
                if (!el) return false;
                const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
                if (setter) setter.call(el, {value}); else el.value = {value};
                el.dispatchEvent(new Event('input', {{bubbles:true}}));
                el.dispatchEvent(new Event('change', {{bubbles:true}}));
                return true;
            "#,
                value = js_string(value)
            )
        }
        "click" => format!(
            "const el = findElement({selector}); if (!el) return false; el.click(); return true;"
        ),
        "wait" => format!(
            "await new Promise(resolve => setTimeout(resolve, {})); return true;",
            step.delay_ms.unwrap_or(1000)
        ),
        "wait_for" => format!(
            r#"
            const deadline = Date.now() + {};
            do {{
                if (findElement({selector})) return true;
                if (Date.now() >= deadline) return false;
                await new Promise(resolve => setTimeout(resolve, 100));
            }} while (true);
        "#,
            step.timeout_ms.unwrap_or(10000)
        ),
        "javascript" => format!(
            "await (async () => {{\n{}\n}})(); return true;",
            step.script.as_deref().unwrap_or("")
        ),
        _ => "return false;".into(),
    };
    format!(
        r#"
        function findElement(selector, root = document) {{
            const found = root.querySelector(selector);
            if (found) return found;
            for (const element of root.querySelectorAll('*')) {{
                if (element.shadowRoot) {{
                    const child = findElement(selector, element.shadowRoot);
                    if (child) return child;
                }}
            }}
            return null;
        }}
        {action}
    "#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    use std::time::Instant;

    struct Fixture {
        root: String,
        hits: Arc<Mutex<HashMap<String, usize>>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Fixture {
        fn new() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let root = format!("http://{}", listener.local_addr().unwrap());
            let hits = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let thread_hits = hits.clone();
            let thread_stop = stop.clone();
            let thread = std::thread::spawn(move || {
                while !thread_stop.load(Ordering::Relaxed) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    };
                    stream
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .unwrap();
                    let mut bytes = [0; 8192];
                    let Ok(length) = stream.read(&mut bytes) else {
                        continue;
                    };
                    let request = String::from_utf8_lossy(&bytes[..length]);
                    let path = request
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .split('?')
                        .next()
                        .unwrap_or("/");
                    *thread_hits.lock().unwrap().entry(path.into()).or_default() += 1;
                    let (status, headers, body) = match path {
                        "/redirect" => ("302 Found", "Location: /lovelace/2\r\n", ""),
                        "/lovelace/2" => (
                            "200 OK",
                            "",
                            "<script>location.replace('/auth/authorize?client_id=unknown&state=random')</script>",
                        ),
                        "/auth/form" => (
                            "200 OK",
                            "",
                            r#"<div id="host"></div><script>
                            const root = document.getElementById('host').attachShadow({mode:'open'});
                            root.innerHTML = '<input id="username"><button id="login">Login</button>';
                            root.querySelector('#login').onclick = () => {
                                if (root.querySelector('#username').value === 'person@example.test') location.href = '/done';
                            };
                        </script>"#,
                        ),
                        "/done" => ("200 OK", "", "<div id='done'>Dashboard</div>"),
                        _ => (
                            "200 OK",
                            "",
                            "<div id='page'>Login or already authenticated page</div>",
                        ),
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\n{headers}Content-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });
            Self {
                root,
                hits,
                stop,
                thread: Some(thread),
            }
        }

        fn count(&self, path: &str) -> usize {
            *self.hits.lock().unwrap().get(path).unwrap_or(&0)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            self.thread.take().unwrap().join().unwrap();
        }
    }

    fn pump(duration: Duration) {
        let context = glib::MainContext::default();
        let deadline = Instant::now() + duration;
        while Instant::now() < deadline {
            while context.pending() {
                context.iteration(false);
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn wait_until(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !ready() && Instant::now() < deadline {
            pump(Duration::from_millis(10));
        }
        assert!(ready(), "WebKit regression scenario timed out");
        pump(Duration::from_millis(250));
    }

    fn cell(fixture: &Fixture, block: &str, steps: serde_json::Value) -> crate::bundle::BundleCell {
        serde_json::from_value(serde_json::json!({
            "view_id": block, "entity_id":"home-assistant", "row":0, "col":0,
            "row_span":1, "col_span":1, "content_type":"web",
            "web_url":format!("{}/redirect", fixture.root),
            "smart_url":{"login_detect_url":"/auth", "session_check_interval_ms":200, "steps":steps}
        }))
        .unwrap()
    }

    fn browser(cell: &crate::bundle::BundleCell) -> (String, webkit6::WebView) {
        let key = super::super::web_cell_key("display", "layout", cell);
        let wv = super::super::ensure_web(
            key.clone(),
            super::super::WebSource::Url(cell.web_url.as_deref().unwrap()),
            "http://frame.invalid",
            "test-key",
            cell.local_storage.as_ref(),
            cell.smart_url.as_ref(),
            None,
        );
        (key, wv)
    }

    #[test]
    #[ignore = "requires an X/Wayland display and WebKit subprocesses; run with xvfb-run"]
    fn smart_url_browser_regression() {
        gtk4::init().unwrap();
        let fixture = Fixture::new();
        let steps = serde_json::json!([
            {"type":"navigate","url":"/auth/form?dynamic_oauth_state=123"},
            {"type":"wait_for","selector":"#username"},
            {"type":"fill","selector":"#username","value":"person@example.test"},
            {"type":"click","selector":"#login"},
            {"type":"wait_for","selector":"#done"},
            {"type":"javascript","script":"await fetch('/success');"}
        ]);
        let first = cell(&fixture, "first", steps.clone());
        let second = cell(&fixture, "second", steps);
        let (first_key, first_wv) = browser(&first);
        let (second_key, second_wv) = browser(&second);
        assert_ne!(first_key, second_key);
        assert_ne!(first_wv, second_wv);
        let window = gtk4::Window::new();
        let row = gtk4::Box::new(gtk4::Orientation::Horizontal, 0);
        row.append(&first_wv);
        row.append(&second_wv);
        window.set_child(Some(&row));
        window.present();
        wait_until(|| fixture.count("/success") == 2);
        assert_eq!(
            fixture.count("/auth/form"),
            2,
            "each independent browser runs once across redirects"
        );
        assert_eq!(
            browser(&first).1,
            first_wv,
            "unchanged settings reuse the existing page"
        );
        first_wv.load_uri(&format!("{}/done", fixture.root));
        wait_until(|| !first_wv.is_loading());
        pump(Duration::from_millis(400));
        assert_eq!(
            fixture.count("/success"),
            2,
            "normal reloads never replay authentication"
        );
        pump(Duration::from_millis(1100)); // the authenticated destination settles
        first_wv.load_uri(&format!("{}/auth/authorize?expired=1", fixture.root));
        wait_until(|| fixture.count("/success") == 3);

        let stay = cell(
            &fixture,
            "stay",
            serde_json::json!([
                {"type":"javascript","script":"await fetch('/stay-run');"},
                {"type":"navigate","url":"/lovelace/2"}
            ]),
        );
        let (stay_key, stay_wv) = browser(&stay);
        row.append(&stay_wv);
        wait_until(|| {
            fixture.count("/stay-run") == 1
                && stay_wv
                    .uri()
                    .is_some_and(|url| url.contains("/auth/authorize"))
                && !stay_wv.is_loading()
        });
        pump(Duration::from_millis(700));
        assert_eq!(
            fixture.count("/stay-run"),
            1,
            "remaining on auth does not cause repeated retries"
        );

        let mut healthy = cell(
            &fixture,
            "healthy",
            serde_json::json!([{"type":"javascript","script":"await fetch('/unexpected');"}]),
        );
        healthy.web_url = Some(format!("{}/healthy", fixture.root));
        let (_, healthy_wv) = browser(&healthy);
        row.append(&healthy_wv);
        wait_until(|| {
            healthy_wv
                .uri()
                .is_some_and(|url| url.ends_with("/healthy"))
                && !healthy_wv.is_loading()
        });
        pump(Duration::from_millis(400));
        assert_eq!(
            fixture.count("/unexpected"),
            0,
            "authenticated pages skip the entire sequence"
        );

        let edited = cell(
            &fixture,
            "first",
            serde_json::json!([
                {"type":"javascript","script":"await fetch('/edited');"}
            ]),
        );
        let (edited_key, edited_wv) = browser(&edited);
        assert_ne!(
            edited_wv, first_wv,
            "editing auth replaces the browser at the same URL"
        );
        row.append(&edited_wv);
        super::super::purge_obsolete_webviews(&HashSet::from([
            edited_key,
            second_key.clone(),
            stay_key.clone(),
        ]));
        wait_until(|| fixture.count("/edited") == 1);

        let mut removed = first.clone();
        removed.smart_url = None;
        let (manual_key, manual_wv) = browser(&removed);
        assert_ne!(
            manual_wv, first_wv,
            "removing auth replaces the browser at the same URL"
        );
        row.append(&manual_wv);
        super::super::purge_obsolete_webviews(&HashSet::from([manual_key, second_key, stay_key]));
        first_wv.load_uri(&format!("{}/auth/authorize?old=1", fixture.root));
        edited_wv.load_uri(&format!("{}/auth/authorize?removed=1", fixture.root));
        wait_until(|| {
            manual_wv
                .uri()
                .is_some_and(|url| url.contains("/auth/authorize"))
                && !manual_wv.is_loading()
        });
        pump(Duration::from_millis(400));
        assert_eq!(
            fixture.count("/success"),
            3,
            "removed settings stop old controllers and leave manual login stable"
        );
        assert_eq!(
            fixture.count("/edited"),
            1,
            "edited settings are also stopped when removed"
        );
        super::super::purge_obsolete_webviews(&HashSet::new());
        window.close();
    }
}
