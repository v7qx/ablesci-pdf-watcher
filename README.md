# Ablesci PDF Watcher

[简体中文](README_zh.md)

Chrome / Edge Extension + Go Native Messaging Helper to assist with PDF downloading, validation, and uploading on the Ablesci help detail page.

## Installation and Configuration

This project consists of two parts: the **Browser Extension** and the **Native Helper**:

- **Browser Extension**: Provides the UI, options configuration, assist buttons, and status alerts.
- **Native Helper**: A local process required for automated uploading, PDF file header verification, MD5/file size calculation, and local logging.

Follow these steps for configuration and installation:

### I. Install & Configure Browser Extension

#### 1. Prepare a Dedicated Browser Profile (Recommended)

To prevent interference with your daily browser's PDF view and download settings, it is recommended to create a dedicated profile. Run the initialization script to automatically generate a dedicated profile and its desktop shortcut:

**Chrome**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Chrome -Launch
```

**Edge**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Edge -Launch
```

#### 2. Load the Browser Extension

1. Open the dedicated browser profile created above, and visit `chrome://extensions/` (or `edge://extensions/`).
2. Turn on **Developer mode** at the top right.
3. Click **Load unpacked**.
4. Select the `extension` folder of this repository.

#### 3. Verify PDF Download & On-Device AI settings

To ensure the download mechanism works properly and save disk space, please check:

- **Auto PDF Downloads**: Turn off "Ask where to save each file before downloading" and configure PDFs to "Download PDF files" (instead of previewing in browser built-in reader).
  - Chrome settings path: `chrome://settings/downloads` and `chrome://settings/content/pdfDocuments`
  - Edge settings path: `edge://settings/downloads` and `edge://settings/content/pdfDocuments` (*Note: You must set your default PDF viewer to a non-Edge application in Windows settings, otherwise Edge may force-open PDFs without triggering downloads.*)
