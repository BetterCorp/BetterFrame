#!/usr/bin/env bash
# Convert a stock pi-gen .img.xz (2-partition: boot + root) into a RAUC
# A/B image (5 partitions: BF_BOOT_A + BF_BOOT_B + BF_ROOT_A + BF_ROOT_B
# + BF_DATA). Also emits the raw rootfs.ext4 and bootfs.vfat slot images
# that the .raucb bundle builder consumes.
#
# Pi 5 tryboot: autoboot.txt goes ON the boot partition (not a separate
# selector). Bootloader reads config.txt + autoboot.txt from partition 1.
# On tryboot, switches to partition 2 (BF_BOOT_B).
#
# Root is referenced by PARTUUID (not LABEL) because the initramfs
# can't resolve filesystem labels. PARTUUIDs are read back from the
# GPT after sfdisk creates it.
set -euo pipefail

IN_IMG_XZ="${1:?input .img.xz required}"
OUT_IMG_XZ="${2:?output .img.xz required}"
ROOTFS_OUT="${3:?rootfs.ext4 output path required}"
BOOTFS_OUT="${4:?bootfs.vfat output path required}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Decompressing $IN_IMG_XZ"
xz -d -c "$IN_IMG_XZ" > "$WORK/in.img"

echo "==> Reading source partition table (sfdisk -J)"
PTABLE="$(sfdisk -J "$WORK/in.img")"
echo "$PTABLE" | jq .

P1_START=$(echo "$PTABLE" | jq '.partitiontable.partitions[0].start')
P1_SIZE=$(echo "$PTABLE" | jq '.partitiontable.partitions[0].size')
P2_START=$(echo "$PTABLE" | jq '.partitiontable.partitions[1].start')
P2_SIZE=$(echo "$PTABLE" | jq '.partitiontable.partitions[1].size')
SECTOR=512

echo "    bootfs: start=${P1_START} size=${P1_SIZE} sectors"
echo "    rootfs: start=${P2_START} size=${P2_SIZE} sectors"

echo "==> Extracting bootfs.vfat (dd)"
dd if="$WORK/in.img" of="$WORK/bootfs.vfat" \
   bs=$SECTOR skip="$P1_START" count="$P1_SIZE" status=progress

echo "==> Extracting rootfs.ext4 (dd)"
dd if="$WORK/in.img" of="$WORK/rootfs.ext4" \
   bs=$SECTOR skip="$P2_START" count="$P2_SIZE" status=progress

rm "$WORK/in.img"

# Shrink rootfs to actual used + 50% headroom (25% was too tight for OTA).
echo "==> Compacting rootfs.ext4"
e2fsck -fy "$WORK/rootfs.ext4" || true
resize2fs -M "$WORK/rootfs.ext4"
ROOTFS_BYTES_USED="$(stat -c%s "$WORK/rootfs.ext4")"
ROOTFS_BYTES_SLOT=$(( ROOTFS_BYTES_USED * 3 / 2 ))
ROOTFS_BYTES_SLOT=$(( (ROOTFS_BYTES_SLOT + 1048575) / 1048576 * 1048576 ))
truncate -s "$ROOTFS_BYTES_SLOT" "$WORK/rootfs.ext4"
resize2fs "$WORK/rootfs.ext4"
echo "    rootfs slot size: $((ROOTFS_BYTES_SLOT / 1024 / 1024)) MiB"

BOOTFS_BYTES_SLOT="$(stat -c%s "$WORK/bootfs.vfat")"
echo "    bootfs slot size: $((BOOTFS_BYTES_SLOT / 1024 / 1024)) MiB"

# Set ext4 filesystem label (used by fstab, not cmdline).
echo "==> Labeling rootfs.ext4 as BF_ROOT_A"
e2label "$WORK/rootfs.ext4" BF_ROOT_A

# ---- Create GPT FIRST so we can read back PARTUUIDs ----
BOOT_MB=$((BOOTFS_BYTES_SLOT / 1024 / 1024))
ROOT_MB=$((ROOTFS_BYTES_SLOT / 1024 / 1024))
DATA_MB=512
TOTAL_MB=$((BOOT_MB*2 + ROOT_MB*2 + DATA_MB + 32))

echo "==> Allocating ${TOTAL_MB} MiB output image"
truncate -s "${TOTAL_MB}M" "$WORK/out.img"

