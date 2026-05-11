# BetterFrame deployment

## Recommended: Docker services + native kiosk

Run server, Angie/nginx, and Node-RED in Docker Compose. Only Angie publishes a
host port. The BetterFrame backend ports and Node-RED are internal to the Docker
network, which forces `/nrdp/`, `/in/kiosk/`, and admin traffic through the
proxy auth rules.

```bash
cd /opt/betterframe
docker compose -f deploy/docker/docker-compose.yml up -d --build
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
