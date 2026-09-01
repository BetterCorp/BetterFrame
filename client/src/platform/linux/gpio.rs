//! GPIO worker threads — one per binding.
//!
//! Each binding spawns a worker that opens the configured gpio chip, requests
//! the configured line, waits for edge events, and posts to
//! `/api/kiosk/event` on each trigger. Output bindings are opened but idle —
//! reserved for future server-driven set operations.
//!
//! The whole worker pool is rebuilt on every bundle reload: `start_workers`
//! replaces any previously running set. Workers shut down when their
//! `running` flag flips to `false`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio_gpiod as gpiod;
use tracing::{info, warn};

use crate::bundle::BundleGpioBinding;

struct WorkerHandle {
    running: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

static WORKERS: Mutex<Vec<WorkerHandle>> = Mutex::new(Vec::new());

/// Tear down the previous worker set (if any) and start a fresh set for the
/// given bindings. Safe to call repeatedly on bundle reload.
pub fn start_workers(bindings: &[BundleGpioBinding], server_url: &str, kiosk_key: &str) {
    stop_workers();

    if bindings.is_empty() {
        return;
    }

    let mut handles = Vec::new();
    for b in bindings {
        let running = Arc::new(AtomicBool::new(true));
        let r2 = running.clone();
        let binding = b.clone();
        let server = server_url.to_string();
        let key = kiosk_key.to_string();

        let thread = std::thread::spawn(move || run_binding(binding, server, key, r2));
        handles.push(WorkerHandle { running, thread });
    }

    if let Ok(mut w) = WORKERS.lock() {
        *w = handles;
    }
    info!("gpio: {} worker(s) started", bindings.len());
}

fn stop_workers() {
    let handles = WORKERS
        .lock()
        .map(|mut workers| workers.drain(..).collect::<Vec<_>>());
    let Ok(handles) = handles else { return };
    for handle in &handles {
        handle.running.store(false, Ordering::Relaxed);
    }
    for handle in handles {
        let _ = handle.thread.join();
    }
}

fn run_binding(b: BundleGpioBinding, server: String, key: String, running: Arc<AtomicBool>) {
    if b.direction != "in" {
        // Output bindings: open the line so the chip knows it's claimed but
        // there's nothing to wait on. Bail early — output set ops will be
        // added later via WS commands.
        return;
    }

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            warn!("gpio: runtime setup failed: {e}");
            return;
        }
    };
    runtime.block_on(run_input_binding(b, server, key, running));
}

async fn run_input_binding(
    b: BundleGpioBinding,
    server: String,
    key: String,
    running: Arc<AtomicBool>,
) {
    let chip = match gpiod::Chip::new(&b.chip).await {
        Ok(c) => c,
        Err(e) => {
            warn!("gpio: open chip {} failed: {e}", b.chip);
            return;
        }
    };

    let mut opts = gpiod::Options::input([b.pin as u32])
        .consumer("betterframe-kiosk");

    if let Some(edge) = b.edge.as_deref() {
        let edge_detect = match edge {
            "rising" => gpiod::EdgeDetect::Rising,
            "falling" => gpiod::EdgeDetect::Falling,
            _ => gpiod::EdgeDetect::Both,
        };
        opts = opts.edge(edge_detect);
    } else {
        opts = opts.edge(gpiod::EdgeDetect::Both);
    }

    if let Some(pull) = b.pull.as_deref() {
        let bias = match pull {
            "up" => gpiod::Bias::PullUp,
            "down" => gpiod::Bias::PullDown,
            _ => gpiod::Bias::Disable,
        };
        opts = opts.bias(bias);
    }

    let mut lines = match chip.request_lines(opts).await {
        Ok(l) => l,
        Err(e) => {
            warn!("gpio: request {}:{} failed: {e}", b.chip, b.pin);
            return;
        }
    };

    info!(
        "gpio: watching {} pin {} ({}/{}/topic={})",
        b.chip,
        b.pin,
        b.direction,
        b.edge.as_deref().unwrap_or("both"),
        b.topic
    );

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("reqwest client build");

    while running.load(Ordering::Relaxed) {
        let event = tokio::select! {
            event = lines.read_event() => event,
            _ = wait_for_stop(&running) => break,
        };
        match event {
            Ok(event) => {
                let edge_str = match event.edge {
                    gpiod::Edge::Rising => "rising",
                    gpiod::Edge::Falling => "falling",
                };
                let payload = serde_json::json!({
                    "chip": b.chip,
                    "pin": b.pin,
                    "edge": edge_str,
                });
                let request = http
                    .post(format!("{server}/api/kiosk/event"))
                    .header("Authorization", format!("Bearer {key}"))
                    .json(&serde_json::json!({
                        "topic": b.topic,
                        "source_type": "gpio",
                        "payload": payload,
                    }));
                tokio::select! {
                    _ = request.send() => {}
                    _ = wait_for_stop(&running) => break,
                }
            }
            Err(e) => {
                warn!("gpio: read_event {}:{} failed: {e}", b.chip, b.pin);
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {}
                    _ = wait_for_stop(&running) => break,
                }
            }
        }
    }
    info!("gpio: worker {}:{} stopped", b.chip, b.pin);
}

async fn wait_for_stop(running: &AtomicBool) {
    while running.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
