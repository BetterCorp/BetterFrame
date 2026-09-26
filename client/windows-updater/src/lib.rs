//! BF-only update selection and validation, independent of the desktop and enrollment loops.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use betterframe_client_core::{update_policy::Policy, version::is_version_upgrade};
use chrono::{DateTime, Datelike, Timelike, Utc};
use ed25519_dalek::{Signature, VerifyingKey, pkcs8::DecodePublicKey};
use reqwest::blocking::{Client, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    time::Duration,
};

pub const TARGET: &str = "windows-x64";
pub const MAX_BYTES: u64 = 512 * 1024 * 1024;
pub const VERSION: &str = match option_env!("BF_BUILD_VERSION") {
    Some(v) => v,
    None => "0.1.0",
};
pub const PUBLIC_KEY: Option<&str> = option_env!("BF_FIRMWARE_SIGNING_PUBLIC_KEY");
pub const UPGRADE_CODE: &str = "{C57DAC79-D926-492A-800D-190630390291}";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Identity {
    pub server_url: String,
    pub kiosk_key: Option<String>,
    #[serde(default)]
    pub demo: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Artifact {
    pub release_id: String,
    pub version: String,
    pub sha256: String,
    pub signature: String,
    pub size_bytes: u64,
    pub download_url: String,
}

#[derive(Debug, Deserialize)]
pub struct Check {
    pub up_to_date: bool,
    pub update: Option<Artifact>,
    pub update_policy: Option<Policy>,
    pub push_request: Option<String>,
}

#[derive(Debug)]
pub enum Failure {
    Deferred(u64),
    Other(String),
}
impl From<String> for Failure {
    fn from(s: String) -> Self {
        Self::Other(s)
    }
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Deferred(s) => write!(f, "BF deferred download for {s}s"),
            Self::Other(s) => f.write_str(s),
        }
    }
}

pub fn client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

/// Only root-relative BF API paths can carry credentials. Never follow redirects.
pub fn endpoint(origin: &str, path: &str) -> Result<String, String> {
    betterframe_client_core::protocol::discovery_probe(origin)?;
    if !path.starts_with("/api/") || path.contains(['\\', '?', '#']) || path.contains("..") {
        return Err("invalid BF update endpoint".into());
    }
    Ok(format!("{}{path}", origin.trim_end_matches('/')))
}

pub fn window_open(policy: &Policy, now: DateTime<Utc>) -> bool {
    let Ok(zone) = policy.schedule.timezone.parse::<chrono_tz::Tz>() else {
        return false;
    };
    let local = now.with_timezone(&zone);
    policy.schedule.allows(
        local.weekday().num_days_from_sunday() as u8,
        (local.hour() * 60 + local.minute()) as u16,
    )
}

fn decode(response: Response) -> Result<Check, Failure> {
    if response.status().as_u16() == 429 {
        return Err(deferred(&response));
    }
    if !response.status().is_success() {
        return Err(Failure::Other(format!(
            "BF check HTTP {}",
            response.status()
        )));
    }
    let body = response
        .take(1024 * 1024)
        .bytes()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| Failure::Other(e.to_string()))?;
    let check: Check = serde_json::from_slice(&body).map_err(|e| Failure::Other(e.to_string()))?;
    if !check.up_to_date && check.update.is_none() {
        return Err(Failure::Other("missing update metadata".into()));
    }
    Ok(check)
}

/// A valid authenticated up-to-date response is authoritative. Failed control
/// checks recover using persisted policy; no policy means fail closed.
pub fn check(
    client: &Client,
    identity: &Identity,
    policy: Option<&Policy>,
    current: &str,
) -> Result<Check, Failure> {
    if identity.demo {
        return Err(Failure::Other("updates disabled in demo mode".into()));
    }
    let query = [("target", TARGET), ("current", current)];
    if let Some(key) = identity.kiosk_key.as_deref().filter(|k| !k.is_empty()) {
        let url = endpoint(&identity.server_url, "/api/kiosk/firmware/check")?;
        if let Ok(response) = client.get(url).query(&query).bearer_auth(key).send() {
            match decode(response) {
                Ok(mut check) => {
                    // The origin is selected locally, never by a manifest.
                    if let Some(policy) = check.update_policy.as_mut() {
                        policy.server = identity.server_url.clone();
                    }
                    return Ok(check);
                }
                Err(error @ Failure::Deferred(_)) => return Err(error),
                Err(_) => (),
            }
        }
    }
    let policy = policy
        .filter(|p| p.server == identity.server_url)
        .ok_or_else(|| {
            Failure::Other("recovery requires a saved policy for this BF origin".into())
        })?;
    public_check(client, &identity.server_url, policy, current)
}

