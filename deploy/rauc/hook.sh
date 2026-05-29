#!/usr/bin/env bash
# RAUC per-slot install hook (shipped inside the .raucb bundle).
#
# WHY: the bundle slot images are built once and installed to whichever
# slot is inactive (A or B). Two things are slot-specific and cannot be
# baked at build time:
#
#   1. bootfs cmdline.txt `root=` — must point at the matching root slot's
#      PARTUUID. The Pi initramfs CANNOT resolve LABEL/partlabel, so root
#      MUST be PARTUUID. Wrong/stale PARTUUID => kernel can't find root =>
#      drops to initramfs.
#   2. rootfs /etc/fstab — /boot/firmware must mount the matching
#      BF_BOOT_<slot>, and / must be the matching root slot.
#
# This runs in full RAUC userspace on the ACTIVE system (udev/blkid up),
# so partlabel lookups here are safe — only the kernel cmdline is the
# initramfs-constrained surface, and that stays PARTUUID.
#
# autoboot.txt is owned by the custom bootloader backend
# (betterframe-rauc-boot.sh set-primary) at activation, not here.
set -euo pipefail

case "${1:-}" in
  slot-post-install) ;;
  *) exit 0 ;;
esac

slot_letter() {
  case "${RAUC_SLOT_NAME##*.}" in
    0) printf 'A' ;;
    1) printf 'B' ;;
    *) echo "hook: unknown slot index in '${RAUC_SLOT_NAME}'" >&2; exit 1 ;;
  esac
}

partuuid_of() {  # partlabel -> lowercase PARTUUID
  local uuid
  uuid="$(blkid -s PARTUUID -o value "/dev/disk/by-partlabel/$1" 2>/dev/null || true)"
  if [ -z "$uuid" ]; then
    echo "hook: could not read PARTUUID of $1" >&2
    exit 1
  fi
  printf '%s' "$uuid" | tr '[:upper:]' '[:lower:]'
}

QUIET_FLAGS="quiet splash plymouth.ignore-serial-consoles loglevel=0 vt.global_cursor_default=0 logo.nologo systemd.unit=multi-user.target"

apply_quiet() {
  local f="$1" flag
  for flag in $QUIET_FLAGS; do
    grep -qw -- "$flag" "$f" || sed -i "s|\$| $flag|" "$f"
  done
}

LETTER="$(slot_letter)"

# Prefer the mount point RAUC already provides; fall back to mounting.
MNT="${RAUC_SLOT_MOUNT_POINT:-}"
OWN_MOUNT=0
if [ -z "$MNT" ]; then
  MNT="$(mktemp -d)"
  mount "$RAUC_SLOT_DEVICE" "$MNT"
  OWN_MOUNT=1
fi
cleanup() {
  sync
  if [ "$OWN_MOUNT" = "1" ]; then
    umount "$MNT" 2>/dev/null || true
    rmdir "$MNT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

case "$RAUC_SLOT_CLASS" in
  bootfs)
    ROOT_UUID="$(partuuid_of "BF_ROOT_${LETTER}")"
    # root MUST stay PARTUUID — initramfs can't resolve labels.
    sed -i "s|root=PARTUUID=[^ ]*|root=PARTUUID=${ROOT_UUID}|" "${MNT}/cmdline.txt"
    sed -i "s|root=/dev/[^ ]*|root=PARTUUID=${ROOT_UUID}|" "${MNT}/cmdline.txt"
    sed -i 's/ init_resize//; s/ resize//' "${MNT}/cmdline.txt"
    apply_quiet "${MNT}/cmdline.txt"
    grep -q '^disable_splash=1' "${MNT}/config.txt" 2>/dev/null \
      || printf '\n# BetterFrame: disable firmware rainbow splash\ndisable_splash=1\n' >> "${MNT}/config.txt"
    echo "hook: patched bootfs slot ${LETTER} -> root=PARTUUID=${ROOT_UUID}"
    ;;
  rootfs)
    ROOT_UUID="$(partuuid_of "BF_ROOT_${LETTER}")"
    cat > "${MNT}/etc/fstab" <<FSTAB
LABEL=BF_BOOT_${LETTER}  /boot/firmware  vfat  defaults  0  2
PARTUUID=${ROOT_UUID}  /               ext4  defaults,noatime  0  1
LABEL=BF_DATA    /var/lib/betterframe  ext4  defaults,noatime,nofail  0  2
FSTAB
    echo "hook: patched rootfs slot ${LETTER} fstab -> BF_BOOT_${LETTER}, root PARTUUID=${ROOT_UUID}"
    ;;
  *)
    echo "hook: ignoring slot class '${RAUC_SLOT_CLASS}'"
    ;;
esac
