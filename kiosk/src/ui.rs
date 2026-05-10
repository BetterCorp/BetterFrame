use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc;

use gtk4::prelude::*;
use gtk4::{self as gtk, Application, ApplicationWindow, Box as GtkBox, Grid, Label, Orientation, Picture};
use tracing::{info, warn};

use crate::bundle::KioskBundle;
use crate::pipeline;
use crate::server;

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

    let server_url = std::env::args().nth(1);
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

        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            server::heartbeat(&server, &key);
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
    let layout = bundle.layouts.iter()
        .find(|l| l.is_default)
        .or_else(|| bundle.layouts.first());

    let Some(layout) = layout else {
        warn!("no layouts in bundle");
        show_logo(window);
        return;
    };

    let Some(ref template) = layout.template else {
        warn!("layout has no template");
        show_logo(window);
        return;
    };

    info!("rendering layout '{}' with {}x{} grid, {} cells",
        layout.name, template.grid_cols, template.grid_rows, layout.cells.len());

    let grid = Grid::new();
    grid.set_row_homogeneous(true);
    grid.set_column_homogeneous(true);
    grid.set_vexpand(true);
    grid.set_hexpand(true);

    let cam_map: std::collections::HashMap<u32, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id, c)).collect();

    let pipelines: Rc<RefCell<Vec<gstreamer::Pipeline>>> = Rc::new(RefCell::new(Vec::new()));

    for cell in &layout.cells {
        let region = template.regions.iter().find(|r| r.name == cell.region_name);
        let Some(region) = region else {
            warn!("region '{}' not found in template", cell.region_name);
            continue;
        };

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
                let html = cell.html_content.as_deref().unwrap_or("HTML");
                let label = Label::new(Some(&html.chars().take(100).collect::<String>()));
                add_css(&label, "label { color: #888; background-color: #111; }");
                label.set_vexpand(true);
                label.set_hexpand(true);
                label.upcast()
            }
            "web" => {
                let url = cell.web_url.as_deref().unwrap_or("about:blank");
                placeholder(&format!("Web: {url}"))
            }
            _ => placeholder("Unknown content"),
        };

        grid.attach(
            &widget,
            region.col as i32,
            region.row as i32,
            region.col_span as i32,
            region.row_span as i32,
        );
    }

    // Fill empty regions
    for region in &template.regions {
        if !layout.cells.iter().any(|c| c.region_name == region.name) {
            let empty = GtkBox::new(Orientation::Vertical, 0);
            add_css(&empty, "box { background-color: #111; }");
            empty.set_vexpand(true);
            empty.set_hexpand(true);
            grid.attach(
                &empty,
                region.col as i32,
                region.row as i32,
                region.col_span as i32,
                region.row_span as i32,
            );
        }
    }

    window.set_child(Some(&grid));

    let pipelines_ref = pipelines.clone();
    window.connect_destroy(move |_| {
        for pipe in pipelines_ref.borrow().iter() {
            pipeline::stop(pipe);
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
