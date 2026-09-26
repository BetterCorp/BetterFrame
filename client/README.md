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

### Windows installation and startup

Install the Windows MSI, then open **BetterFrame** from the Start menu to begin
pairing. The display shows the pairing code; no terminal or separate `install`
command is needed. Double-clicking the installed executable also starts the app.

The MSI enables BetterFrame at Windows sign-in through the machine-wide
`HKLM\Software\Microsoft\Windows\CurrentVersion\Run\BetterFrame` entry.
The agent and display run without a console window, in the signed-in user's
session. Repeated launches in that session reuse the running agent. MSI repair
restores the startup entry, upgrades update its executable path, and uninstall
removes it. Windows Settings / Task Manager **Startup apps** can disable startup.

Use one dedicated Windows account for the kiosk: enrollment is machine-wide,
with protected state restricted to the account that created it, administrators,
and SYSTEM. Sign in with that same account after reboot. The installer does not
configure automatic Windows sign-in, and the display cannot run before sign-in.
A Windows service runs in a noninteractive session and cannot display this UI.

The older CLI `install` / `uninstall` commands manage a separate, optional
scheduled task; they are not needed for MSI installations. If you previously
created that task, run the CLI `uninstall` command once as administrator to remove
it (this does not uninstall the MSI). Normal application removal uses Windows
**Installed apps**. Explicit CLI commands such as `agent` and `self-test` still
attach to an existing terminal; for scripts use PowerShell `Start-Process -Wait
-PassThru` to wait and inspect the exit code of the GUI executable.

The MSI also installs the independent **BetterFrameUpdater** service for automatic
app updates and rollback through BF-hosted, vendor-signed MSI packages. Updates
respect saved maintenance windows and can recover without working enrollment.
See [Windows updates and recovery](../docs/windows-updates.md) for first-deployment
requirements, retained installers, and recovery behavior.
