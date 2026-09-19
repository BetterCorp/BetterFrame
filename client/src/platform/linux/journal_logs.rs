//! Runs before GTK/GStreamer initialization, in a separate systemd service.
//! journald is the durable bounded spool; commit its cursor only after server ACK.
use crate::diagnostic_logs::{self, BATCH_SIZE};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::Duration;

fn entry(record: &Value) -> Option<Value> {
    let cursor = record["__CURSOR"].as_str()?;
    let message = match &record["MESSAGE"] {
        Value::String(text) => text.clone(),
        Value::Array(values) if values.iter().all(|v| v.as_u64().is_some_and(|n| n <= 255)) => {
            let bytes: Vec<u8> = values.iter().map(|v| v.as_u64().unwrap() as u8).collect();
            String::from_utf8_lossy(&bytes).into_owned()
        }
        Value::Array(values) => values.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n"),
        _ => "[Journal message unavailable]".to_string(),
    };
    let micros = record["__REALTIME_TIMESTAMP"]
        .as_str()?
        .parse::<i128>()
        .ok()?;
    let timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(micros.checked_mul(1000)?)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()?;
    let priority = record["PRIORITY"]
        .as_str()
        .and_then(|p| p.parse::<u8>().ok())
        .unwrap_or(6);
    let level = match priority {
        0..=3 => "error",
        4 => "warn",
        7 => "debug",
        _ => "info",
    };
    let (message, truncated) = diagnostic_logs::scrub_with_truncation(&message);
    let mut context = serde_json::Map::new();
    context.insert("truncated".into(), json!(truncated));
    context.insert("source".into(), json!("os"));
    for (input, output) in [
        ("_BOOT_ID", "boot_id"),
        ("_SYSTEMD_UNIT", "unit"),
        ("_PID", "pid"),
        ("_COMM", "process"),
        ("_HOSTNAME", "host"),
        ("SYSLOG_IDENTIFIER", "identifier"),
    ] {
        if let Some(value) = record[input].as_str() {
            context.insert(
                output.into(),
                json!(value.chars().take(256).collect::<String>()),
            );
        }
    }
    Some(
        json!({"event_id": format!("journal:{cursor}"), "logged_at": timestamp,
        "level": level, "message": message, "context": context}),
    )
}

fn read_batch(
    cursor: Option<&str>,
    owner_since: Option<i64>,
) -> Result<(Vec<Value>, Option<String>), ()> {
    read_command(journal_command(cursor, owner_since))
}

fn journal_command(cursor: Option<&str>, owner_since: Option<i64>) -> Command {
    let mut command = Command::new("journalctl");
    // Oldest first, including previous boots. Never use -n here: it skips backlog.
    command.args(["--output=json", "--all", "--no-pager", "--quiet", "--since=-24h", "--priority=info",
        "--output-fields=MESSAGE,PRIORITY,_BOOT_ID,_SYSTEMD_UNIT,_PID,_COMM,_HOSTNAME,SYSLOG_IDENTIFIER"]);
    let cutoff = (time::OffsetDateTime::now_utc().unix_timestamp() - 86400)
        .max(owner_since.unwrap_or(i64::MIN));
    command.arg(format!("--since=@{cutoff}"));
    if let Some(cursor) = cursor {
        command.arg(format!("--after-cursor={cursor}"));
    }
    command
}

fn read_command(mut command: Command) -> Result<(Vec<Value>, Option<String>), ()> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let mut reader = BufReader::new(child.stdout.take().ok_or(())?);
    let mut entries = Vec::new();
    let mut last_cursor = None;
    let mut capped = true;
    for _ in 0..BATCH_SIZE {
        // journald bounds individual records; read at most 1 MiB per JSON line.
        let mut line = Vec::new();
        let mut chunk = std::io::Read::take(&mut reader, 1024 * 1024);
        let length = match chunk.read_until(b'\n', &mut line) {
            Ok(length) => length,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
        };
        if length == 0 {
            capped = false;
            break;
        }
        if line.last() != Some(&b'\n') {
            // Skip a pathological record without buffering it or blocking later logs.
            if reader.skip_until(b'\n').is_err() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
            continue;
        }
        let Ok(record) = serde_json::from_slice::<Value>(&line) else {
            continue;
        };
        last_cursor = record["__CURSOR"]
            .as_str()
            .map(str::to_owned)
            .or(last_cursor);
        if let Some(log) = entry(&record) {
            if log["message"].as_str().is_some_and(|m| !m.is_empty()) {
                entries.push(log);
            }
        }
    }
    // Don't let journalctl continue producing an unbounded backlog into memory.
    if capped {
        let _ = child.kill();
    }
    let status = child.wait().map_err(|_| ())?;
    if !capped && !status.success() {
        return Err(());
    }
    Ok((entries, last_cursor))
}

