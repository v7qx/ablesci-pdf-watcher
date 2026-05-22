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

if (Remove-IfExists -Path $ShortcutDir -Recurse) {
  Write-Host "Start Menu shortcut removed: $ShortcutDir"
} else {
  Write-Host "Start Menu shortcut not found: $ShortcutDir"
}

if ($RemoveFiles) {
  if (Remove-IfExists -Path $InstallDir -Recurse) {
    Write-Host "Install dir removed: $InstallDir"
  } else {
    Write-Host "Install dir not found: $InstallDir"
  }
} else {
  Write-Host "Install dir preserved: $InstallDir"
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
