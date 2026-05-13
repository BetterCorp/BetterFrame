#!/usr/bin/env bash
# Generate an Ed25519 keypair for firmware signing.
#
# Output:
#   firmware-signing.key  (private, PKCS8 PEM, 0600)
#   firmware-signing.pub  (public,  SPKI    PEM, 0644)
#
# Use cases:
#   1. Local dev: drop the .key into the server's dataDir
#      (/var/lib/betterframe/firmware-signing.key) — server picks it up on
#      next boot. The server auto-generates one if missing, this script is
#      only needed when you want a reproducible / shared key.
#   2. Cloud deploy: paste the .key content into the
#      BF_FIRMWARE_SIGNING_KEY env var on your hosting platform (Coolify,
#      k8s secret, GitHub Actions secret, etc.). The server detects the env
#      var and prefers it over the on-disk file.
#
# Pinning on kiosks: the public key gets shipped to kiosks via the
# /api/kiosk/firmware/check response — no manual distribution needed.

set -euo pipefail

OUT_DIR="${1:-.}"
mkdir -p "$OUT_DIR"
priv="$OUT_DIR/firmware-signing.key"
pub="$OUT_DIR/firmware-signing.pub"

if [ -e "$priv" ] || [ -e "$pub" ]; then
  echo "error: $priv or $pub already exists. Refusing to overwrite." >&2
  exit 1
fi

openssl genpkey -algorithm Ed25519 -out "$priv"
chmod 600 "$priv"
openssl pkey -in "$priv" -pubout -out "$pub"
chmod 644 "$pub"

echo "wrote: $priv"
echo "wrote: $pub"
echo
echo "To use in cloud:"
echo "  set BF_FIRMWARE_SIGNING_KEY environment variable to the contents of $priv"
echo
echo "To use locally:"
echo "  install $priv to /var/lib/betterframe/firmware-signing.key (mode 0600)"
