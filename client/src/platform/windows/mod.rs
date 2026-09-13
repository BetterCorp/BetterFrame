use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::num::NonZeroIsize;
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
    COLORREF, CloseHandle, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, GetLastError, HANDLE, HWND, LPARAM,
    LRESULT, LocalFree, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreatePen, CreateSolidBrush, DEVMODEW, DISPLAY_DEVICE_ATTACHED_TO_DESKTOP,
    DISPLAY_DEVICE_MIRRORING_DRIVER, DISPLAY_DEVICEW, DT_CENTER, DT_LEFT, DT_SINGLELINE, DT_TOP,
    DT_VCENTER, DeleteObject, DrawTextW, ENUM_CURRENT_SETTINGS, EndPaint, EnumDisplayDevicesW,
    EnumDisplaySettingsExW, FillRect, HBRUSH, HDC, InvalidateRect, LineTo, MoveToEx, PAINTSTRUCT,
    PS_SOLID, SelectObject, SetBkMode, SetTextColor, UpdateWindow,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    SE_FILE_OBJECT, SetNamedSecurityInfoW,
};
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CryptProtectData, CryptUnprotectData,
};
use windows_sys::Win32::Security::{
    DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetTokenInformation,
    PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER, TokenUser,
};
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DispatchMessageW,
    GetClientRect, GetMessageW, GetSystemMetrics, HMENU, HWND_BROADCAST, LoadIconW, MSG,
    PostQuitMessage, RegisterClassW, SC_MONITORPOWER, SM_CXSCREEN, SM_CYSCREEN, SMTO_ABORTIFHUNG,
    SW_SHOWMAXIMIZED, SendMessageTimeoutW, ShowWindow, TranslateMessage, WM_DESTROY,
    WM_LBUTTONDBLCLK, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_PAINT, WM_SYSCOMMAND, WNDCLASSW,
    WS_EX_TOPMOST, WS_POPUP,
};
use wry::raw_window_handle::{
    HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle,
};
use wry::{
    Rect as WebRect, WebContext, WebView, WebViewBuilder, WebViewBuilderExtWindows,
    dpi::{PhysicalPosition, PhysicalSize},
};

use crate::bundle::{
    BundleCell, BundleDisplayWithLayouts as BundleDisplay, BundleLayout, KioskBundle,
};
use crate::core::commands::ServerCommand as AgentCommand;
use crate::core::layout::{configured_cell_action, resolve_web_url, same_origin};
use crate::core::protocol::{
    HeartbeatResponse, PairClaimResponse, PairInitiateResponse, PendingConfig,
};
use crate::core::state::ClientState;

mod host;
mod renderer;
mod storage;

use host::*;
use renderer::*;
use storage::*;

const DEFAULT_SERVER_URL: &str = crate::core::protocol::LOCAL_SERVER_URL;
const AGENT_TASK_NAME: &str = "BetterFrameWindowsAgent";
const APP_TASK_NAME: &str = "BetterFrameWindowsApp";
const PROTECTED_MAGIC: &[u8; 4] = b"BFW1";

