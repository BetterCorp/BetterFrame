use super::*;

pub(super) fn run_app() -> Result<(), String> {
    let Some(_instance) = acquire_app_instance()? else {
        info!("BetterFrame renderer is already running");
        return Ok(());
    };
    fs::create_dir_all(webview_data_dir())
        .map_err(|error| format!("create WebView2 data directory: {error}"))?;
    gstreamer::init().map_err(|error| format!("GStreamer initialization failed: {error}"))?;
    let policy = load_policy();
    let displays = query_native_displays();
    let _ = save_renderer_displays(
        &displays
            .iter()
            .map(|display| display.report.clone())
            .collect::<Vec<_>>(),
    );
    let targets: Vec<NativeDisplay> = displays
        .into_iter()
        .filter(|d| display_allowed(&policy, &d.report.name))
        .collect();
    let targets = if targets.is_empty() {
        vec![primary_native_display()]
    } else {
        targets
    };

    unsafe {
        let class_name = wide("BetterFrameWindowsKiosk");
        let hinstance = GetModuleHandleW(null());
        let wc = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance,
            hIcon: LoadIconW(hinstance, 1usize as *const u16),
            lpszClassName: class_name.as_ptr(),
            hbrBackground: CreateSolidBrush(rgb(17, 24, 39)) as HBRUSH,
            ..std::mem::zeroed()
        };
        if RegisterClassW(&wc) == 0 {
            return Err("RegisterClassW failed".to_string());
        }

        let mut hwnds = Vec::new();
        let bundle = load_bundle();
        for display in &targets {
            let title = wide(&format!("BetterFrame - {}", display.report.name));
            let r = display.rect;
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_POPUP,
                r.left,
                r.top,
                (r.right - r.left).max(1),
                (r.bottom - r.top).max(1),
                0,
                0 as HMENU,
                hinstance,
                null_mut(),
            );
            if hwnd == 0 {
                return Err("CreateWindowExW failed".to_string());
            }
            let display_id =
                resolve_bundle_display(bundle.as_ref(), &display.report.name, display.report.index)
                    .map(|display| display.id.clone())
                    .unwrap_or_else(|| display.report.name.clone());
            WINDOWS
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap()
                .insert(
                    hwnd,
                    WindowState {
                        display_id,
                        display_name: display.report.name.clone(),
                        display_index: display.report.index,
                        mouse_down: None,
                    },
                );
            ShowWindow(hwnd, SW_SHOWMAXIMIZED);
            UpdateWindow(hwnd);
            hwnds.push(hwnd);
        }

        std::thread::spawn(move || {
            let mut ticks = 0u8;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                for hwnd in &hwnds {
                    InvalidateRect(*hwnd, null(), 1);
                }
                ticks = ticks.wrapping_add(1);
                if ticks % 5 == 0 {
                    let _ = save_renderer_displays(
                        &query_native_displays()
                            .into_iter()
                            .map(|display| display.report)
                            .collect::<Vec<_>>(),
                    );
                }
            }
        });

        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    Ok(())
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint_window(hwnd);
            0
        }
        WM_LBUTTONDOWN => {
            if let Some(windows) = WINDOWS.get() {
                if let Some(st) = windows.lock().unwrap().get_mut(&hwnd) {
                    st.mouse_down = Some(MouseDown { at: Instant::now() });
                }
            }
            0
        }
        WM_LBUTTONUP => {
            let x = loword(lparam as usize) as i16 as i32;
            let y = hiword(lparam as usize) as i16 as i32;
            let mut down = None;
            if let Some(windows) = WINDOWS.get() {
                if let Some(st) = windows.lock().unwrap().get_mut(&hwnd) {
                    down = st.mouse_down.take();
                }
            }
            // No mouse_down means this is the second BUTTONUP of a
            // double-click (DBLCLK already consumed it) â€” don't dispatch.
            if let (Some(display_id), Some(down)) = (resolved_display_id(hwnd), down) {
                let kind = if down.at.elapsed() >= Duration::from_millis(650) {
                    "hold"
                } else {
                    "click"
                };
                handle_pointer_event(&display_id, x, y, kind);
            }
            0
        }
        WM_LBUTTONDBLCLK => {
            let x = loword(lparam as usize) as i16 as i32;
            let y = hiword(lparam as usize) as i16 as i32;
            if let Some(display_id) = resolved_display_id(hwnd) {
                handle_pointer_event(&display_id, x, y, "double_click");
            }
            0
        }
        WM_DESTROY => {
            remove_camera_pipelines(hwnd);
            remove_webviews(hwnd);
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

pub(super) fn paint_window(hwnd: HWND) {
    unsafe {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);
        let brush = CreateSolidBrush(rgb(17, 24, 39));
        FillRect(hdc, &ps.rcPaint, brush);
        DeleteObject(brush as _);

        SetBkMode(hdc, 1);
        SetTextColor(hdc, rgb(229, 231, 235));
        if let Some(display_id) = resolved_display_id(hwnd) {
            let mut client_rect = std::mem::zeroed();
            GetClientRect(hwnd, &mut client_rect);
            paint_layout(hwnd, hdc, client_rect, &display_id);
        } else {
            draw_centered(hdc, ps.rcPaint, "BetterFrame Windows Kiosk");
        }
        EndPaint(hwnd, &ps);
    }
}

