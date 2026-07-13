param(
  [string]$TargetOS = "windows",
  [string]$TargetArch = "amd64",
  [string]$Output = "",
  [string]$Version = "",
  [switch]$SkipVersionInfo
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$HelperDir = Join-Path $RepoRoot "native-helper"
$DistDir = Join-Path $ScriptDir "dist"

function Get-GitValue([string[]]$Args, [string]$Fallback = "") {
  if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    return $Fallback
  }
  try {
    $value = & git @Args 2>$null
    if ($LASTEXITCODE -eq 0 -and ![string]::IsNullOrWhiteSpace($value)) {
      return [string]$value
    }
  } catch {
    return $Fallback
  }
  return $Fallback
}

function Resolve-VersionString([string]$RequestedVersion) {
  if (![string]::IsNullOrWhiteSpace($RequestedVersion)) {
    return $RequestedVersion.TrimStart("v")
  }
  $tag = Get-GitValue -Args @("describe", "--tags", "--abbrev=0") -Fallback ""
  if (![string]::IsNullOrWhiteSpace($tag)) {
    return $tag.TrimStart("v")
  }
  return "0.0.0"
}

function Convert-ToVersionParts([string]$Value) {
  $parts = @($Value -split '[^0-9]+' | Where-Object { $_ -ne "" } | Select-Object -First 4)
  while ($parts.Count -lt 4) {
    $parts += "0"
  }
  return @($parts | ForEach-Object {
    $n = 0
    if ([int]::TryParse($_, [ref]$n)) { [Math]::Max(0, [Math]::Min(65535, $n)) } else { 0 }
  })
}

function New-VersionInfoJson([string]$Path, [string]$VersionText, [string]$Commit) {
  $parts = Convert-ToVersionParts $VersionText
  $fileVersion = "$($parts[0]).$($parts[1]).$($parts[2]).$($parts[3])"
  $manifestPath = (Join-Path $HelperDir "helper.exe.manifest").Replace("\", "\\")
  $comments = if ($Commit) { "Built from commit $Commit" } else { "Built from source" }
  $json = @{
    FixedFileInfo = @{
      FileVersion = @{ Major = $parts[0]; Minor = $parts[1]; Patch = $parts[2]; Build = $parts[3] }
      ProductVersion = @{ Major = $parts[0]; Minor = $parts[1]; Patch = $parts[2]; Build = $parts[3] }
      FileFlagsMask = "3f"
      FileFlags = "00"
      FileOS = "040004"
      FileType = "01"
      FileSubType = "00"
    }
    StringFileInfo = @{
      Comments = $comments
      CompanyName = "v7qx"
      FileDescription = "Native Messaging Helper for Ablesci PDF Watcher"
      FileVersion = $fileVersion
      InternalName = "ablesci_pdf_helper"
      LegalCopyright = "Copyright (c) v7qx"
      OriginalFilename = "ablesci_pdf_helper.exe"
      ProductName = "Ablesci PDF Watcher Native Helper"
      ProductVersion = $VersionText
    }
    VarFileInfo = @{
      Translation = @{
        LangID = "0409"
        CharsetID = "04B0"
      }
    }
    ManifestPath = $manifestPath
  } | ConvertTo-Json -Depth 10
  Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

if ($Output -eq "") {
  $ExeName = "ablesci_pdf_helper"
  if ($TargetOS -eq "windows") {
    $ExeName = "$ExeName.exe"
  }
  $Output = Join-Path $DistDir $ExeName
}
$Output = [System.IO.Path]::GetFullPath($Output)

if (!(Get-Command go -ErrorAction SilentlyContinue)) {
  throw "未找到 Go 编译器，无法从源码构建 Helper。请先准备 Go 开发环境后重新运行本脚本。"
}

$OutDir = Split-Path -Parent $Output
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
if (Test-Path -LiteralPath $Output) {
  try {
    Remove-Item -LiteralPath $Output -Force -ErrorAction Stop
  } catch {
    $runningHelper = @(Get-Process -Name "ablesci_pdf_helper" -ErrorAction SilentlyContinue)
    $processHint = "未检测到同名 Helper 进程；也可能是杀毒软件、索引程序或文件权限暂时阻止了删除。"
    if ($runningHelper.Count -gt 0) {
      $processIds = ($runningHelper | ForEach-Object { $_.Id }) -join ", "
      $processHint = "检测到正在运行的 ablesci_pdf_helper 进程，PID：$processIds。"
    }

    $outputBase = [System.IO.Path]::GetFileNameWithoutExtension($Output)
    $outputExtension = [System.IO.Path]::GetExtension($Output)
    $alternateOutput = Join-Path $OutDir "$outputBase.next$outputExtension"
    $message = @(
      "无法覆盖已有 Helper：$Output",
      "该文件可能正在被 Chrome/Edge Native Messaging、手动启动的 Helper 或安全软件占用，也可能缺少当前目录的修改权限。",
      $processHint,
      "",
      "请依次尝试：",
      "1. 关闭使用该扩展的 Chrome/Edge 窗口。",
      "2. 查看占用进程：Get-CimInstance Win32_Process | Where-Object Name -eq 'ablesci_pdf_helper.exe' | Select-Object ProcessId, ExecutablePath, CommandLine",
      "3. 确认可以结束后执行：Get-Process ablesci_pdf_helper -ErrorAction SilentlyContinue | Stop-Process -Force",
      "4. 重新运行本构建命令。",
      "",
      "如需保留旧文件，可先编译到备用路径：",
      "& `"$PSCommandPath`" -TargetOS $TargetOS -TargetArch $TargetArch -Output `"$alternateOutput`"",
      "",
      "原始错误：$($_.Exception.Message)"
    ) -join [Environment]::NewLine
    throw $message
  }
}

$VersionText = Resolve-VersionString $Version
$Commit = Get-GitValue -Args @("rev-parse", "--short=12", "HEAD") -Fallback ""
$GeneratedVersionInfo = Join-Path $HelperDir "versioninfo.json"
$GeneratedSyso = Join-Path $HelperDir "resource_windows.syso"

Push-Location $HelperDir
try {
  if ($TargetOS -eq "windows" -and !$SkipVersionInfo) {
    if (Test-Path $GeneratedVersionInfo) { Remove-Item -LiteralPath $GeneratedVersionInfo -Force }
    if (Test-Path $GeneratedSyso) { Remove-Item -LiteralPath $GeneratedSyso -Force }
    New-VersionInfoJson $GeneratedVersionInfo $VersionText $Commit
    go run github.com/josephspurrier/goversioninfo/cmd/goversioninfo@v1.4.0 -64 -o resource_windows.syso
  }

  $env:GOOS = $TargetOS
  $env:GOARCH = $TargetArch
  $env:CGO_ENABLED = "0"

  go build -trimpath -ldflags "-s -w -buildid=" -o $Output .

  $hash = Get-FileHash -LiteralPath $Output -Algorithm SHA256
  $shaPath = Join-Path $OutDir "SHA256SUMS.txt"
  "$($hash.Hash.ToLowerInvariant())  $([System.IO.Path]::GetFileName($Output))" | Set-Content -LiteralPath $shaPath -Encoding ASCII

  Write-Host "Built: $Output"
  Write-Host "SHA256: $($hash.Hash.ToLowerInvariant())"
  Write-Host "SHA256SUMS: $shaPath"
} finally {
  if (Test-Path $GeneratedVersionInfo) { Remove-Item -LiteralPath $GeneratedVersionInfo -Force }
  if (Test-Path $GeneratedSyso) { Remove-Item -LiteralPath $GeneratedSyso -Force }
  Pop-Location
}
