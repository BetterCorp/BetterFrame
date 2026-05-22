use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use url::Url;

use gtk4::prelude::*;
use gtk4::{
    self as gtk, Application, ApplicationWindow, Box as GtkBox, Grid, Label, Orientation, Picture,
};
use tracing::{info, warn};

use crate::ServerMsg;
use crate::bundle::{BundleDisplayWithLayouts, KioskBundle};
use crate::cec;
use crate::firmware;
use crate::gpio;
use crate::hwmon;
use crate::local_server;
use crate::onvif_events;
use crate::os_update;
use crate::remote_debug;
use crate::pipeline;
use crate::server;
use crate::ws_client;

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
    state: WarmthState,
    cooling_until: Option<Instant>,
}

/// Pool key. A camera can have multiple concurrent pipelines — typically one
/// per (main, sub, other) stream — each with independent warmth state. When a
/// cell switches M↔S we promote the new variant to Warm/Hot but leave the old
/// one to cool down naturally so a quick swap back is instant.
type PoolKey = (u32, char);

/// WebView pool entry. Same Hot/Warm/Cooling/Cold lifecycle as cameras —
/// switching to a layout that doesn't reference a previously-loaded URL/HTML
/// leaves the WebView alive (unparented) so a fast switch-back preserves the
/// page state, JS execution, and avoids a full reload.
struct WebEntry {
    webview: webkit6::WebView,
    state: WarmthState,
    cooling_until: Option<Instant>,
}

/// Key for the webview pool. "web:<url>" for remote pages, "html:<hash>" for
/// inline HTML. Same content under either form across multiple cells/layouts
/// shares one WebView.
type WebKey = String;

thread_local! {
    /// (camera_id, badge) → PipelineEntry. Pool shared across all displays.
    /// State machine: see WarmthState. Entries dropped when state goes Cold.
    static WARM_CAMERAS: RefCell<HashMap<PoolKey, PipelineEntry>>
        = RefCell::new(HashMap::new());

    /// Web/HTML cell pool. Same lifecycle as WARM_CAMERAS.
    static WARM_WEBVIEWS: RefCell<HashMap<WebKey, WebEntry>>
        = RefCell::new(HashMap::new());

    /// Most recently rendered bundle. Used for layout-switch + idle revert.
    static CURRENT_BUNDLE: RefCell<Option<KioskBundle>> = const { RefCell::new(None) };

    /// Server URL + kiosk key for re-rendering on layout-switch.
    static CURRENT_AUTH: RefCell<Option<(String, String)>> = const { RefCell::new(None) };

    /// Local time when the currently-rendered bundle was received by the UI.
    static CURRENT_SYNC_LABEL: RefCell<String> = RefCell::new(String::from("unknown"));

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
    provider.load_from_string("window { background-color: #000000; } .kiosk-hidden-cursor, .kiosk-hidden-cursor * { cursor: none; }");
    gtk::style_context_add_provider_for_display(
        &WidgetExt::display(&pairing_window),
        &provider,
        gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
    );

    hide_cursor_on(&pairing_window);
    show_logo(&pairing_window);
    pairing_window.present();

    let (tx, rx) = mpsc::channel::<WorkerMsg>();

    let server_url = std::env::var("BETTERFRAME_SERVER")
        .ok()
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
                info!(
                    "bundle: {} cameras, {} display(s)",
                    b.cameras.len(),
                    b.normalized_displays().len()
                );
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

        // Start the LAN-side local server now that we have server URL + kiosk
        // key. Reports the local key to the server on next heartbeat so admin
        // can see it.
        let local_key = server::load_or_create_local_key();
        info!("local-server: kiosk_local_key prefix={}…", &local_key[..8]);
        local_server::start(local_server::LocalServerState {
            local_key,
            server_url: server.clone(),
            kiosk_key: key.clone(),
            ui_tx: std::sync::Arc::new(std::sync::Mutex::new(Some(tx.clone()))),
        });

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
                    ServerMsg::Standby(display_id) => {
                        let _ = tx_for_reload.send(WorkerMsg::Standby(display_id));
                    }
                    ServerMsg::Wake(display_id) => {
                        let _ = tx_for_reload.send(WorkerMsg::Wake(display_id));
                    }
                    ServerMsg::Fan(pwm) => {
                        if !hwmon::set_fan(pwm) {
                            warn!("fan command failed");
                        }
                        send_heartbeat_now(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::SwitchLayout {
                        display_id,
                        layout_id,
                    } => {
                        let _ = tx_for_reload.send(WorkerMsg::SwitchLayout {
                            display_id,
                            layout_id,
                        });
                    }
                    ServerMsg::FirmwareCheck => {
                        maybe_apply_firmware_update(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::OsCheck => {
                        maybe_apply_os_update(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::ShowTerminalCode(code) => {
                        let _ = tx_for_reload.send(WorkerMsg::ShowTerminalCode(code));
                    }
                    ServerMsg::DismissTerminalCode => {
                        let _ = tx_for_reload.send(WorkerMsg::DismissTerminalCode);
                    }
                }
            }
        });

        // Heartbeat loop — reports display geometry + hwmon, also checks for
        // firmware + OS bundle updates so kiosks pick up new builds without
        // admin push.
        // Reset terminal auth boot-attempt counter (lockout_count persists).
        remote_debug::reset_boot_attempts();

        let mut first_iter = true;
        loop {
            let heartbeat_ok = send_heartbeat_now(&server, &key);
            if first_iter && heartbeat_ok {
                // Successfully heart-beat at least once → consider this boot a
                // healthy one. Clears the rollback-pending marker so the next
                // start doesn't try to roll back a healthy install, AND tells
                // RAUC the current slot is good so its boot-attempts counter
                // resets (otherwise three bad boots auto-roll back).
                firmware::mark_firmware_applied();
                mark_kiosk_healthy();
                mark_rauc_slot_good();
                first_iter = false;
            }
            // OS bundle first — if it succeeds it reboots and we never reach
            // the firmware check below this iteration. Order matters: an OS
            // bundle update can ship an app-binary change anyway.
            maybe_apply_os_update(&server, &key);
            maybe_apply_firmware_update(&server, &key);
            std::thread::sleep(std::time::Duration::from_secs(60));
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
                WorkerMsg::SwitchLayout {
                    display_id,
                    layout_id,
                } => {
                    if let Some(display_id) = display_id {
                        render_layout(display_id, layout_id);
                    } else {
                        switch_layout_anywhere(layout_id);
                    }
                }
                WorkerMsg::Standby(display_id) => standby_display(display_id),
                WorkerMsg::Wake(display_id) => wake_display(display_id),
                WorkerMsg::ShowTerminalCode(code) => show_terminal_code_overlay(&code),
                WorkerMsg::DismissTerminalCode => dismiss_terminal_code_overlay(),
            }
        }
        gtk::glib::ControlFlow::Continue
    });
}

pub enum WorkerMsg {
    ShowPairingCode(String),
    RenderBundle(KioskBundle, String, String),
    SwitchLayout {
        display_id: Option<u32>,
        layout_id: u32,
    },
    Standby(Option<u32>),
    Wake(Option<u32>),
    ShowTerminalCode(String),
    DismissTerminalCode,
}

