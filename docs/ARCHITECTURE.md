# BetterFrame — Architecture

## Goals

- Display up to 32 cameras simultaneously on a Pi 5 driving HDMI.
- Mixed cells: cameras, web pages (iframe), and custom HTML.
- Layouts switch with no perceptible latency, driven by API or camera events.
- Layout templates (named regions) compile to a pixel grid at runtime.
- Cameras configured via raw RTSP or ONVIF (auto-discover streams + capabilities).
- API-key-protected REST API for everything except local kiosk reads.
- Single display in v1; data model already supports multi-display.

## Process layout

Two processes on the Pi, coordinating over a local WebSocket:

```
┌──────────────────────────────────────────────────────────────────┐
│                         Raspberry Pi 5                           │
│                                                                  │
│  ┌────────────────────────────┐    ┌───────────────────────────┐ │
│  │   Kiosk (Rust + GTK4)      │    │   Backend (FastAPI)       │ │
│  │                            │    │                           │ │
│  │   Decoder pool (warm/hot)  │◄───┤   - SQLite                │ │
│  │   Grid renderer (GTK4)     │    │   - ONVIF service         │ │
│  │   WebKitGTK pool           │ WS │   - Layout API            │ │
│  │                            │    │   - Event rules engine    │ │
│  └──────────────┬─────────────┘    │   - API key auth          │ │
│                 │                  │   - Static admin UI       │ │
│                 │ RTSP             └────────────┬──────────────┘ │
└─────────────────┼───────────────────────────────┼────────────────┘
                  ▼                               │
       ┌─────────────────┐                        ▼
       │   IP cameras    │                LAN clients (port 8080)
       │  RTSP / ONVIF   │
       └─────────────────┘
```

## Why these choices

**Rust kiosk + Python backend.** Rust where the latency budget is tight
(pipeline state changes, decoder management, render loop). Python where the
ecosystem matters (`onvif-zeep`, FastAPI, alembic). They communicate via
WebSocket so neither is locked to the other's runtime.

**SQLite, not Postgres.** Total dataset is hundreds of rows. WAL mode handles
the kiosk-as-reader case fine, atomic schema migrations are easy, single-file
backup is trivial.

**GStreamer for video.** Only realistic choice on Linux for hardware-accelerated
multi-camera. Pi 5 V4L2 M2M decoder is exposed via `v4l2h264dec`; `gstreamer-rs`
bindings are mature.

## Stream warmth model

Each `(camera_id, stream_type)` pair is in one of four states:

| State    | RTSP open | Decoder running | Visible | Promote cost |
|----------|-----------|-----------------|---------|--------------|
| Hot      | yes       | yes             | yes     | 0            |
| Warm     | yes       | yes (paused)    | no      | ~1 frame     |
| Cooling  | yes       | yes             | no      | 0            |
| Cold     | no        | no              | no      | 1-3 seconds  |

The kiosk computes the needed warm set on every layout activation:

```
warm_set =
    streams_used_by_active_layout
  ∪ streams_in_layout_preload_list
  ∪ streams_used_by_priority_hot_layouts (always-on)
  ∪ streams_currently_in_cooling_window
```

Anything outside that set transitions to cooling, then cold when its timeout
expires.

## Layout templates

Templates define named regions in a normalized 12×12 grid. Layouts reference a
template and bind cameras or content to its named regions.

```yaml
templates:
  - id: 1-big-7-small
    regions:
      - { name: main,  x: 0, y: 0, w: 8, h: 8 }
      - { name: tr-1,  x: 8, y: 0, w: 4, h: 2 }
      - { name: tr-2,  x: 8, y: 2, w: 4, h: 2 }
      # ...

layouts:
  - id: front-overview
    template_id: 1-big-7-small
    bindings:
      main:  { type: camera, camera_id: 1, stream: main }
      tr-1:  { type: camera, camera_id: 2, stream: sub  }
      br-3:  { type: web,    url: "http://homeassistant.local/dashboard" }
    priority: hot
    cooling_timeout_seconds: 300
    preload_camera_ids: [4, 5]
```

Templates compile to pixel rectangles at the kiosk based on actual display
resolution. Cells under 20% of total display area default to sub-stream;
≥20% default to main; per-cell override always wins.

## Event rules engine

ONVIF cameras with event support get a persistent PullPoint subscription managed
by the backend. Events are normalized to `{camera_id, topic, payload}` and
matched against rules:

```yaml
event_rules:
  - when:
      camera_id: 5
      topic: "tns1:RuleEngine/CellMotionDetector/Motion"
      property_op: "Changed"
    do:
      action: activate_layout
      layout_id: front-door-zoom
      revert_after_seconds: 60
      revert_to: previous
    cooldown_seconds: 30
```

External systems fire synthetic events via `POST /api/events/trigger`, so
non-ONVIF inputs work through the same engine.

## Auth

- **Kiosk → backend**: WebSocket on `127.0.0.1:8000`, no auth (loopback only).
- **LAN → backend**: HTTP on `0.0.0.0:8080`, every route requires `X-API-Key`.

Two listeners, two middleware stacks, same FastAPI app.

## Multi-display readiness

Schema includes `display_id` on `layouts` and a `displays` table. v1 hard-codes
a single display row. The kiosk↔backend protocol includes `display_id` in
every activation message. Adding a second display later: new `displays` row,
new kiosk instance bound to it, no API changes.
