use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use url::Url;

pub const LOCAL_SERVER_URL: &str = "http://localhost";
pub const SERVER_CANDIDATES: [&str; 3] = [
    LOCAL_SERVER_URL,
    "http://betterframe.local",
    "https://frame.betterportal.net",
];

pub fn server_origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

pub const MAX_DISCOVERY_REDIRECTS: usize = 5;

/// Discovery never sends enrollment material. Remote destinations must use TLS;
/// explicit local HTTP remains usable for existing on-device/LAN installations.
pub fn discovery_probe(origin: &str) -> Result<Url, String> {
    let mut url = Url::parse(origin.trim()).map_err(|_| "invalid server origin")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err("server must be an origin without credentials, path, query or fragment".into());
    }
    if url.scheme() != "https" && !(url.scheme() == "http" && local_discovery_host(&url)) {
        return Err(
            "remote discovery requires HTTPS; HTTP is supported only for local servers".into(),
        );
    }
    url.set_path("/healthz");
    Ok(url)
}

fn local_discovery_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost" || host.ends_with(".local"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Some(url::Host::Ipv6(ip)) => {
            ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
        }
        None => false,
    }
}

pub fn validate_discovery_redirect(
    previous: &Url,
    next: &Url,
    followed: usize,
) -> Result<(), String> {
    if followed >= MAX_DISCOVERY_REDIRECTS {
        return Err("too many server discovery redirects".into());
    }
    if !next.username().is_empty()
        || next.password().is_some()
        || next.query().is_some()
        || next.fragment().is_some()
        || !matches!(next.path(), "/" | "/healthz")
    {
        return Err("invalid server discovery redirect".into());
    }
    if next.scheme() != "https"
        && !(previous.scheme() == "http"
            && next.scheme() == "http"
            && previous.origin() == next.origin()
            && local_discovery_host(next))
    {
        return Err("server discovery redirects must use HTTPS".into());
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
pub struct PairInitiateResponse {
    pub code: String,
    pub expires_at: String,
    pub expires_in_seconds: Option<u64>,
    pub poll_after_ms: Option<u64>,
    pub polling_secret: Option<String>,
}

impl PairInitiateResponse {
    /// Old servers only provide wall-clock expiry. Bound those sessions too,
    /// without trusting a kiosk clock that may not yet have synchronized.
    pub fn lifetime(&self) -> Duration {
        Duration::from_secs(self.expires_in_seconds.unwrap_or(900).clamp(1, 1800))
    }

    pub fn poll_delay(&self) -> Duration {
        poll_delay(self.poll_after_ms)
    }
}

pub fn claim_body(code: &str, polling_secret: Option<&str>) -> Value {
    let mut body = serde_json::json!({ "code": code });
    if let Some(secret) = polling_secret {
        body["polling_secret"] = Value::String(secret.to_string());
    }
    body
}

pub fn poll_delay(milliseconds: Option<u64>) -> Duration {
    Duration::from_millis(milliseconds.unwrap_or(2000).clamp(1000, 60000))
}

#[derive(Clone, Deserialize, Serialize)]
pub struct DeviceIdentity {
    pub version: u32,
    pub server_url: String,
    pub kiosk_id: String,
    pub kiosk_name: String,
    pub kiosk_key: String,
    pub cluster_key: Option<String>,
    pub encrypt_key: Option<String>,
    pub pairing_code: String,
    pub polling_secret: Option<String>,
}

impl DeviceIdentity {
    pub fn from_claim(
        server: &str,
        session: &PairInitiateResponse,
        claim: PairClaimResponse,
    ) -> Result<Self, String> {
        let identity = Self {
            version: 1,
            server_url: server.to_string(),
            kiosk_id: match claim.kiosk_id {
                Some(Value::String(id)) => id,
                Some(Value::Number(id)) => id.to_string(),
                _ => return Err("claim is missing kiosk ID".into()),
            },
            kiosk_name: claim.kiosk_name.unwrap_or_else(|| "kiosk".into()),
            kiosk_key: claim.kiosk_key.ok_or("claim is missing kiosk key")?,
            cluster_key: claim.cluster_key,
            encrypt_key: claim.encrypt_key,
            pairing_code: session.code.clone(),
            polling_secret: session.polling_secret.clone(),
        };
        identity.validate()?;
        Ok(identity)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || self.kiosk_id.trim().is_empty() || self.kiosk_key.trim().is_empty()
        {
            return Err("invalid saved device identity".into());
        }
        let origin = Url::parse(&self.server_url).map_err(|_| "invalid identity server URL")?;
        if !matches!(origin.scheme(), "http" | "https") || origin.host_str().is_none() {
            return Err("invalid identity server URL".into());
        }
        if !self
            .encrypt_key
            .as_deref()
            .or(self.cluster_key.as_deref())
            .is_some_and(|key| !key.trim().is_empty())
        {
            return Err("device identity is missing encryption material".into());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
pub struct PairClaimResponse {
    pub status: String,
    pub expires_in_seconds: Option<u64>,
    pub poll_after_ms: Option<u64>,
    pub kiosk_id: Option<Value>,
    pub kiosk_name: Option<String>,
    pub kiosk_key: Option<String>,
    pub cluster_key: Option<String>,
    pub encrypt_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HeartbeatResponse {
    pub pending_config: Option<PendingConfig>,
}

#[derive(Debug, Deserialize)]
pub struct PendingConfig {
    pub version: u64,
    pub config: Value,
}

pub fn websocket_url(server_url: &str, token: &str) -> Result<String, String> {
    let mut url = Url::parse(server_url).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("server URL must use http or https".to_string());
    }
    url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
        .map_err(|_| "server URL cannot be converted to a WebSocket URL".to_string())?;
    if url.port() == Some(18081) {
        url.set_port(Some(18082))
            .map_err(|_| "server URL does not support an explicit port".to_string())?;
    }
    url.set_path("/ws/kiosk");
    url.set_query(None);
    url.query_pairs_mut().append_pair("token", token);
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_supports_legacy_and_bounds_untrusted_timing() {
        let legacy: PairInitiateResponse =
            serde_json::from_str(r#"{"code":"ABC123","expires_at":"invalid"}"#).unwrap();
        assert_eq!(legacy.lifetime(), Duration::from_secs(900));
        assert_eq!(legacy.poll_delay(), Duration::from_secs(2));
        let modern: PairInitiateResponse = serde_json::from_str(r#"{"code":"ABC123","expires_at":"invalid","expires_in_seconds":18446744073709551615,"poll_after_ms":0}"#).unwrap();
        assert_eq!(modern.lifetime(), Duration::from_secs(1800));
        assert_eq!(modern.poll_delay(), Duration::from_secs(1));
    }

    #[test]
    fn incomplete_claim_cannot_be_saved_as_paired() {
        let session: PairInitiateResponse =
            serde_json::from_str(r#"{"code":"ABC123","expires_at":"invalid"}"#).unwrap();
        let parse = |json| serde_json::from_str::<PairClaimResponse>(json).unwrap();
        assert!(
            DeviceIdentity::from_claim(
                "https://example.com",
                &session,
                parse(r#"{"status":"claimed","kiosk_key":"key","kiosk_id":"42"}"#)
            )
            .is_err()
        );
        let identity = DeviceIdentity::from_claim("https://example.com", &session, parse(r#"{"status":"claimed","kiosk_key":"key","kiosk_id":42,"encrypt_key":"encryption-key"}"#)).unwrap();
        assert_eq!(identity.kiosk_id, "42");
        assert!(identity.validate().is_ok());
    }

    #[test]
    fn websocket_url_preserves_proxy_or_maps_direct_api_port() {
        assert_eq!(
            websocket_url("https://frame.example/base", "a b").unwrap(),
            "wss://frame.example/ws/kiosk?token=a+b"
        );
        assert_eq!(
            websocket_url("http://10.0.0.2:18081", "key").unwrap(),
            "ws://10.0.0.2:18082/ws/kiosk?token=key"
        );
        assert!(websocket_url("localhost:18081", "key").is_err());
    }

    #[test]
    fn discovery_tries_local_before_the_regional_redirector() {
        assert_eq!(SERVER_CANDIDATES[0], LOCAL_SERVER_URL);
        assert_eq!(
            SERVER_CANDIDATES.last(),
            Some(&"https://frame.betterportal.net")
        );
        assert_eq!(
            server_origin(&Url::parse("https://frame-eu.betterportal.net/healthz").unwrap()),
            "https://frame-eu.betterportal.net"
        );
    }

    #[test]
    fn discovery_rejects_secrets_paths_remote_cleartext_and_downgrades() {
        for origin in [
            "https://user:password@frame.example",
            "https://frame.example/?key=secret",
            "https://frame.example/#token",
            "https://frame.example/admin",
            "http://public.example",
        ] {
            assert!(discovery_probe(origin).is_err(), "accepted {origin}");
        }
        assert_eq!(
            discovery_probe("http://192.168.1.2:18081")
                .unwrap()
                .as_str(),
            "http://192.168.1.2:18081/healthz"
        );
        assert!(discovery_probe("http://[fd00::1]").is_ok());
        let canonical = discovery_probe("https://frame.betterportal.net").unwrap();
        let regional = discovery_probe("https://frame-eu.betterportal.net").unwrap();
        assert!(validate_discovery_redirect(&canonical, &regional, 0).is_ok());
        assert!(validate_discovery_redirect(&canonical, &regional, 4).is_ok());
        assert!(validate_discovery_redirect(&canonical, &regional, 5).is_err());
        for target in [
            "http://frame-eu.betterportal.net/healthz",
            "http://127.0.0.1/healthz",
            "https://user:password@frame-eu.betterportal.net/healthz",
            "https://frame-eu.betterportal.net/healthz?secret=x",
            "https://frame-eu.betterportal.net/healthz#secret",
            "https://frame-eu.betterportal.net/login",
        ] {
            assert!(
                validate_discovery_redirect(&canonical, &Url::parse(target).unwrap(), 0).is_err(),
                "accepted {target}"
            );
        }
        let local = discovery_probe("http://127.0.0.1:18081").unwrap();
        assert!(validate_discovery_redirect(&local, &local.join("/").unwrap(), 0).is_ok());
        assert!(
            validate_discovery_redirect(
                &local,
                &Url::parse("http://127.0.0.1:18082/healthz").unwrap(),
                0
            )
            .is_err()
        );
    }
}
