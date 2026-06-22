# Ablesci PDF Watcher

[English](README.md)

Chrome / Edge 扩展 + Go Native Messaging Helper，用于在 Ablesci 求助详情页辅助下载、校验并上传正文 PDF。

## 组成

- `extension/`：浏览器扩展，负责页面按钮、自动值守、出版社页面解析和浏览器通知。
- `native-helper/`：Go 本地助手源码，负责 PDF 文件头校验、MD5/大小计算、受限 OSS 上传、本地日报和可选文件清理。
- `native-host/`：构建、安装、卸载脚本。

## 快速安装

### 1. 加载扩展

建议使用专用 Chrome / Edge Profile，避免日常浏览器的下载和 PDF 预览设置互相影响。

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Chrome -Launch
```

打开 `chrome://extensions/`，开启开发者模式，加载本仓库的 `extension/` 目录。

需要确认：

- 浏览器下载设置关闭“下载前询问保存位置”。
- PDF 设置为直接下载，不在浏览器内预览。

### 2. 准备 Native Helper

推荐普通用户下载 GitHub Release 中的 `ablesci-pdf-helper-windows.zip`，解压后把 `ablesci_pdf_helper.exe` 放到：

```text
native-host\dist\ablesci_pdf_helper.exe
```

也可以从源码编译：

```powershell
.\native-host\build_helper.ps1 -TargetOS windows -TargetArch amd64
```

### 3. 注册 Native Host

Chrome 专用 Profile：

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile_Chrome"
```

已有 Chrome Profile 示例：

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ProfileDir "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 4"
```

若自动识别扩展 ID 失败，可在扩展管理页复制 ID 后显式传入：

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ExtensionId <扩展ID>
```

## 验证

打开扩展选项页：

- 点“测试提醒”：验证浏览器通知。
- 点“测试”：若显示 `正常：pong`，说明 Native Helper 注册成功。

命令行校验 helper：

```powershell
Get-FileHash .\native-host\dist\ablesci_pdf_helper.exe -Algorithm SHA256
Get-AuthenticodeSignature .\native-host\dist\ablesci_pdf_helper.exe
```

## 安全边界

Native Helper：

- 不常驻后台。
- 不监听端口。
- 不读取浏览器 Cookie 或历史记录。
- 不扫描用户磁盘。
- 只处理允许目录中的 PDF。
- 删除文件前会再次确认路径和 `%PDF-` 文件头。
- 上传目标限制为预期的 HTTPS 阿里云 OSS 公网地址。
- Windows 通知已改为浏览器默认通知卡片，不再由 helper 调 PowerShell Toast。

Windows Defender / SmartScreen 仍可能因为 Go 二进制、文件处理和受限上传行为产生误报。普通用户优先使用 GitHub Actions 构建的 Release 产物；不要关闭 Defender 或添加全局白名单。确认误报时，建议把 Release 产物和 SHA256 提交到 Microsoft Security Intelligence Portal 复核。

## 卸载

移除浏览器扩展后，运行：

```powershell
.\native-host\uninstall_host.ps1
```

如需打开 helper 安装目录手动删除文件：

```powershell
.\native-host\uninstall_host.ps1 -OpenInstallDir
```

自动清理已知 helper 文件：

```powershell
.\native-host\uninstall_host.ps1 -RemoveFiles
```

## 使用边界

本项目是社区维护的浏览器辅助工具，不隶属于 Ablesci、出版社或机构平台。使用者需要自行确认账号状态、机构订阅、文献版权、网站条款以及所在地适用规则。
