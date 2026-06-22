param(
  [string]$ExtensionId = "",

  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "Chrome",

  [string]$InstallDir = "$env:LOCALAPPDATA\AblesciPdfWatcher",

  [string]$ProfileDir = "",

  [string]$DownloadDir = "",

  [string]$ExtensionDir = ""
)

$ErrorActionPreference = "Stop"

$HostName = "com.ablesci.pdf_watcher"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$PrebuiltExe = Join-Path $RepoRoot "native-host\dist\ablesci_pdf_helper.exe"
$SourceGoDir = Join-Path $RepoRoot "native-helper"
$MarkerFileName = ".ablesci_pdf_watcher.install.json"
if ([string]::IsNullOrWhiteSpace($ExtensionDir)) {
  $ExtensionDir = Join-Path $RepoRoot "extension"
}
$ExtensionDir = [System.IO.Path]::GetFullPath($ExtensionDir)

function Get-DefaultUserDataDir([string]$BrowserName) {
  if ($BrowserName -eq "Edge") {
    return "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
  }
  return "$env:LOCALAPPDATA\Google\Chrome\User Data"
}

function Test-BrowserProfileDir([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $name = Split-Path -Leaf ([System.IO.Path]::GetFullPath($Path).TrimEnd('\'))
  if ($name -eq "Default" -or $name -like "Profile *") { return $true }
  if (Test-Path -LiteralPath (Join-Path $Path "Preferences")) { return $true }
  return $false
}

function Resolve-BrowserProfileSelection([string]$BrowserName, [string]$ProfilePath) {
  if ([string]::IsNullOrWhiteSpace($ProfilePath)) {
    $root = [System.IO.Path]::GetFullPath((Get-DefaultUserDataDir $BrowserName))
    return [pscustomobject]@{
      UserDataDir = $root
      ProfileDir = ""
      ExplicitProfileDir = $false
    }
  }
  $full = [System.IO.Path]::GetFullPath($ProfilePath)
  if (Test-BrowserProfileDir $full) {
    return [pscustomobject]@{
      UserDataDir = [System.IO.Path]::GetFullPath((Split-Path -Parent $full))
      ProfileDir = $full
      ExplicitProfileDir = $true
    }
  }
  return [pscustomobject]@{
    UserDataDir = $full
    ProfileDir = [System.IO.Path]::GetFullPath((Join-Path $full "Default"))
    ExplicitProfileDir = $true
  }
}

function Get-PreferencePaths([string]$BrowserName, [string]$UserDataDir) {
  $paths = @()
  if (![string]::IsNullOrWhiteSpace($UserDataDir)) {
    $root = [System.IO.Path]::GetFullPath($UserDataDir)
    $paths += Join-Path $root "Default\Preferences"
    $paths += Join-Path $root "Default\Secure Preferences"
    if (Test-Path -LiteralPath $root) {
      Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "Profile *" } |
        ForEach-Object {
          $paths += Join-Path $_.FullName "Preferences"
          $paths += Join-Path $_.FullName "Secure Preferences"
        }
    }
  } else {
    $paths += Get-PreferencePaths $BrowserName (Get-DefaultUserDataDir $BrowserName)
  }
  return $paths | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
}

function Test-SamePath([string]$A, [string]$B) {
  if ([string]::IsNullOrWhiteSpace($A) -or [string]::IsNullOrWhiteSpace($B)) { return $false }
  try {
    $pa = [System.IO.Path]::GetFullPath($A).TrimEnd('\')
    $pb = [System.IO.Path]::GetFullPath($B).TrimEnd('\')
    return [string]::Equals($pa, $pb, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Find-ExtensionIdInPreferences([string]$BrowserName, [string]$UserDataDir, [string]$TargetExtensionDir) {
  $matches = @()
  foreach ($prefPath in (Get-PreferencePaths $BrowserName $UserDataDir)) {
    try {
      $prefs = Get-Content -LiteralPath $prefPath -Raw | ConvertFrom-Json
      $settings = $prefs.extensions.settings
      if ($null -eq $settings) { continue }
      foreach ($entry in $settings.PSObject.Properties) {
        $id = $entry.Name
        $value = $entry.Value
        $path = if ($null -ne $value.path) { [string]$value.path } else { "" }
        $manifestName = if ($null -ne $value.manifest -and $null -ne $value.manifest.name) { [string]$value.manifest.name } else { "" }
        $manifestDesc = if ($null -ne $value.manifest -and $null -ne $value.manifest.description) { [string]$value.manifest.description } else { "" }
        $pathMatched = Test-SamePath $path $TargetExtensionDir
        $nameMatched = $manifestName -like "Ablesci PDF Watcher*"
        $descMatched = $manifestDesc -like "*Ablesci PDF*"
        if ($pathMatched -or $nameMatched -or $descMatched) {
          $matches += [pscustomobject]@{
            Id = $id
            PreferencePath = $prefPath
            ExtensionPath = $path
            ManifestName = $manifestName
            ExactPath = $pathMatched
          }
        }
      }
    } catch {
      Write-Warning "Could not inspect browser preferences: $prefPath"
    }
  }
  $exact = @($matches | Where-Object { $_.ExactPath })
  if ($exact.Count -eq 1) { return $exact[0] }
  if ($matches.Count -eq 1) { return $matches[0] }
  if ($exact.Count -gt 1) {
    throw "Multiple matching extensions were found by path. Pass -ExtensionId explicitly."
  }
  if ($matches.Count -gt 1) {
    throw "Multiple Ablesci PDF Watcher extensions were found. Pass -ExtensionId explicitly."
  }
  return $null
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

function Get-BrowserProfileDownloadDir([string]$ConcreteProfileDir) {
  if ([string]::IsNullOrWhiteSpace($ConcreteProfileDir)) {
    return ""
  }
  $preferencesPath = Join-Path ([System.IO.Path]::GetFullPath($ConcreteProfileDir)) "Preferences"
  if (!(Test-Path -LiteralPath $preferencesPath)) {
    return ""
  }
  try {
    $prefs = Get-Content -LiteralPath $preferencesPath -Raw | ConvertFrom-Json
    if ($null -ne $prefs.download -and $null -ne $prefs.download.default_directory) {
      $dir = [string]$prefs.download.default_directory
      if (![string]::IsNullOrWhiteSpace($dir)) {
        return [System.IO.Path]::GetFullPath($dir)
      }
    }
  } catch {
    Write-Warning "Could not read profile download directory: $preferencesPath"
  }
  return ""
}

function Ensure-BrowserProfileDownloadPrefs([string]$ConcreteProfileDir, [string]$DownloadDir) {
  if ([string]::IsNullOrWhiteSpace($ConcreteProfileDir)) {
    return
  }
  $profileRoot = [System.IO.Path]::GetFullPath($ConcreteProfileDir)
  $userDataRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $profileRoot))
  $downloadRoot = if ([string]::IsNullOrWhiteSpace($DownloadDir)) {
    Join-Path $profileRoot "Downloads"
  } else {
    [System.IO.Path]::GetFullPath($DownloadDir)
  }
  $preferencesPath = Join-Path $profileRoot "Preferences"
  $localStatePath = Join-Path $userDataRoot "Local State"
  $firstRunPath = Join-Path $userDataRoot "First Run"

  New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
  if (!(Test-Path -LiteralPath $firstRunPath)) {
    New-Item -ItemType File -Force -Path $firstRunPath | Out-Null
  }

  $localState = Read-JsonObject $localStatePath
  $browserState = Ensure-ObjectProperty $localState "browser"
  Set-ObjectProperty $browserState "has_seen_welcome_page" $true
  $localState | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $localStatePath -Encoding UTF8

  $prefs = Read-JsonObject $preferencesPath
  $download = Ensure-ObjectProperty $prefs "download"
  Set-ObjectProperty $download "default_directory" $downloadRoot
  Set-ObjectProperty $download "directory_upgrade" $true
  Set-ObjectProperty $download "prompt_for_download" $false

  $downloadBubble = Ensure-ObjectProperty $prefs "download_bubble"
  Set-ObjectProperty $downloadBubble "partial_view_enabled" $false

  $plugins = Ensure-ObjectProperty $prefs "plugins"
  Set-ObjectProperty $plugins "always_open_pdf_externally" $true

  $browserPrefs = Ensure-ObjectProperty $prefs "browser"
  Set-ObjectProperty $browserPrefs "has_seen_welcome_page" $true

  $profile = Ensure-ObjectProperty $prefs "profile"
  Set-ObjectProperty $profile "exited_cleanly" $true
  Set-ObjectProperty $profile "exit_type" "Normal"
  $contentSettings = Ensure-ObjectProperty $profile "default_content_setting_values"
  Set-ObjectProperty $contentSettings "automatic_downloads" 1

  $prefs | ConvertTo-Json -Depth 64 | Set-Content -LiteralPath $preferencesPath -Encoding UTF8

  Write-Host "Browser profile preferences ensured:"
  Write-Host "  Profile dir : $profileRoot"
  Write-Host "  Download dir: $downloadRoot"
  Write-Host "  PDF direct  : enabled"
}

$ProfileInfo = if ($Browser -eq "All") {
  [pscustomobject]@{ UserDataDir = ""; ProfileDir = ""; ExplicitProfileDir = $false }
} else {
  Resolve-BrowserProfileSelection $Browser $ProfileDir
}
$DownloadDirWasExplicit = ![string]::IsNullOrWhiteSpace($DownloadDir)
$ResolvedDownloadDir = ""

if ($ProfileInfo.ExplicitProfileDir) {
  if ($DownloadDirWasExplicit) {
    $ResolvedDownloadDir = [System.IO.Path]::GetFullPath($DownloadDir)
    Ensure-BrowserProfileDownloadPrefs $ProfileInfo.ProfileDir $ResolvedDownloadDir
  } else {
    $ResolvedDownloadDir = Get-BrowserProfileDownloadDir $ProfileInfo.ProfileDir
    if ([string]::IsNullOrWhiteSpace($ResolvedDownloadDir)) {
      Write-Warning "No download.default_directory was found in this profile. Default Downloads and TEMP are still allowed; pass -DownloadDir to whitelist a custom directory."
    } else {
      Write-Host "Detected profile download directory: $ResolvedDownloadDir"
    }
  }
} elseif ($DownloadDirWasExplicit) {
  $ResolvedDownloadDir = [System.IO.Path]::GetFullPath($DownloadDir)
}

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
  if ($Browser -eq "All") {
    throw "Automatic ExtensionId detection is only supported for one browser at a time. Use -Browser Chrome or -Browser Edge, or pass -ExtensionId explicitly."
  }
  $extensionsPage = if ($Browser -eq "Edge") { "edge://extensions/" } else { "chrome://extensions/" }
  $detected = Find-ExtensionIdInPreferences $Browser $ProfileInfo.UserDataDir $ExtensionDir
  if ($null -eq $detected) {
    $profileHint = if ([string]::IsNullOrWhiteSpace($ProfileDir)) { "(未指定，正在检查默认浏览器 Profile)" } else { [System.IO.Path]::GetFullPath($ProfileDir) }
    $hint = @(
      "无法自动识别扩展 ID。",
      "",
      "这通常不是 Helper 是否预编译的问题，而是安装脚本没有在指定浏览器 Profile 中找到已加载的扩展。",
      "",
      "请按顺序确认：",
      "1. 已用专用浏览器 Profile 打开 $extensionsPage",
      "2. 已开启开发者模式，并加载本仓库的 extension 目录",
      "3. 加载后关闭专用浏览器，让 Chrome / Edge 写入 Profile 配置",
      "4. 重新运行本脚本",
      "",
      "如果仍失败，请在扩展管理页复制扩展 ID 后显式传入：",
      ".\native-host\install_host.ps1 -Browser $Browser -ExtensionId <扩展ID>",
      "",
      "当前检查的 Profile：",
      $profileHint,
      "",
      "当前期望的扩展目录：",
      $ExtensionDir
    ) -join [Environment]::NewLine
    throw $hint
  }
  $ExtensionId = $detected.Id
  Write-Host "Detected extension ID: $ExtensionId"
  Write-Host "  Preferences : $($detected.PreferencePath)"
  if ($detected.ExtensionPath) {
    Write-Host "  Extension   : $($detected.ExtensionPath)"
  }
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  throw "ExtensionId looks invalid: $ExtensionId"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$TargetExe = Join-Path $InstallDir "ablesci_pdf_helper.exe"
$TargetExe = [System.IO.Path]::GetFullPath($TargetExe)

if (Test-Path $PrebuiltExe) {
  Copy-Item $PrebuiltExe $TargetExe -Force
} else {
  if (!(Get-Command go -ErrorAction SilentlyContinue)) {
    throw "未找到 Go，且仓库中没有预编译 Helper：$PrebuiltExe。请先准备 Go 环境或下载 GitHub Release 构建产物，然后重新运行 native-host\build_helper.ps1 或 native-host\install_host.ps1。"
  }
  Push-Location $SourceGoDir
  try {
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    $env:CGO_ENABLED = "0"
    go build -trimpath -ldflags "-s -w -buildid=" -o $TargetExe .
  } finally {
    Pop-Location
  }
}

$ManifestPath = Join-Path $InstallDir "$HostName.json"
$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
$AllowedOrigin = "chrome-extension://$ExtensionId/"
# Overwrite allowed_origins with only the current extension Origin instead of
# merge-accumulating. Merging kept stale extension IDs registered forever across
# reinstalls; a single Origin is the least-privilege default. Warn if we drop any.
$PreviousOrigins = @()
if (Test-Path $ManifestPath) {
  try {
    $ExistingManifest = Get-Content -Raw $ManifestPath | ConvertFrom-Json
    if ($ExistingManifest.allowed_origins) {
      $PreviousOrigins = @($ExistingManifest.allowed_origins)
    }
  } catch {
    $PreviousOrigins = @()
  }
}
$DroppedOrigins = @($PreviousOrigins | Where-Object { $_ -and ($_ -ne $AllowedOrigin) })
if ($DroppedOrigins.Count -gt 0) {
  Write-Warning "Replacing previously registered allowed_origins with the current extension only. Dropped: $($DroppedOrigins -join ', ')"
}
$AllowedOrigins = @($AllowedOrigin)

$manifest = [ordered]@{
  name = $HostName
  description = "Ablesci PDF Watcher Native Helper"
  path = $TargetExe
  type = "stdio"
  allowed_origins = $AllowedOrigins
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

$MarkerPath = Join-Path $InstallDir $MarkerFileName
$ExistingMarker = Read-JsonObject $MarkerPath
$ExistingLegacyDownloadDir = if ($null -ne $ExistingMarker.download_dir) { [string]$ExistingMarker.download_dir } else { "" }
$LegacyDownloadDir = $ExistingLegacyDownloadDir
if ([string]::IsNullOrWhiteSpace($LegacyDownloadDir) -and !$ProfileInfo.ExplicitProfileDir -and ![string]::IsNullOrWhiteSpace($ResolvedDownloadDir)) {
  $LegacyDownloadDir = $ResolvedDownloadDir
}

$Profiles = @()
if ($null -ne $ExistingMarker.profiles) {
  foreach ($profile in @($ExistingMarker.profiles)) {
    $profileBrowser = if ($null -ne $profile.browser) { [string]$profile.browser } else { "" }
    $profileDir = if ($null -ne $profile.profile_dir) { [string]$profile.profile_dir } else { "" }
    $profileDownloadDir = if ($null -ne $profile.download_dir) { [string]$profile.download_dir } else { "" }
    if ([string]::IsNullOrWhiteSpace($profileDir) -or [string]::IsNullOrWhiteSpace($profileDownloadDir)) {
      continue
    }
    $sameProfile = $false
    if ($ProfileInfo.ExplicitProfileDir -and [string]::Equals($profileBrowser, $Browser, [System.StringComparison]::OrdinalIgnoreCase)) {
      $sameProfile = Test-SamePath $profileDir $ProfileInfo.ProfileDir
    }
    if (!$sameProfile) {
      $Profiles += [ordered]@{
        browser = $profileBrowser
        profile_dir = [System.IO.Path]::GetFullPath($profileDir)
        download_dir = [System.IO.Path]::GetFullPath($profileDownloadDir)
        updated_at = if ($null -ne $profile.updated_at) { [string]$profile.updated_at } else { "" }
      }
    }
  }
}
if ($ProfileInfo.ExplicitProfileDir -and ![string]::IsNullOrWhiteSpace($ResolvedDownloadDir)) {
  $Profiles += [ordered]@{
    browser = $Browser
    profile_dir = $ProfileInfo.ProfileDir
    download_dir = $ResolvedDownloadDir
    updated_at = (Get-Date).ToString("s")
  }
}

$Marker = [ordered]@{
  host_name = $HostName
  install_dir = $InstallDir
  helper_exe = [System.IO.Path]::GetFileName($TargetExe)
  manifest = [System.IO.Path]::GetFileName($ManifestPath)
  download_dir = $LegacyDownloadDir
  profiles = $Profiles
  installed_at = (Get-Date).ToString("s")
}
$Marker | ConvertTo-Json -Depth 6 | Set-Content -Path $MarkerPath -Encoding UTF8

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
if (![string]::IsNullOrWhiteSpace($LegacyDownloadDir)) {
  Write-Host "Legacy allowed download dir: $LegacyDownloadDir"
}
if ($Profiles.Count -gt 0) {
  Write-Host "Profile allowed download dirs:"
  foreach ($profile in $Profiles) {
    Write-Host "  [$($profile.browser)] $($profile.profile_dir) -> $($profile.download_dir)"
  }
}
Write-Host "You can now click Test Native Helper in the extension options page."