pub(super) fn resolved_display_id(hwnd: HWND) -> Option<String> {
    let bundle = load_bundle();
    let windows = WINDOWS.get()?;
    let mut windows = windows.lock().ok()?;
    let window = windows.get_mut(&hwnd)?;
    if let Some(display) =
        resolve_bundle_display(bundle.as_ref(), &window.display_name, window.display_index)
    {
        window.display_id = display.id.clone();
    }
    Some(window.display_id.clone())
}

pub(super) fn paint_layout(hwnd: HWND, hdc: HDC, rect: RECT, display_id: &str) {
    let state = load_state();
    let bundle = load_bundle();
    let Some((display, layout)) = active_layout_for_display(bundle.as_ref(), &state, display_id)
    else {
        remove_webviews(hwnd);
        let message = state
            .pairing_code
            .as_deref()
            .map(|code| format!("BetterFrame pairing code: {code}"))
            .unwrap_or_else(|| "BetterFrame Windows Kiosk - waiting for bundle".to_string());
        draw_centered(hdc, rect, &message);
        return;
    };
    if layout.cells.is_empty() {
        remove_webviews(hwnd);
        draw_centered(hdc, rect, &format!("{} - {}", display.name, layout.name));
        return;
    }

    let cols = layout.grid_cols.max(1) as i32;
    let rows = layout.grid_rows.max(1) as i32;
    let pen = unsafe { CreatePen(PS_SOLID, 1, rgb(75, 85, 99)) };
    let old_pen = unsafe { SelectObject(hdc, pen as _) };

    for cell in &layout.cells {
        let cell_rect = cell_rect(rect, cols, rows, cell);
        let brush = unsafe { CreateSolidBrush(color_for_content(&cell.content_type)) };
        unsafe {
            FillRect(hdc, &cell_rect, brush);
            DeleteObject(brush as _);
            MoveToEx(hdc, cell_rect.left, cell_rect.top, null_mut());
            LineTo(hdc, cell_rect.right, cell_rect.top);
            LineTo(hdc, cell_rect.right, cell_rect.bottom);
            LineTo(hdc, cell_rect.left, cell_rect.bottom);
            LineTo(hdc, cell_rect.left, cell_rect.top);
        }
        draw_cell_label(hdc, cell_rect, &cell_label(cell));
    }
    unsafe {
        SelectObject(hdc, old_pen);
        DeleteObject(pen as _);
    }
    sync_camera_pipelines(
        hwnd,
        rect,
        layout,
        bundle.as_ref().expect("active layout requires a bundle"),
        state.encrypt_key.as_deref(),
    );
    sync_webviews(
        hwnd,
        rect,
        layout,
        &bundle.as_ref().unwrap().version,
        &state,
    );
}

struct NativeWindowHandle(HWND);

impl HasWindowHandle for NativeWindowHandle {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0).ok_or(HandleError::Unavailable)?;
        let raw = RawWindowHandle::Win32(Win32WindowHandle::new(hwnd));
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

struct WebCellSpec {
    key: String,
    bounds: WebRect,
    url: Option<String>,
    html: Option<String>,
    local_storage: Option<HashMap<String, String>>,
}

