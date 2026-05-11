use std::cell::RefCell;
use std::sync::mpsc;
use url::Url;

thread_local! {
    /// camera_id → (pipeline, paintable). Pipelines stay warm across layout
    /// swaps for cameras still referenced or in preload_camera_ids.
    static WARM_CAMERAS: RefCell<std::collections::HashMap<u32, (gstreamer::Pipeline, gtk::gdk::Paintable)>>
        = RefCell::new(std::collections::HashMap::new());
}

use gtk4::prelude::*;
use gtk4::{self as gtk, Application, ApplicationWindow, Box as GtkBox, Grid, Label, Orientation, Picture};
use tracing::{info, warn};

use crate::bundle::KioskBundle;
use crate::cec;
use crate::pipeline;
use crate::server;
use crate::ws_client;
use crate::ServerMsg;

const APP_ID: &str = "dev.betterframe.kiosk";
const BETTERFRAME_LOGO_SVG: &str = include_str!("../../server/src/web-static/betterframe-logo.svg");
const BETTERFRAME_MARK_SVG: &str = include_str!("../../server/src/web-static/betterframe-mark.svg");

pub fn build_app() -> Application {
    let app = Application::builder().application_id(APP_ID).build();
    app.connect_activate(activate);
    app
}

fn activate(app: &Application) {
    let window = ApplicationWindow::builder()
        .application(app)
        .title("BetterFrame")
        .fullscreened(true)
        .build();

    let provider = gtk::CssProvider::new();
    provider.load_from_string("window { background-color: #1a1a2e; }");
    gtk::style_context_add_provider_for_display(
        &WidgetExt::display(&window),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    show_logo(&window);
    window.present();

    let (tx, rx) = mpsc::channel::<WorkerMsg>();

    let server_url = std::env::var("BETTERFRAME_SERVER").ok()
        .or_else(|| std::env::args().nth(1));
    std::thread::spawn(move || {
        let server = server::discover_server(server_url.as_deref());
        info!("server: {server}");

        let key = if server::is_paired() {
            info!("already paired");
            server::load_key()
        } else {
            let (code, expires) = server::initiate_pairing(&server);
            info!("pairing code: {code} (expires {expires})");
            let _ = tx.send(WorkerMsg::ShowPairingCode(code.clone()));

            let (name, key) = server::poll_claim(&server, &code);
            info!("paired as: {name}");
            key
        };

        let bundle = server::fetch_bundle(&server, &key);
        info!("bundle: {} cameras, {} layouts", bundle.cameras.len(), bundle.layouts.len());
        let _ = tx.send(WorkerMsg::RenderBundle(bundle, server.clone(), key.clone()));

        // Spawn WS client in a separate thread for live updates
        let server_ws = server.clone();
        let key_ws = key.clone();
        let (ws_tx, ws_rx) = mpsc::channel::<ServerMsg>();
        let tx_for_reload = tx.clone();
        let server_for_reload = server.clone();
        let key_for_reload = key.clone();

        std::thread::spawn(move || {
            ws_client::run(&server_ws, &key_ws, ws_tx);
        });

        // Listen for WS messages and dispatch
        std::thread::spawn(move || {
            for msg in ws_rx {
                match msg {
                    ServerMsg::ReloadBundle => {
                        info!("reloading bundle");
                        let bundle = server::fetch_bundle(&server_for_reload, &key_for_reload);
                        let _ = tx_for_reload.send(WorkerMsg::RenderBundle(
                            bundle,
                            server_for_reload.clone(),
                            key_for_reload.clone(),
                        ));
                    }
                    ServerMsg::Standby => cec::standby(),
                    ServerMsg::Wake => cec::wake(),
                }
            }
        });

        // Heartbeat loop — also reports display geometry
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            let displays = query_displays();
            server::heartbeat(&server, &key, &displays);
        }
    });

    // Poll channel from UI thread via timeout
    let window_clone = window.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
        while let Ok(msg) = rx.try_recv() {
            match msg {
                WorkerMsg::ShowPairingCode(code) => show_pairing_code(&window_clone, &code),
                WorkerMsg::RenderBundle(bundle, server, key) => render_bundle(&window_clone, bundle, &server, &key),
            }
        }
        gtk::glib::ControlFlow::Continue
    });
}

enum WorkerMsg {
    ShowPairingCode(String),
    RenderBundle(KioskBundle, String, String),
}

