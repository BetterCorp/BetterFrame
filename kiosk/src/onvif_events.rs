//! ONVIF event subscription for each ONVIF camera in the bundle.
//!
//! For every camera with cam_type=="onvif" and ONVIF credentials, we:
//!   1. Try push subscription first (WS-BaseNotification Subscribe with
//!      callback URL on the kiosk's local HTTP server, port 18090).
//!      Camera must be on the same subnet for the callback to be reachable.
//!   2. If push fails or camera is on a different subnet, fall back to
//!      PullPoint polling at 5s intervals.
//!   3. Parse each NotificationMessage → topic + source + data key/value
//!   4. POST to /api/kiosk/event with source_type="onvif"
//!   5. Renew subscription before it times out
//!   6. Unsubscribe on shutdown / bundle change
//!
//! Push callback endpoint: POST /onvif/events/:camera_id on the kiosk's
//! local Axum server. Cameras POST SOAP Notify envelopes there.
//!
//! Forwards ALL event topics the camera produces: motion, ANPR, line
//! crossing, intrusion, digital input, analytics, tamper — everything.
//! Node-RED sorts what's interesting.
//!
//! Gated by env BF_ENABLE_ONVIF_EVENTS=1 (default OFF for dev kiosks
//! without cameras on the network).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tracing::{info, warn};

use crate::bundle::BundleCamera;

/// Active subscriptions keyed by camera id. Worker threads check this
/// to know when to stop (camera removed from bundle / bundle changed).
static ACTIVE: Mutex<Option<HashMap<String, ()>>> = Mutex::new(None);

/// Holds the current generation Arc. When start() replaces it, the old
/// Arc drops → old threads' Weak::upgrade() returns None → they exit.
/// Previous code used std::mem::forget which leaked the Arc and kept
/// old threads alive forever.
static GENERATION: Mutex<Option<Arc<()>>> = Mutex::new(None);

/// Subscription status per camera — reported in heartbeat for admin visibility.
static STATUS: Mutex<Option<HashMap<String, SubStatus>>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
pub struct SubStatus {
    pub state: &'static str,
    pub last_event_at: Option<String>,
    pub subscribed_at: Option<String>,
    pub error: Option<String>,
    /// How events are received: "push:kiosk", "push:server", or "poll".
    pub resolved_sink: Option<String>,
}

fn epoch_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn epoch_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn set_status(cam_id: &str, state: &'static str, error: Option<String>) {
    set_status_with_sink(cam_id, state, error, None);
}

fn set_status_with_sink(
    cam_id: &str,
    state: &'static str,
    error: Option<String>,
    resolved_sink: Option<String>,
) {
    let mut map = STATUS.lock().unwrap();
    let map = map.get_or_insert_with(HashMap::new);
    let entry = map.entry(cam_id.to_string()).or_insert_with(|| SubStatus {
        state: "subscribing",
        last_event_at: None,
        subscribed_at: None,
        error: None,
        resolved_sink: None,
    });
    entry.state = state;
    entry.error = error;
    if let Some(sink) = resolved_sink {
        entry.resolved_sink = Some(sink);
    }
    if state == "active" {
        entry.subscribed_at = Some(epoch_now());
    }
}

pub fn mark_event_received(cam_id: &str) {
    let mut map = STATUS.lock().unwrap();
    if let Some(map) = map.as_mut() {
        if let Some(entry) = map.get_mut(cam_id) {
            entry.last_event_at = Some(epoch_now());
        }
    }
}

/// Check if any subscription needs a forced refresh (>24h since subscribe,
/// or currently in failed/stopped state).
pub fn needs_refresh() -> bool {
    let map = STATUS.lock().unwrap();
    let Some(map) = map.as_ref() else {
        return false;
    };
    let now = epoch_now_secs();
    for status in map.values() {
        if status.state == "failed" || status.state == "stopped" {
            return true;
        }
        if let Some(ref sub_at) = status.subscribed_at {
            if let Ok(ts) = sub_at.parse::<u64>() {
                if now.saturating_sub(ts) > 24 * 3600 {
                    return true;
                }
            }
        }
    }
    false
}

/// Get current subscription statuses for all cameras. Used by heartbeat.
pub fn get_statuses() -> HashMap<String, SubStatus> {
    STATUS.lock().unwrap().clone().unwrap_or_default()
}

