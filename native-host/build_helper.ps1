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

# Parse extension version dynamically from extension/manifest.json
$ManifestPath = Join-Path $RepoRoot "extension\manifest.json"
if (Test-Path $ManifestPath) {
  $Manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
  $VersionStr = $Manifest.version
  $VersionParts = $VersionStr -split '\.'
  $Major = [int]$VersionParts[0]
  $Minor = [int]$VersionParts[1]
  $Patch = 0
  if ($VersionParts.Count -gt 2) { $Patch = [int]$VersionParts[2] }
  $Build = 0
  if ($VersionParts.Count -gt 3) { $Build = [int]$VersionParts[3] }
} else {
  $VersionStr = "1.0.0"
  $Major = 1; $Minor = 0; $Patch = 0; $Build = 0
}

Push-Location $HelperDir
try {
  $env:GOOS = $TargetOS
  $env:GOARCH = $TargetArch
  $env:CGO_ENABLED = "0"

  # Generate resource.syso for Windows builds
  if ($TargetOS -eq "windows") {
    $VersionInfoJson = Join-Path $HelperDir "versioninfo.json"
    $IcoSrc = Join-Path $RepoRoot "extension\icons\icon.ico"
    if (Test-Path $VersionInfoJson) {
      Write-Host "Generating Windows resource metadata ($VersionStr)..."
      go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.4.0 `
        -ver-major=$Major -ver-minor=$Minor -ver-patch=$Patch -ver-build=$Build `
        -product-ver-major=$Major -product-ver-minor=$Minor -product-ver-patch=$Patch -product-ver-build=$Build `
        -file-version="$VersionStr" -product-version="$VersionStr" `
        -icon="$IcoSrc" -o="resource.syso" "$VersionInfoJson"
    }
  }

  $SysoPath = Join-Path $HelperDir "resource.syso"
  try {
    go build -trimpath -ldflags "-s -w" -o $Output .
  } finally {
    if (Test-Path $SysoPath) {
      Remove-Item -LiteralPath $SysoPath -Force | Out-Null
      Write-Host "Removed temporary resource.syso"
    }
  }

  if (Test-Path $TelegramTemplate) {
    Copy-Item -LiteralPath $TelegramTemplate -Destination (Join-Path $OutDir "telegram.example.json") -Force
  }

  $NotifyIcon = Join-Path $RepoRoot "extension\icons\icon48.png"
  if (Test-Path $NotifyIcon) {
    Copy-Item -LiteralPath $NotifyIcon -Destination (Join-Path $OutDir "icon48.png") -Force
    Write-Host "Copied notify icon: $NotifyIcon -> $OutDir\icon48.png"
  }

  # Copy the pre-generated high-resolution icon.ico
  $IcoSrc = Join-Path $RepoRoot "extension\icons\icon.ico"
  if (Test-Path $IcoSrc) {
    Copy-Item -LiteralPath $IcoSrc -Destination (Join-Path $OutDir "icon.ico") -Force
    Write-Host "Copied icon.ico to $OutDir\icon.ico"
  }

  Write-Host "Built: $Output"
} finally {
  Pop-Location
}