/// Query connected HDMI displays from sysfs. Returns (name, width, height).
/// Reads /sys/class/drm/*/status and /sys/class/drm/*/modes.
fn query_displays() -> Vec<(String, u32, u32)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip non-HDMI connectors and the "card" parents
        if !name.contains("-HDMI-") && !name.contains("-DP-") { continue; }
        let path = entry.path();
        let status = std::fs::read_to_string(path.join("status")).unwrap_or_default();
        if status.trim() != "connected" { continue; }
        let modes = std::fs::read_to_string(path.join("modes")).unwrap_or_default();
        // First line = preferred mode
        let mode = modes.lines().next().unwrap_or("");
        let parts: Vec<&str> = mode.split('x').collect();
        if parts.len() != 2 { continue; }
        let w: u32 = parts[0].parse().unwrap_or(0);
        let h: u32 = parts[1].trim().parse().unwrap_or(0);
        if w == 0 || h == 0 { continue; }
        // Strip "cardN-" prefix for cleaner name
        let clean_name = name.split_once('-').map(|(_, rest)| rest.to_string()).unwrap_or(name);
        out.push((clean_name, w, h));
    }
    out
}

fn show_pairing_code(window: &ApplicationWindow, code: &str) {
    let vbox = GtkBox::new(Orientation::Vertical, 20);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);

    let title = logo_picture(BETTERFRAME_LOGO_SVG, 360, 88, "pairing-logo");

    let code_label = Label::new(Some(code));
    add_css(&code_label, ".code { font-size: 72px; color: #fff; font-weight: 700; letter-spacing: 12px; font-family: monospace; }");
    code_label.add_css_class("code");

    let hint = Label::new(Some("Enter this code in BetterFrame admin to pair"));
    add_css(&hint, ".hint { font-size: 14px; color: #666; }");
    hint.add_css_class("hint");

    vbox.append(&title);
    vbox.append(&code_label);
    vbox.append(&hint);
    window.set_child(Some(&vbox));
}

fn render_bundle(window: &ApplicationWindow, bundle: KioskBundle, server_url: &str, kiosk_key: &str) {
    let layout = match bundle.display.default_layout_id {
        Some(default_layout_id) => bundle.layouts.iter()
            .find(|l| l.id == default_layout_id)
            .or_else(|| bundle.layouts.iter().find(|l| l.is_default)),
        None => None,
    };

    let Some(layout) = layout else {
        warn!("display has no default layout");
        clear_warm_cameras();
        show_logo(window);
        return;
    };

    if layout.cells.is_empty() {
        warn!("layout has no cells");
        clear_warm_cameras();
        show_logo(window);
        return;
    }

    info!("rendering layout '{}' with {}x{} grid, {} cells",
        layout.name, layout.grid_cols, layout.grid_rows, layout.cells.len());

    // Compute which cameras are needed: cells with content_type=camera + preload_camera_ids
    let mut needed: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for cell in &layout.cells {
        if cell.content_type == "camera" {
            if let Some(id) = cell.camera_id { needed.insert(id); }
        }
    }
    for id in &layout.preload_camera_ids { needed.insert(*id); }

    // Stop pipelines for cameras no longer needed
    WARM_CAMERAS.with(|w| {
        let mut warm = w.borrow_mut();
        let stale: Vec<u32> = warm.keys().filter(|id| !needed.contains(id)).copied().collect();
        for id in stale {
            if let Some((pipe, _)) = warm.remove(&id) {
                info!("stopping pipeline for camera {id} (no longer needed)");
                pipeline::stop(&pipe);
            }
        }
    });

    let grid = Grid::new();
    grid.set_row_homogeneous(true);
    grid.set_column_homogeneous(true);
    grid.set_vexpand(true);
    grid.set_hexpand(true);

    let cam_map: std::collections::HashMap<u32, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id, c)).collect();

    // Ensure preloaded cameras have pipelines even if not visible
    for cam_id in &layout.preload_camera_ids {
        if let Some(cam) = cam_map.get(cam_id) {
            ensure_warm(*cam_id, cam, None);
        }
    }

    for cell in &layout.cells {
        let widget: gtk::Widget = match cell.content_type.as_str() {
            "camera" => {
                if let Some(cam_id) = cell.camera_id {
                    if let Some(cam) = cam_map.get(&cam_id) {
                        if let Some(paintable) = ensure_warm(cam_id, cam, cell.stream_selector.as_deref()) {
                            let picture = Picture::for_paintable(&paintable);
                            picture.set_content_fit(gtk::ContentFit::Cover);
                            picture.set_vexpand(true);
                            picture.set_hexpand(true);
                            picture.upcast()
                        } else {
                            placeholder(Some(&format!("{} (no stream)", cam.name)))
                        }
                    } else {
                        placeholder(Some("Unknown camera"))
                    }
                } else {
                    none_cell()
                }
            }
            "html" => {
                let html = cell.html_content.as_deref().unwrap_or("");
                if html.trim().is_empty() {
                    none_cell()
                } else {
                    let webview = webkit6::WebView::new();
                    webkit6::prelude::WebViewExt::load_html(&webview, html, None);
                    webview.set_vexpand(true);
                    webview.set_hexpand(true);
                    webview.upcast()
                }
            }
            "web" => {
                let url = cell.web_url.as_deref().unwrap_or("").trim();
                if url.is_empty() {
                    none_cell()
                } else {
                    let webview = webkit6::WebView::new();
                    load_webview_url(&webview, url, server_url, kiosk_key);
                    webview.set_vexpand(true);
                    webview.set_hexpand(true);
                    webview.upcast()
                }
            }
            "none" => none_cell(),
            _ => placeholder(Some("Unknown content")),
        };

        grid.attach(
            &widget,
            cell.col as i32,
            cell.row as i32,
            cell.col_span as i32,
            cell.row_span as i32,
        );
    }

    window.set_child(Some(&grid));
}

