use std::time::Duration;

use base64::Engine;
use reqwest::blocking::{Client, RequestBuilder};
use serde::Serialize;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};

use crate::bundle::{BundleCamera, KioskBundle};

#[derive(Debug, Clone, Serialize)]
pub struct OnvifActionError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone)]
struct Services {
    media_url: String,
    ptz_url: Option<String>,
    imaging_url: Option<String>,
    device_io_url: Option<String>,
}

#[derive(Debug, Clone)]
struct ProfileSummary {
    token: String,
    name: Option<String>,
    ptz_configuration_token: Option<String>,
}

fn action_error(code: &str, message: impl Into<String>) -> OnvifActionError {
    OnvifActionError {
        code: code.to_string(),
        message: message.into(),
        details: None,
    }
}

fn action_error_with_details(
    code: &str,
    message: impl Into<String>,
    details: Value,
) -> OnvifActionError {
    OnvifActionError {
        code: code.to_string(),
        message: message.into(),
        details: Some(details),
    }
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn preview_xml(xml: &str) -> String {
    xml.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}

fn wsse_header(username: &str, password: &str) -> String {
    use rand::RngCore;
    let mut nonce_raw = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut nonce_raw);
    let nonce_b64 = base64::engine::general_purpose::STANDARD.encode(nonce_raw);
    let created = chrono_like_now();
    let mut hasher = Sha1::new();
    hasher.update(nonce_raw);
    hasher.update(created.as_bytes());
    hasher.update(password.as_bytes());
    let digest_b64 = base64::engine::general_purpose::STANDARD.encode(hasher.finalize());
    format!(
        r#"<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <UsernameToken>
    <Username>{}</Username>
    <Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">{}</Password>
    <Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">{}</Nonce>
    <Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{}</Created>
  </UsernameToken>
</Security>"#,
        escape_xml(username),
        digest_b64,
        nonce_b64,
        created
    )
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let nanos = now.subsec_nanos();
    let datetime = time::OffsetDateTime::from_unix_timestamp(secs)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
        .replace_nanosecond(nanos)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    datetime
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn soap_envelope(extra_namespaces: &str, header_xml: &str, body_xml: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema"
  {extra_namespaces}>
  <s:Header>{header_xml}</s:Header>
  <s:Body>{body_xml}</s:Body>
</s:Envelope>"#
    )
}

fn extract_tag(xml: &str, open: &str, close: &str) -> Option<String> {
    let start = xml.find(open)?;
    let after = &xml[start + open.len()..];
    let end = after.find(close)?;
    Some(after[..end].trim().to_string())
}

fn extract_tag_ns(xml: &str, tag: &str) -> Option<String> {
    for prefix in [
        "", "tt:", "trt:", "tptz:", "timg:", "tev:", "tds:", "wsa:", "wsa5:", "a:",
    ] {
        let open = format!("<{prefix}{tag}>");
        let close = format!("</{prefix}{tag}>");
        if let Some(val) = extract_tag(xml, &open, &close) {
            if !val.is_empty() {
                return Some(val);
            }
        }
    }
    None
}

fn extract_attr(xml: &str, tag_local_name: &str, attr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    loop {
        let Some(idx) = rest.find(&format!("{tag_local_name}")) else {
            break;
        };
        let candidate = &rest[idx..];
        let Some(end) = candidate.find('>') else {
            break;
        };
        let tag = &candidate[..end];
        if let Some(attr_idx) = tag.find(&format!(r#"{attr}=""#)) {
            let value_start = attr_idx + attr.len() + 2;
            if let Some(value_end) = tag[value_start..].find('"') {
                out.push(tag[value_start..value_start + value_end].to_string());
            }
        }
        rest = &candidate[end + 1..];
    }
    out
}

fn extract_section(xml: &str, tag: &str) -> Option<String> {
    for prefix in ["", "tds:", "trt:", "tt:", "tptz:", "timg:"] {
        let open = format!("<{prefix}{tag}");
        if let Some(start) = xml.find(&open) {
            let after = &xml[start..];
            let close = format!("</{prefix}{tag}>");
            if let Some(end) = after.find(&close) {
                return Some(after[..end + close.len()].to_string());
            }
        }
    }
    None
}

fn extract_first_xaddr(xml: &str, tag: &str) -> Option<String> {
    let section = extract_section(xml, tag)?;
    extract_tag_ns(&section, "XAddr")
}

fn split_profile_blocks(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<trt:Profiles") {
        let after = &rest[start..];
        let Some(tag_end) = after.find('>') else {
            break;
        };
        let content = &after[tag_end + 1..];
        let close_plain = "</Profiles>";
        let close_ns = "</trt:Profiles>";
        let end = content.find(close_ns).or_else(|| content.find(close_plain));
        let Some(end) = end else { break };
        out.push(content[..end].to_string());
        let close_len = if content[end..].starts_with(close_ns) {
            close_ns.len()
        } else {
            close_plain.len()
        };
        rest = &content[end + close_len..];
    }
    out
}

