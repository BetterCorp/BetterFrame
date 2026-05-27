//! Tailscale VPN status + auth from admin UI.

use std::process::Command;
use tracing::{info, warn};

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct TailscaleStatus {
    pub installed: bool,
    pub running: bool,
    pub logged_in: bool,
    pub ip: Option<String>,
    pub hostname: Option<String>,
    pub backend_state: String,
}

pub fn get_status() -> TailscaleStatus {
    let mut status = TailscaleStatus::default();

    let installed = Command::new("tailscale").arg("version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    status.installed = installed;
    if !installed { return status; }

    let out = match Command::new("tailscale").args(["status", "--json"]).output() {
        Ok(o) if o.status.success() => o,
        _ => {
            status.backend_state = "not running".into();
            return status;
        }
    };

    let json: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => return status,
    };

    status.running = true;
    status.backend_state = json.get("BackendState")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    status.logged_in = status.backend_state == "Running";

    if let Some(self_node) = json.get("Self") {
        status.ip = self_node.get("TailscaleIPs")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        status.hostname = self_node.get("HostName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }

    status
}

pub fn authenticate(auth_key: &str) -> Result<(), String> {
    info!("tailscale: authenticating with auth key");
    let status = Command::new("tailscale")
        .args(["up", "--authkey", auth_key, "--ssh"])
        .output()
        .map_err(|e| format!("tailscale up: {e}"))?;
    if !status.status.success() {
        let stderr = String::from_utf8_lossy(&status.stderr);
        warn!("tailscale: auth failed: {stderr}");
        return Err(format!("tailscale up failed: {}", stderr.trim()));
    }
    info!("tailscale: authenticated successfully");
    Ok(())
}
