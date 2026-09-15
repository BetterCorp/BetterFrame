#!/usr/bin/env bash
# Executed as root by systemd, independently of the confined kiosk and RAUC
# bundle mount. D-Bus contract: https://rauc.readthedocs.io/en/latest/reference.html
set -euo pipefail
platform="${1:?platform required}"
target="${2:?target slot required}"
owner="${3:?RAUC bus owner required}"
case "$platform:$target" in pi:rootfs.[01]|x86:rootfs.[01]) ;; *) exit 2 ;; esac
status_file="${BF_REBOOT_STATUS_FILE:-/run/betterframe-rauc/os-reboot-status.txt}"
install -d -m 755 "$(dirname "$status_file")"
status() { printf '%s\n' "$1" > "${status_file}.tmp"; chmod 644 "${status_file}.tmp"; mv "${status_file}.tmp" "$status_file"; }
fail() { status "$1"; echo "$1" >&2; exit 1; }
trap 'fail "Reboot guard failed; the device has not been rebooted"' ERR
same_daemon() {
  [ "$(busctl call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus GetNameOwner s de.pengutronix.rauc)" = "$owner" ]
}
status 'Waiting for OS installation to finish'
deadline=$((SECONDS + ${BF_REBOOT_WAIT_SECONDS:-1800}))
while :; do
  same_daemon || fail 'RAUC restarted during installation; reboot cancelled'
  operation="$(busctl get-property de.pengutronix.rauc / de.pengutronix.rauc.Installer Operation)"
  [ "$operation" != 's "idle"' ] || break
  [ "$operation" = 's "installing"' ] || fail 'Unknown RAUC operation; reboot cancelled'
  [ "$SECONDS" -lt "$deadline" ] || fail 'OS installation did not finish before reboot deadline'
  sleep 1
done
[ "$(busctl get-property de.pengutronix.rauc / de.pengutronix.rauc.Installer LastError)" = 's ""' ] || fail 'OS installation failed; reboot cancelled'
if [ "$platform" = x86 ]; then
  [ "$(busctl call de.pengutronix.rauc / de.pengutronix.rauc.Installer GetPrimary)" = "s \"$target\"" ] || fail 'Updated OS slot was not activated; reboot cancelled'
else
  # The Pi backend GetPrimary deliberately returns the permanent slot, not
  # the trial slot. Its activation writes pending only AFTER both autoboot
  # files have been written and synced. Use that completed activation record.
  letter=A; [ "$target" != rootfs.1 ] || letter=B
  state=/var/lib/betterframe/rauc/betterframe/slot-state
  # Bundles must also work on old systems whose backend uses root-local state.
  if ! grep -q '^data-directory=/var/lib/betterframe/rauc$' "${BF_RAUC_SYSTEM_CONF:-/etc/rauc/system.conf}"; then
    state=/var/lib/rauc/betterframe/slot-state
  fi
  grep -qx "pending=$letter" "${BF_RAUC_ACTIVATION_STATE:-$state}" || fail 'Updated Pi trial slot was not activated; reboot cancelled'
fi
# Copy the legacy state AFTER activation; copying in the slot hook loses the
# pending/activated status written by RAUC when that hook returns.
if grep -q '^data-directory=/var/lib/betterframe/rauc$' "${BF_RAUC_SYSTEM_CONF:-/etc/rauc/system.conf}"; then
  "$(dirname "$0")/state.sh"
else
  "$(dirname "$0")/state.sh" --refresh-legacy
fi
same_daemon || fail 'RAUC restarted before reboot; reboot cancelled'
[ "$(busctl get-property de.pengutronix.rauc / de.pengutronix.rauc.Installer Operation)" = 's "idle"' ] || fail 'Another OS install started; reboot cancelled'
status 'OS installed; reboot requested'
sync
sleep "${BF_REBOOT_GRACE_SECONDS:-5}"
same_daemon || fail 'RAUC restarted during reboot grace period; reboot cancelled'
[ "$(busctl get-property de.pengutronix.rauc / de.pengutronix.rauc.Installer Operation)" = 's "idle"' ] || fail 'Another OS install started; reboot cancelled'
[ "$(busctl get-property de.pengutronix.rauc / de.pengutronix.rauc.Installer LastError)" = 's ""' ] || fail 'OS installation failed; reboot cancelled'
if [ "$platform" = pi ]; then
  # Pi firmware reboot flags are one argument, including the embedded space:
  # https://www.raspberrypi.com/documentation/hardware/rpi/os.html
  reboot '0 tryboot'
else
  systemctl reboot
fi
