# Disposable Windows runner only. Exercise the real SYSTEM updater with three
# vendor-signed fixture MSIs: installed, healthy upgrade, and broken upgrade.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:RUNNER_TEMP 'bf-update-recovery'
$installDir = Join-Path $env:ProgramFiles 'BetterFrame Recovery Test'
$stateDir = Join-Path $env:ProgramData 'BetterFrame/WindowsClient'
$updateDir = Join-Path $installDir 'updates'
$originalVersion = $env:BF_BUILD_VERSION
$originalKey = $env:BF_FIRMWARE_SIGNING_PUBLIC_KEY
$originalFlags = $env:RUSTFLAGS
$server = $null
New-Item -ItemType Directory -Force $fixture | Out-Null
$candle = Join-Path $env:WIX 'bin/candle.exe'
$light = Join-Path $env:WIX 'bin/light.exe'
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'

function Write-Json($Path, $Value) {
    $temp = "$Path.tmp"
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 10 -Compress))
    Move-Item -Force $temp $Path
}
function Wait-For([scriptblock]$Condition, [string]$Message, [int]$Seconds = 180) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (& $Condition) { return }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    if (Test-Path "$updateDir/updater.log") { Get-Content "$updateDir/updater.log" -Tail 30 }
    if (Test-Path "$updateDir/install.log") { Get-Content "$updateDir/install.log" -Tail 30 }
    throw $Message
}
function Invoke-Msi([string]$Arguments) {
    $process = Start-Process msiexec.exe -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -notin 0,3010) { throw "Fixture MSI failed: $($process.ExitCode)" }
}
try {
    if (Get-Service BetterFrameUpdater -ErrorAction SilentlyContinue) { throw 'Test requires no existing BetterFrame installation' }
    if (Test-Path "$stateDir/state.json") { throw 'Test refuses to overwrite existing enrollment' }
    openssl genpkey -algorithm ED25519 -out "$fixture/key.pem"
    if ($LASTEXITCODE -ne 0) { throw 'Fixture key generation failed' }
    openssl pkey -in "$fixture/key.pem" -pubout -out "$fixture/pub.pem"
    if ($LASTEXITCODE -ne 0) { throw 'Fixture public key generation failed' }
    $env:BF_FIRMWARE_SIGNING_PUBLIC_KEY = Get-Content "$fixture/pub.pem" -Raw
    $env:RUSTFLAGS = '-C target-feature=+crt-static'
    foreach ($version in @('1.0.0','1.0.1','1.0.2')) {
        $dir = (New-Item -ItemType Directory -Force (Join-Path $fixture "release-$version")).FullName
        $env:BF_BUILD_VERSION = $version
        cargo build --release --locked -p betterframe-windows-updater --target-dir target/updater
        if ($LASTEXITCODE -ne 0) { throw 'Fixture updater build failed' }
        Copy-Item target/updater/release/betterframe-windows-updater.exe "$dir/updater.exe"
        $probeExit = if ($version -eq '1.0.2') { 42 } else { 0 }
        # Real service/MSI transaction, deterministic client health signal.
        $source = @"
using System;
using System.IO;
using System.Threading;
class Client {
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "installation-test") return $probeExit;
    string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "BetterFrame", "WindowsClient");
    Directory.CreateDirectory(dir);
    while (true) {
      string data = "{\"version\":\"$version\",\"at\":" + DateTimeOffset.UtcNow.ToUnixTimeSeconds() + "}";
      File.WriteAllText(Path.Combine(dir,"runtime-health.json"),data);
      Thread.Sleep(1000);
    }
  }
}
"@
        $sourcePath = Join-Path $dir "client.cs"
        $clientPath = Join-Path $dir "client.exe"
        [IO.File]::WriteAllText($sourcePath, $source)
        & $csc /nologo /target:winexe "/out:$clientPath" $sourcePath
        if ($LASTEXITCODE -ne 0) { throw 'Fixture client build failed' }
        & $candle -nologo -arch x64 "-dReleaseVersion=$version" "-dFixtureDir=$dir" -out "$dir/package.wixobj" ../scripts/windows-update-tests/fixture.wxs
        if ($LASTEXITCODE -ne 0) { throw 'Fixture WiX compile failed' }
        & $light -nologo -out "$fixture/$version.msi" "$dir/package.wixobj"
        if ($LASTEXITCODE -ne 0) { throw 'Fixture MSI link failed' }
        $sha = (Get-FileHash "$fixture/$version.msi" -Algorithm SHA256).Hash.ToLowerInvariant()
        [IO.File]::WriteAllText("$dir/hash", $sha)
        openssl pkeyutl -sign -rawin -in "$dir/hash" -inkey "$fixture/key.pem" -out "$dir/signature"
        if ($LASTEXITCODE -ne 0) { throw 'Fixture signature failed' }
        $signature = [Convert]::ToBase64String([IO.File]::ReadAllBytes("$dir/signature")).TrimEnd('=').Replace('+','-').Replace('/','_')
        # Release IDs use the same UUID-safe alphabet as production.
        $id = $version.Replace('.','-')
        Copy-Item "$fixture/$version.msi" "$fixture/$id.msi"
        Write-Json "$fixture/$version.json" @{release_id=$id;version=$version;sha256=$sha;signature=$signature;size_bytes=(Get-Item "$fixture/$version.msi").Length;download_url="/api/firmware/public/download/$id"}
    }
    Write-Json "$fixture/control.json" @{version='1.0.0';reject_auth=$false}
    $serverScript = (Resolve-Path ../scripts/windows-update-tests/server.py).Path
    $server = Start-Process python -ArgumentList "`"$serverScript`" `"$fixture`"" -PassThru
    Wait-For { Test-Path "$fixture/port" } 'Mock BF server did not start' 30
    $origin = 'http://127.0.0.1:' + (Get-Content "$fixture/port" -Raw)
    New-Item -ItemType Directory -Force $stateDir | Out-Null
    Write-Json "$stateDir/state.json" @{server_url=$origin;kiosk_key='disposable-test-key';demo=$false}
    Invoke-Msi "/i `"$fixture/1.0.0.msi`" /qn /norestart"
    Start-Process "$installDir/bin/betterframe-windows-client.exe" -ArgumentList desktop | Out-Null
    Wait-For { Test-Path "$updateDir/policy.json" } 'Updater did not persist server policy'
    Stop-Service BetterFrameUpdater
    # Enrollment is rejected, and then its file is unavailable: recovery must
    # depend only on the independent service's saved origin/policy.
    Remove-Item "$stateDir/state.json"
    Write-Json "$fixture/control.json" @{version='1.0.1';reject_auth=$true}
    Start-Service BetterFrameUpdater
    Wait-For {
        if (-not (Test-Path "$stateDir/runtime-health.json")) { return $false }
        try { $health = Get-Content "$stateDir/runtime-health.json" -Raw | ConvertFrom-Json } catch { return $false }
        return $health.version -eq '1.0.1' -and -not (Test-Path "$updateDir/pending.json")
    } 'Signed update did not recover after authentication and enrollment failure' 240
    Write-Host 'Recovery upgrade passed with enrollment missing and BF authentication rejected.'
    Stop-Service BetterFrameUpdater
    Write-Json "$fixture/control.json" @{version='1.0.2';reject_auth=$true}
    Start-Service BetterFrameUpdater
    Wait-For {
        if (-not (Test-Path "$updateDir/updater.log")) { return $false }
        return (Get-Content "$updateDir/updater.log" -Raw).Contains('previous release restored') -and -not (Test-Path "$updateDir/pending.json")
    } 'Broken candidate was not rolled back' 240
    $health = Get-Content "$stateDir/runtime-health.json" -Raw | ConvertFrom-Json
    if ($health.version -ne '1.0.1') { throw 'Rollback did not restart the previously healthy client' }
    $attempts = Get-Content "$updateDir/attempts.json" -Raw | ConvertFrom-Json
    if ($attempts.version -ne '1.0.2' -or $attempts.count -ne 1) { throw 'Failure history was lost during rollback' }
    if ((Get-Service BetterFrameUpdater).Status -ne 'Running') { throw 'Recovery left the updater stopped' }
    Write-Host 'Failed candidate rolled back, client restarted, updater survived, and retry history persisted.'

    # A restart must recover an unfinished transaction before checking for
    # another release, even when the app and enrollment are unavailable.
    Stop-Service BetterFrameUpdater
    Get-Process betterframe-windows-client -ErrorAction SilentlyContinue | Stop-Process -Force
    $previous = Get-Content "$fixture/1.0.1.json" -Raw | ConvertFrom-Json
    $candidate = Get-Content "$fixture/1.0.2.json" -Raw | ConvertFrom-Json
    Write-Json "$updateDir/pending.json" @{
        previous=$previous; candidate=$candidate; stage='installing'
        started=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); sessions=@([Diagnostics.Process]::GetCurrentProcess().SessionId)
    }
    Remove-Item "$stateDir/runtime-health.json" -Force -ErrorAction SilentlyContinue
    Start-Service BetterFrameUpdater
    Wait-For {
        if ((Test-Path "$updateDir/pending.json") -or -not (Test-Path "$stateDir/runtime-health.json")) { return $false }
        try { $health = Get-Content "$stateDir/runtime-health.json" -Raw | ConvertFrom-Json } catch { return $false }
        return $health.version -eq '1.0.1'
    } 'Service restart did not recover the interrupted transaction' 180
    Write-Host 'Interrupted transaction recovered from its durable journal with the desktop stopped.'
} finally {
    Stop-Service BetterFrameUpdater -ErrorAction SilentlyContinue
    Get-Process betterframe-windows-client -ErrorAction SilentlyContinue | Stop-Process -Force
    # Identify the fixture product via Windows Installer, without Win32_Product repair scans.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    foreach ($product in $installer.RelatedProducts('{C57DAC79-D926-492A-800D-190630390291}')) {
        Invoke-Msi "/x $product /qn /norestart"
    }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Remove-Item "$stateDir/state.json", "$stateDir/runtime-health.json" -Force -ErrorAction SilentlyContinue
    $env:BF_BUILD_VERSION = $originalVersion
    $env:BF_FIRMWARE_SIGNING_PUBLIC_KEY = $originalKey
    $env:RUSTFLAGS = $originalFlags
}
