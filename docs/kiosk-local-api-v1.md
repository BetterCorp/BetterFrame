# Kiosk local API v1

Status: implementation contract, 20 November 2026. These `/api/v1` routes are being implemented and are not yet released. Intended for any local API client. Existing `/local/*`, `/lsh/*` and `/operator/*` routes remain available.

## Connection and authentication

Connect directly to the kiosk, using its **existing local API token** from BetterFrame kiosk administration. This is not a BF server admin token or an operator-console enrollment code.

- HTTP: `http://KIOSK:18090/api/v1` (port can be overridden by kiosk configuration).
- HTTPS: `https://KIOSK-HOST:18443/api/v1` when the kiosk's existing HTTPS operator listener is enabled. Trust the kiosk certificate using the existing certificate setup.
- Initial implementation: Linux/Pi kiosks with the local server enabled.
- Authentication: `Authorization: Bearer TOKEN`, `?key=TOKEN`, or `?token=TOKEN`. Use URL encoding for query values. If multiple credentials are supplied, every credential must be valid.
- Every route below accepts **GET and POST**. GET operation parameters go in the query; POST command parameters go in a JSON body with `Content-Type: application/json`. Authentication stays in the header or query.
- Responses use JSON except the event stream. Responses are not cacheable. New routes do not require browser cookies and do not offer anonymous access.
- IDs are opaque strings. Store IDs; do not match records by names. Names may change.

## Discovery and reads

All paths are relative to `/api/v1`. POST is also accepted for these reads; no body is needed. For POST `/events`, an optional resume cursor goes in a JSON body: `{"since":"EVENT_ID"}`.

| Path | Result |
| --- | --- |
| `/identity` | Kiosk ID/name, hostname, BF server URL, client version, platform, architecture, readiness and supported API capabilities. |
| `/catalog` | One consistent catalogue of this kiosk's devices, cameras, groups and displays with assigned layouts and cells. |
| `/devices` | `{catalog_version, devices: [...]}`. Camera/NVR IDs and names. |
| `/cameras` | `{catalog_version, cameras: [...]}`. Available cameras, including cameras without a currently visible tile. |
| `/groups` | `{catalog_version, groups: [...]}`. Synced source groups, stable origins and associated layout/camera IDs. |
| `/displays` | `{catalog_version, displays: [...]}`. Configured BF displays and their assigned layouts. |
| `/layouts` | `{catalog_version, layouts: [...]}`. Assigned layouts flattened across displays; each has `display_id`. The same layout can occur on several displays. |
| `/state` | Renderer state: actual active layouts, effective cells, standby/clear/focus state and physical output identification. |
| `/events` | Server-sent events; see below. |
| `/commands/REQUEST_ID` | Receipt for a submitted command. |

Example identity, with incidental fields omitted:

```json
{
  "api_version": "1",
  "api_instance_id": "opaque-boot-id",
  "kiosk_id": "kiosk-uuid",
  "kiosk_name": "Control room",
  "hostname": "bf-control-room",
  "platform": "linux",
  "architecture": "aarch64",
  "client_version": "release-version",
  "server_url": "https://frame.example.com",
  "ready": true,
  "capabilities": {
    "authentication": ["bearer", "query_key", "query_token"],
    "methods": ["GET", "POST"],
    "events": "sse",
    "catalog": true,
    "live_state": true,
    "command_receipts": true,
    "receipt_retention_seconds": 600,
    "event_history": 256,
    "actions": ["select_layout", "focus_camera", "clear_display", "restore_display", "standby_display", "wake_display", "identify_display"]
  }
}
```

`api_instance_id` changes when the kiosk application restarts. Identity and state remain readable before the first bundle is applied; `ready` is false. Catalogue reads return 503 until an applied bundle exists.

## Catalogue

