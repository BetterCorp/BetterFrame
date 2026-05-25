use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing_subscriber::Layer;
use tracing::Subscriber;

const BATCH_SIZE: usize = 50;
const FLUSH_INTERVAL: Duration = Duration::from_secs(10);

struct LogEntry {
    timestamp: String,
    level: String,
    message: String,
    target: String,
    fields: serde_json::Value,
}

pub struct AxiomLayer {
    api_key: String,
    dataset: String,
    buffer: Arc<Mutex<Vec<serde_json::Value>>>,
    hostname: String,
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
                    let _ = flush_to_axiom(&key, &ds, &entries).await;
                });
            }
        });

        Some(layer)
    }

    fn push(&self, entry: serde_json::Value) {
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
                    let _ = flush_to_axiom(&key, &ds, &entries).await;
                });
            });
        }
    }
}

async fn flush_to_axiom(
    api_key: &str,
    dataset: &str,
    entries: &[serde_json::Value],
) -> Result<(), Box<dyn std::error::Error>> {
    let url = format!("https://api.axiom.co/v1/datasets/{dataset}/ingest");
    let client = reqwest::Client::new();
    client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(entries)
        .timeout(Duration::from_secs(5))
        .send()
        .await?;
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

        let entry = serde_json::json!({
            "_time": chrono_now(),
            "level": level,
            "message": message,
            "target": target,
            "host": self.hostname,
            "service": "betterframe-kiosk",
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

fn chrono_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let nanos = now.subsec_nanos();
    format!(
        "{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        1970 + secs / 31557600,
        (secs % 31557600) / 2629800 + 1,
        (secs % 2629800) / 86400 + 1,
        (secs % 86400) / 3600,
        (secs % 3600) / 60,
        secs % 60,
        nanos / 1_000_000,
    )
}