fn output_name_for_display(display_id: u32) -> Option<String> {
    CURRENT_BUNDLE.with(|b| {
        b.borrow()
            .as_ref()
            .and_then(|bundle| {
                bundle
                    .normalized_displays()
                    .into_iter()
                    .find(|d| d.id == display_id)
            })
            .map(|d| d.name)
    })
}

fn standby_display(display_id: Option<u32>) {
    if let Some(display_id) = display_id {
        if let Some(output_name) = output_name_for_display(display_id) {
            cec::standby_output(&output_name);
        } else {
            cec::standby();
        }
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
                st.is_asleep = true;
            }
        });
    } else {
        cec::standby();
        DISPLAYS.with(|ds| {
            for st in ds.borrow_mut().values_mut() {
                st.is_asleep = true;
            }
        });
    }
}

fn wake_display(display_id: Option<u32>) {
    if let Some(display_id) = display_id {
        if let Some(output_name) = output_name_for_display(display_id) {
            cec::wake_output(&output_name);
        } else {
            cec::wake();
        }
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
                st.is_asleep = false;
                st.last_activity = Instant::now();
            }
        });
    } else {
        cec::wake();
        DISPLAYS.with(|ds| {
            for st in ds.borrow_mut().values_mut() {
                st.is_asleep = false;
                st.last_activity = Instant::now();
            }
        });
    }
}

/// Reset activity timer for one display. If asleep, wake it.
fn mark_activity(display_id: u32) {
    DISPLAYS.with(|ds| {
        if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
            st.last_activity = Instant::now();
            if st.is_asleep {
                info!("activity while asleep → waking display {display_id}");
                if let Some(output_name) = output_name_for_display(display_id) {
                    cec::wake_output(&output_name);
                } else {
                    cec::wake();
                }
                st.is_asleep = false;
            }
        }
    });
}

fn send_heartbeat_now(server_url: &str, kiosk_key: &str) -> bool {
    let raw_displays = query_displays();
    let bundle_displays = CURRENT_BUNDLE
        .with(|b| b.borrow().as_ref().map(|b| b.normalized_displays()))
        .unwrap_or_default();
    let displays: Vec<server::DisplayReport> = raw_displays
        .into_iter()
        .enumerate()
        .map(|(index, (name, width_px, height_px))| {
            let bundle_id = bundle_displays
                .get(index)
                .map(|d| d.id)
                .or_else(|| bundle_displays.iter().find(|d| d.name == name).map(|d| d.id));
            let power_state = bundle_id
                .and_then(|id| {
                    DISPLAYS.with(|ds| ds.borrow().get(&id).map(|st| st.is_asleep))
                })
                .map(|is_asleep| if is_asleep { "standby" } else { "awake" })
                .unwrap_or("unknown")
                .to_string();
            server::DisplayReport {
                index,
                name,
                width_px,
                height_px,
                power_state,
            }
        })
        .collect();
    let hw = hwmon::read();
    server::heartbeat(server_url, kiosk_key, &displays, &hw)
}

fn mark_kiosk_healthy() {
    let _ = fs::create_dir_all("/run/betterframe");
    if let Err(err) = fs::write("/run/betterframe/kiosk-healthy", b"ok\n") {
        warn!("failed to write health marker: {err}");
    }
}

