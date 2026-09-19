# BetterFrame client

One Rust client produces the Linux kiosk and Windows desktop artifacts.

For standalone Linux installations, run `sudo ./setup.sh` from the repository
root. See [Linux installation and repair](../docs/linux-install.md) for desktop
startup, dedicated kiosk mode, and update prerequisites.

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
to deliberately choose a new origin. Existing custom/regional paired origins
remain pinned. Older identities saved against the known canonical
`https://frame.betterportal.net` entrypoint migrate through anonymous discovery:
cached content starts immediately, while a background retry loop waits for
regional discovery and durable origin persistence before heartbeat, bundle
retrieval and WebSocket loops start. Cached display interactions can still
contact the original configured origin; their HTTP clients refuse redirects.
Linux journals updates to identity, pending enrollment and `server.url` so an
interrupted migration is completed on restart. Windows atomically replaces its
single protected state record. Device keys, polling secrets and cached content
are preserved; unavailable discovery never resets enrollment.

Discovery rejects credential-bearing URLs, HTTPS downgrades, cross-origin
cleartext redirects and locations containing a query, fragment or unrelated
path. Camera and webpage navigation retain their own existing behavior.

## Application identity

BetterFrame uses `cloud.betterportal.frame` as its canonical application ID for
Android/Android TV and Linux GTK. See [application identity and domain conventions](../docs/application-identity.md).
