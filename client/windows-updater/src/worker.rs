use crate::platform as os;
use betterframe_client_core::update_policy::Policy;
use betterframe_windows_updater::*;
use serde::{Deserialize, Serialize};
use std::{
    fs, os::windows::process::CommandExt, path::Path, process::Command, sync::atomic::Ordering,
    time::Duration,
};
use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, DETACHED_PROCESS};

const INSTALL_MUTEX: &str = "Global\\BetterFrameUpdateInstall";
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    previous: Artifact,
    candidate: Artifact,
    stage: String,
    started: i64,
    #[serde(default)]
    health_started: Option<i64>,
    #[serde(default)]
    sessions: Vec<u32>,
}
#[derive(Default, Serialize, Deserialize)]
struct Attempts {
    version: String,
    count: u32,
    request: Option<String>,
    retry_at: i64,
}
#[derive(Serialize, Deserialize)]
struct SavedPolicy {
    #[serde(flatten)]
    policy: Policy,
    #[serde(default)]
    cancellation: Option<Vec<u8>>,
}
#[derive(Deserialize)]
struct Health {
    version: String,
    at: i64,
}
fn read<T: serde::de::DeserializeOwned>(name: &str) -> Option<T> {
    serde_json::from_slice(&fs::read(os::root().join(name)).ok()?).ok()
}
fn write<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    save(&os::root().join(name), value)
}
fn healthy(pending: &Pending) -> bool {
    let health: Result<Health, _> = os::read_state(&os::state_dir().join("runtime-health.json"));
    health.is_ok_and(|h| {
        h.version == pending.candidate.version && h.at >= pending.started && h.at <= os::now() + 60
    })
}

