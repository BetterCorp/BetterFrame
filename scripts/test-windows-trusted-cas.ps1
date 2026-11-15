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
function Installed($Certificate) { return Test-Path "Cert:\LocalMachine\Root\$($Certificate.Thumbprint)" }
try {
    $first = New-SelfSignedCertificate -Type Custom -Subject ('CN=BF managed test ' + [Guid]::NewGuid()) -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
    $created += $first
    $external = New-SelfSignedCertificate -Type Custom -Subject ('CN=BF external test ' + [Guid]::NewGuid()) -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddDays(1)
    $created += $external
    $root = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
    $root.Open('ReadWrite'); $root.Add($external); $root.Close()
    $env:BF_CA_STATE = $directory
    $env:BF_CA_REQUEST = Join-Path $directory 'request.json'
    $env:BF_CA_REPORT = Join-Path $directory 'report.json'
    $script = Join-Path $PSScriptRoot '../client/src/platform/windows/trusted-cas.ps1'
    function Apply($Cas, $Expected, $ScriptPath = $script) {
        @{ trusted_cas = @($Cas) } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $env:BF_CA_REQUEST -Encoding utf8
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $ScriptPath
        Assert-True ($LASTEXITCODE -eq $Expected) "Installer exit $LASTEXITCODE, expected $Expected; report: $(Get-Content -LiteralPath $env:BF_CA_REPORT -Raw)"
    }
    Write-Host "Testing managed machine-root installation"
    Apply @((Item $first), (Item $external)) 10
    Assert-True (Installed $first) 'Managed root missing'
    Apply @((Item $first), (Item $external)) 0
    $bad = Item $first; $bad.fingerprint_sha256 = '0' * 64
    Apply @($bad) 1
    Assert-True (Installed $first) 'Invalid assignment changed existing trust'
    # Fault injection after the root removal checks that errors still signal restart.
    $fault = Join-Path $directory 'fail-final-journal.ps1'
    $source = Get-Content -LiteralPath $script -Raw
    $finalJournal = 'Write-AtomicJson $journal @{ owned = $owned; previous = $previous; dirty = $false }'
    Assert-True ($source.Contains($finalJournal)) 'Final journal fault location changed'
    $source.Replace($finalJournal, 'throw "injected final journal failure"') | Set-Content -LiteralPath $fault -Encoding utf8
    Apply @() 11 $fault
    Assert-True (-not (Installed $first)) 'Managed root was not removed before the injected error'
    Assert-True (Installed $external) 'Pre-existing root was removed'
    Assert-True ((Get-Content -LiteralPath $env:BF_CA_REPORT -Raw | ConvertFrom-Json).state -eq 'error') 'Partial failure was not reported'
    Apply @() 10
    Apply @() 0
    $expired = New-SelfSignedCertificate -Type Custom -Subject ('CN=BF expired test ' + [Guid]::NewGuid()) -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={critical}{text}ca=1') -CertStoreLocation Cert:\CurrentUser\My -NotBefore (Get-Date).AddDays(-2) -NotAfter (Get-Date).AddDays(-1)
    $created += $expired
    Apply @((Item $first), (Item $expired)) 11
    Assert-True (Installed $first) 'An expired root blocked another valid root'
    Assert-True (-not (Installed $expired)) 'An expired root was installed'
    Apply @() 10
    Apply @() 0
    # Simulate an unelevated agent with the production read-only store path.
    $manualScript = Join-Path $directory 'unelevated-agent.ps1'
    $permissionCheck = '$canWrite = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
    Assert-True ($source.Contains($permissionCheck)) 'Agent permission check changed'
    $source.Replace($permissionCheck, '$canWrite = $false') | Set-Content -LiteralPath $manualScript -Encoding utf8
    Apply @((Item $first), (Item $external)) 0 $manualScript
    Assert-True ((Get-Content -LiteralPath $env:BF_CA_REPORT -Raw | ConvertFrom-Json).state -eq 'manual_action') 'Missing root did not request manual installation'
    $manualJournal = Get-Content -LiteralPath (Join-Path $directory 'ownership.json') -Raw | ConvertFrom-Json
    Assert-True (@($manualJournal.previous.PSObject.Properties).Count -eq 1) 'Manual tracking claimed the pre-existing root'
    Assert-True ($null -ne $manualJournal.previous.PSObject.Properties[(Fingerprint $first)]) 'Manually requested root was not tracked'
    $root.Open('ReadWrite'); $root.Add($first); $root.Close()
    Apply @((Item $first), (Item $external)) 10 $manualScript
    Apply @((Item $first), (Item $external)) 0 $manualScript
    Assert-True ((Get-Content -LiteralPath $env:BF_CA_REPORT -Raw | ConvertFrom-Json).state -eq 'applied') 'Manual installation was not detected'
    Apply @() 0 $manualScript
    Assert-True ((Get-Content -LiteralPath $env:BF_CA_REPORT -Raw | ConvertFrom-Json).state -eq 'manual_action') 'Unassignment failed to request manual removal'
    Assert-True (Installed $first) 'Manual root was silently removed'
    $root.Open('ReadWrite'); $root.Remove($first); $root.Close()
    Apply @() 10 $manualScript
    Apply @() 0 $manualScript
    Assert-True (Installed $external) 'Pre-existing root was removed'
    $report = Get-Content -LiteralPath $env:BF_CA_REPORT -Raw | ConvertFrom-Json
    Assert-True ($report.state -eq 'applied' -and $report.revision -eq 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') 'Empty assignment report mismatch'
    Write-Host 'Windows CA installation, idempotence, validation and removal passed.'
} finally {
    foreach ($cert in $created) {
        foreach ($store in @('LocalMachine\Root', 'CurrentUser\My')) {
            $path = "Cert:\$store\$($cert.Thumbprint)"
            if (Test-Path $path) { Remove-Item $path -Force }
        }
    }
    Remove-Item $directory -Recurse -Force
    Remove-Item Env:BF_CA_STATE, Env:BF_CA_REQUEST, Env:BF_CA_REPORT -ErrorAction SilentlyContinue
}
