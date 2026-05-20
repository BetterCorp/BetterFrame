#!/usr/bin/env bash
set -euo pipefail

MARKER="/run/betterframe/kiosk-healthy"
TIMEOUT="${BF_RAUC_MARK_GOOD_TIMEOUT:-300}"

if ! command -v rauc >/dev/null 2>&1; then
  exit 0
fi

deadline=$(($(date +%s) + TIMEOUT))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -s "$MARKER" ]; then
    exec rauc status mark-good
  fi
  sleep 2
done

echo "[betterframe-rauc-mark-good] kiosk health marker did not appear within ${TIMEOUT}s" >&2
exit 1
