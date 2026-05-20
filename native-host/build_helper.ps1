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
  throw "Go was not found. Install Go first, then rerun build_helper.ps1."
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
  Write-Host "Built: $Output"
} finally {
  Pop-Location
}
