//! Request the root-owned service; retain WebKit's normal TLS verification.
use crate::bundle::TrustedCa;
use crate::trusted_cas::{revision, validate, TrustReport};
use std::{fs, io::Write, path::Path, sync::{Mutex, atomic::{AtomicBool, Ordering}}};

static REQUEST_LOCK: Mutex<()> = Mutex::new(());
static RESETTING: AtomicBool = AtomicBool::new(false);

pub fn reset() -> TrustReport {
    RESETTING.store(true, Ordering::SeqCst);
    sync(&[])
}

pub fn sync(cas: &[TrustedCa]) -> TrustReport {
    let _guard = REQUEST_LOCK.lock().unwrap();
    let cas = if RESETTING.load(Ordering::SeqCst) { &[] } else { cas };
    sync_at(cas, Path::new("/var/lib/betterframe/trusted-cas"),
        Path::new("/var/lib/betterframe/kiosk/trusted-cas-request.json"),
        Path::new("/usr/local/sbin/betterframe-trusted-cas.py"))
}

fn exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn sync_at(cas: &[TrustedCa], state: &Path, request: &Path, helper: &Path) -> TrustReport {
    let rev = revision(cas);
    let mut report = TrustReport { revision: rev.clone(), state: "pending".into(), message: "Waiting for the certificate service".into() };
    if let Err(error) = validate(cas) { return crate::trusted_cas::load_error(error); }
    let status_path = state.join("status.json");
    let pending = match exists(request).and_then(|live| exists(&state.join("processing.json")).map(|claimed| live || claimed)) {
        Ok(pending) => pending,
        Err(error) => return crate::trusted_cas::load_error(error),
    };
    if let Ok(bytes) = fs::read(&status_path) {
        if let Ok(status) = serde_json::from_slice::<TrustReport>(&bytes) {
            // A prior applied status cannot cancel an outstanding newer addition.
            if status.revision == rev && status.state == "applied" && !pending { return status; }
            if status.revision == rev && status.state != "applied" { report = status; }
        }
    }
    if cas.is_empty() && !pending && !status_path.exists() && !state.join("ownership.json").exists() {
        report.state = "applied".into(); report.message.clear(); return report;
    }
    let installed = helper.exists();
    if installed || pending {
        let bytes = serde_json::to_vec(&serde_json::json!({ "trusted_cas": cas })).unwrap();
        if fs::read(request).ok().as_deref() != Some(bytes.as_slice()) {
            let directory = request.parent().unwrap();
            let temporary = directory.join(format!(".trusted-cas-{}.tmp", rand::random::<u64>()));
            let result = (|| {
                let mut file = fs::OpenOptions::new().create_new(true).write(true).open(&temporary)?;
                file.write_all(&bytes)?; file.sync_all()?;
                fs::rename(&temporary, request)?;
                fs::File::open(directory)?.sync_all()
            })();
            if let Err(error) = result {
                let _ = fs::remove_file(temporary);
                return crate::trusted_cas::load_error(format!("Request CA provisioning: {error}"));
            }
        }
    }
    if !installed {
        report.state = "manual_action".into();
        report.message = "Install the BetterFrame certificate service (OS update or rerun Linux setup)".into();
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reset_supersedes_live_or_claimed_additions_even_when_empty_was_applied() {
        let directory = std::env::temp_dir().join(format!("bf-ca-queue-{}-{}", std::process::id(), rand::random::<u64>()));
        fs::create_dir_all(&directory).unwrap();
        let request = directory.join("request.json"); let helper = directory.join("helper");
        fs::write(&helper, b"installed").unwrap();
        let applied = TrustReport { revision: revision(&[]), state: "applied".into(), message: String::new() };
        fs::write(directory.join("status.json"), serde_json::to_vec(&applied).unwrap()).unwrap();
        let ca = TrustedCa { pem: "test".into(), fingerprint_sha256: "a".repeat(64) };
        assert_eq!(sync_at(&[ca.clone()], &directory, &request, &helper).state, "pending");
        assert_eq!(sync_at(&[], &directory, &request, &helper).state, "pending");
        let desired: serde_json::Value = serde_json::from_slice(&fs::read(&request).unwrap()).unwrap();
        assert_eq!(desired["trusted_cas"], serde_json::json!([]));
        fs::remove_file(&request).unwrap();
        fs::write(directory.join("processing.json"), serde_json::to_vec(&serde_json::json!({"trusted_cas": [ca]})).unwrap()).unwrap();
        assert_eq!(sync_at(&[], &directory, &request, &helper).state, "pending");
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(&request).unwrap()).unwrap()["trusted_cas"], serde_json::json!([]));
        fs::remove_dir_all(directory).unwrap();
    }
}
