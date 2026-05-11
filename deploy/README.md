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

Node-RED is reachable only through:

```text
http://<pi-ip>/nrdp/
```

Node-RED HTTP-in routes have two public base URLs:

- Public webhook/user actions: `http://<pi-ip>/in/public/<node-red-path>`
- Kiosk-authenticated ingress: `http://<pi-ip>/in/kiosk/<node-red-path>`

For example, a Node-RED `http in` node at `/test1` is called as
`http://<pi-ip>/in/public/test1` for public traffic, or
`http://<pi-ip>/in/kiosk/test1` for kiosk-authenticated traffic.

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
