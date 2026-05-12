# @betterframe/nodered-nodes

BetterFrame integration nodes for Node-RED. Drag-and-droppable nodes for the
BetterFrame admin REST API and kiosk event ingest.

## Nodes

| Node | Type | Purpose |
| --- | --- | --- |
| `bf-config` | config | Shared server URL + admin API key |
| `bf-event-in` | input  | Filter incoming kiosk events by topic glob |
| `bf-layout-switch` | action | Switch a display's active layout |
| `bf-power` | action | Wake / standby a kiosk display |
| `bf-fan` | action | Set fan mode (auto/pwm) on a kiosk |
| `bf-cameras` | query | Fetch the camera list |

## Authentication

All action/query nodes use an **admin-scoped API key** created in the
BetterFrame admin UI. The key is sent as `Authorization: Bearer bf-...`.
Configure once on a `bf-config` node and reference it from the others.

## Event ingest path

`bf-event-in` is a pure filter — it does not subscribe to the BF server.
Wire an upstream `http in` node on `/in/kiosk/<topic>` (BetterFrame's
authenticated kiosk-ingest endpoint, surfaced by the Angie proxy with
`auth_request` gating) and feed its `msg.payload` into `bf-event-in`.

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
