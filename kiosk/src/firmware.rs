//! Kiosk-side OTA update flow.
//!
//! 1. `check(server, key, arch, current_version)` → asks BF server if there's
//!    a newer release for this kiosk's channel/pin.
//! 2. `apply(server, key, info)` → downloads, verifies sha256 +
//!    Ed25519 signature (server's firmware-signing pubkey, PEM, embedded in
//!    the check response), atomically swaps the running binary, reports
//!    outcome, and exits so systemd's `Restart=always` brings up the new
//!    binary.
//!
//! Binary location: `/opt/betterframe/kiosk/betterframe-kiosk` (production
//! deploy via `deploy/scripts/setup-pi-kiosk.sh`). Override with env
//! `BF_KIOSK_BINARY`.
//!
//! Rollback: the previous binary is kept at `<bin>.prev` before the swap.
//! systemd's StartLimitBurst=10 catches a broken binary; an out-of-band
//! script (`/usr/local/bin/bf-rollback-firmware`, future) handles the
//! restore. For now this module only does forward updates.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey, pkcs8::DecodePublicKey};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tracing::{info, warn};

/// Build-time arch string baked into the binary so `check` can ask for the
/// right target. Falls back to "aarch64-unknown-linux-gnu" when not provided
/// (matches Pi5 default).
pub const ARCH: &str = match option_env!("BF_BUILD_ARCH") {
    Some(s) => s,
    None => "aarch64-unknown-linux-gnu",
};

const DEFAULT_BIN_PATH: &str = "/opt/betterframe/kiosk/betterframe-kiosk";
const FIRMWARE_MARKER: &str = "/var/lib/betterframe/kiosk/firmware-applying.json";
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);

fn binary_path() -> PathBuf {
    std::env::var("BF_KIOSK_BINARY")
        .unwrap_or_else(|_| DEFAULT_BIN_PATH.to_string())
        .into()
}

pub fn request_cancel() {
    CANCEL_REQUESTED.store(true, Ordering::SeqCst);
    cleanup_partial_update();
}

pub fn clear_cancel() {
    CANCEL_REQUESTED.store(false, Ordering::SeqCst);
}

fn cancel_requested() -> bool {
    CANCEL_REQUESTED.load(Ordering::SeqCst)
}

fn cleanup_partial_update() {
    let bin = binary_path();
    let _ = fs::remove_file(bin.with_extension("new"));
    let _ = fs::remove_file(FIRMWARE_MARKER);
}

#[derive(Debug, Deserialize)]
pub struct CheckResponse {
    pub up_to_date: bool,
    pub update: Option<UpdateInfo>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateInfo {
    #[allow(dead_code)] // surfaced for logging / future rollout coordination
    pub release_id: String,
    pub version: String,
    #[allow(dead_code)] // surfaced for logging
    pub channel: String,
    pub sha256: String,
    pub signature: String,
    pub size_bytes: u64,
    pub download_url: String,
    pub public_key_pem: String,
}

/// Public pre-boot firmware check — no auth needed. Always checks stable
/// channel. Used before pairing to self-update to latest binary.
pub fn check_public(server: &str, current_version: &str) -> Option<UpdateInfo> {
    let url = format!(
        "{server}/api/firmware/public/check?arch={arch}&current={cur}",
        arch = ARCH,
        cur = current_version,
    );
    let client = reqwest::blocking::Client::new();
    let resp = match client.get(&url).timeout(Duration::from_secs(10)).send() {
        Ok(r) => r,
        Err(err) => { warn!("preboot firmware check: {err}"); return None; }
    };
    if !resp.status().is_success() { return None; }
    match resp.json::<CheckResponse>() {
        Ok(c) if !c.up_to_date => c.update,
        _ => None,
    }
}

/// Public download + verify + swap — no auth. Used with check_public.
/// On success exits so systemd restarts with new binary.
pub fn apply_public(server: &str, info: &UpdateInfo) -> Result<(), String> {
    info!("preboot firmware: applying {} ({} bytes)", info.version, info.size_bytes);
    let download_url = format!("{server}{}", info.download_url);
    let client = reqwest::blocking::Client::new();
    let resp = client.get(&download_url)
        .timeout(Duration::from_secs(300))
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().map_err(|e| format!("read failed: {e}"))?;
    if bytes.len() as u64 != info.size_bytes {
        return Err(format!("size mismatch: expected {}, got {}", info.size_bytes, bytes.len()));
    }
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let got_sha = hex_lower(&hasher.finalize());
    if got_sha != info.sha256 {
        return Err(format!("sha256 mismatch: expected {}, got {}", info.sha256, got_sha));
    }
    verify_signature(&info.public_key_pem, &info.sha256, &info.signature)
        .map_err(|e| format!("signature verify: {e}"))?;

    let bin = binary_path();
    let new_path = bin.with_extension("new");
    let prev_path = bin.with_extension("prev");
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .create(true).write(true).truncate(true).mode(0o755)
            .open(&new_path)
            .map_err(|e| format!("open {}: {e}", new_path.display()))?;
        use std::io::Write;
        f.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    }
    if bin.exists() {
        let _ = fs::remove_file(&prev_path);
        let _ = fs::rename(&bin, &prev_path);
    }
    fs::rename(&new_path, &bin).map_err(|e| format!("rename: {e}"))?;
    info!("preboot firmware: updated to {}, rebooting", info.version);
    let _ = std::process::Command::new("systemctl").arg("reboot").status();
    std::thread::sleep(Duration::from_secs(30));
    std::process::exit(0);
}

