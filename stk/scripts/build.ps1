<#
    Build gate for the Cachalot module: builds everything, runs the C# and Python unit tests, the extension
    tests (when Node is available), renders UI snapshots and packs artifacts/vd-get-<version>.zip.
      powershell -File stk/scripts/build.ps1                 all of the above
      powershell -File stk/scripts/build.ps1 -Integration    also runs the integration test (real backend, network)
      powershell -File stk/scripts/build.ps1 -SkipPack
#>
[CmdletBinding()]
param(
    [ValidateSet('Debug','Release')][string]$Configuration = 'Release',
    [switch]$Integration,
    [switch]$SkipPack
)
$ErrorActionPreference = 'Stop'
$stk = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $stk

foreach ($project in 'Cachalot.Module', 'Cachalot.DevHost', 'Cachalot.Tests') {
    dotnet build (Join-Path $stk "$project/$project.csproj") -c $Configuration -nologo -v q
    if ($LASTEXITCODE -ne 0) { throw "Build failed: $project" }
}

$tests = Join-Path $stk "Cachalot.Tests/bin/$Configuration/net48/Cachalot.Tests.exe"
if ($Integration) {
    $run = Start-Process -FilePath $tests -ArgumentList '--integration' -NoNewWindow -PassThru -Wait
} else {
    $run = Start-Process -FilePath $tests -NoNewWindow -PassThru -Wait
}
if ($run.ExitCode -ne 0) { throw 'C# tests failed.' }

$env:PYTHONDONTWRITEBYTECODE = '1'
& py -3 -m unittest discover -s (Join-Path $repo 'tests')
if ($LASTEXITCODE -ne 0) { throw 'Python tests failed.' }

$extTests = Join-Path $repo 'extension/chrome/tests'
if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path $extTests)) {
    & node --test $extTests
    if ($LASTEXITCODE -ne 0) { throw 'Extension tests failed.' }
}

$snapshots = Join-Path $repo 'artifacts/snapshots'
New-Item -ItemType Directory -Force $snapshots | Out-Null
$devhost = Join-Path $stk "Cachalot.DevHost/bin/$Configuration/net48/Cachalot.DevHost.exe"
$snap = Start-Process -FilePath $devhost -ArgumentList "--snapshot `"$snapshots`"" -PassThru
if (-not $snap.WaitForExit(60000)) { $snap.Kill(); throw 'Snapshot run timed out.' }
Write-Host "Snapshots in $snapshots" -ForegroundColor Green

if (-not $SkipPack) {
    & (Join-Path $PSScriptRoot 'pack.ps1') -Configuration $Configuration
}
