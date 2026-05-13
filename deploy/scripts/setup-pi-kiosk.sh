#!/usr/bin/env bash
# Single-host BetterFrame installer/updater for Raspberry Pi 5 (Bookworm+).
#
# What it does (every step idempotent — safe to re-run for updates):
#   1. clone or `git pull` the BetterFrame repo into the invoking user's home
#   2. install OS deps: Docker + compose, GTK4/GStreamer/WebKit dev libs,
#      cage + seatd, rust toolchain (via rustup) if missing
#   3. bring up the Docker stack (server + Angie proxy + Node-RED) via
#      `docker compose up -d --build`
#   4. build the Rust kiosk binary as the invoking user, install to
#      /opt/betterframe/kiosk/betterframe-kiosk
#   5. provision the unprivileged `bfkiosk` user + cage PAM stack + systemd
#      unit, disable any display manager, set multi-user.target as default
#   6. enable + start the kiosk service
#
# Re-run after every git change to pull + rebuild + redeploy.
#
# Usage:  sudo ./deploy/scripts/setup-pi-kiosk.sh [client|server|both]
#         client = kiosk-only host (Rust binary + cage + systemd unit)
#         server = headless server host (Docker stack only, no kiosk)
#         both   = single-box install of both (default)
#
# Env overrides:
#   BF_HOME=/path/to/repo          override repo location (default: $HOME/betterframe)
#   BF_REPO_URL=git@…              override clone URL (default: github)
#   SKIP_BUILD=1                   skip kiosk cargo build (expects existing binary)

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "error: must run as root (sudo $0)" >&2
  exit 1
fi

MODE="${1:-both}"
case "${MODE}" in
  client) INSTALL_KIOSK=1; INSTALL_SERVER=0 ;;
  server) INSTALL_KIOSK=0; INSTALL_SERVER=1 ;;
  both)   INSTALL_KIOSK=1; INSTALL_SERVER=1 ;;
  *)
    echo "error: unknown mode '${MODE}'. Use client | server | both." >&2
    exit 1
    ;;
esac
echo "==> Mode: ${MODE}"

REPO_URL="${BF_REPO_URL:-https://github.com/BetterCorp/BetterFrame.git}"
BUILD_USER="${SUDO_USER:-$(id -un)}"
if [ "${BUILD_USER}" = "root" ]; then
  echo "error: refuses to run as root without SUDO_USER set. Use 'sudo ...' from a normal user." >&2
  exit 1
fi
USER_HOME="$(getent passwd "${BUILD_USER}" | cut -d: -f6)"
BF_HOME="${BF_HOME:-${USER_HOME}/betterframe}"

run_as_user() {
  # Run in a login shell so ~/.cargo/env, ~/.profile etc. are sourced.
  sudo -u "${BUILD_USER}" -H -i sh -c "$1"
}

# ----------------------------------------------------------------------------
# 1. Base packages
# ----------------------------------------------------------------------------
echo "==> Installing base packages"
apt-get update
apt-get install -y --no-install-recommends \
  git ca-certificates curl gnupg lsb-release sudo

# ----------------------------------------------------------------------------
# 2. Clone or update repo
# ----------------------------------------------------------------------------
if [ -d "${BF_HOME}/.git" ]; then
  echo "==> Updating repo at ${BF_HOME}"
  run_as_user "git -C '${BF_HOME}' fetch --prune origin && git -C '${BF_HOME}' pull --ff-only"
else
  echo "==> Cloning ${REPO_URL} → ${BF_HOME}"
  install -d -o "${BUILD_USER}" -g "${BUILD_USER}" "$(dirname "${BF_HOME}")"
  run_as_user "git clone '${REPO_URL}' '${BF_HOME}'"
fi
REPO_ROOT="${BF_HOME}"

