#!/usr/bin/env bash
set -euo pipefail

CREDENTIAL=/var/lib/betterframe/at-rest.cred
[ -e /dev/tpmrm0 ] || exit 0
install -d -m 750 -o root -g tss /var/lib/betterframe

if [ -f "$CREDENTIAL" ]; then
  systemd-creds --name=betterframe-at-rest decrypt "$CREDENTIAL" - >/dev/null
  exit 0
fi

PLAIN="$(mktemp)"
SEALED="${CREDENTIAL}.tmp"
trap 'rm -f "$PLAIN" "$SEALED"' EXIT
openssl rand 32 > "$PLAIN"
systemd-creds --with-key=tpm2 --name=betterframe-at-rest encrypt "$PLAIN" "$SEALED"
chown root:tss "$SEALED"
chmod 640 "$SEALED"
mv "$SEALED" "$CREDENTIAL"