/// Tell RAUC the current slot is good so its boot-attempts counter doesn't
/// fire a rollback after a clean boot. No-op when RAUC isn't installed
/// (dev / non-A/B kiosks). RAUC's `mark-good` reads the running slot from
/// /proc/device-tree/chosen/bootloader/partition via our custom bootloader
/// backend — we just shell out and ignore non-zero exit (e.g. running
/// kiosk on a non-RAUC image).
fn mark_rauc_slot_good() {
    use std::process::Command;
    let _ = Command::new("rauc")
        .args(["status", "mark-good"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Ask the server whether a full-OS RAUC bundle is available for this
/// kiosk. On hit, download + sha256 + `rauc install` + reboot. On miss or
/// error: log + keep running. Gated by BF_ENABLE_OS_OTA=1 (default OFF
/// for dev kiosks running a non-A/B image).
fn maybe_apply_os_update(server_url: &str, kiosk_key: &str) {
    if std::env::var("BF_ENABLE_OS_OTA").as_deref() != Ok("1") {
        return;
    }
    let Some(info) = os_update::check(server_url, kiosk_key) else {
        return;
    };
    info!("os-update: bundle {} available", info.version);
    server::report_kiosk_log(
        server_url,
        kiosk_key,
        "info",
        "os update available",
        serde_json::json!({
            "target_version": &info.version,
            "channel": &info.channel,
            "release_id": &info.release_id,
            "size_bytes": info.size_bytes,
        }),
    );
    if let Err(err) = os_update::apply(server_url, kiosk_key, &info) {
        warn!("os-update: apply failed: {err}");
        server::report_kiosk_log(
            server_url,
            kiosk_key,
            "error",
            "os update failed",
            serde_json::json!({
                "target_version": &info.version,
                "release_id": &info.release_id,
                "error": &err,
            }),
        );
    }
    // Success path doesn't return — apply() reboots the system.
}

/// Ask the server whether an update is available. On hit, download + verify
/// + swap + report + exit (systemd brings up the new binary). On miss or
/// error: log + keep running. Designed to be safe to call from any thread.
fn maybe_apply_firmware_update(server_url: &str, kiosk_key: &str) {
    if std::env::var("BF_ENABLE_APP_OTA").as_deref() != Ok("1") {
        return;
    }
    let current = option_env!("BF_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    let Some(info) = firmware::check(server_url, kiosk_key, current) else {
        return;
    };
    info!("firmware: update {} → {} available", current, info.version);
    server::report_kiosk_log(
        server_url,
        kiosk_key,
        "info",
        "firmware update available",
        serde_json::json!({
            "current_version": current,
            "target_version": &info.version,
            "channel": &info.channel,
            "release_id": &info.release_id,
        }),
    );
    if let Err(err) = firmware::apply(server_url, kiosk_key, &info) {
        warn!("firmware: apply failed: {err}");
        server::report_kiosk_log(
            server_url,
            kiosk_key,
            "error",
        "firmware update failed",
        serde_json::json!({
                "target_version": &info.version,
                "release_id": &info.release_id,
                "error": &err,
            }),
        );
        let _ = reqwest::blocking::Client::new()
            .post(format!("{server_url}/api/kiosk/firmware/applied"))
            .header("Authorization", format!("Bearer {kiosk_key}"))
            .json(&serde_json::json!({ "version": info.version, "error": err }))
            .timeout(std::time::Duration::from_secs(5))
            .send();
    }
}

/// Install the once-per-second watchdog that enforces idle/sleep timeouts
/// per display. Safe to call multiple times — installs at most once.
fn install_idle_watchdog() {
    if WATCHDOG_INSTALLED.with(|c| c.get()) {
        return;
    }
    WATCHDOG_INSTALLED.with(|c| c.set(true));
    gtk::glib::timeout_add_local(Duration::from_secs(1), move || {
        // Drop any pipelines / webviews whose cooling window has elapsed.
        expire_cooling_pipelines();
        expire_cooling_webviews();

        let bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
        let Some(bundle) = bundle else {
            return gtk::glib::ControlFlow::Continue;
        };

        // Snapshot per-display timing decisions so we can act outside the borrow.
        struct Action {
            display_id: u32,
            revert_to: Option<u32>,
            sleep: bool,
        }
        let mut actions: Vec<Action> = Vec::new();

        DISPLAYS.with(|ds| {
            for (display_id, st) in ds.borrow().iter() {
                let Some(d) = bundle
                    .normalized_displays()
                    .into_iter()
                    .find(|d| d.id == *display_id)
                else {
                    continue;
                };
                let idle_to = d.idle_timeout_seconds as u64;
                let sleep_to = d.sleep_timeout_seconds as u64;
                let elapsed = st.last_activity.elapsed();
                let default_id = d.default_layout_id;

                let mut act = Action {
                    display_id: *display_id,
                    revert_to: None,
                    sleep: false,
                };

                if idle_to > 0 && elapsed >= Duration::from_secs(idle_to) {
                    let cur_resets_idle = st
                        .current_layout_id
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
                info!(
                    "idle timeout reached → reverting display {} to default",
                    a.display_id
                );
                render_layout(a.display_id, layout_id);
            }
            if a.sleep {
                info!(
                    "sleep timeout reached on display {}",
                    a.display_id
                );
                let output_name = bundle
                    .normalized_displays()
                    .into_iter()
                    .find(|d| d.id == a.display_id)
                    .map(|d| d.name);
                if let Some(output_name) = output_name {
                    cec::standby_output(&output_name);
                } else {
                    cec::standby();
                }
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
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.contains("-HDMI-") && !name.contains("-DP-") {
            continue;
        }
        let path = entry.path();
        let status = std::fs::read_to_string(path.join("status")).unwrap_or_default();
        if status.trim() != "connected" {
            continue;
        }
        let modes = std::fs::read_to_string(path.join("modes")).unwrap_or_default();
        let mode = modes.lines().next().unwrap_or("");
        let parts: Vec<&str> = mode.split('x').collect();
        if parts.len() != 2 {
            continue;
        }
        let w: u32 = parts[0].parse().unwrap_or(0);
        let h: u32 = parts[1].trim().parse().unwrap_or(0);
        if w == 0 || h == 0 {
            continue;
        }
        let clean_name = name
            .split_once('-')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or(name);
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
    add_css(
        &code_label,
        ".code { font-size: 72px; color: #fff; font-weight: 700; letter-spacing: 12px; font-family: monospace; }",
    );
    code_label.add_css_class("code");

    let hint = Label::new(Some("Enter this code in BetterFrame admin to pair"));
    add_css(&hint, ".hint { font-size: 14px; color: #666; }");
    hint.add_css_class("hint");

    vbox.append(&title);
    vbox.append(&code_label);
    vbox.append(&hint);
    vbox.append(&spinner(28));
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
    CURRENT_SYNC_LABEL.with(|s| *s.borrow_mut() = format_current_local_time());

    // Restart GPIO workers (always — even if list is empty, this drops the old set).
    gpio::start_workers(&bundle.gpio_bindings, server_url, kiosk_key);

    // (Re)start ONVIF event subscriptions for all ONVIF cameras in the bundle.
    // Workers self-terminate when a new start() call replaces the generation.
    // Prefer per-kiosk encryption key over shared cluster key.
    let decrypt_key = server::load_encrypt_key().or_else(|| server::load_cluster_key());
    onvif_events::start(&bundle.cameras, decrypt_key.as_deref(), server_url, kiosk_key);

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
        ds.borrow()
            .keys()
            .filter(|id| !keep_ids.contains(id))
            .copied()
            .collect()
    });
    for id in to_remove {
        if let Some(st) = DISPLAYS.with(|ds| ds.borrow_mut().remove(&id)) {
            st.window.close();
        }
    }

    // Note: hot/warm/cooling pool recompute is deferred to the per-display
    // render_layout() calls below — each one calls recompute_global_state()
    // after installing its current_layout_id, so the union across all
    // displays is correct once the loop finishes.

    // Build/reuse window per bundle display, then render its initial layout.
    let mut new_state: HashMap<u32, DisplayState> = HashMap::new();
    for (i, bd) in displays.iter().enumerate() {
        let existing = DISPLAYS.with(|ds| ds.borrow_mut().remove(&bd.id));
        let (window, was_asleep) = match existing {
            Some(st) => (st.window, st.is_asleep),
            None => {
                let w = ApplicationWindow::builder()
                    .application(app)
                    .title(format!("BetterFrame — {}", bd.name))
                    .fullscreened(true)
                    .build();
                let provider = gtk::CssProvider::new();
                provider.load_from_string("window { background-color: #000000; } .kiosk-hidden-cursor, .kiosk-hidden-cursor * { cursor: none; }");
                gtk::style_context_add_provider_for_display(
                    &WidgetExt::display(&w),
                    &provider,
                    gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
                );
                hide_cursor_on(&w);
                w.present();
                if let Some(monitor) = gdk_monitors.get(i) {
                    w.fullscreen_on_monitor(monitor);
                }
                (w, false)
            }
        };
        new_state.insert(
            bd.id,
            DisplayState {
                window,
                current_layout_id: None,
                last_activity: Instant::now(),
                is_asleep: was_asleep,
            },
        );
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
                    show_empty_display_reference(&st.window, &bundle, bd);
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

    let layout = bd.layouts.iter().find(|l| l.id == layout_id).or_else(|| {
        warn!(
            "render_layout: layout {layout_id} not on display {display_id}, falling back to default"
        );
        bd.default_layout_id
            .and_then(|did| bd.layouts.iter().find(|l| l.id == did))
            .or_else(|| bd.layouts.iter().find(|l| l.is_default))
    });

    let Some(layout) = layout else {
        warn!("render_layout: no usable layout on display {display_id}");
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
                show_empty_display_reference(&st.window, &bundle, bd);
                st.current_layout_id = None;
            }
        });
        return;
    };

    // Update per-display layout id BEFORE recomputing warm-cameras so the
    // union across displays is correct.
    let previous_layout_id = DISPLAYS.with(|ds| {
        let prev = ds
            .borrow()
            .get(&display_id)
            .and_then(|s| s.current_layout_id);
        if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
            st.current_layout_id = Some(layout.id);
        }
        prev
    });

    info!(
        "rendering layout '{}' (id {}) on display {} ({}x{} grid, {} cells)",
        layout.name,
        layout.id,
        display_id,
        layout.grid_cols,
        layout.grid_rows,
        layout.cells.len()
    );

    // Notify the server when the active layout actually changes so Node-RED
    // sees idle reverts + any other kiosk-initiated switch. Skip when the
    // layout id is unchanged (re-render of the same layout).
    if previous_layout_id != Some(layout.id) {
        let layout_name = layout.name.clone();
        let layout_id_for_report = layout.id;
        let server = server_url.clone();
        let key = kiosk_key.clone();
        std::thread::spawn(move || {
            server::report_layout_change(
                &server,
                &key,
                display_id,
                layout_id_for_report,
                &layout_name,
            );
        });
    }

    if layout.cells.is_empty() {
        warn!("layout has no cells");
        recompute_global_state();
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(&display_id) {
                show_logo(&st.window);
            }
        });
        return;
    }

    // Recompute hot/warm/cooling pool state across ALL displays' current
    // layouts. Pipelines no longer needed transition to Cooling and are
    // dropped by the watchdog tick after cooling_timeout_seconds.
    recompute_global_state();

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
        let cell_key: Option<String> = match cell.content_type.as_str() {
            "camera" => cell.camera_id.map(|id| {
                format!(
                    "cam:{id}:{}",
                    cell.stream_selector.as_deref().unwrap_or("auto")
                )
            }),
            "web" => cell.web_url.as_deref().map(|u| format!("web:{}", u.trim())),
            "html" => cell
                .html_content
                .as_deref()
                .filter(|h| !h.trim().is_empty())
                .map(html_key),
            _ => None,
        };
        let widget: gtk::Widget = match cell.content_type.as_str() {
            "camera" => {
                if let Some(cam_id) = cell.camera_id {
                    if let Some(cam) = cam_map.get(&cam_id) {
                        let area = (cell.col_span * cell.row_span) as f32 / total_area;
                        if let Some((paintable, badge)) =
                            ensure_warm(cam_id, cam, cell.stream_selector.as_deref(), area)
                        {
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
                                add_css(
                                    &label,
                                    "label { background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; min-width: 14px; }",
                                );
                                overlay.add_overlay(&label);
                            }
                            overlay.upcast()
                        } else {
                            camera_error_cell(&cam.name, "Stream unavailable")
                        }
                    } else {
                        camera_error_cell("Unknown", "Camera not in bundle")
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
                    let key = html_key(html);
                    ensure_web(key, WebSource::Html(html), server_url, kiosk_key).upcast()
                }
            }
            "web" => {
                let url = cell.web_url.as_deref().unwrap_or("").trim();
                if url.is_empty() {
                    none_cell()
                } else {
                    let key = format!("web:{url}");
                    ensure_web(key, WebSource::Url(url), server_url, kiosk_key).upcast()
                }
            }
            "none" => none_cell(),
            _ => placeholder(Some("Unknown content")),
        };

        // Tag the cell widget with a stable key for the layout-swap animation
        // (animate_layout_swap matches by widget_name across old + new grids).
        if let Some(k) = &cell_key {
            widget.set_widget_name(k);
        }

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
            animate_layout_swap(&st.window, &grid);
        }
    });
}

