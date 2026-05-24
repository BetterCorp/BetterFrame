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
# Avoids losetup -fP (kernel partition scanning fails on some CI runners).
# Instead, parses partition offsets from sfdisk -J and uses dd skip/count.
#
# Usage:
#   repartition-image.sh <in.img.xz> <out.img.xz> <rootfs.ext4> <bootfs.vfat>
#
# Requires: xz, sfdisk, dd, e2fsprogs, dosfstools, jq, mkfs.ext4, mkfs.vfat
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

# Parse partition start + size in sectors (512 bytes each) via jq.
# Pi-gen: p1 = boot (vfat), p2 = root (ext4).
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

# Done with source image — free disk space.
rm "$WORK/in.img"

# Shrink rootfs to actual used + 25% headroom.
echo "==> Compacting rootfs.ext4"
e2fsck -fy "$WORK/rootfs.ext4" || true
resize2fs -M "$WORK/rootfs.ext4"
ROOTFS_BYTES_USED="$(stat -c%s "$WORK/rootfs.ext4")"
ROOTFS_BYTES_SLOT=$(( ROOTFS_BYTES_USED * 5 / 4 ))
ROOTFS_BYTES_SLOT=$(( (ROOTFS_BYTES_SLOT + 1048575) / 1048576 * 1048576 ))
truncate -s "$ROOTFS_BYTES_SLOT" "$WORK/rootfs.ext4"
resize2fs "$WORK/rootfs.ext4"
echo "    rootfs slot size: $((ROOTFS_BYTES_SLOT / 1024 / 1024)) MiB"

BOOTFS_BYTES_SLOT="$(stat -c%s "$WORK/bootfs.vfat")"
echo "    bootfs slot size: $((BOOTFS_BYTES_SLOT / 1024 / 1024)) MiB"

# Patch rootfs fstab to use LABEL (slot-agnostic).
echo "==> Patching rootfs /etc/fstab"
ROOTFS_LOOP="$(losetup -f --show "$WORK/rootfs.ext4")"
mkdir -p "$WORK/mnt-root"
mount "$ROOTFS_LOOP" "$WORK/mnt-root"
cat > "$WORK/mnt-root/etc/fstab" <<'FSTAB'
LABEL=BF_BOOT_A  /boot/firmware  vfat  defaults  0  2
LABEL=BF_ROOT_A  /               ext4  defaults,noatime  0  1
LABEL=BF_DATA    /var/lib/betterframe  ext4  defaults,noatime,nofail  0  2
FSTAB
mkdir -p "$WORK/mnt-root/etc/betterframe"
printf '%s\n' "${BF_BUILD_VERSION:-0.0.0}" > "$WORK/mnt-root/etc/betterframe/os-version"
printf '%s\n' "${BF_RAUC_COMPATIBILITY:-betterframe-rpi5-aarch64}" > "$WORK/mnt-root/etc/betterframe/os-compatibility"
umount "$WORK/mnt-root"
losetup -d "$ROOTFS_LOOP"

# Set ext4 filesystem label BEFORE dd into the output image. cmdline.txt
# uses root=LABEL=BF_ROOT_A so the kernel needs this label to find root.
echo "==> Labeling rootfs.ext4 as BF_ROOT_A"
e2label "$WORK/rootfs.ext4" BF_ROOT_A

# Build two bootfs copies with slot-specific cmdline.txt + autoboot.txt.
# Pi 5 bootloader reads autoboot.txt from the SAME partition as config.txt.
echo "==> Building BF_BOOT_A (partition 1 — primary boot)"
cp "$WORK/bootfs.vfat" "$WORK/bootfs_A.vfat"
BOOT_A_LOOP="$(losetup -f --show "$WORK/bootfs_A.vfat")"
mkdir -p "$WORK/mnt-ba"
mount "$BOOT_A_LOOP" "$WORK/mnt-ba"
# Disable initramfs — it can't resolve LABEL= and we don't need it.
# Kernel mounts root directly with rootwait.
sed -i 's/^auto_initramfs=1/auto_initramfs=0/' "$WORK/mnt-ba/config.txt" 2>/dev/null || true
sed -i 's|root=PARTUUID=[^ ]*|root=LABEL=BF_ROOT_A|' "$WORK/mnt-ba/cmdline.txt" 2>/dev/null || true
sed -i 's|root=/dev/[^ ]*|root=LABEL=BF_ROOT_A|' "$WORK/mnt-ba/cmdline.txt" 2>/dev/null || true
# autoboot.txt: normal boot → partition 1 (this one), tryboot → partition 2
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
sed -i 's/^auto_initramfs=1/auto_initramfs=0/' "$WORK/mnt-bb/config.txt" 2>/dev/null || true
sed -i 's|root=PARTUUID=[^ ]*|root=LABEL=BF_ROOT_B|' "$WORK/mnt-bb/cmdline.txt" 2>/dev/null || true
sed -i 's|root=/dev/[^ ]*|root=LABEL=BF_ROOT_B|' "$WORK/mnt-bb/cmdline.txt" 2>/dev/null || true
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

# Layout the new A/B image. GPT, 5 partitions (no separate selector).
# Partition 1 = BF_BOOT_A (Pi bootloader looks here for config.txt).
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

# Re-read the new partition table to get exact offsets for dd writes.
NEW_PT="$(sfdisk -J "$WORK/out.img")"
echo "$NEW_PT" | jq .

get_part() {
  echo "$NEW_PT" | jq ".partitiontable.partitions[$1].$2"
}

# Write each partition content at its exact offset via dd.
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

echo "==> Zeroing BF_DATA (partition 5)"
P_START=$(get_part 4 start)
P_SIZE=$(get_part 4 size)
dd if=/dev/zero of="$WORK/out.img" bs=$SECTOR seek="$P_START" count="$P_SIZE" conv=notrunc status=none

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