pub fn run() {
    let path = crate::server::state_file("journal-cursor.json");
    let client = crate::network::blocking_client();
    let mut state = crate::at_rest::read_maybe_encrypted(&path)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(json!({}));
    let mut failures = 0u32;
    let mut waiting_for_identity = false;
    loop {
        let Some(dest) = crate::server::log_destination() else {
            if !waiting_for_identity {
                eprintln!("journal-upload: waiting for readable kiosk identity");
                waiting_for_identity = true;
            }
            std::thread::sleep(Duration::from_secs(5));
            continue;
        };
        if waiting_for_identity {
            eprintln!("journal-upload: kiosk identity available");
            waiting_for_identity = false;
        }
        let owner = dest.owner();
        if state["owner"].as_str() != Some(&owner) {
            // Re-pairing must not send the previous owner's journal history to
            // the new tenant. Keep the boundary for stale-cursor recovery too.
            let previous_owner = state["owner"].as_str().is_some();
            if previous_owner {
                let output = Command::new("journalctl")
                    .args([
                        "--output=json",
                        "--all",
                        "--no-pager",
                        "--quiet",
                        "--lines=1",
                        "--output-fields=__CURSOR",
                    ])
                    .output();
                let Ok(output) = output else {
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                };
                if !output.status.success() {
                    std::thread::sleep(Duration::from_secs(5));
                    continue;
                }
                let cursor = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .last()
                    .and_then(|line| serde_json::from_str::<Value>(line).ok())
                    .and_then(|record| record["__CURSOR"].as_str().map(str::to_owned));
                state = json!({"owner": owner, "cursor": cursor,
                    "since": time::OffsetDateTime::now_utc().unix_timestamp()});
            } else {
                state = json!({"owner": owner});
            }
            let _ = crate::at_rest::write_encrypted(&path, state.to_string().as_bytes());
        }
        match read_batch(state["cursor"].as_str(), state["since"].as_i64()) {
            Ok((entries, cursor)) => {
                let upload = if entries.is_empty() { Ok(()) }
                    else { diagnostic_logs::send_with_error(&client, &dest, &entries) };
                if let Err(error) = &upload {
                    eprintln!("journal-upload: {error}; retaining batch for retry");
                }
                if upload.is_ok() {
                    if failures > 0 { eprintln!("journal-upload: collection/upload recovered"); }
                    failures = 0;
                    if let Some(cursor) = cursor {
                        state["cursor"] = json!(cursor);
                        // Disk-write failure causes replay after restart; event IDs deduplicate it.
                        let _ =
                            crate::at_rest::write_encrypted(&path, state.to_string().as_bytes());
                    }
                    std::thread::sleep(Duration::from_secs(if entries.len() == BATCH_SIZE {
                        1
                    } else {
                        5
                    }));
                    continue;
                }
            }
            Err(()) => {
                eprintln!("journal-upload: journal read failed; check service journal permissions and journalctl availability");
                // A cursor may have been vacuumed. Replay the retained window;
                // the server safely ignores events it already accepted.
                state.as_object_mut().map(|s| s.remove("cursor"));
            }
        }
        failures = (failures + 1).min(6);
        std::thread::sleep(Duration::from_secs((1u64 << failures).min(60)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_export_keeps_long_and_byte_encoded_messages() {
        let command = journal_command(Some("cursor-1"), None);
        let args: Vec<_> = command.get_args().map(|s| s.to_str().unwrap()).collect();
        assert!(args.contains(&"--all")); // Without this journalctl replaces fields >4096 bytes with null.
        assert!(args.contains(&"--after-cursor=cursor-1"));
        for message in [json!("x".repeat(6000) + "\nWebKit failure"), json!(b"WebKit error\nsecond line".to_vec())] {
            let record = json!({"__CURSOR":"cursor-1", "__REALTIME_TIMESTAMP":"1700000000123456",
                "MESSAGE":message, "PRIORITY":"3", "_SYSTEMD_UNIT":"betterframe-kiosk.service"});
            let log = entry(&record).unwrap();
            assert!(log["message"].as_str().unwrap().contains("WebKit"));
            assert!(log["message"].as_str().unwrap().contains('\n'));
            assert_eq!(log["context"]["source"], "os");
            assert_eq!(log["context"]["unit"], "betterframe-kiosk.service");
            assert_eq!(log["context"]["truncated"], false);
        }
    }
    #[test]
    fn preserves_boot_and_kernel_failure_details() {
        let log = entry(&json!({"__CURSOR":"s=abc;i=1", "__REALTIME_TIMESTAMP":"1700000000123456",
            "MESSAGE":"Out of memory: Killed process 42", "PRIORITY":"3", "_BOOT_ID":"boot-1", "_PID":"42"})).unwrap();
        assert_eq!(log["level"], "error");
        assert_eq!(log["context"]["boot_id"], "boot-1");
        assert_eq!(log["event_id"], "journal:s=abc;i=1");
        assert_eq!(log["logged_at"], "2023-11-14T22:13:20.123456Z");
    }
    #[test]
    fn journal_reader_does_not_skip_backlog_or_treat_idle_as_failure() {
        let records = (0..150).map(|i| format!("'{}'", json!({"__CURSOR":format!("cursor-{i}"),
            "__REALTIME_TIMESTAMP":"1700000000123456", "MESSAGE":format!("message {i}"), "PRIORITY":"6"})))
            .collect::<Vec<_>>().join(" ");
        let mut command = Command::new("sh");
        command.args(["-c", &format!("printf '%s\\n' {records}")]);
        let (entries, cursor) = read_command(command).unwrap();
        assert_eq!(entries.len(), BATCH_SIZE);
        assert_eq!(entries[0]["message"], "message 0");
        assert_eq!(cursor.as_deref(), Some("cursor-99"));
        let (entries, cursor) = read_command(Command::new("true")).unwrap();
        assert!(entries.is_empty());
        assert!(cursor.is_none());
        assert!(read_command(Command::new("false")).is_err());
    }
}
