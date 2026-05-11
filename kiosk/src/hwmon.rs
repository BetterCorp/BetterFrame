//! Pi5 hwmon — read CPU temp + fan RPM, override fan PWM.
//!
//! Read paths:
//!   - /sys/class/thermal/thermal_zone0/temp (millideg C)
//!   - /sys/class/hwmon/hwmon*/fan1_input    (RPM)
//!   - /sys/class/hwmon/hwmon*/pwm1          (0-255 current)
//!
//! Override:
//!   - echo 1 > pwm1_enable  (manual)
//!   - echo N > pwm1         (0-255)
//!   - echo 2 > pwm1_enable  (auto / cooling_device controlled)

use std::fs;
use std::path::PathBuf;
use tracing::warn;

#[derive(Debug, Clone, Default)]
pub struct HwInfo {
    pub cpu_temp_c: Option<f32>,
    pub fan_rpm: Option<u32>,
    pub fan_pwm: Option<u32>,
}

pub fn read() -> HwInfo {
    HwInfo {
        cpu_temp_c: read_temp(),
        fan_rpm: read_u32_in_hwmon("fan1_input"),
        fan_pwm: read_u32_in_hwmon("pwm1"),
    }
}

/// Set fan PWM (0-255). If pwm is None → restore auto mode.
pub fn set_fan(pwm: Option<u32>) -> bool {
    let Some(dir) = find_fan_hwmon() else {
        warn!("hwmon: no fan device found");
        return false;
    };
    let pwm_enable = dir.join("pwm1_enable");
    let pwm_path = dir.join("pwm1");

    match pwm {
        Some(value) => {
            let v = value.min(255);
            if fs::write(&pwm_enable, "1").is_err() {
                warn!("hwmon: cannot write pwm1_enable");
                return false;
            }
            if fs::write(&pwm_path, v.to_string()).is_err() {
                warn!("hwmon: cannot write pwm1");
                return false;
            }
            true
        }
        None => fs::write(&pwm_enable, "2").is_ok(),
    }
}

fn read_temp() -> Option<f32> {
    let raw = fs::read_to_string("/sys/class/thermal/thermal_zone0/temp").ok()?;
    let m: i64 = raw.trim().parse().ok()?;
    Some(m as f32 / 1000.0)
}

fn read_u32_in_hwmon(file: &str) -> Option<u32> {
    let dir = find_fan_hwmon()?;
    let raw = fs::read_to_string(dir.join(file)).ok()?;
    raw.trim().parse().ok()
}

fn find_fan_hwmon() -> Option<PathBuf> {
    let entries = fs::read_dir("/sys/class/hwmon").ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        // Look for hwmon dirs that have pwm1 (the fan controller)
        if path.join("pwm1").exists() {
            return Some(path);
        }
    }
    None
}
