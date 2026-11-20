//! Display power management — CEC for TVs, DPMS (wlr-randr/xset) for monitors.
//!
//! Tries CEC first (works for HDMI TVs).
//! Falls back to compositor-level output disable for desktop monitors that
//! don't speak CEC.

use std::process::Command;
use tracing::{info, warn};

const CEC_DEVICE: &str = "/dev/cec0";

/// Put the display to sleep — fire both CEC and DPMS.
/// CEC handles TVs that listen. DPMS handles monitors that don't.
/// Both are idempotent; doing both is cheap and covers both cases.
pub fn standby() {
    info!("power: standby");
    cec_standby();
    if !wlr_output_off() {
        xset_dpms_off();
    }
}

/// Disable only the named output; failure must never power off other displays.
pub fn standby_output(output: &str) {
    info!("power: standby output {output}");
    if !wlr_output_set(output, false) {
        warn!("power: per-output standby unavailable for {output}");
    }
}

/// Wake the display — fire both CEC and DPMS.
pub fn wake() {
    info!("power: wake");
    cec_wake();
    if !wlr_output_on() {
        xset_dpms_on();
    }
}

/// Enable only the named output; failure must never wake other displays.
pub fn wake_output(output: &str) {
    info!("power: wake output {output}");
    if !wlr_output_set(output, true) {
        warn!("power: per-output wake unavailable for {output}");
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
fn wlr_output_off() -> bool {
    // Get list of outputs
    let outputs = list_outputs();
    if outputs.is_empty() {
        warn!("dpms: no outputs found");
        return false;
    }
    let mut ok = false;
    for output in outputs {
        match Command::new("wlr-randr")
            .args(["--output", &output, "--off"])
            .output()
        {
            Ok(out) if out.status.success() => {
                info!("dpms: {output} off");
                ok = true;
            }
            Ok(out) => warn!("dpms off {output} failed: {}", String::from_utf8_lossy(&out.stderr)),
            Err(e) => warn!("wlr-randr unavailable: {e}"),
        }
    }
    ok
}

fn wlr_output_on() -> bool {
    let outputs = list_outputs();
    if outputs.is_empty() {
        warn!("dpms: no outputs found");
        return false;
    }
    let mut ok = false;
    for output in outputs {
        match Command::new("wlr-randr")
            .args(["--output", &output, "--on"])
            .output()
        {
            Ok(out) if out.status.success() => {
                info!("dpms: {output} on");
                ok = true;
            }
            Ok(out) => warn!("dpms on {output} failed: {}", String::from_utf8_lossy(&out.stderr)),
            Err(e) => warn!("wlr-randr unavailable: {e}"),
        }
    }
    ok
}

fn wlr_output_set(output: &str, on: bool) -> bool {
    let state = if on { "--on" } else { "--off" };
    match Command::new("wlr-randr")
        .args(["--output", output, state])
        .output()
    {
        Ok(out) if out.status.success() => {
            info!("dpms: {output} {state}");
            true
        }
        Ok(out) => {
            warn!("dpms {output} {state} failed: {}", String::from_utf8_lossy(&out.stderr));
            false
        }
        Err(e) => {
            warn!("wlr-randr unavailable: {e}");
            false
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

fn xset_dpms_off() {
    match Command::new("xset").args(["dpms", "force", "off"]).output() {
        Ok(out) if out.status.success() => info!("xset: dpms off"),
        Ok(out) => warn!("xset dpms off failed: {}", String::from_utf8_lossy(&out.stderr)),
        Err(e) => warn!("xset unavailable: {e}"),
    }
}

fn xset_dpms_on() {
    match Command::new("xset").args(["dpms", "force", "on"]).output() {
        Ok(out) if out.status.success() => info!("xset: dpms on"),
        Ok(out) => warn!("xset dpms on failed: {}", String::from_utf8_lossy(&out.stderr)),
        Err(e) => warn!("xset unavailable: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Observe subprocess commands in isolation: a failed named output must
    /// never enumerate or modify other outputs, use global CEC, or invoke xset.
    #[test]
    fn named_power_never_falls_back_to_all_outputs() {
        if std::env::var("BF_POWER_TEST_CHILD").as_deref() == Ok("1") {
            standby_output("Requested screen");
            wake_output("Requested screen");
            return;
        }
        let dir = std::env::temp_dir().join(format!("bf-power-test-{:x}", rand::random::<u128>()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("calls.log");
        let wlr = r#"#!/bin/sh
printf 'wlr:%s\n' "$*" >> "$BF_POWER_TEST_LOG"
if [ "$#" -eq 0 ]; then printf 'HDMI-1\nHDMI-2\n'; exit 0; fi
exit 1
"#;
        for (name, script) in [
            ("wlr-randr", wlr),
            (
                "xset",
                "#!/bin/sh\nprintf 'GLOBAL xset\\n' >> \"$BF_POWER_TEST_LOG\"\n",
            ),
            (
                "cec-ctl",
                "#!/bin/sh\nprintf 'GLOBAL cec\\n' >> \"$BF_POWER_TEST_LOG\"\n",
            ),
        ] {
            let path = dir.join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let result = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "cec::tests::named_power_never_falls_back_to_all_outputs",
                "--nocapture",
            ])
            .env("PATH", &dir)
            .env("BF_POWER_TEST_CHILD", "1")
            .env("BF_POWER_TEST_LOG", &log)
            .output()
            .unwrap();
        let calls = std::fs::read_to_string(&log).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(
            result.status.success(),
            "child fixture failed: {}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            calls,
            "wlr:--output Requested screen --off\nwlr:--output Requested screen --on\n"
        );
    }
}