/// Start event subscription workers for ONVIF cameras assigned to this kiosk.
/// Only subscribes when event_source is "auto" or "kiosk:<this_kiosk_id>".
pub fn start(
    cameras: &[BundleCamera],
    cluster_key: Option<&str>,
    server_url: &str,
    kiosk_key: &str,
) {
    let my_kiosk_id = crate::server::load_kiosk_id();
    let onvif_cams: Vec<_> = cameras
        .iter()
        .filter(|c| {
            if c.cam_type != "onvif" || c.onvif_host.is_none() {
                return false;
            }
            match c.event_source.as_deref() {
                Some("server") => false,
                Some("none") | Some("disabled") => false,
                Some(s) if s.starts_with("kiosk:") => {
                    let assigned = &s[6..];
                    my_kiosk_id.as_deref() == Some(assigned)
                }
                _ => true, // "auto" or missing
            }
        })
        .cloned()
        .collect();

    if onvif_cams.is_empty() {
        return;
    }

    // Signal old workers to stop.
    let mut active = ACTIVE.lock().unwrap();
    let new_map: HashMap<String, ()> = onvif_cams.iter().map(|c| (c.id.clone(), ())).collect();
    *active = Some(new_map);
    drop(active);

    let generation = Arc::new(());
    // Store in static — replaces old generation → old Arc drops → old
    // threads' Weak::upgrade() returns None → they exit cleanly.
    *GENERATION.lock().unwrap() = Some(generation.clone());

    for cam in onvif_cams {
        let server = server_url.to_string();
        let key = kiosk_key.to_string();
        let weak_gen = Arc::downgrade(&generation);
        let password = match (&cam.onvif_password_encrypted, cluster_key) {
            (Some(enc), Some(ck)) => decrypt_cluster(enc, ck),
            _ => None,
        };

        std::thread::spawn(move || {
            run_subscription(cam, password.as_deref(), &server, &key, weak_gen);
        });
    }
}

// ---- Subnet detection for push callback URL ----------------------------------

/// Read the kiosk's own IPv4 addresses with prefix lengths from `ip -j addr show`.
fn read_local_interfaces() -> Vec<(std::net::Ipv4Addr, u32)> {
    let out = match std::process::Command::new("ip")
        .args(["-j", "addr", "show"])
        .output()
    {
        Ok(out) if out.status.success() => out,
        _ => return Vec::new(),
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&out.stdout) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for item in items {
        // Skip loopback
        if item.get("ifname").and_then(|v| v.as_str()) == Some("lo") {
            continue;
        }
        if let Some(addrs) = item.get("addr_info").and_then(|v| v.as_array()) {
            for addr in addrs {
                if addr.get("family").and_then(|v| v.as_str()) != Some("inet") {
                    continue;
                }
                let Some(local) = addr.get("local").and_then(|v| v.as_str()) else {
                    continue;
                };
                let prefix = addr.get("prefixlen").and_then(|v| v.as_u64()).unwrap_or(24) as u32;
                if let Ok(ip) = local.parse::<std::net::Ipv4Addr>() {
                    result.push((ip, prefix));
                }
            }
        }
    }
    result
}

/// Check if a camera IP is on the same subnet as any kiosk interface.
/// Returns the kiosk IP on the matching interface if found.
fn is_same_subnet(
    camera_host: &str,
    kiosk_interfaces: &[(std::net::Ipv4Addr, u32)],
) -> Option<std::net::Ipv4Addr> {
    let cam_ip: std::net::Ipv4Addr = camera_host.parse().ok()?;
    let cam_bits = u32::from(cam_ip);
    for &(iface_ip, prefix_len) in kiosk_interfaces {
        let mask = if prefix_len >= 32 {
            u32::MAX
        } else {
            u32::MAX << (32 - prefix_len)
        };
        let iface_bits = u32::from(iface_ip);
        if (cam_bits & mask) == (iface_bits & mask) {
            return Some(iface_ip);
        }
    }
    None
}

// ---- Push subscription (WS-BaseNotification) ---------------------------------

struct PushSubscription {
    subscription_reference: String,
    resolved_sink: String,
}

fn create_push_subscription(
    event_url: &str,
    callback_url: &str,
    user: &str,
    pass: &str,
) -> Result<PushSubscription, String> {
    let xml = soap_post_authed(
        event_url,
        "http://docs.oasis-open.org/wsn/bw-2/NotificationProducer/SubscribeRequest",
        &format!(
            r#"<wsnt:Subscribe>
  <wsnt:ConsumerReference>
    <wsa:Address>{callback_url}</wsa:Address>
  </wsnt:ConsumerReference>
  <wsnt:InitialTerminationTime>PT300S</wsnt:InitialTerminationTime>
</wsnt:Subscribe>"#
        ),
        user,
        pass,
    )?;

    let address = extract_tag_ns(&xml, "Address")
        .filter(|a| !a.is_empty() && a.starts_with("http"))
        .ok_or_else(|| {
            let preview: String = xml.chars().take(300).collect();
            format!("no SubscriptionReference in Subscribe response: {preview}")
        })?;

    let resolved_sink = if callback_url.contains(":18090") {
        "push:kiosk".to_string()
    } else {
        "push:server".to_string()
    };

    Ok(PushSubscription {
        subscription_reference: address,
        resolved_sink,
    })
}

