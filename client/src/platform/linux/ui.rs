use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};
use url::Url;

static FIRMWARE_LOCK: Mutex<()> = Mutex::new(());
static OS_UPDATE_LOCK: Mutex<()> = Mutex::new(());
static FIRMWARE_ACTIVE: AtomicBool = AtomicBool::new(false);
static OS_UPDATE_ACTIVE: AtomicBool = AtomicBool::new(false);
static UPDATE_APPLY_ACTIVE: AtomicBool = AtomicBool::new(false);
static BOOT_AUDIO_DEFAULT_APPLIED: AtomicBool = AtomicBool::new(false);

/// Cross-thread bundle version. Set on GTK main thread in render_bundle(),
/// read from heartbeat thread. CURRENT_BUNDLE is thread-local so background
/// threads can't see it.
static BUNDLE_VERSION: Mutex<Option<String>> = Mutex::new(None);

fn set_reported_bundle_version(version: &str) {
    if let Ok(mut v) = BUNDLE_VERSION.lock() {
        *v = Some(version.to_string());
    }
}

use gdk_pixbuf::prelude::PixbufLoaderExt;
use gtk4::prelude::*;
use gtk4::{
    self as gtk, Application, ApplicationWindow, Box as GtkBox, Grid, Label, Orientation, Picture,
};
use tracing::{info, warn};

use crate::ServerMsg;
use crate::bundle::{BundleCell, BundleDisplayWithLayouts, KioskBundle};
use crate::cec;
use crate::firmware;
use crate::gpio;
use crate::hwmon;
use crate::local_server;
use crate::onvif_events;
use crate::os_update;
use crate::pipeline;
use crate::remote_debug;
use crate::server;
use crate::ws_client;

/// Per-display runtime state. Kept inside a thread-local hashmap keyed by
/// display id, so all the idle/sleep/layout tracking is local to that display
/// even though the GTK main loop is shared.
struct DisplayState {
    window: ApplicationWindow,
    current_layout_id: Option<String>,
    last_activity: Instant,
    is_asleep: bool,
    content_overlay: gtk::Overlay,
    web_layer: gtk::Fixed,
    web_positions: Vec<WebCellPos>,
    grid_dims: (u32, u32),
    focus_overrides: HashMap<String, FocusOverride>,
    fullscreen_override: Option<FocusOverride>,
    display_cleared: bool,
    override_generation: u64,
}

#[derive(Clone)]
struct FocusOverride {
    camera_id: String,
    stream: String,
    generation: u64,
}

pub use crate::core::commands::OperatorFocusRequest;

#[derive(Clone)]
struct WebCellPos {
    key: WebKey,
    col: u32,
    row: u32,
    col_span: u32,
    row_span: u32,
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

const STALL_THRESHOLD_MS: u64 = 15_000;
const HEAL_THRESHOLD_MS: u64 = 45_000;

struct PipelineEntry {
    _bus_watch: Box<dyn std::any::Any>,
    pipeline: gstreamer::Pipeline,
    paintable: gtk::gdk::Paintable,
    state: WarmthState,
    cooling_until: Option<Instant>,
    last_buffer_at: Arc<AtomicU64>,
    stream_status: Arc<AtomicU8>,
    pipeline_stats: Arc<pipeline::PipelineStats>,
    /// Epoch millis when this pipeline was first detected as stalled.
    /// NOT reset by in-place restart — only cleared when frames resume.
    first_stall_at: Arc<AtomicU64>,
}

/// Pool key. A camera can have multiple concurrent pipelines — typically one
/// per (main, sub, other) stream — each with independent warmth state. When a
/// cell switches M↔S we promote the new variant to Warm/Hot but leave the old
/// one to cool down naturally so a quick swap back is instant.
type PoolKey = (String, char);

/// WebView pool entry. Same Hot/Warm/Cooling/Cold lifecycle as cameras —
/// switching to a layout that doesn't reference a previously-loaded URL/HTML
/// leaves the WebView alive (unparented) so a fast switch-back preserves the
/// page state, JS execution, and avoids a full reload.
struct WebEntry {
    webview: webkit6::WebView,
    state: WarmthState,
    cooling_until: Option<Instant>,
    event_meta: Option<WebEventMeta>,
    last_reported_url: Option<String>,
}

/// Key for the webview pool. "web:<url>" for remote pages, "html:<hash>" for
/// inline HTML. Same content under either form across multiple cells/layouts
/// shares one WebView.
type WebKey = String;

#[derive(Clone, PartialEq, Eq)]
struct WebEventMeta {
    server_url: String,
    kiosk_key: String,
    tenant_slug: String,
    kiosk_id: String,
    display_id: String,
    view_id: Option<String>,
    entity_id: Option<String>,
}

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
    static DISPLAYS: RefCell<HashMap<String, DisplayState>> = RefCell::new(HashMap::new());

    /// Has the idle-watchdog already been installed on the main loop?
    static WATCHDOG_INSTALLED: Cell<bool> = const { Cell::new(false) };
}

const APP_ID: &str = "cloud.betterportal.frame";
const BETTERFRAME_LOGO_PNG: &[u8] = include_bytes!("../../../assets/betterframe-logo-dark.png");
const BETTERFRAME_MARK_PNG: &[u8] = include_bytes!("../../../assets/betterframe-mark.png");

