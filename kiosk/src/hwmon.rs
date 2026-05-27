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
use std::process::Command;
use std::time::Duration;
use tracing::warn;

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct HwInfo {
    pub cpu_temp_c: Option<f32>,
    pub cpu_load_percent: Option<f32>,
    pub fan_rpm: Option<u32>,
    pub fan_pwm: Option<u32>,
    pub memory_total_mb: Option<u64>,
    pub memory_used_mb: Option<u64>,
    pub disk_total_mb: Option<u64>,
    pub disk_free_mb: Option<u64>,
    pub disk_used_percent: Option<f32>,
    pub partitions: Vec<PartitionInfo>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PartitionInfo {
    pub device: String,
    pub mountpoint: String,
    pub total_mb: u64,
    pub used_mb: u64,
    pub free_mb: u64,
    pub used_percent: f32,
}

pub fn read() -> HwInfo {
    let memory = read_memory();
    let disk = read_disk();
    HwInfo {
        cpu_temp_c: read_temp(),
        cpu_load_percent: read_cpu_load_percent(),
        fan_rpm: read_u32_in_hwmon("fan1_input"),
        fan_pwm: read_u32_in_hwmon("pwm1"),
        memory_total_mb: memory.map(|m| m.0),
        memory_used_mb: memory.map(|m| m.1),
        disk_total_mb: disk.map(|d| d.0),
        disk_free_mb: disk.map(|d| d.1),
        disk_used_percent: disk.map(|d| d.2),
        partitions: read_partitions(),
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

pub fn read_temp_c() -> Option<f32> {
    read_temp()
}

fn read_temp() -> Option<f32> {
    let raw = fs::read_to_string("/sys/class/thermal/thermal_zone0/temp").ok()?;
    let m: i64 = raw.trim().parse().ok()?;
    Some(m as f32 / 1000.0)
}

fn read_cpu_load_percent() -> Option<f32> {
    let a = read_proc_stat_cpu()?;
    std::thread::sleep(Duration::from_millis(100));
    let b = read_proc_stat_cpu()?;
    let idle_delta = b.idle.saturating_sub(a.idle);
    let total_delta = b.total.saturating_sub(a.total);
    if total_delta == 0 {
        return None;
    }
    Some(((total_delta - idle_delta) as f32 / total_delta as f32) * 100.0)
}

struct CpuSample {
    idle: u64,
    total: u64,
}

fn read_proc_stat_cpu() -> Option<CpuSample> {
    let raw = fs::read_to_string("/proc/stat").ok()?;
    let line = raw.lines().find(|l| l.starts_with("cpu "))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if nums.len() < 5 {
        return None;
    }
    let idle = nums.get(3).copied().unwrap_or(0) + nums.get(4).copied().unwrap_or(0);
    let total = nums.iter().copied().sum();
    Some(CpuSample { idle, total })
}

fn read_memory() -> Option<(u64, u64)> {
    let raw = fs::read_to_string("/proc/meminfo").ok()?;
    let mut total_kb = None;
    let mut available_kb = None;
    for line in raw.lines() {
        if let Some(v) = line.strip_prefix("MemTotal:") {
            total_kb = v
                .split_whitespace()
                .next()
                .and_then(|n| n.parse::<u64>().ok());
        } else if let Some(v) = line.strip_prefix("MemAvailable:") {
            available_kb = v
                .split_whitespace()
                .next()
                .and_then(|n| n.parse::<u64>().ok());
        }
    }
    let total = total_kb? / 1024;
    let available = available_kb? / 1024;
    Some((total, total.saturating_sub(available)))
}

fn read_disk() -> Option<(u64, u64, f32)> {
    let path = if std::path::Path::new("/var/lib/betterframe").exists() {
        "/var/lib/betterframe"
    } else {
        "/"
    };
    let out = Command::new("df").args(["-kP", path]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let line = text.lines().nth(1)?;
    let cols: Vec<&str> = line.split_whitespace().collect();
    if cols.len() < 5 {
        return None;
    }
    let total_mb = cols[1].parse::<u64>().ok()? / 1024;
    let used_mb = cols[2].parse::<u64>().ok()? / 1024;
    let free_mb = cols[3].parse::<u64>().ok()? / 1024;
    let used_percent = if total_mb == 0 {
        0.0
    } else {
        (used_mb as f32 / total_mb as f32) * 100.0
    };
    Some((total_mb, free_mb, used_percent))
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
        if path.join("pwm1").exists() {
            return Some(path);
        }
    }
    None
}

fn read_partitions() -> Vec<PartitionInfo> {
    let out = match Command::new("df").args(["-kP"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = match String::from_utf8(out.stdout) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let interesting = ["/", "/boot/firmware", "/var/lib/betterframe"];
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 6 {
                return None;
            }
            let mountpoint = cols[5];
            if !interesting.contains(&mountpoint) {
                return None;
            }
            let total_kb = cols[1].parse::<u64>().ok()?;
            let used_kb = cols[2].parse::<u64>().ok()?;
            let free_kb = cols[3].parse::<u64>().ok()?;
            let total_mb = total_kb / 1024;
            let used_mb = used_kb / 1024;
            let free_mb = free_kb / 1024;
            let used_percent = if total_mb == 0 {
                0.0
            } else {
                (used_mb as f32 / total_mb as f32) * 100.0
            };
            Some(PartitionInfo {
                device: cols[0].to_string(),
                mountpoint: mountpoint.to_string(),
                total_mb,
                used_mb,
                free_mb,
                used_percent,
            })
        })
        .collect()
}
