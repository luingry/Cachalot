<#
    Renders the Cachalot icon from its single vector source (assets/brand/cachalot-icon.json):
      assets/brand/cachalot.svg                 vector copy (README, docs)
      assets/brand/cachalot-<n>.png             256 (catalog iconImage, tile-free), 128 (README)
      assets/brand/preview-*.png                tile previews at 256/64/32 (review only)
      extension/chrome/icons/active-<n>.png     16, 24, 32, 48, 128
      extension/chrome/icons/inactive-<n>.png   same, grayscale and dimmed
    Run with -STA:  powershell -NoProfile -STA -File stk/scripts/render-icon.ps1
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase, System.Web.Extensions

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$brand = Join-Path $repo 'assets/brand'
$extIcons = Join-Path $repo 'extension/chrome/icons'
New-Item -ItemType Directory -Force $brand, $extIcons | Out-Null
$utf8 = New-Object Text.UTF8Encoding $false
$spec = (New-Object Web.Script.Serialization.JavaScriptSerializer).DeserializeObject([IO.File]::ReadAllText((Join-Path $brand 'cachalot-icon.json'), $utf8))
$size = [double]$spec['artboard']
$offsetY = [double]$spec['offsetY']

function Color([string]$hex) { [Windows.Media.ColorConverter]::ConvertFromString($hex) }
function Gray([Windows.Media.Color]$c) {
    $l = [byte]([Math]::Min(255, 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B))
    [Windows.Media.Color]::FromArgb([byte]($c.A * 0.55), $l, $l, $l)
}

function Build-Drawing([bool]$grayscale) {
    $group = New-Object Windows.Media.DrawingGroup
    $group.Transform = New-Object Windows.Media.TranslateTransform 0, $offsetY
    foreach ($layer in $spec['layers']) {
        $geometry = [Windows.Media.Geometry]::Parse($layer['path'])
        $brush = $null; $pen = $null
        if ($layer.ContainsKey('fill')) {
            $stops = @($layer['fill'] | ForEach-Object { $c = Color $_; if ($grayscale) { Gray $c } else { $c } })
            if ($stops.Count -eq 1) { $brush = New-Object Windows.Media.SolidColorBrush $stops[0] }
            else { $brush = New-Object Windows.Media.LinearGradientBrush $stops[0], $stops[1], (New-Object Windows.Point 0.5, 0), (New-Object Windows.Point 0.5, 1) }
        }
        if ($layer.ContainsKey('stroke')) {
            $c = Color $layer['stroke']; if ($grayscale) { $c = Gray $c }
            $pen = New-Object Windows.Media.Pen (New-Object Windows.Media.SolidColorBrush $c), ([double]$layer['width'])
            $pen.StartLineCap = 'Round'; $pen.EndLineCap = 'Round'; $pen.LineJoin = 'Round'
        }
        $group.Children.Add((New-Object Windows.Media.GeometryDrawing $brush, $pen, $geometry))
    }
    $group.Freeze()
    $group
}

function Save-Png($drawing, [int]$px, [string]$path, [string]$tile) {
    $visual = New-Object Windows.Media.DrawingVisual
    $dc = $visual.RenderOpen()
    $pad = 0.0
    if ($tile) {
        $dc.DrawRoundedRectangle((New-Object Windows.Media.SolidColorBrush (Color $tile)), $null, (New-Object Windows.Rect 0, 0, $px, $px), $px * 0.22, $px * 0.22)
        $pad = 0.16
    }
    $scale = $px / $size * (1 - 2 * $pad)
    $dc.PushTransform((New-Object Windows.Media.TranslateTransform ($px * $pad), ($px * $pad)))
    $dc.PushTransform((New-Object Windows.Media.ScaleTransform $scale, $scale))
    $dc.DrawDrawing($drawing)
    $dc.Pop(); $dc.Pop(); $dc.Close()
    $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap $px, $px, 96, 96, ([Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create($path)
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
}

$color = Build-Drawing $false
$gray = Build-Drawing $true
Save-Png $color 256 (Join-Path $brand 'cachalot-256.png') $null
Save-Png $color 128 (Join-Path $brand 'cachalot-128.png') $null
$tile = $spec['catalog']['iconBackground']
foreach ($px in 256, 64, 32) { Save-Png $color $px (Join-Path $brand "preview-tile-$px.png") $tile }
foreach ($px in 16, 24, 32, 48, 128) {
    Save-Png $color $px (Join-Path $extIcons "active-$px.png") $null
    Save-Png $gray $px (Join-Path $extIcons "inactive-$px.png") $null
}

# SVG copy from the same layers.
$svg = New-Object Text.StringBuilder
[void]$svg.AppendLine("<svg xmlns=`"http://www.w3.org/2000/svg`" viewBox=`"0 0 $size $size`" width=`"$size`" height=`"$size`">")
[void]$svg.AppendLine('  <defs><linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + $spec['layers'][0]['fill'][0] + '"/><stop offset="1" stop-color="' + $spec['layers'][0]['fill'][1] + '"/></linearGradient></defs>')
[void]$svg.AppendLine("  <g transform=`"translate(0 $offsetY)`">")
$first = $true
foreach ($layer in $spec['layers']) {
    if ($layer.ContainsKey('fill')) {
        $fill = if ($first) { 'url(#body)' } else { $layer['fill'][0] }
        [void]$svg.AppendLine("    <path d=`"$($layer['path'])`" fill=`"$fill`"/>")
    } else {
        [void]$svg.AppendLine("    <path d=`"$($layer['path'])`" fill=`"none`" stroke=`"$($layer['stroke'])`" stroke-width=`"$($layer['width'])`" stroke-linecap=`"round`" stroke-linejoin=`"round`"/>")
    }
    $first = $false
}
[void]$svg.AppendLine('  </g>')
[void]$svg.AppendLine('</svg>')
[IO.File]::WriteAllText((Join-Path $brand 'cachalot.svg'), $svg.ToString(), $utf8)
Write-Host "Icon rendered to $brand and $extIcons" -ForegroundColor Green
