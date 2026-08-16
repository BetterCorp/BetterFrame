use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

use futures_util::{SinkExt, StreamExt};
use gstreamer::prelude::*;
use gstreamer_video::prelude::*;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use windows_sys::Win32::Foundation::{
    BOOL, COLORREF, HWND, LPARAM, LRESULT, LocalFree, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreatePen, CreateSolidBrush, DT_CENTER, DT_LEFT, DT_SINGLELINE, DT_TOP, DT_VCENTER,
    DeleteObject, DrawTextW, EndPaint, EnumDisplayMonitors, FillRect, GetMonitorInfoW, HBRUSH, HDC,
    InvalidateRect, LineTo, MONITORINFOEXW, MoveToEx, PAINTSTRUCT, PS_SOLID, SelectObject,
    SetBkMode, SetTextColor, UpdateWindow,
};
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CryptProtectData, CryptUnprotectData,
};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DispatchMessageW,
    GetClientRect, GetMessageW, GetSystemMetrics, HMENU, HWND_BROADCAST, MSG, PostQuitMessage,
    RegisterClassW, SC_MONITORPOWER, SM_CXSCREEN, SM_CYSCREEN, SW_SHOWMAXIMIZED, SendMessageW,
    ShowWindow, TranslateMessage, WM_DESTROY, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_PAINT, WM_SYSCOMMAND, WNDCLASSW, WS_EX_TOPMOST, WS_POPUP,
};

const DEFAULT_SERVER_URL: &str = "http://localhost";
const AGENT_TASK_NAME: &str = "BetterFrameWindowsAgent";
const APP_TASK_NAME: &str = "BetterFrameWindowsApp";
const PROTECTED_MAGIC: &[u8; 4] = b"BFW1";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowsPolicy {
    #[serde(default)]
    controls: WindowsControls,
    #[serde(default)]
    displays: WindowsDisplayPolicy,
}

