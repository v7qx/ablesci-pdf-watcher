param(
  [string]$ExtensionId = "",

  [ValidateSet("Chrome", "Edge", "All")]
  [string]$Browser = "Chrome",

  [string]$InstallDir = "$env:LOCALAPPDATA\AblesciPdfWatcher",

  [string]$ProfileDir = "",

  [string]$DownloadDir = "$env:USERPROFILE\Downloads",

  [string]$ExtensionDir = ""
)

$ErrorActionPreference = "Stop"

$HostName = "com.ablesci.pdf_watcher"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$PrebuiltExe = Join-Path $RepoRoot "native-helper\bin\windows-amd64\ablesci_pdf_helper.exe"
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

function Ensure-BrowserProfileDownloadPrefs([string]$UserDataDir, [string]$DownloadDir) {
  if ([string]::IsNullOrWhiteSpace($UserDataDir)) {
    return
  }
  $profileRoot = [System.IO.Path]::GetFullPath($UserDataDir)
  $downloadRoot = if ([string]::IsNullOrWhiteSpace($DownloadDir)) {
    Join-Path $profileRoot "Downloads"
  } else {
    [System.IO.Path]::GetFullPath($DownloadDir)
  }
  $defaultProfileDir = Join-Path $profileRoot "Default"
  $preferencesPath = Join-Path $defaultProfileDir "Preferences"
  $localStatePath = Join-Path $profileRoot "Local State"
  $firstRunPath = Join-Path $profileRoot "First Run"

  New-Item -ItemType Directory -Force -Path $defaultProfileDir | Out-Null
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

if (![string]::IsNullOrWhiteSpace($ProfileDir)) {
  Ensure-BrowserProfileDownloadPrefs $ProfileDir $DownloadDir
}

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
  if ($Browser -eq "All") {
    throw "Automatic ExtensionId detection is only supported for one browser at a time. Use -Browser Chrome or -Browser Edge, or pass -ExtensionId explicitly."
  }
  $extensionsPage = if ($Browser -eq "Edge") { "edge://extensions/" } else { "chrome://extensions/" }
  $detected = Find-ExtensionIdInPreferences $Browser $ProfileDir $ExtensionDir
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
    throw "未找到 Go，且仓库中没有预编译 Helper：$PrebuiltExe。请先准备 Go 环境或放入预编译 Helper，然后重新运行 native-host\build_helper.ps1 或 native-host\install_host.ps1。"
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
  description = "Ablesci PDF Watcher Native Helper"
  path = $TargetExe
  type = "stdio"
  allowed_origins = $AllowedOrigins
}

$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8

$MarkerPath = Join-Path $InstallDir $MarkerFileName
$Marker = [ordered]@{
  host_name = $HostName
  install_dir = $InstallDir
  helper_exe = [System.IO.Path]::GetFileName($TargetExe)
  manifest = [System.IO.Path]::GetFileName($ManifestPath)
  installed_at = (Get-Date).ToString("s")
}
$Marker | ConvertTo-Json -Depth 4 | Set-Content -Path $MarkerPath -Encoding UTF8

# Register Start Menu shortcut with AppUserModelID so Windows notification
# shows a stable app name. No custom icon is bound to avoid extra build assets.
$ShortcutCode = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class ShellLink {}

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellLinkW {
    void GetPath(StringBuilder sb, int cch, IntPtr pfd, uint fFlags);
    IntPtr GetIDList();
    void SetIDList(IntPtr pidl);
    void GetDescription(StringBuilder sb, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory(StringBuilder sb, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments(StringBuilder sb, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    ushort GetHotKey();
    void SetHotKey(ushort wHotKey);
    uint GetShowCmd();
    void SetShowCmd(uint iShowCmd);
    void GetIconLocation(StringBuilder sb, int cch, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
    void Resolve(IntPtr hwnd, uint fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, Guid("0000010B-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPersistFile {
    void GetCurFile([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile);
    [PreserveSig] int IsDirty();
    void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
    void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
    void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
    [PreserveSig] int GetCount(out uint cProps);
    [PreserveSig] int GetAt(uint iProp, out PROPERTYKEY pkey);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out IntPtr pv); // simplified
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    [PreserveSig] int Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
    public ushort vt;
    ushort wReserved1;
    ushort wReserved2;
    ushort wReserved3;
    public IntPtr ptrVal;
}

public static class ShortcutManager {
    public static void Create(string lnkPath, string targetPath, string iconPath, string appId) {
        var link = (IShellLinkW)new ShellLink();
        link.SetPath(targetPath);
        if (!string.IsNullOrEmpty(iconPath)) {
            link.SetIconLocation(iconPath, 0);
        }
        var store = (IPropertyStore)link;
        var key = new PROPERTYKEY {
            fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            pid = 5  // PKEY_AppUserModel_ID
        };
        var pv = new PROPVARIANT();
        pv.vt = 31;  // VT_LPWSTR
        pv.ptrVal = Marshal.StringToCoTaskMemUni(appId);
        store.SetValue(ref key, ref pv);
        store.Commit();
        Marshal.FreeCoTaskMem(pv.ptrVal);
        var file = (IPersistFile)link;
        var dir = System.IO.Path.GetDirectoryName(lnkPath);
        if (!System.IO.Directory.Exists(dir)) {
            System.IO.Directory.CreateDirectory(dir);
        }
        file.Save(lnkPath, true);
    }
}
'@

$AppIdForShortcut = "AblesciPDFWatcher"
$ShortcutName = "Ablesci PDF Watcher"
$StartMenuPrograms = [Environment]::GetFolderPath('StartMenu') + "\Programs"
$ShortcutDir = Join-Path $StartMenuPrograms "Ablesci PDF Watcher"
$ShortcutPath = Join-Path $ShortcutDir "$ShortcutName.lnk"

try {
  Add-Type -TypeDefinition $ShortcutCode -ReferencedAssemblies "System.Runtime.InteropServices"
  [ShortcutManager]::Create($ShortcutPath, $TargetExe, "", $AppIdForShortcut)
  Write-Host "Start Menu shortcut created: $ShortcutPath"
  Write-Host "  AppUserModelID = $AppIdForShortcut"
} catch {
  Write-Warning "Failed to create Start Menu shortcut: $_"
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