fn wait_for_regional_origin(origin: &str, tx: &mpsc::Sender<WorkerMsg>) -> String {
    loop {
        match server::migrate_canonical_origin(origin) {
            Ok(resolved) => return resolved,
            Err(error) => {
                warn!("regional discovery: {error}; retaining saved enrollment and cache");
                let _ = tx.send(WorkerMsg::ReadyStartupStatus("Regional server unavailable — retrying with saved enrollment".into()));
                std::thread::sleep(Duration::from_secs(10));
            }
        }
    }
}

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
    let worker = std::thread::spawn(move || {
        let _ = tx.send(WorkerMsg::StartupStatus(
            "Finding BetterFrame server".into(),
        ));
        let mut server = loop {
            match server::discover_server(server_url.as_deref()) {
                Ok(server) => break server,
                Err(error) => {
                    warn!("startup: {error}");
                    let _ = tx.send(WorkerMsg::StartupStatus(
                        "Server or saved identity unavailable — retrying".into(),
                    ));
                    std::thread::sleep(Duration::from_secs(10));
                }
            }
        };
        info!("server: {server}");

        // Pending enrollment has no cached renderer to start. Resolve its old
        // canonical origin before polling a claim or sending a device secret.
        if !server::is_paired() {
            server = wait_for_regional_origin(&server, &tx);
        }

        // Bootstrap updates run before pairing so an older image can repair
        // its client before talking to a newer server.
        if !server::is_paired() {
            if server::ota_enabled("BF_ENABLE_APP_OTA") {
                let _ = tx.send(WorkerMsg::StartupStatus("Checking for app updates".into()));
                let current = crate::server::kiosk_app_version();
                if let Some(update) = crate::firmware::check_public(&server, current) {
                    info!("preboot update available: {} → {}", current, update.version);
                    if let Err(e) = crate::firmware::apply_public(&server, &update) {
                        tracing::warn!("preboot update failed: {e}");
                    }
                }
            }
        }

        let key = if server::is_paired() {
            info!("already paired");
            let _ = tx.send(WorkerMsg::StartupStatus("Loading device identity".into()));
            loop {
                match server::load_key() {
                    Ok(key) => break key,
                    Err(error) => {
                        warn!("identity: {error}");
                        let _ = tx.send(WorkerMsg::StartupStatus(
                            "Unable to read saved identity — retrying".into(),
                        ));
                        std::thread::sleep(Duration::from_secs(10));
                    }
                }
            }
        } else {
            loop {
                let session = match server::initiate_pairing(&server) {
                    Ok(session) => session,
                    Err(error) => {
                        warn!("{error}");
                        let _ = tx.send(WorkerMsg::StartupStatus(
                            "Pairing unavailable — checking connection and storage".into(),
                        ));
                        std::thread::sleep(Duration::from_secs(10));
                        continue;
                    }
                };
                let _ = tx.send(WorkerMsg::ShowPairingCode(session.code.clone()));
                // Let the displayed pairing screen confirm this boot before
                // replacing another slot. Pairing health is independent of claim.
                for _ in 0..15 {
                    if os_update::boot_is_confirmed() {
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
                if server::ota_enabled("BF_ENABLE_OS_OTA") && os_update::boot_is_confirmed() {
                    let _ = tx.send(WorkerMsg::StartupStatus("Checking for OS updates".into()));
                    if let Some(update) = os_update::check_public(&server) {
                        let version = update.version.clone();
                        let tx_progress = tx.clone();
                        if let Err(e) = os_update::apply_public(&server, &update, move |phase, pct| {
                            let _ = tx_progress.send(WorkerMsg::UpdateProgress(Some((
                                format!("OS Update {version}: {phase}"),
                                pct,
                            ))));
                        }) {
                            let _ = tx.send(WorkerMsg::UpdateProgress(None));
                            tracing::warn!("preboot OS update failed: {e}");
                        }
                    }
                }
                let _ = tx.send(WorkerMsg::ShowPairingCode(session.code.clone()));
                if let Some((name, key)) =
                    server::poll_claim_until_expiry(&server, &session, |status| {
                        let _ = tx.send(WorkerMsg::PairingStatus(
                            session.code.clone(),
                            status.to_string(),
                        ));
                    })
                {
                    info!("paired as: {name}");
                    let _ = tx.send(WorkerMsg::ShowPairingProgress);
                    break key;
                }
            }
        };

        // Render cached content before any network request so a paired kiosk
        // starts immediately while its server is unavailable or rebooting.
        let _ = tx.send(WorkerMsg::StartupStatus("Loading cached content".into()));
        let cached = server::load_cached_bundle();
        if let Some(bundle) = &cached {
            info!("boot: rendering cached bundle");
            set_reported_bundle_version(&bundle.version);
            crate::axiom::set_kiosk_id(bundle.kiosk_id.clone());
            set_hostname_from_name(&bundle.kiosk_name);
            let _ = tx.send(WorkerMsg::RenderBundle(
                bundle.clone(),
                server.clone(),
                key.clone(),
            ));
        }

        // Paired displays render cache immediately, even if discovery is offline.
        // This runs on the worker, before bundle, heartbeat and WebSocket loops.
        let regional = wait_for_regional_origin(&server, &tx);
        if regional != server {
            server = regional;
            if let Some(bundle) = &cached {
                let _ = tx.send(WorkerMsg::RenderBundle(bundle.clone(), server.clone(), key.clone()));
            }
        }

        // Fetch the current bundle and replace the cached render when the
        // server is reachable. Background loops keep reconnecting otherwise.
        if cached.is_none() {
            let _ = tx.send(WorkerMsg::StartupStatus(format!("Connecting to {server}")));
        }
        match server::fetch_bundle(&server, &key) {
            Some(b) => {
                set_reported_bundle_version(&b.version);
                crate::axiom::set_kiosk_id(b.kiosk_id.clone());
                set_hostname_from_name(&b.kiosk_name);
                info!(
                    "bundle: {} cameras, {} display(s)",
                    b.cameras.len(),
                    b.normalized_displays().len()
                );
                let _ = tx.send(WorkerMsg::RenderBundle(b, server.clone(), key.clone()));
            }
            None => {
                if cached.is_some() {
                    warn!("offline mode: keeping cached bundle");
                } else {
                    warn!("no bundle available (server unreachable, no cache)");
                    let _ = tx.send(WorkerMsg::StartupStatus(
                        "Paired — waiting for configuration".into(),
                    ));
                }
            }
        }

        // Start the LAN-side local server now that we have server URL + kiosk
        // key. Reports the local key to the server on next heartbeat so admin
        // can see it.
        let local_key = server::load_or_create_local_key();
        info!("local-server: kiosk_local_key prefix={}…", &local_key[..8]);
        local_server::start(local_server::LocalServerState {
            local_key: std::sync::Arc::new(std::sync::Mutex::new(local_key)),
            server_url: server.clone(),
            kiosk_key: key.clone(),
            ui_tx: std::sync::Arc::new(std::sync::Mutex::new(Some(tx.clone()))),
            operator_auth: crate::operator_console::shared_auth(),
        });
        if let Some(bundle) = server::load_cached_bundle() {
            local_server::sync_simple_vms(&bundle);
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
        // retry with capped exponential backoff while keeping the saved identity.
        let retry_tx = tx.clone();
        let retry_server = server.clone();
        let retry_key = key.clone();
        std::thread::spawn(move || {
            let mut backoff_secs: u64 = 10;
            loop {
                std::thread::sleep(Duration::from_secs(backoff_secs));
                if let Some(b) = server::fetch_bundle(&retry_server, &retry_key) {
                    info!("offline-retry: fresh bundle fetched, rendering");
                    set_reported_bundle_version(&b.version);
                    let _ = retry_tx.send(WorkerMsg::RenderBundle(
                        b,
                        retry_server.clone(),
                        retry_key.clone(),
                    ));
                    return;
                }
                backoff_secs = (backoff_secs * 2).min(300);
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
                                set_reported_bundle_version(&bundle.version);
                                local_server::sync_simple_vms(&bundle);
                                let _ = tx_for_reload.send(WorkerMsg::RenderBundle(
                                    bundle,
                                    server_for_reload.clone(),
                                    key_for_reload.clone(),
                                ));
                            }
                            None => warn!("reload-bundle: fetch failed, keeping current render"),
                        }
                        delayed_heartbeat(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::Standby(display_id) => {
                        let _ = tx_for_reload.send(WorkerMsg::Standby(display_id));
                        delayed_heartbeat(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::Wake(display_id) => {
                        let _ = tx_for_reload.send(WorkerMsg::Wake(display_id));
                        delayed_heartbeat(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::VolumeSet(vol) => {
                        crate::audio::set_volume(vol);
                        send_heartbeat_now(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::VolumeMute(muted) => {
                        crate::audio::set_mute(muted);
                        send_heartbeat_now(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::AudioOutputSet(id) => {
                        crate::audio::set_output(&id);
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
                        delayed_heartbeat(&server_for_reload, &key_for_reload);
                    }
                    ServerMsg::OperatorFocus(request) => {
                        let (reply, _) = mpsc::channel();
                        let _ = tx_for_reload.send(WorkerMsg::OperatorFocus(request, reply));
                    }
                    ServerMsg::OperatorClear(display_id) => {
                        let (reply, _) = mpsc::channel();
                        let _ = tx_for_reload.send(WorkerMsg::OperatorClear(display_id, reply));
                    }
                    ServerMsg::OperatorRestore(display_id) => {
                        let (reply, _) = mpsc::channel();
                        let _ = tx_for_reload.send(WorkerMsg::OperatorRestore(display_id, reply));
                    }
                    #[cfg(target_os = "linux")]
                    ServerMsg::TailscaleAuth(key) => {
                        if let Err(e) = crate::tailscale::authenticate(&key) {
                            warn!("tailscale auth failed: {e}");
                        }
                        send_heartbeat_now(&server_for_reload, &key_for_reload);
                    }
                    #[cfg(not(target_os = "linux"))]
                    ServerMsg::TailscaleAuth(_) => {}
                    ServerMsg::Reboot => {
                        info!("reboot requested by admin");
                        let _ = std::process::Command::new("systemctl")
                            .arg("reboot")
                            .status();
                    }
                    ServerMsg::FirmwareCheck { force } => {
                        if force || server::auto_updates_allowed() {
                            maybe_apply_firmware_update(
                                &server_for_reload,
                                &key_for_reload,
                                &tx_for_reload,
                                force,
                            );
                        } else {
                            info!("firmware: outside configured update window");
                        }
                    }
                    ServerMsg::OsCheck { force } => {
                        if force || server::auto_updates_allowed() {
                            maybe_apply_os_update(
                                &server_for_reload,
                                &key_for_reload,
                                &tx_for_reload,
                                force,
                            );
                        } else {
                            info!("os-update: outside configured update window");
                        }
                    }
                    ServerMsg::CancelUpdates => {
                        server::cancel_active_updates("server update preference change");
                        server::clear_cached_update_preferences();
                        let _ = tx_for_reload.send(WorkerMsg::UpdateProgress(None));
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

        let tx_progress = tx.clone();
        let mut first_iter = true;
        let mut confirmation_reported = false;
        loop {
            let heartbeat_ok = send_heartbeat_now(&server, &key);
            if first_iter && heartbeat_ok {
                firmware::mark_firmware_applied();
                mark_kiosk_healthy();
                cleanup_stale_files();
                apply_boot_audio_default();
                first_iter = false;
            }
            if heartbeat_ok && !confirmation_reported {
                confirmation_reported = os_update::report_confirmed(&server, &key);
            }
            if server::auto_updates_allowed() {
                maybe_apply_os_update(&server, &key, &tx_progress, false);
                maybe_apply_firmware_update(&server, &key, &tx_progress, false);
            } else {
                info!("auto-update: outside configured update window");
            }
            maybe_refresh_onvif(&server, &key);
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });

    // Supervise the startup/heartbeat worker even while other threads retain
    // channel senders. A panic must not leave GTK showing a frozen pairing code.
    std::thread::spawn(move || {
        let result = worker.join();
        tracing::error!(
            "kiosk worker stopped (panicked={}); restarting service",
            result.is_err()
        );
        std::process::exit(1);
    });

    // Poll channel from UI thread via timeout
    let app_clone = app.clone();
    let pairing_window_clone = pairing_window.clone();
    gtk::glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
        while let Ok(msg) = rx.try_recv() {
            match msg {
                WorkerMsg::StartupStatus(action) => {
                    show_startup_status(&pairing_window_clone, &action)
                }
                WorkerMsg::ReadyStartupStatus(action) => {
                    show_ready_startup_status(&pairing_window_clone, &action)
                }
                WorkerMsg::ShowPairingCode(code) => show_pairing_code(
                    &pairing_window_clone,
                    &code,
                    "Enter this code in BetterFrame admin to pair",
                ),
                WorkerMsg::PairingStatus(code, status) => {
                    show_pairing_code(&pairing_window_clone, &code, &status)
                }
                WorkerMsg::ShowPairingProgress => show_pairing_progress(&pairing_window_clone),
                WorkerMsg::RenderBundle(bundle, server, key) => {
                    render_bundle(&app_clone, &pairing_window_clone, bundle, &server, &key);
                    install_idle_watchdog();
                }
                WorkerMsg::SwitchLayout {
                    display_id,
                    layout_id,
                } => {
                    if let Some(display_id) = &display_id {
                        render_layout(display_id, &layout_id);
                    } else {
                        switch_layout_anywhere(&layout_id);
                    }
                }
                WorkerMsg::OperatorFocus(request, reply) => {
                    let _ = reply.send(operator_focus(request));
                }
                WorkerMsg::OperatorClear(display_id, reply) => {
                    let _ = reply.send(operator_clear(&display_id));
                }
                WorkerMsg::OperatorRestore(display_id, reply) => {
                    let _ = reply.send(operator_restore(&display_id));
                }
                WorkerMsg::Standby(display_id) => standby_display(display_id.as_deref()),
                WorkerMsg::Wake(display_id) => wake_display(display_id.as_deref()),
                WorkerMsg::ShowTerminalCode(code) => show_terminal_code_overlay(&code),
                WorkerMsg::DismissTerminalCode => dismiss_terminal_code_overlay(),
                WorkerMsg::UpdateProgress(progress) => show_update_banner(progress),
            }
        }
        gtk::glib::ControlFlow::Continue
    });
}

pub enum WorkerMsg {
    StartupStatus(String),
    ReadyStartupStatus(String),
    ShowPairingCode(String),
    PairingStatus(String, String),
    ShowPairingProgress,
    RenderBundle(KioskBundle, String, String),
    SwitchLayout {
        display_id: Option<String>,
        layout_id: String,
    },
    OperatorFocus(
        OperatorFocusRequest,
        mpsc::Sender<Result<serde_json::Value, String>>,
    ),
    OperatorClear(String, mpsc::Sender<Result<serde_json::Value, String>>),
    OperatorRestore(String, mpsc::Sender<Result<serde_json::Value, String>>),
    Standby(Option<String>),
    Wake(Option<String>),
    ShowTerminalCode(String),
    DismissTerminalCode,
    /// Update progress banner — shown as overlay on all displays.
    /// (label, percent 0-100). None = dismiss.
    UpdateProgress(Option<(String, u8)>),
}

fn output_name_for_display(display_id: &str) -> Option<String> {
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

fn standby_display(display_id: Option<&str>) {
    DISPLAYS.with(|ds| {
        for (id, st) in ds.borrow_mut().iter_mut() {
            if display_id.is_none_or(|wanted| wanted == id) {
                st.is_asleep = true;
                st.window.set_child(Some(&build_sleep_screen(id)));
            }
        }
    });
    recompute_global_state();
    if let Some(output) = display_id.and_then(output_name_for_display) {
        cec::standby_output(&output);
    } else {
        cec::standby();
    }
}

/// Replace the whole layout, including webviews and labels. The tick callback is
/// owned by this widget and stops when the sleep screen is detached on wake.
fn build_sleep_screen(display_id: &str) -> gtk::Widget {
    let surface = gtk::Fixed::new();
    surface.set_hexpand(true);
    surface.set_vexpand(true);
    surface.set_overflow(gtk::Overflow::Hidden);
    surface.add_css_class("bf-sleep-screen");
    add_css(&surface, ".bf-sleep-screen { background-color: #000; }");
    let logo = logo_picture(BETTERFRAME_LOGO_PNG, 240, 59, "sleep-logo");
    logo.set_opacity(0.07);
    surface.put(&logo, 0.0, 0.0);
    let started = Instant::now();
    surface.add_tick_callback(move |surface, _| {
        let elapsed = started.elapsed().as_secs_f64();
        // Keep the logo below half the available area, even during a mode
        // change when GTK may briefly allocate a very small surface.
        let scale = (surface.width() as f32 / 480.0)
            .min(surface.height() as f32 / 118.0)
            .clamp(0.0, 1.0);
        let x = crate::core::display_power::bounce_position(
            elapsed,
            17.0,
            f64::from((surface.width() as f32 - logo.width() as f32 * scale).max(0.0)),
        );
        let y = crate::core::display_power::bounce_position(
            elapsed,
            11.0,
            f64::from((surface.height() as f32 - logo.height() as f32 * scale).max(0.0)),
        );
        let transform = gtk::gsk::Transform::new()
            .translate(&gtk::graphene::Point::new(x as f32, y as f32))
            .scale(scale, scale);
        surface.set_child_transform(&logo, Some(&transform));
        gtk::glib::ControlFlow::Continue
    });
    let click = gtk::GestureClick::new();
    let id = display_id.to_owned();
    click.connect_pressed(move |_, _, _, _| wake_display(Some(&id)));
    surface.add_controller(click);
    surface.upcast()
}

fn wake_display(display_id: Option<&str>) {
    if let Some(display_id) = display_id {
        if let Some(output_name) = output_name_for_display(display_id) {
            cec::wake_output(&output_name);
        } else {
            cec::wake();
        }
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(display_id) {
                st.is_asleep = false;
                st.window.set_child(Some(&st.content_overlay));
                st.last_activity = Instant::now();
            }
        });
    } else {
        cec::wake();
        DISPLAYS.with(|ds| {
            for st in ds.borrow_mut().values_mut() {
                st.is_asleep = false;
                st.window.set_child(Some(&st.content_overlay));
                st.last_activity = Instant::now();
            }
        });
    }
    render_current_layouts(display_id);
}

fn render_current_layouts(display_id: Option<&str>) {
    let layouts: Vec<(String, String)> = DISPLAYS.with(|ds| {
        ds.borrow()
            .iter()
            .filter(|(id, _)| match display_id {
                Some(wanted) => wanted == id.as_str(),
                None => true,
            })
            .filter_map(|(id, st)| {
                st.current_layout_id
                    .as_ref()
                    .map(|layout_id| (id.clone(), layout_id.clone()))
            })
            .collect()
    });

    for (display_id, layout_id) in layouts {
        render_layout_inner(&display_id, &layout_id, true);
    }
}

/// Reset activity timer for one display. If asleep, wake it.
fn mark_activity(display_id: &str) {
    DISPLAYS.with(|ds| {
        if let Some(st) = ds.borrow_mut().get_mut(display_id) {
            st.last_activity = Instant::now();
            if st.is_asleep {
                info!("activity while asleep → waking display {display_id}");
                if let Some(output_name) = output_name_for_display(display_id) {
                    cec::wake_output(&output_name);
                } else {
                    cec::wake();
                }
                st.is_asleep = false;
                st.window.set_child(Some(&st.content_overlay));
            }
        }
    });
}

fn delayed_heartbeat(server_url: &str, kiosk_key: &str) {
    let s = server_url.to_string();
    let k = kiosk_key.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(2));
        send_heartbeat_now(&s, &k);
    });
}

fn send_heartbeat_now(server_url: &str, kiosk_key: &str) -> bool {
    let bundle_version = BUNDLE_VERSION.lock().ok().and_then(|v| v.clone());
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
                .map(|d| d.id.clone())
                .or_else(|| {
                    bundle_displays
                        .iter()
                        .find(|d| d.name == name)
                        .map(|d| d.id.clone())
                });
            let power_state = bundle_id
                .as_deref()
                .and_then(|id| DISPLAYS.with(|ds| ds.borrow().get(id).map(|st| st.is_asleep)))
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
    server::heartbeat(
        server_url,
        kiosk_key,
        bundle_version.as_deref(),
        &displays,
        &hw,
    )
}

// Two mapped frame ticks put at least one paint between rendering healthy UI
// and acknowledging the app candidate. This also works before enrollment.
fn confirm_rendered_app(window: &ApplicationWindow) {
    after_rendered_frame(window, firmware::mark_firmware_applied);
}

fn after_rendered_frame(window: &ApplicationWindow, confirm: impl Fn() + 'static) {
    let first_frame = std::cell::Cell::new(true);
    window.add_tick_callback(move |_, _| {
        if first_frame.replace(false) {
            return gtk::glib::ControlFlow::Continue;
        }
        confirm();
        gtk::glib::ControlFlow::Break
    });
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
fn set_hostname_from_name(name: &str) {
    let hostname: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if hostname.is_empty() {
        return;
    }
    let current = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_default();
    if current == hostname {
        return;
    }
    info!("setting hostname to {hostname}");
    let _ = std::process::Command::new("hostnamectl")
        .args(["set-hostname", &hostname])
        .status();
}

fn cleanup_stale_files() {
    // Stale OS update downloads in staging dir.
    let staging = std::path::Path::new("/var/lib/betterframe/tmp");
    if staging.is_dir() {
        if let Ok(entries) = fs::read_dir(staging) {
            let cutoff = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                let old = meta.modified().map(|m| m < cutoff).unwrap_or(false);
                if old {
                    info!(
                        "cleanup: removing stale staging file {}",
                        entry.path().display()
                    );
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    // Old firmware .prev binary (only keep if < 7 days old as rollback safety).
    let prev = std::path::Path::new("/opt/betterframe/kiosk/betterframe-kiosk.prev");
    if prev.exists() {
        let cutoff = std::time::SystemTime::now() - Duration::from_secs(7 * 24 * 3600);
        if let Ok(meta) = prev.metadata() {
            if meta.modified().map(|m| m < cutoff).unwrap_or(false) {
                info!("cleanup: removing old firmware .prev");
                let _ = fs::remove_file(prev);
            }
        }
    }
}

fn apply_boot_audio_default() {
    if BOOT_AUDIO_DEFAULT_APPLIED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(volume) = server::cached_audio_default_volume() else {
        return;
    };
    if crate::audio::set_volume(volume) {
        info!("audio: applied boot default volume {volume}%");
    } else {
        warn!("audio: failed to apply boot default volume {volume}%");
    }
}

/// Ask the server whether a full-OS RAUC bundle is available for this
/// kiosk.
fn maybe_apply_os_update(
    server_url: &str,
    kiosk_key: &str,
    tx: &mpsc::Sender<WorkerMsg>,
    force: bool,
) {
    if !server::ota_enabled("BF_ENABLE_OS_OTA") {
        info!("os-update: disabled (BF_ENABLE_OS_OTA = 0)");
        return;
    }
    if !os_update::boot_is_confirmed() {
        info!("os-update: waiting for current boot health confirmation");
        return;
    }
    if OS_UPDATE_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        info!("os-update: another update already in progress, skipping");
        return;
    }
    os_update::clear_cancel();

    let server_url = server_url.to_string();
    let kiosk_key = kiosk_key.to_string();
    let tx = tx.clone();
    std::thread::spawn(move || {
        let _lock = OS_UPDATE_LOCK.lock().unwrap();
        let Some(info) = os_update::check(&server_url, &kiosk_key) else {
            info!("os-update: no eligible update");
            OS_UPDATE_ACTIVE.store(false, Ordering::SeqCst);
            return;
        };
        let failures = crate::update_guard::failure_count("os", &info.version);
        info!(
            "os-update: check found {} (force={}, previous_failures={failures})",
            info.version, force
        );
        if let Some(failures) = crate::update_guard::blocked("os", &info.version, force) {
            warn!(
                "os-update: skipping {} after {failures} failed attempts; admin push required",
                info.version
            );
            server::report_kiosk_log(
                &server_url,
                &kiosk_key,
                "warn",
                "os update blocked after repeated failures",
                serde_json::json!({
                    "target_version": &info.version,
                    "release_id": &info.release_id,
                    "failures": failures,
                }),
            );
            OS_UPDATE_ACTIVE.store(false, Ordering::SeqCst);
            return;
        }
        info!("os-update: bundle {} available", info.version);
        server::report_kiosk_log(
            &server_url,
            &kiosk_key,
            "info",
            "os update available",
            serde_json::json!({
                "target_version": &info.version,
                "channel": &info.channel,
                "release_id": &info.release_id,
                "size_bytes": info.size_bytes,
            }),
        );
        if UPDATE_APPLY_ACTIVE
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            info!("os-update: another update apply is active, skipping");
            OS_UPDATE_ACTIVE.store(false, Ordering::SeqCst);
            return;
        }
        let version = info.version.clone();
        let tx_cb = tx.clone();
        let result = os_update::apply(
            &server_url,
            &kiosk_key,
            &info,
            move |phase, pct| {
                let label = format!("OS Update {version}: {phase}");
                let _ = tx_cb.send(WorkerMsg::UpdateProgress(Some((label, pct))));
            },
            force,
        );
        UPDATE_APPLY_ACTIVE.store(false, Ordering::SeqCst);
        OS_UPDATE_ACTIVE.store(false, Ordering::SeqCst);
        if let Err(err) = result {
            let failures = crate::update_guard::failure_count("os", &info.version);
            let _ = tx.send(WorkerMsg::UpdateProgress(None));
            warn!("os-update: apply failed: {err}");
            server::report_kiosk_log(
                &server_url,
                &kiosk_key,
                "error",
                "os update failed",
                serde_json::json!({
                    "target_version": &info.version,
                    "release_id": &info.release_id,
                    "error": &err,
                    "failures": failures,
                    "blocked": failures >= 3,
                }),
            );
        }
    });
}

/// Ask the server whether an update is available. On hit, download + verify
/// + swap + report + exit (systemd brings up the new binary). On miss or
/// error: log + keep running. Designed to be safe to call from any thread.
fn maybe_apply_firmware_update(
    server_url: &str,
    kiosk_key: &str,
    tx: &mpsc::Sender<WorkerMsg>,
    force: bool,
) {
    if !server::ota_enabled("BF_ENABLE_APP_OTA") {
        info!("firmware: disabled (BF_ENABLE_APP_OTA = 0)");
        return;
    }
    if FIRMWARE_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        info!("firmware: another update already in progress, skipping");
        return;
    }
    firmware::clear_cancel();
    let server_url = server_url.to_string();
    let kiosk_key = kiosk_key.to_string();
    let tx = tx.clone();
    std::thread::spawn(move || {
        run_firmware_update_worker(server_url, kiosk_key, tx, force);
    });
}

fn run_firmware_update_worker(
    server_url: String,
    kiosk_key: String,
    tx: mpsc::Sender<WorkerMsg>,
    force: bool,
) {
    let _lock = FIRMWARE_LOCK.lock().unwrap();
    let current = option_env!("BF_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"));
    let Some(info) = firmware::check(&server_url, &kiosk_key, current) else {
        info!("firmware: no eligible update");
        FIRMWARE_ACTIVE.store(false, Ordering::SeqCst);
        return;
    };
    let failures = crate::update_guard::failure_count("firmware", &info.version);
    info!(
        "firmware: check found {} (force={}, previous_failures={failures})",
        info.version, force
    );
    if let Some(failures) = crate::update_guard::blocked("firmware", &info.version, force) {
        warn!(
            "firmware: skipping {} after {failures} failed attempts; admin push required",
            info.version
        );
        server::report_kiosk_log(
            &server_url,
            &kiosk_key,
            "warn",
            "firmware update blocked after repeated failures",
            serde_json::json!({
                "current_version": current,
                "target_version": &info.version,
                "release_id": &info.release_id,
                "failures": failures,
            }),
        );
        FIRMWARE_ACTIVE.store(false, Ordering::SeqCst);
        return;
    }
    info!("firmware: update {} -> {} available", current, info.version);
    server::report_kiosk_log(
        &server_url,
        &kiosk_key,
        "info",
        "firmware update available",
        serde_json::json!({
            "current_version": current,
            "target_version": &info.version,
            "channel": &info.channel,
            "release_id": &info.release_id,
        }),
    );
    if UPDATE_APPLY_ACTIVE
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        info!("firmware: another update apply is active, skipping");
        FIRMWARE_ACTIVE.store(false, Ordering::SeqCst);
        return;
    }
    let version = info.version.clone();
    let tx_cb = tx.clone();
    let result = firmware::apply(&server_url, &kiosk_key, &info, move |phase, pct| {
        let label = format!("App Update {version}: {phase}");
        let _ = tx_cb.send(WorkerMsg::UpdateProgress(Some((label, pct))));
    });
    UPDATE_APPLY_ACTIVE.store(false, Ordering::SeqCst);
    FIRMWARE_ACTIVE.store(false, Ordering::SeqCst);
    if let Err(err) = result {
        let failures = crate::update_guard::record_failure("firmware", &info.version, &err);
        let _ = tx.send(WorkerMsg::UpdateProgress(None));
        warn!("firmware: apply failed: {err}");
        server::report_kiosk_log(
            &server_url,
            &kiosk_key,
            "error",
            "firmware update failed",
            serde_json::json!({
                "target_version": &info.version,
                "release_id": &info.release_id,
                "error": &err,
                "failures": failures,
                "blocked": failures >= 3,
            }),
        );
        let _ = crate::network::blocking_client()
            .post(format!("{server_url}/api/kiosk/firmware/applied"))
            .header("Authorization", format!("Bearer {kiosk_key}"))
            .json(&serde_json::json!({ "version": info.version, "error": err }))
            .timeout(std::time::Duration::from_secs(5))
            .send();
    }
}

static LAST_ONVIF_REFRESH: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);

fn maybe_refresh_onvif(server_url: &str, kiosk_key: &str) {
    if !onvif_events::needs_refresh() {
        return;
    }
    // Cooldown: only refresh once per 30 minutes to avoid hammering locked-out cameras.
    let now = std::time::Instant::now();
    let mut last = LAST_ONVIF_REFRESH.lock().unwrap();
    if let Some(prev) = *last {
        if now.duration_since(prev) < Duration::from_secs(30 * 60) {
            return;
        }
    }
    *last = Some(now);
    drop(last);
    info!("onvif: refreshing stale/failed subscriptions");
    let bundle = match server::load_cached_bundle() {
        Some(b) => b,
        None => return,
    };
    let displays = bundle.normalized_displays();
    let layout_cam_ids: std::collections::HashSet<String> = displays
        .iter()
        .flat_map(|d| d.layouts.iter())
        .flat_map(|l| l.cells.iter())
        .filter_map(|c| c.camera_id.clone())
        .collect();
    let layout_cameras: Vec<_> = bundle
        .cameras
        .iter()
        .filter(|c| layout_cam_ids.contains(&c.id))
        .cloned()
        .collect();
    let decrypt_key = server::load_encrypt_key().or_else(|| server::load_cluster_key());
    let tenant = bundle.tenant_slug.as_str();
    onvif_events::start(
        &layout_cameras,
        decrypt_key.as_deref(),
        server_url,
        kiosk_key,
        tenant,
    );
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
        // Drop persistently stalled pipelines and re-render affected displays.
        heal_stalled_streams();

        let bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
        let Some(bundle) = bundle else {
            return gtk::glib::ControlFlow::Continue;
        };

        // Snapshot per-display timing decisions so we can act outside the borrow.
        struct Action {
            display_id: String,
            revert_to: Option<String>,
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
                if st.is_asleep || terminal_prompt_on_display(display_id) {
                    continue;
                }
                let sleep_to = d.sleep_timeout_seconds;
                let elapsed = st.last_activity.elapsed();
                let default_id = d.default_layout_id.clone();
                let current_layout = st
                    .current_layout_id
                    .as_ref()
                    .and_then(|cur_id| d.layouts.iter().find(|l| l.id == *cur_id));
                let idle_to = current_layout
                    .and_then(|l| l.idle_timeout_seconds)
                    .unwrap_or(d.idle_timeout_seconds);

                let mut act = Action {
                    display_id: display_id.clone(),
                    revert_to: None,
                    sleep: false,
                };

                let can_return = current_layout.is_some_and(|layout| layout.resets_idle_timer)
                    && st.current_layout_id.is_some()
                    && default_id.is_some()
                    && st.current_layout_id != default_id;
                match crate::core::display_power::idle_decision(
                    elapsed,
                    st.is_asleep,
                    sleep_to,
                    idle_to,
                    can_return,
                ) {
                    crate::core::display_power::IdleDecision::Sleep => act.sleep = true,
                    crate::core::display_power::IdleDecision::ReturnToDefault => {
                        act.revert_to = default_id
                    }
                    crate::core::display_power::IdleDecision::None => {}
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
                render_layout_inner(&a.display_id, &layout_id, false);
            }
            if a.sleep {
                info!("sleep timeout reached on display {}", a.display_id);
                standby_display(Some(&a.display_id));
            }
        }

        gtk::glib::ControlFlow::Continue
    });
}

/// Query connected DRM displays from sysfs. Returns (name, width, height).
/// Reads /sys/class/drm/*/status and /sys/class/drm/*/modes.
fn query_displays() -> Vec<(String, u32, u32)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let status = std::fs::read_to_string(path.join("status")).unwrap_or_default();
        if status.trim() != "connected" {
            continue;
        }
        let modes = std::fs::read_to_string(path.join("modes")).unwrap_or_default();
        let Some((w, h)) = modes.lines().find_map(parse_drm_mode) else {
            continue;
        };
        let clean_name = name
            .split_once('-')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or(name);
        out.push((clean_name, w, h));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn parse_drm_mode(mode: &str) -> Option<(u32, u32)> {
    let (width, height) = mode.trim().split_once('x')?;
    let dimensions = (width.parse().ok()?, height.parse().ok()?);
    (dimensions.0 > 0 && dimensions.1 > 0).then_some(dimensions)
}

fn show_pairing_code(window: &ApplicationWindow, code: &str, status: &str) {
    let vbox = GtkBox::new(Orientation::Vertical, 20);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);

    let title = logo_picture(BETTERFRAME_LOGO_PNG, 360, 88, "pairing-logo");

    let code_label = Label::new(Some(code));
    add_css(
        &code_label,
        ".code { font-size: 72px; color: #fff; font-weight: 700; letter-spacing: 12px; font-family: monospace; }",
    );
    code_label.add_css_class("code");

    let hint = Label::new(Some(status));
    add_css(&hint, ".hint { font-size: 14px; color: #666; }");
    hint.add_css_class("hint");

    vbox.append(&title);
    vbox.append(&code_label);
    vbox.append(&hint);
    if let Some(note) = os_update::last_update_note() {
        let diagnostic = Label::new(Some(&note));
        diagnostic.set_wrap(true);
        diagnostic.set_max_width_chars(72);
        vbox.append(&diagnostic);
    }

    let fw_ver = server::kiosk_app_version();
    let os_ver =
        std::fs::read_to_string("/etc/betterframe/os-version").unwrap_or_else(|_| "unknown".into());
    let ver_text = format!("FW: {}  OS: {}", fw_ver, os_ver.trim());
    let ver_label = Label::new(Some(&ver_text));
    add_css(
        &ver_label,
        ".ver { font-size: 11px; color: #555; margin: 8px; }",
    );
    ver_label.add_css_class("ver");
    ver_label.set_halign(gtk::Align::Start);
    ver_label.set_valign(gtk::Align::End);

    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&vbox));
    overlay.add_overlay(&ver_label);
    window.set_child(Some(&overlay));
    window.queue_resize();
    window.queue_draw();
    mark_kiosk_healthy();
    confirm_rendered_app(window);
    info!("pairing display updated to {code}");
}

fn show_pairing_progress(window: &ApplicationWindow) {
    let vbox = GtkBox::new(Orientation::Vertical, 20);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);

    let title = logo_picture(BETTERFRAME_LOGO_PNG, 360, 88, "pairing-logo");

    let status = Label::new(Some("Pairing complete"));
    add_css(
        &status,
        ".pairing-status { font-size: 22px; color: #fff; font-weight: 600; }",
    );
    status.add_css_class("pairing-status");

    let hint = Label::new(Some("Preparing kiosk"));
    add_css(&hint, ".hint { font-size: 14px; color: #666; }");
    hint.add_css_class("hint");

    vbox.append(&title);
    vbox.append(&spinner(36));
    vbox.append(&status);
    vbox.append(&hint);

    window.set_child(Some(&vbox));
}

