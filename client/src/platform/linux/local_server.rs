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

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::mpsc::Sender as StdSender;
use std::sync::{Arc, Mutex, OnceLock};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, Query, Request, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, delete, get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{info, warn};

use crate::WorkerMsg;

static ACTIVE_LOCAL_KEY: OnceLock<Arc<Mutex<String>>> = OnceLock::new();
static VMS_PATHS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
const OPERATOR_COOKIE: &str = "betterframe_operator";

#[derive(Clone)]
pub struct LocalServerState {
    pub local_key: Arc<Mutex<String>>,
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
    pub operator_auth: crate::operator_console::OperatorAuth,
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

#[derive(Deserialize)]
struct LocalOnvifBody {
    action: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Deserialize)]
struct OperatorEnrollBody {
    code: String,
}

#[derive(Deserialize)]
struct OperatorMediaBody {
    camera_id: String,
    stream: String,
}

#[derive(Deserialize)]
struct OperatorFocusBody {
    camera_id: String,
    stream: String,
    target: OperatorFocusTarget,
    duration_seconds: Option<u64>,
    #[allow(dead_code)]
    restore: Option<String>,
}

#[derive(Deserialize)]
struct OperatorFocusTarget {
    kind: String,
    cell_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PtzMoveQuery {
    key: String,
    profile_token: Option<String>,
    dir: String,
    speed: Option<f64>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileQuery {
    key: String,
    profile_token: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
struct LocalIoBoxEventBody {
    topic: String,
    #[serde(default)]
    source_type: Option<String>,
    #[serde(default)]
    property_op: Option<String>,
    #[serde(default)]
    payload: serde_json::Value,
}

pub fn start(state: LocalServerState) {
    if std::env::var("BF_KIOSK_LOCAL_DISABLE").ok().as_deref() == Some("1") {
        info!("local-server: disabled by BF_KIOSK_LOCAL_DISABLE=1");
        return;
    }
    let port = local_port();
    let _ = ACTIVE_LOCAL_KEY.set(state.local_key.clone());

    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("local-server tokio runtime");
        rt.block_on(async move {
            let operator_state = state.clone();
            if let Some(config) = crate::server::load_cached_bundle()
                .map(|bundle| bundle.operator_console)
                .filter(|config| config.enabled)
            {
                if let Some(host) = config.host.filter(|host| !host.trim().is_empty()) {
                    let port = config.port;
                    tokio::spawn(async move {
                        let tls = match crate::operator_console::load_or_create_tls(&host) {
                            Ok(material) => material,
                            Err(err) => {
                                warn!("operator-console: TLS setup failed: {err}");
                                return;
                            }
                        };
                        let addr: SocketAddr = ([0, 0, 0, 0], port).into();
                        info!("operator-console: listening on https://{host}:{port}/operator/ fingerprint={}", tls.fingerprint);
                        if let Err(err) = serve_operator_tls(addr, tls, operator_router(operator_state)).await {
                            warn!("operator-console: serve error: {err}");
                        }
                    });
                } else {
                    warn!("operator-console: enabled without a stable host; HTTPS not started");
                }
            }

            let app = Router::new()
                .route("/local/info", get(local_info_handler))
                .route("/local/iobox/check", get(local_iobox_check_handler))
                .route("/local/iobox/event", post(local_iobox_event_handler))
                .route("/local/layout/:id", get(local_layout_handler))
                .route("/local/snapshot/:camera_id", get(local_snapshot_handler))
                .route("/local/operator-certificate.crt", get(operator_certificate_handler))
                .route(
                    "/oce/:tenant/:camera_id/:callback_token",
                    post(onvif_event_callback),
                )
                .route("/local/onvif/:camera_id", post(local_onvif_handler))
                .route(
                    "/local/onvif/:camera_id/ptz/stop",
                    get(local_onvif_ptz_stop_handler),
                )
                .route(
                    "/local/onvif/:camera_id/ptz/home",
                    get(local_onvif_ptz_home_handler),
                )
                .route(
                    "/local/onvif/:camera_id/ptz/move",
                    get(local_onvif_ptz_move_handler),
                )
                .route(
                    "/local/onvif/:camera_id/ptz/preset",
                    get(local_onvif_ptz_list_presets_handler),
                )
                .route(
                    "/local/onvif/:camera_id/ptz/preset/:preset_token",
                    get(local_onvif_ptz_preset_handler),
                )
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

async fn serve_operator_tls(
    addr: SocketAddr,
    tls: crate::operator_console::TlsMaterial,
    router: Router,
) -> Result<(), String> {
    use hyper_util::{
        rt::{TokioExecutor, TokioIo},
        server::conn::auto::Builder,
        service::TowerToHyperService,
    };
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};

    let certs = CertificateDer::pem_slice_iter(&tls.cert_pem)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("certificate parse failed: {err}"))?;
    let key = PrivateKeyDer::from_pem_slice(&tls.key_pem)
        .map_err(|err| format!("private key parse failed: {err}"))?;
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|err| format!("TLS config failed: {err}"))?;
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|err| format!("bind failed: {err}"))?;
    loop {
        let (socket, peer) = listener.accept().await.map_err(|err| format!("accept failed: {err}"))?;
        let acceptor = acceptor.clone();
        let service = TowerToHyperService::new(router.clone());
        tokio::spawn(async move {
            let Ok(stream) = acceptor.accept(socket).await else { return; };
            if let Err(err) = Builder::new(TokioExecutor::new())
                .serve_connection_with_upgrades(TokioIo::new(stream), service)
                .await
            {
                warn!("operator-console: connection {peer} failed: {err}");
            }
        });
    }
}

fn operator_router(state: LocalServerState) -> Router {
    Router::new()
        .route("/operator", get(operator_index_handler))
        .route("/operator/", get(operator_index_handler))
        .route("/operator/work", get(operator_work_handler))
        .route("/operator/app.css", get(operator_css_handler))
        .route("/operator/app.js", get(operator_js_handler))
        .route("/operator/work.js", get(operator_work_js_handler))
        .route("/operator/api/enroll", post(operator_enroll_handler))
        .route("/operator/api/bootstrap", get(operator_bootstrap_handler))
        .route("/operator/api/cameras/:camera_id/onvif", post(operator_onvif_handler))
        .route("/operator/api/media/session", post(operator_media_session_handler))
        .route("/operator/api/displays/:display_id/layouts/:layout_id", post(operator_layout_handler))
        .route("/operator/api/displays/:display_id/focus", post(operator_focus_handler))
        .route("/operator/api/displays/:display_id/clear", post(operator_clear_handler))
        .route("/operator/api/displays/:display_id/overrides", delete(operator_restore_handler))
        .route("/operator/media/:media_path/*tail", any(operator_media_proxy_handler))
        .route("/operator/playback/:endpoint", get(operator_playback_proxy_handler))
        .with_state(state)
}

async fn local_info_handler(
    State(state): State<LocalServerState>,
    Query(auth): Query<LocalAuth>,
) -> Response {
    if !local_key_matches(&state, &auth.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    Json(LocalInfo {
        kiosk_local_port: local_port(),
        server_url: state.server_url.clone(),
    })
    .into_response()
}

fn local_port() -> u16 {
    std::env::var("BF_KIOSK_LOCAL_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(18090)
}

async fn operator_certificate_handler() -> Response {
    let Some(cert) = crate::operator_console::public_certificate() else {
        return (StatusCode::NOT_FOUND, "operator certificate has not been generated").into_response();
    };
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-x509-ca-cert")
        .header("content-disposition", "attachment; filename=betterframe-operator-console.crt")
        .header("cache-control", "no-store")
        .body(Body::from(cert))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn operator_index_handler() -> Response {
    operator_asset(include_str!("../../../operator-console/index.html"), "text/html; charset=utf-8")
}

async fn operator_work_handler() -> Response {
    operator_asset(include_str!("../../../operator-console/work.html"), "text/html; charset=utf-8")
}

async fn operator_css_handler() -> Response {
    operator_asset(include_str!("../../../operator-console/app.css"), "text/css; charset=utf-8")
}

async fn operator_js_handler() -> Response {
    operator_asset(include_str!("../../../operator-console/app.js"), "text/javascript; charset=utf-8")
}

async fn operator_work_js_handler() -> Response {
    operator_asset(include_str!("../../../operator-console/work.js"), "text/javascript; charset=utf-8")
}

fn operator_asset(content: &'static str, content_type: &'static str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .header("cache-control", "no-cache")
        .header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        .header("x-content-type-options", "nosniff")
        .header("referrer-policy", "no-referrer")
        .body(Body::from(content))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn operator_enroll_handler(
    State(state): State<LocalServerState>,
    Json(body): Json<OperatorEnrollBody>,
) -> Response {
    match state.operator_auth.enroll(&body.code) {
        Ok(station) => Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .header(
                "set-cookie",
                format!("{OPERATOR_COOKIE}={}; Path=/operator; Max-Age=31536000; Secure; HttpOnly; SameSite=Strict", station.token),
            )
            .header("cache-control", "no-store")
            .body(Body::from(json!({ "id": station.id, "name": station.name }).to_string()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(err) => (StatusCode::UNAUTHORIZED, err).into_response(),
    }
}

async fn operator_bootstrap_handler(
    State(state): State<LocalServerState>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) {
        return response;
    }
    let Some(bundle) = crate::server::load_cached_bundle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "no bundle cached yet").into_response();
    };
    if !bundle.operator_console.enabled {
        return (StatusCode::SERVICE_UNAVAILABLE, "operator console is disabled").into_response();
    }
    let cameras: Vec<serde_json::Value> = bundle.cameras.iter().filter(|camera| camera.enabled && camera.simple_vms_managed).map(|camera| {
        let status = camera.last_seen_at.as_deref().map(camera_freshness).unwrap_or("unknown");
        json!({
            "id": camera.id,
            "device_id": camera.device_id,
            "device_name": camera.device_name,
            "name": camera.name,
            "camera_number": camera.camera_number,
            "labels": camera.labels,
            "capabilities": camera.capabilities,
            "status": status,
            "last_seen_at": camera.last_seen_at,
            "streams": camera.streams.iter().map(|stream| json!({
                "id": stream.id,
                "role": stream.role,
                "name": stream.name,
                "profile_token": stream.profile_token,
                "encoding": stream.encoding,
                "width": stream.width,
                "height": stream.height,
            })).collect::<Vec<_>>(),
            "simple_vms_managed": camera.simple_vms_managed,
            "playback_path": if camera.simple_vms_managed { Some(media_path_name(&camera.id, "main")) } else { None },
        })
    }).collect();
    let camera_names: std::collections::HashMap<&str, &str> = bundle.cameras.iter()
        .map(|camera| (camera.id.as_str(), camera.name.as_str())).collect();
    let normalized_displays = bundle.normalized_displays();
    let displays: Vec<serde_json::Value> = normalized_displays.iter().map(|display| {
        let layout = display.default_layout_id.as_deref()
            .and_then(|id| display.layouts.iter().find(|layout| layout.id == id))
            .or_else(|| display.layouts.iter().find(|layout| layout.is_default))
            .or_else(|| display.layouts.first());
        let cells = layout.map(|layout| layout.cells.iter().map(|cell| {
            let id = cell.view_id.clone().unwrap_or_else(|| format!("r{}c{}", cell.row, cell.col));
            json!({
                "id": id,
                "camera_id": cell.camera_id,
                "camera_name": cell.camera_id.as_deref().and_then(|id| camera_names.get(id)).copied(),
                "content_type": cell.content_type,
                "row": cell.row,
                "col": cell.col,
                "row_span": cell.row_span,
                "col_span": cell.col_span,
            })
        }).collect::<Vec<_>>()).unwrap_or_default();
        let layouts = display.layouts.iter().filter(|layout| !is_virtual_layout(layout)).map(|layout| json!({
            "id": layout.id,
            "name": layout.name,
            "is_default": layout.is_default,
        })).collect::<Vec<_>>();
        json!({ "id": display.id, "name": display.name, "cells": cells, "layouts": layouts })
    }).collect();
    let content = normalized_displays.first().map(|display| display.layouts.iter().filter_map(|layout| {
        let cell = operator_content_cell(layout)?;
        Some(json!({
            "id": layout.id,
            "name": layout.name.strip_prefix("Full Screen: ").unwrap_or(&layout.name),
            "type": cell.content_type,
            "source": cell.web_url,
        }))
    }).collect::<Vec<_>>()).unwrap_or_default();
    Json(json!({
        "kiosk_id": bundle.kiosk_id,
        "kiosk_name": bundle.kiosk_name,
        "cameras": cameras,
        "displays": displays,
        "content": content,
        "tools": bundle.operator_console.tools,
        "simple_vms": {
            "enabled": bundle.operator_console.simple_vms.enabled,
        }
    })).into_response()
}

fn is_virtual_layout(layout: &crate::bundle::BundleLayout) -> bool {
    layout.cells.len() == 1
        && layout.cells[0].entity_id.as_deref() == Some(layout.id.as_str())
        && layout.cells[0]
            .view_id
            .as_deref()
            .is_some_and(|id| id.starts_with("virtual:") || id.starts_with("operator:"))
}

fn operator_content_cell(layout: &crate::bundle::BundleLayout) -> Option<&crate::bundle::BundleCell> {
    let cell = is_virtual_layout(layout).then(|| &layout.cells[0])?;
    (!matches!(cell.content_type.as_str(), "camera" | "none")).then_some(cell)
}

fn camera_freshness(value: &str) -> &'static str {
    use time::format_description::well_known::Rfc3339;
    let Ok(last_seen) = time::OffsetDateTime::parse(value, &Rfc3339) else {
        return "unknown";
    };
    let age = time::OffsetDateTime::now_utc() - last_seen;
    if age.whole_seconds() <= 180 { "online" } else { "offline" }
}

async fn operator_onvif_handler(
    State(state): State<LocalServerState>,
    Path(camera_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<LocalOnvifBody>,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) {
        return response;
    }
    let allowed = crate::server::load_cached_bundle().is_some_and(|bundle| {
        bundle.cameras.iter().any(|camera| camera.id == camera_id && camera.enabled && camera.simple_vms_managed)
    });
    if !allowed { return StatusCode::NOT_FOUND.into_response(); }
    execute_local_onvif(camera_id, body.action, body.params).await
}

async fn operator_media_session_handler(
    State(state): State<LocalServerState>,
    headers: HeaderMap,
    Json(body): Json<OperatorMediaBody>,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) {
        return response;
    }
    if body.stream != "main" && body.stream != "sub" {
        return (StatusCode::BAD_REQUEST, "stream must be main or sub").into_response();
    }
    let Some(bundle) = crate::server::load_cached_bundle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "no bundle cached yet").into_response();
    };
    let Some(camera) = bundle.cameras.iter().find(|camera| camera.id == body.camera_id && camera.enabled && camera.simple_vms_managed) else {
        return (StatusCode::NOT_FOUND, "camera not in operator catalog").into_response();
    };
    let Some((uri, _)) = camera.pick_stream(Some(&body.stream), if body.stream == "main" { 1.0 } else { 0.0 }) else {
        return (StatusCode::NOT_FOUND, "camera has no playable stream").into_response();
    };
    let decrypt_key = crate::server::load_encrypt_key().or_else(|| crate::server::load_cluster_key());
    let password = camera.playback_password_encrypted.as_ref().and_then(|encrypted| {
        decrypt_key.as_deref().and_then(|key| crate::onvif_events::decrypt_cluster_public(encrypted, key))
    });
    let source = inject_rtsp_credentials(&uri, camera.playback_username.as_deref(), password.as_deref());
    let media_path = media_path_name(&camera.id, &body.stream);
    let api_base = std::env::var("BF_MEDIAMTX_API").unwrap_or_else(|_| "http://127.0.0.1:9997".to_string());
    let client = reqwest::Client::new();
    let encoded = urlencoding::encode(&media_path);
    let config = json!({ "source": source, "sourceOnDemand": true, "sourceOnDemandCloseAfter": "10s" });
    let add = client.post(format!("{api_base}/v3/config/paths/add/{encoded}")).json(&config).send().await;
    let configured = match add {
        Ok(response) if response.status().is_success() => true,
        Ok(_) => client.patch(format!("{api_base}/v3/config/paths/patch/{encoded}"))
            .json(&config).send().await.map(|response| response.status().is_success()).unwrap_or(false),
        Err(_) => false,
    };
    if !configured {
        return (StatusCode::SERVICE_UNAVAILABLE, "MediaMTX is unavailable").into_response();
    }
    Json(json!({ "whep_url": format!("/operator/media/{media_path}/whep") })).into_response()
}

fn inject_rtsp_credentials(uri: &str, username: Option<&str>, password: Option<&str>) -> String {
    let Ok(mut parsed) = url::Url::parse(uri) else { return uri.to_string(); };
    if let Some(username) = username { let _ = parsed.set_username(username); }
    let _ = parsed.set_password(password);
    parsed.to_string()
}

pub fn sync_simple_vms(bundle: &crate::bundle::KioskBundle) {
    const RECORD_KEYS: &[&str] = &[
        "recordFormat",
        "recordPartDuration",
        "recordMaxPartSize",
        "recordSegmentDuration",
        "recordDeleteAfter",
    ];
    let api_base = std::env::var("BF_MEDIAMTX_API")
        .unwrap_or_else(|_| "http://127.0.0.1:9997".to_string());
    let client = match reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(err) => {
            warn!("simple-vms: HTTP client failed: {err}");
            return;
        }
    };
    let decrypt_key = crate::server::load_encrypt_key().or_else(|| crate::server::load_cluster_key());
    let storage = bundle
        .operator_console
        .simple_vms
        .storage_path
        .as_deref()
        .unwrap_or("/var/lib/betterframe/recordings")
        .trim_end_matches('/');
    let defaults = bundle.operator_console.simple_vms.settings.as_object();
    let mut desired = HashSet::new();

