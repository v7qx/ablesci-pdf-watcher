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
  throw "未找到 Go 编译器，无法从源码构建 Helper。请先准备 Go 开发环境后重新运行本脚本。"
}

$OutDir = Split-Path -Parent $Output
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

Push-Location $HelperDir
try {
  $env:GOOS = $TargetOS
  $env:GOARCH = $TargetArch
  $env:CGO_ENABLED = "0"

  go build -trimpath -ldflags "-s -w" -o $Output .

  Write-Host "Built: $Output"
} finally {
  Pop-Location
}