/// Swap the window's content to `new_grid` with a per-cell morph animation.
///
/// Matches cells by widget_name across old + new grids. Same-key cells slide +
/// scale from their old screen position to the new one over 300ms (ease-out
/// cubic). New cells fade in; removed cells fade out from their old spot.
/// Cells with no widget_name (e.g. placeholders) just snap.
const LAYOUT_ANIM_MS: u32 = 350;

#[derive(Clone)]
struct CellSnap {
    paintable: gtk::gdk::Paintable,
    bounds: gtk::graphene::Rect,
}

fn animate_layout_swap(window: &ApplicationWindow, new_grid: &gtk::Grid) {
    // Capture old cell snapshots BEFORE we drop the existing window child.
    let mut snaps: std::collections::HashMap<String, CellSnap> = std::collections::HashMap::new();
    if let Some(old_child) = window.child() {
        let mut child = old_child.first_child();
        while let Some(c) = child {
            let key = c.widget_name();
            if !key.is_empty() {
                if let Some(b) = c.compute_bounds(&old_child) {
                    let paintable: gtk::gdk::Paintable =
                        gtk::WidgetPaintable::new(Some(&c)).upcast();
                    snaps.insert(
                        key.to_string(),
                        CellSnap {
                            paintable,
                            bounds: b,
                        },
                    );
                }
            }
            child = c.next_sibling();
        }
    }

    // Always wrap content in an Overlay so the ghost layer can sit on top of
    // the new grid without disturbing GTK's main layout pass.
    let overlay = gtk::Overlay::new();
    overlay.set_vexpand(true);
    overlay.set_hexpand(true);
    overlay.set_child(Some(new_grid));
    let ghost = gtk::Fixed::new();
    ghost.set_can_target(false);
    overlay.add_overlay(&ghost);

    window.set_child(Some(&overlay));

    if snaps.is_empty() {
        // First render of this display — nothing to animate from. Skip the
        // ghost layer entirely on the next idle tick to keep the tree clean.
        let overlay_weak = overlay.downgrade();
        let new_grid_weak = new_grid.downgrade();
        let window_weak = window.downgrade();
        gtk::glib::idle_add_local_once(move || {
            // Swap back to plain grid as window child (drop the overlay).
            if let (Some(grid), Some(win), Some(ov)) = (
                new_grid_weak.upgrade(),
                window_weak.upgrade(),
                overlay_weak.upgrade(),
            ) {
                if grid.parent().as_ref() == Some(ov.upcast_ref::<gtk::Widget>()) {
                    ov.set_child(None::<&gtk::Widget>);
                    win.set_child(Some(&grid));
                }
            }
        });
        return;
    }

    // Defer one idle tick so the new_grid has computed its allocations.
    let new_grid_clone = new_grid.clone();
    let ghost_clone = ghost.clone();
    let overlay_clone = overlay.clone();
    let window_clone = window.clone();
    gtk::glib::idle_add_local_once(move || {
        let mut pairs: Vec<(gtk::Widget, gtk::graphene::Rect, CellSnap)> = Vec::new();
        let mut fresh: Vec<gtk::Widget> = Vec::new();
        let mut child = new_grid_clone.first_child();
        while let Some(c) = child {
            let key = c.widget_name();
            let new_bounds = c
                .compute_bounds(&new_grid_clone)
                .unwrap_or_else(gtk::graphene::Rect::zero);
            if !key.is_empty() {
                if let Some(snap) = snaps.remove(key.as_str()) {
                    pairs.push((c.clone(), new_bounds, snap));
                } else {
                    fresh.push(c.clone());
                }
            }
            child = c.next_sibling();
        }

        // Anything left in `snaps` was removed by this swap — fade ghosts out
        // in place so the transition visibly drops them.
        for (_key, snap) in &snaps {
            let pic = gtk::Picture::for_paintable(&snap.paintable);
            pic.set_can_target(false);
            pic.set_size_request(snap.bounds.width() as i32, snap.bounds.height() as i32);
            ghost_clone.put(&pic, snap.bounds.x() as f64, snap.bounds.y() as f64);
            fade_out_and_drop(&pic, &ghost_clone);
        }

        // Matched cells: hide real widget, animate ghost from old bounds → new.
        for (target, new_bounds, snap) in pairs {
            target.set_opacity(0.0);
            let pic = gtk::Picture::for_paintable(&snap.paintable);
            pic.set_can_target(false);
            pic.set_size_request(snap.bounds.width() as i32, snap.bounds.height() as i32);
            ghost_clone.put(&pic, snap.bounds.x() as f64, snap.bounds.y() as f64);
            animate_picture_to_bounds(&pic, &target, &ghost_clone, snap.bounds, new_bounds);
        }

        // Fresh cells (no match in old layout): fade in.
        for c in fresh {
            c.set_opacity(0.0);
            fade_in(&c);
        }

        // After animation window, drop the overlay so we return to plain grid.
        let overlay_weak = overlay_clone.downgrade();
        let grid_weak = new_grid_clone.downgrade();
        let window_weak = window_clone.downgrade();
        gtk::glib::timeout_add_local_once(
            Duration::from_millis((LAYOUT_ANIM_MS + 50) as u64),
            move || {
                if let (Some(grid), Some(win), Some(ov)) = (
                    grid_weak.upgrade(),
                    window_weak.upgrade(),
                    overlay_weak.upgrade(),
                ) {
                    if grid.parent().as_ref() == Some(ov.upcast_ref::<gtk::Widget>()) {
                        ov.set_child(None::<&gtk::Widget>);
                        win.set_child(Some(&grid));
                    }
                }
            },
        );
    });
}