    if bundle.operator_console.simple_vms.enabled {
        for camera in bundle.cameras.iter().filter(|camera| {
            camera.enabled
                && camera.simple_vms_managed
                && camera.recording_config.get("record").and_then(|value| value.as_bool()) != Some(false)
        }) {
            let Some((uri, _)) = camera.pick_stream(Some("main"), 1.0) else { continue; };
            let password = camera.playback_password_encrypted.as_ref().and_then(|encrypted| {
                decrypt_key.as_deref().and_then(|key| crate::onvif_events::decrypt_cluster_public(encrypted, key))
            });
            let name = media_path_name(&camera.id, "main");
            let mut config = serde_json::Map::from_iter([
                ("source".to_string(), json!(inject_rtsp_credentials(&uri, camera.playback_username.as_deref(), password.as_deref()))),
                ("sourceOnDemand".to_string(), json!(false)),
                ("record".to_string(), json!(true)),
                ("recordPath".to_string(), json!(format!("{storage}/%path/%Y-%m-%d_%H-%M-%S-%f"))),
            ]);
            for options in [defaults, camera.recording_config.as_object()].into_iter().flatten() {
                for key in RECORD_KEYS {
                    if let Some(value) = options.get(*key) {
                        config.insert((*key).to_string(), value.clone());
                    }
                }
            }
            if configure_mediamtx_path_blocking(&client, &api_base, &name, &config) {
                desired.insert(name);
            }
        }
    }

