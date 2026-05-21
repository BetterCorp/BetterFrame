# Generate the RAUC signing-cert PAIR used to sign OS bundles.
# Run ONCE per deployment. Requires OpenSSL in PATH (e.g. via Git for Windows,
# choco install openssl, or winget install ShiningLight.OpenSSL).
#
# Outputs (written to ./rauc-signing/):
#   ca-cert.pem        - embed in kiosk image at /etc/rauc/keyring.pem
#   ca-key.pem         - KEEP OFFLINE. Only used to issue new signing certs.
#   signing-cert.pem   - GitHub Actions secret BF_RAUC_SIGNING_CERT
#   signing-key.pem    - GitHub Actions secret BF_RAUC_SIGNING_KEY

param(
    [string]$OutDir = ".\rauc-signing"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
    Write-Error "openssl not found in PATH. Install via: winget install ShiningLight.OpenSSL"
    exit 1
}

if (Test-Path "$OutDir\ca-cert.pem") {
    Write-Error "Refusing to overwrite existing keys at $OutDir - delete first if intentional"
    exit 1
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Push-Location $OutDir

try {
    # ECDSA P-256 — RAUC uses OpenSSL CMS which doesn't support Ed25519 on
    # OpenSSL < 3.2 (Ubuntu 24.04 ships 3.0). P-256 is universally supported.
    Write-Host "==> Generating CA (ECDSA P-256, 10 year validity)"
    openssl ecparam -genkey -name prime256v1 -noout -out ca-key.pem
    openssl req -new -x509 -days 3650 -key ca-key.pem `
        -subj "/CN=BetterFrame RAUC CA" -out ca-cert.pem

    Write-Host "==> Generating signing cert (ECDSA P-256, 2 year validity)"
    openssl ecparam -genkey -name prime256v1 -noout -out signing-key.pem
    openssl req -new -key signing-key.pem `
        -subj "/CN=BetterFrame RAUC Signing" -out signing.csr
    openssl x509 -req -in signing.csr -CA ca-cert.pem -CAkey ca-key.pem `
        -CAcreateserial -days 730 -out signing-cert.pem

    Remove-Item -Force signing.csr, ca-cert.srl -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "==> Done. Next steps:"
    Write-Host ""
    Write-Host "1. Commit CA cert into repo:"
    Write-Host "     Copy-Item $(Resolve-Path ca-cert.pem) ..\deploy\rauc\ca-cert.pem"
    Write-Host "     git add deploy/rauc/ca-cert.pem"
    Write-Host "     git commit -m 'chore(rauc): commit CA cert'"
    Write-Host "     git push"
    Write-Host ""
    Write-Host "2. Set GitHub Actions secrets (Settings > Secrets > Actions):"
    Write-Host "     BF_RAUC_SIGNING_CERT = contents of $(Resolve-Path signing-cert.pem)"
    Write-Host "     BF_RAUC_SIGNING_KEY  = contents of $(Resolve-Path signing-key.pem)"
    Write-Host ""
    Write-Host "3. STORE ca-key.pem OFFLINE. Only needed to issue replacement signing certs."
    Write-Host ""
    Get-ChildItem | Format-Table Name, Length
}
finally {
    Pop-Location
}
