param(
  [string]$TargetOS = "windows",
  [string]$TargetArch = "amd64",
  [string]$Output = ""
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$HelperDir = Join-Path $RepoRoot "native-helper"

if ($Output -eq "") {
  $ExeName = "ablesci_pdf_helper"
  if ($TargetOS -eq "windows") {
    $ExeName = "$ExeName.exe"
  }
  $Output = Join-Path $HelperDir "bin\$TargetOS-$TargetArch\$ExeName"
}
$Output = [System.IO.Path]::GetFullPath($Output)

if (!(Get-Command go -ErrorAction SilentlyContinue)) {
  throw "未找到 Go，无法从源码编译 Helper。请先准备 Go 环境，或使用已预编译的 native-helper\\bin\\windows-amd64\\ablesci_pdf_helper.exe。"
}

$OutDir = Split-Path -Parent $Output
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$TelegramTemplate = Join-Path $ScriptDir "telegram.example.json"

Push-Location $HelperDir
try {
  $env:GOOS = $TargetOS
  $env:GOARCH = $TargetArch
  $env:CGO_ENABLED = "0"
  go build -trimpath -ldflags "-s -w" -o $Output .
  if (Test-Path $TelegramTemplate) {
    Copy-Item -LiteralPath $TelegramTemplate -Destination (Join-Path $OutDir "telegram.example.json") -Force
  }
  $NotifyIcon = Join-Path $RepoRoot "extension\icons\icon48.png"
  if (Test-Path $NotifyIcon) {
    Copy-Item -LiteralPath $NotifyIcon -Destination (Join-Path $OutDir "icon48.png") -Force
    Write-Host "Copied notify icon: $NotifyIcon -> $OutDir\icon48.png"
  }

  # Build multi-resolution .ico from PNGs for Start Menu shortcut icon
  $IconsDir = Join-Path $RepoRoot "extension\icons"
  $IcoPath = Join-Path $OutDir "icon.ico"
  $PngSources = @("icon16.png", "icon32.png", "icon48.png", "icon128.png") | ForEach-Object {
    $p = Join-Path $IconsDir $_
    if (Test-Path $p) { $p }
  }
  if ($PngSources.Count -gt 0) {
    try {
      Add-Type -AssemblyName System.Drawing
      $fs = [System.IO.File]::OpenWrite($IcoPath)
      $bw = New-Object System.IO.BinaryWriter($fs)
      # ICO header: reserved(2) + type=1(2) + count(2)
      $bw.Write([uint16]0)
      $bw.Write([uint16]1)
      $bw.Write([uint16]$PngSources.Count)
      # Calculate data offset: header(6) + entries(16 each)
      $dataOffset = 6 + (16 * $PngSources.Count)
      $pngBlobs = @()
      foreach ($sp in $PngSources) {
        $pngBytes = [System.IO.File]::ReadAllBytes($sp)
        $pngBlobs += $pngBytes
        $img = [System.Drawing.Bitmap]::FromFile($sp)
        $w = if ($img.Width -ge 256) { 0 } else { $img.Width }
        $h = if ($img.Height -ge 256) { 0 } else { $img.Height }
        # Directory entry: w(1) h(1) colors(1) reserved(1) planes(2) bpp(2) size(4) offset(4)
        $bw.Write([byte]$w)
        $bw.Write([byte]$h)
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]32)
        $bw.Write([uint32]$pngBytes.Length)
        $bw.Write([uint32]$dataOffset)
        $dataOffset += $pngBytes.Length
        $img.Dispose()
      }
      foreach ($blob in $pngBlobs) {
        $bw.Write($blob)
      }
      $bw.Close()
      $fs.Close()
      Write-Host "Generated icon: $IcoPath"
    } catch {
      Write-Warning "Failed to build .ico: $_"
    }
  }

  Write-Host "Built: $Output"
} finally {
  Pop-Location
}
