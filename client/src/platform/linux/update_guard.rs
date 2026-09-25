use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

const ATTEMPT_LIMIT: u32 = 3;
const ATTEMPT_FILE: &str = "/var/lib/betterframe/kiosk/update-attempts.json";
static GUARD_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Deserialize, Serialize)]
struct AttemptState {
    entries: HashMap<String, AttemptEntry>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct AttemptEntry {
    failures: u32,
    last_error: Option<String>,
    last_failed_at: u64,
}

pub fn blocked(kind: &str, version: &str, force: bool) -> Option<u32> {
    if force {
        return None;
    }
    let _lock = GUARD_LOCK.lock().ok()?;
    let state = read_state();
    let failures = state
        .entries
        .get(&key(kind, version))
        .map(|entry| entry.failures)
        .unwrap_or(0);
    (failures >= ATTEMPT_LIMIT).then_some(failures)
}

/// Persist an attempt before starting work, including attempts interrupted by power loss.
pub fn record_attempt(kind: &str, version: &str) -> Result<u32, String> {
    let _lock = GUARD_LOCK
        .lock()
        .map_err(|_| "Update attempt record locked")?;
    let mut state = read_state();
    let entry = state.entries.entry(key(kind, version)).or_default();
    entry.failures = entry.failures.saturating_add(1);
    entry.last_error = Some("Attempt started; awaiting boot confirmation".into());
    entry.last_failed_at = now_secs();
    let attempts = entry.failures;
    write_state(&state)?;
    Ok(attempts)
}

/// Undo one pre-recorded attempt when the server deferred the download.
pub fn refund_attempt(kind: &str, version: &str) -> Result<(), String> {
    let _lock = GUARD_LOCK.lock().map_err(|_| "Update attempt record locked")?;
    let mut state = read_state();
    refund_entry(&mut state, &key(kind, version));
    write_state(&state)
}

fn refund_entry(state: &mut AttemptState, key: &str) {
    if let Some(entry) = state.entries.get_mut(key) {
        entry.failures = entry.failures.saturating_sub(1);
    }
}

pub fn record_failure(kind: &str, version: &str, err: &str) -> u32 {
    let _lock = GUARD_LOCK.lock().ok();
    let mut state = read_state();
    let entry = state.entries.entry(key(kind, version)).or_default();
    entry.failures = entry.failures.saturating_add(1);
    entry.last_error = Some(truncate(err, 1000));
    entry.last_failed_at = now_secs();
    let failures = entry.failures;
    if let Err(write_err) = write_state(&state) {
        warn!("update-guard: failed to persist {kind} {version} failure: {write_err}");
    }
    failures
}

pub fn failure_count(kind: &str, version: &str) -> u32 {
    let _lock = GUARD_LOCK.lock().ok();
    let state = read_state();
    state
        .entries
        .get(&key(kind, version))
        .map(|entry| entry.failures)
        .unwrap_or(0)
}

pub fn record_success(kind: &str, version: &str) {
    let _lock = GUARD_LOCK.lock().ok();
    let mut state = read_state();
    if state.entries.remove(&key(kind, version)).is_some() {
        if let Err(write_err) = write_state(&state) {
            warn!("update-guard: failed to clear {kind} {version} failure state: {write_err}");
        } else {
            info!("update-guard: cleared {kind} {version} failure state after success");
        }
    }
}

fn key(kind: &str, version: &str) -> String {
    format!("{kind}:{version}")
}

fn read_state() -> AttemptState {
    let Ok(raw) = fs::read_to_string(ATTEMPT_FILE) else {
        return AttemptState::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_state(state: &AttemptState) -> Result<(), String> {
    fs::create_dir_all("/var/lib/betterframe/kiosk").map_err(|e| format!("mkdir: {e}"))?;
    let raw = serde_json::to_string(state).map_err(|e| format!("encode: {e}"))?;
    use std::io::Write;
    let tmp = format!("{ATTEMPT_FILE}.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| format!("create: {e}"))?;
    file.write_all(raw.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("write: {e}"))?;
    fs::rename(tmp, ATTEMPT_FILE).map_err(|e| format!("rename: {e}"))?;
    fs::File::open("/var/lib/betterframe/kiosk")
        .and_then(|f| f.sync_all())
        .map_err(|e| format!("sync directory: {e}"))
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rate_limit_refund_preserves_previous_installation_failures() {
        let mut state = AttemptState::default();
        state.entries.insert("os:2.0".into(), AttemptEntry {failures: 3, ..Default::default()});
        refund_entry(&mut state, "os:2.0");
        assert_eq!(state.entries["os:2.0"].failures, 2);
        refund_entry(&mut state, "os:unknown");
        assert_eq!(state.entries.len(), 1);
        state.entries.get_mut("os:2.0").unwrap().failures = 0;
        refund_entry(&mut state, "os:2.0");
        assert_eq!(state.entries["os:2.0"].failures, 0);
    }
}
