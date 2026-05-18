# BetterFrame deployment

## Deployment shapes

BetterFrame ships as **two artifacts**, deployable in any combination:

| Variant      | What it runs                              | Where it runs                |
|--------------|-------------------------------------------|------------------------------|
| **bf-server**| Docker compose (server + Angie + Node-RED)| Coolify / VM / on-prem box   |
| **bf-client**| Rust kiosk binary + cage + plymouth       | Pi 5 (LAN-attached)          |
| *bf-aio*     | Both, single Pi                            | **Demo / single-site only**  |

The `bf-aio` mode (server + kiosk colocated on one Pi) is the simplest install
but couples failure domains — when the Pi dies, you lose both the displays it
drives AND the management plane for any other kiosks. Use for demos or a
single-display site. For anything else, run `bf-server` separately and have
`bf-client` Pis point at it.

### bf-server (Docker compose, Coolify-friendly)

Pull the repo on the host. Configure via env (overrides `sec-config.yaml`):

```
BF_DATA_DIR=/var/lib/betterframe
BF_SQLITE_PATH=/var/lib/betterframe/betterframe.db
BF_NODERED_URL=http://nodered:1880
BF_SELF_URL=http://server:18080
BF_FIRMWARE_SIGNING_KEY=        # paste Ed25519 PEM for stable signing key
BF_MQTT_URL=                     # optional MQTT telemetry export
```

In Coolify: create a Docker compose stack pointing at the repo's
`docker-compose.yml` (repo root), inject the env vars, set a domain on the
`angie` service. Backups via the admin UI (`/admin/backup`) — Coolify's S3
hook can pull these on a schedule.

### bf-client (kiosk Pi)

```bash
sudo apt install -y git
git clone https://github.com/BetterCorp/BetterFrame.git ~/betterframe
sudo ~/betterframe/deploy/scripts/setup-pi-kiosk.sh client
```

Pairs with whichever `bf-server` is set in `/etc/default/betterframe-kiosk`
(`BETTERFRAME_SERVER=http://<server-host>`).

## Recommended: Docker services + native kiosk

Run server, Angie/nginx, and Node-RED in Docker Compose. Only Angie publishes a
host port. The BetterFrame backend ports and Node-RED are internal to the Docker
network, which forces `/nrdp/`, `/in/kiosk/`, and admin traffic through the
proxy auth rules.

```bash
cd /opt/betterframe
docker compose up -d --build      # from repo root
```

Published:

- `80` -> Angie/nginx public edge

Internal only:

- `18080` -> admin service
- `18081` -> kiosk API service
- `18082` -> kiosk WebSocket service
- `1880` -> Node-RED

Access first-run setup at:

```text
http://<pi-ip>/setup
```

Node-RED editor is reachable only through:

```text
http://<pi-ip>/nrdp/
```

The proxy has four route surfaces:

- BetterFrame web/API: `/`, `/setup`, `/admin/*`, `/auth/*`, `/static/*`,
  `/api/admin/*`, `/api/kiosk/*`, `/api/pair/*`, `/ws/kiosk`
- Kiosk-only Node-RED ingress: `/in/kiosk/<node-red-path>`
- Kiosk-only Node-RED dashboards: `/dash/*`
- Public Node-RED HTTP-in URLs: any otherwise-unmatched root path, plus
  `/in/public/<node-red-path>`

For example, a Node-RED `http in` node at `/test1` is public at
`http://<pi-ip>/test1` and also available at
`http://<pi-ip>/in/public/test1`. Kiosk-authenticated traffic to that same
Node-RED path uses `http://<pi-ip>/in/kiosk/test1`.

Do not publish `18080`, `18081`, `18082`, or `1880` on the host.

If migrating from an older native install, stop the old host daemons first:

```bash
sudo systemctl disable --now betterframe-server betterframe-nodered angie nginx 2>/dev/null || true
```

## Kiosk

The kiosk still runs natively on the Pi because it needs Wayland/HDMI, GTK,
GStreamer, display power control, and local hardware access.

```bash
sudo apt install -y libgtk-4-dev libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-libav \
    gstreamer1.0-gtk4 libwebkitgtk-6.0-dev libssl-dev

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

cd /opt/betterframe/kiosk
cargo build --release
sudo install -Dm755 target/release/betterframe-kiosk /opt/betterframe/kiosk/betterframe-kiosk

mkdir -p ~/.config/systemd/user
cp /opt/betterframe/deploy/systemd/betterframe-kiosk.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now betterframe-kiosk
```

Kiosks should point at the proxy URL, not direct backend ports:

```bash
BETTERFRAME_SERVER=http://<pi-ip> /opt/betterframe/kiosk/betterframe-kiosk
```

## Native server mode

Native server mode is for development only. Run it manually when debugging; do
not install host daemons for BetterFrame server, Angie, or Node-RED in
production. The Docker stack owns those services.
