# Requires a disposable Windows runner: installs, repairs, then removes the MSI.
param([Parameter(Mandatory = $true)][string]$MsiPath)
$ErrorActionPreference = 'Stop'
$msi = (Resolve-Path $MsiPath).Path
$installDir = Join-Path $env:ProgramFiles 'BetterFrame Startup Test'
$exe = Join-Path $installDir 'bin/betterframe-windows-client.exe'
$runKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
$expected = '"' + $exe + '" desktop'
$originalProgramData = $env:ProgramData
$testData = Join-Path ([IO.Path]::GetTempPath()) ('betterframe-msi-' + [guid]::NewGuid())
$agent = $null
$installed = $false

function Invoke-Msi([string]$Arguments) {
    $process = Start-Process msiexec.exe -ArgumentList $Arguments -Wait -PassThru
    if ($process.ExitCode -notin 0, 3010) { throw "msiexec failed: $($process.ExitCode)" }
}

function Assert-Startup {
    $actual = Get-ItemPropertyValue -Path $runKey -Name BetterFrame
    if ($actual -cne $expected) { throw "Incorrect startup command: $actual" }
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'BetterFrame.lnk'
    if (-not (Test-Path $shortcutPath)) { throw 'Start menu shortcut is missing' }
}

try {
    Invoke-Msi "/i `"$msi`" APPLICATIONFOLDER=`"$installDir`" /qn /norestart"
    $installed = $true
    Assert-Startup
    # Verify the actual PE header: Explorer must not allocate a console window.
    $image = [IO.File]::ReadAllBytes($exe)
    $peOffset = [BitConverter]::ToInt32($image, 0x3c)
    $subsystem = [BitConverter]::ToUInt16($image, $peOffset + 24 + 68)
    if ($subsystem -ne 2) { throw "Expected Windows GUI subsystem, got $subsystem" }

    # Isolate enrollment from other tests and never contact the public service.
    $env:ProgramData = $testData
    $probe = Start-Process $exe -ArgumentList 'self-test' -Wait -PassThru
    if ($probe.ExitCode -ne 0) { throw "Installed client self-test failed: $($probe.ExitCode)" }
    $agent = Start-Process $exe -ArgumentList 'desktop --server http://127.0.0.1:9' -PassThru
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($agent.HasExited) { throw "Desktop startup exited: $($agent.ExitCode)" }
        try {
            $mutex = [Threading.Mutex]::OpenExisting('Local\BetterFrameWindowsAgent')
            $mutex.Dispose()
            $ready = $true
            break
        } catch [Threading.WaitHandleCannotBeOpenedException] {
            Start-Sleep -Milliseconds 200
        }
    }
    if (-not $ready) { throw 'Desktop startup did not acquire the instance guard' }
    # No-argument Explorer launch must select the same agent and exit harmlessly.
    $duplicate = Start-Process $exe -PassThru
    if (-not $duplicate.WaitForExit(10000)) {
        Stop-Process -Id $duplicate.Id -Force
        throw 'Duplicate launch did not exit'
    }
    if ($duplicate.ExitCode -ne 0) { throw "Duplicate launch failed: $($duplicate.ExitCode)" }
    Stop-Process -Id $agent.Id -Force
    $agent.WaitForExit()
    $agent = $null

    Remove-ItemProperty -Path $runKey -Name BetterFrame
    Invoke-Msi "/famus `"$msi`" /qn /norestart"
    Assert-Startup
    Invoke-Msi "/x `"$msi`" /qn /norestart"
    $installed = $false
    if (Get-ItemProperty -Path $runKey -Name BetterFrame -ErrorAction SilentlyContinue) {
        throw 'Uninstall left automatic startup registered'
    }
    if (Test-Path $exe) { throw 'Uninstall left the client executable installed' }
    Write-Host 'Windows MSI startup, GUI executable, duplicate launch, repair and uninstall passed.'
} finally {
    if ($agent -and -not $agent.HasExited) { Stop-Process -Id $agent.Id -Force }
    $env:ProgramData = $originalProgramData
    if ($installed) { Invoke-Msi "/x `"$msi`" /qn /norestart" }
    if (Test-Path $testData) { Remove-Item -LiteralPath $testData -Recurse -Force }
}
