use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::core::protocol::{DeviceIdentity, PairClaimResponse, PairInitiateResponse};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
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
            Some(serde_json::json!({
                "name": name,
                "mac": item.get("address").and_then(|v| v.as_str()),
                "operstate": item.get("operstate").and_then(|v| v.as_str()),
                "ips": ips,
            }))
        })
        .collect()
}

fn format_startup_network_summary(interfaces: &[Value]) -> (String, String) {
    let interfaces: Vec<&Value> = interfaces
        .iter()
        .filter(|item| item["name"] != "lo")
        .collect();
    let macs: Vec<String> = interfaces
        .iter()
        .filter_map(|item| {
            Some(format!(
                "{} {}",
                item["name"].as_str()?,
                item["mac"].as_str()?
            ))
        })
        .collect();
    let ips: Vec<&str> = interfaces
        .iter()
        .flat_map(|item| item["ips"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .filter(|ip| !ip.starts_with("fe80:") && !ip.starts_with("127.") && *ip != "::1/128")
        .collect();
    (
        if macs.is_empty() {
            "searching".into()
        } else {
            macs.join(", ")
        },
        if ips.is_empty() {
            "searching".into()
        } else {
            ips.join(", ")
        },
    )
}

pub fn startup_network_summary() -> (String, String) {
    format_startup_network_summary(&read_network_interfaces())
}

#[cfg(test)]
fn state_dir() -> PathBuf {
    static DIRECTORY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    DIRECTORY
        .get_or_init(|| {
            let path = std::env::temp_dir()
                .join(format!("betterframe-client-test-{}", rand::random::<u64>()));
            fs::create_dir_all(&path).unwrap();
            path
        })
        .clone()
}

#[cfg(not(test))]
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
    static IMPORT: Mutex<()> = Mutex::new(());
    let _import = IMPORT.lock().unwrap_or_else(|error| error.into_inner());
    let Some(home) = dirs::home_dir() else {
        return;
    };
    let legacy = home.join(".betterframe-kiosk");
    if let Err(error) = import_legacy_state(&legacy, persistent) {
        tracing::warn!("failed to import legacy kiosk state: {error}");
    }
}

fn import_legacy_state(legacy: &std::path::Path, persistent: &std::path::Path) -> std::io::Result<()> {
    use std::io::Write;
    let complete = persistent.join(".legacy-state-imported");
    if fs::read(&complete).is_ok_and(|bytes| bytes == b"complete-v1\n") {
        return Ok(());
    }
    if !legacy.is_dir() {
        return Ok(());
    }

    for name in [
        "identity.json",
        "pairing.json",
        "origin-migration.json",
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
            let temporary = persistent.join(format!(".{name}.{}.tmp", rand::random::<u64>()));
            let result = (|| {
                fs::copy(&src, &temporary)?;
                fs::File::open(&temporary)?.sync_all()?;
                fs::rename(&temporary, &dst)
            })();
            if result.is_err() {
                let _ = fs::remove_file(temporary);
            }
            result?;
        }
    }
    // Commit all imported filenames before acknowledging the source directory.
    // A recovered/deleted journal must never be copied back on the next lookup.
    fs::File::open(persistent)?.sync_all()?;
    let temporary = persistent.join(".legacy-state-imported.tmp");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(b"complete-v1\n")?;
    file.sync_all()?;
    fs::rename(temporary, complete)?;
    fs::File::open(persistent)?.sync_all()
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

/// Read credentials without discovery/network access; logging never drives enrollment.
pub fn log_destination() -> Option<crate::diagnostic_logs::Destination> {
    if identity_file().exists() {
        let identity = load_identity().ok()?;
        return Some(crate::diagnostic_logs::Destination {
            server: identity.server_url, key: identity.kiosk_key, kiosk_id: identity.kiosk_id,
        });
    }
    Some(crate::diagnostic_logs::Destination {
        server: fs::read_to_string(server_file()).ok()?.trim().to_string(),
        key: load_key().ok()?, kiosk_id: load_kiosk_id()?,
    })
}

pub fn load_kiosk_id() -> Option<String> {
    load_identity()
        .ok()
        .map(|identity| identity.kiosk_id)
        .or_else(|| load_cached_bundle().map(|b| b.kiosk_id))
}

/// Discover anonymously once, then use the saved regional origin on every restart.
pub fn discover_server(override_url: Option<&str>) -> Result<String, String> {
    recover_origin_migration()?;
    if identity_file().exists() {
        // Existing credentials stay bound to their origin and paired offline boot
        // must never depend on contacting the global discovery service.
        return Ok(load_identity()?.server_url);
    }
    let pending_path = state_dir().join("pairing.json");
    if pending_path.exists() {
        let bytes = crate::at_rest::read_maybe_encrypted(&pending_path)
            .ok_or("Unable to read saved pairing session; restore storage or reset locally")?;
        let (origin, _session): (String, PairInitiateResponse) = serde_json::from_slice(&bytes)
            .map_err(|_| "Invalid saved pairing session; restore storage or reset locally")?;
        return Ok(origin);
    }
    let saved = fs::read_to_string(server_file()).ok()
        .map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if is_paired() {
        return saved.ok_or_else(|| "Saved kiosk key has no server origin; restore storage or reset locally".into());
    }

    let save = |origin: String| -> Result<String, String> {
        // Do not initiate enrollment unless its selected origin survives a restart.
        let path = server_file();
        let temporary = path.with_extension("url.tmp");
        fs::write(&temporary, &origin).and_then(|()| fs::rename(&temporary, &path))
            .map_err(|error| format!("Unable to save discovered server: {error}"))?;
        Ok(origin)
    };
    if let Some(url) = override_url.map(str::trim).filter(|url| !url.is_empty()) {
        return save(crate::network::discover(url, true)?);
    }
    if let Some(saved) = saved {
        return Ok(saved);
    }
    for url in crate::core::protocol::SERVER_CANDIDATES {
        info!("trying {url}...");
        if let Ok(resolved) = crate::network::discover(url, false) {
            return save(resolved);
        }
    }
    Err("Could not find BetterFrame server".into())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct OriginMigration {
    target: String,
}

fn migration_file() -> PathBuf { state_dir().join("origin-migration.json") }

fn persist_server_origin(origin: &str) -> Result<(), String> {
    use std::io::Write;
    let path = server_file();
    let temporary = path.with_extension("url.tmp");
    let mut file = fs::File::create(&temporary).map_err(|error| error.to_string())?;
    file.write_all(origin.as_bytes()).and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temporary, &path))
        .and_then(|()| fs::File::open(state_dir())?.sync_all())
        .map_err(|error| format!("Unable to save server origin: {error}"))
}

