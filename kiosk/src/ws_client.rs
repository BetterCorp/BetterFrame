use std::sync::mpsc::Sender;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::ServerMsg;

#[derive(Deserialize)]
struct OnvifSoapRequest {
    request_id: String,
    url: String,
    action: String,
    body: String,
    timeout_ms: Option<u64>,
}

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
                                    let _ = ws
                                        .send(Message::Text(r#"{"type":"pong"}"#.to_string()))
                                        .await;
                                } else if text.contains("\"type\":\"onvif-soap-request\"") {
                                    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text)
                                    else {
                                        warn!("ws: onvif request was not valid JSON");
                                        continue;
                                    };
                                    let Ok(req) = serde_json::from_value::<OnvifSoapRequest>(msg)
                                    else {
                                        warn!("ws: onvif request missing fields");
                                        continue;
                                    };
                                    let response = perform_onvif_soap(req).await;
                                    let _ = ws.send(Message::Text(response)).await;
                                } else if text.contains("\"type\":\"reload-bundle\"") {
                                    info!("ws: reload-bundle received");
                                    let _ = tx.send(ServerMsg::ReloadBundle);
                                } else if text.contains("\"type\":\"standby\"") {
                                    info!("ws: standby received");
                                    let _ = tx.send(ServerMsg::Standby);
                                } else if text.contains("\"type\":\"wake\"") {
                                    info!("ws: wake received");
                                    let _ = tx.send(ServerMsg::Wake);
                                } else if text.contains("\"type\":\"layout-switch\"") {
                                    info!("ws: layout-switch received: {text}");
                                    let msg = serde_json::from_str::<serde_json::Value>(&text).ok();
                                    let layout_id = msg
                                        .as_ref()
                                        .and_then(|m| m.get("layout_id"))
                                        .and_then(|v| v.as_u64())
                                        .map(|v| v as u32);
                                    let display_id = msg
                                        .as_ref()
                                        .and_then(|m| m.get("display_id"))
                                        .and_then(|v| v.as_u64())
                                        .map(|v| v as u32);
                                    if let Some(layout_id) = layout_id {
                                        let _ = tx.send(ServerMsg::SwitchLayout {
                                            display_id,
                                            layout_id,
                                        });
                                    } else {
                                        warn!("ws: layout-switch missing layout_id");
                                    }
                                } else if text.contains("\"type\":\"firmware_check\"") {
                                    info!("ws: firmware_check received");
                                    let _ = tx.send(ServerMsg::FirmwareCheck);
                                } else if text.contains("\"type\":\"fan\"") {
                                    info!("ws: fan received: {text}");
                                    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&text)
                                    else {
                                        warn!("ws: fan command was not valid JSON");
                                        continue;
                                    };
                                    let pwm: Option<u32> =
                                        if msg.get("mode").and_then(|v| v.as_str()) == Some("auto")
                                        {
                                            None
                                        } else if let Some(value) =
                                            msg.get("pwm").and_then(|v| v.as_u64())
                                        {
                                            Some(value.min(255) as u32)
                                        } else {
                                            warn!("ws: fan command missing mode=auto or pwm");
                                            continue;
                                        };
                                    let _ = tx.send(ServerMsg::Fan(pwm));
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

async fn perform_onvif_soap(req: OnvifSoapRequest) -> String {
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(8000).clamp(1000, 30000));
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(client) => client,
        Err(err) => {
            return serde_json::json!({
                "type": "onvif-soap-response",
                "request_id": req.request_id,
                "error": format!("kiosk ONVIF client init failed: {err}"),
            })
            .to_string();
        }
    };

    let parsed = match req.url.parse::<url::Url>() {
        Ok(url) => url,
        Err(err) => {
            return serde_json::json!({
                "type": "onvif-soap-response",
                "request_id": req.request_id,
                "error": format!("invalid ONVIF URL: {err}"),
            })
            .to_string();
        }
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return serde_json::json!({
            "type": "onvif-soap-response",
            "request_id": req.request_id,
            "error": "ONVIF URL must use http or https",
        })
        .to_string();
    }

    let result = client
        .post(parsed)
        .header(
            "Content-Type",
            format!(
                "application/soap+xml; charset=utf-8; action=\"{}\"",
                req.action
            ),
        )
        .header("SOAPAction", req.action)
        .body(req.body)
        .send()
        .await;

    match result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            match resp.text().await {
                Ok(body) => serde_json::json!({
                    "type": "onvif-soap-response",
                    "request_id": req.request_id,
                    "status": status,
                    "body": body,
                })
                .to_string(),
                Err(err) => serde_json::json!({
                    "type": "onvif-soap-response",
                    "request_id": req.request_id,
                    "status": status,
                    "error": format!("kiosk ONVIF response read failed: {err}"),
                })
                .to_string(),
            }
        }
        Err(err) => serde_json::json!({
            "type": "onvif-soap-response",
            "request_id": req.request_id,
            "error": format!("kiosk ONVIF request failed: {err}"),
        })
        .to_string(),
    }
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

    // Direct dev URLs may point at api-http; normal installs go through Angie.
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
