use super::*;
use std::process::Stdio;
use std::os::windows::process::CommandExt;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use crate::trusted_cas::{revision, validate, TrustReport};
use base64::Engine as _;

const SCRIPT: &str = include_str!("trusted-cas.ps1");

pub(super) fn trust_report() -> Option<TrustReport> {
    fs::read(state_dir().join("trusted-ca-status.json")).ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn reconcile(cas: &[crate::bundle::TrustedCa]) -> Result<(bool, Option<String>), String> {
    validate(cas)?;
    let directory = state_dir().join("Trust");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    if cas.is_empty() && !directory.join("ownership.json").exists() {
        let report = TrustReport { revision: revision(cas), state: "applied".into(), message: String::new() };
        let bytes = serde_json::to_vec(&report).map_err(|error| error.to_string())?;
        fs::write(state_dir().join("trusted-ca-status.json"), bytes).map_err(|error| error.to_string())?;
        return Ok((false, None));
    }
    let request = directory.join("request.json");
    fs::write(&request, serde_json::to_vec(&serde_json::json!({"trusted_cas": cas})).unwrap())
        .map_err(|error| error.to_string())?;
    let encoded: Vec<u8> = SCRIPT.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let command = base64::engine::general_purpose::STANDARD.encode(encoded);
    let mut child = Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &command])
        .env("BF_CA_STATE", &directory).env("BF_CA_REQUEST", &request)
        .env("BF_CA_REPORT", state_dir().join("trusted-ca-status.json"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn().map_err(|error| format!("Start certificate installer: {error}"))?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return match status.code() {
                Some(0) => Ok((false, None)), Some(10) => Ok((true, None)),
                Some(11) => Ok((true, Some(trust_report().map(|r| r.message).filter(|m| !m.is_empty()).unwrap_or_else(|| "CA provisioning changed trust before failing".into())))),
                _ => Err(trust_report().map(|r| r.message).unwrap_or_else(|| "Certificate installer failed".into())),
            };
        }
        if start.elapsed() > Duration::from_secs(30) {
            let _ = child.kill(); let _ = child.wait();
            return Err("Certificate installer timed out".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Reset completion requires confirmed removal, including manual installations.
pub(super) fn complete_reset() -> Result<(), String> {
    let (_, error) = reconcile(&[])?;
    if let Some(error) = error { return Err(error); }
    let report = trust_report().ok_or("Missing certificate removal report")?;
    if report.state != "applied" {
        return Err(if report.message.is_empty() { "Certificate removal is incomplete".into() } else { report.message });
    }
    Ok(())
}

/// The elevated agent owns machine trust; an unelevated agent reports manual action.
pub(super) fn reconcile_cached() -> bool {
    let cas = match load_trusted_cas() {
        Ok(cas) => cas,
        Err(error) => {
            let report = crate::trusted_cas::load_error(error);
            if let Ok(bytes) = serde_json::to_vec(&report) { let _ = fs::write(state_dir().join("trusted-ca-status.json"), bytes); }
            return false;
        }
    };
    let (changed, error) = match reconcile(&cas) {
        Ok(result) => result,
        Err(error) => (false, Some(error)),
    };
    if let Some(error) = error {
        let report = TrustReport { revision: revision(&cas), state: "error".into(), message: error.chars().take(1024).collect() };
        if let Ok(bytes) = serde_json::to_vec(&report) { let _ = fs::write(state_dir().join("trusted-ca-status.json"), bytes); }
    }
    changed
}
