use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use url::Url;

use gtk4::prelude::*;
use gtk4::{self as gtk, Application, ApplicationWindow, Box as GtkBox, Grid, Label, Orientation, Picture};
use tracing::{info, warn};

use crate::bundle::{BundleDisplayWithLayouts, KioskBundle};
use crate::cec;
use crate::gpio;
use crate::hwmon;
use crate::pipeline;
use crate::server;
use crate::ws_client;
use crate::ServerMsg;

/// Per-display runtime state. Kept inside a thread-local hashmap keyed by
/// display id, so all the idle/sleep/layout tracking is local to that display
/// even though the GTK main loop is shared.
struct DisplayState {
    window: ApplicationWindow,
    current_layout_id: Option<u32>,
    last_activity: Instant,
    is_asleep: bool,
}

/// Pipeline lifecycle states (CLAUDE.md hot/warm/cooling/cold model):
/// - Hot: belongs to a priority=hot layout — keep warm forever
/// - Warm: actively rendered OR in active layout's preload list — decoding live
/// - Cooling: was warm, now not needed, kept alive until cooling_until
/// - Cold: removed from pool (no entry)
#[derive(Debug, Clone, Copy, PartialEq)]
enum WarmthState {
    Hot,
    Warm,
    Cooling,
}

struct PipelineEntry {
    pipeline: gstreamer::Pipeline,
    paintable: gtk::gdk::Paintable,
    badge: char,
    state: WarmthState,
    cooling_until: Option<Instant>,
}

thread_local! {
    /// camera_id → PipelineEntry. Pool shared across all displays.
    /// State machine: see WarmthState. Entries dropped when state goes Cold.
    static WARM_CAMERAS: RefCell<HashMap<u32, PipelineEntry>>
        = RefCell::new(HashMap::new());

    /// Most recently rendered bundle. Used for layout-switch + idle revert.
    static CURRENT_BUNDLE: RefCell<Option<KioskBundle>> = const { RefCell::new(None) };

    /// Server URL + kiosk key for re-rendering on layout-switch.
    static CURRENT_AUTH: RefCell<Option<(String, String)>> = const { RefCell::new(None) };

    /// Per-display state, keyed by bundle display id.
    static DISPLAYS: RefCell<HashMap<u32, DisplayState>> = RefCell::new(HashMap::new());

    /// Has the idle-watchdog already been installed on the main loop?
    static WATCHDOG_INSTALLED: Cell<bool> = const { Cell::new(false) };
}

const APP_ID: &str = "dev.betterframe.kiosk";
const BETTERFRAME_LOGO_SVG: &str = include_str!("../../server/src/web-static/betterframe-logo.svg");
const BETTERFRAME_MARK_SVG: &str = include_str!("../../server/src/web-static/betterframe-mark.svg");

pub fn build_app() -> Application {
    let app = Application::builder().application_id(APP_ID).build();
    app.connect_activate(activate);
    app
}

