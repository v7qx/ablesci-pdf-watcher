param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId,

  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "Chrome",

  [string]$InstallDir = "$env:LOCALAPPDATA\AblesciPdfUploader"
)

$ErrorActionPreference = "Stop"

$HostName = "com.ablesci.pdf_uploader"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$PrebuiltExe = Join-Path $RepoRoot "native-helper\bin\windows-amd64\ablesci_pdf_helper.exe"
$SourceGoDir = Join-Path $RepoRoot "native-helper"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$TargetExe = Join-Path $InstallDir "ablesci_pdf_helper.exe"
$TargetExe = [System.IO.Path]::GetFullPath($TargetExe)

if (Test-Path $PrebuiltExe) {
  Copy-Item $PrebuiltExe $TargetExe -Force
} else {
  if (!(Get-Command go -ErrorAction SilentlyContinue)) {
    throw "没有找到 Go。请先安装 Go，再重新运行 install_host.ps1。"
  }
  Push-Location $SourceGoDir
  try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    $env:CGO_ENABLED = "0"
    go build -trimpath -ldflags "-s -w" -o $TargetExe .
  } finally {
    Pop-Location
  }
}

$ManifestPath = Join-Path $InstallDir "$HostName.json"
$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
$AllowedOrigin = "chrome-extension://$ExtensionId/"
$ExistingOrigins = @()
if (Test-Path $ManifestPath) {
  try {
    $ExistingManifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
    if ($ExistingManifest.allowed_origins) {
      $ExistingOrigins = @($ExistingManifest.allowed_origins)
    }
  } catch {
    $ExistingOrigins = @()
  }
}
$AllowedOrigins = @($ExistingOrigins + $AllowedOrigin | Where-Object { $_ } | Sort-Object -Unique)

$manifest = [ordered]@{
  name = $HostName
  description = "Ablesci PDF Uploader Native Helper"
  path = $TargetExe
  type = "stdio"
  allowed_origins = $AllowedOrigins
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

$Browsers = if ($Browser -eq "All") { @("Chrome", "Edge") } else { @($Browser) }
foreach ($BrowserName in $Browsers) {
  if ($BrowserName -eq "Chrome") {
    $RegKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\$HostName"
  } else {
    $RegKey = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  }
  & reg.exe add $RegKey /ve /t REG_SZ /d $ManifestPath /f | Out-Null
  Write-Host "Registry entry written: $RegKey"
}

Write-Host "Native host installed."
Write-Host "Host name: $HostName"
Write-Host "Manifest : $ManifestPath"
Write-Host "Helper   : $TargetExe"
Write-Host "Allowed origins: $($AllowedOrigins -join ', ')"
Write-Host "现在可以在插件设置页点击“测试 Native Helper”。"