fn ease_out_cubic(t: f64) -> f64 {
    let inv = 1.0 - t.clamp(0.0, 1.0);
    1.0 - inv * inv * inv
}

fn animate_picture_to_bounds(
    pic: &gtk::Picture,
    target: &gtk::Widget,
    fixed: &gtk::Fixed,
    from: gtk::graphene::Rect,
    to: gtk::graphene::Rect,
) {
    let start = Instant::now();
    let pic_weak = pic.downgrade();
    let fixed_weak = fixed.downgrade();
    let target_weak = target.downgrade();
    pic.add_tick_callback(move |_, _| {
        let Some(pic) = pic_weak.upgrade() else {
            return gtk::glib::ControlFlow::Break;
        };
        let elapsed = start.elapsed().as_millis() as f64;
        let t = (elapsed / LAYOUT_ANIM_MS as f64).min(1.0);
        let e = ease_out_cubic(t);
        let x = from.x() as f64 + (to.x() - from.x()) as f64 * e;
        let y = from.y() as f64 + (to.y() - from.y()) as f64 * e;
        let w = from.width() as f64 + (to.width() - from.width()) as f64 * e;
        let h = from.height() as f64 + (to.height() - from.height()) as f64 * e;
        if let Some(fixed) = fixed_weak.upgrade() {
            fixed.move_(&pic, x, y);
        }
        pic.set_size_request(w as i32, h as i32);
        if t >= 1.0 {
            if let Some(target) = target_weak.upgrade() {
                target.set_opacity(1.0);
            }
            pic.unparent();
            return gtk::glib::ControlFlow::Break;
        }
        gtk::glib::ControlFlow::Continue
    });
}

fn fade_in(widget: &gtk::Widget) {
    let start = Instant::now();
    let weak = widget.downgrade();
    widget.add_tick_callback(move |_, _| {
        let Some(w) = weak.upgrade() else {
            return gtk::glib::ControlFlow::Break;
        };
        let elapsed = start.elapsed().as_millis() as f64;
        let t = (elapsed / LAYOUT_ANIM_MS as f64).min(1.0);
        w.set_opacity(t);
        if t >= 1.0 {
            gtk::glib::ControlFlow::Break
        } else {
            gtk::glib::ControlFlow::Continue
        }
    });
}

fn fade_out_and_drop(pic: &gtk::Picture, fixed: &gtk::Fixed) {
    let start = Instant::now();
    let pic_weak = pic.downgrade();
    let fixed_weak = fixed.downgrade();
    pic.add_tick_callback(move |_, _| {
        let Some(p) = pic_weak.upgrade() else {
            return gtk::glib::ControlFlow::Break;
        };
        let elapsed = start.elapsed().as_millis() as f64;
        let t = (elapsed / LAYOUT_ANIM_MS as f64).min(1.0);
        p.set_opacity(1.0 - t);
        if t >= 1.0 {
            if let Some(_f) = fixed_weak.upgrade() {
                p.unparent();
            }
            return gtk::glib::ControlFlow::Break;
        }
        gtk::glib::ControlFlow::Continue
    });
}

/// Default cooling timeout when a layout doesn't specify one (or specifies 0).
const DEFAULT_COOLING_SECS: u32 = 30;

/// Walk all displays' currently-active layouts (plus any priority=hot layouts)
/// and recompute the warm/hot pool. Pool entries dropped from active layouts
/// transition to Cooling; new entries are NOT added here — `ensure_warm` does
/// that when the layout actually renders.
///
/// Pool keys are (camera_id, badge): a camera's main and sub streams are
/// tracked independently, so flipping a cell from M→S promotes the new sub
/// pipeline to Warm/Hot but leaves the existing main pipeline to cool down
/// naturally (and vice-versa).
fn recompute_global_state() {
    let bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
    let Some(bundle) = bundle else { return };
    let displays = bundle.normalized_displays();

    let mut warm_set: std::collections::HashSet<PoolKey> = std::collections::HashSet::new();
    let mut hot_set: std::collections::HashSet<PoolKey> = std::collections::HashSet::new();
    let mut max_cooling_secs: u32 = 0;

    let cam_map: HashMap<u32, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id, c)).collect();

    // Snapshot per-display active layout id outside any borrow of WARM_CAMERAS.
    let active: Vec<(u32, Option<u32>)> = DISPLAYS.with(|ds| {
        ds.borrow()
            .iter()
            .map(|(id, st)| (*id, st.current_layout_id))
            .collect()
    });

    // Helper: compute the pool key (camera_id, badge) for a given cell in a
    // layout. Falls back to a "?" badge if pick_stream can't decide (camera
    // missing or no streams).
    fn cell_keys(
        layout: &crate::bundle::BundleLayout,
        cam_map: &HashMap<u32, &crate::bundle::BundleCamera>,
        out: &mut std::collections::HashSet<PoolKey>,
    ) {
        let total_area = (layout.grid_cols.max(1) * layout.grid_rows.max(1)) as f32;
        for cell in &layout.cells {
            if cell.content_type != "camera" {
                continue;
            }
            let Some(cam_id) = cell.camera_id else {
                continue;
            };
            let Some(cam) = cam_map.get(&cam_id) else {
                continue;
            };
            let area = (cell.col_span * cell.row_span) as f32 / total_area;
            if let Some((_, badge)) = cam.pick_stream(cell.stream_selector.as_deref(), area) {
                out.insert((cam_id, badge));
            }
        }
        // Preload cameras have no cell context — let pick_stream choose
        // (typically sub). Different layouts that actually render them will
        // promote whichever badge they end up using.
        for cam_id in &layout.preload_camera_ids {
            if let Some(cam) = cam_map.get(cam_id) {
                if let Some((_, badge)) = cam.pick_stream(None, 0.0) {
                    out.insert((*cam_id, badge));
                }
            }
        }
    }

    for bd in &displays {
        let active_id = active
            .iter()
            .find(|(id, _)| *id == bd.id)
            .and_then(|(_, l)| *l);
        if let Some(cur_id) = active_id {
            if let Some(layout) = bd.layouts.iter().find(|l| l.id == cur_id) {
                cell_keys(layout, &cam_map, &mut warm_set);
                let t = layout.cooling_timeout_seconds.unwrap_or(0);
                let t = if t == 0 { DEFAULT_COOLING_SECS } else { t };
                max_cooling_secs = max_cooling_secs.max(t);
            }
        }
        for layout in &bd.layouts {
            if layout.priority == "hot" {
                cell_keys(layout, &cam_map, &mut hot_set);
            }
        }
    }

    // Same walk for web/html cells — pool keys are URL / hash(HTML).
    let mut warm_webs: std::collections::HashSet<WebKey> = std::collections::HashSet::new();
    let mut hot_webs: std::collections::HashSet<WebKey> = std::collections::HashSet::new();
    for bd in &displays {
        let active_id = active
            .iter()
            .find(|(id, _)| *id == bd.id)
            .and_then(|(_, l)| *l);
        if let Some(cur_id) = active_id {
            if let Some(layout) = bd.layouts.iter().find(|l| l.id == cur_id) {
                web_keys_for_layout(layout, &mut warm_webs);
            }
        }
        for layout in &bd.layouts {
            if layout.priority == "hot" {
                web_keys_for_layout(layout, &mut hot_webs);
            }
        }
    }

    if max_cooling_secs == 0 {
        max_cooling_secs = DEFAULT_COOLING_SECS;
    }
    recompute_pool_states(&warm_set, &hot_set, max_cooling_secs);
    recompute_web_states(&warm_webs, &hot_webs, max_cooling_secs);
}