pub(super) fn sync_webviews(
    hwnd: HWND,
    canvas: RECT,
    layout: &BundleLayout,
    bundle_version: &str,
    state: &ClientState,
) {
    let cols = layout.grid_cols.max(1) as i32;
    let rows = layout.grid_rows.max(1) as i32;
    let specs: Vec<WebCellSpec> = layout
        .cells
        .iter()
        .enumerate()
        .filter_map(|(index, cell)| {
            if cell.content_type != "web" && cell.content_type != "html" {
                return None;
            }
            let target = cell_rect(canvas, cols, rows, cell);
            let view_id = cell.view_id.clone().unwrap_or_else(|| index.to_string());
            Some(WebCellSpec {
                key: format!(
                    "{hwnd}:{}:{bundle_version}:{}:{}",
                    layout.id, view_id, cell.content_type,
                ),
                bounds: web_rect(target),
                url: cell
                    .web_url
                    .as_deref()
                    .and_then(|url| resolve_web_url(url, &state.server_url)),
                html: cell.html_content.clone(),
                local_storage: cell.local_storage.clone(),
            })
        })
        .collect();
    let wanted: HashSet<String> = specs.iter().map(|spec| spec.key.clone()).collect();

    for spec in specs {
        let exists = WEBVIEWS.with(|views| {
            let views = views.borrow();
            if let Some(view) = views.get(&spec.key) {
                let _ = view.set_bounds(spec.bounds);
                let _ = view.set_visible(true);
                true
            } else {
                false
            }
        });
        if exists {
            continue;
        }
        if WEB_CONTEXT.with(|context| context.try_borrow().is_err()) {
            continue;
        }
        let should_retry = WEBVIEW_FAILURES.with(|failures| {
            failures
                .borrow()
                .get(&spec.key)
                .is_none_or(|failed_at| failed_at.elapsed() >= Duration::from_secs(10))
        });
        if !should_retry {
            continue;
        }
        WEBVIEW_FAILURES.with(|failures| {
            failures
                .borrow_mut()
                .insert(spec.key.clone(), Instant::now());
        });
        match create_webview(hwnd, &spec, state) {
            Ok(view) => {
                WEBVIEW_FAILURES.with(|failures| {
                    failures.borrow_mut().remove(&spec.key);
                });
                WEBVIEWS.with(|views| {
                    views.borrow_mut().insert(spec.key, view);
                });
            }
            Err(error) => warn!("web cell failed: {error}"),
        }
    }

    let prefix = format!("{hwnd}:");
    WEBVIEWS.with(|views| {
        views
            .borrow_mut()
            .retain(|key, _| !key.starts_with(&prefix) || wanted.contains(key));
    });
    WEBVIEW_FAILURES.with(|failures| {
        failures
            .borrow_mut()
            .retain(|key, _| !key.starts_with(&prefix) || wanted.contains(key));
    });
}

fn create_webview(hwnd: HWND, spec: &WebCellSpec, state: &ClientState) -> Result<WebView, String> {
    let script = initialization_script(spec.local_storage.as_ref());

    WEB_CONTEXT.with(|context| {
        let mut context = context
            .try_borrow_mut()
            .map_err(|_| "WebView2 initialization already in progress".to_string())?;
        let mut builder = WebViewBuilder::new_with_web_context(&mut context)
            .with_bounds(spec.bounds)
            .with_initialization_script(script)
            .with_devtools(false);
        let mut authenticated_load = None;
        if let Some(profile) =
            ablesign_profile_name(spec.url.as_deref(), spec.local_storage.as_ref())
        {
            builder = builder.with_profile_name(profile);
        }
        if let Some(url) = &spec.url {
            if same_origin(url, &state.server_url) {
                if let Some(key) = &state.kiosk_key {
                    let server = reqwest::Url::parse(&state.server_url)
                        .map_err(|error| error.to_string())?;
                    let trusted_origin = server.origin().ascii_serialization();
                    let mut headers = wry::http::HeaderMap::new();
                    headers.insert(
                        wry::http::header::AUTHORIZATION,
                        wry::http::HeaderValue::from_str(&format!("Bearer {key}"))
                            .map_err(|error| error.to_string())?,
                    );
                    builder = builder
                        .with_navigation_handler(move |next| same_origin(&next, &trusted_origin));
                    authenticated_load = Some((url, headers));
                } else {
                    builder = builder.with_url(url);
                }
            } else {
                builder = builder.with_url(url);
            }
        } else if let Some(html) = &spec.html {
            builder = builder.with_html(html);
        } else {
            return Err("web cell has no URL or HTML".to_string());
        }
        let view = builder
            .build_as_child(&NativeWindowHandle(hwnd))
            .map_err(|error| error.to_string())?;
        if let Some((url, headers)) = authenticated_load {
            view.load_url_with_headers(url, headers)
                .map_err(|error| error.to_string())?;
        }
        Ok(view)
    })
}

