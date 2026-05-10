# BetterFrame deployment

## Native install (Raspberry Pi)

### Server

```bash
# Install Node.js 23
curl -fsSL https://deb.nodesource.com/setup_23.x | sudo bash -
sudo apt install -y nodejs build-essential

# Create user + dirs
sudo useradd -r -m -d /var/lib/betterframe betterframe
sudo mkdir -p /opt/betterframe /var/log/betterframe /etc/betterframe
sudo chown betterframe:betterframe /var/lib/betterframe /var/log/betterframe

# Deploy code
sudo git clone https://github.com/BetterCorp/BetterFrame.git /opt/betterframe
cd /opt/betterframe
sudo -u betterframe npm install
sudo cp sec-config.yaml /opt/betterframe/server/sec-config.yaml

# Install systemd unit
sudo cp deploy/systemd/betterframe-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now betterframe-server
```

### Kiosk

```bash
# Install GTK4 + GStreamer + WebKit
sudo apt install -y libgtk-4-dev libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-libav \
    gstreamer1.0-gtk4 libwebkitgtk-6.0-dev libssl-dev

# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Build
cd ~/betterframe/kiosk
cargo build --release
sudo install -Dm755 target/release/betterframe-kiosk /opt/betterframe/kiosk/betterframe-kiosk

# Install systemd user unit
mkdir -p ~/.config/systemd/user
cp deploy/systemd/betterframe-kiosk.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now betterframe-kiosk
```

### Angie proxy

```bash
sudo apt install -y angie  # or nginx
sudo cp deploy/angie/betterframe.conf /etc/angie/conf.d/
sudo systemctl reload angie
```

## Docker

```bash
docker compose -f deploy/docker/docker-compose.yml up -d
```

Kiosk still runs natively on the Pi (needs Wayland/HDMI), not in Docker.

Access: `http://<pi-ip>/setup` for first-run.

## Production secrets

For production, store the server key via `systemd-creds`:

```bash
sudo systemd-creds encrypt --name=betterframe-secret \
    /etc/betterframe/secret.key.plain /etc/betterframe/secret.key
sudo chmod 0600 /etc/betterframe/secret.key
sudo chown root:root /etc/betterframe/secret.key
```

The systemd unit's `LoadCredential=` directive injects this into the
service's `$CREDENTIALS_DIRECTORY`.
