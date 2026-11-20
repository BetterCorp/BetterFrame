//! Versioned generic kiosk API. Shares the existing local API token.
use super::{LocalServerState, local_key_matches};
use crate::core::local_api::Command;
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{
        IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::get,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    convert::Infallible,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const HISTORY: usize = 256;
const RECEIPTS: usize = 1024;
const RECEIPT_TTL: Duration = Duration::from_secs(600);
#[derive(Clone)]
struct ApiEvent {
    sequence: u64,
    kind: &'static str,
    data: Value,
}
struct Receipt {
    command: Command,
    value: Value,
    created: Instant,
    complete: bool,
}
struct Inner {
    sequence: u64,
    catalog: Option<Value>,
    state: Value,
    revision: u64,
    events: VecDeque<ApiEvent>,
    receipts: BTreeMap<String, Receipt>,
}
pub struct Hub {
    instance: String,
    inner: Mutex<Inner>,
}
static HUB: OnceLock<Hub> = OnceLock::new();
pub fn hub() -> &'static Hub {
    HUB.get_or_init(Hub::new)
}
impl Hub {
    /// Create a process-scoped identity and bounded in-memory event/receipt stores.
    fn new() -> Self {
        Self {
            instance: format!("{:032x}", rand::random::<u128>()),
            inner: Mutex::new(Inner {
                sequence: 0,
                catalog: None,
                state: json!({"ready":false,"displays":[]}),
                revision: 0,
                events: VecDeque::new(),
                receipts: BTreeMap::new(),
            }),
        }
    }
    /// Append an event and discard only events outside the advertised replay window.
    fn emit(inner: &mut Inner, kind: &'static str, data: Value) {
        inner.sequence += 1;
        let sequence = inner.sequence;
        inner.events.push_back(ApiEvent {
            sequence,
            kind,
            data,
        });
        while inner.events.len() > HISTORY {
            inner.events.pop_front();
        }
    }
    /// Publish changes to the safe catalogue and renderer state, suppressing duplicates.
    pub fn publish(&self, catalog: Option<Value>, state: Value) {
        let mut inner = self.inner.lock().unwrap();
        if inner.catalog != catalog {
            inner.catalog = catalog;
            let version = inner
                .catalog
                .as_ref()
                .and_then(|c| c.get("version"))
                .cloned();
            Self::emit(
                &mut inner,
                "catalog_changed",
                json!({"catalog_version":version}),
            );
        }
        if inner.state != state {
            inner.state = state;
            inner.revision += 1;
            let revision = inner.revision;
            Self::emit(
                &mut inner,
                "state_changed",
                json!({"state_revision":revision}),
            );
        }
    }
    /// Store an execution acknowledgement and notify subscribers of the final receipt.
    pub fn complete(&self, id: &str, result: Result<Value, String>) {
        let mut inner = self.inner.lock().unwrap();
        let revision = inner.revision;
        let value = match result {
            Ok(result) => {
                json!({"request_id":id,"status":"applied","result":result,"state_revision":revision})
            }
            Err(message) => {
                json!({"request_id":id,"status":"failed","error":{"code":"command_failed","message":message},"state_revision":revision})
            }
        };
        if let Some(receipt) = inner.receipts.get_mut(id) {
            receipt.complete = true;
            receipt.created = Instant::now();
            receipt.value = value.clone();
        }
        Self::emit(&mut inner, "command_completed", value);
    }
    pub(crate) fn receipt(&self, id: &str) -> Option<Value> {
        self.inner
            .lock()
            .unwrap()
            .receipts
            .get(id)
            .map(|r| r.value.clone())
    }
    /// Reserve a request ID atomically; identical retries reuse their existing receipt.
    pub(crate) fn admit(&self, command: &Command) -> Result<bool, (StatusCode, &'static str)> {
        let mut inner = self.inner.lock().unwrap();
        inner
            .receipts
            .retain(|_, r| !r.complete || r.created.elapsed() < RECEIPT_TTL);
        if let Some(previous) = inner.receipts.get(&command.request_id) {
            return if previous.command == *command {
                Ok(false)
            } else {
                Err((
                    StatusCode::CONFLICT,
                    "request_id was already used for another command",
                ))
            };
        }
        if inner.receipts.len() >= RECEIPTS {
            return Err((
                StatusCode::TOO_MANY_REQUESTS,
                "command receipt capacity reached",
            ));
        }
        inner.receipts.insert(
            command.request_id.clone(),
            Receipt {
                command: command.clone(),
                created: Instant::now(),
                complete: false,
                value: json!({"request_id":command.request_id,"status":"accepted"}),
            },
        );
        Ok(true)
    }
    /// Return a credential-free resource snapshot and explicit readiness errors.
    pub(crate) fn snapshot(&self, resource: &str, server_url: &str) -> Result<Value, Response> {
        let inner = self.inner.lock().unwrap();
        let catalog = inner.catalog.as_ref();
        let result = match resource {
            "identity" => json!({"api_version":"1","api_instance_id":self.instance,
                "kiosk_id":catalog.and_then(|c|c.get("kiosk_id")),"kiosk_name":catalog.and_then(|c|c.get("kiosk_name")),
                "hostname":hostname::get().ok().map(|s|s.to_string_lossy().into_owned()),
                "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
                "client_version":option_env!("BF_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
                "server_url":server_url,"ready":catalog.is_some(),
                "capabilities":{"authentication":["bearer","query_key","query_token"],"methods":["GET","POST"],
                    "events":"sse","catalog":true,"live_state":true,"command_receipts":true,
                    "receipt_retention_seconds":600,"event_history":HISTORY,
                    "actions":["select_layout","focus_camera","clear_display","restore_display","standby_display","wake_display","identify_display"]}}),
            "state" => {
                let mut value = inner.state.clone();
                value["revision"] = json!(inner.revision);
                value["api_instance_id"] = json!(self.instance);
                value
            }
            "catalog" => catalog.cloned().ok_or_else(|| {
                error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "not_ready",
                    "kiosk has no applied bundle",
                )
            })?,
            "cameras" | "groups" | "devices" | "displays" => {
                json!({"catalog_version":catalog.and_then(|c|c.get("version")),resource:
                catalog.and_then(|c|c.get(resource)).ok_or_else(||error(StatusCode::SERVICE_UNAVAILABLE,"not_ready","kiosk has no applied bundle"))?})
            }
            "layouts" => json!({"catalog_version":catalog.and_then(|c|c.get("version")),"layouts":
                catalog.and_then(|c|c["displays"].as_array()).ok_or_else(||error(StatusCode::SERVICE_UNAVAILABLE,"not_ready","kiosk has no applied bundle"))?.iter()
                .flat_map(|d|d["layouts"].as_array().into_iter().flatten().map(move |l|{let mut l=l.clone();l["display_id"]=d["id"].clone();l})).collect::<Vec<_>>()}),
            _ => {
                return Err(error(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "resource not found",
                ));
            }
        };
        Ok(result)
    }
    /// Replay a valid cursor or instruct the client to reload after a gap/restart.
    fn replay(&self, cursor: Option<&str>) -> Vec<ApiEvent> {
        let inner = self.inner.lock().unwrap();
        let parsed = cursor
            .and_then(|s| s.split_once(':'))
            .and_then(|(instance, n)| {
                (instance == self.instance)
                    .then(|| n.parse::<u64>().ok())
                    .flatten()
            });
        let oldest = inner
            .events
            .front()
            .map(|e| e.sequence)
            .unwrap_or(inner.sequence + 1);
        match parsed {
            Some(sequence)
                if sequence >= oldest.saturating_sub(1) && sequence <= inner.sequence =>
            {
                inner
                    .events
                    .iter()
                    .filter(|e| e.sequence > sequence)
                    .cloned()
                    .collect()
            }
            _ => vec![ApiEvent {
                sequence: inner.sequence,
                kind: "reset",
                data: json!({"state_revision":inner.revision,
                "catalog_version":inner.catalog.as_ref().and_then(|c|c.get("version"))}),
            }],
        }
    }
}

