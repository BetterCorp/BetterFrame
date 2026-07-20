# @betterframe/nodered-nodes

BetterFrame integration nodes for Node-RED. Drag-and-droppable nodes for the
BetterFrame admin REST API and kiosk event ingest.

## Nodes

| Node | Category | Purpose |
| --- | --- | --- |
| `bf-server-config` | config | Per-tenant server URL + admin API key |
| `bf-kiosk-camera-event` | Triggers | Filter incoming kiosk camera events (default `camera.*`) |
| `bf-trigger-display-power` | Triggers | Fires on `display.power.changed` |
| `bf-trigger-layout-changed` | Triggers | Fires on `layout.changed` |
| `bf-trigger-kiosk-changed` | Triggers | Fires on `kiosk.changed` (connect/disconnect/heartbeat) |
| `bf-trigger-camera-changed` | Triggers | Fires on `camera.changed` (created/updated/deleted) |
| `bf-trigger-status` | Triggers | Fires on `kiosk.status` (heartbeat-only telemetry; optional kiosk_id filter) |
| `bf-layout-switch` | BetterFrame | Switch a display's active layout |
| `bf-power` | BetterFrame | Wake / standby a kiosk display |
| `bf-cameras` | BetterFrame | Fetch the camera list |
| `bf-config-get` | BetterFrame | Fetch BF state (displays/kiosks/cameras/layouts/entities, by id or full list) |
| `bf-config-set` | BetterFrame | Mutate BF state (default layout, enabled, priority, name) |
| `bf-status` | BetterFrame | Fetch current kiosk state by ID (telemetry, last_seen_at, etc.) |
| `bf-snapshot` | BetterFrame | Fetch a JPEG snapshot for a camera entity (binary Buffer payload) |

## Authentication

All action/query nodes use an **admin-scoped API key** created in the
BetterFrame admin UI. The key is sent as `Authorization: Bearer bf-...`.
Each `bf-server-config` also carries a tenant slug and sends
`X-BetterFrame-Tenant: <tenant_slug>`. Configure one `bf-server-config` per
tenant and reference the matching config from action/query/trigger nodes.

Auto-managed tenant configs appear in Node-RED as:

- `BetterFrame (Default)`
- `BetterFrame (<tenant name>)`

BetterFrame keeps those auto-managed config nodes in sync for active tenants.
Manual/custom config nodes are still supported if you set `tenant_slug`
explicitly.

## Event ingest path

Trigger nodes are **self-contained** — each one registers its own
`POST /in/<topic>` handler on Node-RED's user-facing HTTP server (via
`RED.httpNode.post`) when the flow is deployed. You do **not** need to wire
an upstream `http in` node anymore.

Every BetterFrame trigger node now requires selecting a `bf-server-config`.
The trigger only emits events whose `tenant_slug` matches that config.

The BetterFrame server's `nodered-bridge.forward(topic, payload)` posts
events directly to `http://<nodered-host>:1880/in/<topic>`. Each trigger
node listens on its own fixed topic:

| Node | Internal route |
| --- | --- |
| `bf-trigger-display-power` | `POST /in/display.power.changed` |
| `bf-trigger-layout-changed` | `POST /in/layout.changed` |
| `bf-trigger-kiosk-changed` | `POST /in/kiosk.changed` |
| `bf-trigger-camera-changed` | `POST /in/camera.changed` |
| `bf-trigger-status` | `POST /in/kiosk.status` |
| `bf-kiosk-camera-event` | `POST /in/camera.event` |

The server emits these topics from coordinator-ws (kiosk WS lifecycle) and
the admin routes (layout/power/camera mutations). Multiple instances of the
same trigger node on the same canvas are fine — Express runs all matching
handlers in registration order.

If the Angie proxy fronts Node-RED, the otherwise-unmatched root paths
(public HTTP-in URLs) and the `/in/kiosk/<topic>` (kiosk-key gated) /
`/in/public/<topic>` (public, rate-limited) routes are still available
for user-authored flows that use stock `http in` nodes — those layers
strip the prefix before proxying. The trigger nodes' fixed
`/in/<topic>` routes are reserved for internal server-to-Node-RED
delivery and are not exposed through the proxy's gated surfaces by
default.

Each trigger node also offers an optional ID filter (display_id / kiosk_id /
camera_id) so you can drop one node per entity without a downstream switch.
Tenant scoping happens before those ID filters.

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