/// Comparison-only copy: randomized transport ciphertext is not a camera
/// configuration change. Keep opaque values on decrypt failure so unknown
/// credentials cannot accidentally compare equal to absent credentials.
fn render_comparison_bundle(bundle: &KioskBundle, decrypt_key: Option<&str>) -> KioskBundle {
    use sha2::Digest;
    let mut comparable = bundle.clone();
    let normalize = |credential: &mut Option<String>| {
        if let Some(ciphertext) = credential.as_ref() {
            if let Some(secret) = decrypt_key.and_then(|key| onvif_events::decrypt_cluster_public(ciphertext, key)) {
                *credential = Some(format!("sha256:{:x}", sha2::Sha256::digest(secret.as_bytes())));
            }
        }
    };
    for camera in &mut comparable.cameras {
        normalize(&mut camera.playback_password_encrypted);
        normalize(&mut camera.onvif_password_encrypted);
    }
    for layout in comparable.displays.iter_mut().flat_map(|display| &mut display.layouts)
        .chain(comparable.layouts.iter_mut())
    {
        for cell in &mut layout.cells {
            if let Some(smart) = &mut cell.smart_url {
                for step in &mut smart.steps {
                    normalize(&mut step.value_encrypted);
                }
            }
        }
    }
    comparable
}

