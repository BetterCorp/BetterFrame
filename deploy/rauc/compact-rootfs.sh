#!/usr/bin/env bash
# Operates only on the staged bundle copy, never a partition or source image.
set -euo pipefail
IMAGE="${1:?staged rootfs.ext4 required}"
LIMIT="${2:-0}"
[[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo "Invalid rootfs byte limit" >&2; exit 1; }
[ -f "$IMAGE" ] && [ ! -b "$IMAGE" ] || { echo "Expected a regular image file" >&2; exit 1; }
ORIGINAL_BYTES=$(stat -c%s "$IMAGE")
check_fs() {
  local status=0
  e2fsck -fy "$IMAGE" || status=$?
  # 1 means errors were corrected; all other nonzero statuses are failures.
  [ "$status" -le 1 ] || return "$status"
}
check_fs
resize2fs -M "$IMAGE"
MIN_BYTES=$(stat -c%s "$IMAGE")
# Leave room for mounting/journal work before the post-install hook expands
# the filesystem. Do not make a small input filesystem larger than its source.
TARGET_BYTES=$((MIN_BYTES + 64 * 1024 * 1024))
if (( TARGET_BYTES > ORIGINAL_BYTES )); then TARGET_BYTES=$ORIGINAL_BYTES; fi
if (( LIMIT > 0 && TARGET_BYTES > LIMIT )); then
  echo "Compacted rootfs ($TARGET_BYTES bytes) exceeds supported slot ($LIMIT bytes)" >&2
  exit 1
fi
truncate -s "$TARGET_BYTES" "$IMAGE"
resize2fs "$IMAGE"
check_fs
echo "Bundle rootfs: $ORIGINAL_BYTES -> $(stat -c%s "$IMAGE") bytes"
