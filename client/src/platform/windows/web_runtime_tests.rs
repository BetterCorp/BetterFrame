use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use windows_sys::Win32::UI::WindowsAndMessaging::{PM_REMOVE, PeekMessageW};

struct Fixture {
    root: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
    results: Arc<Mutex<Vec<serde_json::Value>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Fixture {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let hits = Arc::new(Mutex::new(HashMap::new()));
        let received = hits.clone();
        let results = Arc::new(Mutex::new(Vec::new()));
        let reported = results.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = [0; 8192];
                let Ok(count) = stream.read(&mut bytes) else {
                    continue;
                };
                if count == 0 {
                    continue;
                }
                let mut request = bytes[..count].to_vec();
                while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                    let Ok(count) = stream.read(&mut bytes) else {
                        break;
                    };
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..count]);
                }
                let header_end = request.windows(4).position(|b| b == b"\r\n\r\n").unwrap() + 4;
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                let path = headers
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("/")
                    .split('?')
                    .next()
                    .unwrap_or("/")
                    .to_owned();
                while request.len() < header_end + length {
                    let Ok(count) = stream.read(&mut bytes) else {
                        break;
                    };
                    if count == 0 {
                        break;
                    }
                    request.extend_from_slice(&bytes[..count]);
                }
                if path == "/api/kiosk/web-actions/result" {
                    reported
                        .lock()
                        .unwrap()
                        .push(serde_json::from_slice(&request[header_end..]).unwrap());
                }
                *received.lock().unwrap().entry(path.clone()).or_insert(0) += 1;
                let (status, header, body) = match path.as_str() {
                    "/start" => (
                        "302 Found",
                        "Location: /auth/authorize?state=unknown\r\n",
                        "",
                    ),
                    "/auth/form" => (
                        "200 OK",
                        "",
                        r#"<div id=host></div><script>const root=document.querySelector('#host').attachShadow({mode:'open'}); root.innerHTML='<input id=username><button id=login>Login</button>';root.querySelector('#login').onclick=()=>{if(root.querySelector('#username').value==='person@example.test')location='/done';};</script>"#,
                    ),
                    "/done" => ("200 OK", "", "<div id=done>Dashboard</div>"),
                    _ => ("200 OK", "", "<div>Page</div>"),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\n{header}Content-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self {
            root,
            hits,
            results,
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
        if std::thread::panicking() {
            eprintln!("Fixture HTTP hits: {:?}", self.hits.lock().unwrap());
        }
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
fn pump() {
    unsafe {
        let mut msg: MSG = std::mem::zeroed();
        while PeekMessageW(&mut msg, 0, 0, 0, PM_REMOVE) != 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    tick();
    std::thread::sleep(Duration::from_millis(20));
}
#[track_caller]
fn wait(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(40);
    while !ready() && Instant::now() < deadline {
        pump();
    }
    if !ready() {
        WEBVIEWS.with(|views| for (key, entry) in views.borrow().iter() {
            eprintln!("Fixture view {key}: url={:?}, loaded={}, failed={}, visible={}, pending={}, epoch={}, auth={:?}, manual={:?}, events={:?}",
                entry.url(), entry.loaded, entry.failed, entry.visible, entry.pending_load, entry.epoch,
                entry.auth.as_ref().map(|s| &s.progress), entry.manual.as_ref().map(|s| &s.progress), entry.events.lock().unwrap());
        });
        panic!("Windows native regression timed out");
    }
}
fn windows() -> usize {
    WINDOWS.get().unwrap().lock().unwrap().len()
}
fn entries(mut ready: impl FnMut(&Entry) -> bool) -> bool {
    WEBVIEWS.with(|views| {
        let views = views.borrow();
        let main = views
            .values()
            .filter(|v| v.layout == "layout")
            .collect::<Vec<_>>();
        main.len() == 2 && main.into_iter().all(|v| ready(v))
    })
}
fn script(cell: &str, js: &str) {
    WEBVIEWS.with(|views| {
        views
            .borrow()
            .values()
            .find(|v| v.cell == cell)
            .unwrap()
            .evaluate_script(js)
            .unwrap();
    });
}

#[test]
#[ignore = "requires an interactive Windows desktop and WebView2"]
fn windows_browser_and_visibility_regression() {
    gstreamer::init().unwrap();
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();
    fs::create_dir_all(webview_data_dir()).unwrap();
    let fixture = Fixture::new();
    let directory = std::env::temp_dir().join(format!("bf-web-regression-{}", std::process::id()));
    // This test runs alone, in its own process, against an isolated enrollment.
    unsafe {
        std::env::set_var("PROGRAMDATA", &directory);
    }
    ensure_secure_state_dir().unwrap();
    let mut state = ClientState::unpaired(&fixture.root);
    state.kiosk_key = Some("fixture-key".into());
    update_state(|s| {
        *s = state.clone();
        Ok(())
    })
    .unwrap();
    let report = query_native_displays().remove(0).report;
    unsafe {
        let name = wide("BetterFrameWindowsKiosk");
        let class = WNDCLASSW {
            lpfnWndProc: Some(renderer::window_proc),
            hInstance: GetModuleHandleW(null()),
            lpszClassName: name.as_ptr(),
            ..std::mem::zeroed()
        };
        assert_ne!(RegisterClassW(&class), 0);
    }
    let cells = (0..2).map(|i| {
        let steps = serde_json::json!([
            {"type":"navigate","url":"/auth/form"},{"type":"wait_for","selector":"#username"},
            {"type":"fill","selector":"#username","value":"person@example.test"},
            {"type":"click","selector":"#login"},{"type":"wait_for","selector":"#done"},
            {"type":"navigate","url":"#ready"}
        ]);
        let smart_url = serde_json::json!({"login_detect_url": if i == 0 { "/auth".to_string() } else { format!("{}/auth",fixture.root) }, "session_check_interval_ms":200,"steps":steps});
        let web_actions = serde_json::json!({"revision":"r1","on_load":[
            {"type":"javascript","script":format!("const key='renew-{i}'; if(!sessionStorage.getItem(key)){{sessionStorage.setItem(key,'1'); history.pushState({{}},'', '/auth/renew');}}")},
            {"type":"wait_for","selector":"#done"},
            {"type":"javascript","script":format!("fetch('/loaded-{i}')")}],"groups":{
            "action":[{"type":"javascript","script":"history.pushState({},'', '/auth/action');"},{"type":"wait","delay_ms":400},{"type":"navigate","url":"/done"}],
            "interrupted":[{"type":"wait_for","selector":"#never","timeout_ms":10000}]
        }});
        serde_json::json!({"view_id":format!("block{i}"),"entity_id":"same-entity","row":0,"col":i,
            "row_span":1,"col_span":1,"content_type":"web","web_url":format!("{}/start",fixture.root),
            "smart_url":smart_url,"web_actions":web_actions})
    }).collect::<Vec<_>>();
    let layout = serde_json::json!({"id":"layout","name":"Auth","grid_cols":2,"grid_rows":1,
        "priority":"normal","is_default":true,"resets_idle_timer":false,"cells":cells});
    let mut bundle: KioskBundle = serde_json::from_value(serde_json::json!({
        "kiosk_id":"fixture","kiosk_name":"Desktop","version":"1","displays":[{
            "id":"display","physical_index":report.index,"name":report.name,"width_px":1280,"height_px":720,
            "idle_timeout_seconds":0,"sleep_timeout_seconds":0,"layouts":[layout]
        }],"cameras":[]
    })).unwrap();
    save_bundle(&bundle).unwrap();
    renderer::reconcile_windows().unwrap();
    assert_eq!(windows(), 1);
    wait(|| {
        entries(|entry| {
            entry.ready(&entry.url().unwrap_or_default())
                && entry.manual.is_none()
                && !entry.pending_load
        }) && fixture.count("/loaded-0") == 1
            && fixture.count("/loaded-1") == 1
    });
    assert_eq!(
        fixture.count("/auth/form"),
        4,
        "both blocks authenticate independently and on-load actions re-authenticate before continuing"
    );
    let request = |group: &str| WebActionRequest {
        request_id: "native-test".into(),
        display_id: "display".into(),
        layout_id: "layout".into(),
        cell_id: "block0".into(),
        group: group.into(),
        revision: "r1".into(),
    };
    WEBVIEWS.with(|views| {
        let mut views = views.borrow_mut();
        let entry = views.values_mut().find(|e| e.cell == "block0").unwrap();
        let mut stale = request("action");
        stale.revision = "old".into();
        assert!(entry.invoke(stale).is_err());
    });
    let inbox = state_dir().join("web-action-inbox");
    fs::create_dir_all(&inbox).unwrap();
    let temporary = inbox.join("native-test.json.tmp");
    fs::write(&temporary, b"{unfinished").unwrap();
    let envelope = PendingAction {
        request: request("action"),
        renderer_id: std::process::id(),
        created_at: timestamp(),
    };
    write_protected(
        &inbox.join("native-test.json"),
        &serde_json::to_vec(&envelope).unwrap(),
    )
    .unwrap();
    tick();
    assert!(
        temporary.exists(),
        "an in-progress producer write is never consumed"
    );
    fs::remove_file(temporary).unwrap();
    wait(|| fixture.count("/api/kiosk/web-actions/result") == 1 && entries(|e| e.manual.is_none()));
    assert_eq!(
        fixture.results.lock().unwrap()[0]["ok"],
        true,
        "normal action reports success"
    );
    assert_eq!(
        fixture.count("/auth/form"),
        4,
        "manual actions pause entity authentication on login paths"
    );
    wait(|| entries(|e| e.ready(&e.url().unwrap_or_default())));
    WEBVIEWS.with(|views| {
        views
            .borrow_mut()
            .values_mut()
            .find(|e| e.cell == "block0")
            .unwrap()
            .invoke(request("interrupted"))
            .unwrap()
    });
    pump();
    script("block0", "location='/done?interrupted'");
    wait(|| fixture.count("/api/kiosk/web-actions/result") == 2 && entries(|e| e.manual.is_none()));
    assert_eq!(
        fixture.results.lock().unwrap()[1]["ok"],
        false,
        "navigation cannot complete a document-owned wait"
    );
    // A cached view sees an SPA auth redirect without a page-load event.
    script(
        "block0",
        "history.pushState({},'', '/auth/authorize?expired=1')",
    );
    wait(|| fixture.count("/auth/form") == 5 && entries(|e| e.ready(&e.url().unwrap_or_default())));
    let mut alternate = bundle.displays[0].layouts[0].clone();
    alternate.id = "alternate".into();
    alternate.cells.truncate(1);
    alternate.cells[0].view_id = Some("alternate-block".into());
    alternate.cells[0].content_type = "html".into();
    alternate.cells[0].web_url = None;
    alternate.cells[0].html_content = Some("<div>Other layout</div>".into());
    alternate.cells[0].smart_url = None;
    alternate.cells[0].web_actions = None;
    bundle.displays[0].layouts.push(alternate);
    save_bundle(&bundle).unwrap();
    update_state(|s| {
        s.active_layouts
            .insert("display".into(), "alternate".into());
        Ok(())
    })
    .unwrap();
    renderer::reconcile_windows().unwrap();
    wait(|| entries(|e| !e.visible));
    script(
        "block0",
        "history.pushState({},'', '/auth/authorize?cached=1')",
    );
    update_state(|s| {
        s.active_layouts.insert("display".into(), "layout".into());
        Ok(())
    })
    .unwrap();
    renderer::reconcile_windows().unwrap();
    wait(|| {
        fixture.count("/auth/form") == 6
            && entries(|e| e.visible && e.ready(&e.url().unwrap_or_default()))
            && fixture.count("/loaded-0") == 2
            && fixture.count("/loaded-1") == 2
    });
    wait(|| {
        entries(|e| {
            e.ready(&e.url().unwrap_or_default())
                && e.manual.is_none()
                && !e.pending_load
                && e.last_check.is_some()
        })
    });
    WEBVIEWS.with(|views| {
        views
            .borrow_mut()
            .values_mut()
            .find(|e| e.cell == "block1")
            .unwrap()
            .config
            .as_mut()
            .unwrap()
            .session_check_interval_ms = Some(0)
    });
    script(
        "block1",
        "history.pushState({},'', '/auth/authorize?periodic-disabled=1')",
    );
    let until = Instant::now() + Duration::from_secs(1);
    while Instant::now() < until {
        pump();
    }
    assert_eq!(
        fixture.count("/auth/form"),
        6,
        "zero disables periodic auth observation"
    );
    WEBVIEWS.with(|views| {
        let mut views = views.borrow_mut();
        let entry = views.values_mut().find(|e| e.cell == "block1").unwrap();
        entry.show(false);
        entry.show(true);
    });
    wait(|| fixture.count("/auth/form") == 7 && entries(|e| e.ready(&e.url().unwrap_or_default())));
    let before = WEBVIEWS.with(|views| views.borrow().keys().cloned().collect::<HashSet<_>>());
    bundle.displays[0].layouts[0].cells[0].local_storage =
        Some(HashMap::from([("changed".into(), "yes".into())]));
    save_bundle(&bundle).unwrap();
    renderer::reconcile_windows().unwrap();
    wait(|| WEBVIEWS.with(|v| v.borrow().keys().any(|k| !before.contains(k))));
    let assigned = bundle.displays.clone();
    bundle.displays.clear();
    bundle.display = None;
    save_bundle(&bundle).unwrap();
    renderer::reconcile_windows().unwrap();
    assert_eq!(windows(), 0);
    assert!(WEBVIEWS.with(|v| v.borrow().is_empty()));
    fs::remove_file(state_dir().join("runtime-health.json")).unwrap();
    wait(|| {
        renderer::reconcile_windows().unwrap();
        windows() == 0 && state_dir().join("runtime-health.json").exists()
    });
    let health: serde_json::Value = serde_json::from_slice(
        &read_protected_or_plain(&state_dir().join("runtime-health.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        health["version"],
        kiosk_app_version(),
        "background renderer confirms update health"
    );
    // Saved empty configuration stays windowless after another reconciliation.
    renderer::reconcile_windows().unwrap();
    assert_eq!(windows(), 0);
    bundle.displays = assigned;
    save_bundle(&bundle).unwrap();
    renderer::reconcile_windows().unwrap();
    assert_eq!(windows(), 1);
    bundle.displays.clear();
    save_bundle(&bundle).unwrap();
    renderer::reconcile_windows().unwrap();
    assert_eq!(windows(), 0);
    fs::remove_dir_all(directory).unwrap();
}
