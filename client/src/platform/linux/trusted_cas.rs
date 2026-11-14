//! Request the root-owned service; retain WebKit's normal TLS verification.
use crate::bundle::TrustedCa;
use crate::trusted_cas::{revision, validate, TrustReport};
use std::{fs, path::Path};

pub fn sync(cas: &[TrustedCa]) -> TrustReport {
    let rev = revision(cas);
    let mut report = TrustReport { revision: rev.clone(), state: "pending".into(), message: "Waiting for the certificate service".into() };
    if let Err(error) = validate(cas) { report.state = "error".into(); report.message = error; return report; }
    let status_path = Path::new("/var/lib/betterframe/trusted-cas/status.json");
    if let Ok(bytes) = fs::read(status_path) {
        if let Ok(status) = serde_json::from_slice::<TrustReport>(&bytes) {
            if status.revision == rev && status.state == "applied" { return status; }
            if status.revision == rev { report = status; }
        }
    }
    if cas.is_empty() && !status_path.exists() && !Path::new("/var/lib/betterframe/trusted-cas/ownership.json").exists() {
        report.state = "applied".into(); report.message.clear(); return report;
    }
    if !Path::new("/usr/local/sbin/betterframe-trusted-cas.py").exists() {
        report.state = "manual_action".into();
        report.message = "Install the BetterFrame certificate service (OS update or rerun Linux setup)".into();
        return report;
    }
    let directory = Path::new("/var/lib/betterframe/kiosk");
    let request = directory.join("trusted-cas-request.json");
    let bytes = serde_json::to_vec(&serde_json::json!({ "trusted_cas": cas })).unwrap();
    // Avoid retriggering the path unit while the existing request is being applied.
    if fs::read(&request).ok().as_deref() != Some(bytes.as_slice()) {
        let temporary = directory.join(format!(".trusted-cas-{}.tmp", rand::random::<u64>()));
        let result = fs::write(&temporary, &bytes).and_then(|()| fs::rename(&temporary, &request));
        if let Err(error) = result {
            let _ = fs::remove_file(temporary);
            report.state = "error".into(); report.message = format!("Request CA provisioning: {error}");
        }
    }
    report
}