/// Complete a journaled origin update before startup selects its server.
/// Every record accepts the old or final origin, making interrupted writes retryable.
fn recover_origin_migration() -> Result<(), String> {
    let journal = migration_file();
    if !journal.exists() { return Ok(()); }
    let bytes = crate::at_rest::read_maybe_encrypted(&journal).ok_or("Unable to read origin migration")?;
    let migration: OriginMigration = serde_json::from_slice(&bytes).map_err(|_| "Invalid origin migration")?;
    let target = crate::core::protocol::discovery_probe(&migration.target)?;
    if target.scheme() != "https" { return Err("Invalid migration target".into()); }
    let allowed = |origin: &str| origin == migration.target || crate::core::protocol::needs_regional_migration(origin);
    // Validate all records before replacing any one of them.
    let identity = if identity_file().exists() {
        let mut identity = load_identity()?;
        if !allowed(&identity.server_url) { return Err("Identity does not match origin migration".into()); }
        identity.server_url = migration.target.clone();
        Some(identity)
    } else { None };
    let pending_path = state_dir().join("pairing.json");
    let pending = if pending_path.exists() {
        let bytes = crate::at_rest::read_maybe_encrypted(&pending_path).ok_or("Unable to read pending enrollment")?;
        let (origin, session): (String, PairInitiateResponse) = serde_json::from_slice(&bytes)
            .map_err(|_| "Invalid pending enrollment")?;
        if !allowed(&origin) { return Err("Pending enrollment does not match origin migration".into()); }
        Some((migration.target.clone(), session))
    } else { None };
    if let Ok(saved) = fs::read_to_string(server_file()) {
        if !allowed(saved.trim()) { return Err("Saved server does not match origin migration".into()); }
    }
    if let Some(identity) = identity {
        crate::at_rest::write_encrypted(&identity_file(), &serde_json::to_vec(&identity).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    if let Some(pending) = pending {
        crate::at_rest::write_encrypted(&pending_path, &serde_json::to_vec(&pending).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
    }
    persist_server_origin(&migration.target)?;
    fs::remove_file(journal).and_then(|()| fs::File::open(state_dir())?.sync_all())
        .map_err(|error| error.to_string())
}

pub fn migrate_canonical_origin(origin: &str) -> Result<String, String> {
    migrate_canonical_origin_with(origin, |url| crate::network::discover(url, true))
}

fn migrate_canonical_origin_with(origin: &str, discover: impl FnOnce(&str) -> Result<String, String>) -> Result<String, String> {
    if !crate::core::protocol::needs_regional_migration(origin) { return Ok(origin.to_string()); }
    if migration_file().exists() {
        recover_origin_migration()?;
        return fs::read_to_string(server_file()).map_err(|error| error.to_string());
    }
    let discovered = discover(origin)?; // Anonymous; no identity or polling material is supplied.
    let destination = crate::core::protocol::discovery_probe(&discovered)?;
    if destination.scheme() != "https" { return Err("Regional migration requires HTTPS".into()); }
    let target = crate::core::protocol::server_origin(&destination);
    if target == origin { return Ok(target); }
    let migration = OriginMigration { target: target.clone() };
    crate::at_rest::write_encrypted(&migration_file(), &serde_json::to_vec(&migration).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    recover_origin_migration()?;
    Ok(target)
}

/// Check if already paired (key file exists).
pub fn is_paired() -> bool {
    identity_file().exists() || key_file().exists()
}

/// Confirm with the server that our key is truly rejected before wiping.
/// Calls /api/kiosk/_check — if 200 the key is still valid (false alarm).
fn confirm_deletion(server: &str, key: &str) -> bool {
    let client = crate::network::blocking_client();
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
        "identity.json",
        "pairing.json",
        "origin-migration.json",
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
pub fn demo_mode() -> bool { load_identity().map(|identity| identity.demo).unwrap_or(false) }

pub fn demo_session() -> Option<(String, PairInitiateResponse)> {
    let bytes = crate::at_rest::read_maybe_encrypted(&state_dir().join("pairing.json"))?;
    let pending: (String, PairInitiateResponse) = serde_json::from_slice(&bytes).ok()?;
    (pending.1.allow_demo && !is_paired()).then_some(pending)
}

pub fn enter_demo() -> Result<(), String> {
    let (origin, session) = demo_session().ok_or("Demo unavailable")?;
    let response = pairing_client()?.post(format!("{origin}/api/pair/demo"))
        .json(&crate::core::protocol::claim_body(&session.code, session.polling_secret.as_deref()))
        .send().map_err(|error| error.to_string())?;
    if !response.status().is_success() { return Err("Demo unavailable; continue normal pairing or restart to retry".into()); }
    Ok(())
}

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

fn identity_file() -> PathBuf {
    state_dir().join("identity.json")
}

fn load_identity() -> Result<DeviceIdentity, String> {
    let bytes = crate::at_rest::read_maybe_encrypted(&identity_file())
        .ok_or("Unable to read saved device identity")?;
    let identity: DeviceIdentity =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid saved device identity")?;
    identity.validate()?;
    Ok(identity)
}

pub fn load_cluster_key() -> Option<String> {
    if identity_file().exists() {
        return load_identity().ok()?.cluster_key;
    }
    crate::at_rest::read_text_maybe_encrypted(&cluster_key_file())
}

/// Keep legacy readers for existing deployments; a damaged new identity must
/// never silently fall back to an older bearer token or start a new enrollment.
pub fn load_key() -> Result<String, String> {
    if identity_file().exists() {
        return Ok(load_identity()?.kiosk_key);
    }
    crate::at_rest::read_text_maybe_encrypted(&key_file())
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "Unable to read saved kiosk key".into())
}

fn pairing_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())
}

/// Persist the polling secret before displaying the code so a reboot can
/// retrieve an already confirmed claim instead of creating an orphan kiosk.
pub fn initiate_pairing(server: &str) -> Result<PairInitiateResponse, String> {
    let pending_path = state_dir().join("pairing.json");
    if pending_path.exists() {
        let bytes = crate::at_rest::read_maybe_encrypted(&pending_path)
            .ok_or("Unable to read saved pairing session; restore storage or reset locally")?;
        let (origin, session) = serde_json::from_slice::<(String, PairInitiateResponse)>(&bytes)
            .map_err(|_| "Invalid saved pairing session; restore storage or reset locally")?;
        if origin != server || session.code.trim().is_empty() {
            return Err("Saved pairing session does not match this server; reset locally to change enrollment".into());
        }
        return Ok(session);
    }
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "kiosk".into());
    let hw_model = fs::read_to_string("/proc/device-tree/model")
        .unwrap_or_else(|_| "unknown".into())
        .replace('\0', "");
    let resp: PairInitiateResponse = pairing_client()?
        .post(format!("{server}/api/pair/initiate"))
        .json(&serde_json::json!({
            "proposed_name": hostname,
            "hardware_model": hw_model,
            "firmware_target": crate::firmware::FIRMWARE_TARGET,
            "capabilities": ["rtsp", "gstreamer", "gtk4"],
            "managed_image": std::path::Path::new("/etc/betterframe/managed-image").is_file(),
            "secure_claim": true
        }))
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("Pairing connection failed: {error}"))?
        .json()
        .map_err(|error| format!("Invalid pairing response: {error}"))?;
    if resp.code.trim().is_empty() {
        return Err("Server returned an empty pairing code".into());
    }
    let bytes = serde_json::to_vec(&(server, &resp)).map_err(|error| error.to_string())?;
    crate::at_rest::write_encrypted(&pending_path, &bytes)
        .map_err(|error| format!("Unable to save pairing session: {error}"))?;
    Ok(resp)
}

