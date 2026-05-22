//! Remote debug access: on-demand journal streaming + gated terminal.
//!
//! Journal: server sends "journal-start" → kiosk spawns `journalctl -f`,
//! pipes lines back as "journal-line" messages. "journal-stop" kills it.
//! One-way, no auth ceremony beyond the existing kiosk WS connection.
//!
//! Terminal: dev-channel only + on-screen code auth + lockout.
//!   - Server sends "terminal-request"
//!   - Kiosk checks lockout state + firmware_channel == "dev"
//!   - Shows 8-char code on screen (NOT logged)
//!   - Server relays admin's code via "terminal-auth"
//!   - Kiosk validates locally
//!   - On success: spawns bash, relays I/O as "terminal-data" (base64)
//!   - On failure: increments attempt counter
//!
//! Lockout: 3 failed attempts per boot → lockout_count++. 3 lockouts
//! (9 total failures across reboots) → permanent lockout (reflash only).
//! Successful kiosk pairing resets all lockout state.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

const LOCKOUT_PATH: &str = "/var/lib/betterframe/kiosk/terminal-lockout.json";
const MAX_ATTEMPTS_PER_BOOT: u32 = 3;
const MAX_LOCKOUTS: u32 = 3;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LockoutState {
    attempts_this_boot: u32,
    lockout_count: u32,
    permanent: bool,
}

impl Default for LockoutState {
    fn default() -> Self {
        Self { attempts_this_boot: 0, lockout_count: 0, permanent: false }
    }
}

fn lockout_path() -> PathBuf { PathBuf::from(LOCKOUT_PATH) }

fn load_lockout() -> LockoutState {
    fs::read_to_string(lockout_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_lockout(state: &LockoutState) {
    if let Some(parent) = lockout_path().parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(lockout_path(), serde_json::to_string(state).unwrap_or_default());
}

/// Reset attempts_this_boot on kiosk start (but keep lockout_count).
pub fn reset_boot_attempts() {
    let mut state = load_lockout();
    state.attempts_this_boot = 0;
    save_lockout(&state);
}

/// Called after successful pairing — clears ALL lockout state.
pub fn reset_all_lockouts() {
    let _ = fs::remove_file(lockout_path());
}

fn is_locked() -> bool {
    let state = load_lockout();
    state.permanent || state.lockout_count >= MAX_LOCKOUTS
}

pub fn is_locked_public() -> bool { is_locked() }

fn record_failed_attempt() -> bool {
    let mut state = load_lockout();
    state.attempts_this_boot += 1;
    if state.attempts_this_boot >= MAX_ATTEMPTS_PER_BOOT {
        state.lockout_count += 1;
        state.attempts_this_boot = 0;
        if state.lockout_count >= MAX_LOCKOUTS {
            state.permanent = true;
        }
    }
    save_lockout(&state);
    state.permanent || state.lockout_count >= MAX_LOCKOUTS
}

fn generate_code() -> String {
    let mut rng = rand::thread_rng();
    let mut code = String::with_capacity(CODE_LEN);
    for _ in 0..CODE_LEN {
        let mut byte = [0u8; 1];
        rng.fill_bytes(&mut byte);
        code.push(CODE_ALPHABET[(byte[0] as usize) % CODE_ALPHABET.len()] as char);
    }
    code
}

// ---- Journal streaming ------------------------------------------------------

pub struct JournalStream {
    kill: Arc<Mutex<bool>>,
}

impl JournalStream {
    /// Spawn journalctl -f and call `on_line` for each line. Blocks until
    /// stopped via `stop()` or the process exits.
    pub fn start<F: Fn(&str) + Send + 'static>(on_line: F) -> Self {
        let kill = Arc::new(Mutex::new(false));
        let kill_clone = kill.clone();

        std::thread::spawn(move || {
            let mut child = match Command::new("journalctl")
                .args(["-u", "betterframe-kiosk", "-f", "--no-pager", "-o", "short-iso", "-n", "50"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    warn!("remote-debug: journalctl spawn failed: {e}");
                    return;
                }
            };

            let stdout = child.stdout.take().unwrap();
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if *kill_clone.lock().unwrap() {
                    break;
                }
                match line {
                    Ok(line) => on_line(&line),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        });

        Self { kill }
    }

    pub fn stop(&self) {
        *self.kill.lock().unwrap() = true;
    }
}

// ---- Terminal access --------------------------------------------------------

/// Check if terminal access is allowed. Returns error message if not.
pub fn check_terminal_access() -> Result<(), String> {
    if is_locked() {
        return Err("locked".to_string());
    }
    // Check channel — terminal allowed when EITHER firmware or OS channel
    // is "dev". Channels pushed from server via heartbeat response, cached
    // in server.rs. No env var, no build-time check.
    let fw = crate::server::cached_firmware_channel();
    let os = crate::server::cached_os_channel();
    if fw != "dev" && os != "dev" {
        return Err("terminal access requires dev channel".to_string());
    }
    Ok(())
}

/// Generate a code and return it. Caller is responsible for displaying it
/// on screen and NOT logging it.
pub fn create_terminal_challenge() -> Result<String, String> {
    check_terminal_access()?;
    Ok(generate_code())
}

/// Validate the code. Returns true on match. On failure, records attempt
/// and returns false. Caller should check `is_locked()` after false.
pub fn validate_terminal_code(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        record_failed_attempt();
        return false;
    }
    // Constant-time compare
    let mut diff = 0u8;
    for (a, b) in expected.bytes().zip(provided.bytes()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        record_failed_attempt();
        return false;
    }
    // Successful terminal auth resets all lockout state.
    let _ = std::fs::remove_file(lockout_path());
    true
}

/// Spawn a bash shell with piped stdin/stdout/stderr. Returns handles for
/// reading output and writing input. Caller is responsible for I/O relay.
pub struct TerminalSession {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
}

impl TerminalSession {
    pub fn spawn() -> Result<(Self, std::process::ChildStdout, std::process::ChildStderr), String> {
        let mut child = Command::new("bash")
            .args(["--login"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("TERM", "xterm-256color")
            .spawn()
            .map_err(|e| format!("bash spawn: {e}"))?;

        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let stdin = child.stdin.take();

        Ok((Self { child, stdin }, stdout, stderr))
    }

    pub fn write_input(&mut self, data: &[u8]) -> Result<(), String> {
        if let Some(ref mut stdin) = self.stdin {
            stdin.write_all(data).map_err(|e| format!("stdin write: {e}"))?;
            stdin.flush().map_err(|e| format!("stdin flush: {e}"))?;
        }
        Ok(())
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Encode bytes as base64 for WS transport.
pub fn b64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Decode base64 from WS transport.
pub fn b64_decode(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("base64 decode: {e}"))
}
