param(
  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "All",

  [string]$InstallDir = "$env:LOCALAPPDATA\AblesciPdfWatcherPrivate",

  [switch]$RemoveFiles,

  [switch]$OpenInstallDir
)

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$HostName = "com.ablesci.pdf_watcher_private"
$Browsers = if ($Browser -eq "All") { @("Chrome", "Edge") } else { @($Browser) }
$StartMenuPrograms = [Environment]::GetFolderPath('StartMenu') + "\Programs"
$ShortcutDir = Join-Path $StartMenuPrograms "Ablesci PDF Uploader"
$ShortcutPath = Join-Path $ShortcutDir "Ablesci PDF Uploader.lnk"
$MarkerPath = Join-Path $InstallDir ".ablesci_pdf_watcher_private.install.json"
$ManifestPath = Join-Path $InstallDir "$HostName.json"
$ExpectedFiles = @(
  "ablesci_pdf_helper.exe",
  "$HostName.json",
  "icon48.png",
  "icon.ico",
  ".ablesci_pdf_watcher_private.install.json"
)

function Remove-IfExists {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [switch]$Recurse
  )

  if (Test-Path $Path) {
    if ($Recurse) {
      Remove-Item -LiteralPath $Path -Recurse -Force
    } else {
      Remove-Item -LiteralPath $Path -Force
    }
    return $true
  }
  return $false
}

function Test-HelperInstallDir {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (!(Test-Path $Path)) {
    return [pscustomobject]@{
      ok = $false
      reason = "install_dir_not_found"
      knownFiles = @()
      extraFiles = @()
    }
  }

  $knownFiles = @()
  $extraFiles = @()
  $entries = Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  foreach ($entry in $entries) {
    if ($ExpectedFiles -contains $entry.Name) {
      $knownFiles += $entry
    } else {
      $extraFiles += $entry
    }
  }

  $markerOk = $false
  if (Test-Path $MarkerPath) {
    try {
      $marker = Get-Content -Raw $MarkerPath | ConvertFrom-Json
      $markerOk = ($marker.host_name -eq $HostName)
    } catch {
      $markerOk = $false
    }
  }

  $manifestOk = $false
  if (Test-Path $ManifestPath) {
    try {
      $manifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
      $manifestOk = ($manifest.name -eq $HostName)
    } catch {
      $manifestOk = $false
    }
  }

  return [pscustomobject]@{
    ok = ($markerOk -or $manifestOk)
    reason = if ($markerOk -or $manifestOk) { "matched" } else { "missing_plugin_marker" }
    knownFiles = $knownFiles
    extraFiles = $extraFiles
  }
}

foreach ($BrowserName in $Browsers) {
  if ($BrowserName -eq "Chrome") {
    $RegKey = "HKCU\Software\Google\Chrome\NativeMessagingHosts\$HostName"
  } else {
    $RegKey = "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\$HostName"
  }
  & reg.exe delete $RegKey /f 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Registry entry removed: $RegKey"
  } else {
    Write-Host "Registry entry not found: $RegKey"
  }
}

if (Remove-IfExists -Path $ShortcutPath) {
  Write-Host "Start Menu shortcut removed: $ShortcutPath"
  $remainingShortcutItems = @(Get-ChildItem -LiteralPath $ShortcutDir -Force -ErrorAction SilentlyContinue)
  if ($remainingShortcutItems.Count -eq 0) {
    Remove-IfExists -Path $ShortcutDir -Recurse | Out-Null
  }
} else {
  Write-Host "Start Menu shortcut not found: $ShortcutPath"
}

if ($RemoveFiles) {
  $check = Test-HelperInstallDir -Path $InstallDir
  if (!$check.ok) {
    Write-Warning "Refuse to delete install dir: $InstallDir"
    Write-Warning "Reason: $($check.reason). Use -OpenInstallDir to review manually."
  } else {
    foreach ($entry in $check.knownFiles) {
      if ($entry.PSIsContainer) {
        Remove-IfExists -Path $entry.FullName -Recurse | Out-Null
      } else {
        Remove-IfExists -Path $entry.FullName | Out-Null
      }
      Write-Host "Removed plugin file: $($entry.FullName)"
    }
    if ($check.extraFiles.Count -gt 0) {
      Write-Warning "Install dir contains extra files. Directory preserved:"
      $check.extraFiles | ForEach-Object { Write-Warning ("  " + $_.FullName) }
    } else {
      $remainingItems = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
      if ($remainingItems.Count -eq 0) {
        Remove-IfExists -Path $InstallDir -Recurse | Out-Null
        Write-Host "Install dir removed: $InstallDir"
      } else {
        Write-Warning "Install dir not empty after plugin file cleanup. Directory preserved: $InstallDir"
      }
    }
  }
} else {
  $check = Test-HelperInstallDir -Path $InstallDir
  if ($check.ok) {
    Write-Host "Install dir preserved: $InstallDir"
    if ($check.extraFiles.Count -gt 0) {
      Write-Host "Extra files present; script will not remove them automatically."
    }
  } else {
    Write-Host "Install dir preserved: $InstallDir"
  }
  Write-Host "Use -RemoveFiles to delete helper files, or -OpenInstallDir to review them manually."
}

if ($OpenInstallDir) {
  $OpenPath = if (Test-Path $InstallDir) { $InstallDir } else { Split-Path -Parent $InstallDir }
  if (Test-Path $OpenPath) {
    Start-Process explorer.exe -ArgumentList "`"$OpenPath`""
    Write-Host "Opened in Explorer: $OpenPath"
  } else {
    Write-Host "Open path not found: $OpenPath"
  }
}