/// Apply the hot/warm/cooling/cold state machine to the existing WARM_CAMERAS
/// pool. Does NOT create new entries — `ensure_warm` handles that.
///
/// - key in hot_set        → Hot   (clear cooling)
/// - key in warm_set       → Warm  (clear cooling)
/// - key in neither & was Cooling → keep cooling_until unchanged
/// - key in neither & not yet cooling → transition to Cooling
///   - if max_cooling_secs == 0, remove immediately (Cold)
fn recompute_pool_states(
    warm_set: &std::collections::HashSet<PoolKey>,
    hot_set: &std::collections::HashSet<PoolKey>,
    max_cooling_secs: u32,
) {
    let mut to_remove: Vec<PoolKey> = Vec::new();
    let mut to_stop: Vec<gstreamer::Pipeline> = Vec::new();

    WARM_CAMERAS.with(|w| {
        let mut warm = w.borrow_mut();
        for (key, entry) in warm.iter_mut() {
            if hot_set.contains(key) {
                entry.state = WarmthState::Hot;
                entry.cooling_until = None;
            } else if warm_set.contains(key) {
                entry.state = WarmthState::Warm;
                entry.cooling_until = None;
            } else {
                if entry.state == WarmthState::Cooling {
                    continue;
                }
                if max_cooling_secs == 0 {
                    to_remove.push(*key);
                    to_stop.push(entry.pipeline.clone());
                } else {
                    entry.state = WarmthState::Cooling;
                    entry.cooling_until =
                        Some(Instant::now() + Duration::from_secs(max_cooling_secs as u64));
                    info!(
                        "camera {} ({}): cooling for {}s before drop",
                        key.0, key.1, max_cooling_secs
                    );
                }
            }
        }
        for k in &to_remove {
            warm.remove(k);
        }
    });

    for pipe in to_stop {
        pipeline::stop(&pipe);
    }
}

/// Drop any Cooling entries whose timer has expired. Called from the
/// 1s watchdog tick.
fn expire_cooling_pipelines() {
    let now = Instant::now();
    let mut expired: Vec<(PoolKey, gstreamer::Pipeline)> = Vec::new();
    WARM_CAMERAS.with(|w| {
        let mut warm = w.borrow_mut();
        let keys: Vec<PoolKey> = warm
            .iter()
            .filter(|(_, e)| {
                e.state == WarmthState::Cooling && e.cooling_until.is_some_and(|t| now >= t)
            })
            .map(|(k, _)| *k)
            .collect();
        for k in keys {
            if let Some(e) = warm.remove(&k) {
                expired.push((k, e.pipeline));
            }
        }
    });
    for (key, pipe) in expired {
        info!(
            "camera {} ({}): cooling expired → stopping pipeline",
            key.0, key.1
        );
        pipeline::stop(&pipe);
    }
}

fn load_webview_url(webview: &webkit6::WebView, url: &str, server_url: &str, kiosk_key: &str) {
    if should_attach_kiosk_auth(url, server_url) {
        // Set a cookie so ALL sub-resource requests (JS, CSS, XHR, WS)
        // carry auth automatically. The Authorization header only applies
        // to the initial request — sub-resources from the loaded page
        // don't inherit it, causing 401 on every CSS/JS/API fetch.
        set_kiosk_cookie(webview, server_url, kiosk_key);

        // Also set the header on the initial request for the page load
        // itself (belt + suspenders — server checks cookie OR header).
        let request = webkit6::URIRequest::new(url);
        if let Some(headers) = request.http_headers() {
            headers.append("Authorization", &format!("Bearer {kiosk_key}"));
        }
        webkit6::prelude::WebViewExt::load_request(webview, &request);
        return;
    }

    webkit6::prelude::WebViewExt::load_uri(webview, url);
}

/// Set a cookie in WebKit's cookie jar so all requests to the server
/// carry the kiosk auth token. Name matches what the server's auth_request
/// endpoint checks: `betterframe_kiosk_key`.
fn set_kiosk_cookie(webview: &webkit6::WebView, server_url: &str, kiosk_key: &str) {
    use webkit6::prelude::*;

    let Ok(server) = url::Url::parse(server_url) else { return };
    let domain = server.host_str().unwrap_or("localhost");
    let secure = server.scheme() == "https";

    // WebKit's CookieManager handles the cookie jar.
    let ctx = webview.network_session();
    let Some(ctx) = ctx else { return };
    let cm = ctx.cookie_manager();
    let Some(cm) = cm else { return };

    // Build a SoupCookie and add it.
    // soup3 crate provides Cookie API used by webkit6.
    let cookie = webkit6::glib::GString::from(format!(
        "betterframe_kiosk_key={key}; Domain={domain}; Path=/; {secure}HttpOnly; SameSite=Strict",
        key = kiosk_key,
        domain = domain,
        secure = if secure { "Secure; " } else { "" },
    ));

    // Use the JavaScript bridge to set the cookie since the Rust
    // CookieManager API varies by webkit6 binding version.
    let js = format!(
        "document.cookie = 'betterframe_kiosk_key={key}; path=/; {secure}SameSite=Strict';",
        key = kiosk_key,
        secure = if secure { "Secure; " } else { "" },
    );
    // Run JS after a tiny delay so the WebView context exists.
    let wv = webview.clone();
    gtk::glib::idle_add_local_once(move || {
        wv.evaluate_javascript(&js, None, None, None::<&gtk::gio::Cancellable>, |_| {});
    });
}

fn should_attach_kiosk_auth(url: &str, server_url: &str) -> bool {
    let Ok(target) = Url::parse(url) else {
        return false;
    };
    let Ok(server) = Url::parse(server_url) else {
        return false;
    };
    if target.scheme() != server.scheme()
        || target.host_str() != server.host_str()
        || target.port_or_known_default() != server.port_or_known_default()
    {
        return false;
    }

    let path = target.path();
    path.starts_with("/dash/") || path.starts_with("/in/kiosk/")
}