echo "==> Writing GPT partition table"
sfdisk "$WORK/out.img" <<SFDISK
label: gpt
start=2048, size=$((BOOT_MB * 2048)), type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name="BF_BOOT_A"
size=$((BOOT_MB * 2048)), type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name="BF_BOOT_B"
size=$((ROOT_MB * 2048)), type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="BF_ROOT_A"
size=$((ROOT_MB * 2048)), type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="BF_ROOT_B"
type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="BF_DATA"
SFDISK

# Read back PARTUUIDs from the new GPT.
NEW_PT="$(sfdisk -J "$WORK/out.img")"
echo "$NEW_PT" | jq .

get_part() {
  echo "$NEW_PT" | jq -r ".partitiontable.partitions[$1].$2"
}

quiet_cmdline() {
  local cmdline="$1"
  for flag in quiet splash plymouth.ignore-serial-consoles loglevel=0 vt.global_cursor_default=0 logo.nologo systemd.unit=multi-user.target; do
    if ! grep -qw -- "$flag" "$cmdline"; then
      sed -i "s|\$| $flag|" "$cmdline"
    fi
  done
}

quiet_config() {
  local config="$1"
  if ! grep -q '^disable_splash=1' "$config"; then
    printf '\n# BetterFrame: disable firmware rainbow splash\ndisable_splash=1\n' >> "$config"
  fi
}

PARTUUID_ROOT_A="$(get_part 2 uuid | tr '[:upper:]' '[:lower:]')"
PARTUUID_ROOT_B="$(get_part 3 uuid | tr '[:upper:]' '[:lower:]')"
echo "    BF_ROOT_A PARTUUID: $PARTUUID_ROOT_A"
echo "    BF_ROOT_B PARTUUID: $PARTUUID_ROOT_B"

# ---- Patch rootfs fstab (uses LABEL — works after initramfs) ----
echo "==> Patching rootfs /etc/fstab"
ROOTFS_LOOP="$(losetup -f --show "$WORK/rootfs.ext4")"
mkdir -p "$WORK/mnt-root"
mount "$ROOTFS_LOOP" "$WORK/mnt-root"
if ! grep -qsh '^CONFIG_SQUASHFS=y$' "$WORK/mnt-root"/boot/config-* &&
   ! find "$WORK/mnt-root/lib/modules" -path '*/kernel/fs/squashfs/squashfs.ko*' -print -quit | grep -q .; then
  echo "ERROR: target kernel lacks SquashFS support required by RAUC" >&2
  exit 1
fi
cat > "$WORK/mnt-root/etc/fstab" <<FSTAB
LABEL=BF_BOOT_A  /boot/firmware  vfat  defaults  0  2
PARTUUID=${PARTUUID_ROOT_A}  /               ext4  defaults,noatime  0  1
LABEL=BF_DATA    /var/lib/betterframe  ext4  defaults,noatime,nofail  0  2
FSTAB
mkdir -p "$WORK/mnt-root/etc/betterframe"
printf '%s\n' "${BF_BUILD_VERSION:-0.0.0}" > "$WORK/mnt-root/etc/betterframe/os-version"
printf '%s\n' "${BF_RAUC_COMPATIBILITY:-betterframe-rpi5-aarch64}" > "$WORK/mnt-root/etc/betterframe/os-compatibility"
umount "$WORK/mnt-root"
losetup -d "$ROOTFS_LOOP"

# ---- Build bootfs copies with PARTUUID + autoboot.txt ----
echo "==> Building BF_BOOT_A (partition 1 — primary boot)"
cp "$WORK/bootfs.vfat" "$WORK/bootfs_A.vfat"
BOOT_A_LOOP="$(losetup -f --show "$WORK/bootfs_A.vfat")"
mkdir -p "$WORK/mnt-ba"
mount "$BOOT_A_LOOP" "$WORK/mnt-ba"
# Replace root= with PARTUUID (works with initramfs). Remove 'resize' (breaks GPT).
sed -i "s|root=PARTUUID=[^ ]*|root=PARTUUID=${PARTUUID_ROOT_A}|" "$WORK/mnt-ba/cmdline.txt" 2>/dev/null || true
sed -i "s|root=/dev/[^ ]*|root=PARTUUID=${PARTUUID_ROOT_A}|" "$WORK/mnt-ba/cmdline.txt" 2>/dev/null || true
sed -i 's/ resize//' "$WORK/mnt-ba/cmdline.txt" 2>/dev/null || true
quiet_cmdline "$WORK/mnt-ba/cmdline.txt"
quiet_config "$WORK/mnt-ba/config.txt"
cat > "$WORK/mnt-ba/autoboot.txt" <<'AUTOBOOT'
[all]
tryboot_a_b=1
boot_partition=1

