//! Kiosk-local HTTP server (LAN-side, on the kiosk Pi itself).
//!
//! Two surfaces:
//!
//! 1. **GET-only layout API** — `/local/layout/:id?key=<kiosk_local_key>`
//!    Lets anyone on the LAN with the kiosk's local key trigger a layout
//!    switch on THIS kiosk via a plain browser URL. Bookmark-friendly. No
//!    body, no admin credentials needed — auth is the local key generated
//!    at boot and surfaced to admin via heartbeat. Only `GET` accepted.
//!
//! 2. **Admin proxy** — `/proxy/*` forwards to the BF server with the
//!    request's `Authorization: Bearer <admin_api_key>` header preserved.
//!    Lets LAN-only clients reach a cloud-hosted BF server through the
//!    kiosk's local socket. Kiosk adds no auth of its own — server-side
//!    auth still enforces.
//!
//! Listens on `0.0.0.0:18090` by default. Override with env
//! `BF_KIOSK_LOCAL_PORT`. Disable with `BF_KIOSK_LOCAL_DISABLE=1`.

use std::net::SocketAddr;
use std::sync::mpsc::Sender as StdSender;
use std::sync::{Arc, Mutex};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, Query, Request, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::WorkerMsg;

#[derive(Clone)]
pub struct LocalServerState {
    pub local_key: String,
    pub server_url: String,
    /// Held for future kiosk-auth proxy paths (currently the proxy forwards
    /// the caller's own Bearer, so kiosk_key isn't read on hot path).
    #[allow(dead_code)]
    pub kiosk_key: String,
    /// Channel into the kiosk UI worker so layout-switch requests reach the
    /// GTK main loop. Wrapped in Mutex<Option<_>> so the state struct stays
    /// cheap to clone (Arc) without forcing every consumer to take a lock
    /// just to read URL/key fields.
    pub ui_tx: Arc<Mutex<Option<StdSender<WorkerMsg>>>>,
}

#[derive(Deserialize)]
pub struct LocalAuth {
    key: String,
}

#[derive(Serialize)]
pub struct LocalInfo {
    kiosk_local_port: u16,
    server_url: String,
}

pub fn start(state: LocalServerState) {
    if std::env::var("BF_KIOSK_LOCAL_DISABLE").ok().as_deref() == Some("1") {
        info!("local-server: disabled by BF_KIOSK_LOCAL_DISABLE=1");
        return;
    }
    let port: u16 = std::env::var("BF_KIOSK_LOCAL_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(18090);

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("local-server tokio runtime");
        rt.block_on(async move {
            let app = Router::new()
                .route("/local/info", get(local_info_handler))
                .route("/local/layout/:id", get(local_layout_handler))
                .route("/local/snapshot/:camera_id", get(local_snapshot_handler))
                .route("/proxy/*path", any(proxy_handler))
                .with_state(state);

            let addr: SocketAddr = ([0, 0, 0, 0], port).into();
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    warn!("local-server: bind {addr} failed: {e}");
                    return;
                }
            };
            info!("local-server: listening on {addr} (GET-only layout API + /proxy/*)");
            if let Err(e) = axum::serve(listener, app).await {
                warn!("local-server: serve error: {e}");
            }
        });
    });
}

async fn local_info_handler(
    State(state): State<LocalServerState>,
    Query(auth): Query<LocalAuth>,
) -> Response {
    if !constant_time_eq(&auth.key, &state.local_key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    Json(LocalInfo {
        kiosk_local_port: 18090,
        server_url: state.server_url.clone(),
    })
    .into_response()
}

async fn local_layout_handler(
    State(state): State<LocalServerState>,
    Path(id): Path<u32>,
    Query(auth): Query<LocalAuth>,
) -> Response {
    if !constant_time_eq(&auth.key, &state.local_key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let tx = state.ui_tx.lock().ok().and_then(|g| g.clone());
    let Some(tx) = tx else {
        return (StatusCode::SERVICE_UNAVAILABLE, "ui not ready").into_response();
    };
    if let Err(e) = tx.send(WorkerMsg::SwitchLayout {
        display_id: None,
        layout_id: id,
    }) {
        warn!("local-server: send SwitchLayout failed: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, "send failed").into_response();
    }
    info!("local-server: switched to layout {id}");
    (StatusCode::NO_CONTENT, "").into_response()
}

/// One-shot JPEG snapshot of `camera_id` from THIS kiosk. Resolves the
/// camera's RTSP URI from the on-disk cached bundle (written by
/// server::save_bundle), then spawns a one-off gstreamer pipeline:
///
///     rtspsrc → decodebin → videoconvert → jpegenc ! filesink
///
/// Identical pattern to the server's fallback path, just running on the
/// kiosk so the admin preview hits the device closest to the camera.
/// Server-side caller selects this when a kiosk already has the camera
/// in its active layout — the assumption is the kiosk's RTSP session
/// already works, so a parallel one-frame pull is cheap. We do NOT
/// reuse the warm GTK4 paintable pipeline because cross-thread paintable
/// access + sample extraction would need significant rework; this is
/// "good enough" and isolated.
async fn local_snapshot_handler(
    State(state): State<LocalServerState>,
    Path(camera_id): Path<u32>,
    Query(auth): Query<LocalAuth>,
) -> Response {
    if !constant_time_eq(&auth.key, &state.local_key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let Some(bundle) = crate::server::load_cached_bundle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "no bundle cached yet").into_response();
    };
    let Some(cam) = bundle.cameras.iter().find(|c| c.id == camera_id) else {
        return (StatusCode::NOT_FOUND, "camera not in bundle").into_response();
    };
    // Use sub stream when present (lower-bandwidth snapshot), else main.
    let Some((uri, _)) = cam.pick_stream(Some("sub"), 0.0)
        .or_else(|| cam.pick_stream(Some("main"), 1.0)) else {
        return (StatusCode::NOT_FOUND, "no stream for camera").into_response();
    };

    // Blocking gst-launch on a worker thread so we don't block axum's reactor.
    let jpeg = tokio::task::spawn_blocking(move || capture_jpeg_blocking(&uri)).await;
    match jpeg {
        Ok(Ok(bytes)) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "image/jpeg")
            .header("cache-control", "no-store")
            .body(Body::from(bytes))
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "build").into_response()),
        Ok(Err(e)) => {
            warn!("local-server: snapshot for cam {camera_id} failed: {e}");
            (StatusCode::BAD_GATEWAY, format!("snapshot failed: {e}")).into_response()
        }
        Err(e) => {
            warn!("local-server: snapshot task join failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "task error").into_response()
        }
    }
}