pub(super) fn initialization_script(local_storage: Option<&HashMap<String, String>>) -> String {
    let mut script = "try{document.documentElement.style.cursor='none';}catch(_e){}".to_string();
    if let Some(values) = local_storage {
        for (key, value) in values {
            script.push_str(&format!(
                "try{{localStorage.setItem({},{});}}catch(_e){{}}",
                serde_json::to_string(key).unwrap(),
                serde_json::to_string(value).unwrap(),
            ));
        }
    }
    script
}

pub(super) fn ablesign_profile_name(
    url: Option<&str>,
    local_storage: Option<&HashMap<String, String>>,
) -> Option<String> {
    let url = reqwest::Url::parse(url?).ok()?;
    if url.host_str() != Some("player.ablesign.tv") {
        return None;
    }
    let screen_id = local_storage?.get("screenId")?;
    let safe_id: String = screen_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .take(48)
        .collect();
    (!safe_id.is_empty()).then(|| format!("ablesign-{safe_id}"))
}

pub(super) fn web_rect(rect: RECT) -> WebRect {
    WebRect {
        position: PhysicalPosition::new(rect.left, rect.top).into(),
        size: PhysicalSize::new(
            (rect.right - rect.left).max(1) as u32,
            (rect.bottom - rect.top).max(1) as u32,
        )
        .into(),
    }
}

pub(super) fn remove_webviews(hwnd: HWND) {
    let prefix = format!("{hwnd}:");
    WEBVIEWS.with(|views| {
        views
            .borrow_mut()
            .retain(|key, _| !key.starts_with(&prefix))
    });
    WEBVIEW_FAILURES.with(|failures| {
        failures
            .borrow_mut()
            .retain(|key, _| !key.starts_with(&prefix))
    });
}

pub(super) fn query_displays() -> Vec<DisplayReport> {
    load_renderer_displays().unwrap_or_else(|| {
        query_native_displays()
            .into_iter()
            .map(|display| display.report)
            .collect()
    })
}

pub(super) fn resolve_bundle_display<'a>(
    bundle: Option<&'a KioskBundle>,
    native_name: &str,
    native_index: usize,
) -> Option<&'a BundleDisplay> {
    crate::core::layout::resolve_display(bundle?, native_name, native_index)
}

pub(super) fn active_layout_for_display<'a>(
    bundle: Option<&'a KioskBundle>,
    state: &ClientState,
    display_id: &str,
) -> Option<(&'a BundleDisplay, &'a BundleLayout)> {
    let bundle = bundle?;
    let display = bundle
        .displays
        .iter()
        .find(|d| d.id == display_id)
        .or_else(|| bundle.displays.first())?;
    let layout = crate::core::layout::active_layout(display, &state.active_layouts)?;
    Some((display, layout))
}

pub(super) fn cell_rect(canvas: RECT, cols: i32, rows: i32, cell: &BundleCell) -> RECT {
    let width = (canvas.right - canvas.left).max(1);
    let height = (canvas.bottom - canvas.top).max(1);
    RECT {
        left: canvas.left + width * cell.col as i32 / cols,
        top: canvas.top + height * cell.row as i32 / rows,
        right: canvas.left + width * (cell.col + cell.col_span) as i32 / cols,
        bottom: canvas.top + height * (cell.row + cell.row_span) as i32 / rows,
    }
}

pub(super) fn cell_at_point<'a>(
    layout: &'a BundleLayout,
    canvas: RECT,
    x: i32,
    y: i32,
) -> Option<&'a BundleCell> {
    let cols = layout.grid_cols.max(1) as i32;
    let rows = layout.grid_rows.max(1) as i32;
    layout.cells.iter().find(|cell| {
        let r = cell_rect(canvas, cols, rows, cell);
        x >= r.left && x < r.right && y >= r.top && y < r.bottom
    })
}

pub(super) fn color_for_content(kind: &str) -> COLORREF {
    match kind {
        "camera" => rgb(21, 94, 117),
        "web" => rgb(30, 64, 175),
        "html" => rgb(146, 64, 14),
        "ablesign" => rgb(88, 28, 135),
        _ => rgb(55, 65, 81),
    }
}

