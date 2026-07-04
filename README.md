# Ablesci PDF Watcher

[简体中文](README_zh.md)

Chrome / Edge extension plus a Go Native Messaging Helper for downloading, validating, and uploading full-text PDFs from Ablesci assist detail pages.

## Components

- `extension/`: browser extension UI, watcher logic, publisher-page parsing, and browser notifications.
- `native-helper/`: Go helper source for PDF validation, MD5/size calculation, constrained OSS upload, local reports, and optional cleanup.
- `native-host/`: build, install, and uninstall scripts.

## Quick Install

### 1. Load the Extension

A dedicated Chrome / Edge profile is recommended so PDF download settings do not affect your daily browser.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Chrome -Launch
```

Open `chrome://extensions/`, enable Developer mode, and load the repository `extension/` directory.

Check these browser settings:

- Turn off “Ask where to save each file before downloading”.
- Configure PDFs to download directly instead of opening in the browser viewer.

### 2. Prepare Native Helper

For ordinary users, download `ablesci-pdf-helper-windows.zip` from GitHub Releases and extract `ablesci_pdf_helper.exe` to:

```text
native-host\dist\ablesci_pdf_helper.exe
```

You can also build it from source:

```powershell
.\native-host\build_helper.ps1 -TargetOS windows -TargetArch amd64
```

### 3. Register Native Host

Dedicated Chrome profile:

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile_Chrome"
```

Existing Chrome profile example:

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ProfileDir "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 4"
```

If extension ID detection fails, pass it explicitly:

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ExtensionId <extension_id>
```

## Verify

Open the extension options page:

- Click “Test Alert” to verify browser notifications.
- Click “Test”; `OK: pong` means Native Helper registration works.

Helper file checks:

```powershell
Get-FileHash .\native-host\dist\ablesci_pdf_helper.exe -Algorithm SHA256
Get-AuthenticodeSignature .\native-host\dist\ablesci_pdf_helper.exe
```

## Optional: Validate PDF Title Before Upload

This feature is off by default and can be enabled under More Settings. It requires Poppler's `pdftotext.exe` and `pdfinfo.exe`; `build_helper.ps1` does not install them.

Download the pinned [Poppler 24.08.0 Windows runtime](https://github.com/oschwartz10612/poppler-windows/releases/download/v24.08.0-0/Release-24.08.0-0.zip) (SHA256: `58A6F9AE269756231D2F9AA6CBA39D75FEC6DEACAF3C4A50683383B5F3D5A527`) and extract the complete archive under:

```text
%LOCALAPPDATA%\AblesciPdfWatcher\tools\poppler\poppler-24.08.0\
```

Keep the adjacent DLLs and license files instead of copying only the EXEs. When title validation is disabled, Poppler is neither located nor invoked.

## Security Notes

The Native Helper:

- does not stay resident;
- does not listen on ports;
- does not read browser cookies or history;
- does not scan user disks;
- only handles PDFs in allowed directories;
- re-checks path and `%PDF-` header before deletion;
- restricts uploads to expected HTTPS Aliyun OSS public endpoints;
- no longer implements Windows Toast notifications through PowerShell; alerts use browser notification cards.

Windows Defender / SmartScreen may still flag Go binaries that handle files and perform constrained uploads, especially locally built binaries with fresh hashes. Prefer GitHub Actions release artifacts. Do not disable Defender or add broad global exclusions; submit confirmed false positives to Microsoft Security Intelligence Portal with the release file and SHA256.

## Uninstall

Remove the browser extension, then unregister Native Helper:

```powershell
.\native-host\uninstall_host.ps1
```

Open the helper install directory for manual cleanup:

```powershell
.\native-host\uninstall_host.ps1 -OpenInstallDir
```

Remove known helper files automatically:

```powershell
.\native-host\uninstall_host.ps1 -RemoveFiles
```

## Disclaimer

This project is a community-maintained browser utility and is not affiliated with Ablesci, publishers, or institutions. Users are responsible for account status, institutional access, copyright, website terms, and local regulations.
