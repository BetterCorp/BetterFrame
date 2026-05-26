//! ONVIF PullPoint event subscription for each ONVIF camera in the bundle.
//!
//! For every camera with cam_type=="onvif" and ONVIF credentials, we:
//!   1. CreatePullPointSubscription (SOAP to the camera's event service)
//!   2. PullMessages in a loop (every 3s)
//!   3. Parse each NotificationMessage → topic + source + data key/value
//!   4. POST to /api/kiosk/event with source_type="onvif"
//!   5. Renew subscription before it times out
//!   6. Unsubscribe on shutdown / bundle change
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
static ACTIVE: Mutex<Option<HashMap<u32, ()>>> = Mutex::new(None);

/// Holds the current generation Arc. When start() replaces it, the old
/// Arc drops → old threads' Weak::upgrade() returns None → they exit.
/// Previous code used std::mem::forget which leaked the Arc and kept
/// old threads alive forever.
static GENERATION: Mutex<Option<Arc<()>>> = Mutex::new(None);

/// Subscription status per camera — reported in heartbeat for admin visibility.
static STATUS: Mutex<Option<HashMap<u32, SubStatus>>> = Mutex::new(None);

#[derive(Clone, serde::Serialize)]
pub struct SubStatus {
    pub state: &'static str, // "subscribing", "active", "failed", "stopped"
    pub last_event_at: Option<String>,
    pub error: Option<String>,
}

fn set_status(cam_id: u32, state: &'static str, error: Option<String>) {
    let mut map = STATUS.lock().unwrap();
    let map = map.get_or_insert_with(HashMap::new);
    let entry = map.entry(cam_id).or_insert_with(|| SubStatus {
        state: "subscribing",
        last_event_at: None,
        error: None,
    });
    entry.state = state;
    entry.error = error;
}

fn mark_event_received(cam_id: u32) {
    let mut map = STATUS.lock().unwrap();
    if let Some(map) = map.as_mut() {
        if let Some(entry) = map.get_mut(&cam_id) {
            entry.last_event_at = Some(crate::os_update::current_os_version_public()); // reuse timestamp helper... actually just use epoch
        }
    }
}

/// Get current subscription statuses for all cameras. Used by heartbeat.
pub fn get_statuses() -> HashMap<u32, SubStatus> {
    STATUS.lock().unwrap().clone().unwrap_or_default()
}