# ----------------------------------------------------------------------------
# 3. Docker engine + compose plugin
# ----------------------------------------------------------------------------
if [ "${INSTALL_SERVER}" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "==> Installing Docker (via convenience script)"
    curl -fsSL https://get.docker.com | sh
  else
    echo "==> Docker already installed: $(docker --version)"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends docker-compose-plugin
  fi
  # Let BUILD_USER use docker without sudo (idempotent).
  if ! id -nG "${BUILD_USER}" | tr ' ' '\n' | grep -qx docker; then
    usermod -aG docker "${BUILD_USER}"
    echo "    added ${BUILD_USER} to docker group (re-login required for that user)"
  fi
  systemctl enable --now docker
fi

# ----------------------------------------------------------------------------
# 4. Kiosk runtime deps (GTK/GStreamer/WebKit + cage + seatd)
# ----------------------------------------------------------------------------
if [ "${INSTALL_KIOSK}" = "1" ]; then
  echo "==> Installing kiosk runtime deps"
  apt-get install -y --no-install-recommends \
    cage seatd \
    libgtk-4-dev libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    libwebkitgtk-6.0-dev pkg-config build-essential \
    gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-libav \
    v4l-utils wlr-randr \
    plymouth plymouth-themes librsvg2-bin

  systemctl enable --now seatd
fi

# ----------------------------------------------------------------------------
# 5. Rust toolchain (kiosk build prerequisite)
# ----------------------------------------------------------------------------
if [ "${INSTALL_KIOSK}" = "1" ] && [ "${SKIP_BUILD:-0}" != "1" ]; then
  if ! run_as_user "command -v cargo >/dev/null 2>&1"; then
    echo "==> Installing rustup as ${BUILD_USER}"
    run_as_user "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal"
  fi
fi

# ----------------------------------------------------------------------------
# 6. Build + start Docker stack
# ----------------------------------------------------------------------------
if [ "${INSTALL_SERVER}" = "1" ]; then
  echo "==> Building + starting Docker stack"
  run_as_user "cd '${REPO_ROOT}' && docker compose -f deploy/docker/docker-compose.yml up -d --build"
fi

# ----------------------------------------------------------------------------
# 7. Build + install kiosk binary
# ----------------------------------------------------------------------------
if [ "${INSTALL_KIOSK}" = "1" ]; then
  BIN_SRC="${REPO_ROOT}/kiosk/target/release/betterframe-kiosk"
  BIN_DST_DIR="/opt/betterframe/kiosk"
  BIN_DST="${BIN_DST_DIR}/betterframe-kiosk"

  if [ "${SKIP_BUILD:-0}" != "1" ]; then
    echo "==> Building kiosk binary (release)"
    run_as_user "cd '${REPO_ROOT}' && cargo build --release --manifest-path kiosk/Cargo.toml"
  fi

  if [ ! -f "${BIN_SRC}" ]; then
    echo "error: kiosk binary not found at ${BIN_SRC}." >&2
    exit 1
  fi

  install -d -m 755 "${BIN_DST_DIR}"
  install -m 755 "${BIN_SRC}" "${BIN_DST}"
  echo "    installed → ${BIN_DST}"

  # --------------------------------------------------------------------------
  # 8. bfkiosk user + PAM + systemd unit
  # --------------------------------------------------------------------------
  echo "==> Provisioning bfkiosk user"
  if ! id -u bfkiosk >/dev/null 2>&1; then
    useradd -m -s /usr/sbin/nologin bfkiosk
  fi
  # Debian's seatd uses -g video (no separate 'seat' group) — only join groups
  # that actually exist on this system.
  for grp in video render input audio; do
    if getent group "$grp" >/dev/null; then
      usermod -a -G "$grp" bfkiosk
    fi
  done

  echo "==> Disabling + masking display managers, removing Pi first-run wizard"
  # Mask (not just disable) so nothing — apt upgrades, dependencies — can
  # re-enable a display manager later.
  for dm in lightdm gdm gdm3 sddm display-manager; do
    systemctl disable --now "${dm}.service" 2>/dev/null || true
    systemctl mask "${dm}.service" 2>/dev/null || true
  done
  systemctl set-default multi-user.target
  systemctl disable --now getty@tty1.service 2>/dev/null || true

  # piwiz = "Welcome to Raspberry Pi" first-run wizard. userconf-pi runs at
  # first boot if no user is configured. Purge both so they can't fire.
  DEBIAN_FRONTEND=noninteractive apt-get purge -y piwiz userconf-pi 2>/dev/null || true
  rm -f /etc/xdg/autostart/piwiz.desktop
  systemctl disable --now userconf.service userconf-pi.service 2>/dev/null || true
  systemctl mask userconf.service userconf-pi.service 2>/dev/null || true

  # Suppress the Debian/Pi console motd and /etc/issue text on tty.
  : > /etc/motd
  printf 'BetterFrame Kiosk\n\n' > /etc/issue
  rm -f /etc/update-motd.d/10-uname /etc/update-motd.d/* 2>/dev/null || true

  echo "==> Installing PAM + systemd unit"
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
  # Restart picks up new binary on re-run.
  systemctl restart betterframe-kiosk.service || true

  # --------------------------------------------------------------------------
  # 9. Plymouth boot splash — hide kernel text + Pi rainbow, show BF logo
  # --------------------------------------------------------------------------
  echo "==> Installing BetterFrame plymouth theme"
  THEME_DIR="/usr/share/plymouth/themes/betterframe"
  install -d -m 755 "${THEME_DIR}"
  install -m 644 "${REPO_ROOT}/deploy/plymouth/betterframe/betterframe.plymouth" "${THEME_DIR}/"
  install -m 644 "${REPO_ROOT}/deploy/plymouth/betterframe/betterframe.script"   "${THEME_DIR}/"
  rsvg-convert -w 480 "${REPO_ROOT}/server/src/web-static/betterframe-logo.svg" \
    -o "${THEME_DIR}/logo.png"
  plymouth-set-default-theme -R betterframe

  # Find the boot config / cmdline file. Bookworm uses /boot/firmware/, older
  # Pi images use /boot/.
  if [ -f /boot/firmware/cmdline.txt ]; then
    BOOT_DIR=/boot/firmware
  else
    BOOT_DIR=/boot
  fi
  CMDLINE="${BOOT_DIR}/cmdline.txt"
  CONFIG="${BOOT_DIR}/config.txt"

  if [ -f "${CMDLINE}" ]; then
    # cmdline.txt is a single line. Append missing flags only.
    for flag in quiet splash plymouth.ignore-serial-consoles "loglevel=0" "vt.global_cursor_default=0" logo.nologo; do
      if ! grep -qw -- "${flag}" "${CMDLINE}"; then
        sed -i "s|\$| ${flag}|" "${CMDLINE}"
      fi
    done
  fi
  if [ -f "${CONFIG}" ]; then
    # Pi firmware rainbow splash off.
    if ! grep -q "^disable_splash=1" "${CONFIG}"; then
      printf '\n# BetterFrame: disable firmware rainbow splash\ndisable_splash=1\n' >> "${CONFIG}"
    fi
  fi
fi

echo "==> Done."
if [ "${INSTALL_SERVER}" = "1" ]; then
  echo "    Server stack: http://$(hostname -I | awk '{print $1}')/"
fi
if [ "${INSTALL_KIOSK}" = "1" ]; then
  echo "    Kiosk service: systemctl status betterframe-kiosk"
fi
