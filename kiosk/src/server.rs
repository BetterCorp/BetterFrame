use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tracing::info;

use crate::bundle::KioskBundle;

pub struct DisplayReport {
    pub index: usize,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub power_state: String,
}

#[derive(Clone, Debug)]
struct ManagedConfigReport {
    version: u64,
    error: Option<String>,
}

static MANAGED_CONFIG_REPORT: Mutex<Option<ManagedConfigReport>> = Mutex::new(None);
static LAST_MANAGED_CONFIG_ATTEMPT: Mutex<Option<(u64, bool)>> = Mutex::new(None);
static AUTO_UPDATES_ALLOWED: AtomicBool = AtomicBool::new(true);

#[derive(Debug, Deserialize)]
struct PendingManagedConfig {
    version: u64,
    config: ManagedConfig,
}

#[derive(Debug, Deserialize)]
struct ManagedConfig {
    timezone: Option<String>,
}

pub fn kiosk_app_version() -> &'static str {
    option_env!("BF_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

fn reported_hostname() -> Option<String> {
    hostname::get()
        .ok()
        .map(|h| h.to_string_lossy().trim().to_string())
        .filter(|h| !h.is_empty())
}

fn read_network_interfaces() -> Vec<Value> {
    let out = match Command::new("ip").args(["-j", "addr", "show"]).output() {
        Ok(out) if out.status.success() => out,
        Ok(out) => {
            tracing::warn!("ip -j addr show exited with {}", out.status);
            return Vec::new();
        }
        Err(err) => {
            tracing::warn!("ip -j addr show failed: {err}");
            return Vec::new();
        }
    };

    let parsed: Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(err) => {
            tracing::warn!("ip -j addr show parse failed: {err}");
            return Vec::new();
        }
    };

    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let name = item.get("ifname")?.as_str()?;
            let addr_info = item.get("addr_info")?.as_array()?;
            let ips: Vec<Value> = addr_info
                .iter()
                .filter_map(|addr| {
                    let family = addr.get("family")?.as_str()?;
                    if family != "inet" && family != "inet6" {
                        return None;
                    }
                    let local = addr.get("local")?.as_str()?;
                    let prefix = addr.get("prefixlen").and_then(|v| v.as_u64());
                    Some(match prefix {
                        Some(prefix) => Value::String(format!("{local}/{prefix}")),
                        None => Value::String(local.to_string()),
                    })
                })
                .collect();
            if ips.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "name": name,
                "mac": item.get("address").and_then(|v| v.as_str()),
                "operstate": item.get("operstate").and_then(|v| v.as_str()),
                "ips": ips,
            }))
        })
        .collect()
}

fn state_dir() -> PathBuf {
    let persistent = PathBuf::from("/var/lib/betterframe/kiosk");
    if fs::create_dir_all(&persistent).is_ok() {
        migrate_legacy_state(&persistent);
        return persistent;
    }

    tracing::warn!("could not use persistent kiosk state dir; falling back to home directory");
    let home = dirs::home_dir().expect("no home directory");
    let fallback = home.join(".betterframe-kiosk");
    fs::create_dir_all(&fallback).ok();
    fallback
}

pub fn state_file(name: &str) -> PathBuf {
    state_dir().join(name)
}

fn migrate_legacy_state(persistent: &PathBuf) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let legacy = home.join(".betterframe-kiosk");
    if !legacy.is_dir() {
        return;
    }

    for name in [
        "kiosk.key",
        "server.url",
        "bundle.json",
        "cluster.key",
        "encrypt.key",
        "local.key",
    ] {
        let src = legacy.join(name);
        let dst = persistent.join(name);
        if src.is_file() && !dst.exists() {
            if let Err(err) = fs::copy(&src, &dst) {
                tracing::warn!("failed to migrate kiosk state file {name}: {err}");
            }
        }
    }
}