impl Default for WindowsPolicy {
    fn default() -> Self {
        Self {
            controls: WindowsControls::default(),
            displays: WindowsDisplayPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowsControls {
    #[serde(default)]
    display_power: bool,
    #[serde(default)]
    host_sleep_wake: bool,
    #[serde(default)]
    volume: bool,
    #[serde(default)]
    host_reboot: bool,
    #[serde(default = "default_true")]
    app_restart: bool,
}

impl Default for WindowsControls {
    fn default() -> Self {
        Self {
            display_power: false,
            host_sleep_wake: false,
            volume: false,
            host_reboot: false,
            app_restart: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WindowsDisplayPolicy {
    #[serde(default = "default_display_mode")]
    mode: String,
    #[serde(default)]
    selected_display_names: Vec<String>,
}

impl Default for WindowsDisplayPolicy {
    fn default() -> Self {
        Self {
            mode: default_display_mode(),
            selected_display_names: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ClientState {
    server_url: String,
    kiosk_key: Option<String>,
    #[serde(default)]
    encrypt_key: Option<String>,
    kiosk_id: Option<String>,
    kiosk_name: Option<String>,
    bundle_version: Option<String>,
    #[serde(default)]
    managed_config_applied_version: u64,
    #[serde(default)]
    managed_config_error: Option<String>,
    active_layouts: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct PairInitiateResponse {
    code: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct PairClaimResponse {
    status: String,
    kiosk_id: Option<serde_json::Value>,
    kiosk_name: Option<String>,
    kiosk_key: Option<String>,
    encrypt_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HeartbeatResponse {
    pending_config: Option<PendingConfig>,
}

#[derive(Debug, Deserialize)]
struct PendingConfig {
    version: u64,
    config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KioskBundle {
    kiosk_id: String,
    kiosk_name: String,
    displays: Vec<BundleDisplay>,
    #[serde(default)]
    cameras: Vec<BundleCamera>,
    version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BundleDisplay {
    id: String,
    name: String,
    default_layout_id: Option<String>,
    layouts: Vec<BundleLayout>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BundleLayout {
    id: String,
    name: String,
    grid_cols: u32,
    grid_rows: u32,
    cells: Vec<BundleCell>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BundleCell {
    view_id: Option<String>,
    entity_id: Option<String>,
    row: u32,
    col: u32,
    row_span: u32,
    col_span: u32,
    content_type: String,
    camera_id: Option<String>,
    stream_selector: Option<String>,
    web_url: Option<String>,
    html_content: Option<String>,
    #[serde(default)]
    input_options: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BundleCamera {
    id: String,
    name: String,
    #[serde(default)]
    playback_username: Option<String>,
    #[serde(default)]
    playback_password_encrypted: Option<String>,
    #[serde(default)]
    streams: Vec<BundleStream>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BundleStream {
    role: String,
    rtsp_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DisplayReport {
    index: usize,
    name: String,
    width_px: u32,
    height_px: u32,
    power_state: String,
}

#[derive(Clone)]
struct NativeDisplay {
    report: DisplayReport,
    rect: RECT,
}

#[derive(Debug, Clone)]
struct WindowState {
    display_id: String,
    mouse_down: Option<MouseDown>,
}

#[derive(Debug, Clone)]
struct MouseDown {
    at: Instant,
}

static WINDOWS: OnceLock<Mutex<HashMap<isize, WindowState>>> = OnceLock::new();

struct CameraPipeline {
    pipeline: gstreamer::Pipeline,
    overlay: gstreamer_video::VideoOverlay,
}

static CAMERA_PIPELINES: OnceLock<Mutex<HashMap<String, CameraPipeline>>> = OnceLock::new();

#[derive(Debug)]
enum AgentCommand {
    ReloadBundle,
    SwitchLayout {
        display_id: Option<String>,
        layout_id: String,
    },
    // SC_MONITORPOWER is host-global; per-display power needs DDC/CI later.
    Standby,
    Wake,
    VolumeSet(u32),
    VolumeMute(bool),
    Reboot,
}

fn default_true() -> bool {
    true
}

fn default_display_mode() -> String {
    "all".to_string()
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("info".parse().unwrap()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    let result = match args.get(1).map(|s| s.as_str()) {
        Some("agent") => run_agent_cli(&args[2..]),
        Some("app") => run_app(),
        Some("install") => install_tasks(&args[2..]),
        Some("uninstall") => uninstall_tasks(),
        _ => {
            eprintln!("Usage:");
            eprintln!("  betterframe-windows-client agent [--server URL]");
            eprintln!("  betterframe-windows-client app");
            eprintln!("  betterframe-windows-client install [--server URL]");
            eprintln!("  betterframe-windows-client uninstall");
            Ok(())
        }
    };

    if let Err(err) = result {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run_agent_cli(args: &[String]) -> Result<(), String> {
    let server = arg_value(args, "--server")
        .unwrap_or_else(|| load_state().server_url)
        .trim()
        .trim_end_matches('/')
        .to_string();
    let server = if server.is_empty() {
        DEFAULT_SERVER_URL.to_string()
    } else {
        server
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    rt.block_on(run_agent(server))
}

async fn run_agent(server_url: String) -> Result<(), String> {
    fs::create_dir_all(state_dir()).map_err(|e| format!("create state dir: {e}"))?;
    ensure_default_policy()?;

    let mut state = load_state();
    state.server_url = server_url;
    save_state(&state)?;

    if state.kiosk_key.is_none() {
        state = pair(&state.server_url).await?;
        save_state(&state)?;
    }

    let policy = Arc::new(Mutex::new(load_policy()));
    let state = Arc::new(Mutex::new(state));
    let app = Arc::new(Mutex::new(None::<Child>));
    start_app(&app)?;

    let (tx, mut rx) = mpsc::unbounded_channel::<AgentCommand>();
    {
        let state = state.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            loop {
                let snapshot = state.lock().unwrap().clone();
                if let (Some(key), server) =
                    (snapshot.kiosk_key.clone(), snapshot.server_url.clone())
                {
                    if let Err(err) = websocket_loop(&server, &key, tx.clone()).await {
                        warn!("ws disconnected: {err}");
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                let snapshot = state.lock().unwrap().clone();
                if let Some(key) = snapshot.kiosk_key.as_deref() {
                    match heartbeat(&snapshot.server_url, key, &snapshot).await {
                        Ok(next) => {
                            let _ = save_state(&next);
                            *state.lock().unwrap() = next;
                        }
                        Err(err) => warn!("heartbeat failed: {err}"),
                    }
                }
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        });
    }
    {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                let snapshot = state.lock().unwrap().clone();
                if let Some(key) = snapshot.kiosk_key.as_deref() {
                    match fetch_bundle(&snapshot.server_url, key).await {
                        Ok(bundle) => {
                            let mut next = snapshot.clone();
                            next.kiosk_id = Some(bundle.kiosk_id.clone());
                            next.kiosk_name = Some(bundle.kiosk_name.clone());
                            next.bundle_version = Some(bundle.version.clone());
                            for display in &bundle.displays {
                                if let Some(layout_id) = display
                                    .default_layout_id
                                    .clone()
                                    .or_else(|| display.layouts.first().map(|l| l.id.clone()))
                                {
                                    next.active_layouts
                                        .entry(display.id.clone())
                                        .or_insert(layout_id);
                                }
                            }
                            let _ = save_bundle(&bundle);
                            let _ = save_state(&next);
                            *state.lock().unwrap() = next;
                        }
                        Err(err) => warn!("bundle fetch failed: {err}"),
                    }
                }
                tokio::time::sleep(Duration::from_secs(20)).await;
            }
        });
    }

    let mut last_supervise = Instant::now();
    loop {
        tokio::select! {
            Some(cmd) = rx.recv() => {
                if let Err(err) = handle_agent_command(cmd, &state, &policy, &app).await {
                    warn!("command failed: {err}");
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(2)) => {
                if last_supervise.elapsed() >= Duration::from_secs(10) {
                    supervise_app(&app)?;
                    last_supervise = Instant::now();
                }
            }
        }
    }
}

async fn pair(server_url: &str) -> Result<ClientState, String> {
    let client = reqwest::Client::new();
    let init: PairInitiateResponse = client
        .post(format!("{server_url}/api/pair/initiate"))
        .json(&serde_json::json!({
            "proposed_name": hostname::get().ok().and_then(|h| h.into_string().ok()).unwrap_or_else(|| "Windows Kiosk".to_string()),
            "hardware_model": "Windows Desktop",
            "firmware_target": "windows-x64",
            "capabilities": ["windows", "desktop_app", "rtsp", "d3d11", "mouse", "keyboard", "app_restart", "display_select"],
            "managed_image": false
        }))
        .send()
        .await
        .map_err(|e| format!("pair initiate: {e}"))?
        .json()
        .await
        .map_err(|e| format!("pair initiate response: {e}"))?;

    println!("BetterFrame Windows pairing code: {}", init.code);
    println!("Enter it in admin before it expires at {}", init.expires_at);

    loop {
        let resp = client
            .post(format!("{server_url}/api/pair/claim"))
            .json(&serde_json::json!({ "code": init.code }))
            .send()
            .await
            .map_err(|e| format!("pair claim: {e}"))?;
        if resp.status().as_u16() == 200 {
            let claim: PairClaimResponse = resp
                .json()
                .await
                .map_err(|e| format!("pair claim response: {e}"))?;
            if claim.status == "claimed" {
                return Ok(ClientState {
                    server_url: server_url.to_string(),
                    kiosk_key: claim.kiosk_key,
                    encrypt_key: claim.encrypt_key,
                    kiosk_id: claim.kiosk_id.map(flexible_id),
                    kiosk_name: claim.kiosk_name,
                    bundle_version: None,
                    managed_config_applied_version: 0,
                    managed_config_error: None,
                    active_layouts: HashMap::new(),
                });
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn websocket_loop(
    server_url: &str,
    key: &str,
    tx: mpsc::UnboundedSender<AgentCommand>,
) -> Result<(), String> {
    let ws_url = build_ws_url(server_url, key);
    let (ws, _) = connect_async(&ws_url)
        .await
        .map_err(|e| format!("connect {ws_url}: {e}"))?;
    info!("connected to coordinator");
    let (mut writer, mut reader) = ws.split();
    while let Some(msg) = reader.next().await {
        let msg = msg.map_err(|e| format!("ws read: {e}"))?;
        let Message::Text(text) = msg else { continue };
        if text.contains("\"type\":\"ping\"") {
            let _ = writer
                .send(Message::Text(r#"{"type":"pong"}"#.to_string()))
                .await;
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match parsed.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "reload-bundle" => {
                let _ = tx.send(AgentCommand::ReloadBundle);
            }
            "layout-switch" => {
                if let Some(layout_id) = parsed.get("layout_id").map(flexible_id_ref) {
                    let display_id = parsed.get("display_id").map(flexible_id_ref);
                    let _ = tx.send(AgentCommand::SwitchLayout {
                        display_id,
                        layout_id,
                    });
                }
            }
            "standby" => {
                let _ = tx.send(AgentCommand::Standby);
            }
            "wake" => {
                let _ = tx.send(AgentCommand::Wake);
            }
            "volume-set" => {
                if let Some(v) = parsed.get("volume").and_then(|v| v.as_u64()) {
                    let _ = tx.send(AgentCommand::VolumeSet(v.min(100) as u32));
                }
            }
            "volume-mute" => {
                let muted = parsed
                    .get("muted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let _ = tx.send(AgentCommand::VolumeMute(muted));
            }
            "reboot" => {
                let _ = tx.send(AgentCommand::Reboot);
            }
            _ => {}
        }
    }
    Ok(())
}

async fn handle_agent_command(
    cmd: AgentCommand,
    state: &Arc<Mutex<ClientState>>,
    _policy: &Arc<Mutex<WindowsPolicy>>,
    app: &Arc<Mutex<Option<Child>>>,
) -> Result<(), String> {
    let current_policy = load_policy();
    match cmd {
        AgentCommand::ReloadBundle => {
            let snapshot = state.lock().unwrap().clone();
            if let Some(key) = snapshot.kiosk_key.as_deref() {
                let bundle = fetch_bundle(&snapshot.server_url, key).await?;
                save_bundle(&bundle)?;
                let mut next = snapshot;
                next.bundle_version = Some(bundle.version);
                save_state(&next)?;
                *state.lock().unwrap() = next;
            }
        }
        AgentCommand::SwitchLayout {
            display_id,
            layout_id,
        } => {
            let mut next = state.lock().unwrap().clone();
            if let Some(display_id) = display_id {
                next.active_layouts
                    .insert(display_id.clone(), layout_id.clone());
                report_layout_change(
                    &next.server_url,
                    next.kiosk_key.as_deref(),
                    &display_id,
                    &layout_id,
                )
                .await;
            } else if let Some(bundle) = load_bundle() {
                if let Some(display) = bundle
                    .displays
                    .iter()
                    .find(|d| d.layouts.iter().any(|l| l.id == layout_id))
                {
                    next.active_layouts
                        .insert(display.id.clone(), layout_id.clone());
                    report_layout_change(
                        &next.server_url,
                        next.kiosk_key.as_deref(),
                        &display.id,
                        &layout_id,
                    )
                    .await;
                }
            }
            save_state(&next)?;
            *state.lock().unwrap() = next;
            invalidate_app_windows();
        }
        AgentCommand::Standby => {
            if current_policy.controls.display_power {
                set_monitor_power(false);
            } else {
                info!("display standby ignored by Windows policy");
            }
        }
        AgentCommand::Wake => {
            if current_policy.controls.display_power {
                set_monitor_power(true);
            } else {
                info!("display wake ignored by Windows policy");
            }
        }
        AgentCommand::VolumeSet(v) => {
            if current_policy.controls.volume {
                set_volume_percent(v);
            } else {
                info!("volume set ignored by Windows policy");
            }
        }
        AgentCommand::VolumeMute(muted) => {
            if current_policy.controls.volume {
                set_mute(muted);
            } else {
                info!("volume mute ignored by Windows policy");
            }
        }
        AgentCommand::Reboot => {
            if current_policy.controls.host_reboot {
                let _ = Command::new("shutdown").args(["/r", "/t", "5"]).spawn();
            } else if current_policy.controls.app_restart {
                // Host reboot not permitted — degrade to restarting the app.
                restart_app(app)?;
            } else {
                info!("reboot ignored by Windows policy");
            }
        }
    }
    Ok(())
}

async fn fetch_bundle(server_url: &str, key: &str) -> Result<KioskBundle, String> {
    reqwest::Client::new()
        .get(format!("{server_url}/api/kiosk/bundle"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("bundle request: {e}"))?
        .json::<KioskBundle>()
        .await
        .map_err(|e| format!("bundle response: {e}"))
}

async fn heartbeat(
    server_url: &str,
    key: &str,
    state: &ClientState,
) -> Result<ClientState, String> {
    let displays = query_displays();
    let resp = reqwest::Client::new()
        .post(format!("{server_url}/api/kiosk/heartbeat"))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "bundle_version": state.bundle_version.as_deref(),
            "kiosk_app_version": env!("CARGO_PKG_VERSION"),
            "firmware_target": "windows-x64",
            "os_version": std::env::consts::OS,
            "os_update_compatibility": "windows-desktop",
            "displays": displays,
            "reported_hostname": hostname::get().ok().and_then(|h| h.into_string().ok()),
            "network_interfaces": [],
            "managed_config_applied_version": state.managed_config_applied_version,
            "managed_config_error": state.managed_config_error,
        }))
        .send()
        .await
        .map_err(|e| format!("heartbeat request: {e}"))?;
    let body = resp
        .json::<HeartbeatResponse>()
        .await
        .map_err(|e| format!("heartbeat response: {e}"))?;
    let mut next = state.clone();
    if let Some(pending) = body.pending_config {
        match apply_pending_config(&pending) {
            Ok(()) => {
                next.managed_config_applied_version = pending.version;
                next.managed_config_error = None;
            }
            Err(err) => {
                next.managed_config_error = Some(err);
            }
        }
    }
    Ok(next)
}

async fn report_layout_change(
    server_url: &str,
    key: Option<&str>,
    display_id: &str,
    layout_id: &str,
) {
    let Some(key) = key else { return };
    let _ = reqwest::Client::new()
        .post(format!("{server_url}/api/kiosk/event"))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "topic": "layout.changed",
            "source_type": "system",
            "payload": {
                "display_id": display_id,
                "layout_id": layout_id,
                "layout_name": layout_id,
            }
        }))
        .send()
        .await;
}

fn start_app(slot: &Arc<Mutex<Option<Child>>>) -> Result<(), String> {
    if slot.lock().unwrap().is_some() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let child = Command::new(exe)
        .arg("app")
        .spawn()
        .map_err(|e| format!("start app: {e}"))?;
    *slot.lock().unwrap() = Some(child);
    Ok(())
}

fn supervise_app(slot: &Arc<Mutex<Option<Child>>>) -> Result<(), String> {
    let mut guard = slot.lock().unwrap();
    let needs_start = match guard.as_mut() {
        Some(child) => child
            .try_wait()
            .map_err(|e| format!("check app: {e}"))?
            .is_some(),
        None => true,
    };
    if needs_start {
        *guard = None;
        drop(guard);
        start_app(slot)?;
    }
    Ok(())
}

fn restart_app(slot: &Arc<Mutex<Option<Child>>>) -> Result<(), String> {
    if let Some(mut child) = slot.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    start_app(slot)
}

fn run_app() -> Result<(), String> {
    gstreamer::init().map_err(|error| format!("GStreamer initialization failed: {error}"))?;
    let policy = load_policy();
    let displays = query_native_displays();
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
            let display_id = bundle
                .as_ref()
                .and_then(|b| b.displays.get(display.report.index).map(|d| d.id.clone()))
                .unwrap_or_else(|| display.report.name.clone());
            WINDOWS
                .get_or_init(|| Mutex::new(HashMap::new()))
                .lock()
                .unwrap()
                .insert(
                    hwnd,
                    WindowState {
                        display_id,
                        mouse_down: None,
                    },
                );
            ShowWindow(hwnd, SW_SHOWMAXIMIZED);
            UpdateWindow(hwnd);
            hwnds.push(hwnd);
        }

        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(1));
                for hwnd in &hwnds {
                    InvalidateRect(*hwnd, null(), 1);
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
            let mut display_id = None;
            let mut down = None;
            if let Some(windows) = WINDOWS.get() {
                if let Some(st) = windows.lock().unwrap().get_mut(&hwnd) {
                    display_id = Some(st.display_id.clone());
                    down = st.mouse_down.take();
                }
            }
            // No mouse_down means this is the second BUTTONUP of a
            // double-click (DBLCLK already consumed it) — don't dispatch.
            if let (Some(display_id), Some(down)) = (display_id, down) {
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
            if let Some(display_id) = WINDOWS
                .get()
                .and_then(|w| w.lock().unwrap().get(&hwnd).map(|st| st.display_id.clone()))
            {
                handle_pointer_event(&display_id, x, y, "double_click");
            }
            0
        }
        WM_DESTROY => {
            remove_camera_pipelines(hwnd);
            unsafe { PostQuitMessage(0) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn paint_window(hwnd: HWND) {
    unsafe {
        let mut ps: PAINTSTRUCT = std::mem::zeroed();
        let hdc = BeginPaint(hwnd, &mut ps);
        let brush = CreateSolidBrush(rgb(17, 24, 39));
        FillRect(hdc, &ps.rcPaint, brush);
        DeleteObject(brush as _);

        SetBkMode(hdc, 1);
        SetTextColor(hdc, rgb(229, 231, 235));
        if let Some(display_id) = WINDOWS
            .get()
            .and_then(|w| w.lock().unwrap().get(&hwnd).map(|st| st.display_id.clone()))
        {
            let mut client_rect = std::mem::zeroed();
            GetClientRect(hwnd, &mut client_rect);
            paint_layout(hwnd, hdc, client_rect, &display_id);
        } else {
            draw_centered(hdc, ps.rcPaint, "BetterFrame Windows Kiosk");
        }
        EndPaint(hwnd, &ps);
    }
}

fn paint_layout(hwnd: HWND, hdc: HDC, rect: RECT, display_id: &str) {
    let state = load_state();
    let bundle = load_bundle();
    let Some((display, layout)) = active_layout_for_display(bundle.as_ref(), &state, display_id)
    else {
        draw_centered(hdc, rect, "BetterFrame Windows Kiosk - waiting for bundle");
        return;
    };
    if layout.cells.is_empty() {
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
    sync_camera_pipelines(hwnd, rect, layout, &bundle, state.encrypt_key.as_deref());
}

fn query_displays() -> Vec<DisplayReport> {
    query_native_displays()
        .into_iter()
        .map(|d| d.report)
        .collect()
}

fn active_layout_for_display<'a>(
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
    let active = state
        .active_layouts
        .get(&display.id)
        .or(display.default_layout_id.as_ref())
        .or_else(|| display.layouts.first().map(|l| &l.id))?;
    let layout = display
        .layouts
        .iter()
        .find(|l| l.id == *active)
        .or_else(|| display.layouts.first())?;
    Some((display, layout))
}

fn cell_rect(canvas: RECT, cols: i32, rows: i32, cell: &BundleCell) -> RECT {
    let width = (canvas.right - canvas.left).max(1);
    let height = (canvas.bottom - canvas.top).max(1);
    RECT {
        left: canvas.left + width * cell.col as i32 / cols,
        top: canvas.top + height * cell.row as i32 / rows,
        right: canvas.left + width * (cell.col + cell.col_span) as i32 / cols,
        bottom: canvas.top + height * (cell.row + cell.row_span) as i32 / rows,
    }
}

fn cell_at_point<'a>(
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

fn color_for_content(kind: &str) -> COLORREF {
    match kind {
        "camera" => rgb(21, 94, 117),
        "web" => rgb(30, 64, 175),
        "html" => rgb(146, 64, 14),
        "ablesign" => rgb(88, 28, 135),
        _ => rgb(55, 65, 81),
    }
}

fn cell_label(cell: &BundleCell) -> String {
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

fn draw_centered(hdc: HDC, rect: RECT, text: &str) {
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

fn draw_cell_label(hdc: HDC, rect: RECT, text: &str) {
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

fn handle_pointer_event(display_id: &str, x: i32, y: i32, kind: &str) {
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

fn configured_cell_action(cell: &BundleCell, kind: &str) -> Option<(String, serde_json::Value)> {
    let options = cell.input_options.as_ref()?;
    let event = options.get("events")?.get(kind)?;
    let action = event.get("action")?.as_str()?.to_string();
    let params = event
        .get("params")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    Some((action, params))
}

fn report_interaction_event(
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

fn sync_camera_pipelines(
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
    let camera_cells = layout
        .cells
        .iter()
        .filter(|cell| cell.content_type == "camera")
        .count();

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

        let requested = cell.stream_selector.as_deref().unwrap_or("auto");
        let role = if requested == "auto" {
            if camera_cells > 4 { "sub" } else { "main" }
        } else {
            requested
        };
        let Some(stream) = camera
            .streams
            .iter()
            .find(|stream| stream.role == role)
            .or_else(|| camera.streams.iter().find(|stream| stream.role == "main"))
            .or_else(|| camera.streams.first())
        else {
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
            &stream.rtsp_uri,
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

fn create_windows_camera_pipeline(
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

fn remove_camera_pipelines(hwnd: HWND) {
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

fn decrypt_camera_password(ciphertext: &str, key: &str) -> Option<String> {
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

fn query_native_displays() -> Vec<NativeDisplay> {
    unsafe extern "system" fn enum_monitor(
        monitor: isize,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let out = unsafe { &mut *(data as *mut Vec<NativeDisplay>) };
        let mut info: MONITORINFOEXW = unsafe { std::mem::zeroed() };
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if unsafe { GetMonitorInfoW(monitor, &mut info as *mut MONITORINFOEXW as *mut _) } != 0 {
            let idx = out.len();
            let name = wide_to_string(&info.szDevice);
            let r = info.monitorInfo.rcMonitor;
            out.push(NativeDisplay {
                report: DisplayReport {
                    index: idx,
                    name,
                    width_px: (r.right - r.left).max(0) as u32,
                    height_px: (r.bottom - r.top).max(0) as u32,
                    power_state: "awake".to_string(),
                },
                rect: r,
            });
        }
        1
    }

    let mut displays = Vec::<NativeDisplay>::new();
    unsafe {
        EnumDisplayMonitors(
            0,
            null(),
            Some(enum_monitor),
            &mut displays as *mut _ as LPARAM,
        );
    }
    if displays.is_empty() {
        displays.push(primary_native_display());
    }
    displays
}

fn primary_native_display() -> NativeDisplay {
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

fn display_allowed(policy: &WindowsPolicy, display_name: &str) -> bool {
    if policy.displays.mode != "selected" {
        return true;
    }
    policy
        .displays
        .selected_display_names
        .iter()
        .any(|name| name.eq_ignore_ascii_case(display_name))
}

fn set_monitor_power(on: bool) {
    unsafe {
        let state = if on {
            -1isize as LPARAM
        } else {
            2isize as LPARAM
        };
        SendMessageW(
            HWND_BROADCAST,
            WM_SYSCOMMAND,
            SC_MONITORPOWER as WPARAM,
            state,
        );
    }
}

fn set_volume_percent(percent: u32) {
    let up_presses = percent.min(100) / 2;
    let script = if up_presses == 0 {
        "$obj = New-Object -ComObject WScript.Shell; 1..50 | % {$obj.SendKeys([char]174)}"
            .to_string()
    } else {
        format!(
            "$obj = New-Object -ComObject WScript.Shell; 1..50 | % {{$obj.SendKeys([char]174)}}; 1..{} | % {{$obj.SendKeys([char]175)}}",
            up_presses
        )
    };
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .spawn();
}

fn set_mute(_muted: bool) {
    let _ = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "(New-Object -ComObject WScript.Shell).SendKeys([char]173)",
        ])
        .spawn();
}

fn invalidate_app_windows() {
    // The app also polls state once per second; this is intentionally best effort.
}

fn install_tasks(args: &[String]) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let server = arg_value(args, "--server").unwrap_or_else(|| DEFAULT_SERVER_URL.to_string());
    let agent_tr = format!("\"{}\" agent --server {}", exe.display(), server);
    let app_tr = format!("\"{}\" app", exe.display());
    run_command(
        "schtasks",
        &[
            "/Create",
            "/TN",
            AGENT_TASK_NAME,
            "/SC",
            "ONLOGON",
            "/RL",
            "HIGHEST",
            "/F",
            "/TR",
            &agent_tr,
        ],
    )?;
    run_command(
        "schtasks",
        &[
            "/Create",
            "/TN",
            APP_TASK_NAME,
            "/SC",
            "ONLOGON",
            "/RL",
            "LIMITED",
            "/F",
            "/TR",
            &app_tr,
        ],
    )?;
    println!("Installed BetterFrame Windows logon tasks.");
    Ok(())
}

fn uninstall_tasks() -> Result<(), String> {
    let _ = run_command("schtasks", &["/Delete", "/TN", AGENT_TASK_NAME, "/F"]);
    let _ = run_command("schtasks", &["/Delete", "/TN", APP_TASK_NAME, "/F"]);
    println!("Removed BetterFrame Windows logon tasks.");
    Ok(())
}

fn run_command(program: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("{program}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} exited with {status}"))
    }
}

fn build_ws_url(http_url: &str, token: &str) -> String {
    let (scheme, rest) = if let Some(rest) = http_url.strip_prefix("https://") {
        ("wss", rest)
    } else if let Some(rest) = http_url.strip_prefix("http://") {
        ("ws", rest)
    } else {
        ("ws", http_url)
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    // Direct-to-API installs (--server http://host:18081) reach the
    // coordinator on 18082. Any other authority is assumed to be the proxy,
    // which routes /ws/kiosk itself.
    let authority = match authority.strip_suffix(":18081") {
        Some(host) => format!("{host}:18082"),
        None => authority.to_string(),
    };
    format!(
        "{scheme}://{authority}/ws/kiosk?token={}",
        urlencoding::encode(token)
    )
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find_map(|pair| {
        if pair[0] == name {
            Some(pair[1].clone())
        } else {
            None
        }
    })
}

fn state_dir() -> PathBuf {
    std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")))
        .join("BetterFrame")
        .join("WindowsClient")
}

fn state_path() -> PathBuf {
    state_dir().join("state.json")
}

fn bundle_path() -> PathBuf {
    state_dir().join("bundle.json")
}

fn policy_path() -> PathBuf {
    state_dir().join("windows-policy.json")
}

fn load_state() -> ClientState {
    read_protected_or_plain(&state_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| ClientState {
            server_url: DEFAULT_SERVER_URL.to_string(),
            ..ClientState::default()
        })
}

fn save_state(state: &ClientState) -> Result<(), String> {
    fs::create_dir_all(state_dir()).map_err(|e| format!("create state dir: {e}"))?;
    write_protected(&state_path(), &serde_json::to_vec(state).unwrap())
}

fn load_bundle() -> Option<KioskBundle> {
    read_protected_or_plain(&bundle_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn save_bundle(bundle: &KioskBundle) -> Result<(), String> {
    write_protected(&bundle_path(), &serde_json::to_vec(bundle).unwrap())
}

fn protect_machine(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: plaintext.len().try_into().map_err(|_| "state too large")?,
        pbData: plaintext.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_LOCAL_MACHINE,
            &mut output,
        )
    };
    if ok == 0 {
        return Err("CryptProtectData failed".to_string());
    }
    let protected =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    let mut result = Vec::with_capacity(PROTECTED_MAGIC.len() + protected.len());
    result.extend_from_slice(PROTECTED_MAGIC);
    result.extend_from_slice(&protected);
    Ok(result)
}

fn unprotect_machine(protected: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: protected.len().try_into().map_err(|_| "state too large")?,
        pbData: protected.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok =
        unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut output) };
    if ok == 0 {
        return Err("CryptUnprotectData failed".to_string());
    }
    let plaintext =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe { LocalFree(output.pbData as _) };
    Ok(plaintext)
}

fn read_protected_or_plain(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|error| format!("read state: {error}"))?;
    if bytes.starts_with(PROTECTED_MAGIC) {
        unprotect_machine(&bytes[PROTECTED_MAGIC.len()..])
    } else {
        Ok(bytes)
    }
}

fn write_protected(path: &std::path::Path, plaintext: &[u8]) -> Result<(), String> {
    let bytes = protect_machine(plaintext)?;
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, bytes).map_err(|error| format!("write protected state: {error}"))?;
    let from = wide_path(temporary.as_os_str());
    let to = wide_path(path.as_os_str());
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(format!(
            "commit protected state: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn wide_path(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn ensure_default_policy() -> Result<(), String> {
    if policy_path().exists() {
        return Ok(());
    }
    fs::write(
        policy_path(),
        serde_json::to_vec_pretty(&WindowsPolicy::default()).unwrap(),
    )
    .map_err(|e| format!("write default policy: {e}"))
}

fn load_policy() -> WindowsPolicy {
    fs::read_to_string(policy_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn apply_pending_config(pending: &PendingConfig) -> Result<(), String> {
    let Some(policy_value) = pending.config.get("windows_policy") else {
        return Ok(());
    };
    let policy: WindowsPolicy = serde_json::from_value(policy_value.clone())
        .map_err(|e| format!("parse windows_policy: {e}"))?;
    fs::write(policy_path(), serde_json::to_vec_pretty(&policy).unwrap())
        .map_err(|e| format!("write windows policy: {e}"))?;
    Ok(())
}

fn flexible_id(v: serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s,
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn flexible_id_ref(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

fn loword(value: usize) -> u16 {
    (value & 0xffff) as u16
}

fn hiword(value: usize) -> u16 {
    ((value >> 16) & 0xffff) as u16
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
}
