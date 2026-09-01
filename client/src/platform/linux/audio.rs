//! Audio output control — volume, mute, output selection.
//!
//! Tries PipeWire (`wpctl`) first, falls back to ALSA (`amixer`).
//! Pi 5 with Debian Bookworm uses PipeWire by default under cage.

use std::process::Command;
use tracing::{info, warn};

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct AudioState {
    pub volume_percent: u32,
    pub muted: bool,
    pub output_name: String,
    pub available_outputs: Vec<AudioOutput>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioOutput {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub fn get_state() -> AudioState {
    if has_wpctl() {
        get_state_pipewire()
    } else {
        get_state_alsa()
    }
}

pub fn set_volume(percent: u32) -> bool {
    let pct = percent.min(100);
    info!("audio: set volume {pct}%");
    if has_wpctl() {
        run_ok("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &format!("{:.2}", pct as f32 / 100.0)])
    } else {
        run_ok("amixer", &["sset", "Master", &format!("{pct}%")])
    }
}

pub fn set_mute(muted: bool) -> bool {
    info!("audio: set mute={muted}");
    if has_wpctl() {
        let val = if muted { "1" } else { "0" };
        run_ok("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", val])
    } else {
        let val = if muted { "mute" } else { "unmute" };
        run_ok("amixer", &["sset", "Master", val])
    }
}

pub fn set_output(id: &str) -> bool {
    info!("audio: set output={id}");
    if has_wpctl() {
        run_ok("wpctl", &["set-default", id])
    } else {
        false
    }
}

fn has_wpctl() -> bool {
    Command::new("wpctl").arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn run_ok(cmd: &str, args: &[&str]) -> bool {
    match Command::new(cmd).args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    {
        Ok(s) => s.success(),
        Err(e) => { warn!("audio: {cmd} failed: {e}"); false }
    }
}

fn get_state_pipewire() -> AudioState {
    let mut state = AudioState::default();

    if let Ok(out) = Command::new("wpctl").args(["get-volume", "@DEFAULT_AUDIO_SINK@"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        // "Volume: 0.75" or "Volume: 0.75 [MUTED]"
        state.muted = text.contains("[MUTED]");
        if let Some(vol_str) = text.split_whitespace().nth(1) {
            if let Ok(v) = vol_str.parse::<f32>() {
                state.volume_percent = (v * 100.0).round() as u32;
            }
        }
    }

    if let Ok(out) = Command::new("wpctl").args(["status"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        let mut in_sinks = false;
        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.contains("Audio/Sink") || trimmed.contains("Sinks:") {
                in_sinks = true;
                continue;
            }
            if in_sinks && trimmed.is_empty() {
                break;
            }
            if in_sinks {
                let is_default = trimmed.contains('*');
                let clean = trimmed.trim_start_matches(['│', '├', '└', '─', ' ', '*', '·']);
                let parts: Vec<&str> = clean.splitn(2, '.').collect();
                if parts.len() == 2 {
                    let id = parts[0].trim().to_string();
                    let name = parts[1].trim().trim_start_matches(' ').to_string();
                    if is_default {
                        state.output_name = name.clone();
                    }
                    state.available_outputs.push(AudioOutput { id, name, is_default });
                }
            }
        }
    }

    state
}

fn get_state_alsa() -> AudioState {
    let mut state = AudioState::default();
    state.output_name = "Master".to_string();

    if let Ok(out) = Command::new("amixer").args(["sget", "Master"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            let trimmed = line.trim();
            // "Mono: Playback 32768 [50%] [on]" or "[off]"
            if trimmed.contains('[') && trimmed.contains('%') {
                if let Some(pct_str) = trimmed.split('[').nth(1) {
                    if let Some(pct) = pct_str.strip_suffix("%]") {
                        state.volume_percent = pct.parse().unwrap_or(0);
                    }
                }
                state.muted = trimmed.contains("[off]");
                break;
            }
        }
    }

    if let Ok(out) = Command::new("aplay").args(["-l"]).output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.starts_with("card ") {
                let name = line.split(':').nth(1).unwrap_or("").trim().to_string();
                let id = line.split_whitespace().nth(1).unwrap_or("0")
                    .trim_end_matches(':').to_string();
                state.available_outputs.push(AudioOutput {
                    id,
                    name,
                    is_default: state.available_outputs.is_empty(),
                });
            }
        }
    }

    state
}