fn extract_preset_blocks(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    for prefix in ["tptz:", ""] {
        let open_tag = format!("<{prefix}Preset ");
        let close_tag = format!("</{prefix}Preset>");
        rest = xml;
        while let Some(start) = rest.find(&open_tag) {
            let after = &rest[start..];
            if let Some(end) = after.find(&close_tag) {
                out.push(after[..end + close_tag.len()].to_string());
                rest = &after[end + close_tag.len()..];
            } else {
                break;
            }
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

fn read_string(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)?
        .as_str()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn read_number(params: &Value, key: &str) -> Option<f64> {
    params.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    })
}

fn read_bool(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) if s == "true" || s == "1" => Some(true),
        Value::String(s) if s == "false" || s == "0" => Some(false),
        _ => None,
    })
}

fn parse_digest_challenge(header: &str) -> Option<std::collections::HashMap<String, String>> {
    if !header.to_lowercase().starts_with("digest ") {
        return None;
    }
    let mut values = std::collections::HashMap::new();
    for part in header[7..].split(',') {
        let mut bits = part.splitn(2, '=');
        let Some(key) = bits.next().map(|v| v.trim().to_lowercase()) else {
            continue;
        };
        let Some(value) = bits.next() else { continue };
        values.insert(key, value.trim().trim_matches('"').to_string());
    }
    Some(values)
}

fn md5_hex(input: &str) -> String {
    format!("{:x}", md5::compute(input))
}

