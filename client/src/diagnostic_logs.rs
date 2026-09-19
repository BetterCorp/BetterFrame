//! Bounded first-party application diagnostics, independent of Axiom/channel.
//! Transport failures never emit tracing events (which would feed this layer).
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing_subscriber::Layer;

pub const BATCH_SIZE: usize = 100;
const QUEUE_SIZE: usize = 1000;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct Destination {
    pub server: String,
    pub key: String,
    pub kiosk_id: String,
}
impl Destination {
    pub fn owner(&self) -> String {
        format!("{}|{}", self.server, self.kiosk_id)
    }
}

pub fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Scrub common credential forms before diagnostics leave the device. Do not
/// collect arbitrary structured fields: those can contain bundles and secrets.
#[cfg(test)]
fn scrub(message: &str) -> String {
    scrub_with_truncation(message).0
}

pub fn scrub_with_truncation(message: &str) -> (String, bool) {
    use std::sync::OnceLock;
    static PATTERNS: OnceLock<(regex::Regex, regex::Regex, regex::Regex)> = OnceLock::new();
    let (auth, url, secret) = PATTERNS.get_or_init(|| (
        regex::Regex::new(r"(?i)\b(?:bearer|basic)[ \t]+\S+").unwrap(),
        regex::Regex::new(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+").unwrap(),
        regex::Regex::new(r#"(?i)\b(?:password|secret|token|authorization|cookie|kiosk_key|api_key|encrypt_key|cluster_key)\b["']?[ \t]*(?:[:=][ \t]*|[ \t]+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)"#).unwrap(),
    ));
    let message = auth.replace_all(message, "[redacted]");
    let message = url.replace_all(&message, "[url]");
    let message = secret.replace_all(&message, "[redacted]");
    // Match the server's UTF-16 length limit without splitting Unicode characters.
    let mut length = 0;
    let clipped = message
        .chars()
        .take_while(|character| {
            length += character.len_utf16();
            length <= 16_384
        })
        .collect();
    (clipped, length > 16_384)
}

pub fn send(client: &reqwest::blocking::Client, dest: &Destination, entries: &[Value]) -> bool {
    send_with_error(client, dest, entries).is_ok()
}

/// Safe transport diagnostics: never include request URLs, credentials or response bodies.
pub fn send_with_error(client: &reqwest::blocking::Client, dest: &Destination, entries: &[Value]) -> Result<(), String> {
    let response = client
        .post(format!("{}/api/kiosk/logs", dest.server.trim_end_matches('/')))
        .bearer_auth(&dest.key)
        .json(&json!({"entries": entries}))
        .timeout(Duration::from_secs(10))
        .send()
        .map_err(|error| {
            if error.is_timeout() { "log upload timed out" }
            else if error.is_connect() { "log upload connection failed" }
            else { "log upload request failed" }.to_string()
        })?;
    if response.status().is_success() { Ok(()) }
    else { Err(format!("log upload rejected: HTTP {}", response.status().as_u16())) }
}

pub struct AppLogLayer {
    queue: Arc<Mutex<VecDeque<Value>>>,
}
impl AppLogLayer {
    /// Spool callbacks use each platform's existing protected storage. The
    /// destination callback reloads enrollment so changes do not require restart.
    pub fn start(
        destination: impl Fn() -> Option<Destination> + Send + 'static,
        read: impl Fn() -> Option<Vec<u8>> + Send + 'static,
        write: impl Fn(&[u8]) + Send + Sync + 'static,
    ) -> Self {
        let queue = Arc::new(Mutex::new(VecDeque::<Value>::new()));
        let pending = queue.clone();
        let saved_owner = Arc::new(Mutex::new(None::<String>));
        let panic_owner = saved_owner.clone();
        let write = Arc::new(write);
        let panic_write = write.clone();
        let panic_queue = queue.clone();
        let previous_hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |panic| {
            // Do not re-enter credential loading or tracing during a panic.
            if let (Ok(mut q), Ok(owner)) = (panic_queue.try_lock(), panic_owner.try_lock()) {
                if let Some(owner) = owner.as_ref() {
                    let stamp = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
                    let (message, truncated) = scrub_with_truncation(&format!("{panic}"));
                    q.push_back(json!({"event_id": format!("panic:{stamp}:{}", std::process::id()),
                        "logged_at": now(), "level": "error", "message": message,
                        "context": {"source": "app", "platform": std::env::consts::OS, "pid": std::process::id(), "truncated": truncated}}));
                    while q.len() > QUEUE_SIZE {
                        q.pop_front();
                    }
                    panic_write(
                        json!({"owner": owner, "entries": *q})
                            .to_string()
                            .as_bytes(),
                    );
                }
            }
            previous_hook(panic);
        }));
        std::thread::spawn(move || {
            let client = crate::network::blocking_client();
            let mut owner = None;
            let mut restored = false;
            let mut first = true;
            loop {
                if !first {
                    std::thread::sleep(Duration::from_secs(5));
                }
                first = false;
                let Some(dest) = destination() else {
                    continue;
                };
                let next_owner = dest.owner();
                let batch = {
                    let mut q = pending.lock().unwrap_or_else(|e| e.into_inner());
                    if owner.as_ref().is_some_and(|old| old != &next_owner) {
                        q.clear();
                    }
                    if !restored {
                        restored = true;
                        if let Some(saved) =
                            read().and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                        {
                            if saved["owner"].as_str() == Some(&next_owner) {
                                if let Some(entries) = saved["entries"].as_array() {
                                    for entry in entries.iter().rev().take(QUEUE_SIZE) {
                                        q.push_front(entry.clone());
                                    }
                                }
                            }
                        }
                    }
                    owner = Some(next_owner.clone());
                    if let Ok(mut saved) = saved_owner.lock() {
                        *saved = owner.clone();
                    }
                    while q.len() > QUEUE_SIZE {
                        q.pop_front();
                    }
                    // A rolling queue bounds disk and memory when offline.
                    if !q.is_empty() {
                        write(
                            json!({"owner": next_owner, "entries": *q})
                                .to_string()
                                .as_bytes(),
                        );
                    }
                    q.iter().take(BATCH_SIZE).cloned().collect::<Vec<_>>()
                };
                if !batch.is_empty() && send(&client, &dest, &batch) {
                    let mut q = pending.lock().unwrap_or_else(|e| e.into_inner());
                    // Entries may have been evicted while the request was in flight.
                    q.retain(|entry| {
                        !batch
                            .iter()
                            .any(|sent| sent["event_id"] == entry["event_id"])
                    });
                    write(
                        json!({"owner": next_owner, "entries": *q})
                            .to_string()
                            .as_bytes(),
                    );
                }
            }
        });
        Self { queue }
    }
}

