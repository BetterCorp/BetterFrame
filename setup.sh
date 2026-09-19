#!/usr/bin/env bash
# BetterFrame standalone Linux app installer. Run from a downloaded checkout:
# sudo ./setup.sh   (or see --help for unattended installation)
set -euo pipefail

BIN=/opt/betterframe/kiosk/betterframe-kiosk
STATE=/var/lib/betterframe/kiosk
MODE=desktop
INSTALL_USER=${SUDO_USER:-}
VERSION=
SOURCE_BINARY=
ASSUME_YES=0
START=1
MODE_SET=0
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'EOF'
Install or repair the BetterFrame Linux app (systemd required).
  sudo ./setup.sh [options]
  --user USER       Desktop/runtime user (defaults to sudo caller)
  --mode desktop    Start on graphical login (default)
  --mode dedicated  Replace graphical login with a Cage fullscreen kiosk
  --version VERSION Download a signed GitHub release (e.g. 1.0.14 or latest)
  --binary FILE     Install an existing, trusted local BF executable
  --yes             Use defaults without prompting (desktop unless specified)
  --no-start        Configure startup but do not start/restart BF now
  --help            Show this help
Without a binary/version, reuse the installed/running BF executable if found;
otherwise download the latest stable release. Existing pairing is preserved.
Dedicated mode takes effect on reboot; this script never reboots the machine.
EOF
}
parse_args() {
    while (($#)); do
        case "$1" in
            --user|--mode|--version|--binary)
                (($# >= 2)) || fail "$1 requires a value"
                case "$1" in
                    --user) INSTALL_USER=$2;;
                    --mode) MODE=$2; MODE_SET=1;;
                    --version) VERSION=$2;;
                    --binary) SOURCE_BINARY=$2;;
                esac
                shift 2;;
            --yes) ASSUME_YES=1; shift;;
            --no-start) START=0; shift;;
            --help|-h) usage; exit 0;;
            *) fail "Unknown option: $1";;
        esac
    done
    [[ -z $VERSION || -z $SOURCE_BINARY ]] || fail 'Choose --version or --binary, not both'
    [[ $MODE == desktop || $MODE == dedicated ]] || fail 'Mode must be desktop or dedicated'
}
user_systemctl() {
    runuser -u "$INSTALL_USER" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_ID/bus" systemctl --user "$@"
}
select_packages() {
    case " $DISTRO_ID $DISTRO_LIKE " in
        *' debian '*|*' ubuntu '*)
            PACKAGE_MANAGER=apt-get
            PACKAGES=(ca-certificates curl openssl python3 libgtk-4-1 libwebkitgtk-6.0-4
                libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 gstreamer1.0-tools
                gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad
                gstreamer1.0-libav dbus-user-session v4l-utils alsa-utils wlr-randr x11-xserver-utils)
            ;;
        *' fedora '*|*' rhel '*)
            PACKAGE_MANAGER=dnf
            PACKAGES=(ca-certificates curl openssl python3 gtk4 webkitgtk6.0 gstreamer1
                gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free
                gstreamer1-plugin-libav dbus-daemon v4l-utils alsa-utils wlr-randr xset)
            ;;
        *) fail "Unsupported distribution: $DISTRO_ID (requires Ubuntu/Debian or Fedora-family packages)";;
    esac
    if [[ $MODE == dedicated ]]; then PACKAGES+=(cage); fi
}
select_target() {
    case "$1" in
        x86_64) TARGET=betterframe-pc-x86_64;;
        aarch64|arm64)
            [[ ${2:-} == *'Raspberry Pi 5'* ]] || fail 'The published ARM app currently targets Raspberry Pi 5 only'
            TARGET=betterframe-rpi5-aarch64;;
        *) fail "Unsupported architecture: $1";;
    esac
}
backup() {
    if [[ -e $1 ]]; then cp -a -- "$1" "$1.before-setup.$BACKUP_ID"; fi
}
verify_download() {
    local artifact=$1 expected actual
    expected=$(tr -d '\r\n' < "$artifact.sha256")
    [[ $expected =~ ^[a-fA-F0-9]{64}$ ]] || fail 'Malformed release checksum'
    actual=$(sha256sum "$artifact"); actual=${actual%% *}
    [[ ${expected,,} == "$actual" ]] || fail 'Release checksum mismatch'
    printf %s "$actual" > "$artifact.digest"
    python3 - "$artifact.sig" "$artifact.signature" <<'PY'
import base64, pathlib, sys
value = pathlib.Path(sys.argv[1]).read_text().strip()
signature = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
if len(signature) != 64:
    raise SystemExit('Invalid Ed25519 signature length')
pathlib.Path(sys.argv[2]).write_bytes(signature)
PY
    openssl pkeyutl -verify -pubin -inkey "$TRUST_KEY" -rawin \
        -in "$artifact.digest" -sigfile "$artifact.signature" >/dev/null || fail 'Release signature is not trusted'
}
download_release() {
    local base='https://github.com/BetterCorp/BetterFrame' tag asset
    if [[ $VERSION == latest || -z $VERSION ]]; then
        tag=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
            --output /dev/null --write-out '%{url_effective}' "$base/releases/latest")
        tag=${tag##*/}
    else
        tag=v${VERSION#v}
    fi
    [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9.-]+)?$ ]] || fail "Invalid release tag: $tag"
    asset="betterframe-kiosk-${tag#v}-$TARGET"
    SOURCE_BINARY="$STAGING/$asset"
    local suffix
    for suffix in '' .sha256 .sig; do
        curl --fail --silent --show-error --location --retry 3 --proto '=https' --proto-redir '=https' \
            "$base/releases/download/$tag/$asset$suffix" --output "$SOURCE_BINARY$suffix"
    done
    TRUST_KEY="$STAGING/vendor.pem"
    cat > "$TRUST_KEY" <<'PEM'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA7cIx3FC6w7AS/NAdCzO6DpX1Rz1TtpGhEpSRATqa0Y4=
