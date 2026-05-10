use std::cell::RefCell;
use std::rc::Rc;

use gtk4::prelude::*;
use gtk4::{self as gtk, Application, ApplicationWindow, Box as GtkBox, Grid, Label, Orientation, Picture};
use gstreamer::prelude::*;
use tracing::{info, warn};

use crate::bundle::{BundleLayout, KioskBundle};
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

    // Dark background
    let provider = gtk::CssProvider::new();
    provider.load_from_string("window { background-color: #1a1a2e; }");
    gtk::style_context_add_provider_for_display(
        &window.display(),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    let container = GtkBox::new(Orientation::Vertical, 0);
    container.set_vexpand(true);
    container.set_hexpand(true);
    window.set_child(Some(&container));

    // Show pairing or camera display
    let server_url = std::env::args().nth(1);
    let container_clone = container.clone();
    let window_clone = window.clone();

    // Run server interaction in a thread, update UI via idle_add
    std::thread::spawn(move || {
        let server = server::discover_server(server_url.as_deref());
        info!("server: {server}");

        let key = if server::is_paired() {
            info!("already paired");
            server::load_key()
        } else {
            let (code, expires) = server::initiate_pairing(&server);
            info!("pairing code: {code} (expires {expires})");

            // Show pairing code on UI
            let code_clone = code.clone();
            gtk::glib::idle_add_once(move || {
                show_pairing_code(&container_clone, &code_clone);
            });

            let (name, key) = server::poll_claim(&server, &code);
            info!("paired as: {name}");
            key
        };

        // Fetch bundle
        let bundle = server::fetch_bundle(&server, &key);
        info!("bundle: {} cameras, {} layouts", bundle.cameras.len(), bundle.layouts.len());

        // Render layout on UI thread
        let server_clone = server.clone();
        let key_clone = key.clone();
        gtk::glib::idle_add_once(move || {
            render_bundle(&window_clone, bundle);
        });

        // Heartbeat loop
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            server::heartbeat(&server_clone, &key_clone);
        }
    });

    window.present();
}

fn show_pairing_code(container: &GtkBox, code: &str) {
    // Clear existing children
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }

    let vbox = GtkBox::new(Orientation::Vertical, 20);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);

    let title = Label::new(Some("BetterFrame"));
    title.add_css_class("title");
    let title_provider = gtk::CssProvider::new();
    title_provider.load_from_string(".title { font-size: 24px; color: #888; font-weight: 300; }");
    gtk::style_context_add_provider_for_display(
        &title.display(),
        &title_provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    let code_label = Label::new(Some(code));
    code_label.add_css_class("pairing-code");
    let code_provider = gtk::CssProvider::new();
    code_provider.load_from_string(
        ".pairing-code { font-size: 72px; color: #fff; font-weight: 700; letter-spacing: 12px; font-family: monospace; }",
    );
    gtk::style_context_add_provider_for_display(
        &code_label.display(),
        &code_provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    let hint = Label::new(Some("Enter this code in BetterFrame admin to pair"));
    hint.add_css_class("hint");
    let hint_provider = gtk::CssProvider::new();
    hint_provider.load_from_string(".hint { font-size: 14px; color: #666; }");
    gtk::style_context_add_provider_for_display(
        &hint.display(),
        &hint_provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    vbox.append(&title);
    vbox.append(&code_label);
    vbox.append(&hint);
    container.append(&vbox);
}

fn render_bundle(window: &ApplicationWindow, bundle: KioskBundle) {
    // Find default layout
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

    // Map cameras by ID for quick lookup
    let cam_map: std::collections::HashMap<u32, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id, c)).collect();

    let pipelines: Rc<RefCell<Vec<gstreamer::Pipeline>>> = Rc::new(RefCell::new(Vec::new()));

    for cell in &layout.cells {
        // Find region in template
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
                                None => placeholder_label(&format!("{} (pipeline error)", cam.name)),
                            }
                        } else {
                            placeholder_label(&format!("{} (no stream)", cam.name))
                        }
                    } else {
                        placeholder_label("Unknown camera")
                    }
                } else {
                    placeholder_label("No camera assigned")
                }
            }
            "html" => {
                let html = cell.html_content.as_deref().unwrap_or("");
                // For HTML cells, show a label placeholder (WebKit integration later)
                let label = Label::new(Some("HTML Content"));
                label.set_markup(&format!("<span color='#888'>{}</span>",
                    gtk::glib::markup_escape_text(html).chars().take(100).collect::<String>()));
                label.set_vexpand(true);
                label.set_hexpand(true);
                label.upcast()
            }
            "web" => {
                let url = cell.web_url.as_deref().unwrap_or("about:blank");
                placeholder_label(&format!("Web: {url}"))
            }
            _ => placeholder_label("Unknown content"),
        };

        grid.attach(
            &widget,
            region.col as i32,
            region.row as i32,
            region.col_span as i32,
            region.row_span as i32,
        );
    }

    // Fill empty regions with dark placeholders
    for region in &template.regions {
        if !layout.cells.iter().any(|c| c.region_name == region.name) {
            let empty = GtkBox::new(Orientation::Vertical, 0);
            let empty_provider = gtk::CssProvider::new();
            empty_provider.load_from_string("box { background-color: #111; }");
            gtk::style_context_add_provider_for_display(
                &empty.display(),
                &empty_provider,
                gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
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

    // Store pipelines so they don't get dropped
    window.connect_destroy(move |_| {
        for pipe in pipelines.borrow().iter() {
            pipeline::stop(pipe);
        }
    });
}

fn show_logo(window: &ApplicationWindow) {
    let label = Label::new(Some("BetterFrame"));
    let provider = gtk::CssProvider::new();
    provider.load_from_string("label { font-size: 48px; color: #fff; font-weight: 300; }");
    gtk::style_context_add_provider_for_display(
        &label.display(),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
    label.set_valign(gtk::Align::Center);
    label.set_halign(gtk::Align::Center);
    label.set_vexpand(true);
    window.set_child(Some(&label));
}

fn placeholder_label(text: &str) -> gtk::Widget {
    let label = Label::new(Some(text));
    label.set_vexpand(true);
    label.set_hexpand(true);
    let provider = gtk::CssProvider::new();
    provider.load_from_string("label { color: #666; font-size: 14px; background-color: #111; }");
    gtk::style_context_add_provider_for_display(
        &label.display(),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );
    label.upcast()
}
