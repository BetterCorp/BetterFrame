#!/usr/bin/env bash
# Randomize and disable interactive logins for image-baked users.
#
# These accounts are service/provisioning identities, not operator login
# accounts. Passwords are randomized so no image has a shared credential, then
# locked and assigned nologin so password auth cannot be used.
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is required to randomize image user passwords" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  set -- bfadmin bfkiosk
fi

for user in "$@"; do
  if ! getent passwd "$user" >/dev/null; then
    continue
  fi
  password="$(openssl rand -base64 48 | tr -d '\n')"
  printf '%s:%s\n' "$user" "$password" | chpasswd
  usermod -s /usr/sbin/nologin "$user"
  passwd -l "$user" >/dev/null 2>&1 || true
done