-----END PUBLIC KEY-----
PEM
    verify_download "$SOURCE_BINARY"
}
check_binary() {
    local candidate=$1 dependencies
    # Check ELF architecture without launching BF or accepting shell scripts.
    python3 - "$candidate" "$TARGET" <<'PY'
import pathlib, struct, sys
with pathlib.Path(sys.argv[1]).open('rb') as f:
    header = f.read(20)
expected = 62 if sys.argv[2] == 'betterframe-pc-x86_64' else 183
if len(header) < 20 or header[:6] != b'\x7fELF\x02\x01' or struct.unpack('<H', header[18:20])[0] != expected:
    raise SystemExit('App must be a matching 64-bit Linux ELF executable')
PY
    chmod 755 "$candidate"
    dependencies=$(ldd "$candidate" 2>&1) || fail "App is incompatible with this OS: $dependencies"
    if [[ $dependencies == *'not found'* ]]; then
        fail "App requires unavailable libraries/ABI versions. Keep the current installation and use a compatible release: $dependencies"
    fi
}
install_app_binary() {
    if [[ -f $BIN ]] && ! cmp -s "$BIN" "$STAGING/candidate"; then
        cp -- "$BIN" "$BIN.prev"
        chown "$INSTALL_USER:$USER_GROUP" "$BIN.prev"
    fi
    install -o "$INSTALL_USER" -g "$USER_GROUP" -m 755 "$STAGING/candidate" "$BIN.new"
    mv -f -- "$BIN.new" "$BIN"
}
write_desktop_unit() {
    cat <<'EOF'
[Unit]
Description=BetterFrame app
PartOf=graphical-session.target
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
ExecStartPre=/usr/local/libexec/betterframe-rollback
ExecStart=/opt/betterframe/kiosk/betterframe-kiosk
Environment=BF_KIOSK_BINARY=/opt/betterframe/kiosk/betterframe-kiosk
Environment=BF_ENABLE_APP_OTA=1
Environment=BF_ENABLE_OS_OTA=0
Restart=always
RestartSec=3
UMask=0077
EOF
}
write_launcher() {
    cat <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Import this graphical session, not a guessed DISPLAY or an SSH environment.
variables=()
for name in DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP; do
    if [[ -v $name ]]; then variables+=("$name"); fi
done
systemctl --user unset-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP
if ((${#variables[@]})); then systemctl --user import-environment "${variables[@]}"; fi
exec systemctl --user restart betterframe.service
EOF
}
write_dedicated_unit() {
    cat <<EOF
[Unit]
Description=BetterFrame dedicated app kiosk
After=systemd-user-sessions.service systemd-logind.service network-online.target
Wants=network-online.target
Conflicts=getty@tty1.service display-manager.service
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
User=$INSTALL_USER
PAMName=betterframe-kiosk
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
Environment=XDG_SESSION_TYPE=wayland
Environment=XDG_RUNTIME_DIR=/run/user/$USER_ID
Environment=LIBSEAT_BACKEND=logind
Environment=BF_KIOSK_BINARY=$BIN
Environment=BF_ENABLE_APP_OTA=1
Environment=BF_ENABLE_OS_OTA=0
ExecStartPre=/usr/local/libexec/betterframe-rollback
ExecStart=/usr/bin/cage -s -- $BIN
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}
main() {
    parse_args "$@"
    [[ $(uname -s) == Linux ]] || fail 'This installer requires Linux'
    [[ $EUID == 0 ]] || fail 'Run with sudo (or root and --user USER)'
    [[ -d /run/systemd/system ]] || fail 'This installer requires systemd'
    [[ ! -e /etc/betterframe/managed-image ]] || fail 'Use the managed-image updater on this device'
    [[ -f $SCRIPT_DIR/deploy/systemd/betterframe-firmware-rollback.sh ]] || fail 'Run setup.sh from a BetterFrame checkout (rollback helper missing)'
    if [[ -t 0 && $ASSUME_YES == 0 ]]; then
        read -r -p "Run BetterFrame as user [${INSTALL_USER:-required}]: " answer
        INSTALL_USER=${answer:-$INSTALL_USER}
        if ((MODE_SET == 0)); then
            read -r -p 'Startup mode: desktop or dedicated (replaces graphical login) [desktop]: ' answer
            MODE=${answer:-desktop}
        fi
        if [[ -z $VERSION && -z $SOURCE_BINARY ]]; then
            read -r -p 'Release: keep installed app, latest, or a version [keep]: ' answer
            if [[ -n $answer && $answer != keep ]]; then VERSION=$answer; fi
        fi
    fi
    [[ $MODE == desktop || $MODE == dedicated ]] || fail 'Mode must be desktop or dedicated'
    [[ -n $INSTALL_USER && $INSTALL_USER != root && $INSTALL_USER =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ ]] || fail 'Specify a non-root runtime user with --user'
    USER_ID=$(id -u "$INSTALL_USER")
    USER_GROUP=$(id -gn "$INSTALL_USER")
    USER_HOME=$(getent passwd "$INSTALL_USER" | cut -d: -f6)
    [[ $USER_HOME == /* && -d $USER_HOME && $USER_HOME != / ]] || fail 'Runtime user needs an existing home directory'
    if [[ -f /etc/betterframe/linux-install ]]; then
        previous=$(cat /etc/betterframe/linux-install)
        [[ $previous == "$INSTALL_USER $MODE" ]] || fail "Existing setup uses '$previous'; restore its startup configuration before changing user/mode"
    fi
    for directory in /opt/betterframe/kiosk "$STATE"; do
        [[ ! -L $directory ]] || fail "Refusing symlink: $directory"
        if [[ -d $directory ]]; then
            owner=$(stat -c %u "$directory")
            [[ $owner == 0 || $owner == "$USER_ID" ]] || fail "$directory belongs to another user; specify that runtime user"
        fi
    done
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID=$ID; DISTRO_LIKE=${ID_LIKE:-}
    select_packages
    model=
    if [[ -r /proc/device-tree/model ]]; then model=$(tr -d '\0' < /proc/device-tree/model); fi
    select_target "$(uname -m)" "$model"
    if [[ -z $VERSION && -z $SOURCE_BINARY ]]; then
        if [[ -f $BIN ]]; then
            SOURCE_BINARY=$BIN
        else
            pid=$(user_systemctl show betterframe.service --property MainPID --value 2>/dev/null || true)
            if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
                running=$(readlink -f "/proc/$pid/exe" || true)
                if [[ ${running##*/} == betterframe-kiosk* && -f $running ]]; then SOURCE_BINARY=$running; fi
            fi
        fi
    fi
    if [[ -z $VERSION && -z $SOURCE_BINARY && -f $USER_HOME/.config/systemd/user/betterframe.service ]]; then
        fail 'Existing BF service is stopped or its binary could not be located. Rerun with --binary /path/to/your/app or --version VERSION'
    fi
    printf 'Installing prerequisites with %s for %s (%s).\n' "$PACKAGE_MANAGER" "$INSTALL_USER" "$MODE"
    if [[ $PACKAGE_MANAGER == apt-get ]]; then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"
    else
        dnf install -y "${PACKAGES[@]}"
    fi
    STAGING=$(mktemp -d)
    trap 'rm -rf -- "$STAGING"' EXIT
    if [[ -z $SOURCE_BINARY ]]; then download_release; fi
    [[ -f $SOURCE_BINARY ]] || fail "Missing app binary: $SOURCE_BINARY"
    cp -- "$SOURCE_BINARY" "$STAGING/candidate"
    check_binary "$STAGING/candidate"
    # Do not stop or replace a working app until validation has passed.
    BACKUP_ID=$(date +%Y%m%dT%H%M%S)-$$
    unit_dir="$USER_HOME/.config/systemd/user"
    autostart_dir="$USER_HOME/.config/autostart"
    install -d -m 755 /etc/betterframe /usr/local/libexec
    install -d -o "$INSTALL_USER" -g "$USER_GROUP" -m 755 /opt/betterframe/kiosk
    install -d -o "$INSTALL_USER" -g "$USER_GROUP" -m 700 "$STATE"
    # Repair root-owned state from manual installs, without following symlinks.
    find "$STATE" -xdev \( -type f -o -type d \) -exec chown "$INSTALL_USER:$USER_GROUP" {} +
    install -m 755 "$SCRIPT_DIR/deploy/systemd/betterframe-firmware-rollback.sh" /usr/local/libexec/betterframe-rollback
    runuser -u "$INSTALL_USER" -- mkdir -p -- "$unit_dir" "$autostart_dir"
    for file in "$unit_dir/betterframe.service" "$autostart_dir/betterframe.desktop"; do backup "$file"; done
    if [[ -S /run/user/$USER_ID/bus ]]; then
        # Existing manual units often set DISPLAY locally rather than importing
        # it into the manager. Preserve that real session before replacing them.
        pid=$(user_systemctl show betterframe.service --property MainPID --value 2>/dev/null || true)
        if [[ $pid =~ ^[1-9][0-9]*$ && -r /proc/$pid/environ ]]; then
            mapfile -d '' -t session_environment < <(python3 - "$pid" <<'PYENV'
from pathlib import Path
import sys
allowed = {b'DISPLAY', b'WAYLAND_DISPLAY', b'XAUTHORITY', b'XDG_SESSION_TYPE', b'XDG_CURRENT_DESKTOP'}
try:
    entries = Path(f'/proc/{int(sys.argv[1])}/environ').read_bytes().split(b'\0')
except OSError:
    entries = []
for entry in entries:
    if entry.partition(b'=')[0] in allowed:
        sys.stdout.buffer.write(entry + b'\0')
PYENV
)
            if ((${#session_environment[@]})); then user_systemctl set-environment "${session_environment[@]}"; fi
        fi
        if ((START)) && [[ $MODE == desktop ]]; then user_systemctl stop betterframe.service || true; fi
        user_systemctl disable betterframe.service 2>/dev/null || true
    fi
    if [[ -f /etc/systemd/system/betterframe-kiosk.service ]]; then
        backup /etc/systemd/system/betterframe-kiosk.service
        systemctl disable betterframe-kiosk.service
        if ((START)) && [[ $MODE == desktop ]]; then systemctl stop betterframe-kiosk.service; fi
    fi
    install_app_binary
    if command -v restorecon >/dev/null; then restorecon -RF /opt/betterframe /usr/local/libexec/betterframe-rollback; fi
    if [[ $MODE == desktop ]]; then
        write_desktop_unit > "$unit_dir/betterframe.service"
        write_launcher > /usr/local/libexec/betterframe-desktop
        chmod 755 /usr/local/libexec/betterframe-desktop
        cat > "$autostart_dir/betterframe.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=BetterFrame
Exec=/usr/local/libexec/betterframe-desktop
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
        chown "$INSTALL_USER:$USER_GROUP" "$unit_dir/betterframe.service" "$autostart_dir/betterframe.desktop"
        if [[ -S /run/user/$USER_ID/bus ]]; then
            user_systemctl daemon-reload
            if ((START)) && user_systemctl show-environment | grep -Eq '^(DISPLAY|WAYLAND_DISPLAY)=.'; then
                user_systemctl start betterframe.service
            fi
        fi
        printf 'BetterFrame starts at the next graphical login (or now if the user manager has a display).\n'
    else
        rm -f -- "$autostart_dir/betterframe.desktop"
        write_dedicated_unit > /etc/systemd/system/betterframe-kiosk.service
        backup /etc/pam.d/betterframe-kiosk
        cat > /etc/pam.d/betterframe-kiosk <<'EOF'
auth required pam_permit.so
account required pam_permit.so
session required pam_loginuid.so
session required pam_systemd.so
EOF
        if [[ ! -f /etc/betterframe/previous-default-target ]]; then
            systemctl get-default > /etc/betterframe/previous-default-target
        fi
        systemctl daemon-reload
        systemctl enable betterframe-kiosk.service
        systemctl set-default multi-user.target
        printf 'Dedicated kiosk enabled for next boot. Reboot when ready; your current desktop remains running.\n'
    fi
    printf '%s %s\n' "$INSTALL_USER" "$MODE" > /etc/betterframe/linux-install
    printf 'Installed app: %s\nPairing/state preserved: %s\nOS updates are disabled for this standalone installation.\n' "$BIN" "$STATE"
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