fn can_preserve_display(state: &DisplayState, previous: &KioskBundle, next: &KioskBundle, id: &str) -> bool {
    // Compare only the cameras actually shown by overrides. Telemetry and
    // changes to other available operator cameras do not affect these tiles.
    let override_cameras_unchanged = state.focus_overrides.values()
        .chain(state.fullscreen_override.iter()).all(|focus| {
            let inputs = |bundle: &KioskBundle| bundle.cameras.iter()
                .find(|camera| camera.id == focus.camera_id)
                .map(crate::core::layout::camera_render_inputs);
            inputs(previous) == inputs(next)
        });
    override_cameras_unchanged && crate::core::layout::display_render_unchanged(
        previous, next, id, state.current_layout_id.as_deref(),
    )
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
    set_reported_bundle_version(&bundle.version);
    let previous_bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
    let decrypt_key = server::load_encrypt_key().or_else(|| server::load_cluster_key());
    let comparable = render_comparison_bundle(&bundle, decrypt_key.as_deref());
    let previous_comparable = previous_bundle.as_ref()
        .map(|previous| render_comparison_bundle(previous, decrypt_key.as_deref()));
    let same_auth = CURRENT_AUTH.with(|a| {
        a.borrow().as_ref().is_some_and(|(url, key)| url == server_url && key == kiosk_key)
    });
    let unchanged_displays: std::collections::HashSet<String> = DISPLAYS.with(|ds| {
        ds.borrow().iter().filter_map(|(id, state)| {
            (same_auth && previous_comparable.as_ref().is_some_and(|previous| {
                can_preserve_display(state, previous, &comparable, id)
            })).then(|| id.clone())
        }).collect()
    });
    CURRENT_BUNDLE.with(|b| *b.borrow_mut() = Some(bundle.clone()));
    CURRENT_AUTH.with(|a| *a.borrow_mut() = Some((server_url.to_string(), kiosk_key.to_string())));
    CURRENT_SYNC_LABEL.with(|s| *s.borrow_mut() = format_current_local_time());

    // Restart GPIO workers (always — even if list is empty, this drops the old set).
    gpio::start_workers(&bundle.gpio_bindings, server_url, kiosk_key);

    // Collect camera IDs actually referenced in layout cells.
    let displays = bundle.normalized_displays();
    let layout_cam_ids: std::collections::HashSet<String> = displays
        .iter()
        .flat_map(|d| d.layouts.iter())
        .flat_map(|l| l.cells.iter())
        .filter_map(|c| c.camera_id.clone())
        .collect();

    // Only subscribe to ONVIF events for cameras in layouts (not all bundle cameras).
    let layout_cameras: Vec<_> = bundle
        .cameras
        .iter()
        .filter(|c| layout_cam_ids.contains(&c.id))
        .cloned()
        .collect();
    onvif_events::start(
        &layout_cameras,
        decrypt_key.as_deref(),
        server_url,
        kiosk_key,
        &bundle.tenant_slug,
    );

    // An existing camera ID does not imply that its URI/credentials are still
    // current. Invalidate changed cameras before ensure_warm can reuse them.
    let reusable_cameras = crate::core::layout::unchanged_camera_ids(previous_comparable.as_ref(), &comparable);
    purge_obsolete_cameras(&reusable_cameras);
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
    let keep_ids: std::collections::HashSet<&str> =
        displays.iter().map(|d| d.id.as_str()).collect();
    let to_remove: Vec<String> = DISPLAYS.with(|ds| {
        ds.borrow()
            .keys()
            .filter(|id| !keep_ids.contains(id.as_str()))
            .cloned()
            .collect()
    });
    for id in to_remove {
        if let Some(st) = DISPLAYS.with(|ds| ds.borrow_mut().remove(&id)) {
            st.window.close();
        }
    }

    if displays.is_empty() {
        // A valid bundle without assignments is a settled configuration state,
        // including when the last display was removed from an active kiosk.
        pairing_window.set_child(Some(&build_empty_display_reference(&bundle, None)));
        pairing_window.present();
        recompute_global_state();
        mark_kiosk_healthy();
        confirm_rendered_app(pairing_window);
        return;
    }

    // Note: hot/warm/cooling pool recompute is deferred to the per-display
    // render_layout() calls below — each one calls recompute_global_state()
    // after installing its current_layout_id, so the union across all
    // displays is correct once the loop finishes.

    // Build/reuse window per bundle display, then render its initial layout.
    let mut new_state: HashMap<String, DisplayState> = HashMap::new();
    for (i, bd) in displays.iter().enumerate() {
        let existing = DISPLAYS.with(|ds| ds.borrow_mut().remove(&bd.id));
        if unchanged_displays.contains(&bd.id) {
            if let Some(state) = existing {
                if let Some(content) = state.content_overlay.child() {
                    refresh_empty_display_reference(&content, &bundle, Some(bd));
                }
                new_state.insert(bd.id.clone(), state);
                continue;
            }
        }

        let (
            window,
            was_asleep,
            last_activity,
            previous_layout,
            existing_overlay,
            existing_web_layer,
        ) = match existing {
            Some(st) => (
                st.window,
                st.is_asleep,
                st.last_activity,
                st.current_layout_id,
                Some(st.content_overlay),
                Some(st.web_layer),
            ),
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
                let input = gtk::EventControllerLegacy::new();
                input.set_propagation_phase(gtk::PropagationPhase::Capture);
                let id = bd.id.clone();
                input.connect_event(move |_, event| {
                    if matches!(
                        event.event_type(),
                        gtk::gdk::EventType::ButtonPress
                            | gtk::gdk::EventType::KeyPress
                            | gtk::gdk::EventType::TouchBegin
                            | gtk::gdk::EventType::Scroll
                    ) {
                        let asleep =
                            DISPLAYS.with(|ds| ds.borrow().get(&id).is_some_and(|st| st.is_asleep));
                        if asleep {
                            wake_display(Some(&id));
                            return gtk::glib::Propagation::Stop;
                        }
                        mark_activity(&id);
                    }
                    gtk::glib::Propagation::Proceed
                });
                w.add_controller(input);
                w.present();
                if let Some(monitor) = gdk_monitors.get(i) {
                    w.fullscreen_on_monitor(monitor);
                }
                (w, false, Instant::now(), None, None, None)
            }
        };
        let content_overlay = existing_overlay.unwrap_or_else(|| {
            let ov = gtk::Overlay::new();
            ov.set_vexpand(true);
            ov.set_hexpand(true);
            ov
        });
        let web_layer = existing_web_layer.unwrap_or_else(|| {
            let wl = gtk::Fixed::new();
            wl.set_can_target(false);
            content_overlay.add_overlay(&wl);
            wl
        });
        if was_asleep {
            window.set_child(Some(&build_sleep_screen(&bd.id)));
        } else {
            window.set_child(Some(&content_overlay));
        }

        new_state.insert(
            bd.id.clone(),
            DisplayState {
                window,
                current_layout_id: previous_layout,
                last_activity,
                is_asleep: was_asleep,
                content_overlay,
                web_layer,
                web_positions: Vec::new(),
                grid_dims: (1, 1),
                focus_overrides: HashMap::new(),
                fullscreen_override: None,
                display_cleared: false,
                override_generation: 0,
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
        if unchanged_displays.contains(&bd.id) {
            continue;
        }
        let previous = DISPLAYS.with(|ds| {
            ds.borrow()
                .get(&bd.id)
                .and_then(|st| st.current_layout_id.clone())
        });
        let target = previous
            .filter(|id| bd.layouts.iter().any(|layout| layout.id == *id))
            .or_else(|| crate::core::layout::initial_layout_id(bd));
        if let Some(layout_id) = target {
            render_layout_inner(&bd.id, &layout_id, true);
        } else {
            info!("display {} has no assigned layouts", bd.id);
            DISPLAYS.with(|ds| {
                if let Some(st) = ds.borrow_mut().get_mut(&bd.id) {
                    let content = build_empty_display_reference(&bundle, Some(bd));
                    st.content_overlay.set_child(Some(&content));
                    hide_all_webviews(&st.web_layer);
                    st.current_layout_id = None;
                }
            });
        }
    }

    // Empty assignments also release content from the previous bundle.
    recompute_global_state();

    // A rendered cached bundle is healthy even when the server is offline.
    // RAUC rollback protects app startup, not server reachability.
    mark_kiosk_healthy();
    DISPLAYS.with(|ds| {
        for state in ds.borrow().values() {
            confirm_rendered_app(&state.window);
        }
    });
}

/// Find which display owns a given layout_id and render it there.
fn switch_layout_anywhere(layout_id: &str) {
    let bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
    let Some(bundle) = bundle else { return };
    for bd in bundle.normalized_displays() {
        if bd.layouts.iter().any(|l| l.id == layout_id) {
            render_layout(&bd.id, layout_id);
            return;
        }
    }
    warn!("switch_layout: layout {layout_id} not found on any display");
}

/// Render a specific layout id on a specific display.
fn render_layout(display_id: &str, layout_id: &str) {
    mark_activity(display_id);
    render_layout_inner(display_id, layout_id, false);
}

fn render_layout_inner(display_id: &str, layout_id: &str, preserve_override: bool) {
    if is_terminal_overlay_active() {
        info!("render_layout: deferred — terminal auth overlay active");
        return;
    }
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
            .as_deref()
            .and_then(|did| bd.layouts.iter().find(|l| l.id == did))
            .or_else(|| bd.layouts.iter().find(|l| l.is_default))
            .or_else(|| bd.layouts.first())
    });

    let Some(base_layout) = layout else {
        info!("render_layout: no assigned layouts on display {display_id}");
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(display_id) {
                let content = build_empty_display_reference(&bundle, Some(bd));
                st.content_overlay.set_child(Some(&content));
                hide_all_webviews(&st.web_layer);
                st.web_positions.clear();
                st.current_layout_id = None;
            }
        });
        return;
    };

    // Update per-display layout id BEFORE recomputing warm-cameras so the
    // union across displays is correct.
    let layout_changed = DISPLAYS.with(|ds| {
        let mut displays = ds.borrow_mut();
        if let Some(st) = displays.get_mut(display_id) {
            let changed = st.current_layout_id.as_deref() != Some(base_layout.id.as_str());
            st.current_layout_id = Some(base_layout.id.clone());
            if !preserve_override {
                st.focus_overrides.clear();
                st.fullscreen_override = None;
                st.display_cleared = false;
            }
            changed
        } else {
            false
        }
    });

    if DISPLAYS.with(|ds| ds.borrow().get(display_id).is_some_and(|st| st.is_asleep)) {
        recompute_global_state();
        return;
    }
    let mut layout = base_layout.clone();
    apply_operator_overrides(display_id, &mut layout);

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
    // sees idle reverts + any other kiosk-initiated switch.
    if layout_changed {
        let layout_name = layout.name.clone();
        let layout_id_for_report = layout.id.clone();
        let display_id_for_report = display_id.to_string();
        let server = server_url.clone();
        let key = kiosk_key.clone();
        std::thread::spawn(move || {
            server::report_layout_change(
                &server,
                &key,
                &display_id_for_report,
                &layout_id_for_report,
                &layout_name,
            );
        });
    }

    if layout.cells.is_empty() {
        info!("layout has no assigned content");
        recompute_global_state();
        DISPLAYS.with(|ds| {
            if let Some(st) = ds.borrow_mut().get_mut(display_id) {
                st.content_overlay
                    .set_child(Some(&build_empty_display_message(
                        &bundle,
                        Some(bd),
                        "This layout is empty. Add content to it in BetterFrame.",
                    )));
                hide_all_webviews(&st.web_layer);
                st.web_positions.clear();
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

    let cam_map: HashMap<&str, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id.as_str(), c)).collect();

    let total_area = (layout.grid_cols.max(1) * layout.grid_rows.max(1)) as f32;

    // Ensure preloaded cameras have pipelines even if not visible.
    for cam_id in &layout.preload_camera_ids {
        if let Some(cam) = cam_map.get(cam_id.as_str()) {
            ensure_warm(cam_id, cam, None, 0.0);
        }
    }

    let mut web_cells: Vec<WebCellPos> = Vec::new();

    for cell in &layout.cells {
        let cell_key: Option<String> = match cell.content_type.as_str() {
            "camera" => cell.camera_id.as_ref().map(|id| {
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
                if let Some(cam_id) = cell.camera_id.as_ref() {
                    if let Some(cam) = cam_map.get(cam_id.as_str()) {
                        let area = (cell.col_span * cell.row_span) as f32 / total_area;
                        if let Some((paintable, badge, stream_status)) =
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
                            overlay.set_overflow(gtk::Overflow::Hidden);
                            let name_label = Label::new(Some(&cam.name));
                            name_label.set_halign(gtk::Align::End);
                            name_label.set_valign(gtk::Align::End);
                            name_label.set_overflow(gtk::Overflow::Hidden);
                            name_label.set_ellipsize(gtk::pango::EllipsizeMode::End);
                            name_label.set_single_line_mode(true);
                            name_label.set_xalign(1.0);
                            name_label.set_margin_end(6);
                            name_label.set_margin_bottom(6);
                            add_css(
                                &name_label,
                                "label { background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; padding: 2px 8px; border-radius: 3px; }",
                            );
                            let overlay_weak = overlay.downgrade();
                            let name_label_weak = name_label.downgrade();
                            overlay.add_tick_callback(move |_, _| {
                                let Some(overlay) = overlay_weak.upgrade() else {
                                    return gtk::glib::ControlFlow::Break;
                                };
                                let Some(name_label) = name_label_weak.upgrade() else {
                                    return gtk::glib::ControlFlow::Break;
                                };

                                let tile_width = overlay.allocated_width();
                                if tile_width > 0 {
                                    name_label
                                        .set_width_request(((tile_width as f64) * 0.9) as i32);
                                    return gtk::glib::ControlFlow::Break;
                                }

                                gtk::glib::ControlFlow::Continue
                            });
                            overlay.add_overlay(&name_label);

                            // Top-left badge row: stream type + status icon
                            let badge_box = GtkBox::new(Orientation::Horizontal, 3);
                            badge_box.set_halign(gtk::Align::Start);
                            badge_box.set_valign(gtk::Align::Start);
                            badge_box.set_margin_start(4);
                            badge_box.set_margin_top(4);

                            if badge == 'M' || badge == 'S' {
                                let label = Label::new(Some(&badge.to_string()));
                                add_css(
                                    &label,
                                    "label { background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; min-width: 14px; }",
                                );
                                badge_box.append(&label);
                            }

                            let status_label = Label::new(None);
                            status_label.set_visible(false);
                            status_label.add_css_class("bf-stream-status");
                            add_css(
                                &status_label,
                                ".bf-stream-status { background: rgba(200,40,40,0.85); color: #fff; font-size: 11px; font-weight: 600; padding: 2px 6px; border-radius: 4px; min-width: 14px; }",
                            );
                            badge_box.append(&status_label);
                            overlay.add_overlay(&badge_box);

                            // Poll stream status every 1s; stop when label is dropped
                            let status_weak = status_label.downgrade();
                            gtk::glib::timeout_add_local(Duration::from_secs(1), move || {
                                let Some(lbl) = status_weak.upgrade() else {
                                    return gtk::glib::ControlFlow::Break;
                                };
                                let s = stream_status.load(Ordering::Relaxed);
                                match s {
                                    pipeline::STATUS_RESTARTING => {
                                        lbl.set_label("↻");
                                        lbl.set_visible(true);
                                    }
                                    pipeline::STATUS_ERROR => {
                                        lbl.set_label("!");
                                        lbl.set_visible(true);
                                    }
                                    _ => {
                                        lbl.set_visible(false);
                                    }
                                }
                                gtk::glib::ControlFlow::Continue
                            });

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
                    let meta = web_event_meta(&bundle, display_id, cell, &server_url, &kiosk_key);
                    let _ = ensure_web(
                        key.clone(),
                        WebSource::Html(html),
                        &server_url,
                        &kiosk_key,
                        None,
                        Some(meta),
                    );
                    web_cells.push(WebCellPos {
                        key,
                        col: cell.col,
                        row: cell.row,
                        col_span: cell.col_span,
                        row_span: cell.row_span,
                    });
                    web_spacer()
                }
            }
            "web" => {
                let url = cell.web_url.as_deref().unwrap_or("").trim();
                if url.is_empty() {
                    none_cell()
                } else {
                    let key = format!("web:{url}");
                    let wv = ensure_web(
                        key.clone(),
                        WebSource::Url(url),
                        &server_url,
                        &kiosk_key,
                        cell.local_storage.as_ref(),
                        Some(web_event_meta(
                            &bundle,
                            display_id,
                            cell,
                            &server_url,
                            &kiosk_key,
                        )),
                    );
                    if let Some(ref smart) = cell.smart_url {
                        let decrypt_key =
                            server::load_encrypt_key().or_else(|| server::load_cluster_key());
                        execute_smart_url_steps(&wv, smart, decrypt_key.as_deref());
                    }
                    web_cells.push(WebCellPos {
                        key,
                        col: cell.col,
                        row: cell.row,
                        col_span: cell.col_span,
                        row_span: cell.row_span,
                    });
                    web_spacer()
                }
            }
            "none" => none_cell(),
            _ => placeholder(Some("Unknown content")),
        };

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

    let grid_cols = layout.grid_cols;
    let grid_rows = layout.grid_rows;
    let display_id_owned = display_id.to_string();

    DISPLAYS.with(|ds| {
        if let Some(st) = ds.borrow_mut().get_mut(display_id) {
            st.web_positions = web_cells;
            st.grid_dims = (grid_cols, grid_rows);
            animate_layout_swap(&st.content_overlay, &grid);
        }
    });

    schedule_webview_positions(&display_id_owned);
}

fn cell_id(cell: &BundleCell) -> String {
    cell.view_id
        .clone()
        .unwrap_or_else(|| format!("r{}c{}", cell.row, cell.col))
}

fn operator_target_cell(
    layout: &crate::bundle::BundleLayout,
    requested_id: Option<&str>,
    overrides: &HashMap<String, FocusOverride>,
) -> Option<String> {
    if let Some(id) = requested_id {
        return layout
            .cells
            .iter()
            .find(|cell| cell_id(cell) == id)
            .map(cell_id);
    }
    layout
        .cells
        .iter()
        .find(|cell| cell.content_type == "none" && !overrides.contains_key(&cell_id(cell)))
        .map(cell_id)
}

fn apply_operator_overrides(display_id: &str, layout: &mut crate::bundle::BundleLayout) {
    let snapshot = DISPLAYS.with(|ds| {
        ds.borrow().get(display_id).map(|st| {
            (
                st.focus_overrides.clone(),
                st.fullscreen_override.clone(),
                st.display_cleared,
            )
        })
    });
    let Some((overrides, fullscreen, cleared)) = snapshot else {
        return;
    };
    if cleared {
        for cell in &mut layout.cells {
            cell.content_type = "none".to_string();
            cell.camera_id = None;
        }
        return;
    }
    if let Some(focus) = fullscreen {
        let mut cell = layout.cells.first().cloned().unwrap_or(BundleCell {
            view_id: None,
            entity_id: None,
            row: 0,
            col: 0,
            row_span: 1,
            col_span: 1,
            content_type: "none".to_string(),
            camera_id: None,
            stream_selector: None,
            web_url: None,
            html_content: None,
            cooling_timeout_seconds: None,
            fit: "cover".to_string(),
            smart_url: None,
            local_storage: None,
            input_options: None,
        });
        layout.grid_cols = 1;
        layout.grid_rows = 1;
        cell.row = 0;
        cell.col = 0;
        cell.row_span = 1;
        cell.col_span = 1;
        cell.content_type = "camera".to_string();
        cell.camera_id = Some(focus.camera_id);
        cell.stream_selector = Some(focus.stream);
        layout.cells = vec![cell];
        return;
    }
    for cell in &mut layout.cells {
        if let Some(focus) = overrides.get(&cell_id(cell)) {
            cell.content_type = "camera".to_string();
            cell.camera_id = Some(focus.camera_id.clone());
            cell.stream_selector = Some(focus.stream.clone());
            cell.web_url = None;
            cell.html_content = None;
        }
    }
}

fn operator_focus(request: OperatorFocusRequest) -> Result<serde_json::Value, String> {
    let bundle = CURRENT_BUNDLE
        .with(|current| current.borrow().clone())
        .ok_or_else(|| "no bundle cached yet".to_string())?;
    if !bundle
        .cameras
        .iter()
        .any(|camera| camera.id == request.camera_id && camera.enabled && camera.simple_vms_managed)
    {
        return Err("camera is not available to this kiosk".to_string());
    }
    let displays = bundle.normalized_displays();
    let display = displays
        .iter()
        .find(|display| display.id == request.display_id)
        .ok_or_else(|| "display not found".to_string())?;
    let active_layout_id = DISPLAYS.with(|states| {
        states
            .borrow()
            .get(&request.display_id)
            .and_then(|state| state.current_layout_id.clone())
    });
    let active_layout_id =
        active_layout_id.ok_or_else(|| "display has no active layout".to_string())?;
    let layout = display
        .layouts
        .iter()
        .find(|layout| layout.id == active_layout_id)
        .ok_or_else(|| "active layout not found".to_string())?;
    let overrides = DISPLAYS.with(|states| {
        states
            .borrow()
            .get(&request.display_id)
            .map(|state| state.focus_overrides.clone())
            .unwrap_or_default()
    });
    let selected_cell = if request.fullscreen {
        None
    } else {
        operator_target_cell(layout, request.cell_id.as_deref(), &overrides)
    };
    if !request.fullscreen && selected_cell.is_none() {
        return Err(if request.cell_id.is_some() {
            "target tile not found".to_string()
        } else {
            "layout has no empty target tile".to_string()
        });
    }

    let generation = DISPLAYS.with(|states| {
        let mut states = states.borrow_mut();
        let state = states
            .get_mut(&request.display_id)
            .ok_or_else(|| "display is not active".to_string())?;
        state.override_generation += 1;
        let generation = state.override_generation;
        state.display_cleared = false;
        let focus = FocusOverride {
            camera_id: request.camera_id.clone(),
            stream: request.stream.clone(),
            generation,
        };
        if request.fullscreen {
            state.fullscreen_override = Some(focus);
        } else if let Some(cell) = selected_cell.as_ref() {
            state.focus_overrides.insert(cell.clone(), focus);
        }
        Ok::<u64, String>(generation)
    })?;

    mark_activity(&request.display_id);
    render_layout_inner(&request.display_id, &active_layout_id, true);
    if let Some(seconds) = request.duration_seconds {
        let display_id = request.display_id.clone();
        let cell = selected_cell.clone();
        let fullscreen = request.fullscreen;
        gtk::glib::timeout_add_local_once(Duration::from_secs(seconds), move || {
            let layout_id = DISPLAYS.with(|states| {
                let mut states = states.borrow_mut();
                let state = states.get_mut(&display_id)?;
                let current = if fullscreen {
                    state.fullscreen_override.as_ref()
                } else {
                    cell.as_ref().and_then(|id| state.focus_overrides.get(id))
                };
                if current.is_none_or(|focus| focus.generation != generation) {
                    return None;
                }
                if fullscreen {
                    state.fullscreen_override = None;
                } else if let Some(id) = cell.as_ref() {
                    state.focus_overrides.remove(id);
                }
                state.current_layout_id.clone()
            });
            if let Some(layout_id) = layout_id {
                render_layout_inner(&display_id, &layout_id, true);
            }
        });
    }
    Ok(serde_json::json!({ "ok": true, "cell_id": selected_cell }))
}

fn operator_clear(display_id: &str) -> Result<serde_json::Value, String> {
    let layout_id = DISPLAYS.with(|states| {
        let mut states = states.borrow_mut();
        let state = states
            .get_mut(display_id)
            .ok_or_else(|| "display is not active".to_string())?;
        state.override_generation += 1;
        state.focus_overrides.clear();
        state.fullscreen_override = None;
        state.display_cleared = true;
        state
            .current_layout_id
            .clone()
            .ok_or_else(|| "display has no active layout".to_string())
    })?;
    mark_activity(display_id);
    render_layout_inner(display_id, &layout_id, true);
    Ok(serde_json::json!({ "ok": true }))
}

fn operator_restore(display_id: &str) -> Result<serde_json::Value, String> {
    let layout_id = DISPLAYS.with(|states| {
        let mut states = states.borrow_mut();
        let state = states
            .get_mut(display_id)
            .ok_or_else(|| "display is not active".to_string())?;
        state.override_generation += 1;
        state.focus_overrides.clear();
        state.fullscreen_override = None;
        state.display_cleared = false;
        state
            .current_layout_id
            .clone()
            .ok_or_else(|| "display has no active layout".to_string())
    })?;
    mark_activity(display_id);
    render_layout_inner(display_id, &layout_id, true);
    Ok(serde_json::json!({ "ok": true }))
}

/// Swap the overlay's grid content with a per-cell morph animation.
///
/// Matches cells by widget_name across old + new grids. Same-key cells slide +
/// scale from their old screen position to the new one over 350ms (ease-out
/// cubic). New cells fade in; removed cells fade out from their old spot.
/// Cells with no widget_name (e.g. placeholders) just snap.
///
/// The `content_overlay` is a persistent Overlay that is always the window
/// child. Its main child is the grid; its overlay children include the
/// web_layer (persistent WebView Fixed). Animation ghosts are added/removed
/// as temporary overlay children.
const LAYOUT_ANIM_MS: u32 = 350;

#[derive(Clone)]
struct CellSnap {
    paintable: gtk::gdk::Paintable,
    bounds: gtk::graphene::Rect,
}

fn animate_layout_swap(content_overlay: &gtk::Overlay, new_grid: &gtk::Grid) {
    let mut snaps: std::collections::HashMap<String, CellSnap> = std::collections::HashMap::new();
    if let Some(old_grid) = content_overlay.child() {
        let mut child = old_grid.first_child();
        while let Some(c) = child {
            let key = c.widget_name();
            if !key.is_empty() {
                if let Some(b) = c.compute_bounds(&old_grid) {
                    // Freeze the image while the old widget is still parented.
                    // A live WidgetPaintable can become empty after grid removal.
                    let paintable = gtk::WidgetPaintable::new(Some(&c)).current_image();
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

    content_overlay.set_child(Some(new_grid));

    if snaps.is_empty() {
        return;
    }

    let ghost = gtk::Fixed::new();
    ghost.set_can_target(false);
    content_overlay.add_overlay(&ghost);

    let new_grid_clone = new_grid.clone();
    let ghost_clone = ghost.clone();
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

        for (_key, snap) in &snaps {
            let pic = gtk::Picture::for_paintable(&snap.paintable);
            pic.set_can_target(false);
            pic.set_size_request(snap.bounds.width() as i32, snap.bounds.height() as i32);
            ghost_clone.put(&pic, snap.bounds.x() as f64, snap.bounds.y() as f64);
            fade_out_and_drop(&pic, &ghost_clone);
        }

        for (target, new_bounds, snap) in pairs {
            target.set_opacity(0.0);
            let pic = gtk::Picture::for_paintable(&snap.paintable);
            pic.set_can_target(false);
            pic.set_size_request(snap.bounds.width() as i32, snap.bounds.height() as i32);
            ghost_clone.put(&pic, snap.bounds.x() as f64, snap.bounds.y() as f64);
            animate_picture_to_bounds(&pic, &target, &ghost_clone, snap.bounds, new_bounds);
        }

        for c in fresh {
            c.set_opacity(0.0);
            fade_in(&c);
        }

        let ghost_weak = ghost_clone.downgrade();
        let grid_weak = new_grid_clone.downgrade();
        gtk::glib::timeout_add_local_once(
            Duration::from_millis((LAYOUT_ANIM_MS + 50) as u64),
            move || {
                // Frame-clock callbacks may be delayed or never run (unmapped
                // widgets, a busy decoder/GPU, or a rapid second layout edit).
                // Restore the real tiles before destroying their animation clock.
                if let Some(grid) = grid_weak.upgrade() {
                    let mut child = grid.first_child();
                    while let Some(tile) = child {
                        tile.set_opacity(1.0);
                        child = tile.next_sibling();
                    }
                }
                if let Some(g) = ghost_weak.upgrade() {
                    if let Some(parent) = g.parent().and_then(|p| p.downcast::<gtk::Overlay>().ok()) {
                        parent.remove_overlay(&g);
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

/// Keep hot stream role selection identical to the pool's desired keys.
fn rewarm_hot_cameras(
    required: &std::collections::HashSet<PoolKey>,
    cameras: &HashMap<&str, &crate::bundle::BundleCamera>,
    mut warm: impl FnMut(&str, &crate::bundle::BundleCamera, Option<&str>),
) {
    for (id, badge) in required {
        if let Some(camera) = cameras.get(id.as_str()) {
            let selector = match badge { 'M' => Some("main"), 'S' => Some("sub"), _ => None };
            warm(id, camera, selector);
        }
    }
}

/// Walk all displays' currently-active layouts (plus any priority=hot layouts)
/// and recompute the warm/hot pool. Pool entries dropped from active layouts
/// transition to Cooling. Hot-layout pipelines are also created here so
/// invalidation cannot leave an inactive hot layout cold.
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

    let cam_map: HashMap<&str, &crate::bundle::BundleCamera> =
        bundle.cameras.iter().map(|c| (c.id.as_str(), c)).collect();

    // Snapshot per-display active layout id outside any borrow of WARM_CAMERAS.
    let active: Vec<(String, Option<String>, bool)> = DISPLAYS.with(|ds| {
        ds.borrow()
            .iter()
            .map(|(id, st)| (id.clone(), st.current_layout_id.clone(), st.is_asleep))
            .collect()
    });

    // Helper: compute the pool key (camera_id, badge) for a given cell in a
    // layout. Falls back to a "?" badge if pick_stream can't decide (camera
    // missing or no streams).
    fn cell_keys(
        layout: &crate::bundle::BundleLayout,
        cam_map: &HashMap<&str, &crate::bundle::BundleCamera>,
        out: &mut std::collections::HashSet<PoolKey>,
    ) {
        let total_area = (layout.grid_cols.max(1) * layout.grid_rows.max(1)) as f32;
        for cell in &layout.cells {
            if cell.content_type != "camera" {
                continue;
            }
            let Some(cam_id) = cell.camera_id.as_ref() else {
                continue;
            };
            let Some(cam) = cam_map.get(cam_id.as_str()) else {
                continue;
            };
            let area = (cell.col_span * cell.row_span) as f32 / total_area;
            if let Some((_, badge)) = cam.pick_stream(cell.stream_selector.as_deref(), area) {
                out.insert((cam_id.clone(), badge));
            }
        }
        // Preload cameras have no cell context — let pick_stream choose
        // (typically sub). Different layouts that actually render them will
        // promote whichever badge they end up using.
        for cam_id in &layout.preload_camera_ids {
            if let Some(cam) = cam_map.get(cam_id.as_str()) {
                if let Some((_, badge)) = cam.pick_stream(None, 0.0) {
                    out.insert((cam_id.clone(), badge));
                }
            }
        }
    }

    for bd in &displays {
        let active_entry = active
            .iter()
            .find(|(id, _, _)| *id == bd.id)
            .map(|(_, layout_id, is_asleep)| (layout_id.clone(), *is_asleep));
        let is_asleep = active_entry
            .as_ref()
            .map(|(_, is_asleep)| *is_asleep)
            .unwrap_or(false);
        if let Some(cur_id) = active_entry
            .as_ref()
            .and_then(|(layout_id, _)| layout_id.as_ref())
        {
            if let Some(layout) = bd.layouts.iter().find(|l| l.id.as_str() == cur_id.as_str()) {
                let t = layout.cooling_timeout_seconds.unwrap_or(0);
                let t = if t == 0 { DEFAULT_COOLING_SECS } else { t };
                max_cooling_secs = max_cooling_secs.max(t);
                if !is_asleep {
                    cell_keys(layout, &cam_map, &mut warm_set);
                }
            }
        }
        if is_asleep {
            continue;
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
        let active_entry = active
            .iter()
            .find(|(id, _, _)| *id == bd.id)
            .map(|(_, layout_id, is_asleep)| (layout_id.clone(), *is_asleep));
        let is_asleep = active_entry
            .as_ref()
            .map(|(_, is_asleep)| *is_asleep)
            .unwrap_or(false);
        if !is_asleep {
            if let Some(cur_id) = active_entry
                .as_ref()
                .and_then(|(layout_id, _)| layout_id.as_ref())
            {
                if let Some(layout) = bd.layouts.iter().find(|l| l.id.as_str() == cur_id.as_str()) {
                    web_keys_for_layout(layout, &mut warm_webs);
                }
            }
        }
        if is_asleep {
            continue;
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
    // Recreate hot streams invalidated by a bundle refresh even when their
    // layout is inactive and no display needed to render again.
    rewarm_hot_cameras(&hot_set, &cam_map, |id, camera, selector| {
        let _ = ensure_warm(id, camera, selector, 0.0);
    });
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
                    to_remove.push(key.clone());
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

/// Remove pipelines whose camera was removed or whose configuration changed.
/// Immediately stops pipelines — no cooling period.
fn purge_obsolete_cameras(valid_ids: &std::collections::HashSet<String>) {
    let mut to_remove: Vec<PoolKey> = Vec::new();
    let mut to_stop: Vec<gstreamer::Pipeline> = Vec::new();

    WARM_CAMERAS.with(|w| {
        let mut warm = w.borrow_mut();
        for (key, entry) in warm.iter() {
            if !valid_ids.contains(key.0.as_str()) {
                to_remove.push(key.clone());
                to_stop.push(entry.pipeline.clone());
            }
        }
        for k in &to_remove {
            warm.remove(k);
        }
    });

    for pipe in &to_stop {
        pipeline::stop(pipe);
    }
    if !to_remove.is_empty() {
        info!(
            "purged {} removed or reconfigured camera pipelines",
            to_remove.len()
        );
    }
}

/// Drop any Cooling entries whose timer has expired. Called from the
/// 1s watchdog tick.
fn expire_cooling_pipelines() {
    let now = Instant::now();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut expired: Vec<(PoolKey, gstreamer::Pipeline)> = Vec::new();
    WARM_CAMERAS.with(|w| {
        let mut warm = w.borrow_mut();
        // Restart stalled Warm/Hot pipelines in-place (no widget rebuild).
        for (k, e) in warm.iter() {
            if e.state == WarmthState::Warm || e.state == WarmthState::Hot {
                let last = e.last_buffer_at.load(Ordering::Relaxed);
                if last > 0 && now_ms.saturating_sub(last) > STALL_THRESHOLD_MS {
                    if e.first_stall_at.load(Ordering::Relaxed) == 0 {
                        e.first_stall_at.store(now_ms, Ordering::Relaxed);
                    }
                    warn!(
                        "camera {} ({}): stream stalled (no frames for {}s) → restarting in-place",
                        k.0,
                        k.1,
                        STALL_THRESHOLD_MS / 1000
                    );
                    pipeline::restart(
                        &e.pipeline,
                        &e.last_buffer_at,
                        &e.stream_status,
                        &e.pipeline_stats,
                    );
                } else if e.first_stall_at.load(Ordering::Relaxed) > 0 {
                    e.first_stall_at.store(0, Ordering::Relaxed);
                }
            }
        }
        // Collect cooling-expired entries for removal.
        let keys: Vec<PoolKey> = warm
            .iter()
            .filter(|(_, e)| {
                e.state == WarmthState::Cooling && e.cooling_until.is_some_and(|t| now >= t)
            })
            .map(|(k, _)| k.clone())
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

/// Drop Warm/Hot pipelines that stayed stalled despite in-place restart.
/// Only re-renders displays that contained the stalled cameras.
fn heal_stalled_streams() {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut dropped_cam_ids: Vec<String> = Vec::new();

    WARM_CAMERAS.with(|w| {
        let mut warm = w.borrow_mut();
        let to_drop: Vec<PoolKey> = warm
            .iter()
            .filter(|(_, e)| {
                (e.state == WarmthState::Warm || e.state == WarmthState::Hot)
                    && e.first_stall_at.load(Ordering::Relaxed) > 0
                    && now_ms.saturating_sub(e.first_stall_at.load(Ordering::Relaxed))
                        > HEAL_THRESHOLD_MS
            })
            .map(|(k, _)| k.clone())
            .collect();

        for k in &to_drop {
            if let Some(e) = warm.remove(k) {
                warn!(
                    "camera {} ({}): stalled >{}s — dropping pipeline for re-render",
                    k.0,
                    k.1,
                    HEAL_THRESHOLD_MS / 1000
                );
                pipeline::stop(&e.pipeline);
                dropped_cam_ids.push(k.0.clone());
            }
        }
    });

    if dropped_cam_ids.is_empty() {
        return;
    }

    let bundle = CURRENT_BUNDLE.with(|b| b.borrow().clone());
    let Some(bundle) = bundle else { return };
    let displays = bundle.normalized_displays();

    let to_render: Vec<(String, String)> = DISPLAYS.with(|ds| {
        ds.borrow()
            .iter()
            .filter_map(|(id, st)| {
                if st.is_asleep {
                    return None;
                }
                let layout_id = st.current_layout_id.as_ref()?;
                let bd = displays.iter().find(|d| d.id == *id)?;
                let layout = bd.layouts.iter().find(|l| l.id == *layout_id)?;
                let uses_dropped = layout.cells.iter().any(|c| {
                    c.camera_id
                        .as_ref()
                        .is_some_and(|cid| dropped_cam_ids.contains(cid))
                });
                if uses_dropped {
                    Some((id.clone(), layout_id.clone()))
                } else {
                    None
                }
            })
            .collect()
    });

    for (display_id, layout_id) in to_render {
        info!("auto-heal: re-rendering layout {layout_id} on display {display_id}");
        render_layout_inner(&display_id, &layout_id, true);
    }
}

fn load_webview_url(webview: &webkit6::WebView, url: &str, server_url: &str, kiosk_key: &str) {
    if should_attach_kiosk_auth(url, server_url) {
        // The trusted server exchanges the initial header for a host-only,
        // HttpOnly cookie used by subsequent sub-resource requests.
        let request = webkit6::URIRequest::new(url);
        if let Some(headers) = request.http_headers() {
            headers.append("Authorization", &format!("Bearer {kiosk_key}"));
        }
        webkit6::prelude::WebViewExt::load_request(webview, &request);
        return;
    }

    webkit6::prelude::WebViewExt::load_uri(webview, url);
}

/// Execute smart URL steps on a WebView after loading. Steps run
/// sequentially via JS injection. Used for auto-login, cookie accept,
/// multi-step navigation before showing the final page.
fn execute_smart_url_steps(
    webview: &webkit6::WebView,
    config: &crate::bundle::SmartUrlConfig,
    decrypt_key: Option<&str>,
) {
    let mut js_parts: Vec<String> = Vec::new();

    for step in &config.steps {
        match step.step_type.as_str() {
            "navigate" => {
                if let Some(url) = &step.url {
                    js_parts.push(format!("window.location.href = {};", js_string_lit(url)));
                    js_parts.push("await new Promise(r => setTimeout(r, 1000));".to_string());
                }
            }
            "fill" => {
                if let Some(sel) = &step.selector {
                    let value = step
                        .value
                        .clone()
                        .or_else(|| {
                            step.value_encrypted.as_ref().and_then(|enc| {
                                decrypt_key.and_then(|k| {
                                    crate::onvif_events::decrypt_cluster_public(enc, k)
                                })
                            })
                        })
                        .unwrap_or_default();
                    js_parts.push(format!(
                        "{{ var el = document.querySelector({}); if (el) {{ el.value = {}; el.dispatchEvent(new Event('input', {{bubbles:true}})); }} }}",
                        js_string_lit(sel), js_string_lit(&value)
                    ));
                }
            }
            "click" => {
                if let Some(sel) = &step.selector {
                    js_parts.push(format!(
                        "{{ var el = document.querySelector({}); if (el) el.click(); }}",
                        js_string_lit(sel)
                    ));
                }
            }
            "wait" => {
                let ms = step.delay_ms.unwrap_or(1000);
                js_parts.push(format!("await new Promise(r => setTimeout(r, {ms}));"));
            }
            "wait_for" => {
                if let Some(sel) = &step.selector {
                    let timeout = step.timeout_ms.unwrap_or(10000);
                    js_parts.push(format!(
                        "await new Promise((resolve) => {{ var deadline = Date.now() + {timeout}; (function check() {{ if (document.querySelector({sel})) return resolve(); if (Date.now() > deadline) return resolve(); setTimeout(check, 200); }})(); }});",
                        sel = js_string_lit(sel)
                    ));
                }
            }
            "javascript" => {
                if let Some(script) = &step.script {
                    js_parts.push(script.clone());
                }
            }
            _ => {}
        }
    }

    if js_parts.is_empty() {
        return;
    }

    let full_js = format!("(async () => {{ {} }})();", js_parts.join("\n"));
    let wv = webview.clone();

    // Execute after the page loads — wait for load-changed signal.
    use webkit6::prelude::*;
    wv.connect_load_changed(move |wv, event| {
        if event == webkit6::LoadEvent::Finished {
            let js = full_js.clone();
            wv.evaluate_javascript(&js, None, None, None::<&gtk::gio::Cancellable>, |_| {});
        }
    });
}

fn js_string_lit(s: &str) -> String {
    format!(
        "'{}'",
        s.replace('\\', "\\\\")
            .replace('\'', "\\'")
            .replace('\n', "\\n")
    )
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
    cam_id: &str,
    cam: &crate::bundle::BundleCamera,
    selector: Option<&str>,
    area_fraction: f32,
) -> Option<(gtk::gdk::Paintable, char, Arc<AtomicU8>)> {
    let (uri, desired_badge) = cam.pick_stream(selector, area_fraction)?;
    let decrypt_key = server::load_encrypt_key().or_else(|| server::load_cluster_key());
    let playback_password = cam.playback_password_encrypted.as_ref().and_then(|enc| {
        decrypt_key
            .as_deref()
            .and_then(|k| crate::onvif_events::decrypt_cluster_public(enc, k))
    });
    let key: PoolKey = (cam_id.to_string(), desired_badge);

    let cached = WARM_CAMERAS.with(|w| {
        w.borrow().get(&key).map(|e| {
            (
                e.pipeline.clone(),
                e.paintable.clone(),
                e.stream_status.clone(),
            )
        })
    });
    if let Some((_pipe, paintable, status)) = cached {
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
        return Some((paintable, desired_badge, status));
    }

    let (pipe, sink, last_buffer, status, pipeline_stats, bus_watch) =
        pipeline::create_camera_pipeline(
            &cam.name,
            &uri,
            cam.playback_username.as_deref(),
            playback_password.as_deref(),
        )?;
    let paintable = sink.property::<gtk::gdk::Paintable>("paintable");
    pipeline::play(&pipe);
    let status_clone = status.clone();
    WARM_CAMERAS.with(|w| {
        w.borrow_mut().insert(
            key,
            PipelineEntry {
                _bus_watch: bus_watch,
                pipeline: pipe,
                paintable: paintable.clone(),
                state: WarmthState::Warm,
                cooling_until: None,
                last_buffer_at: last_buffer,
                stream_status: status_clone,
                pipeline_stats,
                first_stall_at: Arc::new(AtomicU64::new(0)),
            },
        );
    });
    info!("warmed pipeline for camera {cam_id} (stream: {desired_badge})");
    Some((paintable, desired_badge, status))
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

fn web_event_meta(
    bundle: &KioskBundle,
    display_id: &str,
    cell: &crate::bundle::BundleCell,
    server_url: &str,
    kiosk_key: &str,
) -> WebEventMeta {
    WebEventMeta {
        server_url: server_url.to_string(),
        kiosk_key: kiosk_key.to_string(),
        tenant_slug: bundle.tenant_slug.clone(),
        kiosk_id: bundle.kiosk_id.clone(),
        display_id: display_id.to_string(),
        view_id: cell.view_id.clone(),
        entity_id: cell.entity_id.clone(),
    }
}

fn report_web_change_for_key(key: &str, url: String) {
    if url.trim().is_empty() {
        return;
    }

    let report = WARM_WEBVIEWS.with(|m| {
        let mut entries = m.borrow_mut();
        let entry = entries.get_mut(key)?;
        if entry.last_reported_url.as_deref() == Some(url.as_str()) {
            return None;
        }
        entry.last_reported_url = Some(url.clone());
        entry.event_meta.clone().map(|meta| (meta, url.clone()))
    });

    if let Some((meta, url)) = report {
        std::thread::spawn(move || {
            server::report_web_change(
                &meta.server_url,
                &meta.kiosk_key,
                &meta.tenant_slug,
                &meta.kiosk_id,
                &meta.display_id,
                meta.view_id.as_deref(),
                meta.entity_id.as_deref(),
                &url,
            );
        });
    }
}

/// Return a WebView for the given pool key, reusing a cached one if present.
/// On reuse, unparent first (GTK4 forbids attaching a widget with an existing
/// parent). On miss, build, load, and insert into the pool as Warm.
fn ensure_web(
    key: WebKey,
    source: WebSource<'_>,
    server_url: &str,
    kiosk_key: &str,
    local_storage: Option<&std::collections::HashMap<String, String>>,
    event_meta: Option<WebEventMeta>,
) -> webkit6::WebView {
    let cached = WARM_WEBVIEWS.with(|m| m.borrow().get(&key).map(|e| e.webview.clone()));
    if let Some(wv) = cached {
        WARM_WEBVIEWS.with(|m| {
            if let Some(e) = m.borrow_mut().get_mut(&key) {
                if e.event_meta != event_meta {
                    e.last_reported_url = None;
                }
                e.event_meta = event_meta.clone();
                if e.state == WarmthState::Cooling {
                    info!("webview {key}: rescued from cooling → warm");
                    e.state = WarmthState::Warm;
                    e.cooling_until = None;
                }
            }
        });
        if let Some(url) = webkit6::prelude::WebViewExt::uri(&wv).map(|s| s.to_string()) {
            report_web_change_for_key(&key, url);
        }
        return wv;
    }

    let wv = webkit6::WebView::new();
    wv.set_vexpand(true);
    wv.set_hexpand(true);
    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    if let Some(settings) = webkit6::prelude::WebViewExt::settings(&wv) {
        settings.set_hardware_acceleration_policy(webkit6::HardwareAccelerationPolicy::Never);
    }
    webkit6::prelude::WebViewExt::set_background_color(
        &wv,
        &gtk::gdk::RGBA::new(0.0, 0.0, 0.0, 1.0),
    );

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

    {
        use webkit6::prelude::*;
        let event_key = key.clone();
        wv.connect_load_changed(move |wv, event| {
            if event == webkit6::LoadEvent::Finished {
                if let Some(url) = wv.uri().map(|s| s.to_string()) {
                    report_web_change_for_key(&event_key, url);
                }
            }
        });
    }

    if let Some(ls) = local_storage {
        if !ls.is_empty() {
            let mut js = String::from("(function(){");
            for (k, v) in ls {
                js.push_str(&format!(
                    "localStorage.setItem({},{});",
                    js_string_lit(k),
                    js_string_lit(v)
                ));
            }
            js.push_str("})();");
            let script = webkit6::UserScript::new(
                &js,
                webkit6::UserContentInjectedFrames::TopFrame,
                webkit6::UserScriptInjectionTime::Start,
                &[],
                &[],
            );
            if let Some(ucm) = webkit6::prelude::WebViewExt::user_content_manager(&wv) {
                ucm.add_script(&script);
            }
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
                event_meta,
                last_reported_url: None,
            },
        );
    });
    info!("warmed webview {key}");
    wv
}

#[cfg(test)]
mod display_tests {
    fn camera_bundle_for_refresh(ciphertext: &str) -> super::KioskBundle {
        serde_json::from_value(serde_json::json!({
            "kiosk_id":"k", "kiosk_name":"Kiosk", "version":"v",
            "cameras":[{"id":"camera", "name":"Camera", "type":"onvif", "stream_policy":"auto",
                "playback_password_encrypted":ciphertext,"onvif_password_encrypted":ciphertext,
                "streams":[
                    {"id":"main","name":"Main","role":"main","rtsp_uri":"rtsp://new/main"},
                    {"id":"sub","name":"Sub","role":"sub","rtsp_uri":"rtsp://new/sub"}
                ]}],
            "displays":[{"id":"d","name":"Display","width_px":800,"height_px":600,
                "idle_timeout_seconds":0,"sleep_timeout_seconds":0,
                "layouts":[{"id":"l","name":"Layout","grid_cols":1,"grid_rows":1,
                    "priority":"normal","is_default":true,"resets_idle_timer":true,
                    "preload_camera_ids":["camera"],"cells":[{
                        "row":0,"col":0,"row_span":1,"col_span":1,"content_type":"web",
                        "web_url":"https://example.test", "smart_url":{"steps":[{
                            "type":"fill","selector":"#password","value_encrypted":ciphertext
                        }]}
                    }]}]}]
        })).unwrap()
    }

    #[test]
    fn randomized_camera_credentials_preserve_render_and_pool_identity() {
        use super::*;
        use aes_gcm::{Aes256Gcm, Nonce, aead::{Aead, KeyInit}};
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
        let key = [42u8; 32];
        let encoded_key = B64.encode(key);
        let encrypt = |iv: [u8; 12], secret: &[u8]| {
            let encrypted = Aes256Gcm::new_from_slice(&key).unwrap()
                .encrypt(Nonce::from_slice(&iv), secret).unwrap();
            let (ciphertext, tag) = encrypted.split_at(encrypted.len() - 16);
            format!("v1.{}.{}.{}", B64.encode(iv), B64.encode(tag), B64.encode(ciphertext))
        };
        let first = camera_bundle_for_refresh(&encrypt([1; 12], b"test-secret"));
        let second = camera_bundle_for_refresh(&encrypt([2; 12], b"test-secret"));
        assert!(first.cameras[0].playback_password_encrypted != second.cameras[0].playback_password_encrypted);
        let previous = render_comparison_bundle(&first, Some(&encoded_key));
        let next = render_comparison_bundle(&second, Some(&encoded_key));
        assert!(crate::core::layout::display_render_unchanged(&previous, &next, "d", Some("l")));
        assert!(crate::core::layout::unchanged_camera_ids(Some(&previous), &next).contains("camera"));
        // Normalization must never replace the cached/rendered transport bundle.
        assert!(second.cameras[0].playback_password_encrypted.as_ref().unwrap().starts_with("v1."));
        let changed = render_comparison_bundle(
            &camera_bundle_for_refresh(&encrypt([3; 12], b"changed-secret")), Some(&encoded_key));
        assert!(!crate::core::layout::display_render_unchanged(&previous, &changed, "d", Some("l")));
        assert!(crate::core::layout::unchanged_camera_ids(Some(&previous), &changed).is_empty());
        let unknown = render_comparison_bundle(&second, None);
        assert!(crate::core::layout::unchanged_camera_ids(Some(&previous), &unknown).is_empty());
        let mut smart_changed = second.clone();
        smart_changed.displays[0].layouts[0].cells[0].smart_url.as_mut().unwrap().steps[0].value_encrypted =
            Some(encrypt([4; 12], b"changed-web-secret"));
        let smart_changed = render_comparison_bundle(&smart_changed, Some(&encoded_key));
        assert!(!crate::core::layout::display_render_unchanged(&previous, &smart_changed, "d", Some("l")));
        assert!(crate::core::layout::unchanged_camera_ids(Some(&previous), &smart_changed).contains("camera"));
        let mut legacy = second.clone();
        legacy.layouts = legacy.displays[0].layouts.clone();
        let normalized_legacy = render_comparison_bundle(&legacy, Some(&encoded_key));
        assert!(normalized_legacy.layouts[0].cells[0].smart_url.as_ref().unwrap().steps[0]
            .value_encrypted.as_ref().unwrap().starts_with("sha256:"));
        let wrong_key = B64.encode([43u8; 32]);
        let unreadable = render_comparison_bundle(&second, Some(&wrong_key));
        assert!(crate::core::layout::unchanged_camera_ids(Some(&previous), &unreadable).is_empty());
    }

    #[test]
    fn rewarming_required_hot_streams_uses_current_camera_and_exact_roles() {
        use super::*;
        let bundle = camera_bundle_for_refresh("opaque");
        let cameras = bundle.cameras.iter().map(|c| (c.id.as_str(), c)).collect();
        let required = std::collections::HashSet::from([
            ("camera".into(), 'M'), ("camera".into(), 'S'), ("removed".into(), 'S'),
        ]);
        let mut warmed = std::collections::HashSet::new();
        // Model a pool emptied by invalidation: every still-required stream
        // must be recreated from current configuration without rendering a grid.
        rewarm_hot_cameras(&required, &cameras, |id, camera, selector| {
            let (uri, badge) = camera.pick_stream(selector, 0.0).unwrap();
            warmed.insert((id.to_string(), badge, uri));
        });
        assert_eq!(warmed, std::collections::HashSet::from([
            ("camera".into(), 'M', "rtsp://new/main".into()),
            ("camera".into(), 'S', "rtsp://new/sub".into()),
        ]));
    }

    #[test]
    #[ignore = "requires a graphical session; run with xvfb-run"]
    fn display_refresh_updates_empty_metadata_and_checks_fullscreen_camera() {
        use super::*;
        gtk::init().unwrap();
        let mut bundle: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id": "k", "kiosk_name": "Before", "version": "1",
            "cameras": [{"id":"outside", "name":"Camera", "type":"rtsp", "stream_policy":"auto",
                "rtsp_url":"rtsp://before/live", "streams":[]}],
            "displays": [{"id":"d", "name":"Before display", "width_px":800,"height_px":600,
                "idle_timeout_seconds":0,"sleep_timeout_seconds":0,
                "layouts":[{"id":"l","name":"Empty","grid_cols":1,"grid_rows":1,
                    "priority":"normal","is_default":true,"resets_idle_timer":true,"cells":[]}]}]
        })).unwrap();
        CURRENT_SYNC_LABEL.with(|s| *s.borrow_mut() = "before sync".into());
        let content = build_empty_display_message(&bundle, Some(&bundle.displays[0]), "Empty layout");
        let reference = content.last_child().unwrap().downcast::<Label>().unwrap();
        bundle.kiosk_name = "After".into();
        bundle.displays[0].name = "After display".into();
        CURRENT_SYNC_LABEL.with(|s| *s.borrow_mut() = "after sync".into());
        refresh_empty_display_reference(&content, &bundle, Some(&bundle.displays[0]));
        assert_eq!(reference.text().as_str(), "Kiosk: After\nDisplay: After display\nLast sync: after sync");
        assert_eq!(content.last_child().unwrap(), reference.upcast::<gtk::Widget>(), "metadata updates in place");

        let mut state = DisplayState {
            window: ApplicationWindow::builder().build(), current_layout_id: Some("l".into()),
            last_activity: Instant::now(), is_asleep: false, content_overlay: gtk::Overlay::new(),
            web_layer: gtk::Fixed::new(), web_positions: Vec::new(), grid_dims: (1,1),
            focus_overrides: HashMap::new(), fullscreen_override: None,
            display_cleared: false, override_generation: 0,
        };
        let mut next = bundle.clone();
        next.cameras[0].rtsp_url = Some("rtsp://after/live".into());
        assert!(can_preserve_display(&state, &bundle, &next, "d"));
        state.fullscreen_override = Some(FocusOverride { camera_id: "outside".into(), stream: "main".into(), generation: 0 });
        assert!(!can_preserve_display(&state, &bundle, &next, "d"));
        assert!(can_preserve_display(&state, &bundle, &bundle, "d"));
        let mut metadata_only = bundle.clone();
        metadata_only.cameras[0].last_seen_at = Some("2026-09-23T22:00:00Z".into());
        metadata_only.cameras[0].labels.push("updated".into());
        assert!(can_preserve_display(&state, &bundle, &metadata_only, "d"));
        next.cameras.clear();
        assert!(!can_preserve_display(&state, &bundle, &next, "d"));
        state.window.close();
    }

    #[test]
    #[ignore = "requires a graphical session; run with xvfb-run"]
    fn layout_animation_restores_tiles_without_frame_ticks() {
        use super::*;
        gtk::init().unwrap();
        let overlay = gtk::Overlay::new();
        let old_grid = Grid::new();
        let new_grid = Grid::new();
        for index in 0..16 {
            let old_tile = Label::new(Some("Old camera"));
            old_tile.set_widget_name(&format!("cam:{index}:auto"));
            old_grid.attach(&old_tile, index % 4, index / 4, 1, 1);
            let new_tile = Label::new(Some("New camera"));
            new_tile.set_widget_name(&format!("cam:{index}:{}", if index == 0 { "main" } else { "auto" }));
            new_grid.attach(&new_tile, index % 4, index / 4, 1, 1);
        }
        overlay.set_child(Some(&old_grid));
        old_grid.allocate(800, 600, -1, None);
        // Deliberately leave the overlay unmapped: idle/timer callbacks run,
        // but animation frame callbacks cannot restore hidden matched tiles.
        animate_layout_swap(&overlay, &new_grid);
        let context = gtk::glib::MainContext::default();
        while context.pending() { context.iteration(false); }
        assert_eq!(new_grid.first_child().unwrap().opacity(), 0.0);
        let deadline = Instant::now() + Duration::from_millis(600);
        while Instant::now() < deadline {
            while context.pending() { context.iteration(false); }
            std::thread::sleep(Duration::from_millis(5));
        }
        let mut child = new_grid.first_child();
        let mut count = 0;
        while let Some(tile) = child {
            assert_eq!(tile.opacity(), 1.0, "{} stayed invisible after cleanup", tile.widget_name());
            count += 1;
            child = tile.next_sibling();
        }
        assert_eq!(count, 16);
        assert_eq!(overlay.first_child().unwrap(), new_grid.clone().upcast::<gtk::Widget>());
        assert!(new_grid.next_sibling().is_none(), "animation overlay must be removed");
    }

    #[test]
    #[ignore = "requires a graphical session; CI runs with xvfb-run"]
    fn sleep_integration_preserves_deadline_and_hides_layout_until_explicit_wake() {
        use super::*;
        gtk::init().unwrap();
        gstreamer::init().unwrap();
        let app = Application::builder()
            .application_id("cloud.betterframe.SleepTest")
            .build();
        app.register(None::<&gtk::gio::Cancellable>).unwrap();
        let pairing = ApplicationWindow::builder().application(&app).build();
        let display = |id: &str| {
            serde_json::json!({
                "id":id, "name":id, "width_px":800, "height_px":600,
                "idle_timeout_seconds":30, "sleep_timeout_seconds":60, "default_layout_id":"layout",
                "layouts":[{"id":"layout", "name":"Layout", "grid_cols":1, "grid_rows":1,
                    "priority":"normal", "is_default":true, "resets_idle_timer":true, "cells":[]}]
            })
        };
        let bundle: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id":"sleep-test", "kiosk_name":"Sleep test", "version":"test", "cameras":[],
            "displays":[display("one"),display("two")]
        }))
        .unwrap();
        render_bundle(&app, &pairing, bundle.clone(), "http://127.0.0.1:1", "test");
        // Xvfb has no window manager to apply the fullscreen request.
        DISPLAYS.with(|ds| {
            for state in ds.borrow().values() {
                state.window.set_default_size(800, 600);
            }
        });
        let deadline_origin = Instant::now() - Duration::from_secs(61);
        DISPLAYS.with(|ds| ds.borrow_mut().get_mut("one").unwrap().last_activity = deadline_origin);
        render_layout_inner("one", "layout", true);
        render_bundle(&app, &pairing, bundle.clone(), "http://127.0.0.1:1", "test");
        DISPLAYS.with(|ds| assert_eq!(ds.borrow()["one"].last_activity, deadline_origin));
        install_idle_watchdog();
        let context = gtk::glib::MainContext::default();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            while context.pending() {
                context.iteration(false);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        DISPLAYS.with(|ds| {
            let ds = ds.borrow();
            assert!(ds["one"].is_asleep);
            assert!(!ds["two"].is_asleep);
            let screen = ds["one"].window.child().unwrap();
            assert!(screen.has_css_class("bf-sleep-screen"));
            assert!(ds["one"].content_overlay.parent().is_none());
            let logo = screen.first_child().unwrap();
            assert!(logo.opacity() > 0.0 && logo.opacity() < 0.1);
            let fixed = screen.downcast::<gtk::Fixed>().unwrap();
            let (x, y) = fixed.child_position(&logo);
            assert!(
                x > 0.0 && y > 0.0,
                "the dim logo must move while visible: x={x}, y={y}, size={}x{}, logo={}x{}",
                fixed.width(),
                fixed.height(),
                logo.width(),
                logo.height()
            );
            let bounds =
                fixed
                    .child_transform(&logo)
                    .unwrap()
                    .transform_bounds(&gtk::graphene::Rect::new(
                        0.0,
                        0.0,
                        logo.width() as f32,
                        logo.height() as f32,
                    ));
            assert!(bounds.x() >= 0.0 && bounds.y() >= 0.0);
            assert!(bounds.x() + bounds.width() <= fixed.width() as f32);
            assert!(bounds.y() + bounds.height() <= fixed.height() as f32);
        });
        render_bundle(&app, &pairing, bundle, "http://127.0.0.1:1", "test");
        render_layout_inner("one", "layout", true);
        DISPLAYS.with(|ds| {
            let ds = ds.borrow();
            assert!(ds["one"].is_asleep);
            assert!(
                ds["one"]
                    .window
                    .child()
                    .unwrap()
                    .has_css_class("bf-sleep-screen")
            );
            assert_eq!(ds["one"].last_activity, deadline_origin);
        });
        // A same-layout command is real activity and must restore visible content.
        render_layout("one", "layout");
        DISPLAYS.with(|ds| {
            let ds = ds.borrow();
            assert!(!ds["one"].is_asleep);
            assert_eq!(
                ds["one"].window.child().unwrap(),
                ds["one"].content_overlay.clone().upcast::<gtk::Widget>()
            );
            assert!(ds["one"].last_activity.elapsed() < Duration::from_secs(2));
        });
        // Terminal authorization must remain visible even on a sleeping kiosk
        // whose configured sleep timeout is shorter than the prompt lifetime.
        standby_display(None);
        show_terminal_code_overlay("123456");
        let prompt_display = TERMINAL_CODE_DISPLAY.with(|id| id.borrow().clone().unwrap());
        let saved_child = TERMINAL_CODE_SAVED_CHILD.with(|saved| saved.borrow().as_ref().unwrap().1.clone());
        DISPLAYS.with(|ds| {
            let mut ds = ds.borrow_mut();
            for (id, st) in ds.iter_mut() {
                if *id == prompt_display {
                    assert!(!st.is_asleep);
                    assert_eq!(st.window.child().unwrap(), st.content_overlay.clone().upcast::<gtk::Widget>());
                    TERMINAL_CODE_WIDGET.with(|code| {
                        assert_eq!(code.borrow().as_ref().unwrap().parent().unwrap(), st.content_overlay.clone().upcast::<gtk::Widget>());
                    });
                    st.last_activity = Instant::now() - Duration::from_secs(61);
                } else {
                    assert!(st.is_asleep, "only the authorization display should wake");
                }
            }
        });
        let deadline = Instant::now() + Duration::from_millis(1200);
        while Instant::now() < deadline {
            while context.pending() { context.iteration(false); }
            std::thread::sleep(Duration::from_millis(10));
        }
        DISPLAYS.with(|ds| assert!(!ds.borrow()[&prompt_display].is_asleep));
        dismiss_terminal_code_overlay();
        assert!(!terminal_prompt_on_display(&prompt_display));
        DISPLAYS.with(|ds| assert_eq!(ds.borrow()[&prompt_display].content_overlay.child().unwrap(), saved_child));
        DISPLAYS.with(|ds| {
            for (_, state) in ds.borrow_mut().drain() {
                state.window.close();
            }
        });
        pairing.close();
    }

    #[test]
    #[ignore = "requires a graphical session; CI runs with xvfb-run"]
    fn pairing_health_confirmation_waits_for_a_mapped_frame() {
        use super::*;
        gtk::init().unwrap();
        let app = Application::builder().application_id("cloud.betterframe.PairingHealthTest").build();
        app.register(None::<&gtk::gio::Cancellable>).unwrap();
        let window = ApplicationWindow::builder().application(&app).build();
        let confirmations = std::rc::Rc::new(std::cell::Cell::new(0));
        let observed = confirmations.clone();
        render_startup_status(&window, "Starting kiosk", false, move || observed.set(observed.get() + 1));
        let context = gtk::glib::MainContext::default();
        window.present();
        let until = Instant::now() + Duration::from_millis(300);
        while Instant::now() < until {
            while context.pending() { context.iteration(false); }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(confirmations.get(), 0, "a rendered logo cannot confirm worker initialization");
        window.set_visible(false);
        let observed = confirmations.clone();
        render_startup_status(&window, "Regional server unavailable — retrying with saved enrollment", true,
            move || observed.set(observed.get() + 1));
        let until = Instant::now() + Duration::from_millis(100);
        while Instant::now() < until {
            while context.pending() { context.iteration(false); }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(confirmations.get(), 0, "an unmapped startup/pairing UI is not healthy yet");
        window.present();
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            while context.pending() { context.iteration(false); }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(confirmations.get(), 1);
        window.close();
    }

    use super::{FocusOverride, operator_target_cell, parse_drm_mode};
    use std::collections::HashMap;

    #[test]
    fn parses_only_valid_drm_modes() {
        assert_eq!(parse_drm_mode("1920x1080\n"), Some((1920, 1080)));
        assert_eq!(parse_drm_mode("0x1080"), None);
        assert_eq!(parse_drm_mode("unknown"), None);
    }

    #[test]
    fn first_empty_skips_content_and_active_overrides() {
        let layout = serde_json::from_value(serde_json::json!({
            "id":"layout","name":"Layout","grid_cols":3,"grid_rows":1,
            "priority":"normal","cooling_timeout_seconds":null,
            "idle_timeout_seconds":null,"is_default":true,"resets_idle_timer":true,
            "cells":[
                {"view_id":"web","entity_id":null,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"web","camera_id":null,"stream_selector":null,"web_url":"https://example.test","html_content":null,"cooling_timeout_seconds":null},
                {"view_id":"used","entity_id":null,"row":0,"col":1,"row_span":1,"col_span":1,"content_type":"none","camera_id":null,"stream_selector":null,"web_url":null,"html_content":null,"cooling_timeout_seconds":null},
                {"view_id":"empty","entity_id":null,"row":0,"col":2,"row_span":1,"col_span":1,"content_type":"none","camera_id":null,"stream_selector":null,"web_url":null,"html_content":null,"cooling_timeout_seconds":null}
            ]
        })).unwrap();
        let overrides = HashMap::from([(
            "used".to_string(),
            FocusOverride {
                camera_id: "camera".to_string(),
                stream: "main".to_string(),
                generation: 1,
            },
        )]);

        assert_eq!(
            operator_target_cell(&layout, None, &overrides).as_deref(),
            Some("empty")
        );
        assert_eq!(
            operator_target_cell(&layout, Some("web"), &overrides).as_deref(),
            Some("web")
        );
    }
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
    let blank = gtk::gdk::Cursor::from_name("none", None);
    window.set_cursor(blank.as_ref());
}

fn build_logo_content(action: &str) -> gtk::Widget {
    let vbox = GtkBox::new(Orientation::Vertical, 24);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);
    vbox.append(&logo_picture(BETTERFRAME_LOGO_PNG, 480, 118, "idle-logo"));
    vbox.append(&spinner(36));

    let (mac, ip) = server::startup_network_summary();
    let status = Label::new(Some(&format!("IP: {ip}\nMAC: {mac}\nAction: {action}")));
    status.set_xalign(0.0);
    add_css(
        &status,
        ".startup-status { font-size: 13px; color: #777; font-family: monospace; }",
    );
    status.add_css_class("startup-status");
    vbox.append(&status);

    let fw_ver = server::kiosk_app_version();
    let os_ver =
        std::fs::read_to_string("/etc/betterframe/os-version").unwrap_or_else(|_| "unknown".into());
    let ver_text = format!("FW: {}  OS: {}", fw_ver, os_ver.trim());
    let ver_label = Label::new(Some(&ver_text));
    add_css(
        &ver_label,
        ".ver { font-size: 11px; color: #555; margin: 8px; }",
    );
    ver_label.add_css_class("ver");
    ver_label.set_halign(gtk::Align::Start);
    ver_label.set_valign(gtk::Align::End);

    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&vbox));
    overlay.add_overlay(&ver_label);
    overlay.upcast()
}

fn show_logo(window: &ApplicationWindow) {
    show_startup_status(window, "Starting kiosk");
}

fn show_startup_status(window: &ApplicationWindow, action: &str) {
    render_startup_status(window, action, false, firmware::mark_firmware_applied);
}

fn show_ready_startup_status(window: &ApplicationWindow, action: &str) {
    render_startup_status(window, action, true, firmware::mark_firmware_applied);
}

fn render_startup_status(
    window: &ApplicationWindow,
    action: &str,
    worker_ready: bool,
    confirm: impl Fn() + 'static,
) {
    window.set_child(Some(&build_logo_content(action)));
    // Only the worker can report a known-live retry state. The initial logo and
    // generic progress messages do not prove initialization succeeded.
    if worker_ready {
        after_rendered_frame(window, confirm);
    }
}

fn build_empty_display_reference(
    bundle: &KioskBundle,
    display: Option<&BundleDisplayWithLayouts>,
) -> gtk::Widget {
    build_empty_display_message(bundle, display, crate::core::layout::NO_LAYOUTS_ASSIGNED_MESSAGE)
}

fn empty_display_reference_text(bundle: &KioskBundle, display: Option<&BundleDisplayWithLayouts>) -> String {
    let last_sync = CURRENT_SYNC_LABEL.with(|s| s.borrow().clone());
    format!("Kiosk: {}\nDisplay: {}\nLast sync: {}",
        bundle.kiosk_name, display.map(|d| d.name.as_str()).unwrap_or("This display"), last_sync)
}

/// Update diagnostics in-place without rebuilding a preserved empty layout.
fn refresh_empty_display_reference(content: &gtk::Widget, bundle: &KioskBundle, display: Option<&BundleDisplayWithLayouts>) {
    if !content.has_css_class("bf-unassigned-display") { return; }
    let mut child = content.first_child();
    while let Some(widget) = child {
        if widget.has_css_class("empty-reference") {
            if let Some(label) = widget.downcast_ref::<Label>() {
                label.set_label(&empty_display_reference_text(bundle, display));
            }
        }
        child = widget.next_sibling();
    }
}

fn build_empty_display_message(
    bundle: &KioskBundle,
    display: Option<&BundleDisplayWithLayouts>,
    message: &str,
) -> gtk::Widget {
    let overlay = gtk::Overlay::new();
    add_css(&overlay, ".bf-unassigned-display { background-color: #000; }");
    overlay.add_css_class("bf-unassigned-display");
    overlay.set_vexpand(true);
    overlay.set_hexpand(true);

    let vbox = GtkBox::new(Orientation::Vertical, 24);
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);
    vbox.append(&logo_picture(BETTERFRAME_LOGO_PNG, 480, 118, "idle-logo"));
    let instruction = Label::new(Some(message));
    instruction.set_wrap(true);
    instruction.set_justify(gtk::Justification::Center);
    instruction.set_max_width_chars(64);
    instruction.set_margin_start(24);
    instruction.set_margin_end(24);
    add_css(&instruction, ".assignment-instruction { color: #fff; font-size: 22px; }");
    instruction.add_css_class("assignment-instruction");
    vbox.append(&instruction);
    overlay.set_child(Some(&vbox));

    let info = Label::new(Some(&empty_display_reference_text(bundle, display)));
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

    overlay.upcast()
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
    add_css(
        &name_label,
        "label { font-size: 14px; color: #c33; font-weight: 600; }",
    );
    vbox.append(&name_label);

    let reason_label = Label::new(Some(reason));
    add_css(
        &reason_label,
        "label { font-size: 12px; color: #666; margin-top: 4px; }",
    );
    vbox.append(&reason_label);

    let retry_label = Label::new(Some("Retries on next layout render"));
    add_css(
        &retry_label,
        "label { font-size: 10px; color: #444; margin-top: 8px; }",
    );
    vbox.append(&retry_label);

    vbox.upcast()
}

fn placeholder(text: Option<&str>) -> gtk::Widget {
    let vbox = GtkBox::new(Orientation::Vertical, 8);
    add_css(
        &vbox,
        ".bf-placeholder { background-color: #000; } .bf-placeholder-text { color: #666; font-size: 14px; }",
    );
    vbox.add_css_class("bf-placeholder");
    vbox.set_valign(gtk::Align::Center);
    vbox.set_halign(gtk::Align::Center);
    vbox.set_vexpand(true);
    vbox.set_hexpand(true);
    vbox.append(&logo_picture(BETTERFRAME_MARK_PNG, 56, 56, "cell-logo"));
    if let Some(text) = text {
        let label = Label::new(Some(text));
        label.add_css_class("bf-placeholder-text");
        vbox.append(&label);
    }
    vbox.upcast()
}

fn web_spacer() -> gtk::Widget {
    let bx = GtkBox::new(Orientation::Vertical, 0);
    bx.set_vexpand(true);
    bx.set_hexpand(true);
    bx.upcast()
}

fn hide_all_webviews(web_layer: &gtk::Fixed) {
    WARM_WEBVIEWS.with(|m| {
        for entry in m.borrow().values() {
            if entry.webview.parent().as_ref() == Some(web_layer.upcast_ref::<gtk::Widget>()) {
                entry.webview.set_visible(false);
            }
        }
    });
}

fn schedule_webview_positions(display_id: &str) {
    let did = display_id.to_string();
    gtk::glib::idle_add_local_once(move || {
        let ok = apply_webview_positions(&did);
        if !ok {
            let did2 = did.clone();
            gtk::glib::timeout_add_local_once(Duration::from_millis(50), move || {
                apply_webview_positions(&did2);
            });
        }
    });
}

fn apply_webview_positions(display_id: &str) -> bool {
    if is_terminal_overlay_active() {
        return true;
    }
    DISPLAYS.with(|ds| {
        let ds = ds.borrow();
        let Some(st) = ds.get(display_id) else {
            return true;
        };

        let width = st.window.allocated_width();
        let height = st.window.allocated_height();
        if width == 0 || height == 0 {
            return false;
        }

        let (grid_cols, grid_rows) = st.grid_dims;
        if grid_cols == 0 || grid_rows == 0 {
            return true;
        }

        let active_keys: std::collections::HashSet<&str> =
            st.web_positions.iter().map(|p| p.key.as_str()).collect();

        WARM_WEBVIEWS.with(|m| {
            let pool = m.borrow();

            for pos in &st.web_positions {
                let Some(entry) = pool.get(&pos.key) else {
                    continue;
                };
                let x = (pos.col as f64 / grid_cols as f64) * width as f64;
                let y = (pos.row as f64 / grid_rows as f64) * height as f64;
                let w = (pos.col_span as f64 / grid_cols as f64) * width as f64;
                let h = (pos.row_span as f64 / grid_rows as f64) * height as f64;

                entry.webview.set_size_request(w as i32, h as i32);

                if entry.webview.parent().as_ref() == Some(st.web_layer.upcast_ref::<gtk::Widget>())
                {
                    st.web_layer.move_(&entry.webview, x, y);
                } else {
                    if entry.webview.parent().is_some() {
                        entry.webview.unparent();
                    }
                    st.web_layer.put(&entry.webview, x, y);
                }
                entry.webview.set_visible(true);
            }

            for (key, entry) in pool.iter() {
                if !active_keys.contains(key.as_str()) {
                    if entry.webview.parent().as_ref()
                        == Some(st.web_layer.upcast_ref::<gtk::Widget>())
                    {
                        entry.webview.set_visible(false);
                    }
                }
            }
        });
        true
    })
}

fn logo_picture(png: &'static [u8], width: i32, height: i32, css_class: &str) -> gtk::Widget {
    let texture = (|| {
        let loader = gdk_pixbuf::PixbufLoader::with_type("png")?;
        loader.set_size(width, height);
        loader.write(png)?;
        loader.close()?;
        loader
            .pixbuf()
            .map(|pixbuf| gtk::gdk::Texture::for_pixbuf(&pixbuf))
            .ok_or_else(|| {
                gtk::glib::Error::new(gtk::glib::FileError::Failed, "SVG decoded without pixels")
            })
    })();
    match texture {
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
            warn!("failed to load embedded PNG logo: {err}");
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
    static TERMINAL_CODE_SAVED_CHILD: RefCell<Option<(String, gtk::Widget)>> = const { RefCell::new(None) };
    static TERMINAL_OVERLAY_ACTIVE: Cell<bool> = const { Cell::new(false) };
    static TERMINAL_CODE_DISPLAY: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn is_terminal_overlay_active() -> bool {
    TERMINAL_OVERLAY_ACTIVE.with(|a| a.get())
}

fn terminal_prompt_on_display(display_id: &str) -> bool {
    TERMINAL_CODE_DISPLAY.with(|id| id.borrow().as_deref() == Some(display_id))
}

fn show_terminal_code_overlay(code: &str) {
    dismiss_terminal_code_overlay();

    let display_id = DISPLAYS.with(|ds| ds.borrow().keys().next().cloned());
    let Some(display_id) = display_id else { return };

    // Physical-presence authorization must be visible even from standby.
    wake_display(Some(&display_id));
    TERMINAL_CODE_DISPLAY.with(|id| *id.borrow_mut() = Some(display_id.clone()));
    DISPLAYS.with(|ds| {
        let ds = ds.borrow();
        let Some(st) = ds.get(&display_id) else { return };

        let old_child = st.content_overlay.child();
        if let Some(ref c) = old_child {
            TERMINAL_CODE_SAVED_CHILD.with(|s| *s.borrow_mut() = Some((display_id.clone(), c.clone())));
        }

        let vbox = GtkBox::new(Orientation::Vertical, 20);
        vbox.set_valign(gtk::Align::Center);
        vbox.set_halign(gtk::Align::Center);
        vbox.set_vexpand(true);
        vbox.set_hexpand(true);

        let warning = Label::new(Some("⚠  REMOTE TERMINAL ACCESS  ⚠"));
        add_css(&warning, ".term-warn { font-size: 20px; color: #ff4444; font-weight: 700; letter-spacing: 2px; }");
        warning.add_css_class("term-warn");

        let logo = logo_picture(BETTERFRAME_LOGO_PNG, 360, 88, "terminal-logo");

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
        st.content_overlay.set_child(Some(&vbox));
        hide_all_webviews(&st.web_layer);
        st.web_layer.set_visible(false);

        TERMINAL_CODE_WIDGET.with(|w| *w.borrow_mut() = Some(vbox.upcast()));
        TERMINAL_OVERLAY_ACTIVE.with(|a| a.set(true));

        let remaining = std::rc::Rc::new(Cell::new(60u32));
        let tl = timeout_label.clone();
        let r = remaining.clone();
        gtk::glib::timeout_add_local(Duration::from_secs(1), move || {
            if !TERMINAL_OVERLAY_ACTIVE.with(|a| a.get()) {
                return gtk::glib::ControlFlow::Break;
            }
            let left = r.get().saturating_sub(1);
            r.set(left);
            tl.set_text(&format!("Code expires in {left} seconds"));
            if left == 0 {
                dismiss_terminal_code_overlay();
                return gtk::glib::ControlFlow::Break;
            }
            gtk::glib::ControlFlow::Continue
        });
    });
}

fn dismiss_terminal_code_overlay() {
    TERMINAL_CODE_DISPLAY.with(|id| *id.borrow_mut() = None);
    TERMINAL_OVERLAY_ACTIVE.with(|a| a.set(false));
    TERMINAL_CODE_WIDGET.with(|w| {
        if w.borrow().is_none() {
            return;
        }
        *w.borrow_mut() = None;
    });
    TERMINAL_CODE_SAVED_CHILD.with(|s| {
        if let Some((display_id, child)) = s.borrow_mut().take() {
            DISPLAYS.with(|ds| {
                let ds = ds.borrow();
                if let Some(st) = ds.get(&display_id) {
                    st.web_layer.set_visible(true);
                    st.content_overlay.set_child(Some(&child));
                    schedule_webview_positions(&display_id);
                }
            });
        }
    });
}

// ---- Update progress banner -------------------------------------------------

thread_local! {
    static UPDATE_BANNER_LABEL: RefCell<Option<Label>> = RefCell::new(None);
}

fn show_update_banner(progress: Option<(String, u8)>) {
    match progress {
        Some((text, pct)) => {
            let msg = format!("{text} — {pct}%");
            UPDATE_BANNER_LABEL.with(|b| {
                let existing = b.borrow();
                if let Some(label) = existing.as_ref() {
                    if label.parent().is_some() {
                        label.set_text(&msg);
                        return;
                    }
                }
                drop(existing);

                let label = Label::new(Some(&msg));
                add_css(&label, ".update-banner { font-size: 12px; color: #fff; background: rgba(0,0,0,0.75); padding: 6px 14px; border-radius: 4px; margin: 8px; }");
                label.add_css_class("update-banner");
                label.set_halign(gtk::Align::Start);
                label.set_valign(gtk::Align::End);

                DISPLAYS.with(|ds| {
                    let ds = ds.borrow();
                    for (_, st) in ds.iter() {
                        st.content_overlay.add_overlay(&label);
                        return;
                    }
                });
                *b.borrow_mut() = Some(label);
            });
        }
        None => {
            UPDATE_BANNER_LABEL.with(|b| {
                if let Some(label) = b.borrow().as_ref() {
                    if label.parent().is_some() {
                        label.unparent();
                    }
                }
                *b.borrow_mut() = None;
            });
        }
    }
}
