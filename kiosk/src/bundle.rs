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
    pub regions: Vec<BundleRegion>,
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
pub struct BundleRegion {
    pub name: String,
    pub row: u32,
    pub col: u32,
    #[serde(rename = "rowSpan")]
    pub row_span: u32,
    #[serde(rename = "colSpan")]
    pub col_span: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BundleCell {
    pub region_name: String,
    pub content_type: String,
    pub camera_id: Option<u32>,
    pub stream_selector: Option<String>,
    pub web_url: Option<String>,
    pub html_content: Option<String>,
    pub cooling_timeout_seconds: Option<u32>,
}

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
    /// Pick the best stream URI for this camera given a cell's stream_selector.
    pub fn stream_uri(&self, selector: Option<&str>) -> Option<&str> {
        let sel = selector.unwrap_or("auto");
        match sel {
            "main" => self.streams.iter().find(|s| s.role == "main"),
            "sub" => self.streams.iter().find(|s| s.role == "sub"),
            _ => {
                // auto: prefer main, fall back to any
                self.streams.iter().find(|s| s.role == "main")
                    .or_else(|| self.streams.first())
            }
        }
        .map(|s| s.rtsp_uri.as_str())
        .or(self.rtsp_url.as_deref())
    }
}
