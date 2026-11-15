# Embedded in the signed player. Input and output paths are data, never executable text.
$ErrorActionPreference = 'Stop'
function Write-AtomicJson($Path, $Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, (ConvertTo-Json -InputObject $Value -Depth 8 -Compress), [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
}
function Hash-Bytes([byte[]] $Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
$report = @{ revision = (Hash-Bytes ([byte[]]@())); state = 'error'; message = '' }
$changed = $false
$store = $null
try {
    $cas = @((Get-Content -LiteralPath $env:BF_CA_REQUEST -Raw | ConvertFrom-Json).trusted_cas)
    if ($cas.Count -gt 32) { throw 'At most 32 CA certificates are supported' }
    $report.revision = Hash-Bytes ([Text.Encoding]::UTF8.GetBytes((@($cas | ForEach-Object { $_.fingerprint_sha256 } | Sort-Object -CaseSensitive) -join "`n")))
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BetterFrameCaSignature {
    [DllImport("crypt32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CryptVerifyCertificateSignatureEx(IntPtr provider, uint encoding, uint subjectType,
        IntPtr subject, uint issuerType, IntPtr issuer, uint flags, IntPtr extra);
}
'@
    $desired = @{}
    $seen = @{}
    $validityErrors = @()
    foreach ($ca in $cas) {
        $fp = [string]$ca.fingerprint_sha256
        $pem = [string]$ca.pem
        if ($fp -cnotmatch '^[0-9a-f]{64}$' -or $seen.ContainsKey($fp) -or [Text.Encoding]::UTF8.GetByteCount($pem) -gt 16384 -or
            $pem.Trim() -cnotmatch '^-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$') { throw 'Invalid CA assignment' }
        $seen[$fp] = $true
        $der = [Convert]::FromBase64String(($pem -replace '-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s', ''))
        $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
        $basic = @($cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.19' })
        if ($basic.Count -ne 1 -or -not $basic[0].CertificateAuthority -or $cert.Subject -ne $cert.Issuer -or
            (Hash-Bytes $cert.RawData) -cne $fp -or
            -not [BetterFrameCaSignature]::CryptVerifyCertificateSignatureEx([IntPtr]::Zero, 1, 2, $cert.Handle, 2, $cert.Handle, 1, [IntPtr]::Zero)) { throw 'A valid, self-signed root CA is required' }
        if ($cert.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $cert.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) {
            $validityErrors += ($fp + ': CA certificate is expired or not yet valid')
            continue
        }
        $desired[$fp] = $cert
    }
    $journal = Join-Path $env:BF_CA_STATE 'ownership.json'
    $owned = @{}
    if (Test-Path -LiteralPath $journal) {
        $saved = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
        $changed = [bool]$saved.dirty
        foreach ($entry in $saved.owned.PSObject.Properties) { $owned[$entry.Name] = [string]$entry.Value }
    }
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    $canWrite = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    function Require-Administrator {
        if (-not $canWrite) { throw [UnauthorizedAccessException]::new('Run the BetterFrame agent as administrator to manage machine certificates, or install/remove the assigned roots manually in the machine Trusted Root Certification Authorities store.') }
    }
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
    if ($canWrite) { $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite) }
    else { $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly) }
    foreach ($fp in @($owned.Keys)) {
        if ($fp -cnotmatch '^[0-9a-f]{64}$') { throw 'Corrupt CA ownership journal' }
        if ($desired.ContainsKey($fp)) { continue }
        foreach ($cert in @($store.Certificates)) {
            if ((Hash-Bytes $cert.RawData) -ceq $fp) { Require-Administrator; Write-AtomicJson $journal @{ owned = $owned; dirty = $true }; $store.Remove($cert); $changed = $true }
        }
        $owned.Remove($fp)
        Write-AtomicJson $journal @{ owned = $owned; dirty = $true }
    }
    foreach ($fp in $desired.Keys) {
        $found = @($store.Certificates | Where-Object { (Hash-Bytes $_.RawData) -ceq $fp }).Count -gt 0
        if ($found) { continue } # Never claim ownership of a pre-existing root.
        Require-Administrator
        $owned[$fp] = $desired[$fp].Thumbprint
        Write-AtomicJson $journal @{ owned = $owned; dirty = $true }
        $store.Add($desired[$fp]); $changed = $true
    }
    Write-AtomicJson $journal @{ owned = $owned; dirty = $false }
    if ($validityErrors.Count) { $report.state = 'error'; $report.message = ($validityErrors -join '; '); if ($report.message.Length -gt 1024) { $report.message = $report.message.Substring(0, 1024) } }
    else { $report.state = 'applied' }
} catch {
    if ($_.Exception -is [UnauthorizedAccessException]) { $report.state = 'manual_action' }
    $report.message = ([string]$_.Exception.Message).Substring(0, [Math]::Min(1024, ([string]$_.Exception.Message).Length))
} finally {
    if ($null -ne $store) { $store.Close() }
}
Write-AtomicJson $env:BF_CA_REPORT $report
if ($report.state -eq 'error') { if ($changed) { exit 11 }; exit 1 }
if ($report.state -eq 'manual_action') { exit 0 }
if ($changed) { exit 10 }
exit 0
