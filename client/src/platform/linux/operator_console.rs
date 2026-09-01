//! Local Operator Console identity and TLS material.
//!
//! This credential surface is deliberately separate from `local.key`: a
//! station can view/control cameras and wall focus, but it cannot use the
//! broad LAN automation or admin proxy routes.

use std::fs;
use std::net::IpAddr;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_TTL_SECONDS: u64 = 600;

#[derive(Debug, Clone, Serialize)]
pub struct EnrollmentInfo {
    pub code: String,
    pub expires_at: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StationSummary {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnrolledStation {
    pub id: String,
    pub name: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StationRecord {
    id: String,
    name: String,
    token_hash: String,
    created_at: u64,
    #[serde(default)]
    revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingEnrollment {
    name: String,
    code_hash: String,
    expires_at: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StationStore {
    #[serde(default)]
    stations: Vec<StationRecord>,
    #[serde(default)]
    pending: Option<PendingEnrollment>,
}

#[derive(Clone)]
pub struct OperatorAuth {
    store: Arc<Mutex<StationStore>>,
}

static OPERATOR_AUTH: OnceLock<OperatorAuth> = OnceLock::new();

pub fn shared_auth() -> OperatorAuth {
    OPERATOR_AUTH.get_or_init(OperatorAuth::load).clone()
}

impl OperatorAuth {
    pub fn load() -> Self {
        let path = crate::server::state_file("operator-stations.json");
        let store = crate::at_rest::read_maybe_encrypted(&path)
            .and_then(|bytes| serde_json::from_slice::<StationStore>(&bytes).ok())
            .unwrap_or_default();
        Self {
            store: Arc::new(Mutex::new(store)),
        }
    }

    pub fn create_enrollment(&self, name: &str) -> Result<EnrollmentInfo, String> {
        let mut random = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut random);
        let code: String = random
            .iter()
            .map(|byte| CODE_ALPHABET[*byte as usize % CODE_ALPHABET.len()] as char)
            .collect();
        let expires_at = unix_now().saturating_add(CODE_TTL_SECONDS);
        let mut store = self.store.lock().map_err(|_| "station store lock failed")?;
        store.pending = Some(PendingEnrollment {
            name: name.trim().chars().take(128).collect(),
            code_hash: digest(&code),
            expires_at,
        });
        persist(&store)?;
        Ok(EnrollmentInfo { code, expires_at })
    }

    pub fn enroll(&self, code: &str) -> Result<EnrolledStation, String> {
        let mut store = self.store.lock().map_err(|_| "station store lock failed")?;
        let pending = store.pending.take().ok_or("no enrollment is pending")?;
        if unix_now() > pending.expires_at
            || !constant_time_eq(
                &pending.code_hash,
                &digest(&code.trim().to_ascii_uppercase()),
            )
        {
            persist(&store)?;
            return Err("invalid or expired station code".to_string());
        }

        let mut id_bytes = [0u8; 16];
        let mut token_bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        rand::thread_rng().fill_bytes(&mut token_bytes);
        let id = hex::encode(id_bytes);
        let token = format!("bfs_{}", hex::encode(token_bytes));
        let name = if pending.name.trim().is_empty() {
            "Operator station".to_string()
        } else {
            pending.name
        };
        store.stations.push(StationRecord {
            id: id.clone(),
            name: name.clone(),
            token_hash: digest(&token),
            created_at: unix_now(),
            revoked: false,
        });
        persist(&store)?;
        Ok(EnrolledStation { id, name, token })
    }

    pub fn verify(&self, token: &str) -> bool {
        let wanted = digest(token);
        self.store.lock().ok().is_some_and(|store| {
            store
                .stations
                .iter()
                .any(|station| !station.revoked && constant_time_eq(&station.token_hash, &wanted))
        })
    }

    pub fn list(&self) -> Vec<StationSummary> {
        self.store
            .lock()
            .ok()
            .map(|store| {
                store
                    .stations
                    .iter()
                    .map(|station| StationSummary {
                        id: station.id.clone(),
                        name: station.name.clone(),
                        created_at: station.created_at,
                        revoked: station.revoked,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn revoke(&self, id: &str) -> Result<(), String> {
        let mut store = self.store.lock().map_err(|_| "station store lock failed")?;
        let station = store
            .stations
            .iter_mut()
            .find(|station| station.id == id)
            .ok_or("station not found")?;
        station.revoked = true;
        persist(&store)
    }
}

pub struct TlsMaterial {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
    pub fingerprint: String,
}

pub fn load_or_create_tls(host: &str) -> Result<TlsMaterial, String> {
    let cert_path = crate::server::state_file("operator-console.crt");
    let key_path = crate::server::state_file("operator-console.key");
    let host_path = crate::server::state_file("operator-console.host");
    let existing_host = crate::at_rest::read_text_maybe_encrypted(&host_path);
    if existing_host.as_deref() == Some(host) {
        if let (Ok(cert_pem), Some(key_pem)) = (
            fs::read(&cert_path),
            crate::at_rest::read_maybe_encrypted(&key_path),
        ) {
            return Ok(TlsMaterial {
                fingerprint: fingerprint(&cert_pem),
                cert_pem,
                key_pem,
            });
        }
    }

    let nonce = format!("{}-{}", std::process::id(), unix_now());
    let tmp_cert = std::env::temp_dir().join(format!("bf-operator-{nonce}.crt"));
    let tmp_key = std::env::temp_dir().join(format!("bf-operator-{nonce}.key"));
    let san = if host.parse::<IpAddr>().is_ok() {
        format!("subjectAltName=IP:{host}")
    } else {
        format!("subjectAltName=DNS:{host}")
    };
    let status = Command::new("openssl")
        .args([
            "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "3650",
        ])
        .arg("-keyout")
        .arg(&tmp_key)
        .arg("-out")
        .arg(&tmp_cert)
        .arg("-subj")
        .arg(format!("/CN={host}"))
        .arg("-addext")
        .arg(san)
        .status()
        .map_err(|err| format!("openssl launch failed: {err}"))?;
    if !status.success() {
        let _ = fs::remove_file(&tmp_cert);
        let _ = fs::remove_file(&tmp_key);
        return Err("openssl certificate generation failed".to_string());
    }
    let cert_pem = fs::read(&tmp_cert).map_err(|err| format!("certificate read failed: {err}"))?;
    let key_pem = fs::read(&tmp_key).map_err(|err| format!("private key read failed: {err}"))?;
    let _ = fs::remove_file(&tmp_cert);
    let _ = fs::remove_file(&tmp_key);
    fs::write(&cert_path, &cert_pem).map_err(|err| format!("certificate persist failed: {err}"))?;
    crate::at_rest::write_encrypted(&key_path, &key_pem)
        .map_err(|err| format!("private key persist failed: {err}"))?;
    crate::at_rest::write_encrypted(&host_path, host.as_bytes())
        .map_err(|err| format!("certificate host persist failed: {err}"))?;
    Ok(TlsMaterial {
        fingerprint: fingerprint(&cert_pem),
        cert_pem,
        key_pem,
    })
}

pub fn public_certificate() -> Option<Vec<u8>> {
    fs::read(crate::server::state_file("operator-console.crt")).ok()
}

fn persist(store: &StationStore) -> Result<(), String> {
    let bytes = serde_json::to_vec(store).map_err(|err| format!("station encode failed: {err}"))?;
    crate::at_rest::write_encrypted(&crate::server::state_file("operator-stations.json"), &bytes)
        .map_err(|err| format!("station persist failed: {err}"))
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn fingerprint(cert_pem: &[u8]) -> String {
    Sha256::digest(cert_pem)
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_compare_is_exact() {
        assert!(constant_time_eq(&digest("same"), &digest("same")));
        assert!(!constant_time_eq(&digest("same"), &digest("different")));
    }
}
