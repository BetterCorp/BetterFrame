#!/usr/bin/env bash
# BetterFrame standalone Linux app installer. No checkout or companion files required.
# See README.md for the one-line bootstrap, or run sudo bash setup.sh --help.
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
USER_SET=0
CHANNEL=stable
CHANNEL_SET=0
MEDIA_GATEWAY=on
MEDIA_SET=0
MEDIA_SAVED=0
CONFIG=/etc/betterframe/linux-install
PREVIOUS_INSTALL=0
PRESERVE_PREVIOUS=0
RELEASE_VERSION=

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'EOF'
Install, update, or repair the BetterFrame Linux app (systemd required).
  sudo ./setup.sh [options]
  --user USER       Desktop/runtime user (defaults to sudo caller)
  --mode desktop    Start on graphical login (default)
  --mode dedicated  Replace graphical login with a Cage fullscreen kiosk
  --channel CHANNEL stable (default), beta, or dev; remembered for reruns
  --media-gateway on|off Install MediaMTX for preview/recording (default: on)
  --version VERSION Download a signed GitHub release (e.g. 1.0.14 or latest)
  --binary FILE     Install an existing, trusted local BF executable
  --yes             Reuse saved choices without prompting (desktop on first run)
  --no-start        Configure startup but do not start/restart BF now
  --help            Show this help
Every normal run downloads the latest signed release for the saved channel.
--version and --binary override the release for this run only. Pairing is preserved.
Dedicated mode starts immediately when no display manager is active. No OS reboot.
EOF
}
parse_args() {
    while (($#)); do
        case "$1" in
            --user|--mode|--version|--binary|--channel|--media-gateway)
                (($# >= 2)) || fail "$1 requires a value"
                case "$1" in
                    --user) INSTALL_USER=$2; USER_SET=1;;
                    --channel) CHANNEL=$2; CHANNEL_SET=1;;
                    --media-gateway) MEDIA_GATEWAY=$2; MEDIA_SET=1;;
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
    timeout 30 runuser -u "$INSTALL_USER" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" \
        DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_ID/bus" systemctl --user "$@"
}
disable_user_app_offline() {
    # Enablement is filesystem state; --no-reload works without a user bus.
    local units
    units=$(runtime_command env XDG_CONFIG_HOME="$USER_HOME/.config" \
        systemctl --user --no-reload list-unit-files --no-legend --no-pager)
    if [[ $'\n'$units == *$'\nbetterframe.service '* ]]; then
        runtime_command env XDG_CONFIG_HOME="$USER_HOME/.config" \
            systemctl --user --no-reload disable betterframe.service
    fi
}
load_distribution() {
    local distribution
    # os-release also defines VERSION and other names used by this installer.
    # Read it in a subshell so only the distribution identifiers escape.
    distribution=$(
        # shellcheck disable=SC1090,SC1091
        . "${1:-/etc/os-release}" || exit
        printf '%s|%s|%s' "$ID" "${ID_LIKE:-}" "${VERSION_ID:-}"
    ) || return
    IFS='|' read -r DISTRO_ID DISTRO_LIKE DISTRO_VERSION <<< "$distribution"
}

