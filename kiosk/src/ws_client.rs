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
    username: Option<String>,
    password: Option<String>,
}

#[derive(Deserialize)]
struct CameraProxyRequest {
    request_id: String,
    camera_id: String,
    path: String,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct OnvifActionRequest {
    request_id: String,
    camera_id: String,
    action: String,
    #[serde(default)]
    params: serde_json::Value,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct IoBoxControlRequest {
    request_id: String,
    display_id: Option<String>,
    action: String,
    #[serde(default)]
    params: serde_json::Value,
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
                    let (outbound_tx, mut outbound_rx) =
                        tokio::sync::mpsc::unbounded_channel::<String>();

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
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
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
        let _ = writer
            .send(Message::Text(r#"{"type":"pong"}"#.to_string()))
            .await;
    } else if text.contains("\"type\":\"operator-enrollment-create\"") {
        let msg = serde_json::from_str::<serde_json::Value>(text).unwrap_or_default();
        let request_id = msg.get("request_id").and_then(|value| value.as_str()).unwrap_or("");
        let name = msg.get("name").and_then(|value| value.as_str()).unwrap_or("Operator station");
        let response = match crate::operator_console::shared_auth().create_enrollment(name) {
            Ok(enrollment) => serde_json::json!({
                "type": "operator-enrollment-response",
                "request_id": request_id,
                "ok": true,
                "code": enrollment.code,
                "expires_at": enrollment.expires_at,
            }),
            Err(error) => serde_json::json!({
                "type": "operator-enrollment-response",
                "request_id": request_id,
                "ok": false,
                "error": error,
            }),
        };
        ws_send(writer, response).await;
    } else if text.contains("\"type\":\"operator-stations-list\"") {
        let msg = serde_json::from_str::<serde_json::Value>(text).unwrap_or_default();
        ws_send(writer, serde_json::json!({
            "type": "operator-stations-response",
            "request_id": msg.get("request_id").and_then(|value| value.as_str()).unwrap_or(""),
            "ok": true,
            "stations": crate::operator_console::shared_auth().list(),
        })).await;
    } else if text.contains("\"type\":\"operator-station-revoke\"") {
        let msg = serde_json::from_str::<serde_json::Value>(text).unwrap_or_default();
        let request_id = msg.get("request_id").and_then(|value| value.as_str()).unwrap_or("");
        let id = msg.get("station_id").and_then(|value| value.as_str()).unwrap_or("");
        let result = crate::operator_console::shared_auth().revoke(id);
        ws_send(writer, serde_json::json!({
            "type": "operator-station-revoke-response",
            "request_id": request_id,
            "ok": result.is_ok(),
            "error": result.err(),
        })).await;
    } else if text.contains("\"type\":\"onvif-action-request\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            warn!("ws: onvif action request was not valid JSON");
            return;
        };
        let Ok(req) = serde_json::from_value::<OnvifActionRequest>(msg) else {
            warn!("ws: onvif action request missing fields");
            return;
        };
        let response = perform_onvif_action(req).await;
        let _ = writer.send(Message::Text(response)).await;
    } else if text.contains("\"type\":\"iobox-control\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            warn!("ws: iobox control request was not valid JSON");
            return;
        };
        let Ok(req) = serde_json::from_value::<IoBoxControlRequest>(msg) else {
            warn!("ws: iobox control request missing fields");
            return;
        };
        let response = perform_iobox_control(req, tx).await;
        let _ = writer.send(Message::Text(response)).await;
    } else if text.contains("\"type\":\"rotate-local-key\"") {
        let request_id = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|m| {
                m.get("request_id")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
            })
            .unwrap_or_default();
        let new_key = crate::server::rotate_local_key();
        crate::local_server::replace_local_key(new_key.clone());
        let _ = writer
            .send(Message::Text(
                serde_json::json!({
                    "type": "rotate-local-key-response",
                    "request_id": request_id,
                    "ok": true,
                    "local_key": new_key,
                })
                .to_string(),
            ))
            .await;
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
    } else if text.contains("\"type\":\"camera-proxy-request\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            warn!("ws: camera proxy request was not valid JSON");
            return;
        };
        let Ok(req) = serde_json::from_value::<CameraProxyRequest>(msg) else {
            warn!("ws: camera proxy request missing fields");
            return;
        };
        let response = perform_camera_proxy_request(req).await;
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
        let layout_id = msg
            .as_ref()
            .and_then(|m| m.get("layout_id"))
            .and_then(flexible_id_from_value);
        let display_id = msg
            .as_ref()
            .and_then(|m| m.get("display_id"))
            .and_then(flexible_id_from_value);
        if let Some(layout_id) = layout_id {
            let _ = tx.send(ServerMsg::SwitchLayout {
                display_id,
                layout_id,
            });
        }
    } else if text.contains("\"type\":\"operator-focus\"") {
        let msg = serde_json::from_str::<serde_json::Value>(text).unwrap_or_default();
        let display_id = msg.get("display_id").and_then(flexible_id_from_value);
        let camera_id = msg.get("camera_id").and_then(flexible_id_from_value);
        let stream = msg.get("stream").and_then(|value| value.as_str()).unwrap_or("auto");
        if let (Some(display_id), Some(camera_id)) = (display_id, camera_id) {
            let _ = tx.send(ServerMsg::OperatorFocus(crate::ui::OperatorFocusRequest {
                display_id,
                camera_id,
                stream: stream.to_string(),
                cell_id: msg.get("cell_id").and_then(flexible_id_from_value),
                fullscreen: msg.get("fullscreen").and_then(|value| value.as_bool()).unwrap_or(false),
                duration_seconds: msg.get("duration_seconds").and_then(|value| value.as_u64()),
            }));
        }
    } else if text.contains("\"type\":\"operator-clear\"") {
        if let Some(display_id) = serde_json::from_str::<serde_json::Value>(text).ok()
            .and_then(|msg| msg.get("display_id").and_then(flexible_id_from_value))
        {
            let _ = tx.send(ServerMsg::OperatorClear(display_id));
        }
    } else if text.contains("\"type\":\"operator-restore\"") {
        if let Some(display_id) = serde_json::from_str::<serde_json::Value>(text).ok()
            .and_then(|msg| msg.get("display_id").and_then(flexible_id_from_value))
        {
            let _ = tx.send(ServerMsg::OperatorRestore(display_id));
        }
    } else if text.contains("\"type\":\"tailscale-auth\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
        if let Some(key) = msg.get("auth_key").and_then(|v| v.as_str()) {
            let _ = tx.send(ServerMsg::TailscaleAuth(key.to_string()));
        }
    } else if text.contains("\"type\":\"reboot\"") {
        let _ = tx.send(ServerMsg::Reboot);
    } else if text.contains("\"type\":\"operator-console-restart\"") {
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(2)).await;
            std::process::exit(0);
        });
    } else if text.contains("\"type\":\"firmware_check\"") {
        let force = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|msg| msg.get("force").and_then(|v| v.as_bool()))
            .unwrap_or(false);
        let _ = tx.send(ServerMsg::FirmwareCheck { force });
    } else if text.contains("\"type\":\"os_check\"") {
        let force = serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|msg| msg.get("force").and_then(|v| v.as_bool()))
            .unwrap_or(false);
        let _ = tx.send(ServerMsg::OsCheck { force });
    } else if text.contains("\"type\":\"update_cancel\"") {
        let _ = tx.send(ServerMsg::CancelUpdates);
    } else if text.contains("\"type\":\"volume-set\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
        if let Some(vol) = msg.get("volume").and_then(|v| v.as_u64()) {
            let _ = tx.send(ServerMsg::VolumeSet(vol.min(100) as u32));
        }
    } else if text.contains("\"type\":\"volume-mute\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
        let muted = msg.get("muted").and_then(|v| v.as_bool()).unwrap_or(true);
        let _ = tx.send(ServerMsg::VolumeMute(muted));
    } else if text.contains("\"type\":\"audio-output\"") {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
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
            ws_send(
                writer,
                serde_json::json!({ "type": "terminal-denied", "reason": reason }),
            )
            .await;
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
                    ws_send(
                        writer,
                        serde_json::json!({ "type": "terminal-denied", "reason": e }),
                    )
                    .await;
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
                        ws_send(
                            writer,
                            serde_json::json!({
                                "type": "terminal-denied", "reason": format!("spawn: {e}")
                            }),
                        )
                        .await;
                    }
                }
            } else {
                warn!("ws: terminal auth failed");
                let reason = if remote_debug::is_locked_public() {
                    "locked"
                } else {
                    "wrong code"
                };
                ws_send(
                    writer,
                    serde_json::json!({ "type": "terminal-denied", "reason": reason }),
                )
                .await;
            }
        } else {
            ws_send(
                writer,
                serde_json::json!({
                    "type": "terminal-denied", "reason": "no pending challenge"
                }),
            )
            .await;
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
                if tx.send(msg).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

async fn perform_onvif_soap(req: OnvifSoapRequest) -> String {
    use base64::Engine;

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

    let username = req.username.as_deref().unwrap_or("");
    let password = req.password.as_deref().unwrap_or("");
    let basic_auth = if username.is_empty() {
        None
    } else {
        Some(format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        ))
    };

    let mut digest_challenge: Option<String> = None;
    let mut last_status = 0u16;
    let mut last_body = String::new();
    let mut last_error = String::new();

    for (kind, auth_header) in [("wsse", None), ("basic", basic_auth)] {
        if kind == "basic" && auth_header.is_none() {
            continue;
        }

        let mut request = client
            .post(parsed.clone())
            .header(
                "Content-Type",
                format!(
                    "application/soap+xml; charset=utf-8; action=\"{}\"",
                    req.action
                ),
            )
            .header("SOAPAction", &req.action)
            .body(req.body.clone());
        if let Some(auth) = auth_header.clone() {
            request = request.header("Authorization", auth);
        }

        match request.send().await {
            Ok(resp) => {
                last_status = resp.status().as_u16();
                if digest_challenge.is_none() {
                    digest_challenge = resp
                        .headers()
                        .get("www-authenticate")
                        .and_then(|v| v.to_str().ok())
                        .map(|v| v.to_string());
                }
                match resp.text().await {
                    Ok(body) => {
                        if (200..300).contains(&last_status) {
                            return serde_json::json!({
                                "type": "onvif-soap-response",
                                "request_id": req.request_id,
                                "status": last_status,
                                "body": body,
                            })
                            .to_string();
                        }
                        last_body = body;
                        last_error = format!("kiosk ONVIF {kind} HTTP {last_status}");
                    }
                    Err(err) => {
                        last_error = format!("kiosk ONVIF response read failed: {err}");
                    }
                }
            }
            Err(err) => {
                last_error = format!("kiosk ONVIF request failed ({kind}): {err}");
            }
        }
    }

    if !username.is_empty() {
        if let Some(challenge) = digest_challenge.as_deref() {
            if let Some(auth) =
                digest_auth_header_for("POST", parsed.as_str(), challenge, username, password)
            {
                match client
                    .post(parsed.clone())
                    .header(
                        "Content-Type",
                        format!(
                            "application/soap+xml; charset=utf-8; action=\"{}\"",
                            req.action
                        ),
                    )
                    .header("SOAPAction", &req.action)
                    .header("Authorization", auth)
                    .body(req.body.clone())
                    .send()
                    .await
                {
                    Ok(resp) => {
                        last_status = resp.status().as_u16();
                        match resp.text().await {
                            Ok(body) => {
                                if (200..300).contains(&last_status) {
                                    return serde_json::json!({
                                        "type": "onvif-soap-response",
                                        "request_id": req.request_id,
                                        "status": last_status,
                                        "body": body,
                                    })
                                    .to_string();
                                }
                                last_body = body;
                                last_error = format!("kiosk ONVIF digest HTTP {last_status}");
                            }
                            Err(err) => {
                                last_error = format!("kiosk ONVIF response read failed: {err}");
                            }
                        }
                    }
                    Err(err) => {
                        last_error = format!("kiosk ONVIF request failed (digest): {err}");
                    }
                }
            }
        }
    }

    serde_json::json!({
        "type": "onvif-soap-response",
        "request_id": req.request_id,
        "status": last_status,
        "error": last_error,
        "body": last_body,
    })
    .to_string()
}

