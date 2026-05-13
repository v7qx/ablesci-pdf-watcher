# Ablesci PDF Uploader

Chrome / Edge 扩展 + Go Native Messaging Helper，用于在 Ablesci 求助详情页辅助完成正文 PDF 的下载、校验和上传。

它只使用当前浏览器已经能访问到的 PDF，不处理登录页、验证码页、错误页、HTML 或其它非 PDF 文件。

当前版本：`v0.10.0`

## 安装

### 1. 加载扩展

1. 打开 `chrome://extensions/` 或 `edge://extensions/`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择 `extension` 目录
5. 复制浏览器分配的扩展 ID

### 2. 注册 Native Helper

先确认本机可以运行 Go：

```powershell
go version
```

Chrome：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -ExtensionId <Chrome扩展ID> -Browser Chrome
```

Edge：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -ExtensionId <Edge扩展ID> -Browser Edge
```

如果 Chrome 和 Edge 都使用，需要分别用各自浏览器里的扩展 ID 运行一次安装脚本。

### 3. 浏览器下载设置

插件依赖浏览器下载完成事件。建议：

- 关闭下载前询问保存位置。
- 设置 PDF 直接下载，不在内置 PDF 阅读器中打开。

Chrome 设置页：

```text
chrome://settings/downloads
chrome://settings/content/pdfDocuments
```

Edge 设置页：

```text
edge://settings/downloads
edge://settings/content/pdfDocuments
```

### 4. 测试

打开扩展设置页，点击“测试 Native Helper”。显示 `正常：pong` 即可。

## 设置

扩展设置页里可以修改：

- Native Host 名称：默认 `com.ablesci.pdf_uploader`。
- 最小自动上传体积：默认 `1 MB`，小于该值只下载不上传。
- 最大自动上传体积：默认 `99 MB`，大于该值只下载不上传。
- 是否保留浏览器下载记录。
- 上传成功后是否删除本地 PDF。
- 调试模式：只下载并校验 PDF，不自动上传，并显示准备上传的文件信息。
- 按钮显示名称、颜色和位置；有快捷应助区域时挂到该区域，没有时回退到页面详情区域。
- 复制最近一次诊断信息。

## 下载和上传逻辑

- Ablesci 页面如果提供直接 PDF 链接，优先使用该链接。
- ScienceDirect 使用页面原生 View PDF / Download PDF 入口。
- 下载完成后交给 Native Helper 校验 `%PDF-` 文件头、计算 MD5 和文件大小。
- 如果浏览器下载到的是 HTML 页面，插件会在调用 Native Helper 前停止，默认保留本地异常文件并提示可能是未登录、没有权限、机构认证失效、验证码或出版商错误页。
- 命中风险提示、补充材料、备注、驳回/举报提示、小于最小体积或大于最大体积时，只下载不自动上传。
- 同一时间只处理一个任务，避免多个求助页之间串文件。

最近一次诊断信息只包含脱敏后的 URL host/path、下载 MIME、文件名、大小和错误信息，不包含 Cookie、CSRF、token、OSS 签名或本地完整路径。

## 下载与文件删除提醒

插件涉及浏览器下载事件。为了避免误删或误传文件，当前策略是保守处理：

- 普通浏览 ScienceDirect / Nature 页面时，插件不会自动点击 PDF 按钮。只有从 Ablesci 任务打开的出版商标签页，才允许插件自动查找或点击 PDF 入口。
- 如果下载到 HTML、登录页、验证码页或错误页，插件会停止处理，不会上传。默认也不会删除这些异常文件，方便用户自行核对。
- “上传成功后删除本地 PDF”默认关闭。开启后，也只会在上传成功后删除当前任务刚刚下载、并已通过 `%PDF-` 文件头校验的 PDF。
- 插件不应删除 HTML、DOCX、ZIP、网页、登录页、错误页或其它非 PDF 文件。
- 浏览器下载事件是全局事件。插件已经尽量按任务标签页、URL、MIME、文件名和串行队列降低误匹配风险，但如果插件正在等待出版商下载，仍建议不要同时手动下载同一出版商的其它文件。
- 不确定时，可以开启“调试模式”：只下载并校验 PDF，不自动上传，也不删除文件。

## Native Helper

`ablesci_pdf_helper.exe` 是 Native Messaging Helper。它不是常驻服务，不开端口；浏览器需要时启动，完成任务后退出。

Helper 主要做：

1. `ping` 测试；
2. 校验 PDF 文件头；
3. 计算 MD5 和文件大小；
4. 上传到 Ablesci 返回的 OSS 地址；
5. 按扩展设置决定是否删除上传成功后的本地 PDF。

## 从源码构建 Helper

Windows：

```powershell
.\native-host\build_helper.ps1 -TargetOS windows -TargetArch amd64
```

Linux / macOS 交叉编译：

```powershell
.\native-host\build_helper.ps1 -TargetOS linux -TargetArch amd64
.\native-host\build_helper.ps1 -TargetOS linux -TargetArch arm64
.\native-host\build_helper.ps1 -TargetOS darwin -TargetArch amd64
.\native-host\build_helper.ps1 -TargetOS darwin -TargetArch arm64
```

## 扩展图标

图标源码位于 `extension/icons/source.svg`。修改 SVG 颜色或形状后，重新生成浏览器使用的 PNG：

```powershell
python .\scripts\build_icons.py
```

脚本会生成 `extension/icons/icon16.png`、`icon32.png`、`icon48.png` 和 `icon128.png`。开发者模式下需要在扩展管理页重新加载扩展后生效。

## 卸载

```powershell
.\native-host\uninstall_host.ps1
```

删除安装目录：

```powershell
.\native-host\uninstall_host.ps1 -RemoveFiles
```
