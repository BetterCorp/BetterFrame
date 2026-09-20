//! Kiosk-side OTA update flow.
//!
//! 1. `check(server, key, arch, current_version)` → asks BF server if there's
//!    a newer release for this kiosk's channel/pin.
//! 2. `apply(server, key, info)` → downloads, verifies sha256 +
//!    Ed25519 signature against the vendor key embedded at build time,
//!    atomically swaps the running binary, reports
//!    outcome, and exits so systemd's `Restart=always` brings up the new
//!    binary.
//!
//! Binary location: `/opt/betterframe/kiosk/betterframe-kiosk` (production
//! deploy via `deploy/scripts/setup-pi-kiosk.sh`). Override with env
//! `BF_KIOSK_BINARY`.
//!
//! Rollback: the previous binary is kept at `<bin>.prev` before the swap.
//! The service's ExecStartPre rollback helper restores unconfirmed candidates
//! after repeated failed starts. App updates never reboot the operating system.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

static MARKER_LOCK: Mutex<()> = Mutex::new(());
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

pub const FIRMWARE_TARGET: &str = match option_env!("BF_FIRMWARE_TARGET") {
    Some(s) => s,
    None => ARCH,
};

const DEFAULT_BIN_PATH: &str = "/opt/betterframe/kiosk/betterframe-kiosk";
const FIRMWARE_MARKER: &str = "/var/lib/betterframe/kiosk/firmware-applying.json";
const FIRMWARE_ATTEMPTS: &str = "/var/lib/betterframe/kiosk/firmware-applying.attempts";
const MAX_FIRMWARE_BYTES: u64 = 256 * 1024 * 1024;
static CANCEL_REQUESTED: AtomicBool = AtomicBool::new(false);
const FIRMWARE_SIGNING_PUBLIC_KEY: Option<&str> = option_env!("BF_FIRMWARE_SIGNING_PUBLIC_KEY");

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
    let _ = fs::remove_file(FIRMWARE_ATTEMPTS);
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
}

/// Public pre-boot firmware check — no auth needed. Always checks stable
/// channel. Used before pairing to self-update to latest binary.
pub fn check_public(server: &str, current_version: &str) -> Option<UpdateInfo> {
    let url = format!(
        "{server}/api/firmware/public/check?target={target}&arch={arch}&current={cur}",
        target = FIRMWARE_TARGET,
        arch = ARCH,
        cur = current_version,
    );
    let client = crate::network::blocking_client();
    let resp = match client.get(&url).timeout(Duration::from_secs(10)).send() {
        Ok(r) => r,
        Err(err) => {
            warn!("preboot firmware check: {err}");
            return None;
        }
    };
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<CheckResponse>()
        .ok()
        .and_then(|check| newer_update(check, current_version))
}

/// Public download + verify + swap — no auth. Used with check_public.
/// On success exits so systemd restarts with new binary.
pub fn apply_public(server: &str, info: &UpdateInfo) -> Result<(), String> {
    ensure_upgrade(info, crate::server::kiosk_app_version())?;
    info!(
        "preboot firmware: applying {} ({} bytes)",
        info.version, info.size_bytes
    );
    let download_url = format!("{server}{}", info.download_url);
    let client = crate::network::blocking_client();
    let resp = client
        .get(&download_url)
        .timeout(Duration::from_secs(300))
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = read_firmware_body(resp, info.size_bytes, || false)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let got_sha = hex_lower(&hasher.finalize());
    if got_sha != info.sha256 {
        return Err(format!(
            "sha256 mismatch: expected {}, got {}",
            info.sha256, got_sha
        ));
    }
    verify_signature(&info.sha256, &info.signature)
        .map_err(|e| format!("signature verify: {e}"))?;

    let bin = binary_path();
    let new_path = bin.with_extension("new");
    let prev_path = bin.with_extension("prev");
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o755)
            .open(&new_path)
            .map_err(|e| format!("open {}: {e}", new_path.display()))?;
        use std::io::Write;
        f.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
        f.sync_all().map_err(|e| format!("sync app: {e}"))?;
    }
    write_pending_marker(
        &info.version,
        &bin,
        &prev_path,
        Path::new(FIRMWARE_MARKER),
        Path::new(FIRMWARE_ATTEMPTS),
    )?;
    if bin.exists() {
        let _ = fs::remove_file(&prev_path);
        let _ = fs::rename(&bin, &prev_path);
    }
    fs::rename(&new_path, &bin).map_err(|e| format!("rename: {e}"))?;
    info!("app updated to {}; restarting BetterFrame", info.version);
    // The service owns process restart. An app update must never reboot the OS.
    std::process::exit(0);
}

