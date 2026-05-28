use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tracing::warn;

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
    fs::write(ATTEMPT_FILE, raw).map_err(|e| format!("write: {e}"))
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