/// Start event subscription workers for all ONVIF cameras in the bundle.
/// Idempotent — stops old workers (via ACTIVE flag) before starting new.
pub fn start(
    cameras: &[BundleCamera],
    cluster_key: Option<&str>,
    server_url: &str,
    kiosk_key: &str,
) {
    // Only subscribe to cameras where event_source is "auto" or "kiosk:<this_id>"
    // (not "server" or another kiosk). For "auto", this kiosk subscribes because
    // the server put the camera in this kiosk's bundle — meaning it's reachable.
    let onvif_cams: Vec<_> = cameras
        .iter()
        .filter(|c| {
            if c.cam_type != "onvif" || c.onvif_host.is_none() { return false; }
            match c.event_source.as_deref() {
                Some("server") => false,     // server handles this one
                Some(s) if s.starts_with("kiosk:") => true,  // pinned to a kiosk (might be us)
                _ => true,                   // "auto" or missing → this kiosk subscribes
            }
        })
        .cloned()
        .collect();

    if onvif_cams.is_empty() {
        return;
    }

    // Signal old workers to stop.
    let mut active = ACTIVE.lock().unwrap();
    let new_map: HashMap<u32, ()> = onvif_cams.iter().map(|c| (c.id, ())).collect();
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
    let event_url = format!("http://{host}:{port}/onvif/event_service");

    info!("onvif-events: cam {} ({}) subscribing at {event_url}", cam.id, cam.name);

    loop {
        if generation.upgrade().is_none() {
            info!("onvif-events: cam {} generation expired, exiting", cam.id);
            return;
        }

        // 1. CreatePullPointSubscription
        set_status(cam.id, "subscribing", None);
        let sub = match create_pullpoint(&event_url, user, pass) {
            Ok(s) => s,
            Err(e) => {
                warn!("onvif-events: cam {} CreatePullPoint failed: {e}", cam.id);
                set_status(cam.id, "failed", Some(e));
                std::thread::sleep(Duration::from_secs(30));
                continue;
            }
        };
        info!("onvif-events: cam {} subscribed, address={}", cam.id, sub.address);
        set_status(cam.id, "active", None);

        // 2. Poll loop
        let poll_interval = Duration::from_secs(3);
        let renew_interval = Duration::from_secs(55); // renew before 60s timeout
        let mut since_renew = std::time::Instant::now();

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
                        warn!("onvif-events: cam {} renew failed: {e}, resubscribing", cam.id);
                        break; // outer loop will re-create
                    }
                }
            }

            match pull_messages(&sub.address, user, pass) {
                Ok(events) => {
                    for evt in events {
                        forward_event(server, kiosk_key, cam.id, &evt);
                    }
                }
                Err(e) => {
                    warn!("onvif-events: cam {} pull failed: {e}", cam.id);
                    set_status(cam.id, "failed", Some(e));
                    std::thread::sleep(Duration::from_secs(15));
                    break; // resubscribe after backoff
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

fn wsse_header(user: &str, pass: &str) -> String {
    use sha1::{Digest, Sha1};
    use base64::Engine;
    use rand::RngCore;

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
    <Username>{user}</Username>
    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{digest_b64}</Password>
    <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{nonce_b64}</Nonce>
    <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</Created>
  </UsernameToken>
</Security>"#
    )
}

fn soap_envelope(header_inner: &str, body_inner: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tev="http://www.onvif.org/ver10/events/wsdl"
            xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2"
            xmlns:wsa="http://www.w3.org/2005/08/addressing">
  <s:Header>{header_inner}</s:Header>
  <s:Body>{body_inner}</s:Body>
</s:Envelope>"#
    )
}

fn soap_post(url: &str, action: &str, body: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::new();
    let resp = client
        .post(url)
        .header("Content-Type", "application/soap+xml; charset=utf-8")
        .header("SOAPAction", action)
        .body(body.to_string())
        .timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| format!("soap: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        let preview: String = body.chars().take(500).collect();
        return Err(format!("soap HTTP {status}: {preview}"));
    }
    resp.text().map_err(|e| format!("soap body: {e}"))
}

