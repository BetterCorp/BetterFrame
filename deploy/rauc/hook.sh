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

patch_x86_grub_cfg() {
  local cfg="$1"
  local boot_uuid="$2"
  local root_a_uuid="$3"
  local root_b_uuid="$4"
  [ -f "$cfg" ] || return 0
  sed -i -E "0,/search --no-floppy --partuuid [^ ]+ --set=root/s|search --no-floppy --partuuid [^ ]+ --set=root|search --no-floppy --partuuid ${boot_uuid} --set=root|" "$cfg"
  sed -i "/BetterFrame A/,/}/s|root=PARTUUID=[^ ]*|root=PARTUUID=${root_a_uuid}|g" "$cfg"
  sed -i "/BetterFrame B/,/}/s|root=PARTUUID=[^ ]*|root=PARTUUID=${root_b_uuid}|g" "$cfg"
}

patch_x86_loader_entry() {
  local entry="$1"
  local root_uuid="$2"
  [ -f "$entry" ] || return 0
  sed -i "s|root=PARTUUID=[^ ]*|root=PARTUUID=${root_uuid}|g" "$entry"
}

write_x86_rauc_system_conf() {
  local path="$1"
  local boot_a_uuid="$2"
  local boot_b_uuid="$3"
  local root_a_uuid="$4"
  local root_b_uuid="$5"
  cat > "$path" <<RAUCCONF
[system]
compatible=betterframe-x86_64-generic
bootloader=custom
data-directory=/var/lib/rauc
bundle-formats=plain

[keyring]
path=/etc/rauc/keyring.pem

[handlers]
bootloader-custom-backend=/usr/local/sbin/betterframe-rauc-boot.sh

[slot.rootfs.0]
device=/dev/disk/by-partuuid/${root_a_uuid}
type=ext4
bootname=A

[slot.bootfs.0]
device=/dev/disk/by-partuuid/${boot_a_uuid}
type=vfat
parent=rootfs.0

[slot.rootfs.1]
device=/dev/disk/by-partuuid/${root_b_uuid}
type=ext4
bootname=B

[slot.bootfs.1]
device=/dev/disk/by-partuuid/${boot_b_uuid}
type=vfat
parent=rootfs.1
RAUCCONF
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
    if [ -f "${MNT}/cmdline.txt" ]; then
    ROOT_UUID="$(partuuid_of "BF_ROOT_${LETTER}")"
    # root MUST stay PARTUUID — initramfs can't resolve labels.
    sed -i "s|root=PARTUUID=[^ ]*|root=PARTUUID=${ROOT_UUID}|" "${MNT}/cmdline.txt"
    sed -i "s|root=/dev/[^ ]*|root=PARTUUID=${ROOT_UUID}|" "${MNT}/cmdline.txt"
    sed -i 's/ init_resize//; s/ resize//' "${MNT}/cmdline.txt"
    apply_quiet "${MNT}/cmdline.txt"
    grep -q '^disable_splash=1' "${MNT}/config.txt" 2>/dev/null \
      || printf '\n# BetterFrame: disable firmware rainbow splash\ndisable_splash=1\n' >> "${MNT}/config.txt"
      echo "hook: patched Pi bootfs slot ${LETTER} -> root=PARTUUID=${ROOT_UUID}"
    else
      BOOT_UUID="$(partuuid_of "BF_BOOT_${LETTER}")"
      ROOT_A_UUID="$(partuuid_of BF_ROOT_A)"
      ROOT_B_UUID="$(partuuid_of BF_ROOT_B)"
      patch_x86_grub_cfg "${MNT}/EFI/betterframe/grub.cfg" "$BOOT_UUID" "$ROOT_A_UUID" "$ROOT_B_UUID"
      patch_x86_grub_cfg "${MNT}/EFI/BOOT/grub.cfg" "$BOOT_UUID" "$ROOT_A_UUID" "$ROOT_B_UUID"
      patch_x86_grub_cfg "${MNT}/EFI/debian/grub.cfg" "$BOOT_UUID" "$ROOT_A_UUID" "$ROOT_B_UUID"
      patch_x86_grub_cfg "${MNT}/grub.cfg" "$BOOT_UUID" "$ROOT_A_UUID" "$ROOT_B_UUID"
      patch_x86_loader_entry "${MNT}/loader/entries/betterframe-a.conf" "$ROOT_A_UUID"
      patch_x86_loader_entry "${MNT}/loader/entries/betterframe-b.conf" "$ROOT_B_UUID"
      patch_x86_loader_entry "${MNT}/loader/entries/betterframe-a-debug.conf" "$ROOT_A_UUID"
      if [ -f "${MNT}/loader/loader.conf" ]; then
        sed -i "s/^default .*/default betterframe-$(printf '%s' "$LETTER" | tr '[:upper:]' '[:lower:]').conf/" "${MNT}/loader/loader.conf"
      fi
      echo "hook: patched x86 bootfs slot ${LETTER} -> boot PARTUUID=${BOOT_UUID}"
    fi
    ;;
  rootfs)
    if [ -f "${MNT}/etc/betterframe/os-compatibility" ] \
      && grep -qx 'betterframe-x86_64-generic' "${MNT}/etc/betterframe/os-compatibility"; then
      BOOT_UUID="$(partuuid_of "BF_BOOT_${LETTER}")"
      BOOT_A_UUID="$(partuuid_of BF_BOOT_A)"
      BOOT_B_UUID="$(partuuid_of BF_BOOT_B)"
      ROOT_UUID="$(partuuid_of "BF_ROOT_${LETTER}")"
      ROOT_A_UUID="$(partuuid_of BF_ROOT_A)"
      ROOT_B_UUID="$(partuuid_of BF_ROOT_B)"
      DATA_UUID="$(partuuid_of BF_DATA)"
      cat > "${MNT}/etc/fstab" <<FSTAB