    let tracked = VMS_PATHS.get_or_init(|| Mutex::new(HashSet::new()));
    if let Ok(mut active) = tracked.lock() {
        for stale in active.difference(&desired).cloned().collect::<Vec<_>>() {
            let encoded = urlencoding::encode(&stale);
            let _ = client
                .delete(format!("{api_base}/v3/config/paths/delete/{encoded}"))
                .send();
        }
        *active = desired;
    }
}

fn media_path_name(camera_id: &str, stream: &str) -> String {
    let safe_id: String = camera_id.chars().filter(|ch| ch.is_ascii_alphanumeric()).collect();
    format!("bf_{safe_id}_{stream}")
}

fn configure_mediamtx_path_blocking(
    client: &reqwest::blocking::Client,
    api_base: &str,
    name: &str,
    config: &serde_json::Map<String, serde_json::Value>,
) -> bool {
    let encoded = urlencoding::encode(name);
    match client
        .post(format!("{api_base}/v3/config/paths/add/{encoded}"))
        .json(config)
        .send()
    {
        Ok(response) if response.status().is_success() => true,
        Ok(_) => client
            .patch(format!("{api_base}/v3/config/paths/patch/{encoded}"))
            .json(config)
            .send()
            .is_ok_and(|response| response.status().is_success()),
        Err(err) => {
            warn!("simple-vms: MediaMTX path {name} failed: {err}");
            false
        }
    }
}

