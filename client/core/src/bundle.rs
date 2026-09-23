use serde::{Deserialize, Deserializer, Serialize};

fn default_tenant() -> String {
    "default".to_string()
}

fn de_flexible_id<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let v = serde_json::Value::deserialize(deserializer)?;
    match v {
        serde_json::Value::String(s) => Ok(s),
        serde_json::Value::Number(n) => Ok(n.to_string()),
        _ => Err(serde::de::Error::custom("expected string or number for id")),
    }
}

fn de_flexible_id_opt<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    let v = Option::<serde_json::Value>::deserialize(deserializer)?;
    match v {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) if s.is_empty() => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s)),
        Some(serde_json::Value::Number(n)) => Ok(Some(n.to_string())),
        _ => Err(serde::de::Error::custom("expected string or number for id")),
    }
}

fn de_flexible_id_vec<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    let v = Vec::<serde_json::Value>::deserialize(deserializer)?;
    v.into_iter()
        .map(|item| match item {
            serde_json::Value::String(s) => Ok(s),
            serde_json::Value::Number(n) => Ok(n.to_string()),
            _ => Err(serde::de::Error::custom(
                "expected string or number in id array",
            )),
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KioskBundle {
    #[serde(deserialize_with = "de_flexible_id")]
    pub kiosk_id: String,
    pub kiosk_name: String,
    #[serde(default = "default_tenant")]
    pub tenant_slug: String,
    /// Legacy single-display field (mirrors `displays[0]`). New code should
    /// iterate `displays` instead.
    #[serde(default)]
    pub display: Option<BundleDisplay>,
    /// Legacy single-display layouts (mirrors `displays[0].layouts`). Kept for
    /// backward compatibility with older bundles that pre-date multi-display.
    #[serde(default)]
    pub layouts: Vec<BundleLayout>,
    /// All physical displays driven by this kiosk.
    #[serde(default)]
    pub displays: Vec<BundleDisplayWithLayouts>,
    pub cameras: Vec<BundleCamera>,
    #[serde(default)]
    pub gpio_bindings: Vec<BundleGpioBinding>,
    #[serde(default)]
    pub operator_console: OperatorConsoleConfig,
    pub version: String,
}

impl KioskBundle {
    /// Only resolve local aliases within this kiosk's current assignment.
    pub fn local_layout_id(&self, key: &str) -> Option<String> {
        if !valid_local_short_key(key) { return None; }
        self.normalized_displays().iter().flat_map(|display| &display.layouts)
            .find(|layout| layout.local_short_key.as_deref() == Some(key))
            .map(|layout| layout.id.clone())
    }

    pub fn local_camera_id(&self, key: &str) -> Option<String> {
        if !valid_local_short_key(key) { return None; }
        self.cameras.iter()
            .find(|camera| camera.enabled && camera.local_short_key.as_deref() == Some(key))
            .map(|camera| camera.id.clone())
    }

    /// Normalize the bundle: if `displays` is empty (old server), synthesize it
    /// from the legacy single `display` + `layouts` fields so the rest of the
    /// kiosk only deals with one shape.
    pub fn normalized_displays(&self) -> Vec<BundleDisplayWithLayouts> {
        if !self.displays.is_empty() {
            return self.displays.clone();
        }
        if let Some(d) = &self.display {
            return vec![BundleDisplayWithLayouts {
                id: d.id.clone(),
                name: d.name.clone(),
                width_px: d.width_px,
                height_px: d.height_px,
                idle_timeout_seconds: d.idle_timeout_seconds,
                sleep_timeout_seconds: d.sleep_timeout_seconds,
                default_layout_id: d.default_layout_id.clone(),
                layouts: self.layouts.clone(),
            }];
        }
        Vec::new()
    }
}

fn valid_local_short_key(key: &str) -> bool {
    key.len() == 6 && key.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleDisplay {
    #[serde(deserialize_with = "de_flexible_id")]
    pub id: String,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub idle_timeout_seconds: u32,
    pub sleep_timeout_seconds: u32,
    #[serde(default, deserialize_with = "de_flexible_id_opt")]
    pub default_layout_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleDisplayWithLayouts {
    #[serde(deserialize_with = "de_flexible_id")]
    pub id: String,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub idle_timeout_seconds: u32,
    pub sleep_timeout_seconds: u32,
    #[serde(default, deserialize_with = "de_flexible_id_opt")]
    pub default_layout_id: Option<String>,
    #[serde(default)]
    pub layouts: Vec<BundleLayout>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleLayout {
    #[serde(default)]
    pub local_short_key: Option<String>,
    #[serde(deserialize_with = "de_flexible_id")]
    pub id: String,
    pub name: String,
    pub grid_cols: u32,
    pub grid_rows: u32,
    pub priority: String,
    pub cooling_timeout_seconds: Option<u32>,
    pub idle_timeout_seconds: Option<u32>,
    #[serde(default, deserialize_with = "de_flexible_id_vec")]
    pub preload_camera_ids: Vec<String>,
    pub is_default: bool,
    pub resets_idle_timer: bool,
    #[serde(default)]
    pub input_options: Option<serde_json::Value>,
    pub cells: Vec<BundleCell>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleCell {
    #[serde(default, deserialize_with = "de_flexible_id_opt")]
    pub view_id: Option<String>,
    #[serde(default, deserialize_with = "de_flexible_id_opt")]
    pub entity_id: Option<String>,
    pub row: u32,
    pub col: u32,
    pub row_span: u32,
    pub col_span: u32,
    pub content_type: String,
    #[serde(default, deserialize_with = "de_flexible_id_opt")]
    pub camera_id: Option<String>,
    pub stream_selector: Option<String>,
    pub web_url: Option<String>,
    pub html_content: Option<String>,
    pub cooling_timeout_seconds: Option<u32>,
    #[serde(default = "default_fit")]
    pub fit: String,
    #[serde(default)]
    pub smart_url: Option<SmartUrlConfig>,
    #[serde(default)]
    pub local_storage: Option<std::collections::HashMap<String, String>>,
    #[serde(default)]
    pub input_options: Option<serde_json::Value>,
}

fn default_fit() -> String {
    "cover".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartUrlConfig {
    pub steps: Vec<SmartUrlStep>,
    #[serde(default)]
    pub login_detect_url: Option<String>,
    #[serde(default)]
    pub session_check_interval_ms: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartUrlStep {
    #[serde(rename = "type")]
    pub step_type: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub value_encrypted: Option<String>,
    #[serde(default)]
    pub delay_ms: Option<u32>,
    #[serde(default)]
    pub timeout_ms: Option<u32>,
    #[serde(default)]
    pub script: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleCamera {
    #[serde(default)]
    pub local_short_key: Option<String>,
    #[serde(deserialize_with = "de_flexible_id")]
    pub id: String,
    #[serde(default, deserialize_with = "de_flexible_id_opt")]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
    pub name: String,
    #[serde(default)]
    pub camera_number: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub last_seen_at: Option<String>,
    #[serde(default)]
    pub simple_vms_managed: bool,
    #[serde(default)]
    pub recording_config: serde_json::Value,
    #[serde(rename = "type")]
    pub cam_type: String,
    #[serde(default)]
    pub rtsp_url: Option<String>,
    pub stream_policy: String,
    pub streams: Vec<BundleStream>,
    #[serde(default)]
    pub playback_username: Option<String>,
    #[serde(default)]
    pub playback_password_encrypted: Option<String>,
    // ONVIF fields — present when cam_type=="onvif". Password is encrypted
    // with the cluster key; kiosk decrypts for ONVIF SOAP auth.
    #[serde(default)]
    pub onvif_host: Option<String>,
    #[serde(default)]
    pub onvif_port: Option<u16>,
    #[serde(default)]
    pub onvif_username: Option<String>,
    #[serde(default)]
    pub onvif_password_encrypted: Option<String>,
    #[serde(default)]
    pub event_source: Option<String>,
    #[serde(default)]
    pub event_sink: Option<String>,
    #[serde(default)]
    pub event_callback_token: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OperatorConsoleConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default = "default_operator_port")]
    pub port: u16,
    #[serde(default)]
    pub tools: Vec<OperatorTool>,
    #[serde(default)]
    pub simple_vms: SimpleVmsConfig,
}

fn default_operator_port() -> u16 {
    18443
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OperatorTool {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct SimpleVmsConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub storage_path: Option<String>,
    #[serde(default)]
    pub settings: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleStream {
    #[serde(deserialize_with = "de_flexible_id")]
    pub id: String,
    pub role: String,
    pub name: String,
    #[serde(default)]
    pub profile_token: Option<String>,
    pub rtsp_uri: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub encoding: Option<String>,
    pub framerate: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleGpioBinding {
    #[serde(deserialize_with = "de_flexible_id")]
    pub id: String,
    pub chip: String,
    pub pin: u32,
    pub direction: String,
    pub pull: Option<String>,
    pub edge: Option<String>,
    pub topic: String,
}

impl BundleCamera {
    /// A layout visit gets one main-stream fallback attempt, on an explicit
    /// error or ten seconds without video. Never oscillate after main fails.
    pub fn should_try_main(&self, badge: char, attempted: bool, failed: bool, silent_ms: u64) -> bool {
        badge == 'S' && !attempted && (failed || silent_ms >= 10_000)
            && self.main_fallback_uri().is_some()
    }

    /// Only fall back when discovery provides distinct main and sub URLs.
    pub fn main_fallback_uri(&self) -> Option<&str> {
        let sub = self.streams.iter().find(|stream| stream.role == "sub")?;
        let main = self.streams.iter().find(|stream| stream.role == "main")?;
        (!main.rtsp_uri.is_empty() && main.rtsp_uri != sub.rtsp_uri)
            .then_some(main.rtsp_uri.as_str())
    }

    /// Pick stream URI + role tag for this camera given selector and cell area fraction.
    /// Heuristic: when selector=auto, cell ≥20% of grid → main, else sub.
    /// Returns (uri, role_letter) where role_letter is 'M' or 'S' (or empty if single stream).
    pub fn pick_stream(
        &self,
        selector: Option<&str>,
        area_fraction: f32,
    ) -> Option<(String, char)> {
        let has_main = self.streams.iter().any(|s| s.role == "main");
        let has_sub = self.streams.iter().any(|s| s.role == "sub");
        let multi = has_main && has_sub;

        let sel = selector.unwrap_or("auto");
        let role_pref = match sel {
            "main" => "main",
            "sub" => "sub",
            _ => {
                if area_fraction >= 0.2 {
                    "main"
                } else {
                    "sub"
                }
            }
        };

        let stream = self
            .streams
            .iter()
            .find(|s| s.role == role_pref)
            .or_else(|| self.streams.iter().find(|s| s.role == "main"))
            .or_else(|| self.streams.first());

        let uri = stream
            .map(|s| s.rtsp_uri.clone())
            .or_else(|| self.rtsp_url.clone())?;
        let badge = if !multi {
            ' '
        } else if stream.map(|s| s.role.as_str()) == Some("main") {
            'M'
        } else {
            'S'
        };
        Some((uri, badge))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substream_fallback_requires_a_distinct_main_stream() {
        let mut camera: BundleCamera = serde_json::from_value(serde_json::json!({
            "id": "camera", "name": "Camera", "type": "onvif", "stream_policy": "auto",
            "streams": [
                {"id": "main", "name": "Main", "role": "main", "rtsp_uri": "rtsp://nvr/main"},
                {"id": "sub", "name": "Sub", "role": "sub", "rtsp_uri": "rtsp://nvr/sub"}
            ]
        })).unwrap();
        assert_eq!(camera.pick_stream(None, 0.1).unwrap().1, 'S');
        assert_eq!(camera.main_fallback_uri(), Some("rtsp://nvr/main"));
        assert!(!camera.should_try_main('S', false, false, 9_999));
        assert!(camera.should_try_main('S', false, true, 0), "404 falls back immediately");
        assert!(camera.should_try_main('S', false, false, 10_000), "silent substream times out");
        assert!(!camera.should_try_main('M', false, true, 30_000), "main failure cannot bounce back");
        assert!(!camera.should_try_main('S', true, true, 30_000), "no repeat within a layout visit");
        assert!(camera.should_try_main('S', false, true, 0), "new visit permits another attempt");
        camera.streams[0].rtsp_uri = "rtsp://nvr/sub".into();
        assert_eq!(camera.main_fallback_uri(), None, "do not retry the same failing URL");
        camera.streams[0].rtsp_uri.clear();
        assert_eq!(camera.main_fallback_uri(), None);
        camera.streams.remove(0);
        assert_eq!(camera.main_fallback_uri(), None, "no invented main URL");
    }

    #[test]
    fn normalizes_legacy_display_and_flexible_ids() {
        let bundle: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id": 10,
            "kiosk_name": "Lobby",
            "display": {
                "id": 20,
                "name": "Main",
                "width_px": 1920,
                "height_px": 1080,
                "idle_timeout_seconds": 0,
                "sleep_timeout_seconds": 0,
                "default_layout_id": 30
            },
            "layouts": [{
                "id": 30,
                "name": "Default",
                "grid_cols": 1,
                "grid_rows": 1,
                "priority": "normal",
                "cooling_timeout_seconds": null,
                "idle_timeout_seconds": null,
                "preload_camera_ids": [40],
                "is_default": true,
                "resets_idle_timer": true,
                "cells": []
            }],
            "cameras": [],
            "version": "1"
        }))
        .unwrap();

        let displays = bundle.normalized_displays();
        assert_eq!(bundle.kiosk_id, "10");
        assert_eq!(displays[0].id, "20");
        assert_eq!(displays[0].layouts[0].preload_camera_ids, ["40"]);
    }

    #[test]
    fn local_short_keys_only_resolve_current_assigned_resources() {
        let mut bundle: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id": "kiosk", "kiosk_name": "Lobby", "version": "1",
            "displays": [{
                "id": "display", "name": "Main", "width_px": 1920, "height_px": 1080,
                "idle_timeout_seconds": 0, "sleep_timeout_seconds": 0,
                "layouts": [{
                    "id": "layout-uuid", "local_short_key": "abc123", "name": "Layout",
                    "grid_cols": 1, "grid_rows": 1, "priority": "normal",
                    "is_default": true, "resets_idle_timer": true, "cells": []
                }]
            }],
            "cameras": [{
                "id": "camera-uuid", "local_short_key": "def456", "name": "Camera",
                "type": "onvif", "enabled": true, "stream_policy": "auto", "streams": []
            }]
        })).unwrap();
        assert_eq!(bundle.local_layout_id("abc123").as_deref(), Some("layout-uuid"));
        assert_eq!(bundle.local_camera_id("def456").as_deref(), Some("camera-uuid"));
        for key in ["", "ffffff", "layout-uuid", "ABC123", "abc1234", "../abc"] {
            assert_eq!(bundle.local_layout_id(key), None);
        }
        assert_eq!(bundle.local_layout_id("def456"), None);
        assert_eq!(bundle.local_camera_id("abc123"), None);
        bundle.cameras[0].enabled = false;
        assert_eq!(bundle.local_camera_id("def456"), None);
        bundle.displays.clear();
        assert_eq!(bundle.local_layout_id("abc123"), None);
    }

    #[test]
    fn stream_selection_is_shared_across_platforms() {
        let camera: BundleCamera = serde_json::from_value(serde_json::json!({
            "id": "camera",
            "name": "Front",
            "type": "rtsp",
            "stream_policy": "auto",
            "streams": [
                {"id":"main","role":"main","name":"Main","rtsp_uri":"rtsp://main","width":1920,"height":1080,"encoding":"H264","framerate":25},
                {"id":"sub","role":"sub","name":"Sub","rtsp_uri":"rtsp://sub","width":640,"height":360,"encoding":"H264","framerate":15}
            ]
        }))
        .unwrap();

        assert_eq!(camera.pick_stream(None, 0.19).unwrap().0, "rtsp://sub");
        assert_eq!(camera.pick_stream(None, 0.20).unwrap().0, "rtsp://main");
        assert_eq!(
            camera.pick_stream(Some("sub"), 1.0).unwrap().0,
            "rtsp://sub"
        );
    }
}