fn activate(app: &Application) {
    // Create the initial pairing window. Multi-display windows are spawned
    // later once we receive a bundle.
    let pairing_window = ApplicationWindow::builder()
        .application(app)
        .title("BetterFrame")
        .fullscreened(true)
        .build();

    let provider = gtk::CssProvider::new();
    provider.load_from_string("window { background-color: #000000; }");
    gtk::style_context_add_provider_for_display(
        &WidgetExt::display(&pairing_window),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    show_logo(&pairing_window);
    pairing_window.present();

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

        // Try fetching live bundle. If server unreachable, fall back to
        // cached on-disk bundle and keep retrying every 30s in the background.
        let initial = match server::fetch_bundle(&server, &key) {
            Some(b) => {
                info!("bundle: {} cameras, {} display(s)", b.cameras.len(), b.normalized_displays().len());
                Some(b)
            }
            None => {
                if let Some(cached) = server::load_cached_bundle() {
                    warn!("offline mode: rendering cached bundle");
                    Some(cached)
                } else {
                    warn!("no bundle available (server unreachable, no cache)");
                    None
                }
            }
        };

        if let Some(bundle) = initial {
            let _ = tx.send(WorkerMsg::RenderBundle(bundle, server.clone(), key.clone()));
        }

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

        // Background retry thread: if we couldn't fetch a live bundle on boot,
        // try again every 30s until we get one. Once fetched, send a render.
        let retry_tx = tx.clone();
        let retry_server = server.clone();
        let retry_key = key.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(30));
                if let Some(b) = server::fetch_bundle(&retry_server, &retry_key) {
                    info!("offline-retry: fresh bundle fetched, rendering");
                    let _ = retry_tx.send(WorkerMsg::RenderBundle(
                        b,
                        retry_server.clone(),
                        retry_key.clone(),
                    ));
                    return;
                }
            }
        });

        // Listen for WS messages and dispatch
        std::thread::spawn(move || {
            for msg in ws_rx {
                match msg {
                    ServerMsg::ReloadBundle => {
                        info!("reloading bundle");
                        match server::fetch_bundle(&server_for_reload, &key_for_reload) {
                            Some(bundle) => {
                                let _ = tx_for_reload.send(WorkerMsg::RenderBundle(
                                    bundle,
                                    server_for_reload.clone(),
                                    key_for_reload.clone(),
                                ));
                            }
                            None => warn!("reload-bundle: fetch failed, keeping current render"),
                        }
                    }
                    ServerMsg::Standby => cec::standby(),
                    ServerMsg::Wake => {
                        let _ = tx_for_reload.send(WorkerMsg::Wake);
                    }
                    ServerMsg::Fan(pwm) => { hwmon::set_fan(pwm); }
                    ServerMsg::SwitchLayout(id) => {
                        let _ = tx_for_reload.send(WorkerMsg::SwitchLayout(id));
                    }
                }
            }
        });

        // Heartbeat loop — reports display geometry + hwmon
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            let displays = query_displays();
            let hw = hwmon::read();
            server::heartbeat(&server, &key, &displays, &hw);
        }
    });

    // Poll channel from UI thread via timeout
    let app_clone = app.clone();
    let pairing_window_clone = pairing_window.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
        while let Ok(msg) = rx.try_recv() {
            match msg {
                WorkerMsg::ShowPairingCode(code) => show_pairing_code(&pairing_window_clone, &code),
                WorkerMsg::RenderBundle(bundle, server, key) => {
                    render_bundle(&app_clone, &pairing_window_clone, bundle, &server, &key);
                    install_idle_watchdog();
                }
                WorkerMsg::SwitchLayout(id) => {
                    switch_layout_anywhere(id);
                }
                WorkerMsg::Wake => {
                    cec::wake();
                    DISPLAYS.with(|ds| {
                        for st in ds.borrow_mut().values_mut() {
                            st.is_asleep = false;
                            st.last_activity = Instant::now();
                        }
                    });
                }
            }
        }
        gtk::glib::ControlFlow::Continue
    });
}

enum WorkerMsg {
    ShowPairingCode(String),
    RenderBundle(KioskBundle, String, String),
    SwitchLayout(u32),
    Wake,
}

/// Reset activity timer for one display. If asleep, wake it.
fn mark_activity(display_id: u32) {
    DISPLAYS.with(|ds| {
        if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
            st.last_activity = Instant::now();
            if st.is_asleep {
                info!("activity while asleep → waking display {display_id}");
                cec::wake();
                st.is_asleep = false;
            }
        }
    });
}

