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
//! Format: `magic[4] || nonce[12] || ciphertext+tag` ("BFE1" magic).
//! AES-256-GCM. Key derived via HKDF-SHA256 from the hardware id.

use std::fs;

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit},
};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;

const MAGIC: &[u8; 4] = b"BFE1";
const HKDF_SALT: &[u8] = b"betterframe-at-rest-v1";
const HKDF_INFO: &[u8] = b"file-encryption";

/// Read a value uniquely tied to THIS Pi. Pi 5 firmware exposes the CPU
/// serial via device-tree; older kernels stash it in /proc/cpuinfo. On
/// non-Pi dev machines fall back to /etc/machine-id (per-install rather
/// than per-board, but still doesn't ship with the source repo). Always
/// returns a non-empty string so derive_key never panics.
fn hardware_id() -> String {
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

fn derive_key() -> [u8; 32] {
    let hw = hardware_id();
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), hw.as_bytes());
    let mut out = [0u8; 32];
    hk.expand(HKDF_INFO, &mut out).expect("HKDF expand: 32 bytes ≤ 255*32");
    out
}

/// Encrypt plaintext for on-disk storage. Each call uses a fresh random
/// nonce (AES-GCM is unsafe to reuse a nonce under the same key).
pub fn encrypt_for_disk(plaintext: &[u8]) -> Vec<u8> {
    let key_bytes = derive_key();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .expect("AES-GCM encrypt: only fails on >2^36 byte input");
    let mut out = Vec::with_capacity(MAGIC.len() + nonce_bytes.len() + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    out
}

/// Decrypt an on-disk blob. Returns Err for both "not our format" and
/// "decrypt failed" — caller decides whether to treat unrecognized data
/// as legacy plaintext (migration path).
pub fn decrypt_from_disk(blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < MAGIC.len() + 12 + 16 {
        return Err("blob too short".to_string());
    }
    if &blob[..MAGIC.len()] != MAGIC {
        return Err("missing BFE1 magic".to_string());
    }
    let key_bytes = derive_key();
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&blob[MAGIC.len()..MAGIC.len() + 12]);
    cipher
        .decrypt(nonce, &blob[MAGIC.len() + 12..])
        .map_err(|e| format!("AES-GCM decrypt: {e}"))
}

/// Read a file and decrypt if it's a BFE1 blob; otherwise return it raw.
/// Lets us migrate existing kiosks (which have plaintext kiosk.key on disk
/// from before this module shipped) without losing pairing: read plaintext
/// → caller uses it → caller eventually overwrites via `write_encrypted`
/// which re-stores it ciphertext. Returns None if the file doesn't exist.
pub fn read_maybe_encrypted(path: &std::path::Path) -> Option<Vec<u8>> {
    let bytes = fs::read(path).ok()?;
    match decrypt_from_disk(&bytes) {
        Ok(pt) => Some(pt),
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
        assert_ne!(&ct[..MAGIC.len() + 12], pt);
        assert_eq!(&ct[..MAGIC.len()], MAGIC);
        let back = decrypt_from_disk(&ct).expect("decrypt");
        assert_eq!(back, pt);
    }

    #[test]
    fn round_trip_long_json() {
        let pt = serde_json::to_vec(&serde_json::json!({
            "kiosk_id": 42,
            "cameras": [{"id": 1, "rtsp": "rtsp://u:p@host/path"}],
        })).unwrap();
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
