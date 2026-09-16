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

Trigger nodes are **self-contained** and subscribe to their authenticated
`POST /api/internal/<topic>` route. No upstream `http in` node is required.

Every BetterFrame trigger node now requires selecting a `bf-server-config`.
The trigger only emits events whose `tenant_slug` matches that config.

The BetterFrame server's `nodered-bridge.forward(topic, payload)` posts
events to the authenticated tenant runtime at `/api/internal/<topic>`. Each trigger
node listens on its own fixed topic:

| Node | Internal route |
| --- | --- |
| `bf-trigger-display-power` | `POST /api/internal/display.power.changed` |
| `bf-trigger-layout-changed` | `POST /api/internal/layout.changed` |
| `bf-trigger-kiosk-changed` | `POST /api/internal/kiosk.changed` |
| `bf-trigger-camera-changed` | `POST /api/internal/camera.changed` |
| `bf-trigger-status` | `POST /api/internal/kiosk.status` |
| `bf-kiosk-camera-event` | `POST /api/internal/camera.event` |

The server emits these topics from coordinator-ws and the admin/API routes.
The runtime dispatcher fans each event out to matching trigger subscribers.

Public HTTP-in endpoints must use `/in/public/<tenant-slug>/<flow-path>`.
Kiosk-authenticated HTTP-in endpoints use `/in/kiosk/<flow-path>`. These routes
cannot provide anonymous dashboard access. Unmatched root paths now require
an authenticated admin or kiosk; move intentionally public webhook callers to
the explicit public route. Editor and internal-event paths remain reserved.

Each trigger node also offers an optional ID filter (display_id / kiosk_id /
camera_id) so you can drop one node per entity without a downstream switch.
Tenant scoping happens before those ID filters.

The Layout Changed trigger also has a **Source** dropdown: **All (not set)**
(the default, including existing flows), **Server**, or **Kiosk**. Server events
report server-issued switches; kiosk events report kiosk-side layout changes,
including local switches and idle returns. All sources can produce two events
for one server-issued switch. Select a source to receive just that side.
The output preserves `msg.payload.source` (`null` when absent); events without
a source pass only when the dropdown is unset.

## Tenant dashboards

Each tenant has its own Node-RED runtime and flow directory. The editor and
all dashboard URLs, assets, HTTP APIs and Socket.IO connections require an
authenticated tenant. Missing identity never selects the default runtime.
Sign in to BetterFrame, select the tenant, then open its dashboard preview.
Configured FlowFuse base/page paths (for example `/dashboard/page1`) are kept;
a readable page name is not a credential.

**Sync dashboards** discovers FlowFuse `ui-page` nodes belonging to valid
`ui-base` nodes in the selected tenant. Containers are not pages. Existing
`/dash/<page-id>` entity links redirect to that tenant's current configured
page path. Missing IDs return 404; sync marks stale entities **Unavailable in
Node-RED** while preserving their layout assignments and notes. Resync after
editing pages. Runtime/discovery errors fail the sync instead of reporting an
empty successful result. Legacy classic Dashboard tabs are not imported as
FlowFuse pages.

Dashboard middleware also rejects access through public webhook aliases,
including custom dashboard roots and socket connections. Platform browser
cookies are not forwarded to tenant runtimes; public webhook callers should
use explicit webhook credentials rather than browser-cookie authentication. Only configured
HTTP-in endpoints should be exposed through those public URLs.

Kiosks use their authenticated tenant. Android's separate display-session
cookie is host-only and covers configured dashboard paths; the server still
checks current assigned page IDs on each request. It never authorizes device
APIs. Android Socket.IO remains disabled until FlowFuse can enforce
per-display channel subscriptions; this change does not enable dynamic
Android dashboards.

The new proxy and Node-RED manager must be deployed together. Restarting the
manager regenerates dashboard protection in every tenant runtime. No tenant
flow files are deleted or copied between tenants by this change.

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