- **Disable Chrome On-Device AI Model Downloads**:
  Chrome automatically downloads a generative AI model (approx. 4GB) in the background. Use one of these two recommended methods to disable it:

  **Method 1: Manage On-device AI Model in settings**
  1. Open Chrome.
  2. In the top right, select More (three dots) -> Settings -> System.
  3. Toggle off "On-device AI".
  (For details, refer to Google support documentation: [Manage on-device generative AI models](https://support.google.com/chrome/answer/16961953))

  **Method 2: Configure Chrome Flags (Per Profile)**
  1. Type `chrome://flags` in address bar.
  2. Search for `optimization-guide-on-device-model`.
  3. Change its status from `Default` to **`Disabled`**.

---

### II. Compile & Install Native Helper

#### 1. Compile Executable

Compilation requires a Go development environment. Run the build script in the root directory:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\build_helper.ps1 -TargetOS windows -TargetArch amd64
```

If you are only using the extension on Windows, compiling the Windows version of the helper is sufficient. Other platforms can adjust `-TargetOS` and `-TargetArch` as needed.

#### 2. Register Native Host

Run the installation script to register the Native Host. The script automatically detects the extension ID from the dedicated browser profile and completes registration:

**Chrome**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -Browser Chrome -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile_Chrome"
```

**Edge**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -Browser Edge -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile_Edge"
```

If auto-detection fails, manually specify the extension ID:

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ExtensionId <your_extension_id>
```

---

### III. Verification and Testing

1. Open the browser extension's options page.
2. Click **Test Alert** to verify browser desktop notifications.
3. Click **Test** to check the Native Helper. If it displays `OK: pong` (or `正常: pong`), the communication path is working.

*If you see `Error when communicating with the native messaging host`, check if the registry entries were imported, if the extension ID matches the registered host manifest, or if the executable startup was blocked by your OS. The web UI buttons will still work, but local auto-upload and local logs will be unavailable.*

## PDF Download & Validation Logic

- **Link Extraction**: Direct PDF links on the detail page are preferred. For publishers like ScienceDirect and Nature, the extension parses and fetches the native PDF entry point.
- **Verification**: The extension listens to browser download completion events, captures the downloaded file, and forwards it to the Native Helper. The Helper verifies the file header (`%PDF-`) and calculates MD5/file size.
- **Block on Anomalies**: If the downloaded file is HTML, a login wall, Cloudflare challenge, or error page, the process stops immediately and does not upload.
- **Safety Filters**: If blacklisted journals, supplement remarks, rejected/reported assists, or files exceeding size limits are detected, the extension will only download and verify the PDF, skipping auto-upload.
- **Sequential Queue**: Tasks are processed sequentially; only one PDF is downloaded and verified at a time.
- **Cloud Storage Domain Validation**: Native Helper validates target upload storage URLs to ensure they belong to expected domains. If domain or interface formats change, it halts to prevent leaks to untrusted addresses.

---

## Important Considerations & File Cleanup

- **Prevent Mis-uploads**: The extension listens to the browser's downloads API. During queueing or downloading, do not manually download other PDF files in the same browser profile to prevent accidental uploads.
- **File Preservation**: Local files are kept by default. If "Delete PDF After Upload" is enabled, the helper deletes the local PDF only after a successful upload and file header verification. Failed downloads or skipped tasks are kept.

---

## Native Helper Design

- **Lightweight & Stateless**: `ablesci_pdf_helper.exe` uses the Chrome Native Messaging protocol. It is launched by the browser only when a request is made, and exits immediately after. It does not run in the background, listen on any network ports, or consume background system resources.
- **Responsibilities**:
  1. Communication response (`ping/pong` check);
  2. PDF file header (`%PDF-`) verification;
  3. MD5 and file size calculations;
  4. Uploading verified PDFs to Cloud Object Storage (OSS);
  5. Automatic cleanup of uploaded files based on config;
  6. Writing local reports and troubleshooting traces.

## Icon Regeneration

The default source file is `extension/icons/source.svg`. If you update SVG colors or shapes, you can regenerate PNG assets:

```powershell
python .\scripts\build_icons.py
```

This generates `icon16.png`, `icon32.png`, `icon48.png`, `icon64.png`, `icon128.png`, `icon256.png`, and `icon.ico`. The built-in renderer supports simple SVG features only.

Click "Reload" in the browser extensions page to apply. If cached, restart the dedicated browser profile.

To use your own PNG icons, place them in `extension/icons/` and run:

```powershell
python .\scripts\build_icons.py --ico-only
```

This will inspect sizes and build the `icon.ico` without scaling.

---

## Uninstallation

Both components must be uninstalled separately:

### 1. Remove Browser Extension

Simply remove the extension from Chrome/Edge extensions settings.

### 2. Uninstall Native Helper

Clear the registry entries and files:

- **Step 1: Unregister Native Messaging**:
  Run the script in the root directory via PowerShell:

  ```powershell
  .\native-host\uninstall_host.ps1
  ```

- **Step 2: Clean Files**:
  - **Manual deletion (Recommended)**: Run:

    ```powershell
    .\native-host\uninstall_host.ps1 -OpenInstallDir
    ```

    And manually delete the `AblesciPdfWatcher` directory.

  - **Automatic deletion (Optional)**: Run:

    ```powershell
    .\native-host\uninstall_host.ps1 -RemoveFiles
    ```

---

## Disclaimer & Limitations

This project is a community-maintained browser utility and is not affiliated with Ablesci or any publisher platforms. Users must ensure compliance with account terms, subscription access, copyright rules, and local regulations.

The extension works only within limits allowed by browsers and target websites, and does not guarantee long-term availability for all publisher pages. Changes in page layouts, authentication, captcha, or browser security policies may skip, pause, or fail tasks.

Always run the extension in a dedicated Chrome/Edge browser Profile.