fn key_file() -> PathBuf {
    state_dir().join("kiosk.key")
}
fn server_file() -> PathBuf {
    state_dir().join("server.url")
}
fn bundle_cache_path() -> PathBuf {
    state_dir().join("bundle.json")
}
fn cluster_key_file() -> PathBuf {
    state_dir().join("cluster.key")
}
fn local_key_file() -> PathBuf {
    state_dir().join("local.key")
}

/// Load (or generate) the kiosk-local API key used by the LAN-side GET
/// layout-switch endpoint. Persisted hex, 32 bytes random. Stored
/// encrypted-at-rest (hardware-bound) so pulling the SD card doesn't yield
/// the key plaintext.
pub fn load_or_create_local_key() -> String {
    let path = local_key_file();
    if let Ok(raw) = fs::read(&path) {
        let was_encrypted = crate::at_rest::decrypt_from_disk(&raw).is_ok();
        if let Some(trimmed) = crate::at_rest::read_text_maybe_encrypted(&path) {
            if trimmed.len() >= 16 {
                if !was_encrypted {
                    let _ = crate::at_rest::write_encrypted(&path, trimmed.as_bytes());
                }
                return trimmed;
            }
        }
    }
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let hex_key = hex::encode(buf);
    let _ = crate::at_rest::write_encrypted(&path, hex_key.as_bytes());
    hex_key
}

pub fn rotate_local_key() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    let hex_key = hex::encode(buf);
    let _ = crate::at_rest::write_encrypted(&local_key_file(), hex_key.as_bytes());
    hex_key
}

/// Persist the latest bundle to disk for offline boot. Encrypted at rest
/// because the bundle contains camera playback credentials and other
/// kiosk-side secrets.
pub fn save_bundle(bundle: &KioskBundle) {
    match serde_json::to_vec(bundle) {
        Ok(bytes) => {
            if let Err(e) = crate::at_rest::write_encrypted(&bundle_cache_path(), &bytes) {
                tracing::warn!("failed to save bundle cache: {e}");
            }
        }
        Err(e) => tracing::warn!("failed to serialize bundle: {e}"),
    }
}

/// Load a cached bundle from disk. Returns None if file missing or invalid.
/// Tolerates legacy plaintext (kiosks upgraded from a pre-at_rest build)
/// so pairing survives the rollout.
pub fn load_cached_bundle() -> Option<KioskBundle> {
    let bytes = crate::at_rest::read_maybe_encrypted(&bundle_cache_path())?;
    match serde_json::from_slice::<KioskBundle>(&bytes) {
        Ok(b) => Some(b),
        Err(e) => {
            tracing::warn!("cached bundle invalid: {e}");
            None
        }
    }
}

pub fn load_kiosk_id() -> Option<String> {
    load_cached_bundle().map(|b| b.kiosk_id)
}