/// Hit `/api/kiosk/firmware/check` and return the update info if one is
/// available. Returns `None` on up-to-date / network error / unparsable
/// response — never panics.
pub fn check(server: &str, key: &str, current_version: &str) -> Option<UpdateInfo> {
    let client = crate::network::blocking_client();
    // current_version is semver-shaped (already URL-safe). Empty string is
    // fine — server treats it as "unknown" and offers any release.
    let url = format!(
        "{server}/api/kiosk/firmware/check?target={target}&arch={arch}&current={cur}",
        target = FIRMWARE_TARGET,
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
        Ok(c) => newer_update(c, current_version),
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
    ensure_upgrade(info, crate::server::kiosk_app_version())?;
    info!(
        "firmware: applying {} ({} bytes)",
        info.version, info.size_bytes
    );
    on_progress("Downloading", 0);

    // 1. Download
    let url = format!("{}{}", server, info.download_url);
    let client = crate::network::blocking_client();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {key}"))
        .timeout(Duration::from_secs(300))
        .send()
        .map_err(|e| format!("download request: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("download HTTP {}", resp.status()));
    }
    let bytes = read_firmware_body(resp, info.size_bytes, cancel_requested).map_err(|err| {
        if cancel_requested() {
            cleanup_partial_update();
        }
        err
    })?;
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
        return Err(format!(
            "sha256 mismatch: expected {}, got {}",
            info.sha256, got_sha
        ));
    }

    // 3. Ed25519 signature verify (sig is over the hex-encoded sha256 string)
    verify_signature(&info.sha256, &info.signature)
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
        f.write_all(&bytes)
            .map_err(|e| format!("write {}: {e}", new_path.display()))?;
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
    write_pending_marker(
        &info.version,
        &bin,
        &prev_path,
        Path::new(FIRMWARE_MARKER),
        Path::new(FIRMWARE_ATTEMPTS),
    )?;
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

    on_progress("Restarting app", 100);
    info!("app: swap complete; restarting BetterFrame");
    // Restart=always also covers this successful exit after an atomic swap.
    std::process::exit(0);
}

// Both enrolled and pre-pairing updates must arm rollback before swapping.
// Failure to persist this marker aborts the update while the old binary remains.
fn write_pending_marker(
    version: &str,
    bin: &Path,
    prev: &Path,
    marker: &Path,
    attempts: &Path,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "version": version, "attempt_at": chrono_now_iso(), "confirmed": false,
        "bin": bin.to_string_lossy(), "prev": prev.to_string_lossy(),
    });
    persist_pending_marker(
        marker,
        attempts,
        payload.to_string().as_bytes(),
        |file, bytes| {
            file.write_all(bytes)?;
            file.sync_all()
        },
    )
}

