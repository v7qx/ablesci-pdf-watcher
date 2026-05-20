param(
  [Parameter(Mandatory=$true)]
  [string]$ExtensionId,

  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "Chrome",

  [string]$InstallDir = "$env:LOCALAPPDATA\AblesciPdfWatcherPrivate"
)

$ErrorActionPreference = "Stop"

$HostName = "com.ablesci.pdf_watcher_private"
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
    throw "Go was not found. Install Go first, then rerun install_host.ps1."
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
  description = "Ablesci PDF Watcher Private Native Helper"
  path = $TargetExe
  type = "stdio"
  allowed_origins = $AllowedOrigins
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

# Copy notification icon alongside the helper binary
$NotifyIconSrc = Join-Path $RepoRoot "extension\icons\icon48.png"
if (Test-Path $NotifyIconSrc) {
  $NotifyIconDst = Join-Path $InstallDir "icon48.png"
  Copy-Item -LiteralPath $NotifyIconSrc -Destination $NotifyIconDst -Force
  Write-Host "Copied notify icon: $NotifyIconDst"
}

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
Write-Host "You can now click Test Native Helper in the extension options page."
