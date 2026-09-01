//! Hardware-bound at-rest encryption for kiosk state files.
//!
//! Files in ~/.betterframe-kiosk/ (kiosk.key, local.key, bundle.json) hold
//! the kiosk's bearer token, LAN API key, and a cached bundle that contains
//! RTSP credentials in URL form. Plaintext on the SD card means pulling
//! the card → reading every camera password and impersonating the kiosk.
//!
//! Without a TPM on Pi 5 we can't do "real" at-rest encryption. The best
//! pragmatic defense: derive the encryption key from a value that's bound
//! to the specific Pi (CPU serial via device-tree or /proc/cpuinfo). An
//! attacker pulling the SD now needs both the card AND the matching Pi
//! board to decrypt. Defeats casual SD extraction; doesn't defeat an
//! attacker who has both — at that point they ARE the kiosk.
//!
//! Format: `magic[4] || nonce[12] || ciphertext+tag`. `BFE1` uses the legacy
//! board/machine ID; `BFE2` uses a TPM-sealed random secret. Existing BFE1
//! files are re-encrypted as BFE2 when first read on a TPM-enabled image.

use std::fs;
use std::process::Command;
use std::sync::OnceLock;

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit},
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

const LEGACY_MAGIC: &[u8; 4] = b"BFE1";
const TPM_MAGIC: &[u8; 4] = b"BFE2";
const HKDF_SALT: &[u8] = b"betterframe-at-rest-v1";
const HKDF_INFO: &[u8] = b"file-encryption";

fn active_key() -> &'static ([u8; 4], [u8; 32]) {
    static ACTIVE: OnceLock<([u8; 4], [u8; 32])> = OnceLock::new();
    ACTIVE.get_or_init(|| {
        let sealed = std::path::Path::new("/var/lib/betterframe/at-rest.cred");
        if sealed.is_file() {
            let output = Command::new("systemd-creds")
                .args(["--name=betterframe-at-rest", "decrypt"])
                .arg(sealed)
                .arg("-")
                .output()
                .expect("TPM-sealed at-rest key could not be decrypted");
            if !output.status.success() || output.stdout.is_empty() {
                panic!("TPM-sealed at-rest key could not be decrypted");
            }
            (*TPM_MAGIC, derive_key(&output.stdout))
        } else {
            (*LEGACY_MAGIC, *legacy_key())
        }
    })
}

fn legacy_key() -> &'static [u8; 32] {
    static LEGACY: OnceLock<[u8; 32]> = OnceLock::new();
    LEGACY.get_or_init(|| derive_key(read_hardware_id().as_bytes()))
}