async fn operator_focus_handler(
    State(state): State<LocalServerState>,
    Path(display_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<OperatorFocusBody>,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) { return response; }
    if body.stream != "main" && body.stream != "sub" && body.stream != "auto" {
        return (StatusCode::BAD_REQUEST, "invalid stream selector").into_response();
    }
    if let Some(seconds) = body.duration_seconds {
        if !matches!(seconds, 30 | 60 | 120) {
            return (StatusCode::BAD_REQUEST, "duration must be 30, 60, 120, or null").into_response();
        }
    }
    let request = crate::ui::OperatorFocusRequest {
        display_id,
        camera_id: body.camera_id,
        stream: body.stream,
        cell_id: body.target.cell_id,
        fullscreen: body.target.kind == "fullscreen",
        duration_seconds: body.duration_seconds,
    };
    operator_ui_request(&state, |reply| WorkerMsg::OperatorFocus(request, reply)).await
}

async fn operator_layout_handler(
    State(state): State<LocalServerState>,
    Path((display_id, layout_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) { return response; }
    let allowed = crate::server::load_cached_bundle().is_some_and(|bundle| {
        bundle.normalized_displays().iter().any(|display| {
            display.id == display_id && display.layouts.iter().any(|layout| layout.id == layout_id)
        })
    });
    if !allowed { return StatusCode::NOT_FOUND.into_response(); }
    let sent = state.ui_tx.lock().ok().and_then(|guard| guard.as_ref().cloned())
        .is_some_and(|sender| sender.send(WorkerMsg::SwitchLayout {
            display_id: Some(display_id),
            layout_id,
        }).is_ok());
    if sent {
        Json(json!({ "ok": true })).into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "operator UI is unavailable").into_response()
    }
}

