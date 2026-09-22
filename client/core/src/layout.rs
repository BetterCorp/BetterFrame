use std::collections::HashMap;
use serde_json::Value;
use url::Url;

use super::bundle::{BundleCell, BundleDisplayWithLayouts, BundleLayout, KioskBundle};

pub const NO_LAYOUTS_ASSIGNED_MESSAGE: &str =
    "go into BetterFrame and assign layouts to this display";

pub fn initial_layout_id(display: &BundleDisplayWithLayouts) -> Option<String> {
    display
        .default_layout_id
        .as_ref()
        .filter(|id| display.layouts.iter().any(|layout| &layout.id == *id))
        .cloned()
        .or_else(|| {
            display
                .layouts
                .iter()
                .find(|layout| layout.is_default)
                .map(|layout| layout.id.clone())
        })
        .or_else(|| display.layouts.first().map(|layout| layout.id.clone()))
}

pub fn active_layout<'a>(
    display: &'a BundleDisplayWithLayouts,
    active_layouts: &HashMap<String, String>,
) -> Option<&'a BundleLayout> {
    let active = active_layouts
        .get(&display.id)
        .cloned()
        .or_else(|| initial_layout_id(display))?;
    display
        .layouts
        .iter()
        .find(|layout| layout.id == active)
        .or_else(|| display.layouts.first())
}

pub fn resolve_display<'a>(
    bundle: &'a KioskBundle,
    native_name: &str,
    native_index: usize,
) -> Option<&'a BundleDisplayWithLayouts> {
    let suffix = format!(": {native_name}");
    bundle
        .displays
        .iter()
        .find(|display| display.name == native_name || display.name.ends_with(&suffix))
        .or_else(|| bundle.displays.get(native_index))
}

/// Whether a bundle refresh can keep a display's existing widgets and overrides.
/// Inactive layouts still enter the cached bundle for the next layout switch.
pub fn display_render_unchanged(
    previous: &KioskBundle,
    next: &KioskBundle,
    display_id: &str,
    active_id: Option<&str>,
) -> bool {
    fn inputs(bundle: &KioskBundle, display_id: &str, active_id: Option<&str>) -> Option<Value> {
        let displays = bundle.normalized_displays();
        let display = displays.iter().find(|d| d.id == display_id)?;
        let active_id = active_id?;
        let layout = display.layouts.iter().find(|l| l.id == active_id)?;
        let cameras: std::collections::BTreeMap<_, _> = bundle.cameras.iter()
            .filter(|camera| layout.preload_camera_ids.contains(&camera.id)
                || layout.cells.iter().any(|cell| cell.camera_id.as_deref() == Some(&camera.id)))
            .map(|camera| (camera.id.as_str(), camera))
            .collect();
        Some(serde_json::json!({
            "width": display.width_px,
            "height": display.height_px,
            "layout": layout,
            "cameras": cameras,
            "operator_console": bundle.operator_console,
            "tenant": bundle.tenant_slug,
        }))
    }
    let old = inputs(previous, display_id, active_id);
    old.is_some() && old == inputs(next, display_id, active_id)
}

/// Pool entries are keyed by camera ID and stream role, so their configuration
/// must also match before an old decoder/RTSP connection can be reused.
pub fn unchanged_camera_ids(previous: Option<&KioskBundle>, next: &KioskBundle) -> std::collections::HashSet<String> {
    let Some(previous) = previous else { return Default::default() };
    let old: HashMap<_, _> = previous.cameras.iter().map(|camera| (&camera.id, camera)).collect();
    next.cameras.iter().filter(|camera| {
        old.get(&camera.id).is_some_and(|prior| {
            serde_json::to_value(prior).ok() == serde_json::to_value(camera).ok()
        })
    }).map(|camera| camera.id.clone()).collect()
}

pub fn configured_cell_action(cell: &BundleCell, kind: &str) -> Option<(String, Value)> {
    let event = cell.input_options.as_ref()?.get("events")?.get(kind)?;
    Some((
        event.get("action")?.as_str()?.to_string(),
        event
            .get("params")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    ))
}

pub fn resolve_web_url(value: &str, server_url: &str) -> Option<String> {
    let value = value.trim();
    if Url::parse(value).is_ok() {
        return Some(value.to_string());
    }
    Url::parse(&format!("{}/", server_url.trim_end_matches('/')))
        .ok()?
        .join(value)
        .ok()
        .map(String::from)
}

