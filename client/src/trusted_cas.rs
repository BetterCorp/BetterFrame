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

#[cfg(test)]
mod tests {
    use super::*;
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