pub(super) fn cell_label(cell: &BundleCell) -> String {
    if let Some(entity_id) = &cell.entity_id {
        return format!("{} {}", cell.content_type, entity_id);
    }
    if let Some(camera_id) = &cell.camera_id {
        return format!("camera {camera_id}");
    }
    if let Some(url) = &cell.web_url {
        return format!("web {url}");
    }
    cell.content_type.clone()
}

pub(super) fn draw_centered(hdc: HDC, rect: RECT, text: &str) {
    let text_w = wide(text);
    let mut rect = rect;
    unsafe {
        DrawTextW(
            hdc,
            text_w.as_ptr(),
            -1,
            &mut rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE,
        );
    }
}

pub(super) fn draw_cell_label(hdc: HDC, rect: RECT, text: &str) {
    let text_w = wide(text);
    let mut text_rect = RECT {
        left: rect.left + 10,
        top: rect.top + 10,
        right: rect.right - 10,
        bottom: rect.bottom - 10,
    };
    unsafe {
        SetTextColor(hdc, rgb(243, 244, 246));
        DrawTextW(hdc, text_w.as_ptr(), -1, &mut text_rect, DT_LEFT | DT_TOP);
    }
}

pub(super) fn handle_pointer_event(display_id: &str, x: i32, y: i32, kind: &str) {
    let state = load_state();
    let Some(bundle) = load_bundle() else { return };
    let Some((display, layout)) = active_layout_for_display(Some(&bundle), &state, display_id)
    else {
        return;
    };
    let width = WINDOWS
        .get()
        .and_then(|windows| windows.lock().ok())
        .and_then(|windows| {
            windows
                .iter()
                .find(|(_, value)| value.display_id == display_id)
                .map(|(hwnd, _)| *hwnd)
        })
        .map(|hwnd| {
            let mut rect = unsafe { std::mem::zeroed() };
            unsafe { GetClientRect(hwnd, &mut rect) };
            rect
        })
        .unwrap_or(RECT {
            left: 0,
            top: 0,
            right: 1,
            bottom: 1,
        });
    let Some(cell) = cell_at_point(layout, width, x, y) else {
        return;
    };
    if let Some((action, params)) = configured_cell_action(cell, kind) {
        if action == "layout.switch" {
            if let Some(layout_id) = params.get("layout_id").map(flexible_id_ref) {
                let mut next = state.clone();
                next.active_layouts
                    .insert(display.id.clone(), layout_id.clone());
                let _ = save_state(&next);
                if let Some(key) = next.kiosk_key.clone() {
                    let server = next.server_url.clone();
                    let did = display.id.clone();
                    std::thread::spawn(move || {
                        let rt = tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build();
                        if let Ok(rt) = rt {
                            rt.block_on(report_layout_change(
                                &server,
                                Some(&key),
                                &did,
                                &layout_id,
                            ));
                        }
                    });
                }
                return;
            }
        }
    }
    report_interaction_event(&state, display, layout, cell, kind);
}

pub(super) fn report_interaction_event(
    state: &ClientState,
    display: &BundleDisplay,
    layout: &BundleLayout,
    cell: &BundleCell,
    kind: &str,
) {
    let Some(key) = state.kiosk_key.clone() else {
        return;
    };
    let server = state.server_url.clone();
    let payload = serde_json::json!({
        "topic": format!("interaction.cell.{kind}"),
        "source_type": "interaction",
        "payload": {
            "display_id": display.id,
            "layout_id": layout.id,
            "cell_id": cell.view_id,
            "entity_id": cell.entity_id,
            "camera_id": cell.camera_id,
            "kind": kind,
        }
    });
    std::thread::spawn(move || {
        let _ = reqwest::blocking::Client::new()
            .post(format!("{server}/api/kiosk/event"))
            .bearer_auth(key)
            .json(&payload)
            .timeout(Duration::from_secs(5))
            .send();
    });
}

