#!/bin/bash
# Expand BF_DATA (last partition) to fill the SD card on first boot.
# BF_DATA is mounted at /var/lib/betterframe. On a fresh image it's ~512MB;
# after expansion it fills whatever SD card size the operator used.
#
# Safe to re-run: growpart is idempotent (exits 0 "NOCHANGE" if already grown),
# and the marker file prevents systemd from re-invoking after success.
set -euo pipefail

MARKER="/var/lib/betterframe/.data-expanded"
MOUNTPOINT="/var/lib/betterframe"

if [ -f "$MARKER" ]; then
  echo "BF_DATA already expanded, skipping."
  exit 0
fi

# Find the block device backing BF_DATA from the mount table.
DATA_DEV="$(findmnt -n -o SOURCE "$MOUNTPOINT" 2>/dev/null || true)"
if [ -z "$DATA_DEV" ]; then
  echo "WARNING: $MOUNTPOINT not mounted, cannot expand. Skipping."
  exit 0
fi

# Extract disk + partition number (e.g. /dev/mmcblk0p5 → /dev/mmcblk0 + 5).
if [[ "$DATA_DEV" =~ ^(/dev/mmcblk[0-9]+)p([0-9]+)$ ]]; then
  DISK="${BASH_REMATCH[1]}"
  PARTNUM="${BASH_REMATCH[2]}"
elif [[ "$DATA_DEV" =~ ^(/dev/sd[a-z]+)([0-9]+)$ ]]; then
  DISK="${BASH_REMATCH[1]}"
  PARTNUM="${BASH_REMATCH[2]}"
else
  echo "WARNING: cannot parse device $DATA_DEV, skipping expansion."
  exit 0
fi

echo "Expanding partition ${DISK}p${PARTNUM} (BF_DATA) to fill disk..."

# growpart expands the partition to use all trailing free space.
# Exit code 0 = grown, 1 = error, NOCHANGE printed if already at max.
if ! growpart "$DISK" "$PARTNUM"; then
  echo "growpart returned non-zero (may already be at max size)."
fi

# Inform the kernel of the new partition size.
partprobe "$DISK" 2>/dev/null || true

# Resize the ext4 filesystem to fill the expanded partition.
resize2fs "$DATA_DEV"

# Drop marker so this doesn't run again.
touch "$MARKER"

echo "BF_DATA expanded successfully."
