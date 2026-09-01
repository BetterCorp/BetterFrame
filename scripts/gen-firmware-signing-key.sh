#!/usr/bin/env bash
# Generate an Ed25519 keypair for firmware signing.
#
# Output:
#   firmware-signing.key  (private, PKCS8 PEM, 0600)
#   firmware-signing.pub  (public,  SPKI    PEM, 0644)
#
# Vendor client signing key:
#   1. Store the private PEM only in the GitHub Actions secret
#      BF_CLIENT_FIRMWARE_SIGNING_KEY. Release builds embed the derived
#      public key and sign the final stripped binary.
#   2. Configure the public PEM on the server as
#      BF_CLIENT_FIRMWARE_PUBLIC_KEY so imports can be verified.

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
echo "Configure GitHub Actions secret BF_CLIENT_FIRMWARE_SIGNING_KEY from $priv"
echo "Configure server env BF_CLIENT_FIRMWARE_PUBLIC_KEY from $pub"
