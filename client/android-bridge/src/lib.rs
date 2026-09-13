//! Stateless JNI boundary. Never log inputs: bundles, URLs and plans contain secrets.
use betterframe_client_core::{android, bundle::KioskBundle, protocol};
use jni::{
    JNIEnv,
    objects::{JObject, JString},
    sys::jstring,
};

pub fn render_plan_json(bundle: &str, layout: Option<&str>, expanded: Option<&str>) -> String {
    let result = serde_json::from_str::<KioskBundle>(bundle)
        .map_err(|_| "Invalid display configuration")
        .and_then(|bundle| android::render_plan(&bundle, layout, expanded));
    match result {
        Ok(plan) => serde_json::to_string(&plan)
            .unwrap_or_else(|_| r#"{"error":"Unable to render configuration"}"#.into()),
        Err(error) => serde_json::json!({"error":error}).to_string(),
    }
}

/// The wire format is shared with the desktop clients: v1.iv.tag.ciphertext,
/// with unpadded base64url values and an AES-256-GCM device encryption key.
pub fn camera_uri(
    uri: &str,
    username: Option<&str>,
    encrypted: Option<&str>,
    key: Option<&str>,
) -> Option<String> {
    let mut url = url::Url::parse(uri).ok()?;
    if url.scheme() != "rtsp" || url.host_str().is_none() {
        return None;
    }
    if let Some(username) = username.filter(|s| !s.is_empty()) {
        url.set_username(username).ok()?;
        if let Some(encrypted) = encrypted {
            url.set_password(Some(&decrypt_password(encrypted, key?)?))
                .ok()?;
        }
    } else if encrypted.is_some() {
        // Never discard an encrypted password if its username was lost.
        return None;
    }
    Some(url.into())
}
fn decrypt_password(ciphertext: &str, key: &str) -> Option<String> {
    use aes_gcm::{
        Aes256Gcm, Nonce,
        aead::{Aead, KeyInit},
    };
    use base64::Engine;
    let parts: Vec<_> = ciphertext.split('.').collect();
    if parts.len() != 4 || parts[0] != "v1" {
        return None;
    }
    let codec = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let iv = codec.decode(parts[1]).ok()?;
    let tag = codec.decode(parts[2]).ok()?;
    let mut encrypted = codec.decode(parts[3]).ok()?;
    let key = codec.decode(key).ok()?;
    if iv.len() != 12 || tag.len() != 16 || key.len() != 32 {
        return None;
    }
    encrypted.extend_from_slice(&tag);
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    String::from_utf8(
        cipher
            .decrypt(Nonce::from_slice(&iv), encrypted.as_ref())
            .ok()?,
    )
    .ok()
}
fn read(env: &mut JNIEnv, value: &JString) -> Option<String> {
    if value.is_null() {
        return None;
    }
    env.get_string(value).ok().map(Into::into)
}
fn output(env: &mut JNIEnv, result: Option<String>) -> jstring {
    result
        .and_then(|value| env.new_string(value).ok())
        .map(JString::into_raw)
        .unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_cloud_betterportal_frame_NativeCore_renderPlan(
    mut env: JNIEnv,
    _object: JObject,
    bundle: JString,
    layout: JString,
    expanded: JString,
) -> jstring {
    let bundle = read(&mut env, &bundle);
    let layout = read(&mut env, &layout);
    let expanded = read(&mut env, &expanded);
    output(
        &mut env,
        Some(render_plan_json(
            bundle.as_deref().unwrap_or(""),
            layout.as_deref(),
            expanded.as_deref(),
        )),
    )
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_cloud_betterportal_frame_NativeCore_cameraUri(
    mut env: JNIEnv,
    _object: JObject,
    uri: JString,
    username: JString,
    password: JString,
    key: JString,
) -> jstring {
    let uri = read(&mut env, &uri);
    let username = read(&mut env, &username);
    let password = read(&mut env, &password);
    let key = read(&mut env, &key);
    output(
        &mut env,
        uri.and_then(|uri| {
            camera_uri(
                &uri,
                username.as_deref(),
                password.as_deref(),
                key.as_deref(),
            )
        }),
    )
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_cloud_betterportal_frame_NativeCore_resolveWebUrl(
    mut env: JNIEnv,
    _object: JObject,
    value: JString,
    server: JString,
) -> jstring {
    let value = read(&mut env, &value);
    let server = read(&mut env, &server);
    output(
        &mut env,
        value
            .zip(server)
            .and_then(|(value, server)| android::resolve_web_url(&value, &server)),
    )
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_cloud_betterportal_frame_NativeCore_websocketUrl(
    mut env: JNIEnv,
    _object: JObject,
    server: JString,
    token: JString,
) -> jstring {
    let server = read(&mut env, &server);
    let token = read(&mut env, &token);
    output(
        &mut env,
        server
            .zip(token)
            .and_then(|(server, token)| protocol::websocket_url(&server, &token).ok()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_bundle_errors_do_not_echo_secrets() {
        assert_eq!(
            render_plan_json("secret", None, None),
            r#"{"error":"Invalid display configuration"}"#
        );
    }
    #[test]
    fn decrypts_independent_node_server_wire_vector() {
        // Node createCipheriv("aes-256-gcm", Buffer.alloc(32,7), Buffer.alloc(12,3)).
        let uri = camera_uri(
            "rtsp://camera/live",
            Some("u@ser"),
            Some("v1.AwMDAwMDAwMDAwMD.b9EyWq8YCt_X35ZVpALLig.Vb7QcGAHfjUVMic"),
            Some("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"),
        )
        .unwrap();
        assert_eq!(uri, "rtsp://u%40ser:p%40ss%3A%2F%20word@camera/live");
    }

    #[test]
    fn camera_credentials_are_authenticated_and_url_encoded() {
        use aes_gcm::{
            Aes256Gcm, Nonce,
            aead::{Aead, KeyInit},
        };
        use base64::Engine;
        let codec = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let key = [7u8; 32];
        let nonce = [3u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), "p@ss:/ word".as_bytes())
            .unwrap();
        let (data, tag) = ciphertext.split_at(ciphertext.len() - 16);
        let encrypted = format!(
            "v1.{}.{}.{}",
            codec.encode(nonce),
            codec.encode(tag),
            codec.encode(data)
        );
        let uri = camera_uri(
            "rtsp://camera/live",
            Some("u@ser"),
            Some(&encrypted),
            Some(&codec.encode(key)),
        )
        .unwrap();
        assert_eq!(uri, "rtsp://u%40ser:p%40ss%3A%2F%20word@camera/live");
        assert!(
            camera_uri(
                "rtsp://camera/live",
                Some("user"),
                Some(&encrypted),
                Some(&codec.encode([8u8; 32]))
            )
            .is_none()
        );
        assert!(
            camera_uri(
                "rtsp://camera/live",
                Some("user"),
                Some("v1.bad.bad.bad"),
                Some("bad")
            )
            .is_none()
        );
        assert!(camera_uri("file:///secret", None, None, None).is_none());
    }
}