pub fn public_check(
    client: &Client,
    origin: &str,
    policy: &Policy,
    current: &str,
) -> Result<Check, Failure> {
    let url = endpoint(origin, "/api/firmware/public/check")?;
    let response = client
        .get(url)
        .query(&[("target", TARGET), ("current", current)])
        .query(&policy.selection(false))
        .send()
        .map_err(|e| Failure::Other(e.to_string()))?;
    let mut check = decode(response)?;
    // Public recovery can never grant a maintenance-window override or replace policy.
    check.push_request = None;
    check.update_policy = None;
    Ok(check)
}

fn deferred(response: &Response) -> Failure {
    let delay = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60)
        .clamp(1, 3600);
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as u64
        % 61;
    Failure::Deferred(delay + jitter)
}

pub fn validate_offer(info: &Artifact, current: &str) -> Result<(), String> {
    if !is_version_upgrade(&info.version, current) {
        return Err("offered version is not an upgrade".into());
    }
    if info.size_bytes == 0 || info.size_bytes > MAX_BYTES {
        return Err("invalid MSI size".into());
    }
    if info.release_id.is_empty()
        || !info
            .release_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("invalid release ID".into());
    }
    if ![
        format!("/api/kiosk/firmware/download/{}", info.release_id),
        format!("/api/firmware/public/download/{}", info.release_id),
    ]
    .contains(&info.download_url)
    {
        return Err("artifact is not a BF download route".into());
    }
    Ok(())
}

