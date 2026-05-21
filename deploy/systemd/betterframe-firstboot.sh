#!/bin/bash
# Runs ONCE per device on first boot, before betterframe-kiosk starts.
# Purpose: replace the image's baked-in bfadmin password with a per-device
# random one so a leaked image (or shared install) doesn't share creds
# across kiosks.
#
# Outputs:
#   /etc/betterframe/admin-password   (mode 0400, root) — plaintext for now
#   /run/betterframe/firstboot-banner — printed to tty1 so an HDMI-attached
#                                       operator can read the new password
#                                       once. Cleared on next boot.
#   /var/lib/betterframe/.firstboot-complete — marker, blocks re-run.
#
# Future: post the password (encrypted with cluster_key) to the BF server
# via the heartbeat so admins can fetch it from the kiosk detail page.
# Until that's wired the file + tty banner are the only ways out, and the
# operator is expected to read the banner once or pull the file via the
# HDMI-attached console.
set -euo pipefail

MARKER_DIR="/var/lib/betterframe"
MARKER="${MARKER_DIR}/.firstboot-complete"
PASSWORD_FILE="/etc/betterframe/admin-password"
BANNER_DIR="/run/betterframe"
BANNER="${BANNER_DIR}/firstboot-banner"

if [ -f "$MARKER" ]; then
  exit 0
fi

# 32 chars of base64 ≈ 24 bytes entropy. tr away ambiguous glyphs so the
# operator transcribing from a TV screen has a fighting chance.
NEW_PW="$(LC_ALL=C tr -dc 'A-HJ-NP-Za-km-z2-9' < /dev/urandom | head -c 24)"

mkdir -p "$MARKER_DIR"
mkdir -p "$(dirname "$PASSWORD_FILE")"
mkdir -p "$BANNER_DIR"

# Apply the new password atomically.
printf 'bfadmin:%s\n' "$NEW_PW" | chpasswd

# Persist for first-time retrieval. 0400 root-only so bfkiosk + bfadmin
# can't peek at each other's creds. Operator who needs it can `sudo cat`.
umask 077
printf '%s\n' "$NEW_PW" > "$PASSWORD_FILE"
chmod 0400 "$PASSWORD_FILE"
chown root:root "$PASSWORD_FILE"

# Banner printed to tty1 so the operator can read it once before the kiosk
# takes over the screen. cage masks /dev/tty1 when betterframe-kiosk
# starts, so the banner is only visible during the boot window.
cat > "$BANNER" <<EOF

================================================================
  BetterFrame first-boot
  ----------------------------------------------------------------
  bfadmin password rotated from the image default.

  New password: ${NEW_PW}

  Stored at: ${PASSWORD_FILE} (sudo cat to retrieve later)
  This banner only shows once. Write it down or photograph it.
================================================================
EOF

# Echo to tty1 directly. systemd's TTYPath ties stdout to tty1 too but
# during early boot output can race; this is a belt+suspenders.
if [ -w /dev/tty1 ]; then
  cat "$BANNER" > /dev/tty1 || true
fi

# Marker last so a crash mid-script doesn't leave us with a half-applied
# state that blocks the next boot's rerun.
touch "$MARKER"

exit 0
