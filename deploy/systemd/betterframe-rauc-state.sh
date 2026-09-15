#!/usr/bin/env bash
# RAUC metadata must survive replacement of either root slot. BF_DATA is
# root-owned; only its kiosk/recordings children are writable by the kiosk.
set -euo pipefail
legacy="${BF_RAUC_LEGACY_DIR:-/var/lib/rauc}"
shared="${BF_RAUC_SHARED_DIR:-/var/lib/betterframe/rauc}"
if [ ! -e "$shared/.migrated" ] || [ "${1:-}" = --refresh-legacy ]; then
  install -d -m 700 "$shared"
  if [ -d "$legacy" ]; then
    if [ "${1:-}" = --refresh-legacy ]; then
      cp -a "$legacy/." "$shared/"
    else
      cp -a -n "$legacy/." "$shared/"
    fi
  fi
  touch "$shared/.migrated"
  sync -f "$shared"
fi
