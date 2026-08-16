# BetterFrame architecture

BetterFrame is a live-only video-wall system. The server coordinates layouts,
events, and fleet state; kiosks fetch RTSP directly from cameras or NVRs. There
is no recording path.

## Components

- **Server:** TypeScript BSB services backed by PostgreSQL. Each tenant has a
  separate schema; request-local database context prevents concurrent requests
  from sharing `search_path` state.
- **Angie edge:** the only public service. It authenticates admin, kiosk, and
  Node-RED surfaces and passes a verified tenant ID downstream.
- **Node-RED manager:** runs one Node-RED child process, Unix UID, data
  directory, credential secret, and loopback port per active tenant. Tenant
  deletion archives its flow directory before removing runtime state.
- **Linux kiosk:** Rust, GTK4, WebKitGTK, and GStreamer. It opens one fullscreen
  window per detected display and maintains warm camera/web pools for layout
  switching.
- **Windows client:** native fullscreen windows with RTSP camera cells rendered
  by GStreamer `d3d11videosink`. Web and HTML cells remain Linux-only.

## Video path

```text
camera/NVR -> RTSP -> GStreamer decodebin -> gtk4paintablesink -> display
```

The Linux sink is built with DMA-BUF and Wayland support and no longer inserts
an unconditional `videoconvert`. Actual decoder names, hardware-decoder status,
processed/dropped frames, pipeline restarts, and GPU load are reported with the
kiosk heartbeat. Decoder choice still depends on the installed GStreamer
plugins and driver, so verify the decoder field on target hardware.

Small cells select the substream by default; large cells select the main stream.
Per-cell overrides win. The design target is 32 camera cells per display, but
the operational limit is the measured decoder/GPU capacity of the deployed
machine.

## Tenant and authentication boundaries

- Session cookies contain the issuing tenant ID and are HMAC-signed. Tenant
  users cannot switch schemas; only the default-tenant platform administrator
  can administer another tenant.
- Browser mutations require a session-bound CSRF cookie and same-origin browser
  request. Operator routes are an explicit allowlist and default closed.
- API keys and kiosk/ioBOX keys resolve only inside their verified tenant.
- ONVIF callbacks use a per-camera HMAC token stored as a hash and verify the
  tenant, camera, and token together.
- Remote logs/terminal require an admin with completed TOTP and a development
  firmware channel. Debug scripts use a per-response CSP nonce.

## Node-RED routing

The server reconciles active tenants into the manager over its private control
API. Angie first authenticates `/nrdp/` and `/dash/`, then forwards the verified
tenant UUID. Public HTTP-in endpoints must include the tenant slug:

```text
/in/public/<tenant-slug>/<node-red-path>
```

Kiosk-authenticated `/in/kiosk/*` and `/dash/*` requests derive their tenant
from the kiosk key. Runtime admin endpoints cannot be reached through public
HTTP-in paths.

## Offline behavior and updates

Kiosks cache encrypted pairing state and bundles. x86 systems seal the storage
key with TPM2 when available; Windows uses machine-scope DPAPI.

Production OS updates use signed RAUC A/B bundles. Pi uses firmware tryboot;
x86 uses one shared ESP and RAUC's GRUB backend with two root slots. A boot is
reported confirmed only after the kiosk heartbeat marker causes
`rauc status mark-good` to succeed. See [full-os-ota.md](full-os-ota.md).

## Production validation

Before a wall is accepted, test its real codecs, resolutions, frame rates, NVR
connection limits, cabling, GPUs, and display topology at 32 streams, then 64,
then the target six-screen layout for 72 hours. Acceptance requires hardware
decoders, stable GPU memory/temperature, acceptable dropped frames, reconnects,
and a demonstrated failed-update rollback.
