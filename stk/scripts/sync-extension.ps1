<#
    Copies extension/chrome to the folder Chrome loads the unpacked extension from on this machine
    (%LOCALAPPDATA%\SwissTechKnife\data\vd-get\extensao-chrome, the same copy "Instalar no Chrome…" makes).
    Afterwards, click the reload button of the Cachalot extension in chrome://extensions.
      powershell -File stk/scripts/sync-extension.ps1
      powershell -File stk/scripts/sync-extension.ps1 -Target <outra pasta>

    From a Claude desktop session (an MSIX package) %LOCALAPPDATA% is virtualized: new files would land in the
    package's private copy, invisible to Chrome. So the copy runs in a process started through WMI, outside it.
#>
[CmdletBinding()]
param(
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'SwissTechKnife\data\vd-get\extensao-chrome'),
    [switch]$Direct
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $repo 'extension\chrome'

if (-not $Direct) {
    $log = Join-Path $env:TEMP "cachalot-sync-$PID.log"
    $cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Direct -Target `"$Target`" > `"$log`" 2>&1"
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd /c $cmd" }
    if ($created.ReturnValue -ne 0) { throw "Could not start the copy process ($($created.ReturnValue))." }
    $process = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
    if ($process) { $process.WaitForExit(60000) | Out-Null }
    if (Test-Path $log) { Get-Content $log; Remove-Item $log -ErrorAction SilentlyContinue }
    return
}

# Same exclusions as the module package (stk/Cachalot.Module/Cachalot.Module.csproj).
& robocopy $source $Target /E /NJH /NJS /NFL /NDL /NP /XD tests scripts node_modules docs /XF 'package*.json' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)." }
$global:LASTEXITCODE = 0
Write-Host "Extension copied to $Target. Reload it in chrome://extensions."
