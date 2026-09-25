//! Update recovery must not depend on bundle loading, WebSocket, or kiosk auth.
use crate::core::update_policy::{Policy, Schedule};
use std::{
    fs,
    path::Path,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

static LAST_HEARTBEAT: Mutex<Option<Instant>> = Mutex::new(None);
// Serializes policy publication with cancellation and identifies in-flight requests.
static POLICY_WRITE: Mutex<PolicyWrites> = Mutex::new(PolicyWrites {
    generation: 0,
    next_request: 0,
    last_saved: 0,
});

struct PolicyWrites {
    generation: u64,
    next_request: u64,
    last_saved: u64,
}

#[derive(Clone, Copy)]
pub struct HeartbeatRequest {
    generation: u64,
    sequence: u64,
}

/// Capture before sending, so concurrent responses cannot roll back a newer policy.
pub fn begin_heartbeat() -> HeartbeatRequest {
    let mut state = POLICY_WRITE.lock().unwrap();
    state.next_request += 1;
    HeartbeatRequest { generation: state.generation, sequence: state.next_request }
}

pub fn load() -> Option<Policy> {
    let bytes = fs::read(crate::server::update_policy_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Never use another server's saved preferences or a policy invalidated by an
/// admin change whose replacement has not arrived yet.
pub fn policy_for(server: &str) -> Option<Policy> {
    if crate::server::demo_mode()
        || crate::server::update_policy_path()
            .with_extension("suspended")
            .exists()
    {
        return None;
    }
    load().filter(|policy| policy.server == server)
}

pub fn record_heartbeat(server: &str, body: &serde_json::Value, request: HeartbeatRequest) {
    // A successful HTTP response with an invalid body is not a healthy control plane.
    if body.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return;
    }
    *LAST_HEARTBEAT.lock().unwrap() = Some(Instant::now());
    let Some(schedule) = body.get("update_schedule") else {
        return;
    };
    let Ok(schedule) = serde_json::from_value::<Schedule>(schedule.clone()) else {
        return;
    };
    let policy = Policy {
        server: server.to_owned(),
        schedule,
        firmware_channel: body["firmware_channel"].as_str().unwrap_or("stable").into(),
        firmware_target_version: body["firmware_target_version"].as_str().map(str::to_owned),
        os_update_channel: body["os_update_channel"]
            .as_str()
            .unwrap_or("stable")
            .into(),
        os_update_target_version: body["os_update_target_version"].as_str().map(str::to_owned),
    };
    let mut state = POLICY_WRITE.lock().unwrap();
    if request.generation != state.generation || request.sequence <= state.last_saved {
        return;
    }
    let path = crate::server::update_policy_path();
    let result = save(&path, &policy);
    if let Err(error) = result {
        tracing::warn!("update policy could not be saved: {error}");
    } else {
        state.last_saved = request.sequence;
        let _ = fs::remove_file(path.with_extension("suspended"));
    }
}

fn save(path: &Path, policy: &Policy) -> Result<(), String> {
    let bytes = serde_json::to_vec(policy).map_err(|e| e.to_string())?;
    // Avoid rewriting flash every heartbeat. Replace atomically on policy changes.
    if fs::read(path).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(());
    }
    let pending = path.with_extension("pending");
    use std::io::Write;
    let mut file = fs::File::create(&pending).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(pending, path).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn suspend() {
    let mut state = POLICY_WRITE.lock().unwrap();
    state.generation += 1;
    if let Err(error) = fs::write(
        crate::server::update_policy_path().with_extension("suspended"),
        b"awaiting updated policy",
    ) {
        tracing::warn!("could not suspend saved update policy: {error}");
    }
}

pub fn needed() -> bool {
    LAST_HEARTBEAT
        .lock()
        .unwrap()
        .is_none_or(|last| last.elapsed() >= Duration::from_secs(120))
}

pub fn allowed() -> bool {
    if crate::server::demo_mode()
        || crate::server::update_policy_path()
            .with_extension("suspended")
            .exists()
    {
        return false;
    }
    load().is_some_and(|policy| schedule_allows(&policy.schedule))
}

pub fn schedule_allows(schedule: &Schedule) -> bool {
    if schedule.mode == "always" {
        return true;
    }
    // Evaluate in the server's IANA timezone, not the Pi's display timezone.
    // System zoneinfo handles DST without freezing a UTC offset at last contact.
    let zone = &schedule.timezone;
    if zone.is_empty()
        || zone.starts_with('/')
        || zone.split('/').any(|part| part == "..")
        || !Path::new("/usr/share/zoneinfo").join(zone).is_file()
    {
        return false;
    }
    let Ok(output) = Command::new("date")
        .env("TZ", zone)
        .arg("+%w %H %M")
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let values: Vec<u16> = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|v| v.parse().ok())
        .collect();
    values.len() == 3
        && values[0] <= 6
        && values[1] < 24
        && values[2] < 60
        && schedule.allows(values[0] as u8, values[1] * 60 + values[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_is_atomic_and_readable_after_restart() {
        let dir = std::env::temp_dir().join(format!("bf-update-policy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("policy.json");
        let policy = Policy {
            server: "https://frame.example".into(),
            schedule: Schedule {
                mode: "always".into(),
                windows: vec![],
                timezone: "UTC".into(),
            },
            firmware_channel: "beta".into(),
            firmware_target_version: Some("2.0.0".into()),
            os_update_channel: "dev".into(),
            os_update_target_version: None,
        };
        save(&path, &policy).unwrap();
        let reloaded: Policy = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(reloaded.selection(false), policy.selection(false));
        assert!(!path.with_extension("pending").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejected_auth_recovers_over_public_http_with_saved_preferences() {
        let _download_lock = crate::update_download::TEST_LOCK.lock().unwrap();
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let os_enabled = crate::os_update::enabled();
        let handler = std::thread::spawn(move || {
            let cases = [
                ("/api/kiosk/firmware/check?", true, "401 Unauthorized", "{}"),
                (
                    "/api/firmware/public/check?",
                    false,
                    "200 OK",
                    r#"{"up_to_date":false,"update":{"release_id":"app","version":"2.0.0","channel":"beta","sha256":"test","signature":"test","size_bytes":1,"download_url":"/api/firmware/public/download/app"}}"#,
                ),
                ("/api/kiosk/firmware/download/app", true, "401 Unauthorized", "{}"),
                ("/api/firmware/public/download/app", false, "200 OK", "x"),
                ("/api/kiosk/os/check?", true, "503 Unavailable", "{}"),
                (
                    "/api/os/public/check?",
                    false,
                    "200 OK",
                    r#"{"up_to_date":true}"#,
                ),
                (
                    "/api/kiosk/firmware/check?",
                    true,
                    "200 OK",
                    r#"{"up_to_date":true}"#,
                ),
            ];
            for (path, authenticated, status, body) in cases {
                // App-only installations must not make OS update requests, even
                // during recovery. Full-image hosts also exercise OS fallback.
                if path.contains("/os/") && !os_enabled { continue; }
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 1024];
                while !request.windows(4).any(|v| v == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).unwrap();
                    assert!(read > 0);
                    request.extend_from_slice(&buffer[..read]);
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.starts_with(&format!("get {path}")), "{request}");
                assert_eq!(request.contains("authorization:"), authenticated);
                if !authenticated && path.ends_with('?') {
                    assert!(request.contains("channel=beta"));
                    assert!(request.contains("version=2.0.0"));
                }
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        let body = serde_json::json!({"ok":true,
            "update_schedule":{"mode":"always","windows":[],"timezone":"UTC"},
            "firmware_channel":"beta","firmware_target_version":"2.0.0",
            "os_update_channel":"beta","os_update_target_version":"2.0.0"});
        record_heartbeat(&server, &body, begin_heartbeat());
        assert!(allowed());
        assert!(!needed());
        let update = crate::firmware::check(&server, "deleted-key", "1.0.0").unwrap();
        assert_eq!(update.version, "2.0.0");
        // Download remains public even if selection came from an old authenticated
        // endpoint. Invalid hash must abort before touching installed files.
        let mut update = update;
        update.download_url = "/api/kiosk/firmware/download/app".into();
        let error = crate::firmware::apply(&server, "deleted-key", &update, |_, _| {}).unwrap_err();
        assert!(error.contains("sha256 mismatch"), "{error}");
        assert!(crate::os_update::check(&server, "deleted-key").is_none());
        // A valid "up to date" is authoritative and must not trigger fallback.
        assert!(crate::firmware::check(&server, "active-key", "2.0.0").is_none());
        handler.join().unwrap();
        assert!(policy_for("https://another.example").is_none());
        *LAST_HEARTBEAT.lock().unwrap() = Some(Instant::now() - Duration::from_secs(121));
        assert!(needed());
        suspend();
        assert!(!allowed());
        assert!(policy_for(&server).is_none());
        record_heartbeat(&server, &body, begin_heartbeat());
        assert!(allowed());
        let _ = fs::remove_file(crate::server::update_policy_path());
    }
    #[test]
    fn cancellation_rejects_in_flight_policy_until_a_fresh_heartbeat() {
        let _download_lock = crate::update_download::TEST_LOCK.lock().unwrap();
        let server = "https://frame.example";
        let old_body = serde_json::json!({"ok":true,
            "update_schedule":{"mode":"always","windows":[],"timezone":"UTC"},
            "firmware_channel":"beta","firmware_target_version":"2.0.0"});
        record_heartbeat(server, &old_body, begin_heartbeat());
        let in_flight = begin_heartbeat();
        suspend();
        record_heartbeat(server, &old_body, in_flight);
        assert!(!allowed());
        assert!(policy_for(server).is_none());

        let fresh = begin_heartbeat();
        let mut new_body = old_body.clone();
        new_body["firmware_target_version"] = serde_json::json!("3.0.0");
        record_heartbeat(server, &new_body, fresh);
        assert!(allowed());
        assert_eq!(policy_for(server).unwrap().firmware_target_version.as_deref(), Some("3.0.0"));
        // A late old response cannot overwrite the replacement policy either.
        record_heartbeat(server, &old_body, in_flight);
        assert_eq!(policy_for(server).unwrap().firmware_target_version.as_deref(), Some("3.0.0"));
        // Every cancellation invalidates requests, including ones begun suspended.
        suspend();
        let suspended_request = begin_heartbeat();
        suspend();
        record_heartbeat(server, &new_body, suspended_request);
        assert!(policy_for(server).is_none());
        record_heartbeat(server, &new_body, begin_heartbeat());
        assert!(allowed());
        let _ = fs::remove_file(crate::server::update_policy_path());
    }

    #[test]
    fn older_response_cannot_restore_always_after_newer_window_policy() {
        let _download_lock = crate::update_download::TEST_LOCK.lock().unwrap();
        let server = "https://frame.example";
        let old_body = serde_json::json!({"ok":true,
            "update_schedule":{"mode":"always","windows":[],"timezone":"UTC"}});
        record_heartbeat(server, &old_body, begin_heartbeat());
        assert!(allowed());
        let older = begin_heartbeat();
        let newer = begin_heartbeat();
        let mut new_body = old_body.clone();
        new_body["update_schedule"]["mode"] = serde_json::json!("windows");
        // No cancellation: a settings change can be delivered solely by heartbeat.
        record_heartbeat(server, &new_body, newer);
        record_heartbeat(server, &old_body, older);
        assert_eq!(policy_for(server).unwrap().schedule.mode, "windows");
        assert!(!allowed());
        // Starting a request that fails does not discard another usable response.
        let successful = begin_heartbeat();
        let failed = begin_heartbeat();
        record_heartbeat(server, &serde_json::json!({"ok":false}), failed);
        record_heartbeat(server, &old_body, successful);
        assert!(allowed());
        let _ = fs::remove_file(crate::server::update_policy_path());
    }

    #[test]
    fn unknown_timezone_cannot_open_a_window() {
        assert!(!schedule_allows(&Schedule {
            mode: "windows".into(),
            windows: vec![],
            timezone: "../etc/passwd".into()
        }));
    }
}