async fn operator_clear_handler(
    State(state): State<LocalServerState>,
    Path(display_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) { return response; }
    operator_ui_request(&state, |reply| WorkerMsg::OperatorClear(display_id, reply)).await
}

async fn operator_restore_handler(
    State(state): State<LocalServerState>,
    Path(display_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) { return response; }
    operator_ui_request(&state, |reply| WorkerMsg::OperatorRestore(display_id, reply)).await
}

async fn operator_ui_request<F>(state: &LocalServerState, build: F) -> Response
where
    F: FnOnce(std::sync::mpsc::Sender<Result<serde_json::Value, String>>) -> WorkerMsg,
{
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    let sent = state.ui_tx.lock().ok().and_then(|guard| guard.as_ref().cloned())
        .is_some_and(|sender| sender.send(build(reply_tx)).is_ok());
    if !sent { return (StatusCode::SERVICE_UNAVAILABLE, "operator UI is unavailable").into_response(); }
    match tokio::task::spawn_blocking(move || reply_rx.recv_timeout(std::time::Duration::from_secs(3))).await {
        Ok(Ok(Ok(value))) => Json(value).into_response(),
        Ok(Ok(Err(err))) => (StatusCode::CONFLICT, err).into_response(),
        _ => (StatusCode::SERVICE_UNAVAILABLE, "operator UI did not respond").into_response(),
    }
}