pub(super) fn sync_camera_pipelines(
    hwnd: HWND,
    canvas: RECT,
    layout: &BundleLayout,
    bundle: &KioskBundle,
    encrypt_key: Option<&str>,
) {
    let registry = CAMERA_PIPELINES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut pipelines = registry.lock().unwrap();
    let prefix = format!("{hwnd}:");
    let mut wanted = std::collections::HashSet::new();
    for (index, cell) in layout.cells.iter().enumerate() {
        if cell.content_type != "camera" {
            continue;
        }
        let Some(camera_id) = cell.camera_id.as_deref() else {
            continue;
        };
        let Some(camera) = bundle.cameras.iter().find(|camera| camera.id == camera_id) else {
            continue;
        };
        let view_key = cell.view_id.clone().unwrap_or_else(|| index.to_string());
        let key = format!("{prefix}{}:{view_key}:{}", layout.id, bundle.version);
        wanted.insert(key.clone());
        let target = cell_rect(
            canvas,
            layout.grid_cols.max(1) as i32,
            layout.grid_rows.max(1) as i32,
            cell,
        );
        if let Some(existing) = pipelines.get(&key) {
            let _ = existing.overlay.set_render_rectangle(
                target.left,
                target.top,
                (target.right - target.left).max(1),
                (target.bottom - target.top).max(1),
            );
            continue;
        }

        let area = (cell.col_span * cell.row_span) as f32
            / (layout.grid_cols.max(1) * layout.grid_rows.max(1)) as f32;
        let Some((rtsp_uri, _)) = camera.pick_stream(cell.stream_selector.as_deref(), area) else {
            continue;
        };
        let password = camera
            .playback_password_encrypted
            .as_deref()
            .and_then(|ciphertext| {
                encrypt_key.and_then(|key| decrypt_camera_password(ciphertext, key))
            });
        match create_windows_camera_pipeline(
            hwnd,
            &rtsp_uri,
            camera.playback_username.as_deref(),
            password.as_deref(),
            target,
        ) {
            Ok(pipeline) => {
                pipelines.insert(key, pipeline);
            }
            Err(error) => warn!("camera {} playback failed: {error}", camera.name),
        }
    }

    pipelines.retain(|key, pipeline| {
        let keep = !key.starts_with(&prefix) || wanted.contains(key);
        if !keep {
            let _ = pipeline.pipeline.set_state(gstreamer::State::Null);
        }
        keep
    });
}

pub(super) fn create_windows_camera_pipeline(
    hwnd: HWND,
    uri: &str,
    username: Option<&str>,
    password: Option<&str>,
    target: RECT,
) -> Result<CameraPipeline, String> {
    let pipeline = gstreamer::Pipeline::new();
    let mut source_builder = gstreamer::ElementFactory::make("rtspsrc")
        .property("location", uri)
        .property("latency", 300u32)
        .property_from_str("protocols", "tcp");
    if let Some(username) = username.filter(|value| !value.is_empty()) {
        source_builder = source_builder.property("user-id", username);
    }
    if let Some(password) = password.filter(|value| !value.is_empty()) {
        source_builder = source_builder.property("user-pw", password);
    }
    let source = source_builder.build().map_err(|error| error.to_string())?;
    let decode = gstreamer::ElementFactory::make("decodebin")
        .build()
        .map_err(|error| error.to_string())?;
    let sink = gstreamer::ElementFactory::make("d3d11videosink")
        .property("sync", false)
        .build()
        .map_err(|_| {
            "d3d11videosink is unavailable; install the GStreamer MSVC runtime".to_string()
        })?;
    pipeline
        .add_many([&source, &decode, &sink])
        .map_err(|error| error.to_string())?;

    let decode_weak = decode.downgrade();
    source.connect_pad_added(move |_, pad| {
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        if !caps.to_string().contains("media=(string)video") {
            return;
        }
        let Some(decode) = decode_weak.upgrade() else {
            return;
        };
        if let Some(target) = decode.static_pad("sink") {
            if !target.is_linked() {
                let _ = pad.link(&target);
            }
        }
    });
    let sink_weak = sink.downgrade();
    decode.connect_pad_added(move |_, pad| {
        let caps = pad.current_caps().unwrap_or_else(|| pad.query_caps(None));
        if !caps
            .structure(0)
            .map(|value| value.name().starts_with("video/"))
            .unwrap_or(false)
        {
            return;
        }
        let Some(sink) = sink_weak.upgrade() else {
            return;
        };
        if let Some(target) = sink.static_pad("sink") {
            if !target.is_linked() {
                let _ = pad.link(&target);
            }
        }
    });

    let overlay = sink
        .dynamic_cast::<gstreamer_video::VideoOverlay>()
        .map_err(|_| "D3D11 sink does not support video overlay".to_string())?;
    unsafe { overlay.set_window_handle(hwnd as usize) };
    overlay
        .set_render_rectangle(
            target.left,
            target.top,
            (target.right - target.left).max(1),
            (target.bottom - target.top).max(1),
        )
        .map_err(|error| error.to_string())?;
    pipeline
        .set_state(gstreamer::State::Playing)
        .map_err(|error| format!("start pipeline: {error:?}"))?;
    Ok(CameraPipeline { pipeline, overlay })
}

