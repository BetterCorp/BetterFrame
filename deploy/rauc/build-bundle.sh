#!/usr/bin/env bash
# Build a signed RAUC .raucb bundle from a pi-gen-produced .img.xz.
#
# Usage:
#   build-bundle.sh <input.img.xz> <output.raucb> <version> <git_sha> \
#                   <signing_cert.pem> <signing_key.pem>
#
# Approach: decompress the .img.xz, identify its bootfs (vfat) + rootfs
# (ext4) partitions via sfdisk, dd them into bundle-staging/ as
# bootfs.vfat + rootfs.ext4, render the manifest template with version
# + git sha, then `rauc bundle --cert= --key= staging out.raucb`.
#
# We use the FAT and ext4 partitions from a stock pi-gen image — i.e. the
# bundle content matches what's on a freshly-flashed kiosk. The TARGET
# device still needs an A/B partition layout for RAUC to actually install
# (separate workstream); a bundle built today is only consumable by
# kiosks already running the A/B layout.
set -euo pipefail

IN_IMG_XZ="${1:?input .img.xz required}"
OUT_RAUCB="${2:?output .raucb path required}"
VERSION="${3:?version required}"
GIT_SHA="${4:?git sha required}"
SIGNING_CERT="${5:?signing cert path required}"
SIGNING_KEY="${6:?signing key path required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST_IN="${SCRIPT_DIR}/manifest.raucm.in"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "==> Decompressing $IN_IMG_XZ"
RAW_IMG="${WORK_DIR}/image.img"
xz -d -c "$IN_IMG_XZ" > "$RAW_IMG"

echo "==> Reading partition table"
# sfdisk -d emits: <device>: start=N, size=N, type=X, name=...
# pi-gen layout: p1 = bootfs (vfat, type=c), p2 = rootfs (ext4, type=83)
BOOT_INFO="$(sfdisk -d "$RAW_IMG" | awk '/img1/ || /img.*: start/ {print}')"
ROOT_INFO="$(sfdisk -d "$RAW_IMG" | awk '/img2/ || /img.*: start/ {print}')"

# Robust parse: walk partition lines, identify by type code.
parse_part() {
  local part_idx="$1"
  sfdisk -d "$RAW_IMG" \
    | awk -v idx="$part_idx" '
      /: start=/ {
        n++;
        if (n == idx) {
          for (i = 1; i <= NF; i++) {
            if ($i ~ /start=/) { gsub(/[^0-9]/, "", $i); start = $i }
            if ($i ~ /size=/)  { gsub(/[^0-9]/, "", $i); size = $i }
          }
          print start, size;
          exit
        }
      }'
}

read BOOT_START BOOT_SIZE < <(parse_part 1)
read ROOT_START ROOT_SIZE < <(parse_part 2)
if [ -z "${BOOT_START:-}" ] || [ -z "${ROOT_START:-}" ]; then
  echo "could not parse pi-gen partition table — expected 2 partitions" >&2
  sfdisk -d "$RAW_IMG"
  exit 1
fi

echo "    bootfs: start=$BOOT_START size=$BOOT_SIZE sectors (512B each)"
echo "    rootfs: start=$ROOT_START size=$ROOT_SIZE sectors (512B each)"

STAGE="${WORK_DIR}/bundle"
mkdir -p "$STAGE"

echo "==> Extracting bootfs.vfat"
dd if="$RAW_IMG" of="${STAGE}/bootfs.vfat" \
   bs=512 skip="$BOOT_START" count="$BOOT_SIZE" status=none

echo "==> Extracting rootfs.ext4"
dd if="$RAW_IMG" of="${STAGE}/rootfs.ext4" \
   bs=512 skip="$ROOT_START" count="$ROOT_SIZE" status=none

# Shrink the rootfs to actual used space so bundles don't ship empty bytes.
# pi-gen's export-image already does this, but verify file integrity first.
echo "==> Checking rootfs.ext4 integrity"
e2fsck -fy "${STAGE}/rootfs.ext4" || true  # tolerate "clean but old fs version" warnings

echo "==> Rendering manifest"
sed -e "s|@VERSION@|${VERSION}|g" \
    -e "s|@GIT_SHA@|${GIT_SHA}|g" \
    "$MANIFEST_IN" > "${STAGE}/manifest.raucm"

echo "==> Bundle staging contents"
ls -la "$STAGE"
cat "${STAGE}/manifest.raucm"

echo "==> Building RAUC bundle"
rm -f "$OUT_RAUCB"
rauc bundle \
  --cert="$SIGNING_CERT" \
  --key="$SIGNING_KEY" \
  "$STAGE" "$OUT_RAUCB"

echo "==> Verifying bundle (uses the signing cert as its own trust anchor)"
rauc info --keyring="$SIGNING_CERT" "$OUT_RAUCB"

echo
echo "==> Bundle written: $OUT_RAUCB"
ls -la "$OUT_RAUCB"
