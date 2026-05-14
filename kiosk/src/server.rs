use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use tracing::info;

use crate::bundle::KioskBundle;

fn state_dir() -> PathBuf {
    let home = dirs::home_dir().expect("no home directory");
    let dir = home.join(".betterframe-kiosk");
    fs::create_dir_all(&dir).ok();
    dir
}

fn key_file() -> PathBuf { state_dir().join("kiosk.key") }
fn server_file() -> PathBuf { state_dir().join("server.url") }
fn bundle_cache_path() -> PathBuf { state_dir().join("bundle.json") }
fn local_key_file() -> PathBuf { state_dir().join("local.key") }

/// Load (or generate) the kiosk-local API key used by the LAN-side GET
/// layout-switch endpoint. Persisted hex, 32 bytes random.
pub fn load_or_create_local_key() -> String {
    if let Ok(s) = fs::read_to_string(local_key_file()) {
        let trimmed = s.trim().to_string();
        if trimmed.len() >= 16 { return trimmed; }
    }
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let hex_key = hex::encode(buf);
    let _ = fs::write(local_key_file(), &hex_key);
    hex_key
}

/// Persist the latest bundle to disk for offline boot.
pub fn save_bundle(bundle: &KioskBundle) {
    match serde_json::to_string(bundle) {
        Ok(text) => {
            if let Err(e) = fs::write(bundle_cache_path(), text) {
                tracing::warn!("failed to save bundle cache: {e}");
            }
        }
        Err(e) => tracing::warn!("failed to serialize bundle: {e}"),
    }
}

/// Load a cached bundle from disk. Returns None if file missing or invalid.
pub fn load_cached_bundle() -> Option<KioskBundle> {
    let path = bundle_cache_path();
    let text = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<KioskBundle>(&text) {
        Ok(b) => Some(b),
        Err(e) => {
            tracing::warn!("cached bundle invalid: {e}");
            None
        }
    }
}

/// Discover the BetterFrame server.
pub fn discover_server(override_url: Option<&str>) -> String {
    if let Some(url) = override_url {
        return url.to_string();
    }

    // Check saved
    if let Ok(saved) = fs::read_to_string(server_file()) {
        let saved = saved.trim().to_string();
        if check_health(&saved) {
            return saved;
        }
    }

    let candidates = [
        "http://localhost",
        "http://betterframe.local",
        "https://frame.betterportal.cloud",
    ];

    for url in candidates {
        info!("trying {url}...");
        if check_health(url) {
            fs::write(server_file(), url).ok();
            return url.to_string();
        }
    }

    panic!("Could not find BetterFrame server");
}

fn check_health(url: &str) -> bool {
    reqwest::blocking::Client::new()
        .get(format!("{url}/healthz"))
        .timeout(Duration::from_secs(3))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Check if already paired (key file exists).
pub fn is_paired() -> bool {
    key_file().exists()
}

/// Read stored kiosk key.
pub fn load_key() -> String {
    fs::read_to_string(key_file())
        .expect("failed to read kiosk key")
        .trim()
        .to_string()
}

#[derive(Deserialize)]
struct InitiateResp {
    code: String,
    expires_at: String,
}

/// Initiate pairing — returns (code, expires_at).
pub fn initiate_pairing(server: &str) -> (String, String) {
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "kiosk".into());

    let hw_model = fs::read_to_string("/proc/device-tree/model")
        .unwrap_or_else(|_| "unknown".into())
        .replace('\0', "");

    let client = reqwest::blocking::Client::new();
    let resp: InitiateResp = client
        .post(format!("{server}/api/pair/initiate"))
        .json(&serde_json::json!({
            "proposed_name": hostname,
            "hardware_model": hw_model,
            "capabilities": ["rtsp", "gstreamer", "gtk4"]
        }))
        .send()
        .expect("pairing initiate failed")
        .json()
        .expect("bad initiate response");

    (resp.code, resp.expires_at)
}