fn encrypt_key_file() -> PathBuf {
    state_dir().join("encrypt.key")
}

pub fn load_encrypt_key() -> Option<String> {
    if identity_file().exists() {
        return load_identity().ok()?.encrypt_key;
    }
    crate::at_rest::read_text_maybe_encrypted(&encrypt_key_file())
}

/// Retry delivery acknowledgments on startup and bundle retrieval. Unsupported
/// legacy servers simply retain their normal delivery window.
pub fn acknowledge_identity(server: &str) {
    let Ok(mut identity) = load_identity() else {
        return;
    };
    if identity.server_url != server || identity.pairing_code.is_empty() {
        return;
    }
    let Ok(client) = pairing_client() else {
        return;
    };
    if let Ok(response) = client
        .post(format!("{server}/api/pair/ack"))
        .bearer_auth(&identity.kiosk_key)
        .json(&crate::core::protocol::claim_body(
            &identity.pairing_code,
            identity.polling_secret.as_deref(),
        ))
        .send()
    {
        if response.status().is_success() {
            identity.pairing_code.clear();
            identity.polling_secret = None;
            if let Ok(bytes) = serde_json::to_vec(&identity) {
                let _ = crate::at_rest::write_encrypted(&identity_file(), &bytes);
            }
        }
    }
}

