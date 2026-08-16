#!/usr/bin/env bash
set -euo pipefail

MARKER="/run/betterframe/kiosk-healthy"
CONFIRMED_MARKER="/run/betterframe/rauc-confirmed"
TIMEOUT="${BF_RAUC_MARK_GOOD_TIMEOUT:-300}"

if ! command -v rauc >/dev/null 2>&1; then
  exit 0
fi

deadline=$(($(date +%s) + TIMEOUT))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ -s "$MARKER" ]; then
    rauc status mark-good
    install -m 600 /dev/null "$CONFIRMED_MARKER"
    exit 0
  fi
  sleep 2
done

echo "[betterframe-rauc-mark-good] kiosk health marker did not appear within ${TIMEOUT}s" >&2
exit 1
