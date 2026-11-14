<#
.SYNOPSIS
  Zips the Cachalot Chrome extension into cachalot-chrome-<version>.zip.

.DESCRIPTION
  Packs only what Chrome needs (manifest.json, src, popup, pages, ui, icons);
  tests, scripts and package.json stay out. Entries use forward slashes, which
  the Chrome Web Store and other unzip tools expect (Compress-Archive on
  Windows PowerShell 5.1 writes backslashes, so it is not used).

.PARAMETER OutDir
  Output folder. Default: <repo>\artifacts.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File extension\chrome\scripts\package.ps1
  powershell -ExecutionPolicy Bypass -File extension\chrome\scripts\package.ps1 -OutDir $env:TEMP\cachalot-pkg
#>
param(
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$extDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $extDir '..\..')).Path
if (-not $OutDir) {
  $OutDir = Join-Path $repoRoot 'artifacts'
}

$manifest = Get-Content (Join-Path $extDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
if (-not $version) {
  throw 'manifest.json has no version'
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zipPath = Join-Path (Resolve-Path $OutDir).Path "cachalot-chrome-$version.zip"
if (Test-Path $zipPath) {
  Remove-Item $zipPath -Force
}

$include = @('manifest.json', 'src', 'popup', 'pages', 'ui', 'icons')

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$count = 0
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($item in $include) {
    $path = Join-Path $extDir $item
    if (-not (Test-Path $path)) {
      throw "missing $item"
    }
    if (Test-Path $path -PathType Container) {
      $files = Get-ChildItem $path -Recurse -File
    } else {
      $files = @(Get-Item $path)
    }
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($extDir.Length).TrimStart('\', '/').Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, $file.FullName, $relative, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
      $count++
    }
  }
} finally {
  $zip.Dispose()
}

Write-Host "Wrote $zipPath ($count files, version $version)"
