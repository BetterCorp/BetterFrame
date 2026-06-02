#!/usr/bin/env bash
set -euo pipefail

BOOT_A_DEV="${BF_RAUC_BOOT_A_DEV:-/dev/disk/by-partlabel/BF_BOOT_A}"
BOOT_B_DEV="${BF_RAUC_BOOT_B_DEV:-/dev/disk/by-partlabel/BF_BOOT_B}"
STATE_DIR="${BF_RAUC_STATE_DIR:-/var/lib/rauc/betterframe}"
STATE_FILE="${STATE_DIR}/slot-state"

slot_to_boot_dev() {
  case "$1" in
    A) printf '%s' "$BOOT_A_DEV" ;;
    B) printf '%s' "$BOOT_B_DEV" ;;
    *) exit 2 ;;
  esac
}

root_dev_to_slot() {
  local dev root_a root_b
  root_a="$(readlink -f /dev/disk/by-partlabel/BF_ROOT_A 2>/dev/null || true)"
  root_b="$(readlink -f /dev/disk/by-partlabel/BF_ROOT_B 2>/dev/null || true)"
  dev="$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")"
  case "$dev" in
    "$root_a") printf 'A' ;;
    "$root_b") printf 'B' ;;
    *) exit 2 ;;
  esac
}

mounted_at() {
  local dev resolved
  dev="$1"
  resolved="$(readlink -f "$dev" 2>/dev/null || printf '%s' "$dev")"
  findmnt -rn -S "$resolved" -o TARGET 2>/dev/null | head -n1 || true
}

with_boot_mounted() {
  local slot="$1"
  local fn="$2"
  shift 2
  local dev mountpoint mounted
  dev="$(slot_to_boot_dev "$slot")"
  mounted="$(mounted_at "$dev")"
  if [ -n "$mounted" ]; then
    "$fn" "$mounted" "$@"
    return
  fi

  mountpoint="$(mktemp -d)"
  mount "$dev" "$mountpoint"
  set +e
  "$fn" "$mountpoint" "$@"
  local rc=$?
  set -e
  umount "$mountpoint"
  rmdir "$mountpoint"
  return "$rc"
}

read_primary_from_mount() {
  local mountpoint="$1"
  grub-editenv "${mountpoint}/EFI/betterframe/grubenv" list 2>/dev/null \
    | awk -F= '$1 == "bf_primary" { print $2; exit }'
}

write_primary_to_mount() {
  local mountpoint="$1"
  local primary="$2"
  install -d -m 755 "${mountpoint}/EFI/betterframe"
  [ -f "${mountpoint}/EFI/betterframe/grubenv" ] \
    || grub-editenv "${mountpoint}/EFI/betterframe/grubenv" create
  grub-editenv "${mountpoint}/EFI/betterframe/grubenv" set "bf_primary=${primary}"
  sync -f "${mountpoint}/EFI/betterframe/grubenv" 2>/dev/null || sync
}

get_primary() {
  local primary
  primary="$(with_boot_mounted A read_primary_from_mount || true)"
  case "$primary" in
    A|B) printf '%s' "$primary" ;;
    *) printf 'A' ;;
  esac
}

set_primary() {
  local primary="${1:?slot required}"
  case "$primary" in A|B) ;; *) exit 2 ;; esac
  with_boot_mounted A write_primary_to_mount "$primary"
  with_boot_mounted B write_primary_to_mount "$primary"
}

get_current() {
  local root_source
  root_source="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
  [ -n "$root_source" ] || exit 2
  root_dev_to_slot "$root_source"
}

get_state() {
  local slot="$1"
  if [ -f "$STATE_FILE" ] && grep -qx "${slot}=bad" "$STATE_FILE"; then
    printf 'bad\n'
  else
    printf 'good\n'
  fi
}

set_state() {
  local slot="$1"
  local state="$2"
  mkdir -p "$STATE_DIR"
  if [ "$state" = "bad" ]; then
    grep -vx "${slot}=good" "$STATE_FILE" 2>/dev/null | grep -vx "${slot}=bad" > "${STATE_FILE}.tmp" || true
    printf '%s=bad\n' "$slot" >> "${STATE_FILE}.tmp"
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  else
    grep -vx "${slot}=bad" "$STATE_FILE" 2>/dev/null > "${STATE_FILE}.tmp" || true
    mv "${STATE_FILE}.tmp" "$STATE_FILE"
  fi
}

case "${1:-}" in
  get-primary) get_primary ;;
  set-primary) set_primary "${2:?slot required}" ;;
  get-current) get_current ;;
  get-state) get_state "${2:?slot required}" ;;
  set-state) set_state "${2:?slot required}" "${3:?state required}" ;;
  *) exit 2 ;;
esac
