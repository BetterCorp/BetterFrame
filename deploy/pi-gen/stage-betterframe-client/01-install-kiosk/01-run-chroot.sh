#!/bin/bash -e
# Runs inside the pi-gen chroot. Installs the BetterFrame kiosk binary +
# systemd unit + cage PAM + plymouth theme. Mirrors setup-pi-kiosk.sh but
# baked into the image so first boot is fully provisioned.

# --- bfkiosk user ---
if ! id -u bfkiosk >/dev/null 2>&1; then
  useradd -m -s /usr/sbin/nologin bfkiosk
fi
for grp in video render input audio; do
  if getent group "$grp" >/dev/null; then
    usermod -a -G "$grp" bfkiosk
  fi
done

# --- Binary ---
install -d -m 755 /opt/betterframe/kiosk
install -m 755 /tmp/bf-files/betterframe-kiosk /opt/betterframe/kiosk/betterframe-kiosk

# --- Systemd unit + PAM + rollback hook ---
install -m 644 /tmp/bf-files/betterframe-kiosk.service /etc/systemd/system/betterframe-kiosk.service
install -m 644 /tmp/bf-files/cage.pam                  /etc/pam.d/cage
install -m 755 /tmp/bf-files/betterframe-firmware-rollback.sh \
  /usr/local/sbin/betterframe-firmware-rollback.sh
install -m 644 /tmp/bf-files/betterframe-rauc-mark-good.service \
  /etc/systemd/system/betterframe-rauc-mark-good.service
install -m 755 /tmp/bf-files/betterframe-rauc-mark-good.sh \
  /usr/local/sbin/betterframe-rauc-mark-good.sh
install -d -m 755 /etc/tmpfiles.d
install -m 644 /tmp/bf-files/betterframe-kiosk.conf /etc/tmpfiles.d/betterframe-kiosk.conf
install -d -m 755 /etc/udev/rules.d
install -m 644 /tmp/bf-files/90-betterframe-no-hid.rules /etc/udev/rules.d/90-betterframe-no-hid.rules

# Default env file — operator may edit on first boot to point at their server.
cat > /etc/default/betterframe-kiosk <<'EOF'
# Runtime env for betterframe-kiosk. Edit and `systemctl restart betterframe-kiosk`.
# Override the BF server discovery (default tries localhost → betterframe.local
# → frame-eu.betterportal.net):
# BETTERFRAME_SERVER=https://frame.example.com

# Enable kiosk-app OTA. This image is curated and signed by us — fresh dev
# builds auto-deploy once they land in the BF server (via the build workflow's
# auto-import step). Set to 0 to pin a kiosk to its current binary.
BF_ENABLE_APP_OTA=1
EOF

# Plymouth boot splash
install -d -m 755 /usr/share/plymouth/themes/betterframe
install -m 644 /tmp/bf-files/betterframe.plymouth /usr/share/plymouth/themes/betterframe/betterframe.plymouth
install -m 644 /tmp/bf-files/betterframe.script   /usr/share/plymouth/themes/betterframe/betterframe.script
install -m 644 /tmp/bf-files/logo.png             /usr/share/plymouth/themes/betterframe/logo.png
plymouth-set-default-theme betterframe || true

# --- Enable services, disable noise ---
systemctl enable seatd
systemctl enable betterframe-kiosk.service
systemctl enable betterframe-rauc-mark-good.service

# Boot to multi-user, no display manager, no welcome wizard, no getty on tty1.
systemctl set-default multi-user.target
for dm in lightdm gdm gdm3 sddm; do
  systemctl disable "${dm}.service" 2>/dev/null || true
  systemctl mask    "${dm}.service" 2>/dev/null || true
done
systemctl disable getty@tty1.service 2>/dev/null || true
systemctl mask getty@tty1.service ctrl-alt-del.target 2>/dev/null || true
systemctl disable ssh.service ssh.socket 2>/dev/null || true
systemctl mask ssh.service ssh.socket 2>/dev/null || true
systemctl disable bluetooth.service hciuart.service 2>/dev/null || true
systemctl mask bluetooth.service hciuart.service 2>/dev/null || true

# piwiz first-run wizard + userconf-pi → out.
apt-get -y purge piwiz userconf-pi 2>/dev/null || true
rm -f /etc/xdg/autostart/piwiz.desktop

# Suppress console motd / issue.
: > /etc/motd
printf 'BetterFrame Kiosk\n\n' > /etc/issue
rm -f /etc/update-motd.d/* 2>/dev/null || true

# Boot config: quiet splash + no rainbow.
if [ -f /boot/firmware/cmdline.txt ]; then BOOT_DIR=/boot/firmware
else BOOT_DIR=/boot; fi
CMDLINE="${BOOT_DIR}/cmdline.txt"
CONFIG="${BOOT_DIR}/config.txt"
if [ -f "$CMDLINE" ]; then
  for flag in quiet splash plymouth.ignore-serial-consoles loglevel=0 vt.global_cursor_default=0 logo.nologo; do
    if ! grep -qw -- "$flag" "$CMDLINE"; then
      sed -i "s|\$| $flag|" "$CMDLINE"
    fi
  done
fi
if [ -f "$CONFIG" ] && ! grep -q '^disable_splash=1' "$CONFIG"; then
  printf '\n# BetterFrame: disable firmware rainbow splash\ndisable_splash=1\n' >> "$CONFIG"
fi

rm -rf /tmp/bf-files
echo "BetterFrame kiosk stage complete."
