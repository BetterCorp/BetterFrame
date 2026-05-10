use std::sync::mpsc::Sender;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::ServerMsg;

/// Run the WebSocket client in a tokio runtime. Blocks the calling thread.
/// Reconnects on disconnect with exponential backoff.
pub fn run(server_url: &str, kiosk_key: &str, tx: Sender<ServerMsg>) {
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            warn!("ws: failed to build runtime: {e}");
            return;
        }
    };

    let ws_url = build_ws_url(server_url, kiosk_key);
    info!("ws: connecting to {ws_url}");

    rt.block_on(async {
        let mut backoff = 1u64;
        loop {
            match connect_async(&ws_url).await {
                Ok((mut ws, _resp)) => {
                    info!("ws: connected");
                    backoff = 1;

                    while let Some(msg) = ws.next().await {
                        match msg {
                            Ok(Message::Text(text)) => {
                                if text.contains("\"type\":\"ping\"") {
                                    let _ = ws.send(Message::Text(r#"{"type":"pong"}"#.to_string())).await;
                                } else if text.contains("\"type\":\"reload-bundle\"") {
                                    info!("ws: reload-bundle received");
                                    let _ = tx.send(ServerMsg::ReloadBundle);
                                } else if text.contains("\"type\":\"standby\"") {
                                    info!("ws: standby received");
                                    let _ = tx.send(ServerMsg::Standby);
                                } else if text.contains("\"type\":\"wake\"") {
                                    info!("ws: wake received");
                                    let _ = tx.send(ServerMsg::Wake);
                                } else {
                                    info!("ws: msg: {text}");
                                }
                            }
                            Ok(Message::Close(_)) => {
                                info!("ws: server closed connection");
                                break;
                            }
                            Err(e) => {
                                warn!("ws: error: {e}");
                                break;
                            }
                            _ => {}
                        }
                    }
                }
                Err(e) => {
                    warn!("ws: connect failed: {e}");
                }
            }

            info!("ws: reconnecting in {backoff}s");
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(60);
        }
    });
}

fn build_ws_url(http_url: &str, token: &str) -> String {
    // Replace http:// → ws://, https:// → wss://. Strip any trailing path.
    let base = if let Some(rest) = http_url.strip_prefix("https://") {
        format!("wss://{}", rest.split('/').next().unwrap_or(rest))
    } else if let Some(rest) = http_url.strip_prefix("http://") {
        format!("ws://{}", rest.split('/').next().unwrap_or(rest))
    } else {
        format!("ws://{http_url}")
    };

    // coordinator-ws runs on a different port (18082 vs api-http on 18081)
    let base_port = base.rsplit(':').next().unwrap_or("");
    let base = if base_port == "18081" {
        base.replace(":18081", ":18082")
    } else if !base.contains(':') {
        format!("{base}:18082")
    } else {
        base
    };

    format!("{base}/ws/kiosk?token={}", urlencoding(token))
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            for b in ch.to_string().bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}
