use std::collections::HashMap;

use serde_json::Value;
use url::Url;

use super::bundle::{BundleCell, BundleDisplayWithLayouts, BundleLayout, KioskBundle};

pub fn initial_layout_id(display: &BundleDisplayWithLayouts) -> Option<String> {
    display
        .default_layout_id
        .clone()
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
        assert_eq!(active_layout(&display, &HashMap::new()).unwrap().id, "7");
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
        assert_eq!(
            resolve_web_url("dash/main", "https://frame.example").as_deref(),
            Some("https://frame.example/dash/main")
        );
    }
}
