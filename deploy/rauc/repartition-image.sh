#!/usr/bin/env bash
# Convert a stock pi-gen .img.xz (2-partition: boot + root) into a RAUC
# A/B image (6 partitions: BF_BOOTSEL + BF_BOOT_A + BF_BOOT_B + BF_ROOT_A
# + BF_ROOT_B + BF_DATA). Also emits the raw rootfs.ext4 and bootfs.vfat
# slot images that the .raucb bundle builder consumes.
#
# Why post-process pi-gen instead of patching its export-image stage:
# pi-gen's image builder is fitted to stock Pi OS layouts. Bending it
# to A/B was fighting the tool every step. Treating its output as a
# black box and re-laying out in CI keeps pi-gen vanilla + lets us
# iterate the partition logic locally with losetup.
#
# Usage:
#   repartition-image.sh <in.img.xz> <out.img.xz> <rootfs.ext4> <bootfs.vfat>
#
# Requires root (loop mounts, mkfs).
set -euo pipefail

IN_IMG_XZ="${1:?input .img.xz required}"
OUT_IMG_XZ="${2:?output .img.xz required}"
ROOTFS_OUT="${3:?rootfs.ext4 output path required}"
BOOTFS_OUT="${4:?bootfs.vfat output path required}"

WORK="$(mktemp -d)"
trap 'cleanup' EXIT
cleanup() {
  set +e
  if [ -n "${OUT_LOOP:-}" ]; then losetup -d "$OUT_LOOP" 2>/dev/null; fi
  if [ -n "${SRC_LOOP:-}" ]; then losetup -d "$SRC_LOOP" 2>/dev/null; fi
  for m in "$WORK"/mnt-*; do [ -d "$m" ] && umount "$m" 2>/dev/null; done
  rm -rf "$WORK"
}

echo "==> Decompressing $IN_IMG_XZ"
xz -d -c "$IN_IMG_XZ" > "$WORK/in.img"

echo "==> Reading source partition table"
SRC_LOOP="$(losetup -fP --show "$WORK/in.img")"
sfdisk -d "$WORK/in.img"

# Pi-gen layout is always p1=boot vfat, p2=root ext4.
SRC_BOOT="${SRC_LOOP}p1"
SRC_ROOT="${SRC_LOOP}p2"

echo "==> Extracting bootfs + rootfs from source image"
dd if="$SRC_BOOT" of="$WORK/bootfs.vfat" bs=4M status=progress
dd if="$SRC_ROOT" of="$WORK/rootfs.ext4" bs=4M status=progress
losetup -d "$SRC_LOOP"; SRC_LOOP=""

# Shrink rootfs to actual used + small headroom so the bundle and image
# don't ship empty bytes. resize2fs -M shrinks to minimum.
echo "==> Compacting rootfs.ext4"
e2fsck -fy "$WORK/rootfs.ext4" || true
resize2fs -M "$WORK/rootfs.ext4"
ROOTFS_BYTES_USED="$(stat -c%s "$WORK/rootfs.ext4")"
# Grow back with ~25% headroom so first boot has room for apt-update etc.
ROOTFS_BYTES_SLOT=$(( ROOTFS_BYTES_USED * 5 / 4 ))
# Round up to MiB.
ROOTFS_BYTES_SLOT=$(( (ROOTFS_BYTES_SLOT + 1048575) / 1048576 * 1048576 ))
truncate -s "$ROOTFS_BYTES_SLOT" "$WORK/rootfs.ext4"
resize2fs "$WORK/rootfs.ext4"
echo "    rootfs slot size: $((ROOTFS_BYTES_SLOT / 1024 / 1024)) MiB"

# Bootfs we leave as-is (FAT, can't easily shrink, ~256MB).
BOOTFS_BYTES_SLOT="$(stat -c%s "$WORK/bootfs.vfat")"
echo "    bootfs slot size: $((BOOTFS_BYTES_SLOT / 1024 / 1024)) MiB"

# Patch rootfs fstab + boot cmdline to mount by LABEL (slot-agnostic).
# Pi-gen ships PARTUUID-based fstab; with two ROOT slots PARTUUID is
# wrong per-slot. LABEL works because RAUC formats each slot with its
# correct label after install. For the initial flash we hand-set BF_*
# labels below.
echo "==> Patching rootfs /etc/fstab to use LABEL=BF_*"
mkdir -p "$WORK/mnt-root"
mount -o loop "$WORK/rootfs.ext4" "$WORK/mnt-root"
cat > "$WORK/mnt-root/etc/fstab" <<'EOF'
LABEL=BF_BOOT_A  /boot/firmware  vfat  defaults  0  2
LABEL=BF_ROOT_A  /               ext4  defaults,noatime  0  1
LABEL=BF_DATA    /var/lib/betterframe  ext4  defaults,noatime,nofail  0  2
EOF
# Stamp the OS version + compatibility for the kiosk's os_update.rs
# to read at runtime. CI passes BF_BUILD_VERSION via env.
mkdir -p "$WORK/mnt-root/etc/betterframe"
printf '%s\n' "${BF_BUILD_VERSION:-0.0.0}" > "$WORK/mnt-root/etc/betterframe/os-version"
printf '%s\n' "${BF_RAUC_COMPATIBILITY:-betterframe-rpi5-aarch64}" > "$WORK/mnt-root/etc/betterframe/os-compatibility"
umount "$WORK/mnt-root"