fn renew_push(sub_ref: &str, user: &str, pass: &str) -> Result<(), String> {
    soap_post_authed(
        sub_ref,
        "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest",
        r#"<wsnt:Renew><wsnt:TerminationTime>PT300S</wsnt:TerminationTime></wsnt:Renew>"#,
        user,
        pass,
    )?;
    Ok(())
}

fn unsubscribe_push(sub_ref: &str, user: &str, pass: &str) -> Result<(), String> {
    let _ = soap_post_authed(
        sub_ref,
        "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest",
        "<wsnt:Unsubscribe/>",
        user,
        pass,
    );
    Ok(())
}

fn run_subscription(
    cam: BundleCamera,
    password: Option<&str>,
    server: &str,
    kiosk_key: &str,
    generation: std::sync::Weak<()>,
) {
    let host = cam.onvif_host.as_deref().unwrap_or("");
    let port = cam.onvif_port.unwrap_or(80);
    let user = cam.onvif_username.as_deref().unwrap_or("");
    let pass = password.unwrap_or("");
    let event_url = resolve_event_service_url(host, port, user, pass)
        .unwrap_or_else(|| format!("http://{host}:{port}/onvif/event_service"));

    let has_pass = !pass.is_empty();
    info!(
        "onvif-events: cam {} ({}) subscribing at {event_url} user={user} has_pass={has_pass}",
        cam.id, cam.name
    );

    // Determine callback URL for push subscription.
    // If camera is on the same subnet as the kiosk, use direct kiosk callback.
    // Otherwise fall back to PullPoint polling.
    let local_port: u16 = std::env::var("BF_KIOSK_LOCAL_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(18090);
    let callback_url = {
        let interfaces = read_local_interfaces();
        if let Some(kiosk_ip) = is_same_subnet(host, &interfaces) {
            Some(format!(
                "http://{}:{}/onvif/events/{}",
                kiosk_ip, local_port, cam.id
            ))
        } else {
            // Camera not on same subnet — no reachable callback URL.
            // Future: could use server callback URL from bundle if available.
            None
        }
    };

    let mut backoff_secs: u64 = 60;
    loop {
        if generation.upgrade().is_none() {
            info!("onvif-events: cam {} generation expired, exiting", cam.id);
            return;
        }

        set_status(&cam.id, "subscribing", None);

        // ---- Try push subscription first ----
        if let Some(ref cb_url) = callback_url {
            info!(
                "onvif-events: cam {} trying push subscription, callback={cb_url}",
                cam.id
            );
            match create_push_subscription(&event_url, cb_url, user, pass) {
                Ok(push_sub) => {
                    info!(
                        "onvif-events: cam {} push subscription active, ref={}, sink={}",
                        cam.id, push_sub.subscription_reference, push_sub.resolved_sink
                    );
                    set_status_with_sink(
                        &cam.id,
                        "active",
                        None,
                        Some(push_sub.resolved_sink.clone()),
                    );
                    backoff_secs = 30;

                    // Push mode: just renew periodically. Events arrive via HTTP callback.
                    let renew_interval = Duration::from_secs(240); // renew well before 300s timeout
                    let mut since_renew = std::time::Instant::now();
                    let mut consecutive_errors: u32 = 0;

                    loop {
                        if generation.upgrade().is_none() {
                            let _ = unsubscribe_push(&push_sub.subscription_reference, user, pass);
                            return;
                        }

                        std::thread::sleep(Duration::from_secs(30));

                        if since_renew.elapsed() > renew_interval {
                            match renew_push(&push_sub.subscription_reference, user, pass) {
                                Ok(()) => {
                                    since_renew = std::time::Instant::now();
                                    consecutive_errors = 0;
                                }
                                Err(e) => {
                                    consecutive_errors += 1;
                                    warn!(
                                        "onvif-events: cam {} push renew failed ({consecutive_errors}x): {e}",
                                        cam.id
                                    );
                                    if consecutive_errors >= 3 {
                                        warn!(
                                            "onvif-events: cam {} push renew failed too many times, falling through to poll",
                                            cam.id
                                        );
                                        let _ = unsubscribe_push(
                                            &push_sub.subscription_reference,
                                            user,
                                            pass,
                                        );
                                        break; // fall through to PullPoint below
                                    }
                                }
                            }
                        }
                    }
                    // If we broke out of push renew loop, fall through to PullPoint
                }
                Err(e) => {
                    info!(
                        "onvif-events: cam {} push subscription failed: {e}, falling back to poll",
                        cam.id
                    );
                    // Fall through to PullPoint below
                }
            }
        }

        // ---- PullPoint fallback ----
        set_status(&cam.id, "subscribing", None);
        let sub = match create_pullpoint(&event_url, user, pass) {
            Ok(s) => s,
            Err(e) => {
                warn!(
                    "onvif-events: cam {} CreatePullPoint failed: {e} (backoff {backoff_secs}s)",
                    cam.id
                );
                set_status(&cam.id, "failed", Some(e));
                std::thread::sleep(Duration::from_secs(backoff_secs));
                backoff_secs = (backoff_secs * 2).min(900);
                continue;
            }
        };
        backoff_secs = 30;
        info!(
            "onvif-events: cam {} pullpoint subscribed, address={}",
            cam.id, sub.address
        );
        set_status_with_sink(&cam.id, "active", None, Some("poll".to_string()));

        let poll_interval = Duration::from_secs(5);
        let renew_interval = Duration::from_secs(55);
        let mut since_renew = std::time::Instant::now();
        let mut consecutive_errors: u32 = 0;

        loop {
            if generation.upgrade().is_none() {
                let _ = unsubscribe(&sub.address, user, pass);
                return;
            }

            // Renew before timeout
            if since_renew.elapsed() > renew_interval {
                match renew(&sub.address, user, pass) {
                    Ok(()) => since_renew = std::time::Instant::now(),
                    Err(e) => {
                        warn!(
                            "onvif-events: cam {} renew failed: {e}, resubscribing",
                            cam.id
                        );
                        break; // outer loop will re-create
                    }
                }
            }

            match pull_messages(&sub.address, user, pass) {
                Ok(events) => {
                    consecutive_errors = 0;
                    for evt in events {
                        forward_event(server, kiosk_key, &cam.id, &evt);
                        mark_event_received(&cam.id);
                    }
                }
                Err(e) => {
                    consecutive_errors += 1;
                    let error_backoff = (15 * consecutive_errors as u64).min(300);
                    warn!(
                        "onvif-events: cam {} pull failed ({consecutive_errors}x): {e}, backoff {error_backoff}s",
                        cam.id
                    );
                    set_status(&cam.id, "failed", Some(e));
                    if consecutive_errors >= 5 {
                        break; // resubscribe from scratch
                    }
                    std::thread::sleep(Duration::from_secs(error_backoff));
                    continue;
                }
            }

            std::thread::sleep(poll_interval);
        }
    }
}

// ---- SOAP helpers ----------------------------------------------------------

struct Subscription {
    address: String,
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn wsse_header(user: &str, pass: &str) -> String {
    use base64::Engine;
    use rand::RngCore;
    use sha1::{Digest, Sha1};

    let mut nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce);
    let created = chrono_now();
    let mut hasher = Sha1::new();
    hasher.update(&nonce);
    hasher.update(created.as_bytes());
    hasher.update(pass.as_bytes());
    let digest = hasher.finalize();
    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(nonce);
    let digest_b64 = base64::engine::general_purpose::STANDARD.encode(digest);
    format!(
        r#"<Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" s:mustUnderstand="1">
  <UsernameToken>
    <Username>{}</Username>
    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest_b64}</Password>
    <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce_b64}</Nonce>
    <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</Created>
  </UsernameToken>
</Security>"#,
        escape_xml(user)
    )
}