pub fn run() {
    while !os::STOP.load(Ordering::SeqCst) {
        let delay = match std::panic::catch_unwind(tick) {
            Ok(Ok(delay)) => delay,
            Ok(Err(Failure::Deferred(seconds))) => {
                os::log("download deferred by BF; no installation attempt consumed");
                seconds
            }
            Ok(Err(error)) => {
                os::log(&format!("update check: {error}"));
                120
            }
            Err(_) => {
                os::log("update worker recovered from panic");
                120
            }
        };
        for _ in 0..delay {
            if os::STOP.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

fn tick() -> Result<u64, Failure> {
    let Some(_lock) = os::mutex(INSTALL_MUTEX)? else {
        return Ok(15);
    };
    if os::root().join("pending.json").exists() {
        let mut pending: Pending =
            read("pending.json").ok_or("invalid update journal".to_string())?;
        if pending.stage == "awaiting-health" && VERSION == pending.candidate.version {
            if healthy(&pending) {
                fs::remove_file(os::root().join("pending.json")).map_err(|e| e.to_string())?;
                report(&pending.candidate.version, None);
                os::log("updated display confirmed healthy");
                return Ok(120);
            }
            if os::active_sessions().is_empty() {
                return Ok(30);
            }
            let start = *pending.health_started.get_or_insert_with(os::now);
            write("pending.json", &pending)?;
            if os::now() - start < 300 {
                return Ok(15);
            }
        }
        // A worker crash, interrupted install/reboot, or unhealthy candidate
        // restores the previously verified package before another forward update.
        pending.stage = "rollback".into();
        write("pending.json", &pending)?;
        handoff()?;
        return Ok(1);
    }
    let identity = match os::read_state::<Identity>(&os::state_dir().join("state.json")) {
        Ok(identity) => {
            betterframe_client_core::protocol::discovery_probe(&identity.server_url)?;
            write("identity.json", &identity)?;
            identity
        }
        Err(_) => match read("identity.json") {
            Some(saved) => saved,
            None => return Ok(120),
        },
    };
    if identity.demo {
        return Ok(120);
    }
    let client = client()?;
    let cancellation_path = os::state_dir().join("update-policy-suspended");
    let cancellation = fs::read(&cancellation_path).ok();
    let mut policy: Option<Policy> = read::<SavedPolicy>("policy.json")
        .filter(|saved| saved.cancellation == cancellation)
        .map(|saved| saved.policy);
    let offered = check(&client, &identity, policy.as_ref(), VERSION)?;
    if fs::read(&cancellation_path).ok() != cancellation {
        return Ok(15);
    }
    if let Some(next) = offered.update_policy {
        // A single service worker serializes policy updates, so stale desktop
        // heartbeats cannot overwrite cancellation or newer maintenance windows.
        write(
            "policy.json",
            &SavedPolicy {
                policy: next.clone(),
                cancellation: cancellation.clone(),
            },
        )?;
        policy = Some(next);
    }
    let policy = policy
        .filter(|p| p.server == identity.server_url)
        .ok_or("no saved update policy".to_string())?;
    if offered.up_to_date {
        return Ok(120);
    }
    if offered.push_request.is_none() && !window_open(&policy, chrono::Utc::now()) {
        return Ok(120);
    }
    let candidate = offered.update.ok_or("missing candidate".to_string())?;
    validate_offer(&candidate, VERSION)?;
    let mut attempts: Attempts = if os::root().join("attempts.json").exists() {
        read("attempts.json").ok_or("invalid installation attempt history".to_string())?
    } else {
        Attempts::default()
    };
    if attempts.version != candidate.version
        || (offered.push_request.is_some() && attempts.request != offered.push_request)
    {
        attempts = Attempts {
            version: candidate.version.clone(),
            request: offered.push_request.clone(),
            ..Default::default()
        };
    }
    if attempts.count >= 3 || os::now() < attempts.retry_at {
        return Ok(120);
    }
    let key = PUBLIC_KEY.ok_or(
        "this build has no embedded publisher key; automatic installation disabled".to_string(),
    )?;
    // Never replace the application without a verified full rollback installer.
    // MSI's LocalPackage cache may omit cabinets and is not a recovery artifact.
    let mut previous_policy = policy.clone();
    previous_policy.firmware_target_version = Some(VERSION.into());
    let previous = public_check(&client, &identity.server_url, &previous_policy, "")?
        .update
        .ok_or("installed release is not available on BF for rollback".to_string())?;
    if previous.version != VERSION {
        return Err(Failure::Other("rollback release version mismatch".into()));
    }
    validate_offer(&previous, "")?;
    let previous_path = os::root().join("previous.msi");
    if verify_file(&previous_path, &previous, key).is_err() {
        download(&client, &identity, &previous, &previous_path, key)?;
    }
    os::validate_msi(&previous_path, &previous.version)?;
    let candidate_path = os::root().join("candidate.msi");
    download(&client, &identity, &candidate, &candidate_path, key)?;
    os::validate_msi(&candidate_path, &candidate.version)?;
    // Recheck after download: a canceled rollout, changed pin/window, or yanked
    // artifact must not be installed using the earlier decision.
    if fs::read(&cancellation_path).ok() != cancellation {
        return Ok(15);
    }
    let fresh = check(&client, &identity, Some(&policy), VERSION)?;
    if fs::read(&cancellation_path).ok() != cancellation {
        return Ok(15);
    }
    if let Ok(current) = os::read_state::<Identity>(&os::state_dir().join("state.json")) {
        if current.demo || current.server_url != identity.server_url {
            return Ok(120);
        }
    }
    let current_policy = fresh.update_policy.as_ref().unwrap_or(&policy);
    if let Some(next) = fresh.update_policy.as_ref() {
        write(
            "policy.json",
            &SavedPolicy {
                policy: next.clone(),
                cancellation: cancellation.clone(),
            },
        )?;
    }
    if fresh.up_to_date
        || fresh
            .update
            .as_ref()
            .is_none_or(|a| a.sha256 != candidate.sha256 || a.version != candidate.version)
        || (fresh.push_request.is_none() && !window_open(current_policy, chrono::Utc::now()))
    {
        return Ok(120);
    }
    attempts.count += 1;
    attempts.retry_at = os::now() + 1800;
    write("attempts.json", &attempts)?;
    let pending = Pending {
        previous,
        candidate,
        stage: "installing".into(),
        started: os::now(),
        health_started: None,
        sessions: Vec::new(),
    };
    write("pending.json", &pending)?;
    handoff()?;
    Ok(1)
}

fn handoff() -> Result<(), String> {
    let helper = os::root().join("install-worker.exe");
    fs::copy(std::env::current_exe().map_err(|e| e.to_string())?, &helper)
        .map_err(|e| e.to_string())?;
    Command::new(helper)
        .arg("apply")
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map_err(|e| e.to_string())?;
    os::STOP.store(true, Ordering::SeqCst);
    Ok(())
}

pub fn apply() -> Result<(), String> {
    os::require_system()?;
    let result = apply_inner();
    if let Err(error) = os::start_service() {
        os::log(&error);
    }
    result
}

fn apply_inner() -> Result<(), String> {
    // Original updater exits before this copy permits MSI to replace its files.
    let _lock = loop {
        if let Some(lock) = os::mutex(INSTALL_MUTEX)? {
            break lock;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    let mut pending: Pending = read("pending.json").ok_or("missing update journal")?;
    let key = PUBLIC_KEY.ok_or("missing embedded publisher key")?;
    let previous = os::root().join("previous.msi");
    verify_file(&previous, &pending.previous, key)?;
    os::validate_msi(&previous, &pending.previous.version)?;
    let outcome = if pending.stage == "rollback" {
        rollback(&mut pending, &previous)
    } else {
        install(&mut pending, key).or_else(|error| {
            os::log(&format!(
                "candidate failed; restoring previous release: {error}"
            ));
            rollback(&mut pending, &previous)
        })
    };
    // MSI stops and recreates the service. Also restart it after a failed or
    // rolled-back transaction so future published fixes remain reachable.
    if let Err(error) = os::start_service() {
        os::log(&error);
    }
    outcome
}

fn install(pending: &mut Pending, key: &str) -> Result<(), String> {
    let candidate = os::root().join("candidate.msi");
    verify_file(&candidate, &pending.candidate, key)?;
    os::validate_msi(&candidate, &pending.candidate.version)?;
    pending.sessions = os::active_sessions();
    pending.started = os::now();
    write("pending.json", pending)?;
    let running = os::stop_clients()?;
    for session in running {
        if !pending.sessions.contains(&session) {
            pending.sessions.push(session);
        }
    }
    write("pending.json", pending)?;
    let cancellation = fs::read(os::state_dir().join("update-policy-suspended")).ok();
    if read::<SavedPolicy>("policy.json").is_none_or(|saved| saved.cancellation != cancellation) {
        return Err("policy changed before installation".into());
    }
    os::run_msi(&candidate)?;
    os::package_probe()?;
    let updater = os::install_dir().join("bin/betterframe-windows-updater.exe");
    if !Command::new(updater)
        .arg("probe")
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?
        .success()
    {
        return Err("installed updater cannot start".into());
    }
    os::start_service()?;
    pending.stage = "awaiting-health".into();
    write("pending.json", pending)?;
    for session in &pending.sessions {
        let _ = os::launch_client(*session);
    }
    if os::active_sessions().is_empty() {
        return Ok(());
    }
    pending.health_started = Some(os::now());
    write("pending.json", pending)?;
    for _ in 0..150 {
        if healthy(pending) {
            fs::remove_file(os::root().join("pending.json")).map_err(|e| e.to_string())?;
            report(&pending.candidate.version, None);
            os::log("update installed and display confirmed healthy");
            return Ok(());
        }
        if os::active_sessions().is_empty() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err("new display failed to confirm local health within five minutes".into())
}

fn rollback(pending: &mut Pending, previous: &Path) -> Result<(), String> {
    pending.stage = "rollback".into();
    write("pending.json", pending)?;
    report(
        &pending.candidate.version,
        Some("Windows update failed local validation; restoring previous release"),
    );
    let running = os::stop_clients()?;
    os::run_msi(previous)?;
    os::package_probe()?;
    for session in pending.sessions.iter().chain(running.iter()) {
        let _ = os::launch_client(*session);
    }
    fs::remove_file(os::root().join("pending.json")).map_err(|e| e.to_string())?;
    os::log("previous release restored; failed version remains subject to retry limit");
    Ok(())
}

fn report(version: &str, error: Option<&str>) {
    // Telemetry is best effort and cannot prevent installation or recovery.
    let Some(identity) = read::<Identity>("identity.json") else {
        return;
    };
    let Some(key) = identity.kiosk_key.as_deref() else {
        return;
    };
    let (Ok(client), Ok(url)) = (
        client(),
        endpoint(&identity.server_url, "/api/kiosk/firmware/applied"),
    ) else {
        return;
    };
    let _ = client
        .post(url)
        .bearer_auth(key)
        .timeout(Duration::from_secs(5))
        .json(&serde_json::json!({"version": version, "error": error}))
        .send();
}