async fn operator_media_proxy_handler(
    State(state): State<LocalServerState>,
    Path((media_path, tail)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) { return response; }
    if !media_path.starts_with("bf_") || media_path.chars().any(|ch| !(ch.is_ascii_alphanumeric() || ch == '_')) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let base = std::env::var("BF_MEDIAMTX_WEBRTC").unwrap_or_else(|_| "http://127.0.0.1:8889".to_string());
    let target = format!("{}/{}/{}", base.trim_end_matches('/'), media_path, tail.trim_start_matches('/'));
    let client = reqwest::Client::new();
    let mut request = client.request(reqwest_method(&method), &target).body(body.to_vec());
    for (name, value) in headers.iter() {
        if matches!(name.as_str(), "authorization" | "host" | "content-length" | "connection") { continue; }
        request = request.header(name.as_str(), value.as_bytes());
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => return (StatusCode::BAD_GATEWAY, format!("MediaMTX proxy failed: {err}")).into_response(),
    };
    let status = upstream.status().as_u16();
    let upstream_headers = upstream.headers().clone();
    let bytes = match upstream.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => return (StatusCode::BAD_GATEWAY, format!("MediaMTX response failed: {err}")).into_response(),
    };
    let mut response = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        if matches!(name.as_str(), "connection" | "content-length" | "transfer-encoding" | "location") { continue; }
        response = response.header(name, value);
    }
    if let Some(location) = upstream_headers.get("location").and_then(|value| value.to_str().ok()) {
        let suffix = url::Url::parse(location).ok().map(|url| url.path().to_string()).unwrap_or_else(|| location.to_string());
        let rewritten = if let Some(index) = suffix.find(&format!("/{media_path}/")) {
            format!("/operator/media/{media_path}/{}", &suffix[index + media_path.len() + 2..])
        } else {
            format!("/operator/media/{media_path}/{}", suffix.trim_start_matches('/'))
        };
        response = response.header("location", rewritten);
    }
    response.body(Body::from(bytes)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn operator_playback_proxy_handler(
    State(state): State<LocalServerState>,
    Path(endpoint): Path<String>,
    Query(params): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(response) = require_operator(&state, &headers) { return response; }
    if endpoint != "list" && endpoint != "get" {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(path) = params.get("path") else { return StatusCode::BAD_REQUEST.into_response(); };
    if !path.starts_with("bf_") || path.chars().any(|ch| !(ch.is_ascii_alphanumeric() || ch == '_')) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let base = std::env::var("BF_MEDIAMTX_PLAYBACK")
        .unwrap_or_else(|_| "http://127.0.0.1:9996".to_string());
    let mut target = match reqwest::Url::parse(&format!("{}/{endpoint}", base.trim_end_matches('/'))) {
        Ok(url) => url,
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    target.query_pairs_mut().extend_pairs(params.iter());
    let upstream = match reqwest::Client::new().get(target).send().await {
        Ok(response) => response,
        Err(err) => return (StatusCode::BAD_GATEWAY, format!("MediaMTX playback failed: {err}")).into_response(),
    };
    let status = upstream.status().as_u16();
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in upstream_headers.iter() {
        if matches!(name.as_str(), "connection" | "transfer-encoding") { continue; }
        response = response.header(name, value);
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

fn require_operator(state: &LocalServerState, headers: &HeaderMap) -> Option<Response> {
    let token = operator_token(headers).unwrap_or("");
    if state.operator_auth.verify(token) { None } else { Some(StatusCode::UNAUTHORIZED.into_response()) }
}

fn operator_token(headers: &HeaderMap) -> Option<&str> {
    headers.get("cookie")?.to_str().ok()?.split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| (name == OPERATOR_COOKIE).then_some(value))
}

async fn local_iobox_check_handler(
    State(state): State<LocalServerState>,
    Query(auth): Query<LocalAuth>,
) -> Response {
    if !local_key_matches(&state, &auth.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    Json(serde_json::json!({
        "ok": true,
        "kind": "betterframe-kiosk-iobox-local",
    }))
    .into_response()
}

async fn local_iobox_event_handler(
    State(state): State<LocalServerState>,
    Query(auth): Query<LocalAuth>,
    Json(body): Json<LocalIoBoxEventBody>,
) -> Response {
    if !local_key_matches(&state, &auth.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    if body.topic.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "topic required").into_response();
    }

    let target = format!("{}/api/kiosk/event", state.server_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    match client
        .post(target)
        .bearer_auth(&state.kiosk_key)
        .json(&serde_json::json!({
            "topic": body.topic,
            "source_type": body.source_type.unwrap_or_else(|| "io".to_string()),
            "property_op": body.property_op,
            "payload": body.payload,
        }))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({ "ok": true })),
        )
            .into_response(),
        Ok(resp) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("server HTTP {}", resp.status().as_u16()),
            })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({
                "ok": false,
                "error": format!("server event forward failed: {err}"),
            })),
        )
            .into_response(),
    }
}