fn wsse_text_header(user: &str, pass: &str) -> String {
    format!(
        r#"<Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" s:mustUnderstand="1">
  <UsernameToken>
    <Username>{}</Username>
    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">{}</Password>
  </UsernameToken>
</Security>"#,
        escape_xml(user),
        escape_xml(pass)
    )
}

fn soap_envelope(header_inner: Option<&str>, body_inner: &str) -> String {
    let header = header_inner
        .map(|h| format!("<s:Header>{h}</s:Header>"))
        .unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tev="http://www.onvif.org/ver10/events/wsdl"
            xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
            xmlns:wsa="http://www.w3.org/2005/08/addressing">
  {header}
  <s:Body>{body_inner}</s:Body>
</s:Envelope>"#
    )
}

fn soap_post_body(
    client: &reqwest::blocking::Client,
    url: &str,
    action: &str,
    body: &str,
    auth: Option<String>,
) -> Result<(reqwest::StatusCode, String, Option<String>), String> {
    let mut request = client
        .post(url)
        .header("Content-Type", "application/soap+xml; charset=utf-8")
        .header("SOAPAction", action)
        .body(body.to_string())
        .timeout(Duration::from_secs(10));
    if let Some(auth) = auth {
        request = request.header("Authorization", auth);
    }
    let resp = request.send().map_err(|e| format!("soap: {e}"))?;
    let status = resp.status();
    let challenge = resp
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_string());
    let text = resp.text().map_err(|e| format!("soap body: {e}"))?;
    Ok((status, text, challenge))
}

