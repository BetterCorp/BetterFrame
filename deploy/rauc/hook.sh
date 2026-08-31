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

write_x86_rauc_system_conf() {
  local path="$1"
  local root_a_uuid="$2"
  local root_b_uuid="$3"
  cat > "$path" <<RAUCCONF
[system]
compatible=betterframe-x86_64-generic
bootloader=grub
grubenv=/boot/efi/EFI/betterframe/grubenv
data-directory=/var/lib/rauc
bundle-formats=plain

[keyring]
path=/etc/rauc/keyring.pem

[slot.rootfs.0]
device=/dev/disk/by-partuuid/${root_a_uuid}
type=ext4
bootname=A

[slot.rootfs.1]
device=/dev/disk/by-partuuid/${root_b_uuid}
type=ext4
bootname=B

RAUCCONF
}

schedule_reboot() {
  local -a command=(/usr/bin/systemctl reboot)
  if [ "$1" = "pi" ]; then
    command=(/usr/sbin/reboot 0 tryboot)
  fi
  systemd-run --unit=betterframe-rauc-reboot --on-active=30s --collect "${command[@]}"
  echo "hook: scheduled reboot after successful RAUC install"
}

LETTER="$(slot_letter)"

# Prefer the mount point RAUC already provides; fall back to mounting.
MNT="${RAUC_SLOT_MOUNT_POINT:-}"
OWN_MOUNT=0
OWN_ESP_MOUNT=0
if [ -z "$MNT" ]; then
  MNT="$(mktemp -d)"
  mount "$RAUC_SLOT_DEVICE" "$MNT"
  OWN_MOUNT=1
fi
cleanup() {
  sync
  if [ "$OWN_ESP_MOUNT" = "1" ]; then
    umount /boot/efi 2>/dev/null || true
  fi
  if [ "$OWN_MOUNT" = "1" ]; then
    umount "$MNT" 2>/dev/null || true
    rmdir "$MNT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

case "$RAUC_SLOT_CLASS" in
  bootfs)
    if [ ! -f "${MNT}/cmdline.txt" ]; then
      echo "hook: bootfs slot is not a Pi boot filesystem" >&2
      exit 1
    fi
    ROOT_UUID="$(partuuid_of "BF_ROOT_${LETTER}")"
    # root MUST stay PARTUUID — initramfs can't resolve labels.
    sed -i "s|root=PARTUUID=[^ ]*|root=PARTUUID=${ROOT_UUID}|" "${MNT}/cmdline.txt"
    sed -i "s|root=/dev/[^ ]*|root=PARTUUID=${ROOT_UUID}|" "${MNT}/cmdline.txt"
    sed -i 's/ init_resize//; s/ resize//' "${MNT}/cmdline.txt"
    apply_quiet "${MNT}/cmdline.txt"
    grep -q '^disable_splash=1' "${MNT}/config.txt" 2>/dev/null \
      || printf '\n# BetterFrame: disable firmware rainbow splash\ndisable_splash=1\n' >> "${MNT}/config.txt"
    echo "hook: patched Pi bootfs slot ${LETTER} -> root=PARTUUID=${ROOT_UUID}"
    ;;
  rootfs)
    if [ -f "${MNT}/etc/betterframe/os-compatibility" ] \
      && grep -qx 'betterframe-x86_64-generic' "${MNT}/etc/betterframe/os-compatibility"; then
      BOOT_UUID="$(partuuid_of BF_BOOT)"
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
        "$ROOT_A_UUID" "$ROOT_B_UUID"
      if ! mountpoint -q /boot/efi; then
        mkdir -p /boot/efi
        mount "/dev/disk/by-partuuid/${BOOT_UUID}" /boot/efi
        OWN_ESP_MOUNT=1
      fi
      KERNEL="$(find "${MNT}/boot" -maxdepth 1 -type f -name 'vmlinuz-*' -printf '%f\n' | sort -V | tail -n1)"
      INITRD="$(find "${MNT}/boot" -maxdepth 1 -type f -name 'initrd.img-*' -printf '%f\n' | sort -V | tail -n1)"
      if [ -z "$KERNEL" ] || [ -z "$INITRD" ]; then
        echo "hook: updated x86 rootfs has no kernel or initrd" >&2
        exit 1
      fi
      install -m 644 "${MNT}/boot/${KERNEL}" "/boot/efi/.vmlinuz-${LETTER}.new"
      install -m 644 "${MNT}/boot/${INITRD}" "/boot/efi/.initrd-${LETTER}.img.new"
      mv "/boot/efi/.initrd-${LETTER}.img.new" "/boot/efi/initrd-${LETTER}.img"
      mv "/boot/efi/.vmlinuz-${LETTER}.new" "/boot/efi/vmlinuz-${LETTER}"
      # Preserve host identity across replaceable root slots. This also lets
      # the first TPM-enabled update decrypt and migrate legacy BFE1 state,
      # whose x86 fallback key was derived from machine-id.
      if [ -s /etc/machine-id ]; then
        install -m 444 /etc/machine-id "${MNT}/etc/machine-id"
      fi
      schedule_reboot x86
      echo "hook: patched x86 rootfs slot ${LETTER} fstab and RAUC PARTUUIDs"
    else
      ROOT_UUID="$(partuuid_of "BF_ROOT_${LETTER}")"
    cat > "${MNT}/etc/fstab" <<FSTAB
LABEL=BF_BOOT_${LETTER}  /boot/firmware  vfat  defaults  0  2
PARTUUID=${ROOT_UUID}  /               ext4  defaults,noatime  0  1
LABEL=BF_DATA    /var/lib/betterframe  ext4  defaults,noatime,nofail  0  2
FSTAB
      schedule_reboot pi
      echo "hook: patched Pi rootfs slot ${LETTER} fstab -> BF_BOOT_${LETTER}, root PARTUUID=${ROOT_UUID}"
    fi
    ;;
  *)
    echo "hook: ignoring slot class '${RAUC_SLOT_CLASS}'"
    ;;
esac