pub fn verify_file(path: &Path, info: &Artifact, public_key: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != info.size_bytes
        || info.size_bytes > MAX_BYTES
    {
        return Err("MSI size mismatch".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    let digest = format!("{:x}", hash.finalize());
    if digest != info.sha256 {
        return Err("MSI digest mismatch".into());
    }
    let key = VerifyingKey::from_public_key_pem(public_key).map_err(|e| e.to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(info.signature.trim())
        .map_err(|e| e.to_string())?;
    let signature = Signature::from_slice(&bytes).map_err(|e| e.to_string())?;
    key.verify_strict(digest.as_bytes(), &signature)
        .map_err(|_| "MSI publisher signature invalid".into())
}

pub fn download(
    client: &Client,
    identity: &Identity,
    info: &Artifact,
    path: &Path,
    public_key: &str,
) -> Result<(), Failure> {
    let public = format!("/api/firmware/public/download/{}", info.release_id);
    let authenticated = format!("/api/kiosk/firmware/download/{}", info.release_id);
    let send = |route: &str, key: Option<&str>| -> Result<Response, Failure> {
        let mut request = client
            .get(endpoint(&identity.server_url, route)?)
            .timeout(Duration::from_secs(300));
        if let Some(key) = key {
            request = request.bearer_auth(key);
        }
        request.send().map_err(|e| Failure::Other(e.to_string()))
    };
    let response = if let Some(key) = identity.kiosk_key.as_deref() {
        match send(&authenticated, Some(key)) {
            Ok(response) if response.status().is_success() || response.status().as_u16() == 429 => {
                response
            }
            _ => send(&public, None)?,
        }
    } else {
        send(&public, None)?
    };
    if response.status().as_u16() == 429 {
        return Err(deferred(&response));
    }
    if !response.status().is_success() {
        return Err(Failure::Other(format!(
            "BF download HTTP {}",
            response.status()
        )));
    }
    let staged = path.with_extension("part");
    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create(&staged).map_err(|e| e.to_string())?;
        let size = std::io::copy(
            &mut response.take(info.size_bytes.min(MAX_BYTES) + 1),
            &mut file,
        )
        .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if size != info.size_bytes {
            return Err("MSI body size mismatch".into());
        }
        verify_file(&staged, info, public_key)?;
        replace(&staged, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result.map_err(Failure::Other)
}

pub fn save<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let staged = path.with_extension("tmp");
    let mut file = fs::File::create(&staged).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    replace(&staged, path)
}
fn replace(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let wide = |p: &Path| {
            p.as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        if unsafe {
            MoveFileExW(
                wide(from).as_ptr(),
                wide(to).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey, pkcs8::EncodePublicKey};
    use std::net::TcpListener;
    fn policy(origin: &str) -> Policy {
        serde_json::from_value(serde_json::json!({"server":origin,"schedule":{"mode":"always","windows":[],"timezone":"UTC"},"firmware_channel":"beta","firmware_target_version":"1.2.0","os_update_channel":"stable","os_update_target_version":null})).unwrap()
    }
    fn fixture(bytes: &[u8]) -> (Artifact, String) {
        let key = SigningKey::from_bytes(&[7; 32]);
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let signature = URL_SAFE_NO_PAD.encode(key.sign(sha256.as_bytes()).to_bytes());
        (
            Artifact {
                release_id: "release-1".into(),
                version: "1.2.0".into(),
                sha256,
                signature,
                size_bytes: bytes.len() as u64,
                download_url: "/api/kiosk/firmware/download/release-1".into(),
            },
            key.verifying_key()
                .to_public_key_pem(Default::default())
                .unwrap(),
        )
    }
    fn temp() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bf-updater-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn package_signature_size_and_hash_are_all_required() {
        let root = temp();
        let path = root.join("artifact.msi");
        let bytes = b"signed test package";
        let (mut artifact, key) = fixture(bytes);
        fs::write(&path, bytes).unwrap();
        verify_file(&path, &artifact, &key).unwrap();
        artifact.signature = URL_SAFE_NO_PAD.encode([0; 64]);
        assert!(verify_file(&path, &artifact, &key).is_err());
        artifact = fixture(bytes).0;
        fs::write(&path, b"changed test bytes").unwrap();
        assert!(verify_file(&path, &artifact, &key).is_err());
        fs::write(&path, [bytes.as_slice(), b"extra"].concat()).unwrap();
        assert!(verify_file(&path, &artifact, &key).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn no_external_paths_credentials_downgrades_or_unbounded_bodies() {
        for path in [
            "https://github.com/a",
            "//github.com/a",
            "/api/../a",
            "/api/a?url=https://github.com",
            "/api/\\github.com",
        ] {
            assert!(endpoint("https://bf.example", path).is_err());
        }
        assert!(endpoint("https://user:secret@bf.example", "/api/a").is_err());
        assert!(endpoint("http://untrusted.example", "/api/a").is_err());
        let (mut artifact, _) = fixture(b"test");
        assert!(validate_offer(&artifact, "1.2.0").is_err());
        assert!(validate_offer(&artifact, "2.0.0").is_err());
        artifact.download_url = "https://github.com/a".into();
        assert!(validate_offer(&artifact, "1.0.0").is_err());
        artifact = fixture(b"test").0;
        artifact.size_bytes = MAX_BYTES + 1;
        assert!(validate_offer(&artifact, "1.0.0").is_err());
    }
    #[test]
    fn persisted_windows_apply_in_iana_timezone_and_fail_closed() {
        let mut p = policy("https://bf.example");
        p.schedule.mode = "windows".into();
        p.schedule.timezone = "America/New_York".into();
        p.schedule.windows = vec![betterframe_client_core::update_policy::Window {
            day: 1,
            start: "09:00".into(),
            end: "10:00".into(),
        }];
        let summer = DateTime::parse_from_rfc3339("2026-07-06T13:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let winter = DateTime::parse_from_rfc3339("2026-01-05T14:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(window_open(&p, summer));
        assert!(window_open(&p, winter));
        assert!(!window_open(&p, winter - Duration::from_secs(3600)));
        p.schedule.timezone = "missing/timezone".into();
        assert!(!window_open(&p, summer));
        let root = temp();
        save(&root.join("policy.json"), &p).unwrap();
        let reloaded: Policy =
            serde_json::from_slice(&fs::read(root.join("policy.json")).unwrap()).unwrap();
        assert_eq!(reloaded.firmware_target_version, Some("1.2.0".into()));
        fs::remove_dir_all(root).unwrap();
    }
    fn server(
        responses: Vec<(&'static str, String)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8(request).unwrap());
                write!(socket,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nRetry-After: 60\r\nLocation: https://github.com/forbidden\r\n\r\n{body}",body.len()).unwrap();
            }
            requests
        });
        (origin, handle)
    }
    #[test]
    fn auth_failures_and_malformed_responses_recover_without_auth_or_policy_override() {
        for status in [
            "401 Unauthorized",
            "500 Server Error",
            "200 OK",
            "302 Found",
        ] {
            let public=serde_json::json!({"up_to_date":true,"push_request":"untrusted-override","update_policy":policy("wrong")}).to_string();
            let (origin, thread) = server(vec![(status, "malformed".into()), ("200 OK", public)]);
            let identity = Identity {
                server_url: origin.clone(),
                kiosk_key: Some("device-secret".into()),
                demo: false,
            };
            let result = check(
                &client().unwrap(),
                &identity,
                Some(&policy(&origin)),
                "1.0.0",
            )
            .unwrap();
            assert!(result.up_to_date);
            assert!(result.push_request.is_none());
            assert!(result.update_policy.is_none());
            let requests = thread.join().unwrap();
            assert!(
                requests[0]
                    .to_lowercase()
                    .contains("authorization: bearer device-secret")
            );
            assert!(!requests[1].to_lowercase().contains("authorization:"));
            assert!(requests[1].contains("channel=beta"));
            assert!(requests[1].contains("version=1.2.0"));
        }
    }
    #[test]
    fn up_to_date_and_rate_limit_do_not_trigger_public_fallback() {
        for status in ["200 OK", "429 Too Many Requests"] {
            let (origin, thread) = server(vec![(status, "{\"up_to_date\":true}".into())]);
            let identity = Identity {
                server_url: origin.clone(),
                kiosk_key: Some("key".into()),
                demo: false,
            };
            let result = check(
                &client().unwrap(),
                &identity,
                Some(&policy(&origin)),
                "1.0.0",
            );
            if status.starts_with("200") {
                assert!(result.unwrap().up_to_date);
            } else {
                assert!(matches!(result, Err(Failure::Deferred(60..=120))));
            }
            assert_eq!(thread.join().unwrap().len(), 1);
        }
    }
    #[test]
    fn recovery_without_policy_or_with_other_origins_is_disabled() {
        let identity = Identity {
            server_url: "http://127.0.0.1:9".into(),
            kiosk_key: None,
            demo: false,
        };
        assert!(check(&client().unwrap(), &identity, None, "1.0.0").is_err());
        assert!(
            check(
                &client().unwrap(),
                &identity,
                Some(&policy("https://other.example")),
                "1.0.0"
            )
            .is_err()
        );
    }
    #[test]
    fn download_falls_back_to_same_bf_artifact_and_verifies_before_publish() {
        let (artifact, key) = fixture(b"package");
        let (origin, thread) = server(vec![
            ("403 Forbidden", "".into()),
            ("200 OK", "package".into()),
        ]);
        let identity = Identity {
            server_url: origin,
            kiosk_key: Some("key".into()),
            demo: false,
        };
        let root = temp();
        let path = root.join("verified.msi");
        download(&client().unwrap(), &identity, &artifact, &path, &key).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"package");
        let requests = thread.join().unwrap();
        assert!(requests[1].starts_with("GET /api/firmware/public/download/release-1"));
        assert!(!requests[1].to_lowercase().contains("authorization:"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn truncated_downloads_never_replace_a_verified_artifact() {
        let (artifact, key) = fixture(b"package");
        let (origin, thread) = server(vec![("200 OK", "short".into())]);
        let identity = Identity {
            server_url: origin,
            kiosk_key: None,
            demo: false,
        };
        let root = temp();
        let path = root.join("verified.msi");
        fs::write(&path, b"existing").unwrap();
        assert!(download(&client().unwrap(), &identity, &artifact, &path, &key).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing");
        assert!(!path.with_extension("part").exists());
        thread.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