/// Install the once-per-second watchdog that enforces idle/sleep timeouts
/// per display. Safe to call multiple times — installs at most once.
fn install_idle_watchdog() {
    if WATCHDOG_INSTALLED.with(|c| c.get()) { return; }
    WATCHDOG_INSTALLED.with(|c| c.set(true));
    gtk::glib::timeout_add_local(Duration::from_secs(1), move || {
        let bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
        let Some(bundle) = bundle else { return gtk::glib::ControlFlow::Continue };

        // Snapshot per-display timing decisions so we can act outside the borrow.
        struct Action { display_id: u32, revert_to: Option<u32>, sleep: bool }
        let mut actions: Vec<Action> = Vec::new();

        DISPLAYS.with(|ds| {
            for (display_id, st) in ds.borrow().iter() {
                let Some(d) = bundle.normalized_displays().into_iter().find(|d| d.id == *display_id) else { continue };
                let idle_to = d.idle_timeout_seconds as u64;
                let sleep_to = d.sleep_timeout_seconds as u64;
                let elapsed = st.last_activity.elapsed();
                let default_id = d.default_layout_id;

                let mut act = Action { display_id: *display_id, revert_to: None, sleep: false };

                if idle_to > 0 && elapsed >= Duration::from_secs(idle_to) {
                    let cur_resets_idle = st.current_layout_id
                        .and_then(|cur_id| d.layouts.iter().find(|l| l.id == cur_id))
                        .map(|l| l.resets_idle_timer)
                        .unwrap_or(false);
                    if let (Some(cur_id), Some(def_id)) = (st.current_layout_id, default_id) {
                        if cur_id != def_id && cur_resets_idle {
                            act.revert_to = Some(def_id);
                        }
                    }
                }
                if sleep_to > 0 && elapsed >= Duration::from_secs(sleep_to) && !st.is_asleep {
                    act.sleep = true;
                }
                if act.revert_to.is_some() || act.sleep {
                    actions.push(act);
                }
            }
        });

        for a in actions {
            if let Some(layout_id) = a.revert_to {
                info!("idle timeout reached → reverting display {} to default", a.display_id);
                render_layout(a.display_id, layout_id);
            }
            if a.sleep {
                info!("sleep timeout reached on display {} → CEC standby", a.display_id);
                cec::standby();
                DISPLAYS.with(|ds| {
                    if let Some(st) = ds.borrow_mut().get_mut(&a.display_id) {
                        st.is_asleep = true;
                    }
                });
            }
        }

        gtk::glib::ControlFlow::Continue
    });
}

/// Query connected HDMI displays from sysfs. Returns (name, width, height).
/// Reads /sys/class/drm/*/status and /sys/class/drm/*/modes.
fn query_displays() -> Vec<(String, u32, u32)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.contains("-HDMI-") && !name.contains("-DP-") { continue; }
        let path = entry.path();
        let status = std::fs::read_to_string(path.join("status")).unwrap_or_default();
        if status.trim() != "connected" { continue; }
        let modes = std::fs::read_to_string(path.join("modes")).unwrap_or_default();
        let mode = modes.lines().next().unwrap_or("");
        let parts: Vec<&str> = mode.split('x').collect();
        if parts.len() != 2 { continue; }
        let w: u32 = parts[0].parse().unwrap_or(0);
        let h: u32 = parts[1].trim().parse().unwrap_or(0);
        if w == 0 || h == 0 { continue; }
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

