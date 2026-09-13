//! Pure policy for the constrained, single-display Android viewer.
//! This projection is the only Android reader of the canonical bundle model.
use crate::{
    bundle::{BundleCamera, BundleCell, BundleLayout, KioskBundle},
    layout,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use url::Url;

pub const MAX_CAMERAS: usize = 4;
pub const MAX_MIXED_CAMERAS: usize = 2;
pub const MAX_WEB_VIEWS: usize = 1;
const MAX_CELLS: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub display_id: String,
    pub layout_id: String,
    pub layout_name: String,
    pub layouts: Vec<LayoutChoice>,
    pub expanded_cell_id: Option<String>,
    pub background: &'static str,
    pub rows: u32,
    pub cols: u32,
    pub gap: u32,
    pub max_camera_streams: usize,
    pub max_web_views: usize,
    pub cells: Vec<RenderCell>,
}
#[derive(Serialize)]
pub struct LayoutChoice {
    pub id: String,
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderCell {
    pub id: String,
    pub label: String,
    pub row: u32,
    pub col: u32,
    pub row_span: u32,
    pub col_span: u32,
    pub fit: String,
    pub kind: &'static str,
    pub camera: Option<CameraSource>,
    pub web: Option<WebSource>,
    pub message: Option<String>,
    pub action: CellAction,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSource {
    pub id: String,
    pub uri: String,
    pub fallback_uri: Option<String>,
    pub username: Option<String>,
    pub encrypted_password: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSource {
    pub url: Option<String>,
    pub html: Option<String>,
    pub base_url: Option<String>,
    pub origin: Option<String>,
    pub local_storage: HashMap<String, String>,
    pub interactive: bool,
    pub allow_audio: bool,
}
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CellAction {
    Expand,
    Restore,
    #[serde(rename = "layout.switch")]
    SwitchLayout {
        #[serde(rename = "layoutId")]
        layout_id: String,
    },
    Unsupported,
}

/// Invalid geometry/assignment fails closed. Excess resources become visible
/// placeholders; expansion still lets an operator view one of those cells.
pub fn render_plan(
    bundle: &KioskBundle,
    layout_id: Option<&str>,
    expanded_cell_id: Option<&str>,
) -> Result<RenderPlan, &'static str> {
    let displays = bundle.normalized_displays();
    if displays.len() != 1 {
        return Err("Android viewer requires exactly one assigned display");
    }
    let display = &displays[0];
    let default = layout::initial_layout_id(display);
    let selected = layout_id.filter(|s| !s.is_empty()).or(default.as_deref());
    let selected_layout = display
        .layouts
        .iter()
        .find(|l| Some(l.id.as_str()) == selected)
        .ok_or("Layout is not assigned to this display")?;
    validate_layout(selected_layout)?;
    let cameras: HashMap<_, _> = bundle
        .cameras
        .iter()
        .filter(|c| c.enabled)
        .map(|c| (c.id.as_str(), c))
        .collect();
    let expanded = expanded_cell_id.filter(|id| !id.is_empty()).and_then(|id| {
        selected_layout
            .cells
            .iter()
            .enumerate()
            .find(|(i, c)| cell_id(c, *i) == id)
            .filter(|(_, c)| {
                c.content_type != "camera"
                    || c.camera_id
                        .as_deref()
                        .is_some_and(|id| cameras.contains_key(id))
            })
            .map(|(i, c)| cell_id(c, i))
    });
    let visible: Vec<_> = selected_layout
        .cells
        .iter()
        .enumerate()
        .filter(|(i, c)| expanded.as_ref().is_none_or(|id| *id == cell_id(c, *i)))
        .collect();
    let has_web = visible
        .iter()
        .any(|(_, c)| matches!(c.content_type.as_str(), "web" | "html"));
    let camera_budget = if has_web {
        MAX_MIXED_CAMERAS
    } else {
        MAX_CAMERAS
    };
    let mut camera_count = 0;
    let mut web_count = 0;
    let mut cells = Vec::new();
    for (index, cell) in visible {
        let mut output = RenderCell {
            id: cell_id(cell, index),
            label: "".into(),
            row: cell.row,
            col: cell.col,
            row_span: cell.row_span,
            col_span: cell.col_span,
            fit: if cell.fit == "contain" {
                "contain"
            } else {
                "cover"
            }
            .into(),
            kind: "placeholder",
            camera: None,
            web: None,
            message: None,
            action: action(cell, &display.layouts),
        };
        if expanded.is_some() {
            output.row = 0;
            output.col = 0;
            output.row_span = 1;
            output.col_span = 1;
        }
        match cell.content_type.as_str() {
            "camera" => {
                if let Some(camera) = cell.camera_id.as_deref().and_then(|id| cameras.get(id)) {
                    output.label = camera.name.clone();
                    if camera_count >= camera_budget {
                        output.message =
                            Some("Camera limit reached; expand this tile to view".into());
                    } else if let Some(uri) = pick_stream(camera, expanded.is_some()) {
                        let fallback = pick_stream(camera, false).filter(|sub| *sub != uri);
                        output.kind = "camera";
                        output.camera = Some(CameraSource {
                            id: camera.id.clone(),
                            uri,
                            fallback_uri: fallback,
                            username: camera.playback_username.clone(),
                            encrypted_password: camera.playback_password_encrypted.clone(),
                        });
                        camera_count += 1;
                    } else {
                        output.message = Some("No compatible H.264 RTSP stream".into());
                    }
                } else {
                    output.message = Some("Camera is unavailable or no longer assigned".into());
                }
            }
            "web" | "html" => {
                output.label = if cell.content_type == "html" {
                    "HTML"
                } else {
                    "Web / signage"
                }
                .into();
                if cell.smart_url.is_some() {
                    output.message = Some("Scripted login is not supported on Android".into());
                } else if web_count >= MAX_WEB_VIEWS {
                    output.message =
                        Some("Web content limit reached; expand this tile to view".into());
                } else if cell.content_type == "web"
                    && !cell.web_url.as_deref().is_some_and(valid_web_reference)
                {
                    output.message = Some("Unsupported or missing web URL".into());
                } else if cell.content_type == "html"
                    && cell
                        .html_content
                        .as_ref()
                        .is_none_or(|h| h.trim().is_empty())
                {
                    output.message = Some("No HTML content assigned".into());
                } else {
                    let url = if cell.content_type == "web" {
                        cell.web_url.clone()
                    } else {
                        None
                    };
                    let origin = url
                        .as_ref()
                        .and_then(|u| Url::parse(u).ok())
                        .map(|u| u.origin().ascii_serialization());
                    // Each raw HTML cell has a distinct unprivileged HTTPS origin.
                    let base = format!(
                        "https://bf-html-{}.invalid/",
                        hex_id(&format!(
                            "{}:{}:{}",
                            bundle.kiosk_id, selected_layout.id, output.id
                        ))
                    );
                    output.kind = "web";
                    output.web = Some(WebSource {
                        url,
                        html: if cell.content_type == "html" {
                            cell.html_content.clone()
                        } else {
                            None
                        },
                        base_url: Some(base),
                        origin,
                        local_storage: cell.local_storage.clone().unwrap_or_default(),
                        interactive: true,
                        allow_audio: false,
                    });
                    web_count += 1;
                }
            }
            "empty" | "placeholder" => {
                output.message = Some("No content assigned".into());
            }
            _ => {
                output.message = Some("Content type is not supported on Android".into());
            }
        }
        if matches!(output.action, CellAction::Unsupported) && output.message.is_none() {
            output.message = Some("Configured input action is unsupported".into());
        }
        cells.push(output);
    }
    Ok(RenderPlan {
        display_id: display.id.clone(),
        layout_id: selected_layout.id.clone(),
        layout_name: selected_layout.name.clone(),
        layouts: display
            .layouts
            .iter()
            .map(|l| LayoutChoice {
                id: l.id.clone(),
                name: l.name.clone(),
            })
            .collect(),
        rows: if expanded.is_some() {
            1
        } else {
            selected_layout.grid_rows
        },
        cols: if expanded.is_some() {
            1
        } else {
            selected_layout.grid_cols
        },
        expanded_cell_id: expanded,
        background: "#101418",
        gap: 4,
        max_camera_streams: camera_budget,
        max_web_views: MAX_WEB_VIEWS,
        cells,
    })
}

fn hex_id(value: &str) -> String {
    // Stable bounded identifier; the origin grants no server privileges.
    let hash = value.as_bytes().iter().fold(0xcbf29ce484222325u64, |n, b| {
        (n ^ u64::from(*b)).wrapping_mul(0x100000001b3)
    });
    format!("{hash:016x}")
}
fn cell_id(cell: &BundleCell, index: usize) -> String {
    cell.view_id
        .clone()
        .unwrap_or_else(|| format!("cell-{index}"))
}
fn validate_layout(layout: &BundleLayout) -> Result<(), &'static str> {
    if layout.grid_cols == 0
        || layout.grid_rows == 0
        || layout.grid_cols > 16
        || layout.grid_rows > 16
        || layout.cells.len() > MAX_CELLS
    {
        return Err("Layout exceeds supported grid bounds");
    }
    let mut ids = HashSet::new();
    let mut occupied = HashSet::new();
    for (i, c) in layout.cells.iter().enumerate() {
        if !ids.insert(cell_id(c, i)) {
            return Err("Layout contains duplicate cell IDs");
        }
        if c.row_span == 0
            || c.col_span == 0
            || c.row
                .checked_add(c.row_span)
                .is_none_or(|r| r > layout.grid_rows)
            || c.col
                .checked_add(c.col_span)
                .is_none_or(|v| v > layout.grid_cols)
        {
            return Err("Cell is outside the assigned grid");
        }
        for row in c.row..c.row + c.row_span {
            for col in c.col..c.col + c.col_span {
                if !occupied.insert((row, col)) {
                    return Err("Layout contains overlapping cells");
                }
            }
        }
    }
    Ok(())
}
fn action(cell: &BundleCell, layouts: &[BundleLayout]) -> CellAction {
    let Some((name, params)) = layout::configured_cell_action(cell, "click") else {
        return CellAction::Expand;
    };
    match name.as_str() {
        "expand" | "view.expand" => CellAction::Expand,
        "restore" | "view.restore" => CellAction::Restore,
        "layout.switch" => {
            let id = params.get("layout_id").and_then(|v| match v {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            });
            match id.filter(|id| layouts.iter().any(|l| l.id == *id)) {
                Some(layout_id) => CellAction::SwitchLayout { layout_id },
                None => CellAction::Unsupported,
            }
        }
        _ => CellAction::Unsupported,
    }
}
fn valid_rtsp(value: &str) -> bool {
    Url::parse(value).is_ok_and(|u| u.scheme() == "rtsp" && u.host_str().is_some())
}
fn valid_web_reference(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.starts_with("//") || value.contains('\\') {
        return false;
    }
    match Url::parse(value) {
        Ok(u) => {
            matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some()
                && u.username().is_empty()
                && u.password().is_none()
        }
        Err(_) => !value.contains(':'),
    }
}
pub fn resolve_web_url(value: &str, server_url: &str) -> Option<String> {
    if !valid_web_reference(value) {
        return None;
    }
    let url = layout::resolve_web_url(value, server_url)?;
    valid_web_reference(&url).then_some(url)
}
fn pick_stream(camera: &BundleCamera, expanded: bool) -> Option<String> {
    let compatible: Vec<_> = camera
        .streams
        .iter()
        .filter(|s| {
            s.encoding.as_deref().is_none_or(|e| {
                matches!(
                    e.to_ascii_lowercase().replace(['.', '-'], "").as_str(),
                    "h264" | "avc" | "avc1"
                )
            }) && valid_rtsp(&s.rtsp_uri)
        })
        .collect();
    let preferred = if expanded { "main" } else { "sub" };
    compatible
        .iter()
        .find(|s| s.role == preferred)
        .or_else(|| compatible.first())
        .map(|s| s.rtsp_uri.clone())
        // A raw RTSP source has no SDP codec metadata; playback verifies H.264.
        .or_else(|| {
            if camera.streams.is_empty() {
                camera.rtsp_url.clone().filter(|u| valid_rtsp(u))
            } else {
                None
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    fn fixture() -> Value {
        json!({"kiosk_id":1,"kiosk_name":"Lobby","version":"1","displays":[{
            "id":2,"name":"TV","width_px":1920,"height_px":1080,"idle_timeout_seconds":0,"sleep_timeout_seconds":0,"default_layout_id":3,
            "layouts":[{"id":3,"name":"Mixed","grid_cols":3,"grid_rows":2,"priority":"normal","is_default":true,"resets_idle_timer":true,
                "cells":[
                    {"view_id":10,"row":0,"col":0,"row_span":1,"col_span":1,"content_type":"camera","camera_id":5},
                    {"view_id":11,"row":0,"col":1,"row_span":1,"col_span":2,"content_type":"web","web_url":"/dash/lobby"},
                    {"view_id":12,"row":1,"col":0,"row_span":1,"col_span":1,"content_type":"camera","camera_id":5},
                    {"view_id":13,"row":1,"col":1,"row_span":1,"col_span":1,"content_type":"camera","camera_id":5}
                ]}]}],"cameras":[{"id":5,"name":"Entrance","type":"onvif","stream_policy":"auto","playback_username":"viewer","playback_password_encrypted":"v1.placeholder",
                    "streams":[{"id":6,"role":"main","name":"Main","rtsp_uri":"rtsp://camera/main","encoding":"H264"},
                    {"id":7,"role":"sub","name":"Sub","rtsp_uri":"rtsp://camera/sub","encoding":"H264"}]}]})
    }
    fn parse(v: Value) -> KioskBundle {
        serde_json::from_value(v).unwrap()
    }
    fn plan(v: Value, layout: Option<&str>, expanded: Option<&str>) -> RenderPlan {
        render_plan(&parse(v), layout, expanded).unwrap()
    }
    #[test]
    fn mixed_current_bundle_uses_substreams_spans_and_bounded_resources() {
        let p = plan(fixture(), None, None);
        assert_eq!(p.layout_id, "3");
        assert_eq!(p.display_id, "2");
        assert_eq!(p.cells[0].camera.as_ref().unwrap().uri, "rtsp://camera/sub");
        assert_eq!(p.cells[1].col_span, 2);
        assert_eq!(
            p.cells[1].web.as_ref().unwrap().url.as_deref(),
            Some("/dash/lobby")
        );
        assert_eq!(p.cells[3].kind, "placeholder");
        assert_eq!(p.max_camera_streams, 2);
    }
    #[test]
    fn legacy_display_is_identical_and_numeric_ids_normalize() {
        let mut old = fixture();
        let display = old["displays"][0].clone();
        old["display"] = display.clone();
        old["layouts"] = display["layouts"].clone();
        old.as_object_mut().unwrap().remove("displays");
        let current = serde_json::to_value(plan(fixture(), None, None)).unwrap();
        assert_eq!(
            serde_json::to_value(plan(old, None, None)).unwrap(),
            current
        );
    }
    #[test]
    fn expansion_releases_hidden_content_and_restores_to_substreams() {
        let p = plan(fixture(), None, Some("13"));
        assert_eq!(p.cells.len(), 1);
        assert_eq!(p.rows, 1);
        assert_eq!(p.cols, 1);
        assert_eq!(p.cells[0].row, 0);
        assert_eq!(p.cells[0].col, 0);
        let cam = p.cells[0].camera.as_ref().unwrap();
        assert_eq!(cam.uri, "rtsp://camera/main");
        assert_eq!(cam.fallback_uri.as_deref(), Some("rtsp://camera/sub"));
        assert_eq!(
            plan(fixture(), None, None).cells[0]
                .camera
                .as_ref()
                .unwrap()
                .uri,
            "rtsp://camera/sub"
        );
    }
    #[test]
    fn h265_main_falls_back_to_h264_and_h265_only_is_visible_error() {
        let mut f = fixture();
        f["cameras"][0]["streams"][0]["encoding"] = json!("H265");
        let p = plan(f.clone(), None, Some("10"));
        assert_eq!(p.cells[0].camera.as_ref().unwrap().uri, "rtsp://camera/sub");
        f["cameras"][0]["streams"][1]["encoding"] = json!("HEVC");
        f["cameras"][0]["rtsp_url"] = json!("rtsp://camera/unsafe-fallback");
        assert_eq!(plan(f, None, None).cells[0].kind, "placeholder");
    }
    #[test]
    fn revocation_closes_expansion_and_cannot_read_an_unassigned_camera() {
        let mut f = fixture();
        f["cameras"][0]["enabled"] = json!(false);
        let p = plan(f, None, Some("10"));
        assert!(p.expanded_cell_id.is_none());
        assert!(p.cells.iter().all(|c| c.camera.is_none()));
        assert!(
            plan(fixture(), None, Some("missing"))
                .expanded_cell_id
                .is_none()
        );
    }
    #[test]
    fn invalid_layout_geometry_and_unassigned_layouts_fail_closed() {
        assert!(render_plan(&parse(fixture()), Some("elsewhere"), None).is_err());
        let mut f = fixture();
        f["displays"][0]["layouts"][0]["cells"][0]["row_span"] = json!(u32::MAX);
        assert!(render_plan(&parse(f), None, None).is_err());
        let mut f = fixture();
        f["displays"][0]["layouts"][0]["cells"][0]["view_id"] = json!(11);
        assert!(render_plan(&parse(f), None, None).is_err());
        let mut f = fixture();
        f["displays"][0]["layouts"][0]["cells"][0]["col_span"] = json!(2);
        assert!(render_plan(&parse(f), None, None).is_err());
    }
    #[test]
    fn raw_html_has_isolated_origin_and_signage_preserves_storage() {
        let mut f = fixture();
        f["displays"][0]["layouts"][0]["cells"][1]["content_type"] = json!("html");
        f["displays"][0]["layouts"][0]["cells"][1]["html_content"] = json!("<h1>Signage</h1>");
        let p = plan(f, None, None);
        let web = p.cells[1].web.as_ref().unwrap();
        assert!(web.url.is_none());
        assert!(web.base_url.as_ref().unwrap().ends_with(".invalid/"));
        assert_eq!(web.html.as_deref(), Some("<h1>Signage</h1>"));
        assert!(!web.allow_audio);
        let mut f = fixture();
        f["displays"][0]["layouts"][0]["cells"][1]["web_url"] =
            json!("https://player.ablesign.tv/play");
        f["displays"][0]["layouts"][0]["cells"][1]["local_storage"] =
            json!({"screenId":"screen-one","screenToken":"secret"});
        let p = plan(f, None, None);
        let web = p.cells[1].web.as_ref().unwrap();
        assert_eq!(web.origin.as_deref(), Some("https://player.ablesign.tv"));
        assert_eq!(web.local_storage["screenId"], "screen-one");
    }
    #[test]
    fn web_limit_is_enforced_and_expansion_can_view_second_page() {
        let mut f = fixture();
        let c = &mut f["displays"][0]["layouts"][0]["cells"][2];
        c["content_type"] = json!("html");
        c["html_content"] = json!("Hello");
        assert_eq!(plan(f.clone(), None, None).cells[2].kind, "placeholder");
        assert_eq!(plan(f, None, Some("12")).cells[0].kind, "web");
    }
    #[test]
    fn only_assigned_local_actions_are_exposed() {
        for (action, params, allowed) in [
            ("layout.switch", json!({"layout_id":3}), true),
            ("layout.switch", json!({"layout_id":99}), false),
            ("reboot", json!({}), false),
        ] {
            let mut f = fixture();
            f["displays"][0]["layouts"][0]["cells"][0]["input_options"] =
                json!({"events":{"click":{"action":action,"params":params}}});
            assert_eq!(
                !matches!(plan(f, None, None).cells[0].action, CellAction::Unsupported),
                allowed
            );
        }
    }
    #[test]
    fn resolves_bf_relative_urls_but_rejects_privileged_schemes() {
        assert_eq!(
            resolve_web_url("/dash/main", "https://bf.example").as_deref(),
            Some("https://bf.example/dash/main")
        );
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "content://contacts",
            "//evil.example/path",
            "https://user:pass@evil.example",
            "\\\\evil.example",
        ] {
            assert!(
                resolve_web_url(url, "https://bf.example").is_none(),
                "{url}"
            );
        }
    }
}
