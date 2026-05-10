//! CEC (HDMI Consumer Electronics Control) — manages display power state
//! via `cec-ctl` subprocess. v4l-utils package provides cec-ctl on Pi5.
//!
//! Commands:
//!   - standby: tell TV to sleep
//!   - image-view-on: wake TV
//!   - is-active-source: query state

use std::process::Command;
use tracing::{info, warn};

const CEC_DEVICE: &str = "/dev/cec0";

/// Send CEC standby (sleep) to all connected devices.
pub fn standby() -> bool {
    info!("cec: standby");
    run_cec(&["--standby", "--to", "0"])
}

/// Send CEC image-view-on (wake) to TV.
pub fn wake() -> bool {
    info!("cec: wake");
    run_cec(&["--image-view-on", "--to", "0"])
}

/// Switch HDMI input on TV to this device.
pub fn become_active_source() -> bool {
    info!("cec: become active source");
    run_cec(&["--active-source", "phys-addr=0.0.0.0"])
}

fn run_cec(args: &[&str]) -> bool {
    match Command::new("cec-ctl")
        .arg("-d")
        .arg(CEC_DEVICE)
        .args(args)
        .output()
    {
        Ok(out) if out.status.success() => true,
        Ok(out) => {
            warn!("cec-ctl failed: {}", String::from_utf8_lossy(&out.stderr));
            false
        }
        Err(e) => {
            warn!("cec-ctl not available: {e}");
            false
        }
    }
}