fn kiosk_app_version() -> &'static str {
    option_env!("BF_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct WindowsPolicy {
    #[serde(default)]
    controls: WindowsControls,
    #[serde(default)]
    displays: WindowsDisplayPolicy,
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
    display_name: String,
    display_index: usize,
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

thread_local! {
    static WEBVIEWS: RefCell<HashMap<String, WebView>> = RefCell::new(HashMap::new());
    static WEBVIEW_FAILURES: RefCell<HashMap<String, Instant>> = RefCell::new(HashMap::new());
    static WEB_CONTEXT: RefCell<WebContext> = RefCell::new(WebContext::new(Some(webview_data_dir())));
}

enum HeartbeatError {
    Unauthorized,
    Other(String),
}

fn default_true() -> bool {
    true
}

fn default_display_mode() -> String {
    "all".to_string()
}

fn unpaired_state(server_url: &str) -> ClientState {
    ClientState::unpaired(server_url)
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("info".parse().unwrap()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    info!(
        "BetterFrame Windows client {} starting (mode={}, arch={})",
        kiosk_app_version(),
        args.get(1).map(String::as_str).unwrap_or("help"),
        std::env::consts::ARCH
    );
    let result = match args.get(1).map(|s| s.as_str()) {
        Some("agent") => run_agent_cli(&args[2..]),
        Some("app") => run_app(),
        Some("self-test") => self_test(),
        Some("install") => install_tasks(&args[2..]),
        Some("uninstall") => uninstall_tasks(),
        _ => {
            eprintln!("Usage:");
            eprintln!("  betterframe-windows-client agent [--server URL]");
            eprintln!("  betterframe-windows-client app");
            eprintln!("  betterframe-windows-client self-test");
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

fn self_test() -> Result<(), String> {
    let icon = unsafe { LoadIconW(GetModuleHandleW(null()), 1usize as *const u16) };
    if icon == 0 {
        return Err("BetterFrame icon resource is missing".to_string());
    }
    ensure_secure_state_dir()?;
    let probe = b"betterframe-self-test";
    let path = state_dir().join("self-test.tmp");
    write_protected(&path, probe)?;
    let stored = read_protected(&path)?;
    let _ = fs::remove_file(&path);
    if stored != probe {
        return Err("protected state-file round-trip returned different data".to_string());
    }

    gstreamer::init().map_err(|error| format!("GStreamer initialization: {error}"))?;
    for plugin in ["rtspsrc", "decodebin", "d3d11videosink"] {
        if gstreamer::ElementFactory::find(plugin).is_none() {
            return Err(format!(
                "required GStreamer element is unavailable: {plugin}"
            ));
        }
    }

    let webview = wry::webview_version().map_err(|error| format!("WebView2: {error}"))?;
    let displays = query_native_displays();
    if displays.is_empty() {
        return Err("Windows reported no attached displays".to_string());
    }
    println!(
        "self-test passed: DPAPI, state store, GStreamer, d3d11, WebView2 {webview}, {} display(s)",
        displays.len()
    );
    Ok(())
}

fn run_agent_cli(args: &[String]) -> Result<(), String> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?;
    let override_url = arg_value(args, "--server");
    rt.block_on(async {
        let server = loop {
            match discover_server(override_url.as_deref(), &load_agent_state()?).await {
                Ok(server) => break server,
                Err(error) => {
                    warn!("server discovery: {error}; retrying");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
            }
        };
        run_agent(server).await
    })
}

async fn discover_server(
    override_url: Option<&str>,
    state: &ClientState,
) -> Result<String, String> {
    let saved = state.server_url.trim().trim_end_matches('/');
    // Pending or paired credentials bind the origin. A bare discovery result
    // still allows an operator to correct an explicit server selection.
    if state.kiosk_key.is_some() || state.pairing_code.is_some() || state.pairing_secret.is_some() {
        return if saved.is_empty() {
            Err("Saved enrollment has no server origin; restore storage or reset locally".into())
        } else { Ok(saved.to_string()) };
    }
    if let Some(url) = override_url.map(str::trim).filter(|url| !url.is_empty()) {
        return crate::network::discover(url, true).await;
    }
    if !saved.is_empty() {
        return Ok(saved.to_string());
    }
    for candidate in crate::core::protocol::SERVER_CANDIDATES {
        info!("trying {candidate}...");
        if let Ok(origin) = crate::network::discover(candidate, false).await {
            return Ok(origin);
        }
    }
    Err("could not find BetterFrame server".to_string())
}

async fn run_agent(server_url: String) -> Result<(), String> {
    ensure_secure_state_dir()?;
    ensure_default_policy()?;

    let mut state = load_agent_state()?;
    state.server_url = server_url;
    save_state(&state)?;
    let app = Arc::new(Mutex::new(None::<Child>));
    // The renderer reads protected cached state independently. Start it before
    // regional discovery so an offline upgrade keeps showing the saved display.
    if state.kiosk_key.is_some() { start_app(&app)?; }
    while crate::core::protocol::needs_regional_migration(&state.server_url) {
        match migrate_canonical_state(&mut state).await {
            Ok(()) => break,
            Err(error) => {
                warn!("regional discovery: {error}; retaining saved identity and cached content");
                if state.kiosk_key.is_some() { let _ = supervise_app(&app); }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    }
    if state.kiosk_key.is_some() {
        acknowledge_pairing(&crate::network::client(), &mut state).await;
    }

    if state.kiosk_key.is_none() {
        state = pair(&state.server_url).await?;
        save_state(&state)?;
    }

    let policy = Arc::new(Mutex::new(load_policy()));
    let state = Arc::new(Mutex::new(state));
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
                        Err(HeartbeatError::Unauthorized) => {
                            warn!(
                                "server rejected kiosk key; retaining saved identity and cached content"
                            );
                        }
                        Err(HeartbeatError::Other(err)) => warn!("heartbeat failed: {err}"),
                    }
                } else {
                    match pair(&snapshot.server_url).await {
                        Ok(next) => {
                            let _ = save_state(&next);
                            *state.lock().unwrap() = next;
                        }
                        Err(err) => warn!("pairing failed: {err}"),
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
                    if let Err(err) = supervise_app(&app) {
                        warn!("app supervision failed: {err}");
                    }
                    last_supervise = Instant::now();
                }
            }
        }
    }
}

async fn migrate_canonical_state(state: &mut ClientState) -> Result<(), String> {
    if !crate::core::protocol::needs_regional_migration(&state.server_url) { return Ok(()); }
    let target = crate::network::discover(&state.server_url, true).await?;
    // Cached UI controls may update selections while discovery is offline.
    let mut latest = load_agent_state()?;
    apply_regional_state(&mut latest, target, save_state)?;
    *state = latest;
    Ok(())
}

fn apply_regional_state(
    state: &mut ClientState,
    target: String,
    persist: impl FnOnce(&ClientState) -> Result<(), String>,
) -> Result<(), String> {
    if !crate::core::protocol::needs_regional_migration(&state.server_url) { return Ok(()); }
    let destination = crate::core::protocol::discovery_probe(&target)?;
    if destination.scheme() != "https" { return Err("Regional migration requires HTTPS".into()); }
    let mut next = state.clone();
    next.server_url = crate::core::protocol::server_origin(&destination);
    // One protected atomic record contains origin, identity, pending secret and
    // cache version. Failed persistence leaves the in-memory origin unchanged.
    persist(&next)?;
    *state = next;
    Ok(())
}

async fn pair(server_url: &str) -> Result<ClientState, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())?;
    loop {
        let saved = load_agent_state()?;
        let resume = if saved.server_url == server_url && saved.kiosk_key.is_none() {
            saved.pairing_code.map(|code| PairInitiateResponse {
                code,
                expires_at: saved.pairing_expires_at.unwrap_or_default(),
                polling_secret: saved.pairing_secret,
                expires_in_seconds: None,
                poll_after_ms: None,
            })
        } else {
            None
        };
        let init = if let Some(session) = resume {
            session
        } else {
            let response = client.post(format!("{server_url}/api/pair/initiate"))
                .json(&serde_json::json!({
                    "proposed_name": hostname::get().ok().and_then(|h| h.into_string().ok()).unwrap_or_else(|| "Windows Kiosk".to_string()),
                    "hardware_model": "Windows Desktop", "firmware_target": "windows-x64",
                    "capabilities": ["windows", "desktop_app", "rtsp", "d3d11", "mouse", "keyboard", "app_restart", "display_select"],
                    "managed_image": false, "secure_claim": true
                })).send().await.and_then(|response| response.error_for_status());
            let init = match response {
                Ok(response) => response.json::<PairInitiateResponse>().await,
                Err(error) => Err(error),
            };
            match init {
                Ok(init) if !init.code.trim().is_empty() => init,
                _ => {
                    warn!("pairing initiation unavailable; retrying");
                    tokio::time::sleep(Duration::from_secs(10)).await;
                    continue;
                }
            }
        };
        println!("BetterFrame Windows pairing code: {}", init.code);
        let mut pending = unpaired_state(server_url);
        pending.pairing_code = Some(init.code.clone());
        pending.pairing_expires_at = Some(init.expires_at.clone());
        pending.pairing_secret = init.polling_secret.clone();
        save_state(&pending)?;
        let mut deadline = Instant::now() + init.lifetime();
        let mut delay = init.poll_delay();
        loop {
            let response = client
                .post(format!("{server_url}/api/pair/claim"))
                .json(&crate::core::protocol::claim_body(
                    &init.code,
                    init.polling_secret.as_deref(),
                ))
                .send()
                .await;
            let claim = match response {
                Ok(response)
                    if response.status().is_success() || response.status().as_u16() == 503 =>
                {
                    response.json::<PairClaimResponse>().await.ok()
                }
                Ok(response) => {
                    delay = response
                        .headers()
                        .get("retry-after")
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| value.parse::<u64>().ok())
                        .map(|seconds| Duration::from_secs(seconds.clamp(1, 60)))
                        .unwrap_or_else(|| (delay * 2).min(Duration::from_secs(60)));
                    None
                }
                Err(_) => {
                    delay = (delay * 2).min(Duration::from_secs(60));
                    None
                }
            };
            if let Some(claim) = claim {
                if claim.status == "expired" {
                    break;
                }
                if claim.status == "revoked" || claim.status == "acknowledged" {
                    warn!(
                        "pairing is {}; contact administrator or reset locally",
                        claim.status
                    );
                    deadline = Instant::now() + Duration::from_secs(900);
                    delay = Duration::from_secs(60);
                } else if claim.status == "claimed" {
                    match crate::core::protocol::DeviceIdentity::from_claim(
                        server_url, &init, claim,
                    ) {
                        Ok(identity) => {
                            let mut state = ClientState {
                                server_url: identity.server_url,
                                kiosk_key: Some(identity.kiosk_key),
                                encrypt_key: identity.encrypt_key.or(identity.cluster_key),
                                kiosk_id: Some(identity.kiosk_id),
                                kiosk_name: Some(identity.kiosk_name),
                                pairing_code: Some(init.code.clone()),
                                pairing_secret: init.polling_secret.clone(),
                                ..ClientState::default()
                            };
                            match save_state(&state) {
                                Ok(()) => {
                                    acknowledge_pairing(&client, &mut state).await;
                                    return Ok(state);
                                }
                                Err(error) => {
                                    warn!("pairing confirmed but identity storage failed: {error}")
                                }
                            }
                            deadline = Instant::now() + Duration::from_secs(900);
                        }
                        Err(error) => warn!("invalid pairing claim: {error}"),
                    }
                } else {
                    if let Some(seconds) = claim.expires_in_seconds {
                        deadline = Instant::now() + Duration::from_secs(seconds.clamp(1, 1800));
                    }
                    delay = crate::core::protocol::poll_delay(claim.poll_after_ms);
                    if claim.status == "failed" {
                        warn!("pairing server configuration error; retrying");
                    }
                }
            } else {
                warn!("pairing connection unavailable; retrying");
            }
            if init.polling_secret.is_none() && Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(if init.polling_secret.is_some() {
                delay
            } else {
                delay.min(deadline.saturating_duration_since(Instant::now()))
            })
            .await;
        }
        save_state(&unpaired_state(server_url))?;
        info!("pairing session expired; requesting a new code");
    }
}