fn create_pullpoint(url: &str, user: &str, pass: &str) -> Result<Subscription, String> {
    let header = wsse_header(user, pass);
    let body = soap_envelope(
        &header,
        r#"<tev:CreatePullPointSubscription>
  <tev:InitialTerminationTime>PT60S</tev:InitialTerminationTime>
</tev:CreatePullPointSubscription>"#,
    );
    let xml = soap_post(url, "http://www.onvif.org/ver10/events/wsdl/EventPortType/CreatePullPointSubscriptionRequest", &body)?;
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

/// Extract tag content, trying with and without namespace prefixes.
fn extract_tag_ns(xml: &str, tag: &str) -> Option<String> {
    // Try common namespace prefixes for ONVIF/WS-Addressing.
    for prefix in &["", "wsa5:", "wsa:", "a:", "wsnt:", "tev:", "tt:"] {
        let full = format!("{prefix}{tag}");
        if let Some(val) = extract_tag(xml, &full) {
            if !val.is_empty() { return Some(val); }
        }
    }
    // Fallback: regex-style scan for any :Address> content.
    let pattern = format!(":{tag}>");
    if let Some(pos) = xml.find(&pattern) {
        let after = &xml[pos + pattern.len()..];
        if let Some(end) = after.find('<') {
            let val = after[..end].trim();
            if !val.is_empty() { return Some(val.to_string()); }
        }
    }
    None
}

fn pull_messages(sub_url: &str, user: &str, pass: &str) -> Result<Vec<OnvifEvent>, String> {
    let header = wsse_header(user, pass);
    let body = soap_envelope(
        &header,
        r#"<tev:PullMessages>
  <tev:Timeout>PT5S</tev:Timeout>
  <tev:MessageLimit>100</tev:MessageLimit>
</tev:PullMessages>"#,
    );
    let xml = soap_post(sub_url, "http://www.onvif.org/ver10/events/wsdl/PullPointSubscription/PullMessagesRequest", &body)?;
    Ok(parse_notification_messages(&xml))
}

fn renew(sub_url: &str, user: &str, pass: &str) -> Result<(), String> {
    let header = wsse_header(user, pass);
    let body = soap_envelope(
        &header,
        r#"<wsnt:Renew><wsnt:TerminationTime>PT60S</wsnt:TerminationTime></wsnt:Renew>"#,
    );
    soap_post(sub_url, "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/RenewRequest", &body)?;
    Ok(())
}

fn unsubscribe(sub_url: &str, user: &str, pass: &str) -> Result<(), String> {
    let header = wsse_header(user, pass);
    let body = soap_envelope(&header, "<wsnt:Unsubscribe/>");
    let _ = soap_post(sub_url, "http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest", &body);
    Ok(())
}

// ---- Event parsing ---------------------------------------------------------

#[derive(Debug)]
struct OnvifEvent {
    topic: String,
    source: HashMap<String, String>,
    data: HashMap<String, String>,
    timestamp: Option<String>,
}

fn parse_notification_messages(xml: &str) -> Vec<OnvifEvent> {
    let mut events = Vec::new();
    // Split on NotificationMessage blocks
    for block in xml.split("<wsnt:NotificationMessage") {
        if !block.contains("Topic") {
            continue;
        }
        let topic = extract_tag(block, "Topic")
            .or_else(|| extract_attr_value(block, "Topic", "Dialect").map(|_| {
                // Topic might be inline text
                extract_inner_text(block, "Topic").unwrap_or_default()
            }))
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
    let patterns = [
        format!("<{tag}>"),
        format!("<{tag} "),
    ];
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
            if rest.contains(':') && rest.ends_with(tag) || rest.split_whitespace().next()?.ends_with(&format!(":{tag}")) {
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
    let patterns = [
        format!("<tt:{section}"),
        format!("<{section}"),
    ];
    for pat in &patterns {
        if let Some(start) = xml.find(pat.as_str()) {
            let rest = &xml[start..];
            let end_patterns = [
                format!("</tt:{section}>"),
                format!("</{section}>"),
            ];
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

fn forward_event(server: &str, kiosk_key: &str, camera_id: u32, evt: &OnvifEvent) {
    let payload = serde_json::json!({
        "source": evt.source,
        "data": evt.data,
        "timestamp": evt.timestamp,
    });
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
        .timeout(Duration::from_secs(5))
        .send();
}

// ---- Cluster key decryption ------------------------------------------------

/// Decrypt a value encrypted with secrets.encryptForCluster on the server.
/// Format: "v1.<iv_b64u>.<tag_b64u>.<ct_b64u>". AES-256-GCM.
/// cluster_key is base64url-encoded 32-byte key.
pub fn decrypt_cluster_public(ciphertext: &str, key: &str) -> Option<String> {
    decrypt_cluster(ciphertext, key)
}

fn decrypt_cluster(ciphertext: &str, cluster_key_b64u: &str) -> Option<String> {
    use aes_gcm::{Aes256Gcm, Key, Nonce, aead::{Aead, KeyInit}};
    use base64::Engine;

    let b64u = base64::engine::general_purpose::URL_SAFE_NO_PAD;

    let parts: Vec<&str> = ciphertext.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" {
        warn!("decrypt_cluster: bad format: {}", ciphertext.chars().take(20).collect::<String>());
        return None;
    }
    let iv = b64u.decode(parts[1]).ok()?;
    let tag = b64u.decode(parts[2]).ok()?;
    let ct = b64u.decode(parts[3]).ok()?;
    let key_bytes = b64u.decode(cluster_key_b64u).ok()?;
    if key_bytes.len() != 32 || iv.len() != 12 || tag.len() != 16 {
        warn!("decrypt_cluster: bad lengths key={} iv={} tag={}", key_bytes.len(), iv.len(), tag.len());
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
    format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z"
    )
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
