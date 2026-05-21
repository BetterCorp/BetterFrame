#!/usr/bin/env bash
# Build a signed RAUC .raucb bundle from pre-extracted slot images.
#
# The repartition-image.sh script (run earlier in CI) already extracts
# rootfs.ext4 + bootfs.vfat from the pi-gen output, so this script just
# stages them with a rendered manifest + runs `rauc bundle`.
#
# Usage:
#   build-bundle.sh <rootfs.ext4> <bootfs.vfat> <out.raucb> \
#                   <version> <git_sha> <signing_cert.pem> <signing_key.pem>
set -euo pipefail

ROOTFS_IN="${1:?rootfs.ext4 path required}"
BOOTFS_IN="${2:?bootfs.vfat path required}"
OUT_RAUCB="${3:?output .raucb path required}"
VERSION="${4:?version required}"
GIT_SHA="${5:?git sha required}"
SIGNING_CERT="${6:?signing cert path required}"
SIGNING_KEY="${7:?signing key path required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_IN="${SCRIPT_DIR}/manifest.raucm.in"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

STAGE="${WORK_DIR}/bundle"
mkdir -p "$STAGE"

cp "$ROOTFS_IN" "${STAGE}/rootfs.ext4"
cp "$BOOTFS_IN" "${STAGE}/bootfs.vfat"

echo "==> Rendering manifest"
sed -e "s|@VERSION@|${VERSION}|g" \
    -e "s|@GIT_SHA@|${GIT_SHA}|g" \
    "$MANIFEST_IN" > "${STAGE}/manifest.raucm"

ls -la "$STAGE"
cat "${STAGE}/manifest.raucm"

echo "==> Building RAUC bundle"
rm -f "$OUT_RAUCB"
rauc bundle \
  --cert="$SIGNING_CERT" \
  --key="$SIGNING_KEY" \
  "$STAGE" "$OUT_RAUCB"

echo "==> Verifying bundle"
rauc info --keyring="$SIGNING_CERT" "$OUT_RAUCB"

echo
echo "==> Bundle: $(ls -la "$OUT_RAUCB")"
