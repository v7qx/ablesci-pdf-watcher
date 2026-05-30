param(
  [ValidateSet("Chrome", "Edge")]
  [string]$Browser = "Chrome",

  [string]$ProfileDir = "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile",

  [string]$DownloadDir = "$env:USERPROFILE\Downloads\AblesciPdfWatcher",

  [string]$ShortcutName = "Ablesci PDF Watcher",

  [switch]$Launch
)

$ErrorActionPreference = "Stop"

function Find-BrowserExe([string]$Name) {
  $candidates = if ($Name -eq "Edge") {
    @(
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    )
  } else {
    @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
      "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
  }
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) {
      return [System.IO.Path]::GetFullPath($path)
    }
  }
  throw "$Name was not found. Install $Name first, then rerun this script."
}

function Read-JsonObject([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{}
  }
  $raw = Get-Content -LiteralPath $Path -Raw
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [pscustomobject]@{}
  }
  return $raw | ConvertFrom-Json
}

function Ensure-ObjectProperty($Object, [string]$Name) {
  if ($null -eq $Object.$Name) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  return $Object.$Name
}

function Set-ObjectProperty($Object, [string]$Name, $Value) {
  $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ExtensionDir = Join-Path $RepoRoot "extension"
$BrowserExe = Find-BrowserExe $Browser

$ProfileDir = [System.IO.Path]::GetFullPath($ProfileDir)
$DownloadDir = [System.IO.Path]::GetFullPath($DownloadDir)
$DefaultProfileDir = Join-Path $ProfileDir "Default"
$PreferencesPath = Join-Path $DefaultProfileDir "Preferences"
$LocalStatePath = Join-Path $ProfileDir "Local State"
$FirstRunPath = Join-Path $ProfileDir "First Run"

New-Item -ItemType Directory -Force -Path $DefaultProfileDir | Out-Null
New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null
if (!(Test-Path -LiteralPath $FirstRunPath)) {
  New-Item -ItemType File -Force -Path $FirstRunPath | Out-Null
}

$localState = Read-JsonObject $LocalStatePath
$browserState = Ensure-ObjectProperty $localState "browser"
Set-ObjectProperty $browserState "has_seen_welcome_page" $true
$localState | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $LocalStatePath -Encoding UTF8

$prefs = Read-JsonObject $PreferencesPath
$download = Ensure-ObjectProperty $prefs "download"
Set-ObjectProperty $download "default_directory" $DownloadDir
Set-ObjectProperty $download "directory_upgrade" $true
Set-ObjectProperty $download "prompt_for_download" $false

$plugins = Ensure-ObjectProperty $prefs "plugins"
Set-ObjectProperty $plugins "always_open_pdf_externally" $true

$browserPrefs = Ensure-ObjectProperty $prefs "browser"
Set-ObjectProperty $browserPrefs "has_seen_welcome_page" $true

$profile = Ensure-ObjectProperty $prefs "profile"
Set-ObjectProperty $profile "exited_cleanly" $true
Set-ObjectProperty $profile "exit_type" "Normal"
$contentSettings = Ensure-ObjectProperty $profile "default_content_setting_values"
Set-ObjectProperty $contentSettings "automatic_downloads" 1

$prefs | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $PreferencesPath -Encoding UTF8

$DesktopDir = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopDir "$ShortcutName.lnk"
$Arguments = "--user-data-dir=`"$ProfileDir`" --profile-directory=Default chrome://extensions/"
if ($Browser -eq "Edge") {
  $Arguments = "--user-data-dir=`"$ProfileDir`" --profile-directory=Default edge://extensions/"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $BrowserExe
$shortcut.Arguments = $Arguments
$shortcut.WorkingDirectory = Split-Path -Parent $BrowserExe
$shortcut.Description = "Open a dedicated browser profile for Ablesci PDF Watcher"
$shortcut.Save()

Write-Host "Dedicated browser profile prepared."
Write-Host "Browser      : $Browser"
Write-Host "Browser exe  : $BrowserExe"
Write-Host "Profile dir  : $ProfileDir"
Write-Host "Download dir : $DownloadDir"
Write-Host "Preferences : $PreferencesPath"
Write-Host "Local State : $LocalStatePath"
Write-Host "Shortcut    : $ShortcutPath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Open the shortcut."
Write-Host "2. Enable Developer mode on the extensions page."
Write-Host "3. Load unpacked extension from:"
Write-Host "   $ExtensionDir"
Write-Host "4. After loading the extension, install Native Helper with:"
Write-Host "   .\native-host\install_host.ps1 -Browser $Browser -ProfileDir `"$ProfileDir`""

if ($Launch) {
  Start-Process -FilePath $BrowserExe -ArgumentList $Arguments | Out-Null
}
