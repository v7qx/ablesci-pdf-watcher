# Architecture

Ablesci PDF Watcher is a Chrome / Edge extension with a small Go Native Messaging Helper. The extension owns browser UI, page integration, scheduling, download observation, and upload orchestration. The helper only performs local file operations that browser extensions cannot do directly.

## Components

### Browser extension

- `extension/manifest.json`: Manifest V3 entrypoint, permissions, host permissions, background service worker, and content script registration.
- `extension/background.js`: service worker bootstrap, lifecycle recovery, and shared background wiring.
- `extension/background_download_agent.js`: serial PDF download tracking through Chrome Downloads API.
- `extension/background_upload.js`: upload pipeline orchestration after a PDF has been downloaded and validated.
- `extension/background_upload_client.js`: Ablesci upload-request and OSS/native upload request helpers.
- `extension/content_ablesci.js`: Ablesci assist/detail page UI integration and task button behavior.
- `extension/content_publishers.js`: publisher-page PDF entry discovery for supported sites.
- `extension/options.html` and `extension/options.js`: options page UI and user configuration.
- `extension/watcher/`: low-frequency watcher modules for candidate discovery, scheduling, filtering, task execution, reporting, and diagnostics.

### Native helper

- `native-helper/main.go`: Native Messaging process launched by the browser on demand. It validates PDF paths and headers, computes metadata, uploads to the target storage endpoint supplied by Ablesci, writes local reports, and exits.
- `native-host/install_host.ps1`: registers the native host for Chrome or Edge and can prepare the dedicated profile download preferences.
- `native-host/uninstall_host.ps1`: removes the native host registration and can open or clean the local install directory.
- `native-host/build_helper.ps1`: builds the Go helper from source with the local Go toolchain only. It does not embed Windows icon/version resources or fetch extra build tools.
- `scripts/init_browser_profile.ps1`: creates a dedicated browser profile and shortcut for this extension.

## Data Flow

1. The user opens an Ablesci assist/detail page or enables the watcher.
2. The extension selects one candidate task and opens the corresponding detail or publisher page.
3. The extension triggers or observes a PDF download in the dedicated browser profile.
4. `background_download_agent.js` matches the completed browser download and hands the local file path to the upload pipeline.
5. `background_upload.js` asks Ablesci for upload parameters, then asks the native helper to validate and upload the PDF.
6. The native helper restricts local file access to allowed download/temp directories, validates the PDF header, uploads to the accepted target endpoint, optionally deletes the PDF if enabled, and returns the result.
7. The extension updates task status, diagnostics, local reports, and watcher scheduling state.

## Safety Boundaries

- The extension does not request browser cookie permission.
- The native helper is not a daemon and does not listen on a local port.
- Native helper uploads are restricted to the expected storage endpoint supplied by the service. If the service changes its upload storage domain or endpoint format, upload will fail instead of silently uploading elsewhere.
- Local file access is restricted to browser download/temp directories and configured move directories.
- Download matching uses Chrome / Edge Downloads API. A dedicated browser profile is strongly recommended; do not manually download unrelated PDFs in the same profile while a task is running.

## Release Notes for Maintainers

- Keep the extension as the scheduler and browser automation owner. Do not move watcher business rules into the native helper.
- Keep the native helper small, auditable, and low-dependency.
- Avoid adding publisher-specific logic directly to core orchestration files. Put publisher behavior behind existing classifier/strategy boundaries where possible.
- If a file grows large, prefer extracting cohesive modules over broad rewrites.