/// Authentication is checked again when the UI actually executes a command.
pub struct UiCommand {
    pub command: Command,
    key: Arc<Mutex<String>>,
    digest: Vec<u8>,
}
impl UiCommand {
    pub(crate) fn new(command: Command, key: Arc<Mutex<String>>, credential: &str) -> Self {
        Self {
            command,
            key,
            digest: Sha256::digest(credential.as_bytes()).to_vec(),
        }
    }
    /// Refuse queued commands when their authenticating token has since rotated.
    pub fn authorized(&self) -> bool {
        self.key
            .lock()
            .map(|k| Sha256::digest(k.as_bytes()).as_slice() == self.digest.as_slice())
            .unwrap_or(false)
    }
}
pub fn router() -> Router<LocalServerState> {
    Router::new()
        .route(
            "/api/v1/commands/:id",
            get(receipt_handler).post(receipt_handler),
        )
        .route("/api/v1/:resource", get(handler).post(handler))
        .layer(axum::middleware::from_fn(cors))
}
/// This API uses explicit tokens, never ambient browser credentials. Allow generic
/// clients from any origin without granting cookie or operator-session access.
async fn cors(request: Request, next: axum::middleware::Next) -> Response {
    use axum::http::Method;
    let preflight = request.method() == Method::OPTIONS;
    let private_network = request
        .headers()
        .get("access-control-request-private-network")
        .is_some_and(|v| v == "true");
    let mut result = if preflight {
        match request
            .headers()
            .get("access-control-request-method")
            .and_then(|v| v.to_str().ok())
        {
            Some("GET" | "POST") => StatusCode::NO_CONTENT.into_response(),
            _ => error(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "only GET and POST are supported",
            ),
        }
    } else if request.method() != Method::GET && request.method() != Method::POST {
        error(
            StatusCode::METHOD_NOT_ALLOWED,
            "method_not_allowed",
            "only GET and POST are supported",
        )
    } else {
        next.run(request).await
    };
    let headers = result.headers_mut();
    headers.insert("access-control-allow-origin", "*".parse().unwrap());
    if preflight {
        headers.insert("access-control-allow-methods", "GET, POST".parse().unwrap());
        headers.insert(
            "access-control-allow-headers",
            "authorization, content-type, last-event-id"
                .parse()
                .unwrap(),
        );
        headers.insert("access-control-max-age", "600".parse().unwrap());
        if private_network {
            headers.insert(
                "access-control-allow-private-network",
                "true".parse().unwrap(),
            );
        }
        headers.insert("vary","Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network".parse().unwrap());
    }
    result
}
fn response(status: StatusCode, value: Value) -> Response {
    (
        status,
        [
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
        ],
        Json(value),
    )
        .into_response()
}
fn error(status: StatusCode, code: &str, message: &str) -> Response {
    response(status, json!({"error":{"code":code,"message":message}}))
}
/// Accept query or Bearer authentication, rejecting duplicates and conflicting credentials.
fn authenticate(
    state: &LocalServerState,
    request: &Request,
) -> Result<(String, BTreeMap<String, String>), Response> {
    let mut params = BTreeMap::new();
    for (k, v) in url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()) {
        if params.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "duplicate_parameter",
                "duplicate query parameter",
            ));
        }
    }
    let key = params.remove("key");
    let token = params.remove("token");
    if request.headers().get_all("authorization").iter().count() > 1 {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "repeated Authorization headers are not supported",
        ));
    }
    let bearer = match request.headers().get("authorization") {
        Some(value) => Some(
            value
                .to_str()
                .ok()
                .and_then(|v| v.split_once(' '))
                .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
                .map(|(_, token)| token.trim_start_matches(' '))
                .ok_or_else(|| {
                    error(
                        StatusCode::UNAUTHORIZED,
                        "unauthorized",
                        "invalid authorization",
                    )
                })?
                .to_string(),
        ),
        None => None,
    };
    let supplied: Vec<_> = [bearer, key, token].into_iter().flatten().collect();
    if supplied.is_empty()
        || supplied
            .iter()
            .any(|s| s.is_empty() || !local_key_matches(state, s))
    {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "a valid kiosk local API token is required",
        ));
    }
    Ok((supplied[0].clone(), params))
}
/// Read a retained command acknowledgement using the same local-token authorization.
async fn receipt_handler(
    State(state): State<LocalServerState>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    if let Err(err) = authenticate(&state, &request) {
        return err;
    }
    match hub().receipt(&id) {
        Some(v) => response(StatusCode::OK, v),
        None => error(
            StatusCode::NOT_FOUND,
            "not_found",
            "command receipt not found",
        ),
    }
}
/// Dispatch authenticated discovery, event streams, and GET/POST command requests.
async fn handler(
    State(state): State<LocalServerState>,
    Path(resource): Path<String>,
    request: Request,
) -> Response {
    let (credential, params) = match authenticate(&state, &request) {
        Ok(v) => v,
        Err(e) => return e,
    };
    if resource == "events" {
        let mut cursor = request
            .headers()
            .get("last-event-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
            .or_else(|| params.get("since").cloned());
        if request.method() == axum::http::Method::POST {
            if !params.is_empty() {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_parameters",
                    "POST event parameters belong in the JSON body",
                );
            }
            let bytes = match to_bytes(request.into_body(), 16384).await {
                Ok(v) => v,
                Err(_) => {
                    return error(
                        StatusCode::PAYLOAD_TOO_LARGE,
                        "body_too_large",
                        "event body exceeds 16 KiB",
                    );
                }
            };
            if !bytes.is_empty() {
                #[derive(serde::Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Parameters {
                    since: Option<String>,
                }
                let body = match serde_json::from_slice::<Parameters>(&bytes) {
                    Ok(v) => v,
                    Err(_) => {
                        return error(
                            StatusCode::BAD_REQUEST,
                            "invalid_parameters",
                            "invalid event JSON parameters",
                        );
                    }
                };
                if cursor.is_none() {
                    cursor = body.since;
                }
            }
        }
        let stream = futures_util::stream::unfold(
            (state, credential, cursor, VecDeque::<ApiEvent>::new()),
            |(state, credential, mut cursor, mut pending)| async move {
                loop {
                    if !local_key_matches(&state, &credential) {
                        return None;
                    }
                    if let Some(event) = pending.pop_front() {
                        let id = format!("{}:{}", hub().instance, event.sequence);
                        cursor = Some(id.clone());
                        let event = Event::default()
                            .id(id)
                            .event(event.kind)
                            .data(event.data.to_string());
                        return Some((
                            Ok::<_, Infallible>(event),
                            (state, credential, cursor, pending),
                        ));
                    }
                    pending.extend(hub().replay(cursor.as_deref()));
                    if pending.is_empty() {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                }
            },
        );
        let mut result = Sse::new(stream)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
            .into_response();
        result
            .headers_mut()
            .insert("cache-control", "no-store".parse().unwrap());
        result
            .headers_mut()
            .insert("referrer-policy", "no-referrer".parse().unwrap());
        return result;
    }
    if resource != "commands" {
        return match hub().snapshot(&resource, &state.server_url) {
            Ok(v) => response(StatusCode::OK, v),
            Err(e) => e,
        };
    }
    let is_post = request.method() == axum::http::Method::POST;
    let input = if is_post {
        if !params.is_empty() {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_parameters",
                "POST command parameters belong in the JSON body",
            );
        }
        let bytes = match to_bytes(request.into_body(), 16384).await {
            Ok(v) => v,
            Err(_) => {
                return error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "body_too_large",
                    "command body exceeds 16 KiB",
                );
            }
        };
        match serde_json::from_slice::<Command>(&bytes) {
            Ok(c) => c,
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_command",
                    "invalid JSON command",
                );
            }
        }
    } else {
        let mut object = serde_json::Map::new();
        for (key, value) in params {
            let v = if key == "duration_seconds" {
                match value.parse::<u64>() {
                    Ok(n) => json!(n),
                    Err(_) => {
                        return error(
                            StatusCode::BAD_REQUEST,
                            "invalid_command",
                            "duration_seconds must be an integer",
                        );
                    }
                }
            } else {
                json!(value)
            };
            object.insert(key, v);
        }
        match serde_json::from_value::<Command>(Value::Object(object)) {
            Ok(c) => c,
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_command",
                    "invalid query command",
                );
            }
        }
    };
    if let Err(message) = input.validate() {
        return error(StatusCode::BAD_REQUEST, "invalid_command", message);
    }
    let fresh = match hub().admit(&input) {
        Ok(v) => v,
        Err((status, msg)) => {
            return error(
                status,
                if status == StatusCode::TOO_MANY_REQUESTS {
                    "command_capacity"
                } else {
                    "request_conflict"
                },
                msg,
            );
        }
    };
    if fresh {
        let message = crate::WorkerMsg::LocalApi(UiCommand::new(
            input.clone(),
            state.local_key.clone(),
            &credential,
        ));
        let sent = state
            .ui_tx
            .lock()
            .ok()
            .and_then(|tx| tx.as_ref().map(|tx| tx.send(message).is_ok()))
            .unwrap_or(false);
        if !sent {
            hub().complete(
                &input.request_id,
                Err("kiosk renderer is unavailable".into()),
            );
        }
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if !local_key_matches(&state, &credential) {
            return error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "API token changed",
            );
        }
        let value = hub().receipt(&input.request_id).unwrap();
        if value["status"] != "accepted" {
            return response(
                if value["status"] == "applied" {
                    StatusCode::OK
                } else {
                    StatusCode::CONFLICT
                },
                value,
            );
        }
        if Instant::now() >= deadline {
            return response(StatusCode::ACCEPTED, value);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn command(id: &str) -> Command {
        serde_json::from_value(json!({"request_id":id,"action":"wake_display","display_id":"d"}))
            .unwrap()
    }
    #[test]
    /// Require a full reload for gaps and restarts while preserving contiguous replay.
    fn replay_resets_when_cursor_is_expired_or_from_another_process() {
        let h = Hub::new();
        for n in 0..HISTORY + 3 {
            h.publish(None, json!({"n":n}));
        }
        assert_eq!(
            h.replay(Some(&format!("{}:0", h.instance)))[0].kind,
            "reset"
        );
        assert_eq!(h.replay(Some("other:1"))[0].kind, "reset");
        let cursor = format!("{}:{}", h.instance, HISTORY + 2);
        assert_eq!(h.replay(Some(&cursor)).len(), 1);
    }
    #[test]
    /// A repeated request executes once; a different command cannot reuse its ID.
    fn retries_are_idempotent_and_conflicting_ids_fail() {
        let h = Hub::new();
        let c = command("one");
        assert_eq!(h.admit(&c), Ok(true));
        assert_eq!(h.admit(&c), Ok(false));
        let mut other = c.clone();
        other.display_id = "other".into();
        assert!(h.admit(&other).is_err());
        h.complete("one", Ok(json!({})));
        assert_eq!(h.receipt("one").unwrap()["status"], "applied");
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use futures_util::StreamExt;
    use tower::ServiceExt;

    #[tokio::test]
    /// Exercise real routes with both transports, idempotent dispatch and stream revocation.
    async fn authentication_get_post_commands_events_and_rotation() {
        let key = Arc::new(Mutex::new("fixture-key".to_string()));
        let (tx, rx) = std::sync::mpsc::channel();
        let state = LocalServerState {
            local_key: key.clone(),
            server_url: "http://bf.test".into(),
            kiosk_key: "not-exported".into(),
            ui_tx: Arc::new(Mutex::new(Some(tx))),
            operator_auth: crate::operator_console::OperatorAuth::ephemeral(),
        };
        let app = router().with_state(state);
        let request = |url: &str| Request::builder().uri(url).body(Body::empty()).unwrap();
        let preflight = Request::builder()
            .method("OPTIONS")
            .uri("/api/v1/commands")
            .header("origin", "https://client.test")
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization,content-type",
            )
            .header("access-control-request-private-network", "true")
            .body(Body::empty())
            .unwrap();
        let allowed = app.clone().oneshot(preflight).await.unwrap();
        assert_eq!(allowed.status(), StatusCode::NO_CONTENT);
        assert_eq!(allowed.headers()["access-control-allow-origin"], "*");
        assert_eq!(
            allowed.headers()["access-control-allow-private-network"],
            "true"
        );
        assert!(
            allowed
                .headers()
                .get("access-control-allow-credentials")
                .is_none()
        );
        let head=Request::builder().method("HEAD").uri("/api/v1/commands?key=fixture-key&request_id=no-head&action=wake_display&display_id=d").body(Body::empty()).unwrap();
        assert_eq!(
            app.clone().oneshot(head).await.unwrap().status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/identity"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/identity?key=bad"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/identity?key=fixture-key&key=fixture-key"))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let header = Request::builder()
            .uri("/api/v1/identity")
            .header("authorization", "Bearer fixture-key")
            .body(Body::empty())
            .unwrap();
        let identity = app.clone().oneshot(header).await.unwrap();
        assert_eq!(identity.status(), StatusCode::OK);
        assert_eq!(identity.headers()["cache-control"], "no-store");
        assert_eq!(identity.headers()["access-control-allow-origin"], "*");
        let body = to_bytes(identity.into_body(), 10000).await.unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("not-exported"));
        let duplicate = Request::builder()
            .uri("/api/v1/identity")
            .header("authorization", "Bearer fixture-key")
            .header("authorization", "Bearer bad")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(duplicate).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let lowercase = Request::builder()
            .uri("/api/v1/identity")
            .header("authorization", "bEaReR fixture-key")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(lowercase).await.unwrap().status(),
            StatusCode::OK
        );
        let conflict = Request::builder()
            .uri("/api/v1/identity?token=bad")
            .header("authorization", "Bearer fixture-key")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(conflict).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/state?token=fixture-key"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        hub().publish(Some(json!({"version":"test-version","kiosk_id":"k","kiosk_name":"K","devices":[],"cameras":[{"id":"c"}],"groups":[],"displays":[]})),json!({"ready":true,"displays":[]}));
        let cameras = app
            .clone()
            .oneshot(request("/api/v1/cameras?key=fixture-key"))
            .await
            .unwrap();
        let camera_body: Value =
            serde_json::from_slice(&to_bytes(cameras.into_body(), 10000).await.unwrap()).unwrap();
        assert_eq!(camera_body["cameras"][0]["id"], "c");
        let read_post = Request::builder()
            .method("POST")
            .uri("/api/v1/catalog?token=fixture-key")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(read_post).await.unwrap().status(),
            StatusCode::OK
        );
        let worker = std::thread::spawn(move || {
            let mut count = 0;
            while let Ok(crate::WorkerMsg::LocalApi(command)) =
                rx.recv_timeout(Duration::from_secs(5))
            {
                count += 1;
                assert!(command.authorized());
                hub().complete(&command.command.request_id, Ok(json!({"fixture":true})));
                if count == 2 {
                    break;
                }
            }
            count
        });
        let url =
            "/api/v1/commands?key=fixture-key&request_id=http-get&action=wake_display&display_id=d";
        let get = app.clone().oneshot(request(url)).await.unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        assert_eq!(
            app.clone().oneshot(request(url)).await.unwrap().status(),
            StatusCode::OK
        );
        let changed = "/api/v1/commands?key=fixture-key&request_id=http-get&action=wake_display&display_id=other";
        assert_eq!(
            app.clone()
                .oneshot(request(changed))
                .await
                .unwrap()
                .status(),
            StatusCode::CONFLICT
        );
        let post = Request::builder()
            .method("POST")
            .uri("/api/v1/commands?key=fixture-key")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"request_id":"http-post","action":"wake_display","display_id":"d"}"#,
            ))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(post).await.unwrap().status(),
            StatusCode::OK
        );
        assert_eq!(
            worker.join().unwrap(),
            2,
            "retry must not enqueue another UI command"
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/commands/http-post?key=fixture-key"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let events = app
            .clone()
            .oneshot(request("/api/v1/events?key=fixture-key"))
            .await
            .unwrap();
        assert_eq!(events.headers()["access-control-allow-origin"], "*");
        let mut stream = events.into_body().into_data_stream();
        let first = stream.next().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&first).contains("event: reset"));
        let resume = Request::builder()
            .method("POST")
            .uri("/api/v1/events?key=fixture-key")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"since":"other:0"}"#))
            .unwrap();
        let resumed = app.clone().oneshot(resume).await.unwrap();
        assert_eq!(resumed.status(), StatusCode::OK);
        let mut resumed_stream = resumed.into_body().into_data_stream();
        assert!(
            String::from_utf8_lossy(&resumed_stream.next().await.unwrap().unwrap())
                .contains("event: reset")
        );
        *key.lock().unwrap() = "rotated".into();
        assert_eq!(
            app.clone()
                .oneshot(request("/api/v1/identity?key=fixture-key"))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stream.next())
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            app.oneshot(request("/api/v1/identity?key=rotated"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    #[test]
    /// Rotation invalidates work already waiting for the GTK thread.
    fn queued_command_cannot_execute_after_token_rotation() {
        let key = Arc::new(Mutex::new("old".into()));
        let command = UiCommand::new(super::tests::command("rotate"), key.clone(), "old");
        assert!(command.authorized());
        *key.lock().unwrap() = "new".into();
        assert!(!command.authorized());
    }
}
