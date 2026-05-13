param(
  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "All",

  [string]$InstallDir = "$env:LOCALAPPDATA\AblesciPdfUploader",

  [switch]$RemoveFiles
)

$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$HostName = "com.ablesci.pdf_uploader"
$Browsers = if ($Browser -eq "All") { @("Chrome", "Edge") } else { @($Browser) }

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

if ($RemoveFiles -and (Test-Path $InstallDir)) {
  Remove-Item -Path $InstallDir -Recurse -Force
  Write-Host "Install dir removed: $InstallDir"
}