async fn local_layout_handler(
    State(state): State<LocalServerState>,
    Path(id): Path<String>,
    Query(auth): Query<LocalAuth>,
) -> Response {
    if !local_key_matches(&state, &auth.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let tx = state.ui_tx.lock().ok().and_then(|g| g.clone());
    let Some(tx) = tx else {
        return (StatusCode::SERVICE_UNAVAILABLE, "ui not ready").into_response();
    };
    if let Err(e) = tx.send(WorkerMsg::SwitchLayout {
        display_id: None,
        layout_id: id.clone(),
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
    Path(camera_id): Path<String>,
    Query(auth): Query<LocalAuth>,
) -> Response {
    if !local_key_matches(&state, &auth.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let Some(bundle) = crate::server::load_cached_bundle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "no bundle cached yet").into_response();
    };
    let Some(cam) = bundle.cameras.iter().find(|c| c.id == camera_id) else {
        return (StatusCode::NOT_FOUND, "camera not in bundle").into_response();
    };
    // Use sub stream when present (lower-bandwidth snapshot), else main.
    let Some((uri, _)) = cam
        .pick_stream(Some("sub"), 0.0)
        .or_else(|| cam.pick_stream(Some("main"), 1.0))
    else {
        return (StatusCode::NOT_FOUND, "no stream for camera").into_response();
    };
    let decrypt_key =
        crate::server::load_encrypt_key().or_else(|| crate::server::load_cluster_key());
    let playback_password = cam.playback_password_encrypted.as_ref().and_then(|enc| {
        decrypt_key
            .as_deref()
            .and_then(|k| crate::onvif_events::decrypt_cluster_public(enc, k))
    });

    // Blocking gst-launch on a worker thread so we don't block axum's reactor.
    let playback_user = cam.playback_username.clone();
    let jpeg = tokio::task::spawn_blocking(move || {
        capture_jpeg_blocking(&uri, playback_user.as_deref(), playback_password.as_deref())
    })
    .await;
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

async fn execute_local_onvif(
    camera_id: String,
    action: String,
    params: serde_json::Value,
) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let Some(bundle) = crate::server::load_cached_bundle() else {
            return Err(crate::onvif_actions::OnvifActionError {
                code: "executor_unavailable".to_string(),
                message: "no bundle cached yet".to_string(),
                details: None,
            });
        };
        crate::onvif_actions::execute_bundle_action(&bundle, &camera_id, &action, &params, 8000)
    })
    .await;

    match result {
        Ok(Ok(value)) => Json(serde_json::json!({ "ok": true, "result": value })).into_response(),
        Ok(Err(err)) => (
            if err.code == "invalid_params"
                || err.code == "unsupported_action"
                || err.code == "unsupported_capability"
            {
                StatusCode::BAD_REQUEST
            } else if err.code == "camera_not_in_bundle" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_GATEWAY
            },
            Json(serde_json::json!({ "ok": false, "error": err })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "ok": false,
                "error": {
                    "code": "executor_unavailable",
                    "message": format!("local ONVIF task failed: {err}"),
                }
            })),
        )
            .into_response(),
    }
}

