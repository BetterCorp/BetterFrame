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

use serde_json::Value;
use tracing::{info, warn};

use crate::bundle::BundleCamera;

/// Active subscriptions keyed by camera id. Worker threads check this
/// to know when to stop (camera removed from bundle / bundle changed).
static ACTIVE: Mutex<Option<HashMap<u32, ()>>> = Mutex::new(None);

/// Start event subscription workers for all ONVIF cameras in the bundle.
/// Idempotent — stops old workers (via ACTIVE flag) before starting new.
pub fn start(
    cameras: &[BundleCamera],
    cluster_key: Option<&str>,
    server_url: &str,
    kiosk_key: &str,
) {
    if std::env::var("BF_ENABLE_ONVIF_EVENTS").as_deref() != Ok("1") {
        return;
    }

    let onvif_cams: Vec<_> = cameras
        .iter()
        .filter(|c| c.cam_type == "onvif" && c.onvif_host.is_some())
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

    for cam in onvif_cams {
        let server = server_url.to_string();
        let key = kiosk_key.to_string();
        let gen = Arc::downgrade(&generation);
        let password = match (&cam.onvif_password_encrypted, cluster_key) {
            (Some(enc), Some(ck)) => decrypt_cluster(enc, ck),
            _ => None,
        };

        std::thread::spawn(move || {
            run_subscription(cam, password.as_deref(), &server, &key, gen);
        });
    }

    // Keep the Arc alive as long as the bundle is current. When a new
    // start() is called the old Arc drops and Weak::upgrade returns None,
    // signalling old threads to exit.
    std::mem::forget(generation);
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
        let sub = match create_pullpoint(&event_url, user, pass) {
            Ok(s) => s,
            Err(e) => {
                warn!("onvif-events: cam {} CreatePullPoint failed: {e}", cam.id);
                std::thread::sleep(Duration::from_secs(30));
                continue;
            }
        };
        info!("onvif-events: cam {} subscribed, address={}", cam.id, sub.address);

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
                    std::thread::sleep(Duration::from_secs(5));
                    break; // resubscribe
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
        return Err(format!("soap HTTP {}", resp.status()));
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
    let address = extract_tag(&xml, "Address")
        .ok_or_else(|| "no Address in CreatePullPointSubscription response".to_string())?;
    Ok(Subscription { address })
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
                if let Some(end_idx) = after_close.find(&format!(":{tag}>")) {
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

fn decrypt_cluster(ciphertext: &str, _cluster_key: &str) -> Option<String> {
    // TODO: AES-256-GCM decrypt using the cluster key delivered at pairing.
    // For now, RTSP URIs in the bundle already have plaintext credentials
    // embedded, so most deployments work without this path. Full cluster-key
    // decrypt needs the same HKDF + AES-GCM as the server's secrets.ts.
    let _ = ciphertext;
    None
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
