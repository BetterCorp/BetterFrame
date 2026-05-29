//! PID-based fan control for Pi5.
//!
//! Polls CPU temp every 1s, runs a PID loop targeting 55°C setpoint.
//! Always holds pwm1_enable=1 (manual mode) to prevent the hardware
//! fan controller from fighting our output.
//!
//! Manual fan commands (from admin/Node-RED) override auto control for
//! 60s, after which the PID loop resumes.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

use crate::hwmon;

static MANUAL_OVERRIDE_UNTIL: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicBool = AtomicBool::new(false);

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const OVERRIDE_DURATION: Duration = Duration::from_secs(60);

const SETPOINT_C: f32 = 55.0;
const KP: f32 = 8.0;
const KI: f32 = 0.3;
const KD: f32 = 2.0;
const INTEGRAL_CLAMP: f32 = 200.0;
const MIN_PWM: f32 = 0.0;
const MAX_PWM: f32 = 255.0;
const BOOT_COOLDOWN_SECS: u64 = 30;

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

struct PidState {
    integral: f32,
    prev_error: Option<f32>,
    prev_output: f32,
}

impl PidState {
    fn new() -> Self {
        Self {
            integral: 0.0,
            prev_error: None,
            prev_output: 0.0,
        }
    }

    fn update(&mut self, temp_c: f32) -> u32 {
        let error = temp_c - SETPOINT_C;

        self.integral = (self.integral + error).clamp(-INTEGRAL_CLAMP, INTEGRAL_CLAMP);

        let derivative = match self.prev_error {
            Some(prev) => error - prev,
            None => 0.0,
        };
        self.prev_error = Some(error);

        let output = KP * error + KI * self.integral + KD * derivative;
        let clamped = output.clamp(MIN_PWM, MAX_PWM);

        // Anti-windup: if output saturated, don't accumulate integral further
        if (output > MAX_PWM && error > 0.0) || (output < MIN_PWM && error < 0.0) {
            self.integral -= error;
        }

        self.prev_output = clamped;
        clamped as u32
    }

    fn reset(&mut self) {
        self.integral = 0.0;
        self.prev_error = None;
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
                "thermal: PID fan control started (setpoint={SETPOINT_C}C, Kp={KP}, Ki={KI}, Kd={KD})"
            );

            // Full blast on boot to absorb GStreamer hw-decode startup spike.
            hwmon::set_fan(Some(255));
            info!("thermal: boot cooldown — fan 100% for {BOOT_COOLDOWN_SECS}s");

            let boot_start = std::time::Instant::now();
            let mut pid = PidState::new();
            let mut was_override = false;
            let mut boot_phase = true;

            loop {
                std::thread::sleep(POLL_INTERVAL);

                if is_manual_override_active() {
                    if !was_override {
                        info!("thermal: manual override active, PID paused");
                        was_override = true;
                    }
                    continue;
                }

                if was_override {
                    info!("thermal: manual override expired, PID resuming");
                    pid.reset();
                    was_override = false;
                }

                if boot_phase {
                    if boot_start.elapsed() >= Duration::from_secs(BOOT_COOLDOWN_SECS) {
                        info!("thermal: boot cooldown complete, PID taking over");
                        boot_phase = false;
                        pid.reset();
                    } else {
                        hwmon::set_fan(Some(255));
                        continue;
                    }
                }

                let Some(temp) = hwmon::read_temp_c() else {
                    continue;
                };

                let pwm = pid.update(temp);
                if !hwmon::set_fan(Some(pwm)) {
                    warn!("thermal: failed to set fan PWM {pwm}");
                }
            }
        })
        .expect("spawn thermal thread");
}
