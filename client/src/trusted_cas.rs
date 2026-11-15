//! Wire contract shared by OS trust provisioners. No TLS-error bypasses.
use crate::bundle::TrustedCa;
use sha2::{Digest, Sha256};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TrustReport {
    pub revision: String,
    pub state: String,
    pub message: String,
}

pub fn revision(cas: &[TrustedCa]) -> String {
    let mut fingerprints: Vec<_> = cas.iter().map(|ca| ca.fingerprint_sha256.as_str()).collect();
    fingerprints.sort_unstable();
    format!("{:x}", Sha256::digest(fingerprints.join("\n").as_bytes()))
}

pub fn validate(cas: &[TrustedCa]) -> Result<(), String> {
    if cas.len() > 32 { return Err("At most 32 CA certificates are supported".into()); }
    let mut seen = std::collections::HashSet::new();
    for ca in cas {
        if ca.pem.len() > 16384 || ca.fingerprint_sha256.len() != 64
            || !ca.fingerprint_sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            || !seen.insert(&ca.fingerprint_sha256) {
            return Err("Invalid CA assignment".into());
        }
    }
    Ok(())
}

/// An unreadable authoritative cache must never turn into a revocation request.
pub fn load_cached_assignment(
    path: &std::path::Path,
    read: impl FnOnce(&std::path::Path) -> Result<Vec<u8>, String>,
    legacy: impl FnOnce() -> Result<Vec<TrustedCa>, String>,
) -> Result<Vec<TrustedCa>, String> {
    let cas = if path.try_exists().map_err(|error| format!("Inspect CA cache: {error}"))? {
        let bytes = read(path)?;
        serde_json::from_slice(&bytes).map_err(|error| format!("Decode CA cache: {error}"))?
    } else { legacy()? };
    validate(&cas)?;
    Ok(cas)
}

pub fn load_error(message: String) -> TrustReport {
    TrustReport { revision: revision(&[]), state: "error".into(), message: message.chars().take(1024).collect() }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_failures_cannot_become_empty_assignments() {
        let path = std::env::temp_dir().join(format!("bf-trust-cache-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::write(&path, b"not JSON").unwrap();
        let read = |path: &std::path::Path| std::fs::read(path).map_err(|error| error.to_string());
        assert!(load_cached_assignment(&path, read, || panic!("authoritative cache cannot fall back")).is_err());
        assert!(load_cached_assignment(&path, |_| Err("decryption failed".into()), || panic!("cannot fall back")).is_err());
        std::fs::write(&path, b"[]").unwrap();
        assert!(load_cached_assignment(&path, read, || panic!("valid empty cache takes precedence")).unwrap().is_empty());
        std::fs::remove_file(&path).unwrap();
        assert!(load_cached_assignment(&path, read, || Ok(Vec::new())).unwrap().is_empty());
    }

    #[test]
    fn revisions_are_canonical_and_input_is_bounded() {
        assert_eq!(revision(&[]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        let a = TrustedCa { pem: "pem".into(), fingerprint_sha256: "a".repeat(64) };
        let b = TrustedCa { pem: "pem".into(), fingerprint_sha256: "b".repeat(64) };
        assert_eq!(revision(&[a.clone(), b.clone()]), revision(&[b, a.clone()]));
        assert!(validate(&[a.clone(), a.clone()]).is_err());
        assert!(validate(&[TrustedCa { fingerprint_sha256: "../root".into(), ..a }]).is_err());
    }
}
