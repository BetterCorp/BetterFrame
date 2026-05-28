use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tracing_subscriber::Layer;
use tracing::Subscriber;

const BATCH_SIZE: usize = 50;
const FLUSH_INTERVAL: Duration = Duration::from_secs(10);

pub struct AxiomLayer {
    api_key: String,
    dataset: String,
    buffer: Arc<Mutex<Vec<serde_json::Value>>>,
    hostname: String,
}

static GLOBAL_KIOSK_ID: Mutex<Option<String>> = Mutex::new(None);
static FLUSH_ACTIVE: AtomicBool = AtomicBool::new(false);
static FLUSH_COUNT: AtomicU64 = AtomicU64::new(0);
static ERROR_COUNT: AtomicU64 = AtomicU64::new(0);
static EVENTS_RECEIVED: AtomicU64 = AtomicU64::new(0);
static LAST_FLUSH: Mutex<Option<String>> = Mutex::new(None);
static LAST_ATTEMPT: Mutex<Option<String>> = Mutex::new(None);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

pub fn set_kiosk_id(id: String) {
    *GLOBAL_KIOSK_ID.lock().unwrap() = Some(id);
}

pub fn enabled() -> bool {
    !option_env!("BF_AXIOM_KEY").unwrap_or("").is_empty()
        && !option_env!("BF_AXIOM_DATASET").unwrap_or("").is_empty()
}

pub fn active() -> bool {
    FLUSH_ACTIVE.load(Ordering::Relaxed)
}

pub fn iso_now() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| String::from("1970-01-01T00:00:00Z"))
}

pub fn status() -> serde_json::Value {
    let last_flush = LAST_FLUSH.lock().ok().and_then(|g| g.clone());
    let last_attempt = LAST_ATTEMPT.lock().ok().and_then(|g| g.clone());
    let last_error = LAST_ERROR.lock().ok().and_then(|g| g.clone());
    serde_json::json!({
        "enabled": enabled(),
        "active": active(),
        "flush_count": FLUSH_COUNT.load(Ordering::Relaxed),
        "error_count": ERROR_COUNT.load(Ordering::Relaxed),
        "events_received": EVENTS_RECEIVED.load(Ordering::Relaxed),
        "last_flush_at": last_flush,
        "last_attempt_at": last_attempt,
        "last_error": last_error,
    })
}

fn mark_attempt() {
    *LAST_ATTEMPT.lock().unwrap() = Some(iso_now());
}

fn mark_success() {
    FLUSH_ACTIVE.store(true, Ordering::Relaxed);
    FLUSH_COUNT.fetch_add(1, Ordering::Relaxed);
    *LAST_FLUSH.lock().unwrap() = Some(iso_now());
    *LAST_ERROR.lock().unwrap() = None;
}

fn mark_failure(err: &str) {
    FLUSH_ACTIVE.store(false, Ordering::Relaxed);
    ERROR_COUNT.fetch_add(1, Ordering::Relaxed);
    *LAST_ERROR.lock().unwrap() = Some(err.to_string());
}

impl AxiomLayer {
    pub fn new() -> Option<Self> {
        let api_key = option_env!("BF_AXIOM_KEY").unwrap_or("").to_string();
        let dataset = option_env!("BF_AXIOM_DATASET").unwrap_or("").to_string();
        if api_key.is_empty() || dataset.is_empty() {
            return None;
        }

        let hostname = hostname::get()
            .ok()
            .and_then(|h| h.into_string().ok())
            .unwrap_or_else(|| "unknown".into());

        let layer = Self {
            api_key,
            dataset,
            buffer: Arc::new(Mutex::new(Vec::with_capacity(BATCH_SIZE))),
            hostname,
        };

        let flush_buffer = layer.buffer.clone();
        let flush_key = layer.api_key.clone();
        let flush_dataset = layer.dataset.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            loop {
                std::thread::sleep(FLUSH_INTERVAL);
                let entries = {
                    let mut buf = flush_buffer.lock().unwrap();
                    if buf.is_empty() {
                        continue;
                    }
                    std::mem::take(&mut *buf)
                };
                let key = flush_key.clone();
                let ds = flush_dataset.clone();
                rt.block_on(async {
                    flush_and_track(&key, &ds, &entries).await;
                });
            }
        });

        Some(layer)
    }

    fn push(&self, entry: serde_json::Value) {
        EVENTS_RECEIVED.fetch_add(1, Ordering::Relaxed);
        let mut buf = self.buffer.lock().unwrap();
        buf.push(entry);
        if buf.len() >= BATCH_SIZE {
            let entries = std::mem::take(&mut *buf);
            let key = self.api_key.clone();
            let ds = self.dataset.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(async {
                    flush_and_track(&key, &ds, &entries).await;
                });
            });
        }
    }
}

async fn flush_and_track(api_key: &str, dataset: &str, entries: &[serde_json::Value]) {
    mark_attempt();
    match flush_to_axiom(api_key, dataset, entries).await {
        Ok(()) => mark_success(),
        Err(e) => mark_failure(&e.to_string()),
    }
}

async fn flush_to_axiom(
    api_key: &str,
    dataset: &str,
    entries: &[serde_json::Value],
) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!("https://api.axiom.co/v1/datasets/{dataset}/ingest");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(entries)
        .timeout(Duration::from_secs(5))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(format!("axiom returned {}", resp.status()).into());
    }
    Ok(())
}

impl<S: Subscriber> Layer<S> for AxiomLayer {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let meta = event.metadata();
        let level = meta.level().as_str();
        let target = meta.target();

        let mut fields = serde_json::Map::new();
        let mut visitor = JsonVisitor(&mut fields);
        event.record(&mut visitor);

        let message = fields
            .remove("message")
            .unwrap_or(serde_json::Value::String(String::new()));

        let kiosk_id = GLOBAL_KIOSK_ID.lock().ok()
            .and_then(|g| g.clone())
            .unwrap_or_default();

        let entry = serde_json::json!({
            "_time": iso_now(),
            "level": level,
            "message": message,
            "target": target,
            "host": self.hostname,
            "service": "betterframe-kiosk",
            "kiosk_id": kiosk_id,
            "fields": serde_json::Value::Object(fields),
        });

        self.push(entry);
    }
}

struct JsonVisitor<'a>(&'a mut serde_json::Map<String, serde_json::Value>);

impl<'a> tracing::field::Visit for JsonVisitor<'a> {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0.insert(
            field.name().to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.insert(
            field.name().to_string(),
            serde_json::Value::String(format!("{value:?}")),
        );
    }
    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.0.insert(
            field.name().to_string(),
            serde_json::json!(value),
        );
    }
    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.0.insert(
            field.name().to_string(),
            serde_json::json!(value),
        );
    }
    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.0.insert(
            field.name().to_string(),
            serde_json::json!(value),
        );
    }
}