/// Returns (paintable, badge_char) for a camera, creating a warm pipeline if
/// the (cam, badge) variant isn't already in the pool. If the camera's OTHER
/// stream variant is cached (e.g. cell switched from main to sub), we leave
/// that sibling entry alone — recompute_pool_states will demote it to Cooling
/// so it can be reused if the cell flips back before the cooldown elapses.
fn ensure_warm(
    cam_id: u32,
    cam: &crate::bundle::BundleCamera,
    selector: Option<&str>,
    area_fraction: f32,
) -> Option<(gtk::gdk::Paintable, char)> {
    let (uri, desired_badge) = cam.pick_stream(selector, area_fraction)?;
    let key: PoolKey = (cam_id, desired_badge);

    let cached = WARM_CAMERAS.with(|w| {
        w.borrow()
            .get(&key)
            .map(|e| (e.pipeline.clone(), e.paintable.clone()))
    });
    if let Some((_pipe, paintable)) = cached {
        // Promote out of Cooling if we're rendering it again.
        WARM_CAMERAS.with(|w| {
            if let Some(e) = w.borrow_mut().get_mut(&key) {
                if e.state == WarmthState::Cooling {
                    info!(
                        "camera {} ({}): rescued from cooling → warm",
                        cam_id, desired_badge
                    );
                    e.state = WarmthState::Warm;
                    e.cooling_until = None;
                }
            }
        });
        return Some((paintable, desired_badge));
    }

    let (pipe, sink) = pipeline::create_camera_pipeline(&cam.name, &uri)?;
    let paintable = sink.property::<gtk::gdk::Paintable>("paintable");
    pipeline::play(&pipe);
    WARM_CAMERAS.with(|w| {
        w.borrow_mut().insert(
            key,
            PipelineEntry {
                pipeline: pipe,
                paintable: paintable.clone(),
                state: WarmthState::Warm,
                cooling_until: None,
            },
        );
    });
    info!("warmed pipeline for camera {cam_id} (stream: {desired_badge})");
    Some((paintable, desired_badge))
}

