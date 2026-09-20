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