/// Render a fresh bundle: rebuild the per-display window set, restart GPIO
/// workers, recompute warm-camera needs across all displays.
fn render_bundle(
    app: &Application,
    pairing_window: &ApplicationWindow,
    bundle: KioskBundle,
    server_url: &str,
    kiosk_key: &str,
) {
    CURRENT_BUNDLE.with(|b| *b.borrow_mut() = Some(bundle.clone()));
    CURRENT_AUTH.with(|a| *a.borrow_mut() = Some((server_url.to_string(), kiosk_key.to_string())));

    // Restart GPIO workers (always — even if list is empty, this drops the old set).
    gpio::start_workers(&bundle.gpio_bindings, server_url, kiosk_key);

    let displays = bundle.normalized_displays();
    if displays.is_empty() {
        warn!("bundle has no displays");
        show_logo(pairing_window);
        return;
    }

    // Match GDK monitors to bundle displays by index. Bundle display 0 → GDK
    // monitor 0, etc. v1 simple ordering — re-binding will land if/when the
    // admin UI exposes a mapping. Falls back to overlapping windows on a
    // single physical screen if the kiosk has fewer monitors than bundle
    // displays (rare on Pi5).
    let gdk_monitors: Vec<gtk::gdk::Monitor> = WidgetExt::display(pairing_window)
        .monitors()
        .iter::<gtk::gdk::Monitor>()
        .flatten()
        .collect();

    // Tear down any previous per-display windows we no longer need.
    let keep_ids: std::collections::HashSet<u32> = displays.iter().map(|d| d.id).collect();
    let to_remove: Vec<u32> = DISPLAYS.with(|ds| {
        ds.borrow().keys().filter(|id| !keep_ids.contains(id)).copied().collect()
    });
    for id in to_remove {
        if let Some(st) = DISPLAYS.with(|ds| ds.borrow_mut().remove(&id)) {
            st.window.close();
        }
    }

    // Compute warm vs hot camera sets per the CLAUDE.md model.
    // Warm = cameras in the currently-active layout (cells + preload) of any display.
    // Hot  = cameras referenced by ANY layout with priority=hot (kept warm always).
    // Anything previously cached but in neither set transitions to Cooling.
    let mut warm_set: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut hot_set: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut max_cooling_secs: u32 = 0;
    for (i, bd) in displays.iter().enumerate() {
        let target_id = pick_initial_layout(bd);
        if let Some(target_id) = target_id {
            if let Some(layout) = bd.layouts.iter().find(|l| l.id == target_id) {
                for cell in &layout.cells {
                    if cell.content_type == "camera" {
                        if let Some(id) = cell.camera_id { warm_set.insert(id); }
                    }
                }
                for id in &layout.preload_camera_ids { warm_set.insert(*id); }
                if let Some(t) = layout.cooling_timeout_seconds { max_cooling_secs = max_cooling_secs.max(t); }
            }
        }
        // Hot layouts keep their cameras warm even when not active.
        for layout in &bd.layouts {
            if layout.priority == "hot" {
                for cell in &layout.cells {
                    if cell.content_type == "camera" {
                        if let Some(id) = cell.camera_id { hot_set.insert(id); }
                    }
                }
                for id in &layout.preload_camera_ids { hot_set.insert(*id); }
            }
        }
        let _ = gdk_monitors.get(i);
    }

    recompute_pool_states(&warm_set, &hot_set, max_cooling_secs);

    // Build/reuse window per bundle display, then render its initial layout.
    let mut new_state: HashMap<u32, DisplayState> = HashMap::new();
    for (i, bd) in displays.iter().enumerate() {
        let existing = DISPLAYS.with(|ds| ds.borrow_mut().remove(&bd.id));
        let window = match existing {
            Some(st) => st.window,
            None => {
                let w = ApplicationWindow::builder()
                    .application(app)
                    .title(format!("BetterFrame — {}", bd.name))
                    .fullscreened(true)
                    .build();
                let provider = gtk::CssProvider::new();
                provider.load_from_string("window { background-color: #000000; }");
                gtk::style_context_add_provider_for_display(
                    &WidgetExt::display(&w),
                    &provider,
                    gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
                );
                w.present();
                if let Some(monitor) = gdk_monitors.get(i) {
                    w.fullscreen_on_monitor(monitor);
                }
                w
            }
        };
        new_state.insert(bd.id, DisplayState {
            window,
            current_layout_id: None,
            last_activity: Instant::now(),
            is_asleep: false,
        });
    }
    DISPLAYS.with(|ds| *ds.borrow_mut() = new_state);

    // Hide the pairing window now that real displays are up (if we created any).
    if !displays.is_empty() {
        pairing_window.set_visible(false);
    }

    // Now render each display's initial layout.
    for bd in &displays {
        let target = pick_initial_layout(bd);
        if let Some(layout_id) = target {
            render_layout(bd.id, layout_id);
        } else {
            warn!("display {} has no default layout", bd.id);
            DISPLAYS.with(|ds| {
                if let Some(st) = ds.borrow_mut().get_mut(&bd.id) {
                    show_logo(&st.window);
                    st.current_layout_id = None;
                }
            });
        }
    }
}