fn soap_post_authed(
    url: &str,
    action: &str,
    body_inner: &str,
    user: &str,
    pass: &str,
) -> Result<String, String> {
    use base64::Engine;

    let client = reqwest::blocking::Client::new();
    let mut last_error = String::from("unknown ONVIF SOAP error");
    let mut digest_challenge: Option<String> = None;
    let attempts = [
        (
            "wsse-digest",
            soap_envelope(Some(&wsse_header(user, pass)), body_inner),
            None,
        ),
        (
            "wsse-text",
            soap_envelope(Some(&wsse_text_header(user, pass)), body_inner),
            None,
        ),
        (
            "basic",
            soap_envelope(None, body_inner),
            Some(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"))
            )),
        ),
        ("challenge", soap_envelope(None, body_inner), None),
    ];

    for (kind, body, auth) in attempts {
        match soap_post_body(&client, url, action, &body, auth) {
            Ok((status, text, challenge)) => {
                if digest_challenge.is_none() {
                    digest_challenge = challenge;
                }
                let fault = extract_soap_fault(&text);
                if status.is_success() && fault.is_empty() {
                    return Ok(text);
                }
                last_error = format!("soap {kind} HTTP {status}: {fault}");
            }
            Err(err) => last_error = format!("soap {kind}: {err}"),
        }
    }

    if let Some(challenge) = digest_challenge.as_deref() {
        if let Some(auth) = digest_auth_header_from_challenge("POST", url, challenge, user, pass) {
            let body = soap_envelope(None, body_inner);
            let (status, text, _) = soap_post_body(&client, url, action, &body, Some(auth))?;
            let fault = extract_soap_fault(&text);
            if status.is_success() && fault.is_empty() {
                return Ok(text);
            }
            last_error = format!("soap digest HTTP {status}: {fault}");
        }
    }

    Err(last_error)
}

/// Extract a human-readable fault reason from SOAP XML, stripping envelope noise.
fn extract_soap_fault(xml: &str) -> String {
    if !xml.contains(":Fault") && !xml.contains("<Fault") {
        return String::new();
    }
    // Try common SOAP fault tags
    for tag in &["Reason", "Text", "faultstring", "Detail", "Subcode"] {
        if let Some(val) = extract_tag_ns(xml, tag) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    // Try Code/Value
    if let Some(val) = extract_tag_ns(xml, "Value") {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return format!("Code: {trimmed}");
        }
    }
    // Fallback: first 300 chars stripped of XML tags
    let stripped: String = xml
        .replace(|c: char| c == '<', "\n<")
        .lines()
        .filter(|l| !l.trim_start().starts_with('<'))
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if stripped.is_empty() {
        xml.chars().take(300).collect()
    } else {
        stripped.chars().take(300).collect()
    }
}

fn create_pullpoint(url: &str, user: &str, pass: &str) -> Result<Subscription, String> {
    let xml = soap_post_authed(
        url,
        "http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest",
        r#"<tev:CreatePullPointSubscription>
  <tev:InitialTerminationTime>PT60S</tev:InitialTerminationTime>
</tev:CreatePullPointSubscription>"#,
        user,
        pass,
    )?;
    // Camera may use namespaced Address: <wsa5:Address>, <a:Address>,
    // <wsa:Address>, or plain <Address>. Try all.
    let address = extract_tag_ns(&xml, "Address")
        .filter(|a| !a.is_empty() && a.starts_with("http"))
        .ok_or_else(|| {
            // Log first 300 chars of response for debugging.
            let preview: String = xml.chars().take(300).collect();
            format!("no Address in CreatePullPoint response: {preview}")
        })?;
    Ok(Subscription { address })
}