/// Hit `/api/kiosk/firmware/check` and return the update info if one is
/// available. Returns `None` on up-to-date / network error / unparsable
/// response — never panics.
pub fn check(server: &str, key: &str, current_version: &str) -> Option<UpdateInfo> {
    let client = reqwest::blocking::Client::new();
    // current_version is semver-shaped (already URL-safe). Empty string is
    // fine — server treats it as "unknown" and offers any release.
    let url = format!(
        "{server}/api/kiosk/firmware/check?arch={arch}&current={cur}",
        arch = ARCH,
        cur = current_version,
    );
    let resp = match client
        .get(&url)
        .header("Authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(10))
        .send()
    {
        Ok(r) => r,
        Err(err) => {
            warn!("firmware check: request failed: {err}");
            return None;
        }
    };
    if !resp.status().is_success() {
        warn!("firmware check: HTTP {}", resp.status());
        return None;
    }
    match resp.json::<CheckResponse>() {
        Ok(c) if !c.up_to_date => c.update,
        Ok(_) => None,
        Err(err) => {
            warn!("firmware check: parse failed: {err}");
            None
        }
    }
}

/// Download + verify + swap. Reports outcome to the server. On success the
/// process exits with code 0 so systemd's Restart=always picks up the new
/// binary. On failure the function returns Err and the kiosk keeps running.
pub fn apply(
    server: &str,
    key: &str,
    info: &UpdateInfo,
    on_progress: impl Fn(&str, u8),
) -> Result<(), String> {
    info!("firmware: applying {} ({} bytes)", info.version, info.size_bytes);
    on_progress("Downloading", 0);

    // 1. Download
    let url = format!("{}{}", server, info.download_url);
    let client = reqwest::blocking::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(300))
        .send()
        .map_err(|e| format!("download request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let mut reader = resp;
    let mut bytes = Vec::with_capacity(info.size_bytes.min(64 * 1024 * 1024) as usize);
    let mut buf = [0u8; 256 * 1024];
    loop {
        if cancel_requested() {
            cleanup_partial_update();
            return Err("firmware update canceled after channel change".to_string());
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => bytes.extend_from_slice(&buf[..n]),
            Err(e) => return Err(format!("download body: {e}")),
        }
    }
    if bytes.len() as u64 != info.size_bytes {
        return Err(format!(
            "size mismatch: expected {}, got {}",
            info.size_bytes,
            bytes.len()
        ));
    }
    if cancel_requested() {
        cleanup_partial_update();
        return Err("firmware update canceled after channel change".to_string());
    }

    on_progress("Verifying", 70);
    // 2. sha256
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    let got_sha = hex_lower(&digest);
    if got_sha != info.sha256 {
        return Err(format!("sha256 mismatch: expected {}, got {}", info.sha256, got_sha));
    }

    // 3. Ed25519 signature verify (sig is over the hex-encoded sha256 string)
    verify_signature(&info.public_key_pem, &info.sha256, &info.signature)
        .map_err(|e| format!("signature verify: {e}"))?;
    if cancel_requested() {
        cleanup_partial_update();
        return Err("firmware update canceled after channel change".to_string());
    }

    on_progress("Applying", 90);
    // 4. Atomic swap
    let bin = binary_path();
    let new_path = bin.with_extension("new");
    let prev_path = bin.with_extension("prev");

    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode_for_unix(0o755)
            .open(&new_path)
            .map_err(|e| format!("open {}: {e}", new_path.display()))?;
        f.write_all(&bytes).map_err(|e| format!("write {}: {e}", new_path.display()))?;
        f.sync_all().ok();
    }
    if cancel_requested() {
        cleanup_partial_update();
        return Err("firmware update canceled after channel change".to_string());
    }

    // Drop a marker file the systemd ExecStartPre script reads to detect a
    // failed first boot of the new binary. We delete it after a clean boot
    // (see `mark_firmware_applied()`). If we crash before that, next start
    // sees a stale marker → restores .prev.
    {
        let marker = PathBuf::from(FIRMWARE_MARKER);
        let payload = serde_json::json!({
            "version": info.version,
            "attempt_at": chrono_now_iso(),
            "bin": bin.to_string_lossy(),
            "prev": prev_path.to_string_lossy(),
        });
        let _ = fs::write(&marker, payload.to_string());
    }
    if cancel_requested() {
        cleanup_partial_update();
        return Err("firmware update canceled after channel change".to_string());
    }

    // Save current binary as .prev so an out-of-band rollback can restore it.
    if bin.exists() {
        let _ = fs::remove_file(&prev_path);
        if let Err(e) = fs::rename(&bin, &prev_path) {
            warn!("firmware: could not stash previous binary: {e}");
        }
    }
    fs::rename(&new_path, &bin).map_err(|e| format!("rename → {}: {e}", bin.display()))?;

    // 5. Tell the server we're about to apply.
    let _ = client
        .post(format!("{server}/api/kiosk/firmware/applied"))
        .header("Authorization", format!("Bearer {key}"))
        .json(&serde_json::json!({ "version": info.version }))
        .timeout(Duration::from_secs(5))
        .send();

    on_progress("Rebooting", 100);
    info!("firmware: swap complete → rebooting to pick up new binary");
    match std::process::Command::new("systemctl").arg("reboot").status() {
        Ok(_) => {
            std::thread::sleep(Duration::from_secs(30));
            std::process::exit(0);
        }
        Err(e) => {
            info!("systemctl reboot failed: {e}, falling back to exit");
            std::process::exit(0);
        }
    }
}

fn verify_signature(public_key_pem: &str, sha256_hex: &str, sig_b64url: &str) -> Result<(), String> {
    let vk = VerifyingKey::from_public_key_pem(public_key_pem)
        .map_err(|e| format!("parse pubkey: {e}"))?;
    let sig_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(sig_b64url.trim_end_matches('='))
        .map_err(|e| format!("decode signature: {e}"))?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("signature shape: {e}"))?;
    vk.verify(sha256_hex.as_bytes(), &sig)
        .map_err(|e| format!("verify: {e}"))
}

/// Clear the in-progress marker. Call after the kiosk has booted cleanly and
/// reported back to the server — proves the new binary survives startup.
pub fn mark_firmware_applied() {
    let marker = PathBuf::from(FIRMWARE_MARKER);
    if marker.exists() {
        let _ = fs::remove_file(marker);
    }
}

fn chrono_now_iso() -> String {
    // Sidesteps adding a chrono dep — Unix epoch ms is enough for the
    // ExecStartPre rollback check.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

// Helper trait so OpenOptions.mode_for_unix(0o755) compiles cross-platform.
// On non-unix we no-op the mode bits — kiosk doesn't run on Windows in prod
// but the unit tests / IDE check on dev machines need to compile.
trait OpenOptionsModeExt {
    fn mode_for_unix(&mut self, mode: u32) -> &mut Self;
}

#[cfg(unix)]
impl OpenOptionsModeExt for fs::OpenOptions {
    fn mode_for_unix(&mut self, mode: u32) -> &mut Self {
        use std::os::unix::fs::OpenOptionsExt;
        self.mode(mode)
    }
}

#[cfg(not(unix))]
impl OpenOptionsModeExt for fs::OpenOptions {
    fn mode_for_unix(&mut self, _mode: u32) -> &mut Self { self }
}
