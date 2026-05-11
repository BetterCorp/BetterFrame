use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KioskBundle {
    pub kiosk_id: u32,
    pub kiosk_name: String,
    pub display: BundleDisplay,
    pub layouts: Vec<BundleLayout>,
    pub cameras: Vec<BundleCamera>,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleDisplay {
    pub id: u32,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub idle_timeout_seconds: u32,
    pub sleep_timeout_seconds: u32,
    pub default_layout_id: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleLayout {
    pub id: u32,
    pub name: String,
    pub grid_cols: u32,
    pub grid_rows: u32,
    pub priority: String,
    pub cooling_timeout_seconds: Option<u32>,
    pub preload_camera_ids: Vec<u32>,
    pub is_default: bool,
    pub resets_idle_timer: bool,
    pub cells: Vec<BundleCell>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleCell {
    pub row: u32,
    pub col: u32,
    pub row_span: u32,
    pub col_span: u32,
    pub content_type: String,
    pub camera_id: Option<u32>,
    pub stream_selector: Option<String>,
    pub web_url: Option<String>,
    pub html_content: Option<String>,
    pub cooling_timeout_seconds: Option<u32>,
    #[serde(default = "default_fit")]
    pub fit: String,
}

fn default_fit() -> String { "cover".to_string() }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleCamera {
    pub id: u32,
    pub name: String,
    #[serde(rename = "type")]
    pub cam_type: String,
    pub rtsp_url: Option<String>,
    pub stream_policy: String,
    pub streams: Vec<BundleStream>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleStream {
    pub id: u32,
    pub role: String,
    pub name: String,
    pub rtsp_uri: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub encoding: Option<String>,
    pub framerate: Option<u32>,
}

impl BundleCamera {
    /// Pick stream URI + role tag for this camera given selector and cell area fraction.
    /// Heuristic: when selector=auto, cell ≥20% of grid → main, else sub.
    /// Returns (uri, role_letter) where role_letter is 'M' or 'S' (or empty if single stream).
    pub fn pick_stream(&self, selector: Option<&str>, area_fraction: f32) -> Option<(String, char)> {
        let has_main = self.streams.iter().any(|s| s.role == "main");
        let has_sub = self.streams.iter().any(|s| s.role == "sub");
        let multi = has_main && has_sub;

        let sel = selector.unwrap_or("auto");
        let role_pref = match sel {
            "main" => "main",
            "sub" => "sub",
            _ => if area_fraction >= 0.2 { "main" } else { "sub" },
        };

        let stream = self.streams.iter().find(|s| s.role == role_pref)
            .or_else(|| self.streams.iter().find(|s| s.role == "main"))
            .or_else(|| self.streams.first());

        let uri = stream.map(|s| s.rtsp_uri.clone())
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
