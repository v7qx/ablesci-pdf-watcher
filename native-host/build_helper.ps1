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
if (Test-Path $Output) { Remove-Item -LiteralPath $Output -Force }

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
