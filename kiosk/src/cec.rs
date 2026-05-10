//! Display power management — CEC for TVs, DPMS (wlr-randr/xset) for monitors.
//!
//! Tries CEC first (works for HDMI TVs).
//! Falls back to compositor-level output disable for desktop monitors that
//! don't speak CEC.

use std::process::Command;
use tracing::{info, warn};

const CEC_DEVICE: &str = "/dev/cec0";

/// Put the display to sleep — try CEC first, fall back to compositor DPMS.
pub fn standby() {
    info!("power: standby");
    if !cec_standby() {
        wlr_output_off();
    }
}

/// Wake the display — try CEC first, fall back to compositor DPMS.
pub fn wake() {
    info!("power: wake");
    if !cec_wake() {
        wlr_output_on();
    }
}

fn cec_standby() -> bool {
    run_cec(&["--standby", "--to", "0"])
}

fn cec_wake() -> bool {
    run_cec(&["--image-view-on", "--to", "0"])
}

fn run_cec(args: &[&str]) -> bool {
    if !std::path::Path::new(CEC_DEVICE).exists() {
        return false;
    }
    match Command::new("cec-ctl").arg("-d").arg(CEC_DEVICE).args(args).output() {
        Ok(out) if out.status.success() => {
            info!("cec: ok");
            true
        }
        Ok(out) => {
            warn!("cec failed: {}", String::from_utf8_lossy(&out.stderr));
            false
        }
        Err(e) => {
            warn!("cec-ctl not available: {e}");
            false
        }
    }
}

/// Turn off all outputs via wlr-randr (Wayland compositors: labwc, wayfire, sway).
fn wlr_output_off() {
    // Get list of outputs
    let outputs = list_outputs();
    if outputs.is_empty() {
        warn!("dpms: no outputs found");
        return;
    }
    for output in outputs {
        match Command::new("wlr-randr")
            .args(["--output", &output, "--off"])
            .output()
        {
            Ok(out) if out.status.success() => info!("dpms: {output} off"),
            Ok(out) => warn!("dpms off {output} failed: {}", String::from_utf8_lossy(&out.stderr)),
            Err(e) => warn!("wlr-randr unavailable: {e}"),
        }
    }
}

fn wlr_output_on() {
    let outputs = list_outputs();
    for output in outputs {
        match Command::new("wlr-randr")
            .args(["--output", &output, "--on"])
            .output()
        {
            Ok(out) if out.status.success() => info!("dpms: {output} on"),
            Ok(out) => warn!("dpms on {output} failed: {}", String::from_utf8_lossy(&out.stderr)),
            Err(e) => warn!("wlr-randr unavailable: {e}"),
        }
    }
}

fn list_outputs() -> Vec<String> {
    let out = match Command::new("wlr-randr").output() {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .filter(|l| !l.starts_with(' ') && !l.is_empty())
        .map(|l| l.split_whitespace().next().unwrap_or("").to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