async fn perform_camera_proxy_request(req: CameraProxyRequest) -> String {
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(8000).clamp(1000, 30000));
    let Some(bundle) = crate::server::load_cached_bundle() else {
        return serde_json::json!({
            "type": "camera-proxy-response",
            "request_id": req.request_id,
            "status": 503,
            "error": "no bundle cached yet",
        })
        .to_string();
    };
    let Some(cam) = bundle.cameras.iter().find(|c| c.id == req.camera_id) else {
        return serde_json::json!({
            "type": "camera-proxy-response",
            "request_id": req.request_id,
            "status": 404,
            "error": "camera not in bundle",
        })
        .to_string();
    };
    let Some(host) = cam.onvif_host.as_deref().filter(|v| !v.trim().is_empty()) else {
        return serde_json::json!({
            "type": "camera-proxy-response",
            "request_id": req.request_id,
            "status": 400,
            "error": "camera has no ONVIF host",
        })
        .to_string();
    };

    let path = normalize_camera_proxy_path(&req.path);
    let url = format!("http://{}:{}{}", host, cam.onvif_port.unwrap_or(80), path);
    let decrypt_key =
        crate::server::load_encrypt_key().or_else(|| crate::server::load_cluster_key());
    let username = cam.onvif_username.as_deref().unwrap_or("");
    let password = cam
        .onvif_password_encrypted
        .as_ref()
        .and_then(|enc| {
            decrypt_key
                .as_deref()
                .and_then(|k| crate::onvif_events::decrypt_cluster_public(enc, k))
        })
        .unwrap_or_default();

    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(client) => client,
        Err(err) => {
            return serde_json::json!({
                "type": "camera-proxy-response",
                "request_id": req.request_id,
                "status": 500,
                "error": format!("camera proxy client init failed: {err}"),
            })
            .to_string();
        }
    };

    let mut status;
    let challenge: Option<String>;
    let mut first = client.get(&url);
    if !username.is_empty() {
        first = first.basic_auth(username, Some(password.as_str()));
    }
    match first.send().await {
        Ok(resp) => {
            status = resp.status().as_u16();
            challenge = resp
                .headers()
                .get("www-authenticate")
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_string());
            if resp.status().is_success() {
                return camera_proxy_response(req.request_id, resp).await;
            }
        }
        Err(err) => {
            return serde_json::json!({
                "type": "camera-proxy-response",
                "request_id": req.request_id,
                "status": 502,
                "error": format!("camera proxy request failed: {err}"),
            })
            .to_string();
        }
    }

    if !username.is_empty() {
        if let Some(challenge) = challenge.as_deref() {
            if let Some(auth) =
                digest_auth_header_for("GET", &url, challenge, username, password.as_str())
            {
                match client.get(&url).header("Authorization", auth).send().await {
                    Ok(resp) => {
                        status = resp.status().as_u16();
                        if resp.status().is_success() {
                            return camera_proxy_response(req.request_id, resp).await;
                        }
                    }
                    Err(err) => {
                        return serde_json::json!({
                            "type": "camera-proxy-response",
                            "request_id": req.request_id,
                            "status": 502,
                            "error": format!("camera proxy digest request failed: {err}"),
                        })
                        .to_string();
                    }
                }
            }
        }
    }

    serde_json::json!({
        "type": "camera-proxy-response",
        "request_id": req.request_id,
        "status": status,
        "error": format!("camera proxy HTTP {status}"),
    })
    .to_string()
}

