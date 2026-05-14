#!/usr/bin/env bash
# Rollback the kiosk binary if a recent OTA update never reached a healthy
# heartbeat. Run as ExecStartPre on the betterframe-kiosk service.
#
# Logic:
#   - Marker file at /var/lib/betterframe/kiosk/firmware-applying.json
#     written by the kiosk just before swapping in the new binary.
#   - Kiosk deletes it after a successful heartbeat post-boot.
#   - If we're running and the marker still exists older than 120s, the
#     previous start failed before heartbeat → restore .prev, drop the marker.
#
# Idempotent. Silent on the happy path. Logs to journal otherwise.

set -euo pipefail

BIN="/opt/betterframe/kiosk/betterframe-kiosk"
PREV="${BIN}.prev"
MARKER="/var/lib/betterframe/kiosk/firmware-applying.json"

if [ ! -f "$MARKER" ]; then
  exit 0
fi

# Marker mtime in epoch seconds.
marker_mtime=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER" 2>/dev/null || echo 0)
now=$(date +%s)
age=$(( now - marker_mtime ))

# Marker fresh → previous boot is still in progress, leave it.
if [ "$age" -lt 120 ]; then
  exit 0
fi

# Stale marker + .prev present → rollback.
if [ -f "$PREV" ]; then
  echo "[bf-firmware-rollback] stale apply marker (${age}s old) + .prev exists — rolling back" >&2
  cp -f "$PREV" "$BIN"
  chmod +x "$BIN"
  rm -f "$MARKER"
else
  echo "[bf-firmware-rollback] stale marker but no .prev — clearing marker, manual intervention needed" >&2
  rm -f "$MARKER"
fi