pub fn poll_claim_until_expiry(
    server: &str,
    session: &PairInitiateResponse,
    status: impl Fn(&str),
) -> Option<(String, String)> {
    let mut deadline = Instant::now() + session.lifetime();
    let mut delay = session.poll_delay();
    loop {
        let response = pairing_client().and_then(|client| {
            client
                .post(format!("{server}/api/pair/claim"))
                .json(&crate::core::protocol::claim_body(
                    &session.code,
                    session.polling_secret.as_deref(),
                ))
                .send()
                .map_err(|error| error.to_string())
        });
        let claim = match response {
            Ok(response) if response.status().is_success() || response.status().as_u16() == 503 => {
                response
                    .json::<PairClaimResponse>()
                    .map_err(|error| format!("Invalid pairing response: {error}"))
            }
            Ok(response) => {
                if let Some(seconds) = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                {
                    delay = Duration::from_secs(seconds.clamp(1, 60));
                }
                Err(format!("Pairing server returned {}", response.status()))
            }
            Err(error) => Err(format!("Pairing connection failed: {error}")),
        };
        match claim {
            Ok(claim) if claim.status == "expired" => break,
            Ok(claim) if claim.status == "revoked" || claim.status == "acknowledged" => {
                if claim.status == "acknowledged" {
                    if let Ok(identity) = load_identity() {
                        return Some((identity.kiosk_name, identity.kiosk_key));
                    }
                    status(
                        "Pairing acknowledged but saved identity is missing — contact administrator",
                    );
                } else {
                    status("Pairing revoked — contact administrator or reset the device locally");
                }
                deadline = Instant::now() + Duration::from_secs(900);
                delay = Duration::from_secs(60);
            }
            Ok(claim) if claim.status == "claimed" => {
                match DeviceIdentity::from_claim(server, session, claim).and_then(|identity| {
                    let bytes = serde_json::to_vec(&identity).map_err(|error| error.to_string())?;
                    crate::at_rest::write_encrypted(&identity_file(), &bytes)
                        .map_err(|error| format!("Unable to save device identity: {error}"))?;
                    Ok(identity)
                }) {
                    Ok(identity) => {
                        crate::axiom::set_kiosk_id(identity.kiosk_id);
                        let _ = fs::remove_file(state_dir().join("pairing.json"));
                        acknowledge_identity(server);
                        crate::remote_debug::reset_all_lockouts();
                        return Some((identity.kiosk_name, identity.kiosk_key));
                    }
                    Err(error) => {
                        tracing::warn!("{error}");
                        status("Pairing confirmed — unable to save identity; retrying");
                        // Never abandon a confirmed claim because storage is temporarily unavailable.
                        deadline = Instant::now() + Duration::from_secs(900);
                    }
                }
            }
            Ok(claim) => {
                if let Some(remaining) = claim.expires_in_seconds {
                    deadline = Instant::now() + Duration::from_secs(remaining.clamp(1, 1800));
                }
                delay = crate::core::protocol::poll_delay(claim.poll_after_ms);
                if claim.status == "failed" {
                    status("Pairing server configuration error — retrying");
                } else {
                    status("Enter this code in BetterFrame admin to pair");
                }
            }
            Err(error) => {
                tracing::warn!("{error}");
                status("Pairing connection interrupted — retrying");
                delay = (delay * 2).min(Duration::from_secs(60));
            }
        }
        // A secure session may have been confirmed during an outage. Only
        // the server can expire it; retain its polling secret across reboots.
        if session.polling_secret.is_none() && Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(if session.polling_secret.is_some() {
            delay
        } else {
            delay.min(deadline.saturating_duration_since(Instant::now()))
        });
    }
    tracing::info!("pairing session expired; requesting a fresh code");
    let _ = fs::remove_file(state_dir().join("pairing.json"));
    None
}

