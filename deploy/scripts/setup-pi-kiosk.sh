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
# Re-run safely: every step is idempotent.
#
# By default the script builds the kiosk Rust binary (cargo build --release)
# and installs it at /opt/betterframe/kiosk/betterframe-kiosk. Set
# SKIP_BUILD=1 to skip the build step (expects the binary already present
# at kiosk/target/release/betterframe-kiosk in the repo).
#
# Usage:  sudo ./deploy/scripts/setup-pi-kiosk.sh
#         sudo SKIP_BUILD=1 ./deploy/scripts/setup-pi-kiosk.sh

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

echo "==> Building + installing kiosk binary"
BIN_SRC="${REPO_ROOT}/kiosk/target/release/betterframe-kiosk"
BIN_DST_DIR="/opt/betterframe/kiosk"
BIN_DST="${BIN_DST_DIR}/betterframe-kiosk"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  apt-get install -y --no-install-recommends \
    libgtk-4-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    libwebkitgtk-6.0-dev pkg-config build-essential \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-libav

  # Build as the invoking user (typically the dev/admin user), not root,
  # so cargo registry caches stay in their home and rustup PATH applies.
  # -i runs a login shell so ~/.cargo/env gets sourced from .profile/.bashrc.
  BUILD_USER="${SUDO_USER:-root}"
  echo "    building as ${BUILD_USER}"
  sudo -u "${BUILD_USER}" -i sh -c "cd '${REPO_ROOT}' && cargo build --release --manifest-path kiosk/Cargo.toml"
fi

if [ ! -f "${BIN_SRC}" ]; then
  echo "error: kiosk binary not found at ${BIN_SRC}." >&2
  echo "       Run with SKIP_BUILD=0 (default) or build manually first." >&2
  exit 1
fi

install -d -m 755 "${BIN_DST_DIR}"
install -m 755 "${BIN_SRC}" "${BIN_DST}"
echo "    installed → ${BIN_DST}"

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

systemctl daemon-reload
systemctl enable betterframe-kiosk.service

echo "==> Done. Reboot to take effect, or 'systemctl start betterframe-kiosk' now."