```json
{
  "version": "opaque-bundle-version",
  "kiosk_id": "kiosk-uuid",
  "kiosk_name": "Control room",
  "devices": [{"id": "nvr-uuid", "name": "Property NVR"}],
  "cameras": [{
    "id": "camera-uuid",
    "name": "Entrance",
    "device_id": "nvr-uuid",
    "camera_number": "1",
    "type": "rtsp",
    "labels": ["entrance"],
    "capabilities": ["ptz"],
    "origin": {
      "provider": "simplevms",
      "source_id": "bf-source-uuid",
      "instance_id": "native-recorder-id",
      "external_id": "native-camera-id"
    },
    "streams": [{"id": "stream-uuid", "role": "main", "name": "Main", "width": 1920, "height": 1080, "encoding": "H264", "framerate": 25}]
  }],
  "groups": [{
    "id": "simplevms:bf-source-uuid:native-group-id",
    "name": "Entrances",
    "layout_id": "layout-uuid",
    "camera_ids": ["camera-uuid"],
    "origin": {
      "provider": "simplevms",
      "source_id": "bf-source-uuid",
      "instance_id": "native-recorder-id",
      "external_id": "native-group-id"
    }
  }],
  "displays": [{
    "id": "display-uuid",
    "name": "Wall left",
    "width_px": 1920,
    "height_px": 1080,
    "default_layout_id": "layout-uuid",
    "layouts": [{
      "id": "layout-uuid", "name": "Entrances", "is_default": true,
      "managed": true, "grid_cols": 1, "grid_rows": 1,
      "cells": [{
        "id": "view-uuid", "entity_id": null,
        "row": 0, "col": 0, "row_span": 1, "col_span": 1,
        "content_type": "camera", "camera_id": "camera-uuid",
        "stream": "auto", "fit": "contain"
      }]
    }]
  }]
}
```

Camera `origin` is null for content without an external source reference. Older bundles may have no origin/group metadata. Sources are distinguished by `source_id` and `instance_id`; external IDs alone are not globally unique. Groups are actual synced groups, distinct from NVR/device grouping. Only groups with a layout assigned to this kiosk are returned. Group membership is scoped to available cameras.

`managed` identifies source-generated layouts. BF custom layouts remain available alongside generated layouts. Local API operations select layouts or temporarily override their display; they do not edit source group configuration.

Cells use zero-based row/column indices and spans. Cell IDs use the BF view ID, with `r{row}c{col}` as a legacy fallback. The API intentionally excludes stream URLs, credentials, integration tokens, web page URLs, HTML, scripts and browser storage. It does not provide video transport; camera capability labels describe the camera, not an assertion that every capability has a v1 command.

## Live state

```json
{
  "ready": true,
  "api_instance_id": "opaque-boot-id",
  "revision": 42,
  "catalog_version": "opaque-bundle-version",
  "displays": [{
    "id": "display-uuid", "name": "Wall left",
    "active_layout_id": "layout-uuid",
    "standby": false, "cleared": false,
    "fullscreen_override": false, "overridden_cell_ids": [],
    "terminal_overlay": false, "identifying": false,
    "output": {
      "connector": "HDMI-A-1", "model": "Display model", "manufacturer": "Vendor",
      "x": 0, "y": 0, "width": 1920, "height": 1080, "scale_factor": 1
    },
    "cells": [{"id": "view-uuid", "entity_id": null, "row": 0, "col": 0, "row_span": 1, "col_span": 1, "content_type": "camera", "camera_id": "camera-uuid", "stream": "auto", "fit": "contain"}]
  }]
}
```

`cells` describes the effective rendered selection after focus/clear overrides. It is empty during standby or a terminal authentication overlay. `output` may be null; individual monitor properties may also be null. Configured display IDs and physical connector names are separate concepts.

State reflects renderer selection and display state, not proof that a camera is delivering frames. Decoder/stream health is not part of this initial contract. Changes from local controls, the BF server and expiration of overrides are reflected too. State is sampled at roughly one-second intervals; commands force an immediate sample before completion.

## Controls

Submit to `/commands` using GET or POST. Both forms use the same flat parameter names:

```http
POST /api/v1/commands
Authorization: Bearer TOKEN
Content-Type: application/json

{"request_id":"client-unique-123","action":"select_layout","display_id":"display-uuid","layout_id":"layout-uuid","expected_catalog_version":"opaque-bundle-version"}
```

Equivalent GET:

```text
/api/v1/commands?key=TOKEN&request_id=client-unique-123&action=select_layout&display_id=display-uuid&layout_id=layout-uuid&expected_catalog_version=opaque-bundle-version
```