validate_distribution() {
    local minimum=
    case "$DISTRO_ID" in ubuntu) minimum=24;; debian) minimum=13;; esac
    if [[ -n $minimum ]]; then
        [[ ${DISTRO_VERSION:-} =~ ^[0-9]+([.][0-9]+)*$ ]] || fail "Cannot determine $DISTRO_ID release; BF needs GTK 4.14+ and WebKitGTK 6.0"
        local major=${DISTRO_VERSION%%.*}
        ((10#$major >= minimum)) || fail "Unsupported $DISTRO_ID $DISTRO_VERSION: use Ubuntu 24.04+ or Debian 13+ (GTK 4.14+ and WebKitGTK 6.0 required)"
    fi
}
check_runtime_libraries() {
    python3 - <<'PYRUNTIME'
import ctypes
try:
    gtk = ctypes.CDLL('libgtk-4.so.1')
    version = (gtk.gtk_get_major_version(), gtk.gtk_get_minor_version())
    if version < (4, 14):
        raise RuntimeError(f'installed GTK is {version[0]}.{version[1]}')
    ctypes.CDLL('libwebkitgtk-6.0.so.4')
except (OSError, RuntimeError) as error:
    raise SystemExit(f'Unsupported runtime: BF requires GTK 4.14+ and WebKitGTK 6.0 ({error}). Existing app was not replaced.')
PYRUNTIME
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
    if [[ -e $1 ]]; then cp -a --remove-destination -- "$1" "$1.before-setup.$BACKUP_ID"; fi
}
load_settings() {
    local saved_user saved_mode saved_channel saved_media extra
    if [[ -f $CONFIG ]]; then
        read -r saved_user saved_mode saved_channel saved_media extra < "$CONFIG"
        [[ -z $extra && $saved_user =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ && $saved_user != root ]] || fail 'Invalid saved installer user'
        [[ $saved_mode == desktop || $saved_mode == dedicated ]] || fail 'Invalid saved installer mode'
        saved_channel=${saved_channel:-stable} # Migrate the original two-field format.
        [[ $saved_channel == stable || $saved_channel == beta || $saved_channel == dev ]] || fail 'Invalid saved installer channel'
        if [[ -n $saved_media ]]; then
            [[ $saved_media == on || $saved_media == off ]] || fail 'Invalid saved media gateway option'
            MEDIA_SAVED=1
            if ((MEDIA_SET == 0)); then MEDIA_GATEWAY=$saved_media; fi
        fi
        if ((USER_SET == 0)); then INSTALL_USER=$saved_user; fi
        if ((MODE_SET == 0)); then MODE=$saved_mode; fi
        if ((CHANNEL_SET == 0)); then CHANNEL=$saved_channel; fi
        [[ $INSTALL_USER == "$saved_user" && $MODE == "$saved_mode" ]] || fail 'Changing the runtime user/mode requires restoring the old startup configuration first'
        PREVIOUS_INSTALL=1
    fi
    if ((CHANNEL_SET == 0)) && [[ -n $VERSION && $VERSION != latest ]]; then
        case "$VERSION" in *-dev*|*-alpha*) CHANNEL=dev;; *-beta*) CHANNEL=beta;; *) CHANNEL=stable;; esac
    fi
    [[ $CHANNEL == stable || $CHANNEL == beta || $CHANNEL == dev ]] || fail 'Channel must be stable, beta, or dev'
    [[ $MEDIA_GATEWAY == on || $MEDIA_GATEWAY == off ]] || fail 'Media gateway must be on or off'
}
# Write canonical managed files atomically. Identical reruns do not create backups.
reconcile_file() {
    local owner=$3
    if [[ $EUID == 0 && $owner != root && $owner != 0 ]]; then
        # Everything beneath a runtime user's home is written with that user's
        # privileges, including temporary files and permission repairs.
        runuser -u "$owner" -- bash -c "$(declare -f backup reconcile_file_local)
set -euo pipefail
BACKUP_ID=\$1; shift
reconcile_file_local \"\$@\"" -- "$BACKUP_ID" "$@"
    else
        reconcile_file_local "$@"
    fi
}
runtime_command() {
    if [[ $INSTALL_USER == "$EUID" || $(id -u "$INSTALL_USER") == "$EUID" ]]; then
        "$@"
    else
        runuser -u "$INSTALL_USER" -- "$@"
    fi
}
runtime_backup() {
    if [[ -e $1 || -L $1 ]]; then
        runtime_command cp -a --remove-destination -- "$1" "$1.before-setup.$BACKUP_ID"
    fi
}
reconcile_file_local() {
    local destination=$1 mode=$2 owner=$3 group=$4 candidate
    candidate=$(mktemp "$(dirname "$destination")/.bf-setup.XXXXXX")
    cat > "$candidate"
    chmod "$mode" "$candidate"
    chown "$owner:$group" "$candidate"
    if [[ ! -L $destination && -f $destination ]] && cmp -s "$candidate" "$destination" &&
        [[ $(stat -c '%a %u %g' "$candidate") == "$(stat -c '%a %u %g' "$destination")" ]]; then
        rm -f -- "$candidate"
    else
        if [[ -L $destination ]] || ! cmp -s "$candidate" "$destination"; then backup "$destination"; fi
        mv -fT -- "$candidate" "$destination"
    fi
}
service_command() {
    local scope=$1; shift
    if [[ $scope == user ]]; then user_systemctl "$@"; else timeout 30 systemctl "$@"; fi
}
stop_app_service() {
    local scope=$1 unit=$2 selected=0
    if [[ ( $MODE == desktop && $scope == user ) || ( $MODE == dedicated && $scope == system ) ]]; then selected=1; fi
    if [[ $(service_command "$scope" show "$unit" -p LoadState --value) == not-found ]]; then return; fi
    if ((selected)); then
        if service_command "$scope" is-active --quiet "$unit"; then PRESERVE_PREVIOUS=0; fi
        if service_command "$scope" is-failed --quiet "$unit"; then PRESERVE_PREVIOUS=1; fi
    fi
    if ! service_command "$scope" stop "$unit"; then
        if ((selected)); then PRESERVE_PREVIOUS=1; fi
        service_command "$scope" kill --kill-whom=all --signal=KILL "$unit" || true
        service_command "$scope" stop "$unit" || fail "Cannot stop $unit; app was not replaced"
    fi
    local state
    state=$(service_command "$scope" show "$unit" -p ActiveState --value)
    [[ $state == inactive || $state == failed ]] || fail "$unit is still $state; app was not replaced"
}
clear_interrupted_update() {
    # Called only after the managed processes are stopped and the candidate is
    # validated. Preserve identity, bundle, keys and OS-update state.
    local file
    for file in firmware-applying.json firmware-applying.attempts; do
        runtime_backup "$STATE/$file"
        if [[ $file != firmware-applying.json || ${1:-} != keep-marker ]]; then
            runtime_command rm -f -- "$STATE/$file"
        fi
    done
    runtime_command rm -f -- "$BIN.new"
    if [[ -f $STATE/update-attempts.json ]]; then
        runtime_command python3 - "$STATE/update-attempts.json" "$BACKUP_ID" <<'PYGUARD'
import json, os, pathlib, shutil, sys
p = pathlib.Path(sys.argv[1])
try:
    state = json.loads(p.read_text())
    entries = state['entries']
    if not isinstance(entries, dict):
        raise ValueError('invalid entries')
except (ValueError, KeyError, TypeError):
    # The app already treats malformed history as empty. Preserve it for diagnosis.
    print('Preserving unreadable update history; app retry counters will start empty.', file=sys.stderr)
else:
    app_keys = [key for key in entries if key.startswith('firmware:')]
    if app_keys:
        shutil.copy2(p, str(p) + '.before-setup.' + sys.argv[2])
        for key in app_keys:
            del entries[key]
        temporary = p.with_name(p.name + '.setup-new')
        temporary.unlink(missing_ok=True)
        temporary.write_text(json.dumps(state))
        info = p.stat()
        os.chmod(temporary, info.st_mode & 0o777)
        os.chown(temporary, info.st_uid, info.st_gid)
        os.replace(temporary, p)
PYGUARD
    fi
}
arm_setup_candidate() {
    runtime_command python3 - "$STATE/firmware-applying.json" "$BIN" "$RELEASE_VERSION" "${1:-$BIN}" <<'PYMARKER'
import hashlib, json, os, pathlib, sys, tempfile, time
marker, binary, version, candidate = sys.argv[1:]
with open(candidate, 'rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
fd, temporary = tempfile.mkstemp(prefix='.bf-app-marker-', dir=pathlib.Path(marker).parent)
try:
    with os.fdopen(fd, 'w') as stream:
        json.dump(dict(version=version, sha256=digest, attempt_at=str(int(time.time())),
                       confirmed=False, bin=binary, prev=binary + '.prev'), stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, marker)
finally:
    if os.path.exists(temporary): os.unlink(temporary)
PYMARKER
}
start_app_service() {
    local scope=$1 unit=$2 initial_pid current_pid
    if service_command "$scope" is-failed --quiet "$unit"; then
        service_command "$scope" reset-failed "$unit" || printf 'Could not clear failed state for %s; attempting startup.\n' "$unit" >&2
    fi
    if service_command "$scope" start "$unit"; then
        initial_pid=$(service_command "$scope" show "$unit" -p MainPID --value)
        sleep 3
        current_pid=$(service_command "$scope" show "$unit" -p MainPID --value)
        if [[ $initial_pid =~ ^[1-9][0-9]*$ && $initial_pid == "$current_pid" ]] && service_command "$scope" is-active --quiet "$unit"; then return; fi
    fi
    printf 'App did not stay running; restoring the previous executable if available.\n' >&2
    stop_app_service "$scope" "$unit"
    if [[ -f $BIN.prev ]]; then
        runtime_command rm -f -- "$BIN.new"
        runtime_command install -m 755 "$BIN.prev" "$BIN.new"
        runtime_command mv -fT -- "$BIN.new" "$BIN"
        runtime_command rm -f -- "$STATE/firmware-applying.json" "$STATE/firmware-applying.attempts"
        service_command "$scope" reset-failed "$unit" || printf 'Could not clear failed state for %s; attempting startup.\n' "$unit" >&2
        service_command "$scope" start "$unit" || true
    fi
    local option=
    if [[ $scope == user ]]; then option=--user; fi
    fail "App startup failed. Inspect journalctl $option -u $unit"
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
select_channel_release() {
    python3 - "$1" "$CHANNEL" "$TARGET" <<'PYRELEASE'
import json, re, sys
releases = json.load(open(sys.argv[1]))
if not isinstance(releases, list):
    raise SystemExit('Invalid release response')
choices = []
for release in releases:
    tag = release.get('tag_name', '')
    channel_pattern = '(?:dev|alpha)' if sys.argv[2] == 'dev' else re.escape(sys.argv[2])
    if release.get('draft') or not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+-' + channel_pattern + r'(?:[.-][a-zA-Z0-9.-]+)?', tag):
        continue
    artifact = f'betterframe-kiosk-{tag[1:]}-{sys.argv[3]}'
    names = {a.get('name') for a in release.get('assets', [])}
    if all(artifact + suffix in names for suffix in ('', '.sha256', '.sig')):
        choices.append(release)
if choices:
    print(max(choices, key=lambda r: r.get('published_at') or '')['tag_name'])
PYRELEASE
}
download_release() {
    local base='https://github.com/BetterCorp/BetterFrame' tag asset
    if [[ ( $VERSION == latest || -z $VERSION ) && $CHANNEL == stable ]]; then
        tag=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
            --connect-timeout 15 --max-time 120 --output /dev/null --write-out '%{url_effective}' "$base/releases/latest")
        tag=${tag##*/}
    elif [[ $VERSION == latest || -z $VERSION ]]; then
        # Public release metadata; downloads still require the embedded vendor key.
        # Page through recent releases rather than silently falling back to stable.
        local page
        tag=
        for page in {1..10}; do
            curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
                --proto '=https' --proto-redir '=https' \
                "https://api.github.com/repos/BetterCorp/BetterFrame/releases?per_page=100&page=$page" \
                --output "$STAGING/releases.json"
            tag=$(select_channel_release "$STAGING/releases.json")
            [[ -z $tag ]] || break
            [[ $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$STAGING/releases.json") == 100 ]] || break
        done
        [[ -n $tag ]] || fail "No downloadable $CHANNEL release found; specify --version VERSION"
    else
        tag=v${VERSION#v}
    fi
    [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9.-]+)?$ ]] || fail "Invalid release tag: $tag"
    RELEASE_VERSION=${tag#v}
    asset="betterframe-kiosk-$RELEASE_VERSION-$TARGET"
    SOURCE_BINARY="$STAGING/$asset"
    local suffix
    for suffix in '' .sha256 .sig; do
        curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 600 --proto '=https' --proto-redir '=https' \
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
prepare_candidate() {
    if [[ -z $SOURCE_BINARY ]]; then download_release; fi
    [[ -f $SOURCE_BINARY ]] || fail "Missing app binary: $SOURCE_BINARY"
    cp -- "$SOURCE_BINARY" "$STAGING/candidate"
    check_binary "$STAGING/candidate"
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
    runtime_command rm -f -- "$BIN.new" "$BIN.prev.new"
    if [[ -f $BIN && ! -f $STATE/firmware-applying.json && ( $PRESERVE_PREVIOUS == 0 || ! -f $BIN.prev ) ]] && ! cmp -s "$BIN" "$STAGING/candidate"; then
        runtime_command install -m 755 "$BIN" "$BIN.prev.new"
        runtime_command mv -fT -- "$BIN.prev.new" "$BIN.prev"
    fi
    clear_interrupted_update keep-marker
    # The validated staging file is private to root. Stream it to an
    # unprivileged writer instead of granting access to the staging directory.
    # shellcheck disable=SC2016 # Positional parameters belong to the child shell.
    runtime_command sh -c 'set -eu; umask 077; cat > "$1"; chmod 755 "$1"' sh "$BIN.new" < "$STAGING/candidate"
    # Publish protection before replacing the executable. Failures/interruption
    # up to the final rename leave the existing app in place.
    arm_setup_candidate "$BIN.new"
    runtime_command mv -fT -- "$BIN.new" "$BIN"
}
# Embedded for single-file installation. Keep identical to the deployment helper;
# scripts/test-linux-setup.py checks that the two copies cannot drift.
write_rollback_helper() {
    cat <<'BF_ROLLBACK_HELPER'
#!/usr/bin/env bash
# Roll back the kiosk binary if an app OTA candidate never confirms healthy.
#
# The kiosk writes MARKER just before swapping in a new binary and removes it
# after a healthy UI frame or successful post-boot heartbeat. This script runs
# from the app service ExecStartPre, so it can recover even when the new
# kiosk binary exits before Rust code can run.

set -euo pipefail

BIN="/opt/betterframe/kiosk/betterframe-kiosk"
PREV="${BIN}.prev"
MARKER="/var/lib/betterframe/kiosk/firmware-applying.json"
ATTEMPTS="/var/lib/betterframe/kiosk/firmware-applying.attempts"
MAX_ATTEMPTS=3
MAX_AGE_SECONDS=120

clear_bookkeeping() {
  # Once restoration succeeds, read-only state must not prevent the old app
  # from launching. Remaining state can be retried on the next service start.
  if ! rm -f "$MARKER" "$ATTEMPTS"; then
    echo "[bf-firmware-rollback] could not clear startup bookkeeping; continuing with restored/current app" >&2
  fi
}

if [ ! -f "$MARKER" ]; then
  clear_bookkeeping
  exit 0
fi

rollback() {
  local reason="$1"
  if [ -f "$PREV" ]; then
    echo "[bf-firmware-rollback] ${reason}; .prev exists, rolling back" >&2
    cp -f "$PREV" "$BIN"
    chmod +x "$BIN"
    clear_bookkeeping
  else
    echo "[bf-firmware-rollback] ${reason}; no .prev, clearing marker and leaving current binary" >&2
    clear_bookkeeping
  fi
}

attempts=0
if [ -f "$ATTEMPTS" ]; then
  attempts=$(cat "$ATTEMPTS" 2>/dev/null || echo 0)
fi
case "$attempts" in
  ''|*[!0-9]*) attempts=0 ;;
esac

# Start the health deadline when the candidate is actually launched. Setup may
# install it hours before the next desktop login or dedicated-kiosk boot.
if [ "$attempts" -eq 0 ]; then
  if ! touch "$MARKER"; then
    rollback "cannot initialize candidate health deadline"
    exit 0
  fi
fi

marker_mtime=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER" 2>/dev/null || echo 0)
now=$(date +%s)
age=$(( now - marker_mtime ))

if [ "$age" -ge "$MAX_AGE_SECONDS" ]; then
  rollback "apply marker is stale (${age}s old)"
  exit 0
fi

if [ "$attempts" -ge "$MAX_ATTEMPTS" ]; then
  rollback "candidate failed to confirm after ${attempts} start attempts"
  exit 0
fi

attempts=$((attempts + 1))
if ! printf '%s\n' "$attempts" > "$ATTEMPTS"; then
  rollback "cannot record candidate start attempt"
  exit 0
fi
echo "[bf-firmware-rollback] pending firmware candidate start attempt ${attempts}/${MAX_ATTEMPTS}" >&2
BF_ROLLBACK_HELPER
}
# Keep the bundled gateway version/config aligned with managed images.
MEDIAMTX_VERSION=1.19.3
verify_mediamtx_archive() {
    python3 - "$STAGING/$MEDIAMTX_ARCHIVE" "$STAGING/mediamtx-checksums" "$STAGING/mediamtx" <<'PYMTX'
import hashlib, pathlib, sys, tarfile
archive, checksums, output = map(pathlib.Path, sys.argv[1:])
entries = [line.split() for line in checksums.read_text().splitlines()]
expected = [parts[0] for parts in entries if len(parts) == 2 and parts[1].lstrip('*') == archive.name]
if len(expected) != 1 or hashlib.sha256(archive.read_bytes()).hexdigest() != expected[0].lower():
    raise SystemExit('MediaMTX checksum mismatch or missing checksum')
with tarfile.open(archive, 'r:gz') as bundle:
    members = [member for member in bundle.getmembers() if member.name == 'mediamtx']
    if len(members) != 1 or not members[0].isfile():
        raise SystemExit('MediaMTX archive must contain one regular executable')
    with bundle.extractfile(members[0]) as source, output.open('wb') as dest:
        import shutil
        shutil.copyfileobj(source, dest)
PYMTX
    chmod 755 "$STAGING/mediamtx"
}
download_mediamtx() {
    local arch=amd64 base
    if [[ $TARGET == betterframe-rpi5-aarch64 ]]; then arch=arm64; fi
    MEDIAMTX_ARCHIVE="mediamtx_v${MEDIAMTX_VERSION}_linux_${arch}.tar.gz"
    base="https://github.com/bluenviron/mediamtx/releases/download/v$MEDIAMTX_VERSION"
    curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 600 \
        --proto '=https' --proto-redir '=https' "$base/$MEDIAMTX_ARCHIVE" -o "$STAGING/$MEDIAMTX_ARCHIVE"
    curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 120 \
        --proto '=https' --proto-redir '=https' "$base/checksums.sha256" -o "$STAGING/mediamtx-checksums"
    verify_mediamtx_archive
    "$STAGING/mediamtx" --version
}
write_mediamtx_config() {
    cat <<'BF_MEDIAMTX_CONFIG'
logLevel: warn
api: true
apiAddress: 127.0.0.1:9997
metrics: false
pprof: false
rtsp: false
rtmp: false
hls: false
webrtc: true
webrtcAddress: 127.0.0.1:8889
webrtcAllowOrigins: ["*"]
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
srt: false
moq: false
playback: true
playbackAddress: 127.0.0.1:9996
pathDefaults:
  sourceOnDemand: true
  sourceOnDemandCloseAfter: 10s
paths: {}
BF_MEDIAMTX_CONFIG
}
write_mediamtx_unit() {
    cat <<EOF
[Unit]
Description=BetterFrame local media gateway and recorder
After=network.target
Before=betterframe-kiosk.service
StartLimitIntervalSec=0

[Service]
User=$INSTALL_USER
Group=$USER_GROUP
ExecStart=/opt/betterframe/mediamtx/mediamtx /etc/betterframe/mediamtx.yml
Restart=always
RestartSec=2
TimeoutStopSec=15
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/betterframe/recordings

[Install]
WantedBy=multi-user.target
EOF
}
install_mediamtx() {
    local directory
    for directory in /opt/betterframe/mediamtx /var/lib/betterframe/recordings; do
        [[ ! -L $directory ]] || fail "Refusing symlink: $directory"
    done
    if ((START)); then
        # Do not let gateway failure alter the app's rollback selection.
        (stop_app_service system betterframe-mediamtx.service)
    elif systemctl is-active --quiet betterframe-mediamtx.service; then
        fail '--no-start requires MediaMTX to be stopped as well'
    fi
    systemctl unmask betterframe-mediamtx.service
    systemctl unmask --runtime betterframe-mediamtx.service
    install -d -o root -g root -m 755 /opt/betterframe/mediamtx
    install -d -o "$INSTALL_USER" -g "$USER_GROUP" -m 750 /var/lib/betterframe/recordings
    reconcile_file /opt/betterframe/mediamtx/mediamtx 755 root root < "$STAGING/mediamtx"
    write_mediamtx_config | reconcile_file /etc/betterframe/mediamtx.yml 644 root root
    write_mediamtx_unit | reconcile_file /etc/systemd/system/betterframe-mediamtx.service 644 root root
    systemctl daemon-reload
    systemctl enable betterframe-mediamtx.service
    if ((START)); then
        systemctl reset-failed betterframe-mediamtx.service || printf 'Could not clear failed state; attempting MediaMTX startup.\n' >&2
        systemctl start betterframe-mediamtx.service
        # Service activation alone does not prove the gateway API is reachable.
        local _attempt
        for _attempt in {1..10}; do
            if systemctl is-active --quiet betterframe-mediamtx.service &&
                curl --fail --silent --max-time 2 http://127.0.0.1:9997/v3/config/global/get >/dev/null; then
                printf 'MediaMTX %s is ready.\n' "$MEDIAMTX_VERSION"
                return
            fi
            sleep 1
        done
        fail 'MediaMTX API is unavailable; inspect journalctl -u betterframe-mediamtx.service'
    fi
}

write_desktop_unit() {
    cat <<'EOF'
[Unit]
Description=BetterFrame app
PartOf=graphical-session.target
StartLimitIntervalSec=0

[Service]
ExecStartPre=/usr/local/libexec/betterframe-rollback
ExecStart=/opt/betterframe/kiosk/betterframe-kiosk
Environment=BF_KIOSK_BINARY=/opt/betterframe/kiosk/betterframe-kiosk
Environment=BF_ENABLE_APP_OTA=1
Environment=BF_ENABLE_OS_OTA=0
Restart=always
RestartSec=3
TimeoutStopSec=15
KillMode=control-group
UMask=0077
EOF
}
write_repair_override() {
    cat <<'EOF'
# Managed by setup.sh; custom server settings belong in override.conf.
[Unit]
FailureAction=none
SuccessAction=none
StartLimitAction=none
StartLimitIntervalSec=0

[Service]
ExecStart=
EOF
    if [[ $MODE == desktop ]]; then
        printf 'ExecStart=/usr/bin/env BF_KIOSK_BINARY=%s BF_ENABLE_APP_OTA=1 BF_ENABLE_OS_OTA=0 %s\n' "$BIN" "$BIN"
    else
        printf 'ExecStart=/usr/bin/env BF_KIOSK_BINARY=%s BF_ENABLE_APP_OTA=1 BF_ENABLE_OS_OTA=0 /usr/bin/cage -s -- %s\n' "$BIN" "$BIN"
    fi
    cat <<'EOF'
ExecStartPre=
ExecStartPre=/usr/local/libexec/betterframe-rollback
Restart=always
RestartSec=3
TimeoutStopSec=15
KillMode=control-group
SendSIGKILL=yes
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
if systemctl --user is-failed --quiet betterframe.service; then
    systemctl --user reset-failed betterframe.service || printf 'Could not clear failed state; attempting BF startup.\n' >&2
fi
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
StartLimitIntervalSec=0

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
TimeoutStopSec=15
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}
main() {
    parse_args "$@"
    printf 'BetterFrame setup revision 2026-09-20.8\n'
    [[ $(uname -s) == Linux ]] || fail 'This installer requires Linux'
    [[ $EUID == 0 ]] || fail 'Run with sudo (or root and --user USER)'
    [[ -d /run/systemd/system ]] || fail 'This installer requires systemd'
    [[ ! -e /etc/betterframe/managed-image ]] || fail 'Use the managed-image updater on this device'
    command -v flock >/dev/null || fail 'Install util-linux (flock) before running setup'
    exec 9>/run/lock/betterframe-setup.lock
    flock -n 9 || fail 'Another BetterFrame setup is already running'
    load_settings
    if [[ -t 0 && $ASSUME_YES == 0 && $PREVIOUS_INSTALL == 0 ]]; then
        read -r -p "Run BetterFrame as user [${INSTALL_USER:-required}]: " answer
        INSTALL_USER=${answer:-$INSTALL_USER}
        if ((MODE_SET == 0)); then
            read -r -p 'Startup mode: desktop or dedicated (replaces graphical login) [desktop]: ' answer
            MODE=${answer:-desktop}
        fi
        if [[ -z $VERSION && -z $SOURCE_BINARY ]]; then
            read -r -p "Release channel: stable, beta, or dev [$CHANNEL]: " answer
            CHANNEL=${answer:-$CHANNEL}
        fi
    fi
    if [[ -t 0 && $ASSUME_YES == 0 && $MEDIA_SET == 0 && $MEDIA_SAVED == 0 ]]; then
        read -r -p 'Install MediaMTX for Operator Console preview and optional recording? [Y/n]: ' answer
        case "$answer" in
            ''|y|Y|yes|YES) MEDIA_GATEWAY=on;;
            n|N|no|NO) MEDIA_GATEWAY=off;;
            *) fail 'Answer yes or no, or pass --media-gateway on|off';;
        esac
    fi
    [[ $MODE == desktop || $MODE == dedicated ]] || fail 'Mode must be desktop or dedicated'
    [[ -n $INSTALL_USER && $INSTALL_USER != root && $INSTALL_USER =~ ^[a-zA-Z_][a-zA-Z0-9_-]*\$?$ ]] || fail 'Specify a non-root runtime user with --user'
    [[ $CHANNEL == stable || $CHANNEL == beta || $CHANNEL == dev ]] || fail 'Channel must be stable, beta, or dev'
    USER_ID=$(id -u "$INSTALL_USER")
    USER_GROUP=$(id -gn "$INSTALL_USER")
    USER_HOME=$(getent passwd "$INSTALL_USER" | cut -d: -f6)
    [[ $USER_HOME == /* && -d $USER_HOME && $USER_HOME != / ]] || fail 'Runtime user needs an existing home directory'
    for directory in /opt/betterframe/kiosk "$STATE"; do
        [[ ! -L $directory ]] || fail "Refusing symlink: $directory"
        if [[ -d $directory ]]; then
            owner=$(stat -c %u "$directory")
            [[ $owner == 0 || $owner == "$USER_ID" ]] || fail "$directory belongs to another user; specify that runtime user"
        fi
    done
    load_distribution /etc/os-release
    validate_distribution
    select_packages
    model=
    if [[ -r /proc/device-tree/model ]]; then model=$(tr -d '\0' < /proc/device-tree/model); fi
    select_target "$(uname -m)" "$model"
    printf 'Installing prerequisites with %s for %s (%s).\n' "$PACKAGE_MANAGER" "$INSTALL_USER" "$MODE"
    if [[ $PACKAGE_MANAGER == apt-get ]]; then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${PACKAGES[@]}"
    else
        dnf install -y "${PACKAGES[@]}"
    fi
    check_runtime_libraries
    STAGING=$(mktemp -d)
    trap 'rm -rf -- "$STAGING"' EXIT
    prepare_candidate
    if [[ $MEDIA_GATEWAY == on ]]; then download_mediamtx; fi
    # Do not stop or replace a working app until validation has passed.
    BACKUP_ID=$(date +%Y%m%dT%H%M%S)-$$
    unit_dir="$USER_HOME/.config/systemd/user"
    autostart_dir="$USER_HOME/.config/autostart"
    # Secure BF's parent directories before touching runtime-writable children.
    # Users can replace entries inside their directories, but cannot redirect
    # these root-owned parent entries while reconciliation is in progress.
    for directory in /opt/betterframe /var/lib/betterframe /etc/betterframe /usr/local/libexec; do
        [[ ! -L $directory ]] || fail "Refusing symlink parent: $directory"
        install -d -o root -g root -m 755 "$directory"
    done
    for directory in /opt/betterframe/kiosk "$STATE"; do
        [[ ! -L $directory ]] || fail "Refusing symlink: $directory"
    done
    install -d -o "$INSTALL_USER" -g "$USER_GROUP" -m 755 /opt/betterframe/kiosk
    install -d -o "$INSTALL_USER" -g "$USER_GROUP" -m 700 "$STATE"
    # Repair root-owned state from manual installs, without following symlinks.
    python3 - "$STATE" "$USER_ID" "$(id -g "$INSTALL_USER")" <<'PYOWN'
import os, stat, sys
uid, gid = map(int, sys.argv[2:])
root = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    device = os.fstat(root).st_dev
    for _, dirs, files, fd in os.fwalk('.', dir_fd=root, follow_symlinks=False):
        if os.fstat(fd).st_dev != device:
            dirs[:] = []
            continue
        os.fchown(fd, uid, gid)
        for name in files:
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISREG(info.st_mode):
                    os.chown(name, uid, gid, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                pass # An active app may atomically replace its state files.
finally:
    os.close(root)
PYOWN
    write_rollback_helper | reconcile_file /usr/local/libexec/betterframe-rollback 755 root root
    runuser -u "$INSTALL_USER" -- mkdir -p -- "$unit_dir" "$autostart_dir"
    if [[ $MEDIA_GATEWAY == on ]]; then
        install_mediamtx
    elif [[ $(systemctl show betterframe-mediamtx.service -p LoadState --value) != not-found ]]; then
        if ((START)); then
            (stop_app_service system betterframe-mediamtx.service)
        elif systemctl is-active --quiet betterframe-mediamtx.service; then
            fail '--no-start requires MediaMTX to be stopped before disabling it'
        fi
        systemctl disable betterframe-mediamtx.service
        printf 'Media gateway disabled; existing recordings are preserved.\n'
    fi
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
        if ((START)); then
            stop_app_service user betterframe.service
        elif user_systemctl is-active --quiet betterframe.service; then
            fail '--no-start requires the existing BF service to be stopped; rerun without it to repair a running app'
        fi
        user_systemctl unmask betterframe.service
        user_systemctl unmask --runtime betterframe.service
    fi
    disable_user_app_offline
    if ((START)); then
        stop_app_service system betterframe-kiosk.service
    elif systemctl is-active --quiet betterframe-kiosk.service; then
        fail '--no-start requires the existing BF service to be stopped'
    fi
    systemctl disable betterframe-kiosk.service 2>/dev/null || true
    systemctl unmask betterframe-kiosk.service
    systemctl unmask --runtime betterframe-kiosk.service
    install_app_binary
    if command -v restorecon >/dev/null; then restorecon -RF /opt/betterframe /usr/local/libexec/betterframe-rollback; fi
    printf '%s %s %s %s\n' "$INSTALL_USER" "$MODE" "$CHANNEL" "$MEDIA_GATEWAY" | reconcile_file "$CONFIG" 644 root root
    if [[ $MODE == desktop ]]; then
        write_desktop_unit | reconcile_file "$unit_dir/betterframe.service" 644 "$INSTALL_USER" "$USER_GROUP"
        runuser -u "$INSTALL_USER" -- mkdir -p "$unit_dir/betterframe.service.d"
        write_repair_override | reconcile_file "$unit_dir/betterframe.service.d/zz-betterframe-setup.conf" 644 "$INSTALL_USER" "$USER_GROUP"
        write_launcher | reconcile_file /usr/local/libexec/betterframe-desktop 755 root root
        reconcile_file "$autostart_dir/betterframe.desktop" 644 "$INSTALL_USER" "$USER_GROUP" <<'EOF'
[Desktop Entry]
Type=Application
Name=BetterFrame
Exec=/usr/local/libexec/betterframe-desktop
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
        if [[ -S /run/user/$USER_ID/bus ]]; then
            user_systemctl daemon-reload
            if ((START)) && user_systemctl show-environment | grep -Eq '^(DISPLAY|WAYLAND_DISPLAY)=.'; then
                start_app_service user betterframe.service
            fi
        fi
        printf 'BetterFrame starts at the next graphical login (or now if the user manager has a display).\n'
    else
        runtime_backup "$autostart_dir/betterframe.desktop"
        runtime_command rm -f -- "$autostart_dir/betterframe.desktop"
        write_dedicated_unit | reconcile_file /etc/systemd/system/betterframe-kiosk.service 644 root root
        [[ ! -L /etc/systemd/system/betterframe-kiosk.service.d ]] || fail 'Refusing symlink service override directory'
        install -d -o root -g root -m 755 /etc/systemd/system/betterframe-kiosk.service.d
        write_repair_override | reconcile_file /etc/systemd/system/betterframe-kiosk.service.d/zz-betterframe-setup.conf 644 root root
        reconcile_file /etc/pam.d/betterframe-kiosk 644 root root <<'EOF'
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
        if ((START)) && ! systemctl is-active --quiet display-manager.service; then
            start_app_service system betterframe-kiosk.service
        else
            printf 'Dedicated startup configured. Current graphical login is preserved; BF starts on the next boot.\n'
        fi
    fi
    printf 'Release: %s (channel %s)\n' "${RELEASE_VERSION:-trusted local binary}" "$CHANNEL"
    printf 'Installed app: %s\nPairing/state preserved: %s\nOS updates are disabled for this standalone installation.\n' "$BIN" "$STATE"
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