enum WebSource<'a> {
    Url(&'a str),
    Html(&'a str),
}

/// Stable key for an inline HTML cell. Hash the content so identical HTML in
/// two layouts/cells shares one WebView in the pool.
fn html_key(html: &str) -> WebKey {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    html.hash(&mut h);
    format!("html:{:x}", h.finish())
}

/// Return a WebView for the given pool key, reusing a cached one if present.
/// On reuse, unparent first (GTK4 forbids attaching a widget with an existing
/// parent). On miss, build, load, and insert into the pool as Warm.
fn ensure_web(
    key: WebKey,
    source: WebSource<'_>,
    server_url: &str,
    kiosk_key: &str,
) -> webkit6::WebView {
    let cached = WARM_WEBVIEWS.with(|m| m.borrow().get(&key).map(|e| e.webview.clone()));
    if let Some(wv) = cached {
        WARM_WEBVIEWS.with(|m| {
            if let Some(e) = m.borrow_mut().get_mut(&key) {
                if e.state == WarmthState::Cooling {
                    info!("webview {key}: rescued from cooling → warm");
                    e.state = WarmthState::Warm;
                    e.cooling_until = None;
                }
            }
        });
        // Detach from previous container so the new grid can take it.
        if wv.parent().is_some() {
            wv.unparent();
        }
        return wv;
    }

    let wv = webkit6::WebView::new();
    wv.set_vexpand(true);
    wv.set_hexpand(true);

    // Hide the pointer inside every WebKit page. The default GTK CSS cursor:
    // none we set on top-level windows doesn't propagate into the WebView's
    // own surface — it draws its own cursor over hovered HTML elements.
    // Inject a UserStyleSheet at the WebKit level so every page (and every
    // frame) hides the cursor unconditionally. UserStyleLevel::User wins
    // over page-author CSS.
    {
        use webkit6::prelude::*;
        if let Some(ucm) = wv.user_content_manager() {
            let style = webkit6::UserStyleSheet::new(
                "*, *::before, *::after { cursor: none !important; }",
                webkit6::UserContentInjectedFrames::AllFrames,
                webkit6::UserStyleLevel::User,
                &[],
                &[],
            );
            ucm.add_style_sheet(&style);
        }
    }

    match source {
        WebSource::Html(html) => {
            webkit6::prelude::WebViewExt::load_html(&wv, html, None);
        }
        WebSource::Url(url) => {
            load_webview_url(&wv, url, server_url, kiosk_key);
        }
    }
    WARM_WEBVIEWS.with(|m| {
        m.borrow_mut().insert(
            key.clone(),
            WebEntry {
                webview: wv.clone(),
                state: WarmthState::Warm,
                cooling_until: None,
            },
        );
    });
    info!("warmed webview {key}");
    wv
}

/// Walk an arbitrary layout's web/html cells and add their pool keys to `out`.
/// Mirrors `cell_keys` for cameras.
fn web_keys_for_layout(
    layout: &crate::bundle::BundleLayout,
    out: &mut std::collections::HashSet<WebKey>,
) {
    for cell in &layout.cells {
        match cell.content_type.as_str() {
            "web" => {
                if let Some(url) = cell.web_url.as_deref() {
                    let url = url.trim();
                    if !url.is_empty() {
                        out.insert(format!("web:{url}"));
                    }
                }
            }
            "html" => {
                if let Some(html) = cell.html_content.as_deref() {
                    if !html.trim().is_empty() {
                        out.insert(html_key(html));
                    }
                }
            }
            _ => {}
        }
    }
}

/// Apply hot/warm/cooling state to the WebView pool. Mirror of
/// `recompute_pool_states` for cameras.
fn recompute_web_states(
    warm_set: &std::collections::HashSet<WebKey>,
    hot_set: &std::collections::HashSet<WebKey>,
    max_cooling_secs: u32,
) {
    let mut to_remove: Vec<WebKey> = Vec::new();
    WARM_WEBVIEWS.with(|w| {
        let mut warm = w.borrow_mut();
        for (key, entry) in warm.iter_mut() {
            if hot_set.contains(key) {
                entry.state = WarmthState::Hot;
                entry.cooling_until = None;
            } else if warm_set.contains(key) {
                entry.state = WarmthState::Warm;
                entry.cooling_until = None;
            } else {
                if entry.state == WarmthState::Cooling {
                    continue;
                }
                if max_cooling_secs == 0 {
                    to_remove.push(key.clone());
                } else {
                    entry.state = WarmthState::Cooling;
                    entry.cooling_until =
                        Some(Instant::now() + Duration::from_secs(max_cooling_secs as u64));
                    info!("webview {key}: cooling for {max_cooling_secs}s before drop");
                }
            }
        }
        for k in &to_remove {
            if let Some(e) = warm.remove(k) {
                if e.webview.parent().is_some() {
                    e.webview.unparent();
                }
            }
        }
    });
}

/// Drop Cooling webviews whose timer has expired.
fn expire_cooling_webviews() {
    let now = Instant::now();
    let mut expired: Vec<WebKey> = Vec::new();
    WARM_WEBVIEWS.with(|w| {
        let mut warm = w.borrow_mut();
        let keys: Vec<WebKey> = warm
            .iter()
            .filter(|(_, e)| {
                e.state == WarmthState::Cooling && e.cooling_until.is_some_and(|t| now >= t)
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in keys {
            if let Some(e) = warm.remove(&k) {
                if e.webview.parent().is_some() {
                    e.webview.unparent();
                }
                expired.push(k);
            }
        }
    });
    for key in expired {
        info!("webview {key}: cooling expired → dropped");
    }
}

/// Hide the mouse pointer on a window. Avoid GDK's "none" cursor here because
/// some GTK/Wayland stacks render it as a small square in the top-left corner.
fn hide_cursor_on(window: &ApplicationWindow) {
    window.add_css_class("kiosk-hidden-cursor");
}

fn show_logo(window: &ApplicationWindow) {
    let vbox = GtkBox::new(Orientation::Vertical, 24);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);
    vbox.append(&logo_picture(BETTERFRAME_LOGO_SVG, 480, 118, "idle-logo"));
    vbox.append(&spinner(36));
    window.set_child(Some(&vbox));
}

fn show_empty_display_reference(
    window: &ApplicationWindow,
    bundle: &KioskBundle,
    display: &BundleDisplayWithLayouts,
) {
    let overlay = gtk::Overlay::new();
    overlay.set_vexpand(true);
    overlay.set_hexpand(true);

    let vbox = GtkBox::new(Orientation::Vertical, 24);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);
    vbox.append(&logo_picture(BETTERFRAME_LOGO_SVG, 480, 118, "idle-logo"));
    overlay.set_child(Some(&vbox));

    let last_sync = CURRENT_SYNC_LABEL.with(|s| s.borrow().clone());
    let info = Label::new(Some(&format!(
        "Kiosk: {}\nDisplay: {}\nLast sync: {}",
        bundle.kiosk_name, display.name, last_sync,
    )));
    info.set_halign(gtk::Align::Start);
    info.set_valign(gtk::Align::End);
    info.set_margin_start(24);
    info.set_margin_bottom(20);
    info.set_xalign(0.0);
    add_css(
        &info,
        ".empty-reference { color: #8a8a8a; font-size: 13px; font-family: monospace; }",
    );
    info.add_css_class("empty-reference");
    overlay.add_overlay(&info);

    window.set_child(Some(&overlay));
}

fn format_current_local_time() -> String {
    gtk::glib::DateTime::now_local()
        .and_then(|dt| dt.format("%Y-%m-%d %H:%M:%S"))
        .map(|s| s.to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

/// A centered GTK spinner sized at `px` pixels. Already spinning.
fn spinner(px: i32) -> gtk::Spinner {
    let s = gtk::Spinner::new();
    s.set_size_request(px, px);
    s.set_halign(gtk::Align::Center);
    s.start();
    s
}

fn none_cell() -> gtk::Widget {
    placeholder(None)
}

fn camera_error_cell(name: &str, reason: &str) -> gtk::Widget {
    let vbox = GtkBox::new(Orientation::Vertical, 8);
    add_css(&vbox, ".bf-cam-error { background-color: #1a0000; }");
    vbox.add_css_class("bf-cam-error");
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);

    let icon = Label::new(Some("⚠"));
    add_css(&icon, "label { font-size: 36px; color: #c33; }");
    vbox.append(&icon);

    let name_label = Label::new(Some(name));
    add_css(&name_label, "label { font-size: 14px; color: #c33; font-weight: 600; }");
    vbox.append(&name_label);

    let reason_label = Label::new(Some(reason));
    add_css(&reason_label, "label { font-size: 12px; color: #666; margin-top: 4px; }");
    vbox.append(&reason_label);

    let retry_label = Label::new(Some("Retries on next layout render"));
    add_css(&retry_label, "label { font-size: 10px; color: #444; margin-top: 8px; }");
    vbox.append(&retry_label);

    vbox.upcast()
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

// ---- Terminal code overlay --------------------------------------------------
// Shown when admin requests terminal access. Big centered code on a dark
// semi-transparent backdrop over all kiosk windows. The code is NOT logged
// anywhere (security requirement — physical presence only).

thread_local! {
    static TERMINAL_CODE_WIDGET: RefCell<Option<gtk::Widget>> = const { RefCell::new(None) };
    static TERMINAL_CODE_SAVED_CHILD: RefCell<Option<(u32, gtk::Widget)>> = const { RefCell::new(None) };
}

fn show_terminal_code_overlay(code: &str) {
    dismiss_terminal_code_overlay();

    // Cage is a single-window compositor. We can't open a new window.
    // Instead, replace the first display window's child with the code
    // overlay and restore it when dismissed.
    let display_id = DISPLAYS.with(|ds| {
        ds.borrow().keys().next().copied()
    });
    let Some(display_id) = display_id else { return };

    DISPLAYS.with(|ds| {
        let ds = ds.borrow();
        let Some(st) = ds.get(&display_id) else { return };
        let win = &st.window;

        // Save current child for restore.
        let old_child = win.child();
        if let Some(ref c) = old_child {
            TERMINAL_CODE_SAVED_CHILD.with(|s| *s.borrow_mut() = Some((display_id, c.clone())));
        }

        // Match the pairing screen layout but with red warning theme.
        let vbox = GtkBox::new(Orientation::Vertical, 20);
        vbox.set_valign(gtk::Align::Center);
        vbox.set_halign(gtk::Align::Center);
        vbox.set_vexpand(true);
        vbox.set_hexpand(true);

        // Warning banner
        let warning = Label::new(Some("⚠  REMOTE TERMINAL ACCESS  ⚠"));
        add_css(&warning, ".term-warn { font-size: 20px; color: #ff4444; font-weight: 700; letter-spacing: 2px; }");
        warning.add_css_class("term-warn");

        // Logo (same as pairing screen)
        let logo = logo_picture(BETTERFRAME_LOGO_SVG, 360, 88, "terminal-logo");

        // Code label (same style as pairing but red)
        let code_label = Label::new(Some(code));
        add_css(&code_label, ".term-code { font-size: 72px; color: #ff4444; font-weight: 700; letter-spacing: 12px; font-family: monospace; }");
        code_label.add_css_class("term-code");

        let hint = Label::new(Some("Enter this code in BetterFrame admin to authorize terminal"));
        add_css(&hint, ".term-hint { font-size: 14px; color: #888; }");
        hint.add_css_class("term-hint");

        let timeout_label = Label::new(Some("Code expires in 60 seconds"));
        add_css(&timeout_label, ".term-timeout { font-size: 12px; color: #555; margin-top: 8px; }");
        timeout_label.add_css_class("term-timeout");

        vbox.append(&warning);
        vbox.append(&logo);
        vbox.append(&code_label);
        vbox.append(&hint);
        vbox.append(&spinner(28));
        vbox.append(&timeout_label);

        add_css(&vbox, "box { background: #000; }");
        win.set_child(Some(&vbox));

        TERMINAL_CODE_WIDGET.with(|w| *w.borrow_mut() = Some(vbox.upcast()));
    });

    // Auto-dismiss after 60s (timeout doesn't count as failed attempt).
    gtk::glib::timeout_add_local_once(Duration::from_secs(60), || {
        dismiss_terminal_code_overlay();
    });
}

fn dismiss_terminal_code_overlay() {
    // Restore previous content.
    TERMINAL_CODE_WIDGET.with(|w| {
        if w.borrow().is_none() { return; }
        *w.borrow_mut() = None;
    });
    TERMINAL_CODE_SAVED_CHILD.with(|s| {
        if let Some((display_id, child)) = s.borrow_mut().take() {
            DISPLAYS.with(|ds| {
                let ds = ds.borrow();
                if let Some(st) = ds.get(&display_id) {
                    st.window.set_child(Some(&child));
                }
            });
        }
    });
}
