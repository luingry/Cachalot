<#
    Installs the current Release build of the module into this machine's SwissTechKnife, over the installed
    version folder, and restarts SwissTechKnife to the notification area. Also syncs the Chrome extension copy.
      powershell -File stk/scripts/install-local.ps1            build + install + restart
      powershell -File stk/scripts/install-local.ps1 -NoBuild   install the existing build

    The installed version folder is read from the real state.json (the module's version normally matches it).
    Like sync-extension.ps1, the file work runs in a process started through WMI: a Claude desktop session (an MSIX
    package) sees a virtualized %LOCALAPPDATA%, and SwissTechKnife started from it would inherit that view.
#>
[CmdletBinding()]
param(
    [switch]$NoBuild,
    [switch]$Direct
)
$ErrorActionPreference = 'Stop'
$stk = Split-Path -Parent $PSScriptRoot

if (-not $Direct) {
    if (-not $NoBuild) {
        dotnet build (Join-Path $stk 'Cachalot.Module/Cachalot.Module.csproj') -c Release -nologo -v q
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    }
    $log = Join-Path $env:TEMP "cachalot-install-$PID.log"
    $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Direct > `"$log`" 2>&1"
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd /c $cmd" }
    if ($created.ReturnValue -ne 0) { throw "Could not start the install process ($($created.ReturnValue))." }
    $process = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
    if ($process) { $process.WaitForExit(120000) | Out-Null }
    if (Test-Path $log) { Get-Content $log; Remove-Item $log -ErrorAction SilentlyContinue }
    & (Join-Path $PSScriptRoot 'sync-extension.ps1')
    return
}

$root = Join-Path $env:LOCALAPPDATA 'SwissTechKnife'
$state = Get-Content (Join-Path $root 'state.json') -Raw | ConvertFrom-Json
$installed = @($state.modules | Where-Object { $_.id -eq 'vd-get' }) | Select-Object -First 1
if (-not $installed) { throw 'Cachalot (vd-get) is not installed in SwissTechKnife: install it from the module list first.' }
$target = Join-Path $root "modules\vd-get\$($installed.folder)"
$source = Join-Path $stk 'Cachalot.Module\bin\Release\net48'
$exe = 'C:\Program Files\SwissTechKnife\SwissTechKnife.exe'

Get-Process SwissTechKnife -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill(); $_.WaitForExit(10000) | Out-Null }
Start-Sleep -Seconds 2
& robocopy $source $target /E /NJH /NJS /NFL /NDL /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)." }
$global:LASTEXITCODE = 0
Start-Process -FilePath $exe -ArgumentList '--startup'
Write-Host "Installed into $target (state version $($installed.version)) and restarted SwissTechKnife."