fn digest_auth_header_for(
    method: &str,
    url: &str,
    challenge_header: &str,
    user: &str,
    pass: &str,
) -> Option<String> {
    use rand::RngCore;

    let params = parse_digest_challenge(challenge_header)?;
    let realm = params.get("realm")?;
    let nonce = params.get("nonce")?;
    let parsed = url::Url::parse(url).ok()?;
    let uri = format!(
        "{}{}",
        parsed.path(),
        parsed.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    let qop = params
        .get("qop")
        .map(|v| {
            v.split(',')
                .map(|s| s.trim().to_string())
                .find(|s| s == "auth")
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let mut cnonce_bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut cnonce_bytes);
    let cnonce = hex::encode(cnonce_bytes);
    let nc = "00000001";
    let ha1 = md5_hex(&format!("{user}:{realm}:{pass}"));
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let response = if qop.is_empty() {
        md5_hex(&format!("{ha1}:{nonce}:{ha2}"))
    } else {
        md5_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}"))
    };
    let mut parts = vec![
        format!(r#"Digest username="{user}""#),
        format!(r#"realm="{realm}""#),
        format!(r#"nonce="{nonce}""#),
        format!(r#"uri="{uri}""#),
        format!(r#"response="{response}""#),
    ];
    if let Some(opaque) = params.get("opaque") {
        parts.push(format!(r#"opaque="{opaque}""#));
    }
    if let Some(algorithm) = params.get("algorithm") {
        parts.push(format!("algorithm={algorithm}"));
    }
    if !qop.is_empty() {
        parts.push(format!("qop={qop}"));
        parts.push(format!("nc={nc}"));
        parts.push(format!(r#"cnonce="{cnonce}""#));
    }
    Some(parts.join(", "))
}

fn is_soap_fault(xml: &str) -> bool {
    xml.contains(":Fault") || xml.contains("<Fault")
}

fn extract_soap_fault(xml: &str) -> String {
    for tag in [
        "Text",
        "faultstring",
        "Reason",
        "Subcode",
        "Value",
        "Detail",
    ] {
        if let Some(value) = extract_tag_ns(xml, tag) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return trimmed.chars().take(300).collect();
            }
        }
    }
    preview_xml(xml)
}

fn build_request(client: &Client, url: &str, action: &str, body: &str) -> RequestBuilder {
    client
        .post(url)
        .header(
            "Content-Type",
            format!(r#"application/soap+xml; charset=utf-8; action="{action}""#),
        )
        .header("SOAPAction", action)
        .body(body.to_string())
}

fn soap_post_with_fallback(
    url: &str,
    action: &str,
    body: &str,
    username: &str,
    password: &str,
    timeout_ms: u64,
) -> Result<String, OnvifActionError> {
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout_ms.clamp(1000, 30000)))
        .build()
        .map_err(|err| {
            action_error(
                "camera_unreachable",
                format!("ONVIF client init failed: {err}"),
            )
        })?;

    let basic = if username.is_empty() {
        None
    } else {
        Some(format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"))
        ))
    };

    let mut digest_challenge: Option<String> = None;
    let mut last_error = action_error("camera_unreachable", "unknown ONVIF failure");

    for (kind, auth_header) in [("wsse", None), ("basic", basic.as_deref())] {
        if kind == "basic" && auth_header.is_none() {
            continue;
        }
        let mut request = build_request(&client, url, action, body);
        if let Some(auth) = auth_header {
            request = request.header("Authorization", auth);
        }
        match request.send() {
            Ok(response) => {
                if digest_challenge.is_none() {
                    digest_challenge = response
                        .headers()
                        .get("www-authenticate")
                        .and_then(|v| v.to_str().ok())
                        .map(|v| v.to_string());
                }
                let status = response.status();
                let text = response.text().unwrap_or_default();
                if status.is_success() && !is_soap_fault(&text) {
                    return Ok(text);
                }
                let message = if is_soap_fault(&text) {
                    format!(
                        "ONVIF {action} SOAP fault ({kind}): {}",
                        extract_soap_fault(&text)
                    )
                } else {
                    format!(
                        "ONVIF {action} HTTP {} ({kind}): {}",
                        status.as_u16(),
                        preview_xml(&text)
                    )
                };
                last_error = if is_soap_fault(&text) {
                    action_error_with_details(
                        "soap_fault",
                        message,
                        json!({ "responsePreview": preview_xml(&text) }),
                    )
                } else if status.as_u16() == 401 {
                    action_error("auth_failed", message)
                } else {
                    action_error_with_details(
                        "camera_unreachable",
                        message,
                        json!({ "responsePreview": preview_xml(&text) }),
                    )
                };
            }
            Err(err) => {
                last_error = if err.is_timeout() {
                    action_error(
                        "timeout",
                        format!("ONVIF {action} timed out after {timeout_ms}ms"),
                    )
                } else {
                    action_error(
                        "camera_unreachable",
                        format!("ONVIF request failed ({kind}): {err}"),
                    )
                };
            }
        }
    }

    if !username.is_empty() {
        if let Some(challenge) = digest_challenge.as_deref() {
            if let Some(auth) = digest_auth_header_for("POST", url, challenge, username, password) {
                match build_request(&client, url, action, body)
                    .header("Authorization", auth)
                    .send()
                {
                    Ok(response) => {
                        let status = response.status();
                        let text = response.text().unwrap_or_default();
                        if status.is_success() && !is_soap_fault(&text) {
                            return Ok(text);
                        }
                        let message = if is_soap_fault(&text) {
                            format!(
                                "ONVIF {action} SOAP fault (digest): {}",
                                extract_soap_fault(&text)
                            )
                        } else {
                            format!(
                                "ONVIF {action} HTTP {} (digest): {}",
                                status.as_u16(),
                                preview_xml(&text)
                            )
                        };
                        last_error = if is_soap_fault(&text) {
                            action_error_with_details(
                                "soap_fault",
                                message,
                                json!({ "responsePreview": preview_xml(&text) }),
                            )
                        } else {
                            action_error_with_details(
                                "camera_unreachable",
                                message,
                                json!({ "responsePreview": preview_xml(&text) }),
                            )
                        };
                    }
                    Err(err) => {
                        last_error = if err.is_timeout() {
                            action_error(
                                "timeout",
                                format!("ONVIF {action} timed out after {timeout_ms}ms"),
                            )
                        } else {
                            action_error(
                                "camera_unreachable",
                                format!("ONVIF request failed (digest): {err}"),
                            )
                        };
                    }
                }
            }
        }
    }

    Err(last_error)
}

fn resolve_services(
    cam: &BundleCamera,
    password: &str,
    timeout_ms: u64,
) -> Result<Services, OnvifActionError> {
    let host = cam
        .onvif_host
        .as_deref()
        .ok_or_else(|| action_error("invalid_params", "camera missing ONVIF host"))?;
    let port = cam.onvif_port.unwrap_or(80);
    let origin = format!("http://{host}:{port}");
    let device_url = format!("{origin}/onvif/device_service");
    let header = wsse_header(cam.onvif_username.as_deref().unwrap_or(""), password);
    let envelope = soap_envelope(
        r#"xmlns:tds="http://www.onvif.org/ver10/device/wsdl""#,
        &header,
        r#"<tds:GetCapabilities><tds:Category>All</tds:Category></tds:GetCapabilities>"#,
    );
    match soap_post_with_fallback(
        &device_url,
        "http://www.onvif.org/ver10/device/wsdl/GetCapabilities",
        &envelope,
        cam.onvif_username.as_deref().unwrap_or(""),
        password,
        timeout_ms,
    ) {
        Ok(xml) => Ok(Services {
            media_url: extract_first_xaddr(&xml, "Media")
                .unwrap_or_else(|| format!("{origin}/onvif/media_service")),
            ptz_url: extract_first_xaddr(&xml, "PTZ"),
            imaging_url: extract_first_xaddr(&xml, "Imaging"),
            device_io_url: extract_first_xaddr(&xml, "DeviceIO"),
        }),
        Err(e) => {
            tracing::warn!(
                "GetCapabilities failed, falling back to well-known paths: {}",
                e.message.chars().take(120).collect::<String>()
            );
            Ok(Services {
                media_url: format!("{origin}/onvif/media_service"),
                ptz_url: Some(format!("{origin}/onvif/PTZ")),
                imaging_url: Some(format!("{origin}/onvif/imaging_service")),
                device_io_url: None,
            })
        }
    }
}

fn get_profiles(
    cam: &BundleCamera,
    password: &str,
    timeout_ms: u64,
    media_url: &str,
) -> Result<Vec<ProfileSummary>, OnvifActionError> {
    let xml = soap_post_with_fallback(
        media_url,
        "http://www.onvif.org/ver10/media/wsdl/GetProfiles",
        &soap_envelope(
            "",
            &wsse_header(cam.onvif_username.as_deref().unwrap_or(""), password),
            "<trt:GetProfiles/>",
        ),
        cam.onvif_username.as_deref().unwrap_or(""),
        password,
        timeout_ms,
    )?;
    let tokens = extract_attr(&xml, "Profiles", "token");
    let blocks = split_profile_blocks(&xml);
    Ok(blocks
        .into_iter()
        .enumerate()
        .filter_map(|(idx, block)| {
            let token = tokens.get(idx)?.to_string();
            Some(ProfileSummary {
                token,
                name: extract_tag_ns(&block, "Name"),
                ptz_configuration_token: extract_attr(&block, "PTZConfiguration", "token")
                    .first()
                    .cloned(),
            })
        })
        .collect())
}

fn require_profile_token(
    action: &str,
    params: &Value,
    profiles: &[ProfileSummary],
) -> Result<String, OnvifActionError> {
    if let Some(token) = read_string(params, "profileToken") {
        return Ok(token);
    }
    if profiles.len() == 1 {
        return Ok(profiles[0].token.clone());
    }
    Err(action_error_with_details(
        "invalid_params",
        format!("{action} requires profileToken when multiple profiles exist"),
        json!({ "availableProfileTokens": profiles.iter().map(|p| p.token.clone()).collect::<Vec<_>>() }),
    ))
}

fn require_ptz_configuration_token(
    profile_token: &str,
    profiles: &[ProfileSummary],
) -> Result<String, OnvifActionError> {
    profiles
        .iter()
        .find(|profile| profile.token == profile_token)
        .and_then(|profile| profile.ptz_configuration_token.clone())
        .ok_or_else(|| {
            action_error(
                "unsupported_capability",
                format!("Profile {profile_token} does not expose PTZ configuration"),
            )
        })
}

fn action_result(action: &str, xml: &str, data: Value) -> Value {
    json!({
        "status": "ok",
        "action": action,
        "data": data,
        "rawXml": preview_xml(xml),
    })
}

pub fn execute_bundle_action(
    bundle: &KioskBundle,
    camera_id: &str,
    action: &str,
    params: &Value,
    timeout_ms: u64,
) -> Result<Value, OnvifActionError> {
    let Some(cam) = bundle.cameras.iter().find(|camera| camera.id == camera_id) else {
        return Err(action_error("camera_not_in_bundle", "camera not in bundle"));
    };
    let decrypt_key =
        crate::server::load_encrypt_key().or_else(|| crate::server::load_cluster_key());
    let password = match (&cam.onvif_password_encrypted, decrypt_key.as_deref()) {
        (Some(enc), Some(key)) => crate::onvif_events::decrypt_cluster_public(enc, key),
        _ => None,
    }
    .unwrap_or_default();
    execute_camera_action(cam, &password, action, params, timeout_ms)
}

pub fn execute_camera_action(
    cam: &BundleCamera,
    password: &str,
    action: &str,
    params: &Value,
    timeout_ms: u64,
) -> Result<Value, OnvifActionError> {
    let services = resolve_services(cam, password, timeout_ms)?;
    let username = cam.onvif_username.as_deref().unwrap_or("");
    let header = wsse_header(username, password);

    let needs_profiles = matches!(
        action,
        "ptz.get_status"
            | "ptz.get_configuration_options"
            | "ptz.continuous_move"
            | "ptz.relative_move"
            | "ptz.absolute_move"
            | "ptz.stop"
            | "ptz.get_presets"
            | "ptz.goto_preset"
            | "ptz.set_preset"
            | "ptz.remove_preset"
            | "ptz.goto_home"
            | "ptz.set_home"
            | "ptz.send_auxiliary_command"
            | "media.get_profiles"
            | "media.get_stream_uri"
            | "media.get_snapshot_uri"
    );

    let bundle_profiles: Vec<ProfileSummary> = cam
        .streams
        .iter()
        .filter_map(|s| {
            Some(ProfileSummary {
                token: s.profile_token.clone()?,
                name: Some(s.name.clone()),
                ptz_configuration_token: None,
            })
        })
        .collect();

    let profiles = if needs_profiles {
        if !bundle_profiles.is_empty() && action != "media.get_profiles" {
            bundle_profiles
        } else {
            get_profiles(cam, password, timeout_ms, &services.media_url)?
        }
    } else {
        Vec::new()
    };

    match action {
        "media.get_profiles" => Ok(json!({
            "status": "ok",
            "action": action,
            "data": {
                "profiles": profiles.iter().map(|profile| json!({
                    "token": profile.token,
                    "name": profile.name,
                    "ptzConfigurationToken": profile.ptz_configuration_token,
                })).collect::<Vec<_>>(),
            },
        })),
        "media.get_stream_uri" | "media.get_snapshot_uri" => {
            let profile_token = require_profile_token(action, params, &profiles)?;
            let (soap_action, body) = if action == "media.get_stream_uri" {
                (
                    "http://www.onvif.org/ver10/media/wsdl/GetStreamUri",
                    format!(
                        r#"<trt:GetStreamUri>
  <trt:StreamSetup>
    <tt:Stream>RTP-Unicast</tt:Stream>
    <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
  </trt:StreamSetup>
  <trt:ProfileToken>{}</trt:ProfileToken>
</trt:GetStreamUri>"#,
                        escape_xml(&profile_token)
                    ),
                )
            } else {
                (
                    "http://www.onvif.org/ver10/media/wsdl/GetSnapshotUri",
                    format!(
                        "<trt:GetSnapshotUri><trt:ProfileToken>{}</trt:ProfileToken></trt:GetSnapshotUri>",
                        escape_xml(&profile_token)
                    ),
                )
            };
            let xml = soap_post_with_fallback(
                &services.media_url,
                soap_action,
                &soap_envelope("", &header, &body),
                username,
                password,
                timeout_ms,
            )?;
            Ok(action_result(
                action,
                &xml,
                json!({
                    "profileToken": profile_token,
                    "uri": extract_tag_ns(&xml, "Uri"),
                }),
            ))
        }
        "ptz.get_nodes" => {
            let ptz_url = services.ptz_url.ok_or_else(|| {
                action_error(
                    "unsupported_capability",
                    "PTZ is not supported by this device",
                )
            })?;
            let xml = soap_post_with_fallback(
                &ptz_url,
                "http://www.onvif.org/ver20/ptz/wsdl/GetNodes",
                &soap_envelope(
                    r#"xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl""#,
                    &header,
                    "<tptz:GetNodes/>",
                ),
                username,
                password,
                timeout_ms,
            )?;
            Ok(action_result(
                action,
                &xml,
                json!({
                    "nodes": extract_attr(&xml, "PTZNode", "token"),
                }),
            ))
        }
        action if action.starts_with("ptz.") => {
            let ptz_url = services.ptz_url.ok_or_else(|| {
                action_error(
                    "unsupported_capability",
                    "PTZ is not supported by this device",
                )
            })?;
            let profile_token = require_profile_token(action, params, &profiles)?;
            let timeout =
                read_number(params, "timeoutMs").map(|ms| format!("PT{}S", (ms.max(1.0) / 1000.0)));
            let soap_action;
            let body = match action {
                "ptz.get_status" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/GetStatus";
                    format!(
                        "<tptz:GetStatus><tptz:ProfileToken>{}</tptz:ProfileToken></tptz:GetStatus>",
                        escape_xml(&profile_token)
                    )
                }
                "ptz.get_configuration_options" => {
                    let cfg = require_ptz_configuration_token(&profile_token, &profiles)?;
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/GetConfigurationOptions";
                    format!(
                        "<tptz:GetConfigurationOptions><tptz:ConfigurationToken>{}</tptz:ConfigurationToken></tptz:GetConfigurationOptions>",
                        escape_xml(&cfg)
                    )
                }
                "ptz.continuous_move" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/ContinuousMove";
                    format!(
                        r#"<tptz:ContinuousMove>
  <tptz:ProfileToken>{}</tptz:ProfileToken>
  <tptz:Velocity>
    <tt:PanTilt x="{}" y="{}"/>
    <tt:Zoom x="{}"/>
  </tptz:Velocity>
  {}
</tptz:ContinuousMove>"#,
                        escape_xml(&profile_token),
                        read_number(params, "pan").unwrap_or(0.0),
                        read_number(params, "tilt").unwrap_or(0.0),
                        read_number(params, "zoom").unwrap_or(0.0),
                        timeout
                            .map(|v| format!("<tptz:Timeout>{}</tptz:Timeout>", escape_xml(&v)))
                            .unwrap_or_default(),
                    )
                }
                "ptz.relative_move" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/RelativeMove";
                    format!(
                        r#"<tptz:RelativeMove>
  <tptz:ProfileToken>{}</tptz:ProfileToken>
  <tptz:Translation>
    <tt:PanTilt x="{}" y="{}"/>
    <tt:Zoom x="{}"/>
  </tptz:Translation>
  <tptz:Speed>
    <tt:PanTilt x="{}" y="{}"/>
    <tt:Zoom x="{}"/>
  </tptz:Speed>
</tptz:RelativeMove>"#,
                        escape_xml(&profile_token),
                        read_number(params, "x").unwrap_or(0.0),
                        read_number(params, "y").unwrap_or(0.0),
                        read_number(params, "z").unwrap_or(0.0),
                        read_number(params, "pan").unwrap_or(0.0),
                        read_number(params, "tilt").unwrap_or(0.0),
                        read_number(params, "zoom").unwrap_or(0.0),
                    )
                }
                "ptz.absolute_move" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/AbsoluteMove";
                    format!(
                        r#"<tptz:AbsoluteMove>
  <tptz:ProfileToken>{}</tptz:ProfileToken>
  <tptz:Position>
    <tt:PanTilt x="{}" y="{}"/>
    <tt:Zoom x="{}"/>
  </tptz:Position>
  <tptz:Speed>
    <tt:PanTilt x="{}" y="{}"/>
    <tt:Zoom x="{}"/>
  </tptz:Speed>
</tptz:AbsoluteMove>"#,
                        escape_xml(&profile_token),
                        read_number(params, "x").unwrap_or(0.0),
                        read_number(params, "y").unwrap_or(0.0),
                        read_number(params, "z").unwrap_or(0.0),
                        read_number(params, "pan").unwrap_or(0.0),
                        read_number(params, "tilt").unwrap_or(0.0),
                        read_number(params, "zoom").unwrap_or(0.0),
                    )
                }
                "ptz.stop" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/Stop";
                    format!(
                        "<tptz:Stop><tptz:ProfileToken>{}</tptz:ProfileToken><tptz:PanTilt>{}</tptz:PanTilt><tptz:Zoom>{}</tptz:Zoom></tptz:Stop>",
                        escape_xml(&profile_token),
                        read_bool(params, "panTilt").unwrap_or(true),
                        read_bool(params, "zoom").unwrap_or(true),
                    )
                }
                "ptz.get_presets" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/GetPresets";
                    format!(
                        "<tptz:GetPresets><tptz:ProfileToken>{}</tptz:ProfileToken></tptz:GetPresets>",
                        escape_xml(&profile_token)
                    )
                }
                "ptz.goto_preset" => {
                    let preset = read_string(params, "presetToken").ok_or_else(|| {
                        action_error("invalid_params", "ptz.goto_preset requires presetToken")
                    })?;
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/GotoPreset";
                    format!(
                        "<tptz:GotoPreset><tptz:ProfileToken>{}</tptz:ProfileToken><tptz:PresetToken>{}</tptz:PresetToken></tptz:GotoPreset>",
                        escape_xml(&profile_token),
                        escape_xml(&preset)
                    )
                }
                "ptz.set_preset" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/SetPreset";
                    let name = read_string(params, "presetName");
                    let token = read_string(params, "presetToken");
                    format!(
                        "<tptz:SetPreset><tptz:ProfileToken>{}</tptz:ProfileToken>{}{}</tptz:SetPreset>",
                        escape_xml(&profile_token),
                        name.map(|v| format!(
                            "<tptz:PresetName>{}</tptz:PresetName>",
                            escape_xml(&v)
                        ))
                        .unwrap_or_default(),
                        token
                            .map(|v| format!(
                                "<tptz:PresetToken>{}</tptz:PresetToken>",
                                escape_xml(&v)
                            ))
                            .unwrap_or_default(),
                    )
                }
                "ptz.remove_preset" => {
                    let preset = read_string(params, "presetToken").ok_or_else(|| {
                        action_error("invalid_params", "ptz.remove_preset requires presetToken")
                    })?;
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/RemovePreset";
                    format!(
                        "<tptz:RemovePreset><tptz:ProfileToken>{}</tptz:ProfileToken><tptz:PresetToken>{}</tptz:PresetToken></tptz:RemovePreset>",
                        escape_xml(&profile_token),
                        escape_xml(&preset)
                    )
                }
                "ptz.goto_home" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/GotoHomePosition";
                    format!(
                        "<tptz:GotoHomePosition><tptz:ProfileToken>{}</tptz:ProfileToken></tptz:GotoHomePosition>",
                        escape_xml(&profile_token)
                    )
                }
                "ptz.set_home" => {
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/SetHomePosition";
                    format!(
                        "<tptz:SetHomePosition><tptz:ProfileToken>{}</tptz:ProfileToken></tptz:SetHomePosition>",
                        escape_xml(&profile_token)
                    )
                }
                "ptz.send_auxiliary_command" => {
                    let aux = read_string(params, "auxiliaryData").ok_or_else(|| {
                        action_error(
                            "invalid_params",
                            "ptz.send_auxiliary_command requires auxiliaryData",
                        )
                    })?;
                    soap_action = "http://www.onvif.org/ver20/ptz/wsdl/SendAuxiliaryCommand";
                    format!(
                        "<tptz:SendAuxiliaryCommand><tptz:ProfileToken>{}</tptz:ProfileToken><tptz:AuxiliaryData>{}</tptz:AuxiliaryData></tptz:SendAuxiliaryCommand>",
                        escape_xml(&profile_token),
                        escape_xml(&aux)
                    )
                }
                _ => {
                    return Err(action_error(
                        "unsupported_action",
                        format!("unsupported ONVIF action: {action}"),
                    ));
                }
            };
            let xml = soap_post_with_fallback(
                &ptz_url,
                soap_action,
                &soap_envelope(
                    r#"xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl""#,
                    &header,
                    &body,
                ),
                username,
                password,
                timeout_ms,
            )?;
            let data = if action == "ptz.get_status" {
                json!({
                    "profileToken": profile_token,
                    "pan": extract_attr(&xml, "PanTilt", "x").first().cloned(),
                    "tilt": extract_attr(&xml, "PanTilt", "y").first().cloned(),
                    "zoom": extract_attr(&xml, "Zoom", "x").first().cloned(),
                })
            } else if action == "ptz.get_presets" {
                let tokens = extract_attr(&xml, "Preset", "token");
                let names: Vec<Option<String>> = extract_preset_blocks(&xml)
                    .iter()
                    .map(|block| extract_tag_ns(block, "Name"))
                    .collect();
                let presets: Vec<Value> = tokens
                    .into_iter()
                    .enumerate()
                    .map(|(i, token)| {
                        json!({
                            "token": token,
                            "name": names.get(i).and_then(|n| n.clone()),
                        })
                    })
                    .collect();
                json!({
                    "profileToken": profile_token,
                    "presets": presets,
                })
            } else {
                json!({ "profileToken": profile_token })
            };
            Ok(action_result(action, &xml, data))
        }
        "deviceio.set_relay_output_state" => {
            let device_url = services.device_io_url.ok_or_else(|| {
                action_error(
                    "unsupported_capability",
                    "DeviceIO is not supported by this device",
                )
            })?;
            let relay = read_string(params, "relayToken")
                .ok_or_else(|| action_error("invalid_params", "relayToken is required"))?;
            let state = read_string(params, "logicalState")
                .ok_or_else(|| action_error("invalid_params", "logicalState is required"))?;
            let xml = soap_post_with_fallback(
                &device_url,
                "http://www.onvif.org/ver10/deviceIO/wsdl/SetRelayOutputState",
                &soap_envelope(
                    r#"xmlns:tmd="http://www.onvif.org/ver10/deviceIO/wsdl""#,
                    &header,
                    &format!(
                        "<tmd:SetRelayOutputState><tmd:RelayOutputToken>{}</tmd:RelayOutputToken><tmd:LogicalState>{}</tmd:LogicalState></tmd:SetRelayOutputState>",
                        escape_xml(&relay),
                        escape_xml(&state)
                    ),
                ),
                username,
                password,
                timeout_ms,
            )?;
            Ok(action_result(
                action,
                &xml,
                json!({ "relayToken": relay, "logicalState": state }),
            ))
        }
        "imaging.get_settings" | "imaging.get_options" => {
            let imaging_url = services.imaging_url.ok_or_else(|| {
                action_error(
                    "unsupported_capability",
                    "Imaging is not supported by this device",
                )
            })?;
            let token = read_string(params, "videoSourceToken").ok_or_else(|| {
                action_error(
                    "invalid_params",
                    format!("{action} requires videoSourceToken"),
                )
            })?;
            let soap_action = if action == "imaging.get_settings" {
                "http://www.onvif.org/ver20/imaging/wsdl/GetImagingSettings"
            } else {
                "http://www.onvif.org/ver20/imaging/wsdl/GetOptions"
            };
            let body = if action == "imaging.get_settings" {
                format!(
                    "<timg:GetImagingSettings><timg:VideoSourceToken>{}</timg:VideoSourceToken></timg:GetImagingSettings>",
                    escape_xml(&token)
                )
            } else {
                format!(
                    "<timg:GetOptions><timg:VideoSourceToken>{}</timg:VideoSourceToken></timg:GetOptions>",
                    escape_xml(&token)
                )
            };
            let xml = soap_post_with_fallback(
                &imaging_url,
                soap_action,
                &soap_envelope(
                    r#"xmlns:timg="http://www.onvif.org/ver20/imaging/wsdl""#,
                    &header,
                    &body,
                ),
                username,
                password,
                timeout_ms,
            )?;
            Ok(action_result(
                action,
                &xml,
                json!({ "videoSourceToken": token }),
            ))
        }
        _ => Err(action_error(
            "unsupported_action",
            format!("unsupported ONVIF action: {action}"),
        )),
    }
}
