# BetterFrame

BetterFrame (BF) turns Linux PCs and Raspberry Pi 5 devices into centrally managed
camera walls and mixed-content displays. Create layouts containing live cameras,
webpages, HTML, and signage; assign them to displays; and switch them from the
admin UI, automation, or local LAN controls.

The server manages configuration, pairing, and commands. Native clients render
content and pull camera streams directly from cameras or NVRs. Linux clients
cache their assigned configuration for offline operation and keep media pipelines
warm for responsive layout changes. Actual camera capacity depends on the
hardware, stream resolution, codecs, and available decoders.

## Contents

- [Components and platforms](#components-and-platforms)
- [Install the server](#install-the-server)
- [Install the Linux app](#install-the-linux-app)
- [Other client installation options](#other-client-installation-options)
- [Pair and configure a display](#pair-and-configure-a-display)
- [App and OS updates](#app-and-os-updates)
- [Local controls and automation](#local-controls-and-automation)
- [Operations and troubleshooting](#operations-and-troubleshooting)
- [Development](#development)
- [Documentation](#documentation)
- [License](#license)

## Components and platforms

| Component | Purpose | Deployment |
| --- | --- | --- |
| BF server | Admin UI, API, device enrollment, layouts, tenant data, releases | Docker Compose with PostgreSQL 18 |
| Angie | Public HTTP entry point and authenticated reverse proxy | Included in the server stack |
| Node-RED | Per-tenant automation and dashboards | Included in the server stack |
| Linux app | Native GTK4/WebKitGTK/GStreamer display client | PC x86_64 or Raspberry Pi 5 aarch64 |
| Managed Linux image | Dedicated appliance with signed A/B OS updates | PC x86_64 or Raspberry Pi 5 |
| Windows app | Native Windows adapter over the shared Rust core | MSI; experimental, pending runtime qualification |
| Android viewer | Assigned camera, web, HTML, and signage layouts | Android/Android TV APK; experimental |
| ioBOX | Physical input integration | Supported Ethernet/Wi-Fi firmware variants |

Linux supports ONVIF camera integration, PTZ controls, multiple display windows,
and local hardware integration where the device provides it. Managed images also
include the MediaMTX gateway for Operator Console live preview and optional
SimpleVMS recording/playback. The standalone Linux installer asks whether to install MediaMTX (recommended)
and remembers that choice for future repairs.

Run the server separately from displays for a multi-device installation. A
combined server/client host is possible, but restarting or losing that host
affects both the display and its management services.

## Install the server

Requirements: Docker Engine with the Compose plugin, Git, a reachable host, and
persistent storage. The provided Compose configuration builds the server, proxy,
and Node-RED containers and runs PostgreSQL 18.

```sh
git clone https://github.com/BetterCorp/BetterFrame.git
cd BetterFrame
cp .env.example .env
```

Edit `.env` before starting:

| Variable | Purpose |
| --- | --- |
| `BF_PG_PASSWORD` | A unique, random database password |
| `BF_NODERED_MANAGER_SECRET` | A separate random secret of at least 32 characters |
| `BF_HTTP_PORT` | Published HTTP port; defaults to `80` |
| `TZ` | Server timezone; defaults to `UTC` |
| `BF_CLIENT_FIRMWARE_PUBLIC_KEY` | Vendor public PEM for verifying imported app releases |

Generate random values with `openssl rand -hex 32`. Keep `.env` private and out of
version control. The app verification key is public; preserve its PEM header,
footer, and line breaks when entering it into deployment environment settings.
The private release signing key belongs only in the release system.

```sh
docker compose up -d --build
docker compose ps
```

Open `http://<server-host>/setup` (include your configured port if it is not 80)
and create the initial administrator. Usernames require 3–64 characters and
passwords at least 12 characters. Continue through authentication setup in the
admin UI, then use `/admin` to manage the installation.

Only Angie publishes a host port. Keep PostgreSQL, Node-RED, and the backend
listeners on the internal Compose network. For an HTTPS deployment, put your TLS
edge in front of Angie and point clients at that public proxy URL. The
[deployment guide](deploy/README.md) covers the route boundaries and Coolify
configuration using [docker-compose.coolify.yml](docker-compose.coolify.yml).

Persistent Compose volumes hold PostgreSQL data, server keys/state, and Node-RED
flows. Back them up together; see [backup and recovery](docs/backup-recovery.md).

## Install the Linux app

Copy and paste this **one-line install** into a terminal on Ubuntu/Debian or
Fedora. It installs download tools and all BF prerequisites automatically;
no Git checkout or manual download is needed:

```sh
sudo bash -c 'set -eu; if command -v apt-get >/dev/null; then apt-get update; apt-get install -y ca-certificates curl util-linux; elif command -v dnf >/dev/null; then dnf install -y ca-certificates curl util-linux; else echo "Ubuntu/Debian or Fedora required" >&2; exit 1; fi; f=$(mktemp /tmp/bf-setup.XXXXXXXX); trap "rm -f -- $f" EXIT; curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 --proto =https --proto-redir =https https://raw.githubusercontent.com/BetterCorp/BetterFrame/master/setup.sh -o "$f"; bash "$f" "$@"' bf-setup
```

Run it as your normal desktop user with sudo access. The installer downloads to
a private temporary file, runs only after a successful HTTPS download, and is
removed afterward. Prompts remain interactive. Repeat the same command to repair
and update BF using the saved settings; append `--yes` after `bf-setup` to run
without prompts, or `--channel dev` to choose the dev channel.

If you already have a checkout, `sudo ./setup.sh` works too. The commands below
show this local-file form; the one-line command accepts the same options.

The installer:

1. Asks which existing user will run BF and which startup mode to use.
2. Installs runtime prerequisites using apt on Ubuntu/Debian or dnf on
   Fedora-family distributions, plus the checksum-verified MediaMTX gateway
   when selected (recommended by default).
3. Downloads the latest signed app in the chosen stable/beta/dev channel, or
   installs a release/executable explicitly selected for this run.
4. Checks the executable architecture and required libraries before replacing
   a working installation.
5. Installs the app at a stable path with the permissions needed for app updates,
   preserves pairing state, and configures startup and rollback.

**Desktop mode is the default.** BF starts when the selected user logs into their
existing graphical desktop. It does not configure automatic login. The service
restarts the app after a successful update or a process failure.

**Dedicated mode is optional.** Select it at the prompt to replace graphical
login with a fullscreen Cage kiosk. If a desktop is active, this takes effect on
the next boot; reruns on a dedicated kiosk restart the app immediately. Setup does not reboot the
machine or disable SSH. This remains a standalone app installation; it does not
convert the existing OS into a managed BF image.

For an unattended desktop installation:

```sh
sudo ./setup.sh --yes --user kiosk --mode desktop --version latest
```

Use an existing regular account in place of `kiosk`. `latest` selects the latest release in the saved channel (initially stable).
Use `--channel beta` or `--channel dev` to select another channel, or
`--version VERSION` for a particular release.
The installer requires Ubuntu 24.04+, Debian 13+, or a Fedora-family system
providing GTK 4.14+ and WebKitGTK 6.0. Older Ubuntu/Debian releases are rejected
with an explanation; the loaded runtime libraries are also checked before any
app service is stopped or executable replaced. Setup does not upgrade the OS.

New PC releases use the Ubuntu 24.04 library baseline. Older releases and older
distributions can have incompatible libraries, which setup detects and reports.
ARM release downloads currently target Raspberry Pi 5 specifically.

### Repeatable repair and updates

Rerun setup to bring BF back to its expected configuration and update the app:

```sh
sudo ./setup.sh --yes
```

Setup remembers the runtime user, startup mode, and release channel. It repairs
managed startup files and permissions, handles masked/stopped/failed services,
clears stale app-update state, and restarts the app. It preserves pairing, keys,
and OS-update state. A concurrent setup run is rejected; unchanged configuration
creates no additional backups. Download or verification failures leave the
existing app in place. Immediate startup failure attempts restoration of the
previous executable and reports failure instead of claiming success.

Use `sudo ./setup.sh --yes --channel dev` to switch future updates to the dev
channel. The one-line install fetches current setup logic on every run. If using
a local checkout instead, update it before running setup.

### Repair a manual installation

The normal setup command downloads a replacement even when the existing binary
is missing or broken. To use a particular trusted executable instead, pass it
explicitly:

```sh
sudo ./setup.sh --user YOUR_USER --binary /absolute/path/to/betterframe-kiosk-VERSION-betterframe-pc-x86_64
```

`--binary` trusts the local executable you supply. Downloaded releases require a
valid vendor signature and matching checksum. `--no-start` defers app startup
and requires existing BF services to be stopped. Existing pairing and keys stay in `/var/lib/betterframe/kiosk`.

See [Linux installation and repair](docs/linux-install.md) for all options,
startup behavior, paths, and restoring graphical login after dedicated mode.

### Point the app at your server

Clients perform server discovery and can fall back to the public BF origin. To
set an explicit server for a desktop installation, run these commands as the
runtime user:

```sh
systemctl --user edit betterframe.service
```

Add:

```ini
[Service]
Environment="BETTERFRAME_SERVER=https://your-bf-server.example"
```

Then run `systemctl --user restart betterframe.service` from the graphical
session. In dedicated mode, use `sudo systemctl edit betterframe-kiosk.service`
and `sudo systemctl restart betterframe-kiosk.service`. Use the proxy URL, not
internal backend ports. Existing enrolled identities preserve their stored
server; changing a service environment value is not an enrollment reset.

## Other client installation options

### Managed Linux appliance

[GitHub releases](https://github.com/BetterCorp/BetterFrame/releases) contain
compressed client images for PC x86_64 and Raspberry Pi 5. Select the image for
your hardware, decompress it, and write it to the intended boot drive with an
image-writing tool. Writing an image replaces the destination drive's contents.

Boot the device, connect it to the network, and pair it with BF. Managed images
provide the dedicated display environment and signed RAUC A/B OS updates. The
standalone `setup.sh` intentionally refuses to overwrite a managed image's
configuration. Read [full OS OTA](docs/full-os-ota.md) before operating an image
fleet or building custom images.

The older [Pi source provisioning script](deploy/scripts/setup-pi-kiosk.sh) is
for appliance provisioning, including host-level changes. Use `setup.sh` for an
app installation on an existing desktop.

### Windows

Download the matching `betterframe-windows-client-<version>-x86_64.msi` from a
release. Windows uses a native renderer and the shared Rust client core. It
remains experimental: building an MSI does not establish unattended runtime
reliability. See the [client guide](client/README.md) and
[Windows acceptance requirements](docs/unified-client.md) before deployment.

### Android / Android TV

Install the signed `betterframe-android.apk` from a release and approve its
pairing code in BF. Android is an experimental display viewer with a restricted
capability set; Linux device-management and local-LAN controls are not exposed
by this app. See the [Android guide](client/android/README.md) for supported
content, signing, updates, build requirements, and device qualification.

### ioBOX

Use the [ioBOX firmware guide](iobox-firmware/README.md) for supported hardware,
provisioning, enrollment, and OTA trust configuration. ioBOX firmware is distinct
from display app releases.

## Pair and configure a display

1. Start the server and complete `/setup`.
2. Start a client and note its pairing code.
3. Approve the code in the server's pairing UI and configure the resulting kiosk
   and display records.
4. Add cameras using their stream/ONVIF settings, or add web/HTML content.
5. Create layouts and assign them to the display, including a default layout.
6. Check the kiosk heartbeat, rendered content, and camera decoder information
   before expanding to additional displays.

Assignments and labels determine which resources a kiosk receives. Local layout
switching is limited to layouts assigned to that kiosk. The cached bundle allows
previously configured content to continue during server outages; remote content
and camera streams still require their own network connections.

For enrollment retries, replacement devices, or credential recovery, follow
[pairing and recovery](docs/pairing-recovery.md).

## App and OS updates

| Update type | What changes | Restart behavior |
| --- | --- | --- |
| **App** | Signed display application executable | Restarts BF only; no OS reboot |
| **OS** | Managed appliance's signed RAUC system image | Separate A/B installation and OS reboot |
| **Server** | Compose services and server migrations | Restart/recreate affected containers |
| **ioBOX firmware** | Physical input device firmware | Device-specific OTA lifecycle |

The admin UI calls display software **App**. Existing API paths, environment
variables, and artifact names containing `firmware` remain for compatibility.
App releases support stable/beta/dev channels and version pinning. Standalone
Linux setup enables app OTA and disables OS OTA. Managed images normally deliver
the app with their OS image; see their separate update policy.

App downloads are verified with the vendor Ed25519 signature and SHA256. The
previous executable is retained for rollback, and systemd uses `Restart=always`
so a successful app-update exit launches the new version. App failures must not
escalate into an OS reboot.

The app-only restart behavior requires a release containing this updater change.
An older executable retained during repair still contains its older updater.
Install a release containing the change before relying on the no-reboot behavior.

For server upgrades, take a coordinated backup, check release notes, update your
checkout to the intended release, and run `docker compose up -d --build`.
Release signing and managed OS lifecycle details are in the
[deployment guide](deploy/README.md) and [OS update guide](docs/full-os-ota.md).

## Local controls and automation

Linux kiosks expose Local LAN controls on port `18090`. The kiosk admin page
shows the normal endpoint examples and additional short smart-key links for
assigned layouts and scoped camera PTZ actions:

```text
http://<kiosk-ip>:18090/lsh/<layout-key>?key=<local-key>
http://<kiosk-ip>:18090/lsh/<camera-key>/s?key=<local-key>
http://<kiosk-ip>:18090/lsh/<camera-key>/m?key=<local-key>&dir=left
http://<kiosk-ip>:18090/lsh/<camera-key>/p/<preset-token>?key=<local-key>
```

Smart keys are persistent six-character resource identifiers. The full kiosk
local authentication key is still required. The UI shows link lengths for
controllers with a 127-character input limit; optional PTZ parameters and long
preset tokens can exceed that limit. See [Local LAN smart keys](docs/local-smart-keys.md).

Open the authenticated Node-RED editor at `/nrdp/`. BF nodes can react to camera,
layout, kiosk, and display-power events and perform layout switches and other
commands. Each tenant has an isolated runtime. Public HTTP-in endpoints use
`/in/public/<tenant-slug>/<node-red-path>`; kiosk-authenticated ingress uses
`/in/kiosk/<node-red-path>`. See [Node-RED nodes](nodered/README.md).

## Operations and troubleshooting

| Symptom | Checks |
| --- | --- |
| Server does not start | `docker compose ps` and `docker compose logs --tail=100 server postgres`; check `.env` and database health |
| Desktop app does not start | Log into the configured graphical account; inspect `journalctl --user -u betterframe.service -n 100` |
| Dedicated kiosk does not start | Inspect `sudo journalctl -u betterframe-kiosk.service -n 100` and Cage/display errors |
| Manual install cannot update | Rerun `setup.sh --binary …`; check the stable executable path, writable parent directory, and state ownership |
| Installer rejects a release | Check target architecture and missing library/ABI errors; use a compatible release/OS |
| App version is missing from the server | Check release import job results and the server's vendor public PEM, including line breaks |
| MediaMTX is unavailable | Rerun the one-line installer; inspect `sudo journalctl -u betterframe-mediamtx.service -n 100` |
| Camera tile is blank | Check camera credentials, reachability from the client, stream URL, installed GStreamer codecs, and decoder telemetry |
| Local link returns 404 | Confirm the resource is assigned/enabled and the kiosk has refreshed its bundle |
| Pairing/reconnection fails | Check the proxy URL and client logs; use the recovery guide before discarding identity files |

Back up PostgreSQL, BF server keys/state, and Node-RED data together with
[deploy/scripts/backup-stack.sh](deploy/scripts/backup-stack.sh). The backup
procedure requires `age`; see [backup and recovery](docs/backup-recovery.md).
Old SQLite `.bfbak` browser archives do not restore the current PostgreSQL stack.

See [kiosk diagnostic logging](docs/kiosk-diagnostic-logging.md) for log capture,
upload behavior, and debug access requirements.

## Development

The repository contains the TypeScript server and Node-RED nodes, the shared
Rust client core and native adapters, Android sources, ioBOX firmware, and image
and deployment tooling.

| Path | Contents |
| --- | --- |
| `server/` | BSB services, PostgreSQL repository/migrations, admin UI, API, tests |
| `nodered/` | BetterFrame integration nodes |
| `client/core/` | Shared client models, policy, protocol, and state logic |
| `client/src/` | Native Linux and Windows adapters |
| `client/android/` | Android viewer and Gradle build |
| `client/android-bridge/` | Rust/JNI bridge |
| `iobox-firmware/` | Physical input device firmware |
| `deploy/` | Containers, systemd units, Pi/x86 images, RAUC, provisioning |
| `scripts/` | Release, signing, deployment checks, and utilities |
| `docs/` | Architecture and operational guides |

Use Node.js 24 and npm 11 for the JavaScript workspace (package minimums are
Node.js 23 and npm 11):

```sh
npm ci
npm run build
npm test
```

Database integration tests require a disposable PostgreSQL database configured
through `BF_TEST_PG_URL`. Tests that create HTTP/WebSocket listeners require
loopback socket access. Never point integration tests at production data.
For native server development, adapt `sec-config.template.yaml` with real local
configuration; production deployment uses the Compose stack.

Shared client tests require stable Rust:

```sh
cargo test --manifest-path client/Cargo.toml -p betterframe-client-core --locked
```

A full Linux client build also requires GTK4 (at least 4.14), WebKitGTK 6,
GStreamer development packages, pkg-config, and OpenSSL development headers:

```sh
cargo build --release --manifest-path client/Cargo.toml --locked
```

The release binary is `client/target/release/betterframe-client`; to install a
trusted local build with the normal startup/update layout, pass that path to
`sudo ./setup.sh --binary ...`. Locally built clients need the appropriate
embedded public signing key before app OTA can verify vendor releases.
Platform build details are in [client/README.md](client/README.md) and the
[Android guide](client/android/README.md).

Installer regression tests are non-destructive and require Python 3, Bash, and
OpenSSL:

```sh
bash -n setup.sh
python3 scripts/test-linux-setup.py
```

Pull-request validation also covers server, Linux/Windows client, Android/ioBOX,
and deployment checks through the workflows in `.github/workflows/`.

## Documentation

- [Deployment and network routes](deploy/README.md)
- [Linux app installation and repair](docs/linux-install.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Client overview](client/README.md)
- [Shared Linux/Windows runtime](docs/unified-client.md)
- [Android viewer](client/android/README.md)
- [Android Play publishing](docs/android-play-publishing.md)
- [ioBOX firmware](iobox-firmware/README.md)
- [ioBOX hardware](docs/iobox-hardware-lcsc-easyeda.md)
- [Local LAN smart keys](docs/local-smart-keys.md)
- [Pairing and recovery](docs/pairing-recovery.md)
- [Kiosk diagnostic logging](docs/kiosk-diagnostic-logging.md)
- [PostgreSQL backup and recovery](docs/backup-recovery.md)
- [Full OS OTA](docs/full-os-ota.md)
- [RAUC update lifecycle](deploy/rauc/UPDATE-LIFECYCLE.md)
- [Node-RED integration nodes](nodered/README.md)
- [Application identity](docs/application-identity.md)

## License

BetterFrame is dual-licensed under **AGPL-3.0-only OR Commercial**. See
[LICENSE.md](LICENSE.md), [LICENSE-AGPL.txt](LICENSE-AGPL.txt), and
[LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).