fn persist_pending_marker(
    marker: &Path,
    attempts: &Path,
    payload: &[u8],
    write_and_sync: impl FnOnce(&mut fs::File, &[u8]) -> std::io::Result<()>,
) -> Result<(), String> {
    let _guard = MARKER_LOCK.lock().unwrap();
    let temporary = marker.with_file_name(format!(
        ".bf-app-marker-{}-{:016x}.tmp",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode_for_unix(0o600)
            .open(&temporary)
            .map_err(|e| format!("create temporary app rollback marker: {e}"))?;
        write_and_sync(&mut file, payload)
            .map_err(|e| format!("persist app rollback marker: {e}"))?;
        match fs::remove_file(attempts) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("reset app startup attempts: {err}")),
        }
        fs::rename(&temporary, marker).map_err(|e| format!("publish app rollback marker: {e}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn newer_update(check: CheckResponse, current_version: &str) -> Option<UpdateInfo> {
    if check.up_to_date {
        return None;
    }
    let update = check.update.filter(|update| {
        crate::core::version::is_version_upgrade(&update.version, current_version)
    });
    if update.is_none() {
        warn!("firmware: refusing non-upgrade offered for installed version {current_version}");
    }
    update
}

fn ensure_upgrade(info: &UpdateInfo, current_version: &str) -> Result<(), String> {
    if crate::core::version::is_version_upgrade(&info.version, current_version) {
        Ok(())
    } else {
        Err(format!(
            "refusing firmware downgrade or reinstall: installed {current_version}, offered {}",
            info.version
        ))
    }
}

fn read_firmware_body(
    mut reader: impl Read,
    expected_size: u64,
    canceled: impl Fn() -> bool,
) -> Result<Vec<u8>, String> {
    if expected_size > MAX_FIRMWARE_BYTES {
        return Err(format!(
            "firmware size {expected_size} exceeds {MAX_FIRMWARE_BYTES} byte limit"
        ));
    }
    let mut bytes = Vec::with_capacity(expected_size.min(64 * 1024 * 1024) as usize);
    let mut buf = [0u8; 256 * 1024];
    loop {
        if canceled() {
            return Err("firmware update canceled after channel change".to_string());
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("download body: {e}"))?;
        if n == 0 {
            break;
        }
        if n as u64 > expected_size.saturating_sub(bytes.len() as u64) {
            return Err(format!(
                "size mismatch: expected {expected_size}, download exceeded limit"
            ));
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    if bytes.len() as u64 != expected_size {
        return Err(format!(
            "size mismatch: expected {expected_size}, got {}",
            bytes.len()
        ));
    }
    Ok(bytes)
}

fn verify_signature(sha256_hex: &str, sig_b64url: &str) -> Result<(), String> {
    let public_key_pem = FIRMWARE_SIGNING_PUBLIC_KEY
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            "OTA disabled: vendor signing key was not embedded in this build".to_string()
        })?;
    verify_signature_with_key(public_key_pem, sha256_hex, sig_b64url)
}

fn verify_signature_with_key(
    public_key_pem: &str,
    sha256_hex: &str,
    sig_b64url: &str,
) -> Result<(), String> {
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
    if let Some(version) = confirm_pending_marker(
        Path::new(FIRMWARE_MARKER),
        Path::new(FIRMWARE_ATTEMPTS),
        crate::server::kiosk_app_version(),
        Path::new("/proc/self/exe"),
    ) {
        if !version.is_empty() {
            crate::update_guard::record_success("firmware", &version);
        }
    }
}

// Never let a final heartbeat/UI frame from the old process confirm an update
// which has been staged on disk but has not run yet. Setup also supports trusted
// local builds with the same version, so its marker uses the executable hash.
fn confirm_pending_marker(
    marker: &Path,
    attempts: &Path,
    running_version: &str,
    executable: &Path,
) -> Option<String> {
    let _guard = MARKER_LOCK.lock().unwrap();
    let value: serde_json::Value = serde_json::from_slice(&fs::read(marker).ok()?).ok()?;
    let version = value.get("version")?.as_str()?;
    if let Some(expected) = value.get("sha256").and_then(|value| value.as_str()) {
        let mut file = fs::File::open(executable).ok()?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let size = file.read(&mut buffer).ok()?;
            if size == 0 {
                break;
            }
            digest.update(&buffer[..size]);
        }
        if hex_lower(&digest.finalize()) != expected {
            return None;
        }
    } else if version.is_empty()
        || version.trim_start_matches('v') != running_version.trim_start_matches('v')
    {
        return None;
    }
    fs::remove_file(marker).ok()?;
    let _ = fs::remove_file(attempts);
    Some(version.to_owned())
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
    fn mode_for_unix(&mut self, _mode: u32) -> &mut Self {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::{read_firmware_body, verify_signature_with_key};
    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::{Cursor, Write};

    #[test]
    fn pending_marker_arms_rollback_and_resets_stale_attempts() {
        let root = std::env::temp_dir().join(format!("bf-app-marker-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("applying.json");
        let attempts = root.join("attempts");
        let bin = root.join("app");
        let prev = root.join("app.prev");
        std::fs::write(&bin, b"existing app").unwrap();
        std::fs::write(&attempts, b"99").unwrap();
        super::write_pending_marker("1.2.3", &bin, &prev, &marker, &attempts).unwrap();
        let payload: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
        assert_eq!(payload["version"], "1.2.3");
        assert_eq!(payload["confirmed"], false);
        assert_eq!(payload["prev"], prev.to_string_lossy().as_ref());
        assert!(!attempts.exists());
        assert_eq!(std::fs::read(&bin).unwrap(), b"existing app");
        assert!(
            super::write_pending_marker(
                "1.2.4",
                &bin,
                &prev,
                &root.join("missing/marker"),
                &attempts
            )
            .is_err()
        );
        assert_eq!(std::fs::read(&bin).unwrap(), b"existing app");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn partial_marker_write_preserves_existing_marker_and_attempts() {
        let root = std::env::temp_dir().join(format!("bf-marker-atomic-{}", rand::random::<u64>()));
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("marker");
        let attempts = root.join("attempts");
        fs::write(&marker, b"existing valid marker").unwrap();
        fs::write(&attempts, b"2").unwrap();
        let result =
            super::persist_pending_marker(&marker, &attempts, b"new payload", |file, _| {
                file.write_all(b"partial")?;
                Err(std::io::Error::from_raw_os_error(28)) // ENOSPC after a partial write.
            });
        assert!(result.is_err());
        assert_eq!(fs::read(&marker).unwrap(), b"existing valid marker");
        assert_eq!(fs::read(&attempts).unwrap(), b"2");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_file(&marker).unwrap();
        assert!(
            super::persist_pending_marker(&marker, &attempts, b"new", |_, _| Err(
                std::io::Error::from_raw_os_error(5)
            ))
            .is_err()
        );
        assert!(!marker.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn healthy_unpaired_candidate_confirms_only_its_own_marker() {
        let root =
            std::env::temp_dir().join(format!("bf-marker-confirm-{}", rand::random::<u64>()));
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("marker");
        let attempts = root.join("attempts");
        let binary = root.join("running");
        fs::write(&binary, b"running candidate").unwrap();
        fs::write(&attempts, b"1").unwrap();
        fs::write(&marker, r#"{"version":"1.2.3"}"#).unwrap();
        assert!(super::confirm_pending_marker(&marker, &attempts, "1.2.2", &binary).is_none());
        assert!(marker.exists());
        assert_eq!(
            super::confirm_pending_marker(&marker, &attempts, "1.2.3", &binary).as_deref(),
            Some("1.2.3")
        );
        assert!(!marker.exists());
        assert!(!attempts.exists());
        let payload = serde_json::json!({"version":"", "sha256":super::hex_lower(&Sha256::digest(b"running candidate"))});
        fs::write(&marker, payload.to_string()).unwrap();
        fs::write(&binary, b"old running process").unwrap();
        assert!(super::confirm_pending_marker(&marker, &attempts, "1.2.3", &binary).is_none());
        assert!(marker.exists());
        fs::write(&binary, b"running candidate").unwrap();
        assert_eq!(
            super::confirm_pending_marker(&marker, &attempts, "local", &binary).as_deref(),
            Some("")
        );
        assert!(!marker.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn firmware_body_is_bounded_by_declared_size() {
        let error = read_firmware_body(Cursor::new(vec![0; 5]), 4, || false).unwrap_err();
        assert!(error.contains("exceeded limit"));
        assert!(
            read_firmware_body(Cursor::new([]), super::MAX_FIRMWARE_BYTES + 1, || false).is_err()
        );
    }

    #[test]
    fn signature_is_verified_with_the_configured_key() {
        let signing_key = SigningKey::from_bytes(&[7; 32]);
        let public_key = signing_key
            .verifying_key()
            .to_public_key_pem(Default::default())
            .unwrap();
        let digest = "0123456789abcdef";
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(signing_key.sign(digest.as_bytes()).to_bytes());

        assert!(verify_signature_with_key(&public_key, digest, &signature).is_ok());
        assert!(verify_signature_with_key(&public_key, "changed", &signature).is_err());
    }
}