| Action | Additional parameters | Behavior |
| --- | --- | --- |
| `select_layout` | `layout_id` required | Select an assigned layout on that display; wakes a sleeping display. |
| `focus_camera` | `camera_id` required; `cell_id`, `stream`, `duration_seconds` optional | Temporarily show an available camera in the specified cell. Omitting `cell_id` focuses it fullscreen. `stream`: `auto` (default), `main`, `sub`. Optional duration: 1–3600 seconds; omission lasts until restore/layout selection or another overriding action. |
| `clear_display` | None | Clear displayed cells while retaining the selected layout for restoration. |
| `restore_display` | None | Remove focus/clear overrides and restore the selected layout. |
| `standby_display` | None | Put the specified display in standby. |
| `wake_display` | None | Wake the specified display. |
| `identify_display` | `duration_seconds` optional | Show kiosk/display name and display ID on that display; 1–30 seconds, default 10. |

Every command requires `request_id`, `action`, and `display_id`. `expected_catalog_version` is optional; supply it to reject actions based on stale catalogue data. Unknown or inapplicable parameters are rejected. Focus, clear, restore and identify require an awake display; use `wake_display` first when necessary. Controls are rejected while terminal authentication is active.

`request_id` is 1–128 ASCII letters/digits or `-_.:`. Generate a new ID for each intended action. Retrying the identical command with the same ID returns its receipt without executing it again. Reusing an ID for a different command returns 409. Completed receipts are retained for at least ten minutes in the current application process. A restart clears receipts: clients must not assume idempotency across a changed `api_instance_id`.

A completed command returns HTTP 200:

```json
{"request_id":"client-unique-123","status":"applied","result":{"display_id":"display-uuid","layout_id":"layout-uuid"},"state_revision":43}
```

If it has not completed within approximately three seconds, HTTP 202:

```json
{"request_id":"client-unique-123","status":"accepted"}
```

Follow `/commands/client-unique-123` or `command_completed` events. `accepted` does not mean applied. `applied` acknowledges renderer processing; it does not confirm camera video delivery or a physical monitor's CEC response.

Execution failure returns HTTP 409 with a receipt:

```json
{"request_id":"client-unique-123","status":"failed","error":{"code":"command_failed","message":"layout is not assigned to this display"},"state_revision":42}
```

Command receipt reads return HTTP 200 for any existing receipt, including accepted/failed receipts; inspect `status`.

## Events and reconnects

Connect to `/events` using a streaming HTTP client. For browser `EventSource`, query-token authentication is supported:

```javascript
const events = new EventSource(`${base}/api/v1/events?key=${encodeURIComponent(token)}`);
events.addEventListener('catalog_changed', () => reloadCatalog());
events.addEventListener('state_changed', () => reloadState());
events.addEventListener('command_completed', event => handleReceipt(JSON.parse(event.data)));
events.addEventListener('reset', () => reloadCatalogAndState());
```

```text
id: opaque-boot-id:57
event: state_changed
data: {"state_revision":43}
```

- `catalog_changed`: `{catalog_version}`; refresh catalogue.
- `state_changed`: `{state_revision}`; refresh state.
- `command_completed`: full final command receipt.
- `reset`: `{catalog_version, state_revision}`; refresh catalogue and state. Sent initially and when replay is unavailable.
- Event IDs are opaque cursors. Reconnect using `Last-Event-ID` or `?since=URL_ENCODED_EVENT_ID`.
- The most recent 256 events are retained in memory. Restarts or older cursors result in `reset`; do not rely on receiving every historical event.
- SSE keepalive runs approximately every 15 seconds. Token rotation terminates streams authenticated with the previous token; obtain the new token before reconnecting.

Recommended client sequence: fetch identity, open the event stream, fetch catalogue and state, and refresh on invalidation/reset events. Re-fetch identity after reconnect to detect application restarts. Coalesce concurrent refreshes; revisions and catalogue versions allow duplicate notifications to be ignored. Polling reads remain available to clients without SSE support.

## Errors and scope

Request-level errors have this shape:

```json
{"error":{"code":"unauthorized","message":"a valid kiosk local API token is required"}}
```

Typical statuses: 400 invalid parameters, 401 invalid/missing token, 404 unknown resource/receipt, 409 command conflict/failure, 413 oversized command body (limit 16 KiB), 429 receipt capacity reached, 503 catalogue not ready.

The token authorizes this kiosk's assigned displays/layouts and available cameras. It does not authorize assignment to other kiosks, editing layouts/groups, source configuration, server administration or token creation. Existing PTZ/snapshot/operator routes retain their existing contracts; new PTZ/media/playback commands are outside this first v1 increment.