fn clear_warm_cameras() {
    WARM_CAMERAS.with(|w| {
        for (_, (pipe, _)) in w.borrow().iter() { pipeline::stop(pipe); }
        w.borrow_mut().clear();
    });
}

fn load_webview_url(webview: &webkit6::WebView, url: &str, server_url: &str, kiosk_key: &str) {
    if should_attach_kiosk_auth(url, server_url) {
        let request = webkit6::URIRequest::new(url);
        if let Some(headers) = request.http_headers() {
            headers.append("Authorization", &format!("Bearer {kiosk_key}"));
        }
        webkit6::prelude::WebViewExt::load_request(webview, &request);
        return;
    }

    webkit6::prelude::WebViewExt::load_uri(webview, url);
}

fn should_attach_kiosk_auth(url: &str, server_url: &str) -> bool {
    let Ok(target) = Url::parse(url) else { return false };
    let Ok(server) = Url::parse(server_url) else { return false };
    if target.scheme() != server.scheme()
        || target.host_str() != server.host_str()
        || target.port_or_known_default() != server.port_or_known_default()
    {
        return false;
    }

    let path = target.path();
    path.starts_with("/dash/") || path.starts_with("/in/kiosk/")
}

/// Returns the paintable for a camera, creating a warm pipeline if missing.
fn ensure_warm(
    cam_id: u32,
    cam: &crate::bundle::BundleCamera,
    selector: Option<&str>,
) -> Option<gtk::gdk::Paintable> {
    let existing = WARM_CAMERAS.with(|w| w.borrow().get(&cam_id).map(|(_, p)| p.clone()));
    if let Some(p) = existing {
        return Some(p);
    }
    let uri = cam.stream_uri(selector)?;
    let (pipe, sink) = pipeline::create_camera_pipeline(&cam.name, uri)?;
    let paintable = sink.property::<gtk::gdk::Paintable>("paintable");
    pipeline::play(&pipe);
    WARM_CAMERAS.with(|w| {
        w.borrow_mut().insert(cam_id, (pipe, paintable.clone()));
    });
    info!("warmed pipeline for camera {cam_id}");
    Some(paintable)
}

fn show_logo(window: &ApplicationWindow) {
    let vbox = GtkBox::new(Orientation::Vertical, 0);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);
    vbox.append(&logo_picture(BETTERFRAME_LOGO_SVG, 480, 118, "idle-logo"));
    window.set_child(Some(&vbox));
}

fn none_cell() -> gtk::Widget {
    placeholder(None)
}

fn placeholder(text: Option<&str>) -> gtk::Widget {
    let vbox = GtkBox::new(Orientation::Vertical, 8);
    add_css(
        &vbox,
        ".bf-placeholder { background-color: #111; } .bf-placeholder-text { color: #666; font-size: 14px; }",
    );
    vbox.add_css_class("bf-placeholder");
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);
    vbox.append(&logo_picture(BETTERFRAME_MARK_SVG, 56, 56, "cell-logo"));
    if let Some(text) = text {
        let label = Label::new(Some(text));
        label.add_css_class("bf-placeholder-text");
        vbox.append(&label);
    }
    vbox.upcast()
}

fn logo_picture(svg: &'static str, width: i32, height: i32, css_class: &str) -> gtk::Widget {
    let bytes = gtk::glib::Bytes::from_static(svg.as_bytes());
    match gtk::gdk::Texture::from_bytes(&bytes) {
        Ok(texture) => {
            let picture = Picture::for_paintable(&texture);
            picture.add_css_class(css_class);
            picture.set_content_fit(gtk::ContentFit::Contain);
            picture.set_can_shrink(true);
            picture.set_size_request(width, height);
            picture.set_valign(gtk::Align::Center);
            picture.set_halign(gtk::Align::Center);
            picture.upcast()
        }
        Err(err) => {
            warn!("failed to load embedded logo: {err}");
            let label = Label::new(Some("BetterFrame"));
            label.set_size_request(width, height);
            label.set_valign(gtk::Align::Center);
            label.set_halign(gtk::Align::Center);
            label.upcast()
        }
    }
}

fn add_css(widget: &impl IsA<gtk::Widget>, css: &str) {
    let provider = gtk::CssProvider::new();
    provider.load_from_string(css);
    gtk::style_context_add_provider_for_display(
        &widget.display(),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
}