impl<S: tracing::Subscriber> Layer<S> for AppLogLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let meta = event.metadata();
        if !meta.target().starts_with("betterframe") || *meta.level() > tracing::Level::INFO {
            return;
        }
        struct Message(String);
        impl tracing::field::Visit for Message {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.0 = format!("{value:?}");
                }
            }
        }
        let mut visitor = Message(String::new());
        event.record(&mut visitor);
        if visitor.0.is_empty() {
            return;
        }
        let stamp = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
        let (message, truncated) = scrub_with_truncation(&visitor.0);
        let entry = json!({
            "event_id": format!("app:{stamp}:{}:{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)),
            "logged_at": now(), "level": meta.level().as_str().to_ascii_lowercase(),
            "message": message,
            "context": {"source": "app", "truncated": truncated, "target": meta.target(), "platform": std::env::consts::OS,
                "version": option_env!("BF_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
                "pid": std::process::id()}
        });
        // Credential loading/storage can trace on the uploader thread. Never
        // block recursively while that thread holds the queue lock.
        if let Ok(mut q) = self.queue.try_lock() {
            if q.len() >= QUEUE_SIZE {
                q.pop_front();
            }
            q.push_back(entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_and_urls_are_scrubbed() {
        let result = scrub(
            "HTTP Authorization: Bearer abc password=hunter2 url=rtsp://user:pass@host/a?token=secret failed",
        );
        for secret in ["abc", "hunter2", "user:pass", "token=secret"] {
            assert!(!result.contains(secret), "{result}");
        }
        assert!(result.ends_with("failed"));
    }
    #[test]
    fn unicode_messages_are_bounded() {
        assert_eq!(scrub(&"é".repeat(20_000)).chars().count(), 16_384);
        assert_eq!(scrub(&"😀".repeat(20_000)).encode_utf16().count(), 16_384);
        assert_eq!(
            scrub("Failure:\n  at main\n\tcaused by timeout"),
            "Failure:\n  at main\n\tcaused by timeout"
        );
    }
    #[test]
    fn upload_failures_are_retryable_and_redirects_are_not_followed() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let dest = Destination {
            server: origin.clone(),
            key: "test-key".into(),
            kiosk_id: "k1".into(),
        };
        let server = std::thread::spawn(move || {
            let mut bodies = Vec::new();
            for status in ["503 Service Unavailable", "302 Found", "200 OK"] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut buf = [0u8; 1024];
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..n]);
                    if let Some(split) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..split]);
                        let length: usize = header
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(str::to_owned)
                            })
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= split + 4 + length {
                            bodies.push(bytes[split + 4..].to_vec());
                            break;
                        }
                    }
                }
                write!(stream, "HTTP/1.1 {status}\r\nLocation: {origin}/elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
            }
            bodies
        });
        let client = crate::network::blocking_client();
        let batch = vec![json!({"event_id":"retry-1", "message":"error", "level":"error"})];
        assert_eq!(send_with_error(&client, &dest, &batch).unwrap_err(), "log upload rejected: HTTP 503");
        assert_eq!(send_with_error(&client, &dest, &batch).unwrap_err(), "log upload rejected: HTTP 302");
        assert!(send(&client, &dest, &batch));
        let bodies = server.join().unwrap();
        assert_eq!(bodies.len(), 3);
        assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
    }
}
