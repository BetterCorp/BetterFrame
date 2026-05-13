# @betterframe/nodered-nodes

BetterFrame integration nodes for Node-RED. Drag-and-droppable nodes for the
BetterFrame admin REST API and kiosk event ingest.

## Nodes

| Node | Category | Purpose |
| --- | --- | --- |
| `bf-server-config` | config | Shared server URL + admin API key |
| `bf-kiosk-camera-event` | Triggers | Filter incoming kiosk camera events (default `camera.*`) |
| `bf-trigger-display-power` | Triggers | Fires on `display.power.changed` |
| `bf-trigger-layout-changed` | Triggers | Fires on `layout.changed` |
| `bf-trigger-kiosk-changed` | Triggers | Fires on `kiosk.changed` (connect/disconnect/heartbeat) |
| `bf-trigger-camera-changed` | Triggers | Fires on `camera.changed` (created/updated/deleted) |
| `bf-layout-switch` | BetterFrame | Switch a display's active layout |
| `bf-power` | BetterFrame | Wake / standby a kiosk display |
| `bf-fan` | BetterFrame | Set fan mode (auto/pwm) on a kiosk |
| `bf-cameras` | BetterFrame | Fetch the camera list |
| `bf-config-get` | BetterFrame | Fetch BF state (displays/kiosks/cameras/layouts/entities, by id or full list) |
| `bf-config-set` | BetterFrame | Mutate BF state (default layout, enabled, priority, name) |

## Authentication

All action/query nodes use an **admin-scoped API key** created in the
BetterFrame admin UI. The key is sent as `Authorization: Bearer bf-...`.
Configure once on a `bf-server-config` node and reference it from the others.

## Event ingest path

Trigger nodes are pure filters — they do not subscribe to the BF server.
Wire an upstream `http in` node on `/in/kiosk/<topic>` (BetterFrame's
authenticated kiosk-ingest endpoint, surfaced by the Angie proxy with
`auth_request` gating) and feed its `msg.payload` into the matching
`bf-trigger-*` node. The server emits these topics from coordinator-ws
(kiosk WS lifecycle) and the admin routes (layout/power/camera mutations).

## Installation

### Dev (single-host BetterFrame install)

```sh
# Symlink the package into Node-RED's user dir so edits hot-reload.
ln -s "$(pwd)/nodered" ~/.node-red/node_modules/@betterframe/nodered-nodes
# Restart Node-RED.
```

### Docker compose

The compose stack mounts `nodered-data` as `/data`. Either:

- bake the package into the Node-RED image by extending the Dockerfile with
  `npm install /repo/nodered`, or
- mount `./nodered` into `/data/node_modules/@betterframe/nodered-nodes` and
  restart the container.