async fn acknowledge_pairing(client: &reqwest::Client, state: &mut ClientState) {
    let (Some(code), Some(key)) = (&state.pairing_code, &state.kiosk_key) else {
        return;
    };
    if let Ok(response) = client
        .post(format!("{}/api/pair/ack", state.server_url))
        .bearer_auth(key)
        .timeout(Duration::from_secs(15))
        .json(&crate::core::protocol::claim_body(
            code,
            state.pairing_secret.as_deref(),
        ))
        .send()
        .await
    {
        if response.status().is_success() {
            state.pairing_code = None;
            state.pairing_expires_at = None;
            state.pairing_secret = None;
            if let Err(error) = save_state(state) {
                warn!("save pairing acknowledgment: {error}");
            }
        }
    }
}

async fn websocket_loop(
    server_url: &str,
    key: &str,
    tx: mpsc::UnboundedSender<AgentCommand>,
) -> Result<(), String> {
    let ws_url = crate::core::protocol::websocket_url(server_url, key)
        .map_err(|error| format!("invalid server URL: {error}"))?;
    let (ws, _) = tokio::time::timeout(Duration::from_secs(15), connect_async(&ws_url))
        .await
        .map_err(|_| "coordinator connection timed out")?
        .map_err(|e| format!("connect coordinator websocket: {e}"))?;
    info!("connected to coordinator");
    let (mut writer, mut reader) = ws.split();
    while let Some(msg) = tokio::time::timeout(Duration::from_secs(90), reader.next())
        .await
        .map_err(|_| "coordinator read deadline expired")?
    {
        let msg = msg.map_err(|e| format!("ws read: {e}"))?;
        let text = match msg {
            Message::Text(text) => text,
            Message::Ping(payload) => {
                tokio::time::timeout(Duration::from_secs(10), writer.send(Message::Pong(payload)))
                    .await
                    .map_err(|_| "coordinator write timed out")?
                    .map_err(|error| error.to_string())?;
                continue;
            }
            Message::Close(_) => break,
            _ => continue,
        };
        if text.contains("\"type\":\"ping\"") {
            let _ = tokio::time::timeout(
                Duration::from_secs(10),
                writer.send(Message::Text(r#"{"type":"pong"}"#.to_string())),
            )
            .await;
            continue;
        }
        if let Ok(Some(command)) = crate::core::commands::decode(&text) {
            let _ = tx.send(command);
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
        AgentCommand::Standby(_) => {
            if current_policy.controls.display_power {
                set_monitor_power(false);
            } else {
                info!("display standby ignored by Windows policy");
            }
        }
        AgentCommand::Wake(_) => {
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
                set_mute(muted)?;
            } else {
                info!("volume mute ignored by Windows policy");
            }
        }
        AgentCommand::Reboot => {
            if current_policy.controls.host_reboot {
                let _ = Command::new("shutdown").args(["/r", "/t", "5"]).spawn();
            } else if current_policy.controls.app_restart {
                // Host reboot not permitted â€” degrade to restarting the app.
                restart_app(app)?;
            } else {
                info!("reboot ignored by Windows policy");
            }
        }
        _ => info!("command unsupported on Windows"),
    }
    Ok(())
}

async fn fetch_bundle(server_url: &str, key: &str) -> Result<KioskBundle, String> {
    let response = crate::network::client()
        .get(format!("{server_url}/api/kiosk/bundle"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("bundle request: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let detail = detail.trim();
        return Err(format!(
            "bundle response: HTTP {status}{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(" ({})", detail.chars().take(512).collect::<String>())
            }
        ));
    }
    response
        .json::<KioskBundle>()
        .await
        .map_err(|e| format!("bundle response: {e}"))
}

async fn heartbeat(
    server_url: &str,
    key: &str,
    state: &ClientState,
) -> Result<ClientState, HeartbeatError> {
    let displays = query_displays();
    info!(
        "heartbeat reporting {} display(s): {}",
        displays.len(),
        displays
            .iter()
            .map(|display| format!(
                "{}={}x{}",
                display.name, display.width_px, display.height_px
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let resp = crate::network::client()
        .post(format!("{server_url}/api/kiosk/heartbeat"))
        .bearer_auth(key)
        .json(&serde_json::json!({
            "bundle_version": state.bundle_version.as_deref(),
            "kiosk_app_version": kiosk_app_version(),
            "firmware_target": "windows-x64",
            "os_version": std::env::consts::OS,
            "os_update_compatibility": "windows-desktop",
            "displays": displays,
            "reported_hostname": hostname::get().ok().and_then(|h| h.into_string().ok()),
            "network_interfaces": [],
            "managed_config_applied_version": state.managed_config_applied_version,
            "managed_config_error": state.managed_config_error,
        }))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| HeartbeatError::Other(format!("heartbeat request: {e}")))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(HeartbeatError::Unauthorized);
    }
    if !resp.status().is_success() {
        return Err(HeartbeatError::Other(format!(
            "heartbeat response: HTTP {}",
            resp.status()
        )));
    }
    let body = resp
        .json::<HeartbeatResponse>()
        .await
        .map_err(|e| HeartbeatError::Other(format!("heartbeat response: {e}")))?;
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
    let _ = crate::network::client()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pending_and_paired_restarts_stay_on_saved_regional_origin_without_discovery() {
        let mut state = ClientState::unpaired("https://frame-eu.betterportal.net");
        state.pairing_code = Some("ABC123".into());
        state.pairing_secret = Some("test-polling-secret".into());
        let reloaded: ClientState = serde_json::from_slice(&serde_json::to_vec(&state).unwrap()).unwrap();
        assert_eq!(discover_server(Some("https://frame.betterportal.net"), &reloaded).await.unwrap(), state.server_url);
        state.pairing_code = None;
        assert_eq!(discover_server(Some("https://changed.example"), &state).await.unwrap(), state.server_url);
        state.kiosk_key = Some("test-device-key".into());
        state.pairing_secret = None;
        assert_eq!(discover_server(Some("https://changed.example"), &state).await.unwrap(), state.server_url);
    }

    #[tokio::test]
    async fn explicit_server_can_correct_a_saved_discovery_result_before_enrollment() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let peer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut chunk = [0; 4096];
                let read = stream.read(&mut chunk).unwrap();
                assert!(read > 0);
                request.extend_from_slice(&chunk[..read]);
            }
            let request = String::from_utf8(request).unwrap().to_lowercase();
            assert!(request.starts_with("get /healthz "));
            assert!(!request.contains("authorization:"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let state = ClientState::unpaired("https://mistyped.example");
        assert_eq!(discover_server(None, &state).await.unwrap(), state.server_url);
        assert_eq!(discover_server(Some(&origin), &state).await.unwrap(), origin);
        peer.join().unwrap();
    }

    #[test]
    fn legacy_canonical_migration_preserves_protected_identity_pending_state_and_cache() {
        let directory = std::env::temp_dir().join(format!("bf-region-migration-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let state_file = directory.join("state.json");
        let cache_file = directory.join("bundle.json");
        let mut state = ClientState {
            server_url: "https://FRAME.BETTERPORTAL.NET:443/".into(),
            kiosk_key: Some("retained-device-key".into()),
            encrypt_key: Some("retained-encryption-key".into()),
            kiosk_id: Some("42".into()),
            pairing_code: Some("ABC123".into()),
            pairing_secret: Some("retained-polling-secret".into()),
            bundle_version: Some("cached-v1".into()),
            ..ClientState::default()
        };
        state.active_layouts.insert("display".into(), "layout".into());
        write_protected(&state_file, &serde_json::to_vec(&state).unwrap()).unwrap();
        let cached: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id":"42", "kiosk_name":"Recovered", "version":"cached-v1", "displays":[], "cameras":[]
        })).unwrap();
        write_protected(&cache_file, &serde_json::to_vec(&cached).unwrap()).unwrap();
        let original = serde_json::to_value(&state).unwrap();
        let cache_before = fs::read(&cache_file).unwrap();
        assert!(apply_regional_state(&mut state, "https://frame-eu.betterportal.net".into(), |_| Err("storage unavailable".into())).is_err());
        assert_eq!(serde_json::to_value(&state).unwrap(), original);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&read_protected(&state_file).unwrap()).unwrap(), original);
        apply_regional_state(&mut state, "https://frame-eu.betterportal.net".into(), |next|
            write_protected(&state_file, &serde_json::to_vec(next).unwrap())).unwrap();
        let restarted: ClientState = serde_json::from_slice(&read_protected(&state_file).unwrap()).unwrap();
        assert_eq!(restarted.server_url, "https://frame-eu.betterportal.net");
        assert_eq!(restarted.kiosk_key.as_deref(), Some("retained-device-key"));
        assert_eq!(restarted.encrypt_key.as_deref(), Some("retained-encryption-key"));
        assert_eq!(restarted.pairing_secret.as_deref(), Some("retained-polling-secret"));
        assert_eq!(restarted.active_layouts.get("display").map(String::as_str), Some("layout"));
        assert_eq!(fs::read(&cache_file).unwrap(), cache_before);
        apply_regional_state(&mut state, "https://unrelated.example".into(), |_| panic!("A custom/regional origin must remain pinned")).unwrap();
        assert_eq!(state.server_url, "https://frame-eu.betterportal.net");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reset_and_display_reconciliation_keep_only_valid_identity() {
        let reset = unpaired_state("https://frame.example");
        assert_eq!(reset.server_url, "https://frame.example");
        assert!(reset.kiosk_key.is_none());

        let bundle: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id": "kiosk",
            "kiosk_name": "Lobby",
            "displays": [
                {
                    "id": "first",
                    "name": r"Lobby: \\.\DISPLAY1",
                    "width_px": 1920,
                    "height_px": 1080,
                    "idle_timeout_seconds": 0,
                    "sleep_timeout_seconds": 0,
                    "layouts": []
                },
                {
                    "id": "second",
                    "name": r"Lobby: \\.\DISPLAY2",
                    "width_px": 1920,
                    "height_px": 1080,
                    "idle_timeout_seconds": 0,
                    "sleep_timeout_seconds": 0,
                    "layouts": []
                }
            ],
            "cameras": [],
            "version": "1"
        }))
        .unwrap();
        assert_eq!(
            resolve_bundle_display(Some(&bundle), r"\\.\DISPLAY2", 0).map(|d| d.id.as_str()),
            Some("second")
        );
    }

    #[test]
    fn ablesign_profiles_follow_screen_identity() {
        let first = HashMap::from([("screenId".into(), "101".into())]);
        let second = HashMap::from([("screenId".into(), "202".into())]);

        assert_eq!(
            ablesign_profile_name(Some("https://player.ablesign.tv"), Some(&first)).as_deref(),
            Some("ablesign-101")
        );
        assert_eq!(
            ablesign_profile_name(Some("https://player.ablesign.tv"), Some(&second)).as_deref(),
            Some("ablesign-202")
        );
        assert_eq!(
            ablesign_profile_name(Some("https://example.com"), Some(&first)),
            None
        );
    }

    #[test]
    fn webview_initialization_cannot_skip_local_storage_when_dom_is_empty() {
        let values = HashMap::from([
            ("screenId".into(), "101".into()),
            ("screenToken".into(), "token".into()),
        ]);
        let script = initialization_script(Some(&values));

        assert!(script.starts_with("try{document.documentElement"));
        assert!(script.contains("localStorage.setItem(\"screenId\",\"101\")"));
        assert!(script.contains("localStorage.setItem(\"screenToken\",\"token\")"));
    }
}