[tryboot]
boot_partition=2
AUTOBOOT
umount "$WORK/mnt-ba"
losetup -d "$BOOT_A_LOOP"
fatlabel "$WORK/bootfs_A.vfat" BF_BOOT_A

echo "==> Building BF_BOOT_B (partition 2 — tryboot target)"
cp "$WORK/bootfs.vfat" "$WORK/bootfs_B.vfat"
BOOT_B_LOOP="$(losetup -f --show "$WORK/bootfs_B.vfat")"
mkdir -p "$WORK/mnt-bb"
mount "$BOOT_B_LOOP" "$WORK/mnt-bb"
sed -i "s|root=PARTUUID=[^ ]*|root=PARTUUID=${PARTUUID_ROOT_B}|" "$WORK/mnt-bb/cmdline.txt" 2>/dev/null || true
sed -i "s|root=/dev/[^ ]*|root=PARTUUID=${PARTUUID_ROOT_B}|" "$WORK/mnt-bb/cmdline.txt" 2>/dev/null || true
sed -i 's/ resize//' "$WORK/mnt-bb/cmdline.txt" 2>/dev/null || true
quiet_cmdline "$WORK/mnt-bb/cmdline.txt"
quiet_config "$WORK/mnt-bb/config.txt"
cat > "$WORK/mnt-bb/autoboot.txt" <<'AUTOBOOT'
[all]
tryboot_a_b=1
boot_partition=2

[tryboot]
boot_partition=1
AUTOBOOT
umount "$WORK/mnt-bb"
losetup -d "$BOOT_B_LOOP"
fatlabel "$WORK/bootfs_B.vfat" BF_BOOT_B

# ---- Write partition contents into the image ----
echo "==> Writing BF_BOOT_A (partition 1)"
P_START=$(get_part 0 start)
dd if="$WORK/bootfs_A.vfat" of="$WORK/out.img" bs=$SECTOR seek="$P_START" conv=notrunc status=none

echo "==> Writing BF_BOOT_B (partition 2)"
P_START=$(get_part 1 start)
dd if="$WORK/bootfs_B.vfat" of="$WORK/out.img" bs=$SECTOR seek="$P_START" conv=notrunc status=none

echo "==> Writing BF_ROOT_A (partition 3)"
P_START=$(get_part 2 start)
dd if="$WORK/rootfs.ext4" of="$WORK/out.img" bs=$SECTOR seek="$P_START" conv=notrunc status=none

echo "==> Zeroing BF_ROOT_B (partition 4 — empty placeholder)"
P_START=$(get_part 3 start)
P_SIZE=$(get_part 3 size)
dd if=/dev/zero of="$WORK/out.img" bs=$SECTOR seek="$P_START" count="$P_SIZE" conv=notrunc status=none

echo "==> Formatting BF_DATA (partition 5)"
P_START=$(get_part 4 start)
P_SIZE=$(get_part 4 size)
dd if=/dev/zero of="$WORK/out.img" bs=$SECTOR seek="$P_START" count="$P_SIZE" conv=notrunc status=none
# Create a standalone ext4 image, then dd it in
DATA_BYTES=$((P_SIZE * SECTOR))
truncate -s "$DATA_BYTES" "$WORK/data.ext4"
mkfs.ext4 -L BF_DATA -q "$WORK/data.ext4"
dd if="$WORK/data.ext4" of="$WORK/out.img" bs=$SECTOR seek="$P_START" conv=notrunc status=none
rm "$WORK/data.ext4"

echo "==> Final partition table"
sfdisk -d "$WORK/out.img"

echo "==> Emitting bundle slot images"
cp "$WORK/rootfs.ext4" "$ROOTFS_OUT"
cp "$WORK/bootfs.vfat" "$BOOTFS_OUT"

echo "==> Compressing output image (xz -T0)"
xz -T0 -6 -c "$WORK/out.img" > "$OUT_IMG_XZ"

echo
echo "==> Done."
ls -la "$OUT_IMG_XZ" "$ROOTFS_OUT" "$BOOTFS_OUT"