/// Discover the BetterFrame server.
pub fn discover_server(override_url: Option<&str>) -> String {
    if let Some(url) = override_url {
        return url.to_string();
    }

    // A paired kiosk must boot from cache without waiting for its server.
    // The WS and bundle retry loops reconnect to this saved endpoint later.
    if let Ok(saved) = fs::read_to_string(server_file()) {
        let saved = saved.trim().to_string();
        if !saved.is_empty() && (is_paired() || check_health(&saved)) {
            return saved;
        }
    }

    // Probe order: on-device → LAN mDNS → BetterCorp managed cloud.
    // Single image works for aio (server beside kiosk on same Pi), on-prem
    // (server on the LAN, discoverable by mDNS), and client-only (no local
    // server — falls through to the cloud).
    let candidates = [
        "http://localhost",
        "http://betterframe.local",
        "https://frame-eu.betterportal.net",
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

/// Confirm with the server that our key is truly rejected before wiping.
/// Calls /api/kiosk/_check — if 200 the key is still valid (false alarm).
fn confirm_deletion(server: &str, key: &str) -> bool {
    let client = reqwest::blocking::Client::new();
    match client
        .get(format!("{server}/api/kiosk/_check"))
        .header("Authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(5))
        .send()
    {
        Ok(r) => r.status().as_u16() == 401,
        Err(_) => false, // network error — don't wipe
    }
}

fn remove_pairing_state_files(dir: &PathBuf) {
    for name in [
        "kiosk.key",
        "server.url",
        "bundle.json",
        "cluster.key",
        "encrypt.key",
        "local.key",
    ] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

/// Wipe all kiosk state and exit. Systemd restarts the service,
/// kiosk boots fresh with a new pairing code.
pub fn reset_pairing_and_restart(reason: &str) -> ! {
    tracing::warn!("{reason}; wiping kiosk pairing state and restarting");

    remove_pairing_state_files(&PathBuf::from("/var/lib/betterframe/kiosk"));
    if let Some(home) = dirs::home_dir() {
        remove_pairing_state_files(&home.join(".betterframe-kiosk"));
    }

    tracing::info!("config wiped, exiting for systemd restart");
    std::process::exit(1);
}

/// Only called after double-verification (bf_kiosk_deleted + _check 401).
fn wipe_and_restart() -> ! {
    reset_pairing_and_restart("server confirmed kiosk key is invalid")
}

/// Load cluster key (if stored from pairing). Used for ONVIF password decrypt.
pub fn load_cluster_key() -> Option<String> {
    crate::at_rest::read_text_maybe_encrypted(&cluster_key_file())
}

/// Read stored kiosk key. Detects legacy plaintext (kiosks upgraded from
/// a pre-at_rest build) and re-stores it ciphertext in place so subsequent
/// SD-card extractions don't see the bearer token.
pub fn load_key() -> String {
    let path = key_file();
    let raw = fs::read(&path).expect("failed to read kiosk key");
    let was_encrypted = crate::at_rest::decrypt_from_disk(&raw).is_ok();
    let key = crate::at_rest::read_text_maybe_encrypted(&path).expect("failed to decode kiosk key");
    if !was_encrypted {
        // Best-effort migrate. If write fails (e.g. RO mount during a
        // recovery boot) we still hand back the key so the kiosk works.
        let _ = crate::at_rest::write_encrypted(&path, key.as_bytes());
    }
    key
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
            "firmware_target": crate::firmware::FIRMWARE_TARGET,
            "capabilities": ["rtsp", "gstreamer", "gtk4"]
        }))
        .send()
        .expect("pairing initiate failed")
        .json()
        .expect("bad initiate response");

    (resp.code, resp.expires_at)
}

fn encrypt_key_file() -> PathBuf {
    state_dir().join("encrypt.key")
}

#[derive(Deserialize)]
struct ClaimResp {
    status: String,
    kiosk_id: Option<serde_json::Value>,
    kiosk_key: Option<String>,
    kiosk_name: Option<String>,
    cluster_key: Option<String>,
    encrypt_key: Option<String>,
}

/// Load the per-kiosk encryption key. Preferred over cluster_key for
/// decrypting camera passwords in the bundle.
pub fn load_encrypt_key() -> Option<String> {
    crate::at_rest::read_text_maybe_encrypted(&encrypt_key_file())
}

/// Poll for pairing claim. Returns (name, key) when admin confirms.
pub fn poll_claim(server: &str, code: &str) -> (String, String) {
    loop {
        if let Some(claim) = poll_claim_once(server, code) {
            return claim;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

/// Poll for pairing claim until the server-provided expiry passes.
/// Returns None when the kiosk should request and show a fresh code.
pub fn poll_claim_until_expiry(
    server: &str,
    code: &str,
    expires_at: &str,
) -> Option<(String, String)> {
    let expires_at = OffsetDateTime::parse(expires_at, &Rfc3339).ok();
    loop {
        if let Some(claim) = poll_claim_once(server, code) {
            return Some(claim);
        }
        if expires_at
            .map(|expires_at| OffsetDateTime::now_utc() >= expires_at)
            .unwrap_or(false)
        {
            tracing::info!("pairing code {code} expired, requesting a fresh code");
            return None;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}

fn poll_claim_once(server: &str, code: &str) -> Option<(String, String)> {
    let client = reqwest::blocking::Client::new();
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
            if let Some(ref id) = claim.kiosk_id {
                let id_str = match id {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    other => other.to_string(),
                };
                crate::axiom::set_kiosk_id(id_str);
            }
            crate::at_rest::write_encrypted(&key_file(), key.as_bytes())
                .expect("failed to save kiosk key");
            // Store cluster key for backward compat ONVIF password decryption.
            if let Some(ref ck) = claim.cluster_key {
                let _ = crate::at_rest::write_encrypted(&cluster_key_file(), ck.as_bytes());
            }
            // Store per-kiosk encryption key (preferred over cluster_key).
            if let Some(ref ek) = claim.encrypt_key {
                let _ = crate::at_rest::write_encrypted(&encrypt_key_file(), ek.as_bytes());
            }
            crate::remote_debug::reset_all_lockouts();
            return Some((name, key));
        }
    }
    None
}

/// Fetch bundle from server. Returns None on network/HTTP/parse failure.
/// On success, also writes the bundle to the on-disk cache.
/// Cached ETag from the last bundle fetch. Sent as If-None-Match so the
/// server can return 304 when the bundle hasn't changed.
static BUNDLE_ETAG: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn fetch_bundle(server: &str, key: &str) -> Option<KioskBundle> {
    let client = reqwest::blocking::Client::new();
    let mut req = client
        .get(format!("{server}/api/kiosk/bundle"))
        .header("Authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(10));
    if let Some(etag) = BUNDLE_ETAG.lock().unwrap().as_deref() {
        req = req.header("If-None-Match", etag);
    }
    let resp = match req.send() {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("bundle fetch failed: {e}");
            return None;
        }
    };

    // 304 Not Modified — bundle unchanged, use cached.
    if resp.status().as_u16() == 304 {
        return load_cached_bundle();
    }

    if resp.status().as_u16() == 401 {
        reset_pairing_and_restart("server rejected kiosk key during bundle fetch");
    }

    if !resp.status().is_success() {
        tracing::warn!("bundle fetch returned {}", resp.status());
        return None;
    }

    // Cache the ETag for next request.
    if let Some(etag) = resp.headers().get("etag").and_then(|v| v.to_str().ok()) {
        *BUNDLE_ETAG.lock().unwrap() = Some(etag.to_string());
    }

    let text = match resp.text() {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("bundle read failed: {e}");
            return None;
        }
    };

    // Server signals kiosk was deleted — double-verify via _check before wiping
    if text.contains("\"bf_kiosk_deleted\"") {
        tracing::warn!("server reports kiosk deleted, confirming via _check");
        if confirm_deletion(server, key) {
            tracing::error!("deletion confirmed, wiping config and restarting");
            wipe_and_restart();
        }
        tracing::info!("_check says key still valid, ignoring bf_kiosk_deleted");
        return None;
    }

    match serde_json::from_str::<KioskBundle>(&text) {
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
    display_id: &str,
    layout_id: &str,
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

pub fn report_web_change(
    server: &str,
    key: &str,
    tenant_slug: &str,
    kiosk_id: &str,
    display_id: &str,
    view_id: Option<&str>,
    entity_id: Option<&str>,
    url: &str,
) {
    let client = reqwest::blocking::Client::new();
    let _ = client
        .post(format!("{server}/api/kiosk/event"))
        .header("Authorization", format!("Bearer {key}"))
        .json(&serde_json::json!({
            "topic": "web-change",
            "source_type": "system",
            "payload": {
                "url": url,
                "tenant_slug": tenant_slug,
                "tenant_key": tenant_slug,
                "kiosk_id": kiosk_id,
                "display_id": display_id,
                "view_id": view_id,
                "entity_id": entity_id,
            },
        }))
        .timeout(Duration::from_secs(5))
        .send();
}

pub fn report_kiosk_log(server: &str, key: &str, level: &str, message: &str, payload: Value) {
    let client = reqwest::blocking::Client::new();
    let _ = client
        .post(format!("{server}/api/kiosk/event"))
        .header("Authorization", format!("Bearer {key}"))
        .json(&serde_json::json!({
            "topic": "kiosk.log",
            "source_type": "system",
            "payload": {
                "level": level,
                "message": message,
                "context": payload,
            },
        }))
        .timeout(Duration::from_secs(5))
        .send();
}

#[cfg(target_os = "linux")]
fn tailscale_status() -> serde_json::Value {
    serde_json::to_value(crate::tailscale::get_status()).unwrap_or_default()
}

#[cfg(not(target_os = "linux"))]
fn tailscale_status() -> serde_json::Value {
    serde_json::Value::Null
}

pub fn heartbeat(
    server: &str,
    key: &str,
    bundle_version: Option<&str>,
    displays: &[DisplayReport],
    hw: &crate::hwmon::HwInfo,
) -> bool {
    let client = reqwest::blocking::Client::new();
    let display_info: Vec<_> = displays
        .iter()
        .map(|d| {
            serde_json::json!({
                "index": d.index,
                "name": &d.name,
                "width_px": d.width_px,
                "height_px": d.height_px,
                "power_state": &d.power_state,
            })
        })
        .collect();
    // Surface the LAN-side local key + port to admin so the UI can show a
    // copy-paste URL for bookmark-style layout switches.
    let local_key = load_or_create_local_key();
    let local_port: u16 = std::env::var("BF_KIOSK_LOCAL_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(18090);
    let hostname = reported_hostname();
    let network_interfaces = read_network_interfaces();
    let managed_report = MANAGED_CONFIG_REPORT.lock().ok().and_then(|g| g.clone());
    let mut payload = serde_json::json!({
        "bundle_version": bundle_version,
        "kiosk_app_version": kiosk_app_version(),
        "firmware_target": crate::firmware::FIRMWARE_TARGET,
        "os_version": crate::os_update::current_os_version_public(),
        "os_update_compatibility": crate::os_update::compatibility_public(),
        "displays": display_info,
        "cpu_temp_c": hw.cpu_temp_c,
        "cpu_load_percent": hw.cpu_load_percent,
        "gpu_load_percent": hw.gpu_load_percent,
        "fan_rpm": hw.fan_rpm,
        "fan_pwm": hw.fan_pwm,
        "memory_total_mb": hw.memory_total_mb,
        "memory_used_mb": hw.memory_used_mb,
        "disk_total_mb": hw.disk_total_mb,
        "disk_free_mb": hw.disk_free_mb,
        "disk_used_percent": hw.disk_used_percent,
        "local_key": local_key,
        "local_port": local_port,
        "reported_hostname": hostname,
        "network_interfaces": network_interfaces,
        "logging": {
            "client_time": crate::axiom::iso_now(),
            "axiom": crate::axiom::status(),
        },
        "onvif_subscriptions": serde_json::to_value(crate::onvif_events::get_statuses()).unwrap_or_default(),
        "partitions": serde_json::to_value(&hw.partitions).unwrap_or_default(),
        "audio": serde_json::to_value(crate::audio::get_state()).unwrap_or_default(),
        "pipeline_stats": serde_json::to_value(crate::pipeline::telemetry()).unwrap_or_default(),
        "tailscale": tailscale_status(),
    });
    if let Some(report) = managed_report {
        if let Some(err) = report.error {
            payload["managed_config_error"] = serde_json::json!(err);
        } else {
            payload["managed_config_applied_version"] = serde_json::json!(report.version);
        }
    }
    client
        .post(format!("{server}/api/kiosk/heartbeat"))
        .header("Authorization", format!("Bearer {key}"))
        .json(&payload)
        .timeout(Duration::from_secs(5))
        .send()
        .and_then(|r| {
            if r.status().as_u16() == 401 {
                reset_pairing_and_restart("server rejected kiosk key during heartbeat");
            }

            if !r.status().is_success() {
                return Ok(false);
            }
            if let Ok(body) = r.json::<serde_json::Value>() {
                if body
                    .get("bf_kiosk_deleted")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    tracing::warn!(
                        "server reports kiosk deleted via heartbeat, confirming via _check"
                    );
                    if confirm_deletion(server, key) {
                        tracing::error!(
                            "deletion confirmed via heartbeat, wiping config and restarting"
                        );
                        wipe_and_restart();
                    }
                    tracing::info!(
                        "_check says key still valid, ignoring bf_kiosk_deleted from heartbeat"
                    );
                }
                let fw = body.get("firmware_channel").and_then(|v| v.as_str());
                let os = body.get("os_update_channel").and_then(|v| v.as_str());
                let fw_target = body.get("firmware_target_version").map(|v| v.as_str());
                let os_target = body.get("os_update_target_version").map(|v| v.as_str());
                update_cached_update_preferences(fw, fw_target, os, os_target);
                if let Some(allowed) = body.get("auto_updates_allowed").and_then(|v| v.as_bool()) {
                    AUTO_UPDATES_ALLOWED.store(allowed, Ordering::SeqCst);
                }
                if let Some(volume) = body
                    .get("audio_default_volume_percent")
                    .and_then(|v| v.as_u64())
                {
                    *CACHED_AUDIO_DEFAULT_VOLUME.lock().unwrap() = Some(volume.min(100) as u32);
                }
                if let Some(pending) = body.get("pending_config") {
                    apply_pending_managed_config(pending);
                }
            }
            Ok(true)
        })
        .unwrap_or(false)
}

pub fn auto_updates_allowed() -> bool {
    AUTO_UPDATES_ALLOWED.load(Ordering::SeqCst)
}

use std::sync::Mutex as StdMutex;
static CACHED_FIRMWARE_CHANNEL: StdMutex<Option<String>> = StdMutex::new(None);
static CACHED_FIRMWARE_TARGET_VERSION: StdMutex<Option<Option<String>>> = StdMutex::new(None);
static CACHED_OS_CHANNEL: StdMutex<Option<String>> = StdMutex::new(None);
static CACHED_OS_TARGET_VERSION: StdMutex<Option<Option<String>>> = StdMutex::new(None);
static CACHED_AUDIO_DEFAULT_VOLUME: StdMutex<Option<u32>> = StdMutex::new(None);

pub fn update_cached_update_preferences(
    firmware_channel: Option<&str>,
    firmware_target_version: Option<Option<&str>>,
    os_channel: Option<&str>,
    os_target_version: Option<Option<&str>>,
) {
    let mut changed = false;
    if let Some(next) = firmware_channel {
        let mut cached = CACHED_FIRMWARE_CHANNEL.lock().unwrap();
        if cached.as_deref().is_some_and(|old| old != next) {
            changed = true;
        }
        cached.replace(next.to_string());
    }
    if let Some(firmware_target_version) = firmware_target_version {
        let mut cached = CACHED_FIRMWARE_TARGET_VERSION.lock().unwrap();
        let next = firmware_target_version.map(|s| s.to_string());
        if cached.as_ref().is_some_and(|old| old != &next) {
            changed = true;
        }
        cached.replace(next);
    }
    if let Some(next) = os_channel {
        let mut cached = CACHED_OS_CHANNEL.lock().unwrap();
        if cached.as_deref().is_some_and(|old| old != next) {
            changed = true;
        }
        cached.replace(next.to_string());
    }
    if let Some(os_target_version) = os_target_version {
        let mut cached = CACHED_OS_TARGET_VERSION.lock().unwrap();
        let next = os_target_version.map(|s| s.to_string());
        if cached.as_ref().is_some_and(|old| old != &next) {
            changed = true;
        }
        cached.replace(next);
    }
    if changed {
        cancel_active_updates("update channel or pinned version changed");
    }
}

pub fn cancel_active_updates(reason: &str) {
    tracing::warn!("{reason}; canceling active updates and cleaning partial artifacts");
    crate::firmware::request_cancel();
    crate::os_update::request_cancel();
}

pub fn clear_cached_update_preferences() {
    CACHED_FIRMWARE_CHANNEL.lock().unwrap().take();
    CACHED_FIRMWARE_TARGET_VERSION.lock().unwrap().take();
    CACHED_OS_CHANNEL.lock().unwrap().take();
    CACHED_OS_TARGET_VERSION.lock().unwrap().take();
}

pub fn cached_firmware_channel() -> String {
    CACHED_FIRMWARE_CHANNEL
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "stable".to_string())
}
pub fn cached_os_channel() -> String {
    CACHED_OS_CHANNEL
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "stable".to_string())
}

pub fn cached_audio_default_volume() -> Option<u32> {
    *CACHED_AUDIO_DEFAULT_VOLUME.lock().unwrap()
}

fn apply_pending_managed_config(raw: &Value) {
    let pending = match serde_json::from_value::<PendingManagedConfig>(raw.clone()) {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!("managed-config: invalid pending config: {err}");
            return;
        }
    };
    let already_attempted = LAST_MANAGED_CONFIG_ATTEMPT
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(|(version, success)| version == pending.version && !success)
        .unwrap_or(false);
    if already_attempted {
        return;
    }

    let result = apply_managed_config(&pending.config);
    let success = result.is_ok();
    let error = result.err();
    if let Ok(mut report) = MANAGED_CONFIG_REPORT.lock() {
        *report = Some(ManagedConfigReport {
            version: pending.version,
            error: error.clone(),
        });
    }
    if let Ok(mut attempt) = LAST_MANAGED_CONFIG_ATTEMPT.lock() {
        *attempt = Some((pending.version, success));
    }
    match error {
        Some(err) => tracing::warn!("managed-config: version {} failed: {err}", pending.version),
        None => tracing::info!("managed-config: version {} applied", pending.version),
    }
}

fn apply_managed_config(config: &ManagedConfig) -> Result<(), String> {
    if let Some(tz) = config.timezone.as_deref() {
        apply_timezone(tz)?;
    }
    Ok(())
}

fn apply_timezone(timezone: &str) -> Result<(), String> {
    validate_timezone(timezone)?;
    let current = Command::new("timedatectl")
        .args(["show", "-p", "Timezone", "--value"])
        .output()
        .map_err(|e| format!("timedatectl show: {e}"))?;
    if current.status.success() {
        let current_tz = String::from_utf8_lossy(&current.stdout).trim().to_string();
        if current_tz == timezone {
            return Ok(());
        }
    }
    let helper = std::path::Path::new("/usr/local/sbin/betterframe-apply-managed-config.sh");
    let out = if helper.is_file() {
        let helper_path = helper.to_string_lossy().to_string();
        Command::new("sudo")
            .args(["-n", helper_path.as_str(), "timezone", timezone])
            .output()
    } else {
        Command::new("timedatectl")
            .args(["set-timezone", timezone])
            .output()
    }
    .map_err(|e| format!("set timezone: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(format!("timedatectl set-timezone failed: {stderr}"))
    }
}

fn validate_timezone(timezone: &str) -> Result<(), String> {
    if timezone.starts_with('/')
        || timezone.contains("..")
        || timezone.contains('\\')
        || !timezone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
    {
        return Err(format!("invalid timezone: {timezone}"));
    }
    let path = std::path::Path::new("/usr/share/zoneinfo").join(timezone);
    if path.is_file() {
        Ok(())
    } else {
        Err(format!("timezone not found: {timezone}"))
    }
}
