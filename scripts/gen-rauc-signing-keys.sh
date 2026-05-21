#!/usr/bin/env bash
# Generate the RAUC signing-cert PAIR used to sign OS bundles. Run ONCE per
# deployment; ALL kiosks built afterward must embed the matching CA cert
# in /etc/rauc/keyring.pem to accept bundles signed with this key.
#
# Outputs (written to ./rauc-signing/, .gitignored):
#   ca-cert.pem        — embed in kiosk image at /etc/rauc/keyring.pem
#   ca-key.pem         — KEEP OFFLINE. Only used to issue new signing certs.
#   signing-cert.pem   — committed to GitHub Actions secret BF_RAUC_SIGNING_CERT
#   signing-key.pem    — committed to GitHub Actions secret BF_RAUC_SIGNING_KEY
#
# RAUC accepts any OpenSSL-supported key inside an X.509 cert. We use
# Ed25519 because the cert chain stays small and verification is fast on
# the Pi. CA cert is self-signed; signing cert is issued by the CA. If
# the signing cert is ever leaked, revoke by rotating it under the same
# CA — kiosks don't need a re-flash, only a CRL update (future work).
set -euo pipefail

OUT_DIR="${1:-./rauc-signing}"
mkdir -p "$OUT_DIR"
cd "$OUT_DIR"

if [ -f ca-cert.pem ]; then
  echo "refusing to overwrite existing keys at $OUT_DIR — delete first if intentional"
  exit 1
fi

echo "==> Generating CA (Ed25519, 10 year validity)"
openssl genpkey -algorithm ED25519 -out ca-key.pem
openssl req -new -x509 -days 3650 -key ca-key.pem \
  -subj "/CN=BetterFrame RAUC CA" -out ca-cert.pem

echo "==> Generating signing cert (Ed25519, 2 year validity)"
openssl genpkey -algorithm ED25519 -out signing-key.pem
openssl req -new -key signing-key.pem \
  -subj "/CN=BetterFrame RAUC Signing" -out signing.csr
openssl x509 -req -in signing.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -days 730 -out signing-cert.pem
rm -f signing.csr ca-cert.srl

chmod 600 ca-key.pem signing-key.pem

cat <<EOF

==> Done. Next steps:

1. Embed CA cert in the image at /etc/rauc/keyring.pem
   (commit ca-cert.pem to repo; pi-gen stage will install it).

2. Set GitHub Actions secrets (Settings → Secrets → Actions):
     BF_RAUC_SIGNING_CERT = $(realpath signing-cert.pem) contents
     BF_RAUC_SIGNING_KEY  = $(realpath signing-key.pem) contents

3. STORE ca-key.pem OFFLINE. It's used only to issue replacement signing
   certs if the live signing key is rotated. Treat like a root password.

Files:
  $(ls -la)
EOF
