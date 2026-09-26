# Run from client/ with the GStreamer SDK and WiX available (Windows CI).
param([Parameter(Mandatory = $true)][string]$InstallVersion)
$ErrorActionPreference = 'Stop'

cargo install cargo-wix --version 0.3.9 --locked
if ($LASTEXITCODE -ne 0) { throw "cargo-wix install failed" }
$archive = Join-Path $env:RUNNER_TEMP "gstreamer-1.0-msvc-x86_64-$env:GSTREAMER_VERSION-merge-modules.zip"
gh release download $env:GSTREAMER_RELEASE --repo $env:GITHUB_REPOSITORY --dir $env:RUNNER_TEMP --pattern (Split-Path $archive -Leaf)
if ($LASTEXITCODE -ne 0) { throw "GStreamer merge-module download failed" }
$actualHash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $env:GSTREAMER_MSM_SHA256) {
  throw "GStreamer merge-module checksum mismatch: $actualHash"
}
$extractDir = Join-Path $env:RUNNER_TEMP "gstreamer-msm"
Expand-Archive -LiteralPath $archive -DestinationPath $extractDir
$sourceDir = Get-ChildItem $extractDir -Directory | Select-Object -First 1
$moduleDir = New-Item -ItemType Directory -Force -Path "target\gstreamer-msm"
@(
  "base-system-1.0.msm",
  "base-crypto.msm",
  "gstreamer-1.0-core.msm",
  "gstreamer-1.0-net.msm",
  "gstreamer-1.0-playback.msm",
  "gstreamer-1.0-codecs.msm",
  "gstreamer-1.0-system.msm",
  "gstreamer-1.0-libav.msm"
) | ForEach-Object { Copy-Item (Join-Path $sourceDir $_) $moduleDir }
cargo wix --package betterframe-client --nocapture --install-version $InstallVersion -L -sice:ICE30 -L -sice:ICE80
if ($LASTEXITCODE -ne 0) { throw "MSI build failed" }
