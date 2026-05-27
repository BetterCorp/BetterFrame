//! Automatic fan control based on CPU temperature thresholds.
//!
//! Runs a background thread that polls CPU temp every 5s and sets fan PWM:
//!   - < 45C  -> hardware auto mode
//!   - >= 45C -> 50% (PWM 128)
//!   - >= 50C -> 100% (PWM 255)
//!
//! Manual fan commands (from admin/Node-RED) override auto control for 60s,
//! after which the thermal loop resumes.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

use crate::hwmon;

static MANUAL_OVERRIDE_UNTIL: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);

const POLL_INTERVAL: Duration = Duration::from_secs(5);
const OVERRIDE_DURATION: Duration = Duration::from_secs(60);

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Call when a manual fan command arrives to suppress auto control temporarily.
pub fn set_manual_override() {
    let until = now_epoch_secs() + OVERRIDE_DURATION.as_secs();
    MANUAL_OVERRIDE_UNTIL.store(until, Ordering::Relaxed);
}

fn is_manual_override_active() -> bool {
    let until = MANUAL_OVERRIDE_UNTIL.load(Ordering::Relaxed);
    until > 0 && now_epoch_secs() < until
}

/// Compute target fan mode from CPU temperature.
fn target_pwm(temp_c: f32) -> Option<u32> {
    if temp_c >= 50.0 {
        Some(255)
    } else if temp_c >= 45.0 {
        Some(128)
    } else {
        None
    }
}

/// Start the thermal management background thread. Call once at startup.
pub fn start() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // already running
    }

    std::thread::Builder::new()
        .name("thermal".into())
        .spawn(|| {
            info!("thermal: auto fan control started (<45C auto, >=45C 50%, >=50C 100%)");
            let mut last_pwm: Option<u32> = None;

            loop {
                std::thread::sleep(POLL_INTERVAL);

                if is_manual_override_active() {
                    last_pwm = None; // reset so we re-apply when override expires
                    continue;
                }

                let Some(temp) = hwmon::read_temp_c() else {
                    continue;
                };

                let pwm = target_pwm(temp);
                if last_pwm == pwm {
                    continue; // no change needed
                }

                if hwmon::set_fan(pwm) {
                    last_pwm = pwm;
                } else {
                    warn!("thermal: failed to set fan PWM {pwm:?}");
                }
            }
        })
        .expect("spawn thermal thread");
}