pub(super) fn remove_camera_pipelines(hwnd: HWND) {
    let Some(registry) = CAMERA_PIPELINES.get() else {
        return;
    };
    let prefix = format!("{hwnd}:");
    registry.lock().unwrap().retain(|key, pipeline| {
        if !key.starts_with(&prefix) {
            return true;
        }
        let _ = pipeline.pipeline.set_state(gstreamer::State::Null);
        false
    });
}

pub(super) fn decrypt_camera_password(ciphertext: &str, key: &str) -> Option<String> {
    use aes_gcm::{
        Aes256Gcm, Key, Nonce,
        aead::{Aead, KeyInit},
    };
    use base64::Engine;
    let parts: Vec<_> = ciphertext.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" {
        return None;
    }
    let codec = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let iv = codec.decode(parts[1]).ok()?;
    let tag = codec.decode(parts[2]).ok()?;
    let mut encrypted = codec.decode(parts[3]).ok()?;
    let key = codec.decode(key).ok()?;
    if iv.len() != 12 || tag.len() != 16 || key.len() != 32 {
        return None;
    }
    encrypted.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    String::from_utf8(
        cipher
            .decrypt(Nonce::from_slice(&iv), encrypted.as_ref())
            .ok()?,
    )
    .ok()
}

pub(super) fn query_native_displays() -> Vec<NativeDisplay> {
    let mut displays = Vec::<NativeDisplay>::new();
    for device_number in 0.. {
        let mut device: DISPLAY_DEVICEW = unsafe { std::mem::zeroed() };
        device.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
        if unsafe { EnumDisplayDevicesW(null(), device_number, &mut device, 0) } == 0 {
            break;
        }
        if device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP == 0
            || device.StateFlags & DISPLAY_DEVICE_MIRRORING_DRIVER != 0
        {
            continue;
        }
        let mut mode: DEVMODEW = unsafe { std::mem::zeroed() };
        mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
        if unsafe {
            EnumDisplaySettingsExW(
                device.DeviceName.as_ptr(),
                ENUM_CURRENT_SETTINGS,
                &mut mode,
                0,
            )
        } == 0
        {
            continue;
        }
        let position = unsafe { mode.Anonymous1.Anonymous2.dmPosition };
        displays.push(NativeDisplay {
            report: DisplayReport {
                index: 0,
                name: wide_to_string(&device.DeviceName),
                width_px: mode.dmPelsWidth,
                height_px: mode.dmPelsHeight,
                power_state: "awake".to_string(),
            },
            rect: RECT {
                left: position.x,
                top: position.y,
                right: position.x + mode.dmPelsWidth as i32,
                bottom: position.y + mode.dmPelsHeight as i32,
            },
        });
    }
    if displays.is_empty() {
        displays.push(primary_native_display());
    }
    displays.sort_by(|left, right| left.report.name.cmp(&right.report.name));
    for (index, display) in displays.iter_mut().enumerate() {
        display.report.index = index;
    }
    displays
}

pub(super) fn primary_native_display() -> NativeDisplay {
    let width = unsafe { GetSystemMetrics(SM_CXSCREEN).max(1) };
    let height = unsafe { GetSystemMetrics(SM_CYSCREEN).max(1) };
    NativeDisplay {
        report: DisplayReport {
            index: 0,
            name: "Primary".to_string(),
            width_px: width as u32,
            height_px: height as u32,
            power_state: "awake".to_string(),
        },
        rect: RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        },
    }
}

pub(super) fn display_allowed(policy: &WindowsPolicy, display_name: &str) -> bool {
    if policy.displays.mode != "selected" {
        return true;
    }
    policy
        .displays
        .selected_display_names
        .iter()
        .any(|name| name.eq_ignore_ascii_case(display_name))
}
