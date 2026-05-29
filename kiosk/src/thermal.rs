//! Zone-based fan control with hysteresis for Pi5.
//!
//! Zones: ≥50°C → 100%, 45–49°C → 50%, <45°C → off.
//! Increases are immediate; decreases step down one zone at a time,
//! holding for 60s at each level before dropping further.
//!
//! Boot cooldown: 30s at 100% to absorb GStreamer hw-decode startup.
//!
//! Manual fan commands (from admin/Node-RED) override auto control for
//! 60s, after which zone control resumes.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

use crate::hwmon;

static MANUAL_OVERRIDE_UNTIL: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const OVERRIDE_DURATION: Duration = Duration::from_secs(60);
const BOOT_COOLDOWN_SECS: u64 = 30;
const HOLD_SECS: u64 = 60;

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

fn zone_pwm(temp_c: f32) -> u32 {
    if temp_c >= 50.0 {
        255
    } else if temp_c >= 40.0 {
        128
    } else {
        0
    }
}

fn next_zone_down(pwm: u32) -> u32 {
    if pwm > 128 {
        128
    } else {
        0
    }
}

/// Start the thermal management background thread. Call once at startup.
pub fn start() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::Builder::new()
        .name("thermal".into())
        .spawn(|| {
            info!(
                "thermal: zone fan control started (>=50C→100%, 40-49C→50%, <40C→off, hold {HOLD_SECS}s)"
            );

            hwmon::set_fan(Some(255));
            info!("thermal: boot cooldown — fan 100% for {BOOT_COOLDOWN_SECS}s");

            let boot_start = Instant::now();
            let mut boot_phase = true;
            let mut was_override = false;
            let mut current_pwm: u32 = 255;
            let mut hold_until: Option<Instant> = None;

            loop {
                std::thread::sleep(POLL_INTERVAL);

                if is_manual_override_active() {
                    if !was_override {
                        info!("thermal: manual override active, auto paused");
                        was_override = true;
                    }
                    continue;
                }

                if was_override {
                    info!("thermal: manual override expired, auto resuming");
                    was_override = false;
                    current_pwm = hwmon::read_temp_c().map(zone_pwm).unwrap_or(255);
                    hwmon::set_fan(Some(current_pwm));
                    hold_until = None;
                    continue;
                }

                if boot_phase {
                    if boot_start.elapsed() >= Duration::from_secs(BOOT_COOLDOWN_SECS) {
                        info!("thermal: boot cooldown complete, zone control taking over");
                        boot_phase = false;
                        current_pwm = hwmon::read_temp_c().map(zone_pwm).unwrap_or(128);
                        hwmon::set_fan(Some(current_pwm));
                        hold_until = None;
                    } else {
                        hwmon::set_fan(Some(255));
                    }
                    continue;
                }

                let Some(temp) = hwmon::read_temp_c() else {
                    continue;
                };

                let target = zone_pwm(temp);

                if target > current_pwm {
                    current_pwm = target;
                    hold_until = None;
                    if !hwmon::set_fan(Some(current_pwm)) {
                        warn!("thermal: failed to set fan PWM {current_pwm}");
                    }
                } else if target < current_pwm {
                    if hold_until.is_none() {
                        hold_until = Some(Instant::now() + Duration::from_secs(HOLD_SECS));
                    }
                    if Instant::now() >= hold_until.unwrap() {
                        current_pwm = next_zone_down(current_pwm);
                        hold_until = None;
                        if !hwmon::set_fan(Some(current_pwm)) {
                            warn!("thermal: failed to set fan PWM {current_pwm}");
                        }
                    }
                } else {
                    hold_until = None;
                }
            }
        })
        .expect("spawn thermal thread");
}
