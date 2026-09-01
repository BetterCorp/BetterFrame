use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ClientState {
    pub server_url: String,
    pub kiosk_key: Option<String>,
    #[serde(default)]
    pub encrypt_key: Option<String>,
    pub kiosk_id: Option<String>,
    pub kiosk_name: Option<String>,
    pub bundle_version: Option<String>,
    #[serde(default)]
    pub managed_config_applied_version: u64,
    #[serde(default)]
    pub managed_config_error: Option<String>,
    #[serde(default)]
    pub pairing_code: Option<String>,
    #[serde(default)]
    pub pairing_expires_at: Option<String>,
    #[serde(default)]
    pub active_layouts: HashMap<String, String>,
}

impl ClientState {
    pub fn unpaired(server_url: &str) -> Self {
        Self {
            server_url: server_url.to_string(),
            ..Self::default()
        }
    }
}
