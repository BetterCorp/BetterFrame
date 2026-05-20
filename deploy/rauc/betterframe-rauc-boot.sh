#!/usr/bin/env bash
set -euo pipefail

SELECTOR_DEV="${BF_RAUC_SELECTOR_DEV:-/dev/disk/by-partlabel/BF_BOOTSEL}"
STATE_DIR="${BF_RAUC_STATE_DIR:-/var/lib/rauc/betterframe}"
STATE_FILE="${STATE_DIR}/slot-state"

slot_to_part() {
  case "$1" in
    A) printf '2' ;;
    B) printf '3' ;;
    *) exit 2 ;;
  esac
}

part_to_slot() {
  case "$1" in
    2) printf 'A' ;;
    3) printf 'B' ;;
    *) exit 2 ;;
  esac
}

other_slot() {
  case "$1" in
    A) printf 'B' ;;
    B) printf 'A' ;;
    *) exit 2 ;;
  esac
}

read_current_slot() {
  local part_file="/proc/device-tree/chosen/bootloader/partition"
  if [ -r "$part_file" ]; then
    local part
    part="$(tr -d '\000\n\r ' < "$part_file")"
    case "$part" in
      2|3) printf '%s' "$part"; return ;;
      *) exit 2 ;;
    esac
  fi
  exit 2
}

with_selector_mounted() {
  local fn="$1"
  shift
  local mountpoint
  mountpoint="$(mktemp -d)"
  mount "$SELECTOR_DEV" "$mountpoint"
  set +e
  "$fn" "$mountpoint" "$@"
  local rc=$?
  set -e
  umount "$mountpoint"
  rmdir "$mountpoint"
  return "$rc"
}

get_primary_from_mount() {
  local mountpoint="$1"
  awk '
    /^\[all\]$/ { in_all=1; next }
    /^\[/ { in_all=0; next }
    in_all && /^boot_partition=/ { sub(/^boot_partition=/, ""); print; exit }
  ' "${mountpoint}/autoboot.txt"
}

write_primary_to_mount() {
  local mountpoint="$1"
  local primary_slot="$2"
  local primary_part try_part
  primary_part="$(slot_to_part "$primary_slot")"
  try_part="$(slot_to_part "$(other_slot "$primary_slot")")"
  cat > "${mountpoint}/autoboot.txt" <<EOF
[all]
tryboot_a_b=1
PARTITION_WALK=1
boot_partition=${primary_part}

[tryboot]
boot_partition=${try_part}
EOF
  sync -f "${mountpoint}/autoboot.txt" 2>/dev/null || sync
}

get_primary() {
  local part
  part="$(with_selector_mounted get_primary_from_mount)"
  part_to_slot "$part"
}

set_primary() {
  with_selector_mounted write_primary_to_mount "$1"
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
  get-state) get_state "${2:?slot required}" ;;
  set-state) set_state "${2:?slot required}" "${3:?state required}" ;;
  get-current) part_to_slot "$(read_current_slot)" ;;
  *) exit 2 ;;
esac