fn resolve_event_service_url(host: &str, port: u16, user: &str, pass: &str) -> Option<String> {
    let device_url = format!("http://{host}:{port}/onvif/device_service");
    let xml = soap_post_authed(
        &device_url,
        "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
        r#"<tds:GetCapabilities xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <tds:Category>All</tds:Category>
</tds:GetCapabilities>"#,
        user,
        pass,
    )
    .ok()?;
    let events = extract_section(&xml, "Events")?;
    let xaddr = extract_tag_ns(&events, "XAddr")?;
    if xaddr.starts_with("http://") || xaddr.starts_with("https://") {
        Some(xaddr)
    } else {
        None
    }
}

/// Extract tag content, trying with and without namespace prefixes.
fn extract_tag_ns(xml: &str, tag: &str) -> Option<String> {
    // Try common namespace prefixes for ONVIF/WS-Addressing.
    for prefix in &["", "wsa5:", "wsa:", "a:", "wsnt:", "tev:", "tt:"] {
        let full = format!("{prefix}{tag}");
        if let Some(val) = extract_tag(xml, &full) {
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    // Fallback: regex-style scan for any :Address> content.
    let pattern = format!(":{tag}>");
    if let Some(pos) = xml.find(&pattern) {
        let after = &xml[pos + pattern.len()..];
        if let Some(end) = after.find('<') {
            let val = after[..end].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn pull_messages(sub_url: &str, user: &str, pass: &str) -> Result<Vec<OnvifEvent>, String> {
    let xml = soap_post_authed(
        sub_url,
        "http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest",
        r#"<tev:PullMessages>
  <tev:Timeout>PT5S</tev:Timeout>
  <tev:MessageLimit>100</tev:MessageLimit>
</tev:PullMessages>"#,
        user,
        pass,
    )?;
    Ok(parse_notification_messages(&xml))
}

fn renew(sub_url: &str, user: &str, pass: &str) -> Result<(), String> {
    soap_post_authed(
        sub_url,
        "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest",
        r#"<wsnt:Renew><wsnt:TerminationTime>PT60S</wsnt:TerminationTime></wsnt:Renew>"#,
        user,
        pass,
    )?;
    Ok(())
}

fn unsubscribe(sub_url: &str, user: &str, pass: &str) -> Result<(), String> {
    let _ = soap_post_authed(
        sub_url,
        "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest",
        "<wsnt:Unsubscribe/>",
        user,
        pass,
    );
    Ok(())
}

// ---- Event parsing ---------------------------------------------------------

#[derive(Debug)]
pub struct OnvifEvent {
    pub topic: String,
    pub source: HashMap<String, String>,
    pub data: HashMap<String, String>,
    pub timestamp: Option<String>,
}

/// Parse ONVIF NotificationMessage blocks from SOAP XML. Public so the push
/// callback endpoint in `local_server` can parse incoming Notify envelopes.
pub fn parse_notification_messages(xml: &str) -> Vec<OnvifEvent> {
    let mut events = Vec::new();
    // Split on NotificationMessage blocks
    for block in xml.split("<wsnt:NotificationMessage") {
        if !block.contains("Topic") {
            continue;
        }
        let topic = extract_tag(block, "Topic")
            .or_else(|| {
                extract_attr_value(block, "Topic", "Dialect").map(|_| {
                    // Topic might be inline text
                    extract_inner_text(block, "Topic").unwrap_or_default()
                })
            })
            .unwrap_or_default();
        if topic.is_empty() {
            continue;
        }

        let mut source = HashMap::new();
        let mut data = HashMap::new();

        // Parse SimpleItem elements in Source and Data sections
        if let Some(src_block) = extract_section(block, "Source") {
            for (name, value) in parse_simple_items(&src_block) {
                source.insert(name, value);
            }
        }
        if let Some(key_block) = extract_section(block, "Key") {
            for (name, value) in parse_simple_items(&key_block) {
                data.insert(name, value);
            }
        }
        if let Some(data_block) = extract_section(block, "Data") {
            for (name, value) in parse_simple_items(&data_block) {
                data.insert(name, value);
            }
        }

        let timestamp = extract_tag(block, "UtcTime")
            .or_else(|| extract_attr_value(block, "Message", "UtcTime"));

        events.push(OnvifEvent {
            topic,
            source,
            data,
            timestamp,
        });
    }
    events
}

fn parse_simple_items(xml: &str) -> Vec<(String, String)> {
    let mut items = Vec::new();
    for part in xml.split("SimpleItem") {
        let name = extract_attr_inline(part, "Name");
        let value = extract_attr_inline(part, "Value");
        if let (Some(n), Some(v)) = (name, value) {
            items.push((n, v));
        }
    }
    items
}

// ---- Minimal XML helpers (no full parser dep) ------------------------------

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    // Handles both <ns:Tag>value</ns:Tag> and <Tag>value</Tag>
    let patterns = [format!("<{tag}>"), format!("<{tag} ")];
    for pat in &patterns {
        if let Some(start) = xml.find(pat.as_str()) {
            let after = &xml[start + pat.len()..];
            // If pattern ended with space, skip to >
            let content_start = if pat.ends_with(' ') {
                after.find('>')?.checked_add(1)?
            } else {
                0
            };
            let content = &after[content_start..];
            let end_patterns = [format!("</{tag}>"), format!(":{tag}>")];
            for end_pat in &end_patterns {
                if let Some(end) = content.find(end_pat.as_str()) {
                    // Walk back to find the < of the closing tag
                    let slice = &content[..end];
                    let result = if let Some(lt) = slice.rfind('<') {
                        &slice[..lt]
                    } else {
                        slice
                    };
                    return Some(result.trim().to_string());
                }
            }
        }
    }
    // Try with namespace prefix
    for part in xml.split('<') {
        if let Some(rest) = part.strip_suffix('>').or_else(|| {
            let idx = part.find('>')?;
            Some(&part[..idx])
        }) {
            if rest.contains(':') && rest.ends_with(tag)
                || rest
                    .split_whitespace()
                    .next()?
                    .ends_with(&format!(":{tag}"))
            {
                // Found opening tag with namespace
                let after_close = &xml[xml.find(part)? + part.len()..];
                if let Some(_end_idx) = after_close.find(&format!(":{tag}>")) {
                    let content = &after_close[after_close.find('>')? + 1..];
                    if let Some(close) = content.find('<') {
                        return Some(content[..close].trim().to_string());
                    }
                }
            }
        }
    }
    None
}

fn extract_inner_text(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!(":{tag}"))?;
    let after = &xml[start..];
    let gt = after.find('>')?;
    let content = &after[gt + 1..];
    let lt = content.find('<')?;
    Some(content[..lt].trim().to_string())
}

fn extract_section(xml: &str, section: &str) -> Option<String> {
    let patterns = [format!("<tt:{section}"), format!("<{section}")];
    for pat in &patterns {
        if let Some(start) = xml.find(pat.as_str()) {
            let rest = &xml[start..];
            let end_patterns = [format!("</tt:{section}>"), format!("</{section}>")];
            for end_pat in &end_patterns {
                if let Some(end) = rest.find(end_pat.as_str()) {
                    return Some(rest[..end + end_pat.len()].to_string());
                }
            }
        }
    }
    None
}

fn extract_attr_value(xml: &str, tag: &str, attr: &str) -> Option<String> {
    let tag_start = xml.find(tag)?;
    let after = &xml[tag_start..];
    let attr_pat = format!("{attr}=\"");
    let attr_start = after.find(&attr_pat)?;
    let val_start = attr_start + attr_pat.len();
    let val_end = after[val_start..].find('"')?;
    Some(after[val_start..val_start + val_end].to_string())
}

fn extract_attr_inline(xml: &str, attr: &str) -> Option<String> {
    let pat = format!("{attr}=\"");
    let start = xml.find(&pat)?;
    let val_start = start + pat.len();
    let val_end = xml[val_start..].find('"')?;
    Some(xml[val_start..val_start + val_end].to_string())
}

// ---- Forward to BF server --------------------------------------------------

/// Forward an ONVIF event to the BF server. Public so the push callback
/// endpoint in `local_server` can reuse the same forwarding logic.
pub fn forward_event(server: &str, kiosk_key: &str, camera_id: &str, evt: &OnvifEvent) {
    let (data, camera_proxy_paths) = camera_proxy_event_data(&evt.data);
    let mut payload = serde_json::json!({
        "source": evt.source,
        "data": data,
        "timestamp": evt.timestamp,
    });
    if !camera_proxy_paths.is_empty() {
        payload["camera_proxy_paths"] = serde_json::json!(camera_proxy_paths);
    }
    let body = serde_json::json!({
        "topic": evt.topic,
        "source_type": "onvif",
        "camera_id": camera_id,
        "property_op": "changed",
        "payload": payload,
    });
    let _ = reqwest::blocking::Client::new()
        .post(format!("{server}/api/kiosk/event"))
        .header("Authorization", format!("Bearer {kiosk_key}"))
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send();
}

fn camera_proxy_event_data(
    data: &HashMap<String, String>,
) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut out = data.clone();
    let mut camera_proxy_paths = HashMap::new();
    let image_exts = [".jpg", ".jpeg", ".png", ".bmp"];
    for (key, value) in data {
        if !value.starts_with("http://") && !value.starts_with("https://") {
            continue;
        }
        let lower = value.to_lowercase();
        let image_like_key =
            key.to_lowercase().contains("picture") || key.to_lowercase().contains("image");
        if !image_like_key && !image_exts.iter().any(|ext| lower.contains(ext)) {
            continue;
        }
        if let Some(path) = image_proxy_path(value) {
            out.insert(key.clone(), path.clone());
            camera_proxy_paths.insert(key.clone(), path);
        }
    }
    (out, camera_proxy_paths)
}

fn image_proxy_path(raw: &str) -> Option<String> {
    let parsed = url::Url::parse(raw).ok()?;
    let mut path = parsed.path().to_string();
    if path.is_empty() {
        path = "/".to_string();
    }
    if let Some(query) = parsed.query() {
        path.push('?');
        path.push_str(query);
    }
    Some(path)
}

fn digest_auth_header_from_challenge(
    method: &str,
    url: &str,
    www_auth: &str,
    user: &str,
    pass: &str,
) -> Option<String> {
    if !www_auth.to_lowercase().starts_with("digest ") {
        return None;
    }
    let realm = extract_digest_field(www_auth, "realm")?;
    let nonce = extract_digest_field(www_auth, "nonce")?;
    let qop = extract_digest_field(www_auth, "qop").unwrap_or_default();
    let uri = url::Url::parse(url)
        .ok()
        .map(|u| {
            if let Some(query) = u.query() {
                format!("{}?{}", u.path(), query)
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
    if qop.contains("auth") {
        Some(format!(
            r#"Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", response="{response}", qop=auth, nc={nc}, cnonce="{cnonce}""#
        ))
    } else {
        Some(format!(
            r#"Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", response="{response}""#
        ))
    }
}

fn extract_digest_field(header: &str, field: &str) -> Option<String> {
    let pat = format!("{field}=\"");
    let start = header.find(&pat)? + pat.len();
    let end = header[start..].find('"')?;
    Some(header[start..start + end].to_string())
}

fn md5_hex(input: &str) -> String {
    let digest = md5::compute(input.as_bytes());
    hex_lower_bytes(&digest.0)
}

fn hex_lower_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

// ---- Cluster key decryption ------------------------------------------------

/// Decrypt a value encrypted with secrets.encryptForCluster on the server.
/// Format: "v1.<iv_b64u>.<tag_b64u>.<ct_b64u>". AES-256-GCM.
/// cluster_key is base64url-encoded 32-byte key.
pub fn decrypt_cluster_public(ciphertext: &str, key: &str) -> Option<String> {
    decrypt_cluster(ciphertext, key)
}

fn decrypt_cluster(ciphertext: &str, cluster_key_b64u: &str) -> Option<String> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Key, Nonce,
    };
    use base64::Engine;

    let b64u = base64::engine::general_purpose::URL_SAFE_NO_PAD;

    let parts: Vec<&str> = ciphertext.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" {
        warn!(
            "decrypt_cluster: bad format: {}",
            ciphertext.chars().take(20).collect::<String>()
        );
        return None;
    }
    let iv = b64u.decode(parts[1]).ok()?;
    let tag = b64u.decode(parts[2]).ok()?;
    let ct = b64u.decode(parts[3]).ok()?;
    let key_bytes = b64u.decode(cluster_key_b64u).ok()?;
    if key_bytes.len() != 32 || iv.len() != 12 || tag.len() != 16 {
        warn!(
            "decrypt_cluster: bad lengths key={} iv={} tag={}",
            key_bytes.len(),
            iv.len(),
            tag.len()
        );
        return None;
    }

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let nonce = Nonce::from_slice(&iv);
    // AES-GCM ciphertext+tag concatenated for decryption.
    let mut combined = ct;
    combined.extend_from_slice(&tag);
    match cipher.decrypt(nonce, combined.as_ref()) {
        Ok(plaintext) => String::from_utf8(plaintext).ok(),
        Err(e) => {
            warn!("decrypt_cluster: decrypt failed: {e}");
            None
        }
    }
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // ISO-8601 approximation without chrono crate.
    let days = secs / 86400;
    let remaining = secs % 86400;
    let hours = remaining / 3600;
    let minutes = (remaining % 3600) / 60;
    let seconds = remaining % 60;
    // Rough year/month/day — good enough for WSSE nonce timestamp.
    // This is NOT used for display, only SOAP auth.
    let (year, month, day) = epoch_days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn epoch_days_to_ymd(days: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