fn normalize_camera_proxy_path(raw: &str) -> String {
    if let Ok(url) = url::Url::parse(raw) {
        let mut path = url.path().to_string();
        if path.is_empty() {
            path = "/".to_string();
        }
        if let Some(query) = url.query() {
            path.push('?');
            path.push_str(query);
        }
        return path;
    }
    let trimmed = raw.trim();
    if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    }
}

async fn camera_proxy_response(request_id: String, resp: reqwest::Response) -> String {
    use base64::Engine;

    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    match resp.bytes().await {
        Ok(bytes) => {
            if bytes.len() > 10 * 1024 * 1024 {
                return serde_json::json!({
                    "type": "camera-proxy-response",
                    "request_id": request_id,
                    "status": 413,
                    "error": "camera proxy response too large",
                })
                .to_string();
            }
            serde_json::json!({
                "type": "camera-proxy-response",
                "request_id": request_id,
                "status": status,
                "content_type": content_type,
                "body_b64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            })
            .to_string()
        }
        Err(err) => serde_json::json!({
            "type": "camera-proxy-response",
            "request_id": request_id,
            "status": 502,
            "error": format!("camera proxy body read failed: {err}"),
        })
        .to_string(),
    }
}

async fn perform_onvif_action(req: OnvifActionRequest) -> String {
    let timeout_ms = req.timeout_ms.unwrap_or(8000).clamp(1000, 30000);
    let request_id = req.request_id.clone();
    let camera_id = req.camera_id.clone();
    let action = req.action.clone();
    let params = req.params.clone();

    let result = tokio::task::spawn_blocking(move || {
        let Some(bundle) = crate::server::load_cached_bundle() else {
            return Err(crate::onvif_actions::OnvifActionError {
                code: "executor_unavailable".to_string(),
                message: "no bundle cached yet".to_string(),
                details: None,
            });
        };
        crate::onvif_actions::execute_bundle_action(
            &bundle, &camera_id, &action, &params, timeout_ms,
        )
    })
    .await;

    match result {
        Ok(Ok(value)) => serde_json::json!({
            "type": "onvif-action-response",
            "request_id": request_id,
            "ok": true,
            "result": value,
        })
        .to_string(),
        Ok(Err(err)) => serde_json::json!({
            "type": "onvif-action-response",
            "request_id": request_id,
            "ok": false,
            "error": err,
        })
        .to_string(),
        Err(err) => serde_json::json!({
            "type": "onvif-action-response",
            "request_id": request_id,
            "ok": false,
            "error": {
                "code": "executor_unavailable",
                "message": format!("kiosk ONVIF action task failed: {err}"),
            },
        })
        .to_string(),
    }
}

async fn perform_iobox_control(req: IoBoxControlRequest, tx: &Sender<ServerMsg>) -> String {
    if req.action == "layout.switch" {
        let Some(layout_id) = req.params.get("layout_id").and_then(flexible_id_from_value) else {
            return serde_json::json!({
                "type": "iobox-control-response",
                "request_id": req.request_id,
                "ok": false,
                "error": {
                    "code": "invalid_params",
                    "message": "layout.switch requires params.layout_id",
                },
            })
            .to_string();
        };
        let send_result = tx.send(ServerMsg::SwitchLayout {
            display_id: req.display_id,
            layout_id,
        });
        return serde_json::json!({
            "type": "iobox-control-response",
            "request_id": req.request_id,
            "ok": send_result.is_ok(),
            "result": {
                "action": "layout.switch",
            },
            "error": send_result.err().map(|e| serde_json::json!({
                "code": "executor_unavailable",
                "message": format!("ui channel send failed: {e}"),
            })),
        })
        .to_string();
    }

    if req.action.starts_with("ptz.") {
        let Some(camera_id) = req.params.get("camera_id").and_then(flexible_id_from_value) else {
            return serde_json::json!({
                "type": "iobox-control-response",
                "request_id": req.request_id,
                "ok": false,
                "error": {
                    "code": "invalid_params",
                    "message": "PTZ ioBOX control requires params.camera_id",
                },
            })
            .to_string();
        };
        let mut params = req.params.clone();
        if let Some(obj) = params.as_object_mut() {
            obj.remove("camera_id");
        }
        let result = perform_onvif_action(OnvifActionRequest {
            request_id: req.request_id.clone(),
            camera_id,
            action: req.action,
            params,
            timeout_ms: Some(8000),
        })
        .await;
        let mut value = serde_json::from_str::<serde_json::Value>(&result).unwrap_or_default();
        value["type"] = serde_json::Value::String("iobox-control-response".to_string());
        return value.to_string();
    }

    serde_json::json!({
        "type": "iobox-control-response",
        "request_id": req.request_id,
        "ok": false,
        "error": {
            "code": "unsupported_action",
            "message": format!("unsupported ioBOX local action: {}", req.action),
        },
    })
    .to_string()
}

fn digest_auth_header_for(
    method: &str,
    url: &str,
    challenge_header: &str,
    user: &str,
    pass: &str,
) -> Option<String> {
    if !challenge_header.to_lowercase().starts_with("digest ") {
        return None;
    }
    let realm = extract_digest_field(challenge_header, "realm")?;
    let nonce = extract_digest_field(challenge_header, "nonce")?;
    let qop = extract_digest_field(challenge_header, "qop").unwrap_or_default();
    let opaque = extract_digest_field(challenge_header, "opaque");
    let algorithm = extract_digest_field(challenge_header, "algorithm");
    let uri = url::Url::parse(url)
        .ok()
        .map(|u| {
            if let Some(q) = u.query() {
                format!("{}?{}", u.path(), q)
            } else {
                u.path().to_string()
            }
        })
        .unwrap_or_else(|| "/".to_string());
    let ha1 = md5_hex(&format!("{user}:{realm}:{pass}"));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let cnonce = format!("{:08x}", rand::random::<u32>());
    let nc = "00000001";
    let response = if qop.contains("auth") {
        md5_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}"))
    } else {
        md5_hex(&format!("{ha1}:{nonce}:{ha2}"))
    };
    let mut parts = vec![
        format!(r#"Digest username="{user}""#),
        format!(r#"realm="{realm}""#),
        format!(r#"nonce="{nonce}""#),
        format!(r#"uri="{uri}""#),
        format!(r#"response="{response}""#),
    ];
    if let Some(opaque) = opaque {
        parts.push(format!(r#"opaque="{opaque}""#));
    }
    if let Some(algorithm) = algorithm {
        parts.push(format!("algorithm={algorithm}"));
    }
    if qop.contains("auth") {
        parts.push("qop=auth".to_string());
        parts.push(format!("nc={nc}"));
        parts.push(format!(r#"cnonce="{cnonce}""#));
    }
    Some(parts.join(", "))
}

fn extract_digest_field(header: &str, field: &str) -> Option<String> {
    let pat = format!("{field}=\"");
    let start = header.find(&pat)? + pat.len();
    let end = header[start..].find('"')?;
    Some(header[start..start + end].to_string())
}

fn md5_hex(input: &str) -> String {
    let digest = md5::compute(input.as_bytes());
    let mut out = String::with_capacity(digest.0.len() * 2);
    for byte in digest.0 {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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
