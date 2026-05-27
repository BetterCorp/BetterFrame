use std::io::Read;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};

use crate::ServerMsg;
use crate::remote_debug;

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
                Ok((ws_stream, _resp)) => {
                    info!("ws: connected");
                    backoff = 1;

                    let (mut writer, mut reader) = ws_stream.split();

                    // Channel for sync threads (journal, terminal) to send WS messages.
                    let (outbound_tx, mut outbound_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

                    // State for journal streaming + terminal session.
                    let journal_stream: Arc<Mutex<Option<remote_debug::JournalStream>>> =
                        Arc::new(Mutex::new(None));
                    let terminal_session: Arc<Mutex<Option<remote_debug::TerminalSession>>> =
                        Arc::new(Mutex::new(None));
                    let pending_code: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

                    loop {
                        tokio::select! {
                            ws_msg = reader.next() => {
                                let Some(ws_msg) = ws_msg else { break };
                                match ws_msg {
                                    Ok(Message::Text(text)) => {
                                        handle_message(
                                            &text,
                                            &mut writer,
                                            &tx,
                                            &outbound_tx,
                                            &journal_stream,
                                            &terminal_session,
                                            &pending_code,
                                        ).await;
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
                            Some(out_msg) = outbound_rx.recv() => {
                                if writer.send(Message::Text(out_msg)).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }

                    // Cleanup on disconnect.
                    if let Some(stream) = journal_stream.lock().unwrap().take() {
                        stream.stop();
                    }
                    if let Some(mut session) = terminal_session.lock().unwrap().take() {
                        session.kill();
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

type WsWriter = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    Message,
>;

async fn ws_send(writer: &mut WsWriter, msg: serde_json::Value) {
    let _ = writer.send(Message::Text(msg.to_string())).await;
}

async fn handle_message(
    text: &str,
    writer: &mut WsWriter,
    tx: &Sender<ServerMsg>,
    outbound_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    journal_stream: &Arc<Mutex<Option<remote_debug::JournalStream>>>,
    terminal_session: &Arc<Mutex<Option<remote_debug::TerminalSession>>>,
    pending_code: &Arc<Mutex<Option<String>>>,
) {
    if text.contains("\"type\":\"ping\"") {
        let _ = writer.send(Message::Text(r#"{"type":"pong"}"#.to_string())).await;
    } else if text.contains("\"type\":\"onvif-soap-request\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            warn!("ws: onvif request was not valid JSON");
            return;
        };
        let Ok(req) = serde_json::from_value::<OnvifSoapRequest>(msg) else {
            warn!("ws: onvif request missing fields");
            return;
        };
        let response = perform_onvif_soap(req).await;
        let _ = writer.send(Message::Text(response)).await;
    } else if text.contains("\"type\":\"reload-bundle\"") {
        info!("ws: reload-bundle received");
        let _ = tx.send(ServerMsg::ReloadBundle);
    } else if text.contains("\"type\":\"standby\"") {
        let display_id = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|m| m.get("display_id").and_then(flexible_id_from_value));
        let _ = tx.send(ServerMsg::Standby(display_id));
    } else if text.contains("\"type\":\"wake\"") {
        let display_id = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|m| m.get("display_id").and_then(flexible_id_from_value));
        let _ = tx.send(ServerMsg::Wake(display_id));
    } else if text.contains("\"type\":\"layout-switch\"") {
        let msg = serde_json::from_str::<serde_json::Value>(text).ok();
        let layout_id = msg.as_ref()
            .and_then(|m| m.get("layout_id"))
            .and_then(flexible_id_from_value);
        let display_id = msg.as_ref()
            .and_then(|m| m.get("display_id"))
            .and_then(flexible_id_from_value);
        if let Some(layout_id) = layout_id {
            let _ = tx.send(ServerMsg::SwitchLayout { display_id, layout_id });
        }
    } else if text.contains("\"type\":\"tailscale-auth\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else { return };
        if let Some(key) = msg.get("auth_key").and_then(|v| v.as_str()) {
            let _ = tx.send(ServerMsg::TailscaleAuth(key.to_string()));
        }
    } else if text.contains("\"type\":\"reboot\"") {
        let _ = tx.send(ServerMsg::Reboot);
    } else if text.contains("\"type\":\"firmware_check\"") {
        let _ = tx.send(ServerMsg::FirmwareCheck);
    } else if text.contains("\"type\":\"os_check\"") {
        let _ = tx.send(ServerMsg::OsCheck);
    } else if text.contains("\"type\":\"fan\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else { return };
        let pwm = if msg.get("mode").and_then(|v| v.as_str()) == Some("auto") {
            None
        } else if let Some(value) = msg.get("pwm").and_then(|v| v.as_u64()) {
            Some(value.min(255) as u32)
        } else {
            return;
        };
        let _ = tx.send(ServerMsg::Fan(pwm));
    } else if text.contains("\"type\":\"volume-set\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else { return };
        if let Some(vol) = msg.get("volume").and_then(|v| v.as_u64()) {
            let _ = tx.send(ServerMsg::VolumeSet(vol.min(100) as u32));
        }
    } else if text.contains("\"type\":\"volume-mute\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else { return };
        let muted = msg.get("muted").and_then(|v| v.as_bool()).unwrap_or(true);
        let _ = tx.send(ServerMsg::VolumeMute(muted));
    } else if text.contains("\"type\":\"audio-output\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else { return };
        if let Some(id) = msg.get("output_id").and_then(|v| v.as_str()) {
            let _ = tx.send(ServerMsg::AudioOutputSet(id.to_string()));
        }

    // ---- Journal streaming --------------------------------------------------
    } else if text.contains("\"type\":\"journal-start\"") {
        info!("ws: journal-start");
        if let Some(old) = journal_stream.lock().unwrap().take() {
            old.stop();
        }
        let otx = outbound_tx.clone();
        let stream = remote_debug::JournalStream::start(move |line| {
            let msg = serde_json::json!({ "type": "journal-line", "line": line }).to_string();
            let _ = otx.send(msg);
        });
        *journal_stream.lock().unwrap() = Some(stream);
    } else if text.contains("\"type\":\"journal-stop\"") {
        info!("ws: journal-stop");
        if let Some(stream) = journal_stream.lock().unwrap().take() {
            stream.stop();
        }

    // ---- Terminal -----------------------------------------------------------
    } else if text.contains("\"type\":\"terminal-request\"") {
        info!("ws: terminal-request");
        if let Err(reason) = remote_debug::check_terminal_access() {
            ws_send(writer, serde_json::json!({ "type": "terminal-denied", "reason": reason })).await;
        } else {
            match remote_debug::create_terminal_challenge() {
                Ok(code) => {
                    *pending_code.lock().unwrap() = Some(code.clone());
                    let _ = tx.send(ServerMsg::ShowTerminalCode(code));
                    // Auto-expire code after 60s. Timeout does NOT count as failed attempt.
                    let pc_timeout = pending_code.clone();
                    let tx_timeout = tx.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        if pc_timeout.lock().unwrap().take().is_some() {
                            info!("ws: terminal code expired (60s timeout)");
                            let _ = tx_timeout.send(ServerMsg::DismissTerminalCode);
                        }
                    });
                    ws_send(writer, serde_json::json!({ "type": "terminal-challenge" })).await;
                }
                Err(e) => {
                    ws_send(writer, serde_json::json!({ "type": "terminal-denied", "reason": e })).await;
                }
            }
        }
    } else if text.contains("\"type\":\"terminal-auth\"") {
        let msg: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        let provided = msg.get("code").and_then(|v| v.as_str()).unwrap_or("");
        let expected = pending_code.lock().unwrap().take();
        if let Some(expected) = expected {
            if remote_debug::validate_terminal_code(&expected, provided) {
                info!("ws: terminal auth OK");
                let _ = tx.send(ServerMsg::DismissTerminalCode);
                match remote_debug::TerminalSession::spawn() {
                    Ok((session, stdout, stderr)) => {
                        *terminal_session.lock().unwrap() = Some(session);
                        // Pipe stdout + stderr → outbound WS channel.
                        let otx1 = outbound_tx.clone();
                        std::thread::spawn(move || pipe_output(stdout, otx1));
                        let otx2 = outbound_tx.clone();
                        std::thread::spawn(move || pipe_output(stderr, otx2));
                        ws_send(writer, serde_json::json!({ "type": "terminal-granted" })).await;
                    }
                    Err(e) => {
                        ws_send(writer, serde_json::json!({
                            "type": "terminal-denied", "reason": format!("spawn: {e}")
                        })).await;
                    }
                }
            } else {
                warn!("ws: terminal auth failed");
                let reason = if remote_debug::is_locked_public() { "locked" } else { "wrong code" };
                ws_send(writer, serde_json::json!({ "type": "terminal-denied", "reason": reason })).await;
            }
        } else {
            ws_send(writer, serde_json::json!({
                "type": "terminal-denied", "reason": "no pending challenge"
            })).await;
        }
    } else if text.contains("\"type\":\"terminal-data\"") {
        let msg: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
        if let Some(b64) = msg.get("data").and_then(|v| v.as_str()) {
            if let Ok(bytes) = remote_debug::b64_decode(b64) {
                if let Some(ref mut session) = *terminal_session.lock().unwrap() {
                    let _ = session.write_input(&bytes);
                }
            }
        }
    } else if text.contains("\"type\":\"terminal-close\"") {
        info!("ws: terminal-close");
        if let Some(mut session) = terminal_session.lock().unwrap().take() {
            session.kill();
        }
    } else {
        info!("ws: unknown msg: {text}");
    }
}

fn pipe_output<R: Read>(mut reader: R, tx: tokio::sync::mpsc::UnboundedSender<String>) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let b64 = remote_debug::b64_encode(&buf[..n]);
                let msg = serde_json::json!({ "type": "terminal-data", "data": b64 }).to_string();
                if tx.send(msg).is_err() { break; }
            }
            Err(_) => break,
        }
    }
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
            }).to_string();
        }
    };

    let parsed = match req.url.parse::<url::Url>() {
        Ok(url) => url,
        Err(err) => {
            return serde_json::json!({
                "type": "onvif-soap-response",
                "request_id": req.request_id,
                "error": format!("invalid ONVIF URL: {err}"),
            }).to_string();
        }
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return serde_json::json!({
            "type": "onvif-soap-response",
            "request_id": req.request_id,
            "error": "ONVIF URL must use http or https",
        }).to_string();
    }

    let result = client
        .post(parsed)
        .header("Content-Type", format!(
            "application/soap+xml; charset=utf-8; action=\"{}\"", req.action
        ))
        .header("SOAPAction", &req.action)
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
                }).to_string(),
                Err(err) => serde_json::json!({
                    "type": "onvif-soap-response",
                    "request_id": req.request_id,
                    "status": status,
                    "error": format!("kiosk ONVIF response read failed: {err}"),
                }).to_string(),
            }
        }
        Err(err) => serde_json::json!({
            "type": "onvif-soap-response",
            "request_id": req.request_id,
            "error": format!("kiosk ONVIF request failed: {err}"),
        }).to_string(),
    }
}

/// Extract an ID from a JSON value that may be a string or a number.
/// Mirrors the flexible ID deserialization in bundle.rs.
fn flexible_id_from_value(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn build_ws_url(http_url: &str, token: &str) -> String {
    let base = if let Some(rest) = http_url.strip_prefix("https://") {
        format!("wss://{}", rest.split('/').next().unwrap_or(rest))
    } else if let Some(rest) = http_url.strip_prefix("http://") {
        format!("ws://{}", rest.split('/').next().unwrap_or(rest))
    } else {
        format!("ws://{http_url}")
    };

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
