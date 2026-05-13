#!/usr/bin/env bash
# Provision a Raspberry Pi (Bookworm or later) as a BetterFrame kiosk.
#
#   - Creates the unprivileged `bfkiosk` user
#   - Installs `cage` (single-app Wayland compositor) and `seatd`
#   - Disables any installed display manager and sets multi-user.target
#   - Disables getty on tty1 (cage owns the tty)
#   - Installs the betterframe-kiosk system unit + PAM stack
#   - Enables + starts the service
#
# Re-run safely: every step is idempotent. The kiosk binary itself must
# already be installed at /opt/betterframe/kiosk/betterframe-kiosk.
#
# Usage:  sudo ./deploy/scripts/setup-pi-kiosk.sh

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "error: must run as root (sudo $0)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> Installing cage + seatd"
apt-get update
apt-get install -y --no-install-recommends cage seatd

echo "==> Enabling seatd"
systemctl enable --now seatd

echo "==> Ensuring bfkiosk user exists"
if ! id -u bfkiosk >/dev/null 2>&1; then
  useradd -m -s /usr/sbin/nologin bfkiosk
fi
# nologin shell means no interactive login. The systemd unit launches cage
# directly so a shell is not needed. The user joins the hardware-access
# groups required by GStreamer/GTK/cage.
for grp in video render input audio seat; do
  if getent group "$grp" >/dev/null; then
    usermod -a -G "$grp" bfkiosk
  fi
done

echo "==> Disabling any display manager"
for dm in lightdm gdm gdm3 sddm; do
  systemctl disable --now "${dm}.service" 2>/dev/null || true
done
systemctl set-default multi-user.target

echo "==> Disabling getty on tty1 (cage owns it)"
systemctl disable --now getty@tty1.service 2>/dev/null || true

echo "==> Installing PAM stack and systemd unit"
install -m 644 "${REPO_ROOT}/deploy/pam.d/cage" /etc/pam.d/cage
install -m 644 "${REPO_ROOT}/deploy/systemd/betterframe-kiosk.service" \
  /etc/systemd/system/betterframe-kiosk.service

if [ ! -e /etc/default/betterframe-kiosk ]; then
  cat > /etc/default/betterframe-kiosk <<'EOF'
# Runtime env for betterframe-kiosk. Edit and `systemctl restart betterframe-kiosk`.
# BETTERFRAME_SERVER=http://192.168.1.10
EOF
fi

if [ ! -x /opt/betterframe/kiosk/betterframe-kiosk ]; then
  echo "warn: /opt/betterframe/kiosk/betterframe-kiosk is missing or not executable."
  echo "      Build the kiosk with 'cargo build --release' and copy the binary there"
  echo "      before starting the service."
fi

systemctl daemon-reload
systemctl enable betterframe-kiosk.service

echo "==> Done. Reboot to take effect, or 'systemctl start betterframe-kiosk' now."