async fn local_onvif_handler(
    State(state): State<LocalServerState>,
    Path(camera_id): Path<String>,
    Query(auth): Query<LocalAuth>,
    Json(body): Json<LocalOnvifBody>,
) -> Response {
    if !local_key_matches(&state, &auth.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    execute_local_onvif(camera_id, body.action, body.params).await
}

async fn local_onvif_ptz_stop_handler(
    State(state): State<LocalServerState>,
    Path(camera_id): Path<String>,
    Query(query): Query<ProfileQuery>,
) -> Response {
    if !local_key_matches(&state, &query.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let params = json_object_with_profile(query.profile_token);
    execute_local_onvif(camera_id, "ptz.stop".to_string(), params).await
}

async fn local_onvif_ptz_home_handler(
    State(state): State<LocalServerState>,
    Path(camera_id): Path<String>,
    Query(query): Query<ProfileQuery>,
) -> Response {
    if !local_key_matches(&state, &query.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let params = json_object_with_profile(query.profile_token);
    execute_local_onvif(camera_id, "ptz.goto_home".to_string(), params).await
}

async fn local_onvif_ptz_list_presets_handler(
    State(state): State<LocalServerState>,
    Path(camera_id): Path<String>,
    Query(query): Query<ProfileQuery>,
) -> Response {
    if !local_key_matches(&state, &query.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let params = json_object_with_profile(query.profile_token);
    execute_local_onvif(camera_id, "ptz.get_presets".to_string(), params).await
}

async fn local_onvif_ptz_preset_handler(
    State(state): State<LocalServerState>,
    Path((camera_id, preset_token)): Path<(String, String)>,
    Query(query): Query<ProfileQuery>,
) -> Response {
    if !local_key_matches(&state, &query.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let mut params = json_object_with_profile(query.profile_token);
    params["presetToken"] = serde_json::Value::String(preset_token);
    execute_local_onvif(camera_id, "ptz.goto_preset".to_string(), params).await
}

async fn local_onvif_ptz_move_handler(
    State(state): State<LocalServerState>,
    Path(camera_id): Path<String>,
    Query(query): Query<PtzMoveQuery>,
) -> Response {
    if !local_key_matches(&state, &query.key) {
        return (StatusCode::UNAUTHORIZED, "bad key").into_response();
    }
    let speed = query.speed.unwrap_or(0.5).clamp(0.0, 1.0);
    let mut params = json_object_with_profile(query.profile_token);
    params["timeoutMs"] =
        serde_json::Value::Number(serde_json::Number::from(query.timeout_ms.unwrap_or(1000)));
    match query.dir.as_str() {
        "left" => {
            params["pan"] = json!(0.0 - speed);
        }
        "right" => {
            params["pan"] = json!(speed);
        }
        "up" => {
            params["tilt"] = json!(speed);
        }
        "down" => {
            params["tilt"] = json!(0.0 - speed);
        }
        "upleft" => {
            params["pan"] = json!(0.0 - speed);
            params["tilt"] = json!(speed);
        }
        "upright" => {
            params["pan"] = json!(speed);
            params["tilt"] = json!(speed);
        }
        "downleft" => {
            params["pan"] = json!(0.0 - speed);
            params["tilt"] = json!(0.0 - speed);
        }
        "downright" => {
            params["pan"] = json!(speed);
            params["tilt"] = json!(0.0 - speed);
        }
        "zoomin" => {
            params["zoom"] = json!(speed);
        }
        "zoomout" => {
            params["zoom"] = json!(0.0 - speed);
        }
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({
                    "ok": false,
                    "error": {
                        "code": "invalid_params",
                        "message": "dir must be one of left,right,up,down,upleft,upright,downleft,downright,zoomin,zoomout",
                    }
                })),
            ).into_response();
        }
    }
    execute_local_onvif(camera_id, "ptz.continuous_move".to_string(), params).await
}

fn json_object_with_profile(profile_token: Option<String>) -> serde_json::Value {
    let mut value = serde_json::json!({});
    if let Some(profile) = profile_token {
        value["profileToken"] = serde_json::Value::String(profile);
    }
    value
}

fn local_key_matches(state: &LocalServerState, candidate: &str) -> bool {
    let Some(current) = state.local_key.lock().ok().map(|guard| guard.clone()) else {
        return false;
    };
    constant_time_eq(candidate, &current)
}

pub fn replace_local_key(new_key: String) {
    if let Some(active) = ACTIVE_LOCAL_KEY.get() {
        if let Ok(mut guard) = active.lock() {
            *guard = new_key;
        }
    }
}

fn capture_jpeg_blocking(
    rtsp_uri: &str,
    username: Option<&str>,
    password: Option<&str>,
) -> Result<Vec<u8>, String> {
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
    let mut args = vec![
        "-q".to_string(),
        "rtspsrc".to_string(),
        format!("location={rtsp_uri}"),
        "latency=200".to_string(),
        "protocols=tcp".to_string(),
    ];
    if let Some(user) = username.filter(|v| !v.is_empty()) {
        args.push(format!("user-id={user}"));
    }
    if let Some(pass) = password.filter(|v| !v.is_empty()) {
        args.push(format!("user-pw={pass}"));
    }
    args.extend([
        "!".to_string(),
        "decodebin".to_string(),
        "!".to_string(),
        "videoconvert".to_string(),
        "!".to_string(),
        "jpegenc".to_string(),
        "!".to_string(),
        "filesink".to_string(),
        "num-buffers=1".to_string(),
        format!("location={}", tmp.display()),
    ]);
    let status = Command::new("gst-launch-1.0")
        .args(&args)
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

/// Receives ONVIF push notification (WS-BaseNotification Notify) from cameras.
/// The camera POSTs a SOAP envelope containing one or more NotificationMessage
/// blocks. We parse them with the same logic used by the PullPoint path and
/// forward each event to the BF server.
///
/// No auth on this endpoint — cameras cannot send Bearer tokens. The route is
/// only reachable from the LAN (same subnet check done when creating the
/// subscription) and the camera was told the callback URL by the kiosk.
async fn onvif_event_callback(
    State(state): State<LocalServerState>,
    Path((_tenant, camera_id, callback_token)): Path<(String, String, String)>,
    body: String,
) -> Response {
    if !crate::onvif_events::callback_token_matches(&camera_id, &callback_token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let events = crate::onvif_events::parse_notification_messages(&body);
    if events.is_empty() {
        // Could be a subscription confirmation or an empty notify — just ACK.
        return StatusCode::OK.into_response();
    }
    let count = events.len();
    info!("onvif-push: received {count} event(s) for camera {camera_id}");
    // forward_event uses reqwest::blocking — run on a blocking thread to avoid
    // stalling the single-threaded tokio reactor that serves the local server.
    let server_url = state.server_url.clone();
    let kiosk_key = state.kiosk_key.clone();
    let cam_id = camera_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        for evt in &events {
            crate::onvif_events::forward_event(&server_url, &kiosk_key, &cam_id, evt);
            crate::onvif_events::mark_event_received(&cam_id);
        }
    })
    .await;
    StatusCode::OK.into_response()
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

#[cfg(test)]
mod tests {
    use super::operator_token;
    use axum::http::HeaderMap;

    #[test]
    fn operator_token_comes_from_the_http_only_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            "unrelated=value; betterframe_operator=bfs_secret".parse().unwrap(),
        );
        headers.insert("authorization", "Bearer ignored".parse().unwrap());
        assert_eq!(operator_token(&headers), Some("bfs_secret"));
    }
}