pub fn same_origin(url: &str, server_url: &str) -> bool {
    match (Url::parse(url), Url::parse(server_url)) {
        (Ok(url), Ok(server)) => url.origin() == server.origin(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundle::BundleDisplayWithLayouts;

    #[test]
    fn refresh_only_invalidates_the_active_display_content() {
        let previous: KioskBundle = serde_json::from_value(serde_json::json!({
            "kiosk_id": "k", "kiosk_name": "Kiosk", "version": "1", "cameras": [],
            "displays": [{
                "id": "d", "name": "Display", "width_px": 1920, "height_px": 1080,
                "idle_timeout_seconds": 0, "sleep_timeout_seconds": 0,
                "layouts": [
                    {"id": "active", "name": "Active", "grid_cols": 1, "grid_rows": 1,
                     "priority": "normal", "is_default": true, "resets_idle_timer": true, "cells": []},
                    {"id": "other", "name": "Other", "grid_cols": 1, "grid_rows": 1,
                     "priority": "normal", "is_default": false, "resets_idle_timer": true, "cells": []}
                ]
            }]
        })).unwrap();
        let unchanged = |next: &KioskBundle| display_render_unchanged(&previous, next, "d", Some("active"));
        let mut next = previous.clone();
        next.version = "2".into();
        assert!(unchanged(&next), "unassigned edits / repeated notifications keep the display");
        next.displays[0].layouts[1].grid_cols = 2;
        assert!(unchanged(&next), "inactive assigned layout edits keep the display");
        next.displays[0].layouts.remove(1);
        assert!(unchanged(&next), "removing an inactive assignment keeps the display");
        next.displays[0].layouts[0].grid_cols = 2;
        assert!(!unchanged(&next), "active layout edits must render");
        next = previous.clone();
        next.displays[0].layouts.remove(0);
        assert!(!unchanged(&next), "removing the active assignment must render a fallback");
        next = previous.clone();
        next.displays[0].width_px = 1280;
        assert!(!unchanged(&next));
        next.displays.clear();
        assert!(!unchanged(&next));

        let mut preloaded = previous.clone();
        preloaded.cameras.push(serde_json::from_value(serde_json::json!({
            "id": "preload", "name": "Preload", "type": "onvif", "stream_policy": "auto",
            "streams": [{"id": "s", "name": "Sub", "role": "sub", "rtsp_uri": "rtsp://old/sub"}]
        })).unwrap());
        preloaded.displays[0].layouts[0].preload_camera_ids.push("preload".into());
        assert!(unchanged_camera_ids(Some(&preloaded), &preloaded).contains("preload"));
        let mut changed = preloaded.clone();
        changed.cameras[0].streams[0].rtsp_uri = "rtsp://new/sub".into();
        assert!(!display_render_unchanged(&preloaded, &changed, "d", Some("active")));
        assert!(!unchanged_camera_ids(Some(&preloaded), &changed).contains("preload"));
        changed = preloaded.clone();
        changed.cameras[0].playback_password_encrypted = Some("new-encrypted-value".into());
        assert!(!display_render_unchanged(&preloaded, &changed, "d", Some("active")));
        assert!(!unchanged_camera_ids(Some(&preloaded), &changed).contains("preload"));
        changed.cameras.clear();
        assert!(!display_render_unchanged(&preloaded, &changed, "d", Some("active")));
        assert!(unchanged_camera_ids(Some(&preloaded), &changed).is_empty());
        assert!(unchanged_camera_ids(None, &preloaded).is_empty());
    }

    #[test]
    fn selects_default_then_first_layout() {
        let mut display: BundleDisplayWithLayouts = serde_json::from_value(serde_json::json!({
            "id": 1,
            "name": "Main",
            "width_px": 1920,
            "height_px": 1080,
            "idle_timeout_seconds": 0,
            "sleep_timeout_seconds": 0,
            "layouts": [{
                "id": 7,
                "name": "Default",
                "grid_cols": 1,
                "grid_rows": 1,
                "priority": "normal",
                "cooling_timeout_seconds": null,
                "idle_timeout_seconds": null,
                "is_default": true,
                "resets_idle_timer": true,
                "cells": []
            }]
        }))
        .unwrap();
        assert_eq!(initial_layout_id(&display).as_deref(), Some("7"));
        display.default_layout_id = Some("missing".into());
        assert_eq!(initial_layout_id(&display).as_deref(), Some("7"));
        assert_eq!(active_layout(&display, &HashMap::new()).unwrap().id, "7");
        display.layouts[0].is_default = false;
        assert_eq!(initial_layout_id(&display).as_deref(), Some("7"));
        // An assigned layout can intentionally have no cells. Only removing
        // the assignment should transition to the configuration instruction.
        assert!(active_layout(&display, &HashMap::new()).unwrap().cells.is_empty());
        display.layouts.clear();
        let stale_selection = HashMap::from([(display.id.clone(), "7".into())]);
        assert_eq!(initial_layout_id(&display), None);
        assert!(active_layout(&display, &stale_selection).is_none());
    }

    #[test]
    fn credentials_only_attach_to_the_configured_origin() {
        assert!(same_origin(
            "https://frame.example/admin",
            "https://frame.example"
        ));
        assert!(!same_origin(
            "https://frame.example.evil.test",
            "https://frame.example"
        ));
        assert!(same_origin(
            "https://frame.example/dash/main",
            "https://frame.example"
        ));
        assert!(same_origin(
            "http://betterframe.local/dash/main",
            "http://betterframe.local"
        ));
        assert!(!same_origin(
            "http://evil.betterframe.local/dash/main",
            "http://betterframe.local"
        ));
        assert_eq!(
            resolve_web_url("dash/main", "https://frame.example").as_deref(),
            Some("https://frame.example/dash/main")
        );
    }
}