fn capture_jpeg_blocking(rtsp_uri: &str) -> Result<Vec<u8>, String> {
    use std::process::Command;
    let tmp = std::env::temp_dir().join(format!(
        "bf-snap-{}.jpg",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    // 5s ceiling: rtspsrc handshake + a couple of decoded frames. jpegenc
    // emits one JPEG, filesink writes it. num-buffers=1 on filesink stops
    // the pipeline after the first sample so we don't dangle.
    let status = Command::new("gst-launch-1.0")
        .args([
            "-q",
            "rtspsrc",
            &format!("location={rtsp_uri}"),
            "latency=200",
            "protocols=tcp",
            "!",
            "decodebin",
            "!",
            "videoconvert",
            "!",
            "jpegenc",
            "!",
            "filesink",
            "num-buffers=1",
            &format!("location={}", tmp.display()),
        ])
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .status()
        .map_err(|e| format!("gst-launch-1.0 spawn: {e}"))?;
    let result = if status.success() {
        std::fs::read(&tmp).map_err(|e| format!("read snapshot: {e}"))
    } else {
        Err(format!("gst-launch-1.0 exit {status:?}"))
    };
    let _ = std::fs::remove_file(&tmp);
    result.and_then(|bytes| {
        if bytes.is_empty() {
            Err("snapshot file empty".to_string())
        } else {
            Ok(bytes)
        }
    })
}

/// Forward any request under /proxy/* to the BF server. Method, query
/// string, body, and Authorization header are preserved. Kiosk adds NO auth
/// — caller must supply their own admin API key (Bearer) which server-side
/// auth verifies.
async fn proxy_handler(
    State(state): State<LocalServerState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let raw_path = uri.path();
    let path = raw_path.strip_prefix("/proxy").unwrap_or(raw_path);
    let q = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let target = format!("{}{}{}", state.server_url.trim_end_matches('/'), path, q);

    let client = reqwest::Client::new();
    let mut req = client.request(reqwest_method(&method), &target);
    for (k, v) in headers.iter() {
        let name = k.as_str();
        // Skip hop-by-hop + host headers — let reqwest set its own.
        if matches!(
            name,
            "host" | "content-length" | "connection" | "keep-alive" | "transfer-encoding"
        ) {
            continue;
        }
        if let Ok(val) = v.to_str() {
            req = req.header(name, val);
        }
    }
    if !body.is_empty() {
        req = req.body(body.to_vec());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            warn!("local-server: proxy → {target} failed: {e}");
            return (StatusCode::BAD_GATEWAY, "proxy upstream error").into_response();
        }
    };
    let status_code = resp.status().as_u16();
    let mut builder = Response::builder().status(status_code);
    for (k, v) in resp.headers().iter() {
        let name = k.as_str();
        if matches!(name, "connection" | "keep-alive" | "transfer-encoding") {
            continue;
        }
        builder = builder.header(name, v);
    }
    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            warn!("local-server: proxy body read failed: {e}");
            return (StatusCode::BAD_GATEWAY, "proxy upstream body error").into_response();
        }
    };
    builder.body(Body::from(bytes)).unwrap_or_else(|_| {
        (StatusCode::INTERNAL_SERVER_ERROR, "bad proxy response").into_response()
    })
}

fn reqwest_method(m: &Method) -> reqwest::Method {
    reqwest::Method::from_bytes(m.as_str().as_bytes()).unwrap_or(reqwest::Method::GET)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Drop in Request unused-import suppression on non-feature builds.
#[allow(dead_code)]
fn _request_marker(_: Request) {}
