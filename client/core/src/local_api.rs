//! Portable, credential-free catalogue and control contract for local clients.
use crate::bundle::{BundleCell, KioskBundle};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CatalogMetadata {
    #[serde(default)]
    pub camera_origins: BTreeMap<String, Origin>,
    #[serde(default)]
    pub groups: Vec<CatalogGroup>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Origin {
    pub provider: String,
    pub source_id: String,
    pub instance_id: String,
    pub external_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogGroup {
    pub id: String,
    pub name: String,
    pub layout_id: String,
    pub camera_ids: Vec<String>,
    pub origin: Origin,
}

/// Project tile identity and selection without executable content or connection URLs.
pub fn cell(cell: &BundleCell) -> Value {
    json!({"id": cell.view_id.clone().unwrap_or_else(|| format!("r{}c{}", cell.row, cell.col)),
        "entity_id": cell.entity_id, "row": cell.row, "col": cell.col,
        "row_span": cell.row_span, "col_span": cell.col_span,
        "content_type": cell.content_type, "camera_id": cell.camera_id,
        "stream": cell.stream_selector, "fit": cell.fit})
}

/// Explicit field projection: bundle URLs, credentials, HTML and scripts must
/// never be serialized into the local catalogue.
pub fn catalog(bundle: &KioskBundle) -> Value {
    let cameras: HashSet<_> = bundle
        .cameras
        .iter()
        .filter(|c| c.enabled)
        .map(|c| c.id.as_str())
        .collect();
    let displays = bundle.normalized_displays();
    let layouts: HashSet<_> = displays
        .iter()
        .flat_map(|d| &d.layouts)
        .map(|l| l.id.as_str())
        .collect();
    let mut devices = BTreeMap::new();
    let camera_list: Vec<_> = bundle.cameras.iter().filter(|c| c.enabled).map(|c| {
        if let Some(id) = &c.device_id { devices.insert(id.clone(), json!({"id":id,"name":c.device_name})); }
        json!({"id":c.id,"name":c.name,"device_id":c.device_id,"camera_number":c.camera_number,
            "labels":c.labels,"capabilities":c.capabilities,"type":c.cam_type,
            "origin":bundle.catalog_metadata.camera_origins.get(&c.id),
            "streams":c.streams.iter().map(|s| json!({"id":s.id,"role":s.role,"name":s.name,
                "width":s.width,"height":s.height,"encoding":s.encoding,"framerate":s.framerate})).collect::<Vec<_>>()})
    }).collect();
    let groups: Vec<_> = bundle.catalog_metadata.groups.iter().filter(|g| layouts.contains(g.layout_id.as_str())).map(|g| {
        let members: Vec<_> = g.camera_ids.iter().filter(|id| cameras.contains(id.as_str())).collect();
        json!({"id":g.id,"name":g.name,"layout_id":g.layout_id,"camera_ids":members,"origin":g.origin})
    }).collect();
    json!({"version":bundle.version,"kiosk_id":bundle.kiosk_id,"kiosk_name":bundle.kiosk_name,
        "devices":devices.into_values().collect::<Vec<_>>(),"cameras":camera_list,"groups":groups,
        "displays":displays.iter().map(|d| json!({"id":d.id,"name":d.name,"width_px":d.width_px,
            "height_px":d.height_px,"default_layout_id":d.default_layout_id,
            "layouts":d.layouts.iter().map(|l| json!({"id":l.id,"name":l.name,"is_default":l.is_default,
                "grid_cols":l.grid_cols,"grid_rows":l.grid_rows,
                "managed":bundle.catalog_metadata.groups.iter().any(|g|g.layout_id==l.id),
                "cells":l.cells.iter().map(cell).collect::<Vec<_>>()})).collect::<Vec<_>>()
        })).collect::<Vec<_>>()})
}

/// Flat parameters work identically in URL queries and JSON POST bodies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub request_id: String,
    pub action: String,
    pub display_id: String,
    #[serde(default)]
    pub layout_id: Option<String>,
    #[serde(default)]
    pub camera_id: Option<String>,
    #[serde(default)]
    pub cell_id: Option<String>,
    #[serde(default)]
    pub stream: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub expected_catalog_version: Option<String>,
}
impl Command {
    /// Reject unsupported actions, missing IDs and irrelevant or unbounded parameters.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.request_id.is_empty()
            || matches!(self.request_id.as_str(), "." | "..")
            || self.request_id.len() > 128
            || !self
                .request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b))
        {
            return Err(
                "request_id must be 1-128 ASCII letters, digits, '-', '_', '.' or ':', excluding the complete IDs . and ..",
            );
        }
        if self.display_id.is_empty() || self.display_id.len() > 128 {
            return Err("display_id is required");
        }
        if !matches!(
            self.action.as_str(),
            "select_layout"
                | "focus_camera"
                | "clear_display"
                | "restore_display"
                | "standby_display"
                | "wake_display"
                | "identify_display"
        ) {
            return Err("unsupported action");
        }
        if self.action == "select_layout" && self.layout_id.as_deref().is_none_or(str::is_empty) {
            return Err("layout_id is required");
        }
        if self.action == "focus_camera" && self.camera_id.as_deref().is_none_or(str::is_empty) {
            return Err("camera_id is required");
        }
        if self
            .stream
            .as_deref()
            .is_some_and(|s| !matches!(s, "main" | "sub" | "auto"))
        {
            return Err("stream must be main, sub or auto");
        }
        if self
            .duration_seconds
            .is_some_and(|s| s == 0 || s > 3600 || (self.action == "identify_display" && s > 30))
        {
            return Err("duration_seconds is out of range (identify: 1-30; focus: 1-3600)");
        }
        if self.layout_id.is_some() && self.action != "select_layout" {
            return Err("layout_id only applies to select_layout");
        }
        if (self.camera_id.is_some() || self.cell_id.is_some() || self.stream.is_some())
            && self.action != "focus_camera"
        {
            return Err("camera parameters only apply to focus_camera");
        }
        if self.duration_seconds.is_some()
            && !matches!(self.action.as_str(), "focus_camera" | "identify_display")
        {
            return Err("duration_seconds only applies to focus_camera or identify_display");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    /// Assert explicit projection cannot leak credentials or unrelated group metadata.
    fn catalog_never_exports_bundle_secrets() {
        let bundle: KioskBundle = serde_json::from_value(json!({"kiosk_id":"k","kiosk_name":"K","version":"v",
            "display":{"id":"d","name":"D","width_px":100,"height_px":100,"idle_timeout_seconds":0,"sleep_timeout_seconds":0},
            "layouts":[{"id":"l","name":"L","grid_cols":1,"grid_rows":1,"priority":"normal","is_default":true,"resets_idle_timer":false,"cells":[
                {"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"web","web_url":"SECRET-url","html_content":"SECRET-html","overlay_html":"SECRET-overlay"}]}],
            "cameras":[{"id":"c","name":"C","type":"rtsp","stream_policy":"auto","rtsp_url":"SECRET-rtsp",
                "playback_password_encrypted":"SECRET-password","streams":[{"id":"s","role":"main","name":"Main","rtsp_uri":"SECRET-stream"}]}],
            "catalog_metadata":{"camera_origins":{},"groups":[{"id":"foreign","name":"Foreign","layout_id":"other","camera_ids":["c"],
                "origin":{"provider":"simplevms","source_id":"src","instance_id":"i","external_id":"g"}}]}})).unwrap();
        let projected = catalog(&bundle);
        assert!(!projected.to_string().contains("SECRET"));
        assert_eq!(projected["groups"], json!([]));
        assert_eq!(
            projected["displays"][0]["layouts"][0]["cells"][0]["id"],
            "r0c0"
        );
        assert_eq!(projected["cameras"][0]["id"], "c");
    }
    #[test]
    /// Validate supported stream selectors and request-ID syntax before dispatch.
    fn reject_invalid_control_parameters() {
        let mut c: Command = serde_json::from_value(
            json!({"request_id":"id","action":"focus_camera","display_id":"d","camera_id":"c"}),
        )
        .unwrap();
        assert!(c.validate().is_ok());
        c.stream = Some("invalid".into());
        assert!(c.validate().is_err());
        c.stream = None;
        for id in [".", ".."] {
            c.request_id = id.into();
            assert!(c.validate().is_err());
        }
        c.request_id = "bad id".into();
        assert!(c.validate().is_err());
    }
}