/// Fetch bundle from server. Returns None on network/HTTP/parse failure.
/// On success, also writes the bundle to the on-disk cache.
/// Cached ETag from the last bundle fetch. Sent as If-None-Match so the
/// server can return 304 when the bundle hasn't changed.
static BUNDLE_ETAG: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

pub fn fetch_bundle(server: &str, key: &str) -> Option<KioskBundle> {
    acknowledge_identity(server);
    let client = crate::network::blocking_client();
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
        tracing::warn!("server rejected kiosk key during bundle fetch; retaining identity");
        return None;
    }

    if !resp.status().is_success() {
        tracing::warn!("bundle fetch returned {}", resp.status());
        return None;
    }

    // Commit the validator only after decoding a usable bundle. Otherwise
    // one malformed body can trap subsequent requests on 304 with no cache.
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

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
            *BUNDLE_ETAG.lock().unwrap() = etag;
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
    let client = crate::network::blocking_client();
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
    let client = crate::network::blocking_client();
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
    // Preserve the automation event and also feed first-party diagnostic storage.
    match level {
        "error" => tracing::error!("{message}"),
        "warn" => tracing::warn!("{message}"),
        _ => tracing::info!("{message}"),
    }
    let client = crate::network::blocking_client();
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

pub fn ota_enabled(name: &str) -> bool {
    std::env::var(name).as_deref() != Ok("0")
}

