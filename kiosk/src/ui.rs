use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc;

thread_local! {
    static ACTIVE_PIPELINES: RefCell<Vec<gstreamer::Pipeline>> = RefCell::new(Vec::new());
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
        let _ = tx.send(WorkerMsg::RenderBundle(bundle));

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
                        let _ = tx_for_reload.send(WorkerMsg::RenderBundle(bundle));
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
                WorkerMsg::RenderBundle(bundle) => render_bundle(&window_clone, bundle),
            }
        }
        gtk::glib::ControlFlow::Continue
    });
}

enum WorkerMsg {
    ShowPairingCode(String),
    RenderBundle(KioskBundle),
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

    let title = Label::new(Some("BetterFrame"));
    add_css(&title, ".title { font-size: 24px; color: #888; font-weight: 300; }");
    title.add_css_class("title");

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

fn render_bundle(window: &ApplicationWindow, bundle: KioskBundle) {
    // Stop and clear any existing pipelines BEFORE building the new layout
    ACTIVE_PIPELINES.with(|p| {
        let mut pipes = p.borrow_mut();
        info!("stopping {} active pipelines before re-render", pipes.len());
        for pipe in pipes.iter() {
            pipeline::stop(pipe);
        }
        pipes.clear();
    });

    let layout = bundle.layouts.iter()
        .find(|l| l.is_default)
        .or_else(|| bundle.layouts.first());

    let Some(layout) = layout else {
        warn!("no layouts in bundle");
        show_logo(window);
        return;
    };

    if layout.cells.is_empty() {
        warn!("layout has no cells");
        show_logo(window);
        return;
    }

    info!("rendering layout '{}' with {}x{} grid, {} cells",
        layout.name, layout.grid_cols, layout.grid_rows, layout.cells.len());

    let grid = Grid::new();
    grid.set_row_homogeneous(true);
    grid.set_column_homogeneous(true);
    grid.set_vexpand(true);
    grid.set_hexpand(true);

    let cam_map: std::collections::HashMap<u32, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id, c)).collect();

    let pipelines: Rc<RefCell<Vec<gstreamer::Pipeline>>> = Rc::new(RefCell::new(Vec::new()));

    for cell in &layout.cells {
        let widget: gtk::Widget = match cell.content_type.as_str() {
            "camera" => {
                if let Some(cam_id) = cell.camera_id {
                    if let Some(cam) = cam_map.get(&cam_id) {
                        if let Some(uri) = cam.stream_uri(cell.stream_selector.as_deref()) {
                            match pipeline::create_camera_pipeline(&cam.name, uri) {
                                Some((pipe, sink)) => {
                                    let paintable = sink.property::<gtk::gdk::Paintable>("paintable");
                                    let picture = Picture::for_paintable(&paintable);
                                    picture.set_content_fit(gtk::ContentFit::Cover);
                                    picture.set_vexpand(true);
                                    picture.set_hexpand(true);
                                    pipeline::play(&pipe);
                                    pipelines.borrow_mut().push(pipe);
                                    picture.upcast()
                                }
                                None => placeholder(&format!("{} (pipeline error)", cam.name)),
                            }
                        } else {
                            placeholder(&format!("{} (no stream)", cam.name))
                        }
                    } else {
                        placeholder("Unknown camera")
                    }
                } else {
                    placeholder("No camera assigned")
                }
            }
            "html" => {
                let html = cell.html_content.as_deref().unwrap_or("");
                let webview = webkit6::WebView::new();
                webkit6::prelude::WebViewExt::load_html(&webview, html, None);
                webview.set_vexpand(true);
                webview.set_hexpand(true);
                webview.upcast()
            }
            "web" => {
                let url = cell.web_url.as_deref().unwrap_or("about:blank");
                let webview = webkit6::WebView::new();
                webkit6::prelude::WebViewExt::load_uri(&webview, url);
                webview.set_vexpand(true);
                webview.set_hexpand(true);
                webview.upcast()
            }
            _ => placeholder("Unknown content"),
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

    // Move newly-created pipelines into the global registry so we can stop
    // them on the next reload-bundle
    ACTIVE_PIPELINES.with(|p| {
        let mut global = p.borrow_mut();
        for pipe in pipelines.borrow().iter() {
            global.push(pipe.clone());
        }
    });
}

fn show_logo(window: &ApplicationWindow) {
    let label = Label::new(Some("BetterFrame"));
    add_css(&label, "label { font-size: 48px; color: #fff; font-weight: 300; }");
    label.set_valign(gtk::Align::Center);
    label.set_halign(gtk::Align::Center);
    label.set_vexpand(true);
    window.set_child(Some(&label));
}

fn placeholder(text: &str) -> gtk::Widget {
    let label = Label::new(Some(text));
    add_css(&label, "label { color: #666; font-size: 14px; background-color: #111; }");
    label.set_vexpand(true);
    label.set_hexpand(true);
    label.upcast()
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