fn pick_initial_layout(bd: &BundleDisplayWithLayouts) -> Option<u32> {
    bd.default_layout_id
        .or_else(|| bd.layouts.iter().find(|l| l.is_default).map(|l| l.id))
        .or_else(|| bd.layouts.first().map(|l| l.id))
}

/// Find which display owns a given layout_id and render it there.
fn switch_layout_anywhere(layout_id: u32) {
    let bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
    let Some(bundle) = bundle else { return };
    for bd in bundle.normalized_displays() {
        if bd.layouts.iter().any(|l| l.id == layout_id) {
            render_layout(bd.id, layout_id);
            return;
        }
    }
    warn!("switch_layout: layout {layout_id} not found on any display");
}

/// Render a specific layout id on a specific display.
fn render_layout(display_id: u32, layout_id: u32) {
    mark_activity(display_id);

    let snapshot: Option<(KioskBundle, String, String)> = CURRENT_BUNDLE.with(|b| {
        let bundle = b.borrow();
        let bundle = bundle.as_ref()?.clone();
        let auth = CURRENT_AUTH.with(|a| a.borrow().clone());
        let (server_url, kiosk_key) = auth?;
        Some((bundle, server_url, kiosk_key))
    });
    let Some((bundle, server_url, kiosk_key)) = snapshot else {
        warn!("render_layout: no cached bundle yet");
        return;
    };

    let displays = bundle.normalized_displays();
    let Some(bd) = displays.iter().find(|d| d.id == display_id) else {
        warn!("render_layout: display {display_id} not in bundle");
        return;
    };

    let layout = bd.layouts.iter().find(|l| l.id == layout_id)
        .or_else(|| {
            warn!("render_layout: layout {layout_id} not on display {display_id}, falling back to default");
            bd.default_layout_id
                .and_then(|did| bd.layouts.iter().find(|l| l.id == did))
                .or_else(|| bd.layouts.iter().find(|l| l.is_default))
        });

    let Some(layout) = layout else {
        warn!("render_layout: no usable layout on display {display_id}");
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
                show_logo(&st.window);
                st.current_layout_id = None;
            }
        });
        return;
    };

    // Update per-display layout id BEFORE recomputing warm-cameras so the
    // union across displays is correct.
    DISPLAYS.with(|ds| {
        if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
            st.current_layout_id = Some(layout.id);
        }
    });

    info!("rendering layout '{}' (id {}) on display {} ({}x{} grid, {} cells)",
        layout.name, layout.id, display_id, layout.grid_cols, layout.grid_rows, layout.cells.len());

    if layout.cells.is_empty() {
        warn!("layout has no cells");
        recompute_warm_cameras(&bundle);
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
                show_logo(&st.window);
            }
        });
        return;
    }

    // Recompute warm-camera set across ALL displays (the union), then drop
    // pipelines no longer needed anywhere.
    recompute_warm_cameras(&bundle);

    let server_url = server_url.as_str();
    let kiosk_key = kiosk_key.as_str();

    let grid = Grid::new();
    grid.set_row_homogeneous(true);
    grid.set_column_homogeneous(true);
    grid.set_vexpand(true);
    grid.set_hexpand(true);

    let cam_map: HashMap<u32, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id, c)).collect();

    let total_area = (layout.grid_cols.max(1) * layout.grid_rows.max(1)) as f32;

    // Ensure preloaded cameras have pipelines even if not visible.
    for cam_id in &layout.preload_camera_ids {
        if let Some(cam) = cam_map.get(cam_id) {
            ensure_warm(*cam_id, cam, None, 0.0);
        }
    }

    for cell in &layout.cells {
        let widget: gtk::Widget = match cell.content_type.as_str() {
            "camera" => {
                if let Some(cam_id) = cell.camera_id {
                    if let Some(cam) = cam_map.get(&cam_id) {
                        let area = (cell.col_span * cell.row_span) as f32 / total_area;
                        if let Some((paintable, badge)) = ensure_warm(cam_id, cam, cell.stream_selector.as_deref(), area) {
                            let picture = Picture::for_paintable(&paintable);
                            picture.set_content_fit(match cell.fit.as_str() {
                                "contain" => gtk::ContentFit::Contain,
                                "fill" => gtk::ContentFit::Fill,
                                _ => gtk::ContentFit::Cover,
                            });
                            picture.set_vexpand(true);
                            picture.set_hexpand(true);
                            let overlay = gtk::Overlay::new();
                            overlay.set_child(Some(&picture));
                            overlay.set_vexpand(true);
                            overlay.set_hexpand(true);
                            if badge == 'M' || badge == 'S' {
                                let label = Label::new(Some(&badge.to_string()));
                                label.set_halign(gtk::Align::Start);
                                label.set_valign(gtk::Align::Start);
                                label.set_margin_start(4);
                                label.set_margin_top(4);
                                add_css(&label, "label { background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; min-width: 14px; }");
                                overlay.add_overlay(&label);
                            }
                            overlay.upcast()
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

    DISPLAYS.with(|ds| {
        if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
            st.window.set_child(Some(&grid));
        }
    });
}

/// Compute the union of cameras needed across all displays' current layouts +
/// preload sets, then drop any warm pipelines outside that set.
fn recompute_warm_cameras(bundle: &KioskBundle) {
    let mut needed: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let displays = bundle.normalized_displays();
    DISPLAYS.with(|ds| {
        for (display_id, st) in ds.borrow().iter() {
            let Some(bd) = displays.iter().find(|d| d.id == *display_id) else { continue };
            let Some(cur_id) = st.current_layout_id else { continue };
            let Some(layout) = bd.layouts.iter().find(|l| l.id == cur_id) else { continue };
            for cell in &layout.cells {
                if cell.content_type == "camera" {
                    if let Some(id) = cell.camera_id { needed.insert(id); }
                }
            }
            for id in &layout.preload_camera_ids { needed.insert(*id); }
        }
    });
    WARM_CAMERAS.with(|w| {
        let mut warm = w.borrow_mut();
        let stale: Vec<u32> = warm.keys().filter(|id| !needed.contains(id)).copied().collect();
        for id in stale {
            if let Some((pipe, _, _)) = warm.remove(&id) {
                info!("stopping pipeline for camera {id} (no longer needed)");
                pipeline::stop(&pipe);
            }
        }
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

/// Returns (paintable, badge_char) for a camera, creating a warm pipeline if missing.
/// If cached pipeline's stream differs from what the cell needs (M↔S swap due
/// to layout change), tear down old and spin up new.
fn ensure_warm(
    cam_id: u32,
    cam: &crate::bundle::BundleCamera,
    selector: Option<&str>,
    area_fraction: f32,
) -> Option<(gtk::gdk::Paintable, char)> {
    let (uri, desired_badge) = cam.pick_stream(selector, area_fraction)?;

    let cached = WARM_CAMERAS.with(|w| {
        w.borrow().get(&cam_id).map(|(p, paint, b)| (p.clone(), paint.clone(), *b))
    });
    if let Some((pipe, paintable, badge)) = cached {
        if badge == desired_badge {
            return Some((paintable, badge));
        }
        info!("camera {cam_id}: stream change {badge} → {desired_badge}, swapping");
        pipeline::stop(&pipe);
        WARM_CAMERAS.with(|w| { w.borrow_mut().remove(&cam_id); });
    }

    let (pipe, sink) = pipeline::create_camera_pipeline(&cam.name, &uri)?;
    let paintable = sink.property::<gtk::gdk::Paintable>("paintable");
    pipeline::play(&pipe);
    WARM_CAMERAS.with(|w| {
        w.borrow_mut().insert(cam_id, (pipe, paintable.clone(), desired_badge));
    });
    info!("warmed pipeline for camera {cam_id} (stream: {desired_badge})");
    Some((paintable, desired_badge))
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