# Two bootfs copies, each rewriting cmdline.txt root=LABEL=BF_ROOT_{A,B}.
echo "==> Building BF_BOOT_A bootfs"
cp "$WORK/bootfs.vfat" "$WORK/bootfs_A.vfat"
mkdir -p "$WORK/mnt-boota"
mount -o loop "$WORK/bootfs_A.vfat" "$WORK/mnt-boota"
sed -i 's|root=PARTUUID=[^ ]*|root=LABEL=BF_ROOT_A|' "$WORK/mnt-boota/cmdline.txt"
umount "$WORK/mnt-boota"

echo "==> Building BF_BOOT_B bootfs (placeholder, kernel from A)"
cp "$WORK/bootfs.vfat" "$WORK/bootfs_B.vfat"
mkdir -p "$WORK/mnt-bootb"
mount -o loop "$WORK/bootfs_B.vfat" "$WORK/mnt-bootb"
sed -i 's|root=PARTUUID=[^ ]*|root=LABEL=BF_ROOT_B|' "$WORK/mnt-bootb/cmdline.txt"
umount "$WORK/mnt-bootb"

# Layout the new combined image. GPT (Pi 5 firmware supports it). All
# sizes in MiB to keep sfdisk happy.
SELECTOR_MB=8
BOOT_MB=$((BOOTFS_BYTES_SLOT / 1024 / 1024))
ROOT_MB=$((ROOTFS_BYTES_SLOT / 1024 / 1024))
DATA_MB=512    # placeholder; resize2fs at first boot expands to free space
TOTAL_MB=$((SELECTOR_MB + BOOT_MB*2 + ROOT_MB*2 + DATA_MB + 32))

echo "==> Allocating ${TOTAL_MB} MiB output image"
truncate -s "${TOTAL_MB}M" "$WORK/out.img"

echo "==> Writing GPT partition table"
sfdisk "$WORK/out.img" <<EOF
label: gpt

start=2048,                              size=$((SELECTOR_MB * 2048)),  type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name="BF_BOOTSEL"
                                         size=$((BOOT_MB * 2048)),       type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name="BF_BOOT_A"
                                         size=$((BOOT_MB * 2048)),       type=EBD0A0A2-B9E5-4433-87C0-68B6B72699C7, name="BF_BOOT_B"
                                         size=$((ROOT_MB * 2048)),       type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="BF_ROOT_A"
                                         size=$((ROOT_MB * 2048)),       type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="BF_ROOT_B"
                                                                          type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name="BF_DATA"
EOF

OUT_LOOP="$(losetup -fP --show "$WORK/out.img")"

echo "==> Formatting selector + writing autoboot.txt"
mkfs.vfat -n "BF_BOOTSEL" "${OUT_LOOP}p1"
mkdir -p "$WORK/mnt-sel"
mount "${OUT_LOOP}p1" "$WORK/mnt-sel"
cat > "$WORK/mnt-sel/autoboot.txt" <<'EOF'
[all]
tryboot_a_b=1
PARTITION_WALK=1
boot_partition=2

[tryboot]
boot_partition=3
EOF
umount "$WORK/mnt-sel"

echo "==> Writing BF_BOOT_A + BF_BOOT_B"
dd if="$WORK/bootfs_A.vfat" of="${OUT_LOOP}p2" bs=4M conv=fsync
dd if="$WORK/bootfs_B.vfat" of="${OUT_LOOP}p3" bs=4M conv=fsync
# Force the label on the partition's vfat header.
fatlabel "${OUT_LOOP}p2" BF_BOOT_A
fatlabel "${OUT_LOOP}p3" BF_BOOT_B

echo "==> Writing BF_ROOT_A + initializing BF_ROOT_B empty"
dd if="$WORK/rootfs.ext4" of="${OUT_LOOP}p4" bs=4M conv=fsync
e2label "${OUT_LOOP}p4" BF_ROOT_A
mkfs.ext4 -F -L BF_ROOT_B "${OUT_LOOP}p5"

echo "==> Formatting BF_DATA"
mkfs.ext4 -F -L BF_DATA "${OUT_LOOP}p6"

losetup -d "$OUT_LOOP"; OUT_LOOP=""

echo "==> Final partition table"
sfdisk -d "$WORK/out.img"

echo "==> Emitting bundle slot images"
cp "$WORK/rootfs.ext4" "$ROOTFS_OUT"
cp "$WORK/bootfs.vfat" "$BOOTFS_OUT"

echo "==> Compressing output image (xz -T0)"
xz -T0 -9 -c "$WORK/out.img" > "$OUT_IMG_XZ"

echo
echo "==> Done."
ls -la "$OUT_IMG_XZ" "$ROOTFS_OUT" "$BOOTFS_OUT"
