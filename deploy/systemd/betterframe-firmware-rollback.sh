#!/usr/bin/env bash
# Roll back the kiosk binary if an app OTA candidate never confirms healthy.
#
# The kiosk writes MARKER just before swapping in a new binary and removes it
# only after a successful post-boot heartbeat. This script runs as root from
# betterframe-kiosk.service ExecStartPre, so it can recover even when the new
# kiosk binary exits before Rust code can run.

set -euo pipefail

BIN="/opt/betterframe/kiosk/betterframe-kiosk"
PREV="${BIN}.prev"
MARKER="/var/lib/betterframe/kiosk/firmware-applying.json"
ATTEMPTS="/var/lib/betterframe/kiosk/firmware-applying.attempts"
MAX_ATTEMPTS=3
MAX_AGE_SECONDS=120

if [ ! -f "$MARKER" ]; then
  rm -f "$ATTEMPTS"
  exit 0
fi

rollback() {
  local reason="$1"
  if [ -f "$PREV" ]; then
    echo "[bf-firmware-rollback] ${reason}; .prev exists, rolling back" >&2
    cp -f "$PREV" "$BIN"
    chmod +x "$BIN"
    rm -f "$MARKER" "$ATTEMPTS"
  else
    echo "[bf-firmware-rollback] ${reason}; no .prev, clearing marker and leaving current binary" >&2
    rm -f "$MARKER" "$ATTEMPTS"
  fi
}

marker_mtime=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER" 2>/dev/null || echo 0)
now=$(date +%s)
age=$(( now - marker_mtime ))

attempts=0
if [ -f "$ATTEMPTS" ]; then
  attempts=$(cat "$ATTEMPTS" 2>/dev/null || echo 0)
fi
case "$attempts" in
  ''|*[!0-9]*) attempts=0 ;;
esac

if [ "$age" -ge "$MAX_AGE_SECONDS" ]; then
  rollback "apply marker is stale (${age}s old)"
  exit 0
fi

if [ "$attempts" -ge "$MAX_ATTEMPTS" ]; then
  rollback "candidate failed to confirm after ${attempts} start attempts"
  exit 0
fi

attempts=$((attempts + 1))
printf '%s\n' "$attempts" > "$ATTEMPTS"
echo "[bf-firmware-rollback] pending firmware candidate start attempt ${attempts}/${MAX_ATTEMPTS}" >&2
