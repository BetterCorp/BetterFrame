# BetterFrame client

One Rust client produces the Linux kiosk and Windows desktop artifacts.

```text
core/src/                platform-free bundle, command, layout, protocol, and state logic
src/platform/linux/      GTK/WebKitGTK, Linux host controls, GPIO, and RAUC
src/platform/windows/    Win32/WebView2 renderer, Windows host policy, and DPAPI storage
src/main.rs              target selection and process bootstrap
```

The Linux release is built from this directory and renamed
`betterframe-kiosk` for the existing systemd/image contract. The Windows MSI
installs the same package as `betterframe-windows-client.exe`.

```bash
cargo test --manifest-path core/Cargo.toml
cargo build --release
```

Windows source builds require the GStreamer MSVC SDK. After installation, run
`betterframe-windows-client.exe self-test` to verify DPAPI, protected state,
GStreamer/D3D11, WebView2, and display enumeration.

## Server discovery and regional routing

Linux and Windows try the on-device server, LAN discovery, then
`https://frame.betterportal.net`. An explicit server option uses the same
anonymous `/healthz` discovery before enrollment. The canonical hostname may
redirect to a regional HTTPS origin; clients follow at most five validated
discovery redirects and save the terminal origin before sending pairing data.
Explicit local HTTP servers remain supported, including direct API ports
without `/healthz` (HTTP 404).

Saved origins are reused on restart. Before enrollment starts, an explicit server
option can correct a saved discovery result. Once a pairing code, polling secret
or device identity exists, its saved origin takes precedence over launch options.
Subsequent pairing, device API and WebSocket requests use the regional origin;
authenticated HTTP requests never follow redirects. Changing launch arguments
does not move existing credentials to another server: reset enrollment first
to deliberately choose a new origin. Existing paired Linux/Windows identities
remain pinned and can start from their cache while offline; this change does
not migrate already-paired origins through discovery.

Discovery rejects credential-bearing URLs, HTTPS downgrades, cross-origin
cleartext redirects and locations containing a query, fragment or unrelated
path. Camera and webpage navigation retain their own existing behavior.

## Application identity

BetterFrame uses `cloud.betterportal.frame` as its canonical application ID for
Android/Android TV and Linux GTK. See [application identity and domain conventions](../docs/application-identity.md).
