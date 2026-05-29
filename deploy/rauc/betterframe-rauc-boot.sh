#!/usr/bin/env bash
set -euo pipefail

BOOT_A_DEV="${BF_RAUC_BOOT_A_DEV:-/dev/disk/by-partlabel/BF_BOOT_A}"
BOOT_B_DEV="${BF_RAUC_BOOT_B_DEV:-/dev/disk/by-partlabel/BF_BOOT_B}"
STATE_DIR="${BF_RAUC_STATE_DIR:-/var/lib/rauc/betterframe}"
STATE_FILE="${STATE_DIR}/slot-state"

slot_to_part() {
  case "$1" in
    A) printf '1' ;;
    B) printf '2' ;;
    *) exit 2 ;;
  esac
}

part_to_slot() {
  case "$1" in
    1) printf 'A' ;;
    2) printf 'B' ;;
    *) exit 2 ;;
  esac
}

slot_to_boot_dev() {
  case "$1" in
    A) printf '%s' "$BOOT_A_DEV" ;;
    B) printf '%s' "$BOOT_B_DEV" ;;
    *) exit 2 ;;
  esac
}

root_dev_to_slot() {
  local dev="$1"
  local root_a root_b
  root_a="$(readlink -f /dev/disk/by-partlabel/BF_ROOT_A 2>/dev/null || true)"
  root_b="$(readlink -f /dev/disk/by-partlabel/BF_ROOT_B 2>/dev/null || true)"
  dev="$(readlink -f "$dev" 2>/dev/null || printf '%s' "$dev")"
  case "$dev" in
    "$root_a") printf 'A' ;;
    "$root_b") printf 'B' ;;
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
  local root_source
  root_source="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
  if [ -n "$root_source" ]; then
    local slot
    if slot="$(root_dev_to_slot "$root_source" 2>/dev/null)"; then
      printf '%s' "$slot"
      return
    fi
  fi

  local part_file="/proc/device-tree/chosen/bootloader/partition"
  if [ -r "$part_file" ]; then
    local part
    part="$(tr -d '\000\n\r ' < "$part_file")"
    case "$part" in
      1|2) part_to_slot "$part"; return ;;
      3) printf 'A'; return ;;
      4) printf 'B'; return ;;
      *) exit 2 ;;
    esac
  fi
  exit 2
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
  part="$(with_boot_mounted A get_primary_from_mount)"
  part_to_slot "$part"
}

set_primary() {
  with_boot_mounted A write_primary_to_mount "$1"
  with_boot_mounted B write_primary_to_mount "$1"
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
  get-current) read_current_slot ;;
  *) exit 2 ;;
esac