PARTUUID=${BOOT_UUID}  /boot/efi             vfat  defaults  0  2
PARTUUID=${ROOT_UUID}  /                    ext4  defaults,noatime  0  1
PARTUUID=${DATA_UUID}  /var/lib/betterframe ext4  defaults,noatime,nofail  0  2
FSTAB
      write_x86_rauc_system_conf "${MNT}/etc/rauc/system.conf" \
        "$BOOT_A_UUID" "$BOOT_B_UUID" "$ROOT_A_UUID" "$ROOT_B_UUID"
      if [ -f "${MNT}/usr/local/sbin/betterframe-rauc-boot.sh" ]; then
        sed -i \
          -e "s|^BOOT_A_DEV=.*|BOOT_A_DEV=\"\${BF_RAUC_BOOT_A_DEV:-/dev/disk/by-partuuid/${BOOT_A_UUID}}\"|" \
          -e "s|^BOOT_B_DEV=.*|BOOT_B_DEV=\"\${BF_RAUC_BOOT_B_DEV:-/dev/disk/by-partuuid/${BOOT_B_UUID}}\"|" \
          -e "s|^  root_a=.*|  root_a=\"\$(readlink -f /dev/disk/by-partuuid/${ROOT_A_UUID} 2>/dev/null || true)\"|" \
          -e "s|^  root_b=.*|  root_b=\"\$(readlink -f /dev/disk/by-partuuid/${ROOT_B_UUID} 2>/dev/null || true)\"|" \
          "${MNT}/usr/local/sbin/betterframe-rauc-boot.sh"
      fi
      echo "hook: patched x86 rootfs slot ${LETTER} fstab and RAUC PARTUUIDs"
    else
      ROOT_UUID="$(partuuid_of "BF_ROOT_${LETTER}")"
    cat > "${MNT}/etc/fstab" <<FSTAB
LABEL=BF_BOOT_${LETTER}  /boot/firmware  vfat  defaults  0  2
PARTUUID=${ROOT_UUID}  /               ext4  defaults,noatime  0  1
LABEL=BF_DATA    /var/lib/betterframe  ext4  defaults,noatime,nofail  0  2
FSTAB
      echo "hook: patched Pi rootfs slot ${LETTER} fstab -> BF_BOOT_${LETTER}, root PARTUUID=${ROOT_UUID}"
    fi
    ;;
  *)
    echo "hook: ignoring slot class '${RAUC_SLOT_CLASS}'"
    ;;
esac
