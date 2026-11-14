# Run on a disposable Windows CI user; always remove only this test's temporary certificates.
$ErrorActionPreference = 'Stop'
$directory = Join-Path $env:TEMP ("bf-ca-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$created = @()
function Assert-True($Value, $Message) { if (-not $Value) { throw $Message } }
function Fingerprint($Certificate) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Certificate.RawData))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Item($Certificate) {
    return @{ pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($Certificate.RawData, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"; fingerprint_sha256 = (Fingerprint $Certificate) }
}
function Installed($Certificate) { return Test-Path "Cert:\CurrentUser\Root\$($Certificate.Thumbprint)" }
try {
    $first = New-SelfSignedCertificate -Type Custom -Subject ('CN=BF managed test ' + [Guid]::NewGuid()) -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
    $created += $first
    $external = New-SelfSignedCertificate -Type Custom -Subject ('CN=BF external test ' + [Guid]::NewGuid()) -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
    $created += $external
    $root = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    $root.Open('ReadWrite'); $root.Add($external); $root.Close()
    $env:BF_CA_STATE = $directory
    $env:BF_CA_REQUEST = Join-Path $directory 'request.json'
    $env:BF_CA_REPORT = Join-Path $directory 'report.json'
    $script = Join-Path $PSScriptRoot '../client/src/platform/windows/trusted-cas.ps1'
    function Apply($Cas, $Expected) {
        @{ trusted_cas = @($Cas) } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:BF_CA_REQUEST -Encoding utf8
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script
        Assert-True ($LASTEXITCODE -eq $Expected) "Installer exit $LASTEXITCODE, expected $Expected; report: $(Get-Content -LiteralPath $env:BF_CA_REPORT -Raw)"
    }
    Apply @((Item $first), (Item $external)) 10
    Assert-True (Installed $first) 'Managed root missing'
    Apply @((Item $first), (Item $external)) 0
    $bad = Item $first; $bad.fingerprint_sha256 = '0' * 64
    Apply @($bad) 1
    Assert-True (Installed $first) 'Invalid assignment changed existing trust'
    Apply @() 10
    Assert-True (-not (Installed $first)) 'Managed root was not removed'
    Assert-True (Installed $external) 'Pre-existing root was removed'
    Apply @() 0
    $report = Get-Content -LiteralPath $env:BF_CA_REPORT -Raw | ConvertFrom-Json
    Assert-True ($report.state -eq 'applied' -and $report.revision -eq 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') 'Empty assignment report mismatch'
    Write-Host 'Windows CA installation, idempotence, validation and removal passed.'
} finally {
    foreach ($cert in $created) {
        foreach ($store in @('Root', 'My')) {
            $path = "Cert:\CurrentUser\$store\$($cert.Thumbprint)"
            if (Test-Path $path) { Remove-Item $path -Force }
        }
    }
    Remove-Item $directory -Recurse -Force
    Remove-Item Env:BF_CA_STATE, Env:BF_CA_REQUEST, Env:BF_CA_REPORT -ErrorAction SilentlyContinue
}