pub fn heartbeat(
    server: &str,
    key: &str,
    bundle_version: Option<&str>,
    displays: &[DisplayReport],
    hw: &crate::hwmon::HwInfo,
) -> bool {
    let client = crate::network::blocking_client();
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
            "updates": {
                "app_enabled": ota_enabled("BF_ENABLE_APP_OTA"),
                "os_enabled": crate::os_update::enabled(),
            },
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
                tracing::warn!("server rejected kiosk key during heartbeat; retaining identity");
                return Ok(false);
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
    const LEGACY_HELPER: &str = "/usr/local/sbin/betterframe-apply-managed-config.sh";
    set_timezone_with_fallback(
        timezone,
        std::path::Path::new(LEGACY_HELPER)
            .is_file()
            .then_some(LEGACY_HELPER),
        |program, args| {
            let out = Command::new(program)
                .args(args)
                .output()
                .map_err(|error| format!("{program}: {error}"))?;
            if out.status.success() {
                Ok(())
            } else {
                Err(format!(
                    "{program}: {}: {}",
                    out.status,
                    String::from_utf8_lossy(&out.stderr).trim()
                ))
            }
        },
    )
}

fn set_timezone_with_fallback(
    timezone: &str,
    legacy_helper: Option<&str>,
    mut run: impl FnMut(&str, &[&str]) -> Result<(), String>,
) -> Result<(), String> {
    let direct_error = match run(
        "timedatectl",
        &["--no-ask-password", "set-timezone", timezone],
    ) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    // App OTA cannot install the new polkit rule. Preserve the provisioned
    // sudoers/helper path on older installations where escalation is allowed.
    // sudo -n fails promptly under NoNewPrivileges; never weaken the service.
    let fallback_error = match legacy_helper {
        Some(helper) => match run("sudo", &["-n", helper, "timezone", timezone]) {
            Ok(()) => return Ok(()),
            Err(error) => error,
        },
        None => "legacy managed-config helper is unavailable".to_string(),
    };
    Err(format!(
        "Unable to set timezone ({direct_error}; {fallback_error}). Check the managed timezone policy; hardened legacy images require an OS policy update."
    ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed_legacy_import_never_resurrects_a_consumed_journal_or_reset_identity() {
        let root = std::env::temp_dir().join(format!("bf-legacy-import-{}", rand::random::<u64>()));
        let legacy = root.join("legacy");
        let persistent = root.join("persistent");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&persistent).unwrap();
        let journal = b"{\"target\":\"https://frame-eu.betterportal.net\"}";
        fs::write(legacy.join("origin-migration.json"), journal).unwrap();
        fs::write(legacy.join("identity.json"), b"old canonical identity").unwrap();
        import_legacy_state(&legacy, &persistent).unwrap();
        assert_eq!(fs::read(persistent.join("origin-migration.json")).unwrap(), journal);

        // Recovery updates the identity and consumes its destination journal.
        fs::write(persistent.join("identity.json"), b"updated regional identity").unwrap();
        fs::remove_file(persistent.join("origin-migration.json")).unwrap();
        import_legacy_state(&legacy, &persistent).unwrap();
        assert!(!persistent.join("origin-migration.json").exists());
        assert_eq!(fs::read(persistent.join("identity.json")).unwrap(), b"updated regional identity");
        assert!(legacy.join("origin-migration.json").exists());

        // Resetting enrollment must not cause the old source identity to return.
        fs::remove_file(persistent.join("identity.json")).unwrap();
        import_legacy_state(&legacy, &persistent).unwrap();
        assert!(!persistent.join("identity.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_legacy_import_commit_is_retryable_without_overwriting_current_state() {
        let root = std::env::temp_dir().join(format!("bf-legacy-import-retry-{}", rand::random::<u64>()));
        let legacy = root.join("legacy");
        let persistent = root.join("persistent");
        fs::create_dir_all(&legacy).unwrap();
        fs::create_dir_all(&persistent).unwrap();
        fs::write(legacy.join("identity.json"), b"legacy identity").unwrap();
        fs::write(legacy.join("origin-migration.json"), b"journal").unwrap();
        fs::write(persistent.join("identity.json"), b"current identity").unwrap();
        let blocked = persistent.join(".legacy-state-imported.tmp");
        fs::create_dir(&blocked).unwrap();
        assert!(import_legacy_state(&legacy, &persistent).is_err());
        assert!(!persistent.join(".legacy-state-imported").exists());
        assert_eq!(fs::read(persistent.join("identity.json")).unwrap(), b"current identity");
        fs::remove_dir(blocked).unwrap();
        import_legacy_state(&legacy, &persistent).unwrap();
        assert!(persistent.join(".legacy-state-imported").exists());
        assert_eq!(fs::read(persistent.join("identity.json")).unwrap(), b"current identity");
        fs::remove_file(persistent.join("origin-migration.json")).unwrap();
        import_legacy_state(&legacy, &persistent).unwrap();
        assert!(!persistent.join("origin-migration.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn timezone_policy_success_does_not_invoke_legacy_helper() {
        let mut calls = Vec::new();
        set_timezone_with_fallback("Europe/London", Some("/legacy/helper"), |program, args| {
            calls.push((
                program.to_string(),
                args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(),
            ));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            calls,
            vec![(
                "timedatectl".into(),
                vec![
                    "--no-ask-password".into(),
                    "set-timezone".into(),
                    "Europe/London".into()
                ]
            )]
        );
    }

    #[test]
    fn timezone_uses_noninteractive_helper_when_direct_authorization_fails() {
        let mut calls = Vec::new();
        set_timezone_with_fallback("Europe/London", Some("/legacy/helper"), |program, args| {
            calls.push((
                program.to_string(),
                args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>(),
            ));
            if program == "timedatectl" {
                Err("access denied".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1],
            (
                "sudo".into(),
                vec![
                    "-n".into(),
                    "/legacy/helper".into(),
                    "timezone".into(),
                    "Europe/London".into()
                ]
            )
        );
    }

    #[test]
    fn timezone_reports_missing_helper_without_attempting_sudo() {
        let mut calls = 0;
        let error = set_timezone_with_fallback("Etc/UTC", None, |program, _| {
            calls += 1;
            assert_eq!(program, "timedatectl");
            Err("policy denied".into())
        })
        .unwrap_err();
        assert_eq!(calls, 1);
        assert!(error.contains("policy denied"));
        assert!(error.contains("helper is unavailable"));
        assert!(error.contains("OS policy update"));
    }

    #[test]
    fn timezone_does_not_report_success_when_hardening_blocks_legacy_helper() {
        let error = set_timezone_with_fallback("Etc/UTC", Some("/legacy/helper"), |program, _| {
            Err(if program == "sudo" {
                "NoNewPrivileges prevents sudo"
            } else {
                "policy denied"
            }
            .into())
        })
        .unwrap_err();
        assert!(error.contains("policy denied"));
        assert!(error.contains("NoNewPrivileges prevents sudo"));
        assert!(error.contains("OS policy update"));
    }

    #[test]
    fn pairing_recovers_bad_response_and_preserves_identity_after_bundle_rejection() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let peer = std::thread::spawn(move || {
            for (status, body) in [
                (200, "{}"), // Anonymous discovery before any enrollment request.
                (500, "{}"),
                (
                    200,
                    r#"{"code":"ABCDEFGH","expires_at":"invalid-clock","expires_in_seconds":1,"polling_secret":"test-session-secret"}"#,
                ),
                (200, "invalid JSON"),
                (
                    200,
                    r#"{"status":"claimed","kiosk_id":"42","kiosk_name":"Recovered","kiosk_key":"bearer","encrypt_key":"encrypt"}"#,
                ),
                (200, r#"{"status":"acknowledged"}"#),
                (401, "{}"),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let count = stream.read(&mut chunk).unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        // A saved discovery result alone is not enrollment: an operator may
        // correct --server before a pairing code or device key exists.
        fs::write(server_file(), "https://mistyped.example").unwrap();
        assert_eq!(discover_server(Some(&server)).unwrap(), server);
        assert_eq!(fs::read_to_string(server_file()).unwrap(), server);
        assert_eq!(discover_server(None).unwrap(), server);
        assert!(initiate_pairing(&server).is_err());
        let session = initiate_pairing(&server).unwrap();
        assert_eq!(discover_server(None).unwrap(), server);
        assert_eq!(discover_server(Some("https://changed.example")).unwrap(), server);
        let resumed = initiate_pairing(&server).unwrap();
        assert_eq!(resumed.code, session.code);
        let mut_statuses = std::sync::Mutex::new(Vec::new());
        let (name, key) = poll_claim_until_expiry(&server, &session, |status| {
            mut_statuses.lock().unwrap().push(status.to_string())
        })
        .unwrap();
        assert_eq!(name, "Recovered");
        assert!(!mut_statuses.lock().unwrap().is_empty());
        assert_eq!(load_key().unwrap(), key);
        assert_eq!(discover_server(None).unwrap(), server);
        assert_eq!(discover_server(Some("https://changed.example")).unwrap(), server);
        assert_eq!(load_encrypt_key().as_deref(), Some("encrypt"));
        assert!(fetch_bundle(&server, &key).is_none());
        assert_eq!(load_key().unwrap(), key);
        peer.join().unwrap();

        // Upgrade an old --server canonical enrollment without losing its key,
        // polling secret or cache. Offline discovery must leave everything alone.
        let canonical = crate::core::protocol::CANONICAL_SERVER_URL;
        let regional = "https://frame-eu.betterportal.net";
        let mut identity = load_identity().unwrap();
        identity.server_url = canonical.into();
        crate::at_rest::write_encrypted(&identity_file(), &serde_json::to_vec(&identity).unwrap()).unwrap();
        crate::at_rest::write_encrypted(&state_dir().join("pairing.json"),
            &serde_json::to_vec(&(canonical, &session)).unwrap()).unwrap();
        persist_server_origin(canonical).unwrap();
        let cached: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id":"42", "kiosk_name":"Recovered", "version":"cached-v1", "displays":[], "cameras":[]
        })).unwrap();
        save_bundle(&cached);
        let cache_before = fs::read(bundle_cache_path()).unwrap();
        assert!(migrate_canonical_origin_with(canonical, |_| Err("offline".into())).is_err());
        assert_eq!(load_identity().unwrap().server_url, canonical);
        assert_eq!(load_cached_bundle().unwrap().version, "cached-v1");
        assert_eq!(load_key().unwrap(), key);
        assert!(!migration_file().exists());

        // Fail the final origin-file write after both encrypted records have
        // changed. Startup must replay the journal before selecting its origin.
        let blocked_temporary = server_file().with_extension("url.tmp");
        fs::create_dir(&blocked_temporary).unwrap();
        assert!(migrate_canonical_origin_with(canonical, |_| Ok(regional.into())).is_err());
        assert!(migration_file().exists());
        assert_eq!(load_identity().unwrap().server_url, regional);
        assert_eq!(fs::read_to_string(server_file()).unwrap(), canonical);
        fs::remove_dir(blocked_temporary).unwrap();
        assert_eq!(discover_server(None).unwrap(), regional);
        assert!(!migration_file().exists());
        let pending: (String, PairInitiateResponse) = serde_json::from_slice(
            &crate::at_rest::read_maybe_encrypted(&state_dir().join("pairing.json")).unwrap()).unwrap();
        assert_eq!(pending.0, regional);
        assert_eq!(pending.1.polling_secret, session.polling_secret);
        assert_eq!(load_key().unwrap(), key);
        assert_eq!(load_encrypt_key().as_deref(), Some("encrypt"));
        assert_eq!(fs::read(bundle_cache_path()).unwrap(), cache_before);
        assert_eq!(fs::read_to_string(server_file()).unwrap(), regional);

        // Earlier images used a separate key file instead of identity.json.
        fs::remove_file(identity_file()).unwrap();
        fs::remove_file(state_dir().join("pairing.json")).unwrap();
        crate::at_rest::write_encrypted(&key_file(), key.as_bytes()).unwrap();
        persist_server_origin(canonical).unwrap();
        assert_eq!(discover_server(Some("https://custom.example")).unwrap(), canonical);
        assert_eq!(migrate_canonical_origin_with(canonical, |_| Ok(regional.into())).unwrap(), regional);
        assert_eq!(discover_server(None).unwrap(), regional);
        assert_eq!(load_key().unwrap(), key);
        assert_eq!(fs::read(bundle_cache_path()).unwrap(), cache_before);

        crate::at_rest::write_encrypted(
            &state_dir().join("pairing.json"),
            b"broken pending session",
        )
        .unwrap();
        assert!(initiate_pairing(&server).is_err());
        fs::remove_dir_all(state_dir()).unwrap();
    }

    #[test]
    fn startup_network_summary_keeps_mac_while_waiting_for_ip() {
        let interfaces = vec![serde_json::json!({
            "name": "eth0",
            "mac": "aa:bb:cc:dd:ee:ff",
            "ips": ["fe80::1/64"]
        })];
        assert_eq!(
            format_startup_network_summary(&interfaces),
            ("eth0 aa:bb:cc:dd:ee:ff".into(), "searching".into())
        );
    }
}
