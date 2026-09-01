use serde::Deserialize;
use serde_json::Value;
use url::Url;

#[derive(Debug, Deserialize)]
pub struct PairInitiateResponse {
    pub code: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct PairClaimResponse {
    pub status: String,
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
}
