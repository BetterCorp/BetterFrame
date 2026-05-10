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
        "http://localhost:18081",
        "http://betterframe.local:18081",
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

/// Fetch bundle from server.
pub fn fetch_bundle(server: &str, key: &str) -> KioskBundle {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(format!("{server}/api/kiosk/bundle"))
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .expect("bundle fetch failed");

    if !resp.status().is_success() {
        panic!("Bundle fetch returned {}", resp.status());
    }

    resp.json().expect("bad bundle JSON")
}

/// Send heartbeat.
pub fn heartbeat(server: &str, key: &str) {
    let client = reqwest::blocking::Client::new();
    let _ = client
        .post(format!("{server}/api/kiosk/heartbeat"))
        .header("Authorization", format!("Bearer {key}"))
        .json(&serde_json::json!({
            "kiosk_app_version": env!("CARGO_PKG_VERSION"),
        }))
        .timeout(Duration::from_secs(5))
        .send();
}
