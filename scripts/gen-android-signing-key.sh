#!/usr/bin/env bash
# Run once. Back up the entire output directory in approved secure storage.
# Never commit these files or regenerate the key to fix a build failure.
set -euo pipefail
umask 077

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 /secure/path/to/new-signing-directory" >&2
  exit 2
fi
command -v keytool >/dev/null || { echo "error: keytool (JDK) is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "error: python3 is required" >&2; exit 1; }

out_dir="$1"
if [[ -L "$out_dir" ]]; then
  echo "error: refusing a symbolic-link output directory" >&2
  exit 1
fi
if [[ -e "$out_dir" ]]; then
  [[ -d "$out_dir" ]] || { echo "error: output path is not a directory" >&2; exit 1; }
  shopt -s nullglob dotglob
  existing=("$out_dir"/*)
  if (( ${#existing[@]} )); then
    echo "error: output directory is not empty; refusing to overwrite signing material" >&2
    exit 1
  fi
else
  mkdir -m 700 -p -- "$out_dir"
fi
chmod 700 -- "$out_dir"
# Prevent concurrent generators from using the same empty directory.
mkdir -- "$out_dir/.generation-lock"
trap 'rmdir -- "$out_dir/.generation-lock"' EXIT

python3 - "$out_dir" <<'PY'
import pathlib
import secrets
import sys

destination = pathlib.Path(sys.argv[1])
password = secrets.token_urlsafe(48)
for name, value in (
    ("store-password.txt", password),
    ("key-password.txt", password),  # PKCS12 uses the store password for its key.
    ("key-alias.txt", "betterframe-release"),
):
    with (destination / name).open("x", encoding="utf-8") as output:
        output.write(value + "\n")
PY

# Passwords are passed by file, never in arguments, environment, or log output.
keytool -genkeypair -noprompt \
  -keystore "$out_dir/release.p12" -storetype PKCS12 \
  -storepass:file "$out_dir/store-password.txt" \
  -keypass:file "$out_dir/key-password.txt" \
  -alias betterframe-release -keyalg RSA -keysize 3072 -sigalg SHA256withRSA \
  -validity 36500 -dname "CN=BetterFrame Android Release, O=BetterPortal"
keytool -exportcert -rfc \
  -keystore "$out_dir/release.p12" -storetype PKCS12 \
  -storepass:file "$out_dir/store-password.txt" \
  -alias betterframe-release -file "$out_dir/certificate.pem"

python3 - "$out_dir" <<'PY'
import hashlib
import pathlib
import ssl
import sys

destination = pathlib.Path(sys.argv[1])
certificate = ssl.PEM_cert_to_DER_cert((destination / "certificate.pem").read_text())
with (destination / "certificate-sha256.txt").open("x", encoding="ascii") as output:
    output.write(hashlib.sha256(certificate).hexdigest().upper() + "\n")
PY
chmod 600 -- "$out_dir/release.p12" "$out_dir/store-password.txt" \
  "$out_dir/key-password.txt" "$out_dir/key-alias.txt" \
  "$out_dir/certificate.pem" "$out_dir/certificate-sha256.txt"
echo "Created permanent Android signing material. Back up all six files in secure storage before using the key."