#[derive(Deserialize)]
struct ClaimResp {
    status: String,
    kiosk_key: Option<String>,
    kiosk_name: Option<String>,
}

/// Poll for pairing claim. Returns (name, key) when admin confirms.
pub fn poll_claim(server: &str, code: &str) -> (String, String) {
    let client = reqwest::blocking::Client::new();
    loop {
        let resp = client
            .post(format!("{server}/api/pair/claim"))
            .json(&serde_json::json!({ "code": code }))
            .send()
            .expect("claim request failed");

        if resp.status().as_u16() == 200 {
            let claim: ClaimResp = resp.json().expect("bad claim response");
            if claim.status == "claimed" {
                let key = claim.kiosk_key.expect("missing kiosk_key");
                let name = claim.kiosk_name.unwrap_or_else(|| "kiosk".into());
                fs::write(key_file(), &key).expect("failed to save kiosk key");
                return (name, key);
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Fetch bundle from server. Returns None on network/HTTP/parse failure.
/// On success, also writes the bundle to the on-disk cache.
pub fn fetch_bundle(server: &str, key: &str) -> Option<KioskBundle> {
    let client = reqwest::blocking::Client::new();
    let resp = match client
        .get(format!("{server}/api/kiosk/bundle"))
        .header("Authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(10))
        .send()
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("bundle fetch failed: {e}");
            return None;
        }
    };

    if !resp.status().is_success() {
        tracing::warn!("bundle fetch returned {}", resp.status());
        return None;
    }

    match resp.json::<KioskBundle>() {
        Ok(b) => {
            save_bundle(&b);
            Some(b)
        }
        Err(e) => {
            tracing::warn!("bundle parse failed: {e}");
            None
        }
    }
}

/// Send heartbeat with display geometry + hwmon.
/// Report a kiosk-side layout switch to the server, which forwards to
/// node-red as a `layout.changed` event. Covers idle reverts and any other
/// switch the kiosk performs without an admin click (admin clicks already
/// emit server-side).
pub fn report_layout_change(
    server: &str,
    key: &str,
    display_id: u32,
    layout_id: u32,
    layout_name: &str,
) {
    let client = reqwest::blocking::Client::new();
    let _ = client
        .post(format!("{server}/api/kiosk/event"))
        .header("Authorization", format!("Bearer {key}"))
        .json(&serde_json::json!({
            "topic": "layout.changed",
            "source_type": "system",
            "payload": {
                "display_id": display_id,
                "layout_id": layout_id,
                "layout_name": layout_name,
            },
        }))
        .timeout(Duration::from_secs(5))
        .send();
}

pub fn heartbeat(
    server: &str,
    key: &str,
    displays: &[(String, u32, u32)],
    hw: &crate::hwmon::HwInfo,
) {
    let client = reqwest::blocking::Client::new();
    let display_info: Vec<_> = displays.iter().enumerate().map(|(index, (name, w, h))| {
        serde_json::json!({ "index": index, "name": name, "width_px": w, "height_px": h })
    }).collect();
    // Surface the LAN-side local key + port to admin so the UI can show a
    // copy-paste URL for bookmark-style layout switches.
    let local_key = load_or_create_local_key();
    let local_port: u16 = std::env::var("BF_KIOSK_LOCAL_PORT")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(18090);
    let _ = client
        .post(format!("{server}/api/kiosk/heartbeat"))
        .header("Authorization", format!("Bearer {key}"))
        .json(&serde_json::json!({
            "kiosk_app_version": env!("CARGO_PKG_VERSION"),
            "displays": display_info,
            "cpu_temp_c": hw.cpu_temp_c,
            "fan_rpm": hw.fan_rpm,
            "fan_pwm": hw.fan_pwm,
            "local_key": local_key,
            "local_port": local_port,
        }))
        .timeout(Duration::from_secs(5))
        .send();
}