/// Pi firmware exposes the CPU serial via device-tree; older kernels use
/// /proc/cpuinfo. Non-Pi systems fall back to the per-install machine ID.
fn read_hardware_id() -> String {
    if let Ok(s) = fs::read_to_string("/proc/device-tree/serial-number") {
        let trimmed = s.trim_end_matches('\0').trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(s) = fs::read_to_string("/proc/cpuinfo") {
        for line in s.lines() {
            if let Some(rest) = line.trim_start().strip_prefix("Serial") {
                let v = rest.trim_start_matches(':').trim();
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    if let Ok(s) = fs::read_to_string("/etc/machine-id") {
        let trimmed = s.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    // Last-ditch constant. Defeats nothing but lets dev environments without
    // any persistent id still round-trip files.
    "betterframe-dev-fallback".to_string()
}

fn derive_key(material: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), material);
    let mut out = [0u8; 32];
    hk.expand(HKDF_INFO, &mut out)
        .expect("HKDF expand: 32 bytes ≤ 255*32");
    out
}

/// Encrypt plaintext for on-disk storage. Each call uses a fresh random
/// nonce (AES-GCM is unsafe to reuse a nonce under the same key).
pub fn encrypt_for_disk(plaintext: &[u8]) -> Vec<u8> {
    let (magic, key_bytes) = active_key();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .expect("AES-GCM encrypt: only fails on >2^36 byte input");
    let mut out = Vec::with_capacity(magic.len() + nonce_bytes.len() + ciphertext.len());
    out.extend_from_slice(magic);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    out
}

/// Decrypt an on-disk blob. Returns Err for both "not our format" and
/// "decrypt failed" — caller decides whether to treat unrecognized data
/// as legacy plaintext (migration path).
pub fn decrypt_from_disk(blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < LEGACY_MAGIC.len() + 12 + 16 {
        return Err("blob too short".to_string());
    }
    let key_bytes = match &blob[..LEGACY_MAGIC.len()] {
        magic if magic == LEGACY_MAGIC => legacy_key(),
        magic if magic == TPM_MAGIC && active_key().0 == *TPM_MAGIC => &active_key().1,
        magic if magic == TPM_MAGIC => return Err("TPM credential missing".to_string()),
        _ => return Err("missing BetterFrame encryption magic".to_string()),
    };
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key_bytes));
    let nonce = Nonce::from_slice(&blob[LEGACY_MAGIC.len()..LEGACY_MAGIC.len() + 12]);
    cipher
        .decrypt(nonce, &blob[LEGACY_MAGIC.len() + 12..])
        .map_err(|e| format!("AES-GCM decrypt: {e}"))
}

/// Read a file and decrypt if it is a BetterFrame encrypted blob; otherwise
/// return it raw.
/// Lets us migrate existing kiosks (which have plaintext kiosk.key on disk
/// from before this module shipped) without losing pairing: read plaintext
/// → caller uses it → caller eventually overwrites via `write_encrypted`
/// which re-stores it ciphertext. Returns None if the file doesn't exist.
pub fn read_maybe_encrypted(path: &std::path::Path) -> Option<Vec<u8>> {
    let bytes = fs::read(path).ok()?;
    match decrypt_from_disk(&bytes) {
        Ok(pt) => {
            if bytes.starts_with(LEGACY_MAGIC) && active_key().0 == *TPM_MAGIC {
                let _ = write_encrypted(path, &pt);
            }
            Some(pt)
        }
        Err(_) if bytes.starts_with(LEGACY_MAGIC) || bytes.starts_with(TPM_MAGIC) => None,
        Err(_) => Some(bytes), // assume legacy plaintext
    }
}

/// Convenience: read + UTF-8 decode + trim. The state files we store are
/// all small text blobs (hex keys, JSON, URLs) so this is the common path.
pub fn read_text_maybe_encrypted(path: &std::path::Path) -> Option<String> {
    let bytes = read_maybe_encrypted(path)?;
    String::from_utf8(bytes).ok().map(|s| s.trim().to_string())
}

/// Write plaintext encrypted-on-disk. Atomic via tempfile + rename so a
/// crash mid-write can't leave a half-encrypted file.
pub fn write_encrypted(path: &std::path::Path, plaintext: &[u8]) -> std::io::Result<()> {
    let blob = encrypt_for_disk(plaintext);
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &blob)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_short() {
        let pt = b"hello world";
        let ct = encrypt_for_disk(pt);
        assert_ne!(&ct[..LEGACY_MAGIC.len() + 12], pt);
        assert_eq!(&ct[..LEGACY_MAGIC.len()], &active_key().0);
        let back = decrypt_from_disk(&ct).expect("decrypt");
        assert_eq!(back, pt);
    }

    #[test]
    fn round_trip_long_json() {
        let pt = serde_json::to_vec(&serde_json::json!({
            "kiosk_id": 42,
            "cameras": [{"id": 1, "rtsp": "rtsp://u:p@host/path"}],
        }))
        .unwrap();
        let ct = encrypt_for_disk(&pt);
        let back = decrypt_from_disk(&ct).expect("decrypt");
        assert_eq!(back, pt);
    }

    #[test]
    fn legacy_plaintext_read() {
        // read_maybe_encrypted should return the bytes as-is when they're
        // not a BFE1 blob (i.e. the migration path).
        let tmp = std::env::temp_dir().join("bf-at-rest-legacy-test");
        std::fs::write(&tmp, b"plain text content").unwrap();
        let got = read_maybe_encrypted(&tmp).unwrap();
        assert_eq!(got, b"plain text content");
        let _ = std::fs::remove_file(&tmp);
    }
}
