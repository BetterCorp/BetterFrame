# BetterFrame Windows Client

Windows kiosk MVP with two modes:

- `agent`: pairs with the BetterFrame server, heartbeats, fetches bundles, listens on the kiosk WebSocket, applies Windows policy gates, and supervises the desktop app.
- `app`: visible fullscreen desktop UI for the displays allowed by `windows-policy.json`.

Install logon tasks:

```powershell
cargo build --release
.\target\release\betterframe-windows-client.exe install --server http://betterframe.local
```

Run manually during development:

```powershell
cargo run -- agent --server http://localhost
cargo run -- app
```

Release MSIs include the 64-bit GStreamer runtime required by the client.
Camera cells use `d3d11videosink`; decoder selection and GPU acceleration are
handled by GStreamer/D3D11. Source builds still require the GStreamer MSVC SDK.

State lives in:

```text
%PROGRAMDATA%\BetterFrame\WindowsClient
```

`windows-policy.json` defaults host-sensitive controls off:

```json
{
  "controls": {
    "display_power": false,
    "host_sleep_wake": false,
    "volume": false,
    "host_reboot": false,
    "app_restart": true
  },
  "displays": {
    "mode": "all",
    "selected_display_names": []
  }
}
```

Set `"mode": "selected"` and list Windows display names such as `"\\\\.\\DISPLAY1"` to only take over specific monitors.

The app renders the active layout on every selected display, plays RTSP camera
cells through D3D11, and dispatches click/double-click/hold events.
`layout.switch` actions are handled locally; undefined events are forwarded to
Node-RED as `interaction.cell.<kind>`. Embedded webpage cells remain labelled
placeholders; use the Linux kiosk when webpage/HTML cells are required.
