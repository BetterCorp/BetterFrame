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

Current renderer status: the app renders the active BetterFrame layout grid per display, draws each configured block, and dispatches block click/double-click/hold events. `layout.switch` actions are handled locally; undefined events are forwarded to Node-RED as `interaction.cell.<kind>`. RTSP camera playback and embedded WebView rendering are intentionally left for the next implementation pass.
