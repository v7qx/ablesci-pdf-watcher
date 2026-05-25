# Ablesci PDF Watcher

Chrome / Edge 扩展 + Go Native Messaging Helper，用于在 Ablesci 求助详情页辅助完成正文 PDF 的下载、校验和上传。

它只使用当前浏览器已经能访问到的 PDF，不处理登录页、验证码页、错误页、HTML 或其它非 PDF 文件。

## 安装与启动顺序

先区分两类能力：

- **只要浏览器提醒、设置页、页面按钮**：只加载扩展即可，**不需要 Native Helper**。
- **需要自动上传 / PDF 校验 / 本地日报 / 本地配置文件**：必须再安装 **Native Helper**。

推荐顺序如下。

### 第 1 步：准备专用浏览器 Profile（推荐）

为了避免影响日常浏览器的 PDF 预览和下载设置，建议先创建一个专用 Chrome / Edge Profile。脚本会自动：

- 创建专用浏览器 Profile 目录；
- 创建独立下载目录；
- 关闭下载前询问保存位置；
- 设置 PDF 直接下载；
- 在桌面创建一个专用浏览器快捷方式；
- 打开扩展管理页，方便你手动加载扩展。

Chrome：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Chrome -Launch
```

Edge：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Edge -Launch
```

这一步不会自动安装扩展。浏览器打开后仍需要你手动开启开发者模式并加载 `extension` 目录。

如果你已经手动创建了专用浏览器 Profile，也可以跳过这一步。

### 第 2 步：加载扩展（必须）

1. 打开 `chrome://extensions/` 或 `edge://extensions/`
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择 `extension` 目录

这一步完成后，浏览器通知、设置页、测试提醒等能力已经可以工作。

### 第 3 步：确认浏览器下载设置（建议）

插件依赖浏览器下载完成事件。建议：

- 关闭下载前询问保存位置
- 设置 PDF 直接下载，不在内置 PDF 阅读器中打开

Chrome：

```text
chrome://settings/downloads
chrome://settings/content/pdfDocuments
```

Edge：

```text
edge://settings/downloads
edge://settings/content/pdfDocuments
```

如果使用了第 1 步脚本，这些设置已经写入专用 Profile；这里只需要打开浏览器设置页确认。
如果浏览器已经打开，再运行脚本修改配置后，请关闭并重新打开专用浏览器，Chrome / Edge 才会重新读取这些下载设置。

### 第 4 步：安装 Native Helper（仅自动上传所必需）

如果你需要以下能力，才需要这一步：

- 自动上传
- `%PDF-` 文件头校验
- MD5 / 文件大小计算
- OSS 上传
- 本地日报写入
- 读取 / 写入 `journal-access.json`、`telegram.json`

直接运行安装脚本即可。**如果仓库里已有预编译的 helper，脚本会直接复制；只有没有预编译文件时才需要 Go。**

Chrome：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -Browser Chrome -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile"
```

Edge：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -Browser Edge -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile"
```

安装脚本会从专用 Profile 中自动识别已加载扩展的 ID，并再次确认该 Profile 已设置为 PDF 直接下载。
如果你没有使用第 1 步脚本，或者自动识别失败，可以在扩展管理页复制扩展 ID 后手动指定：

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ExtensionId <扩展ID>
```

如果 Chrome 和 Edge 都使用，需要分别用各自浏览器里的扩展 ID 运行一次。

如果你之前安装过早期版本的 Native Helper，更新后请重新执行本步骤。当前公开版默认 Native Host ID 为 `com.ablesci.pdf_watcher`。

### 第 5 步：验证

1. 打开扩展设置页
2. 点击“测试提醒”
   - 默认应走**浏览器通知**
   - 这一步**不依赖 Native Helper**
3. 如果你要用自动上传，再点击“测试 Native Helper”
   - 显示 `正常：pong` 才说明 helper 可用

如果“测试 Native Helper”报：

```text
Error when communicating with the native messaging host
```

通常表示：

- 没有执行 `install_host.ps1`
- 扩展 ID 变了但没有重新注册
- 这台电脑拦截了未签名本地 EXE

此时：

- **浏览器通知仍可工作**
- **自动上传、PDF 校验、本地日报会受影响**

## 设置

扩展设置页里可以修改：

- Native Host 名称：默认 `com.ablesci.pdf_watcher`。
- 最小自动上传体积：默认 `1 MB`，小于该值只下载不上传。
- 最大自动上传体积：默认 `99 MB`，大于该值只下载不上传。
- 是否保留浏览器下载记录。
- 上传成功后是否删除本地 PDF：默认关闭，开启后只删除当前任务上传成功且通过 PDF 校验的文件。
- 调试模式：只下载并校验 PDF，不自动上传，并显示准备上传的文件信息。
- 智能推送：控制提交成功后是否显示网站返回的相关文献提示层。
- 按钮显示名称、颜色和位置；有快捷应助区域时挂到该区域，没有时回退到页面详情区域。
- 复制最近一次诊断信息。
- 实验低频值守：默认关闭；启用后使用浏览器 alarm 低频检查 Ablesci 求助列表，跳过置顶、举报、驳回、补充材料和明显异常候选，每次最多处理 1 个候选。

## 下载和上传逻辑

- Ablesci 页面如果提供直接 PDF 链接，优先使用该链接。
- ScienceDirect / Nature 等页面会使用出版社网页中的原生 PDF 入口。
- 插件会监听浏览器下载完成事件，拿到下载文件后交给 Native Helper 校验 `%PDF-` 文件头、计算 MD5 和文件大小。
- 如果下载到的是 HTML、登录页、验证码页或错误页，插件会停止处理，不会上传。
- 命中风险提示、补充材料、备注、驳回/举报提示、小于最小体积或大于最大体积时，只下载和校验，不自动上传。
- 同一时间只处理一个 Ablesci 任务，后续任务会排队。

## 使用提醒与文件删除

插件依赖浏览器下载事件。使用时建议一次只处理一个求助任务；等待下载期间，不要在同一浏览器里手动下载其它文献 PDF，否则可能误传文件。

默认不删除本地 PDF。只有开启“上传成功后删除本地 PDF”时，才会删除当前任务上传成功、且通过 `%PDF-` 校验的 `.pdf` 文件。下载到 HTML、登录页、验证码页或错误页时不会上传，默认也不会删除。

## Native Helper

`ablesci_pdf_helper.exe` 是 Native Messaging Helper。它不是常驻服务，不开端口；浏览器需要时启动，完成任务后退出。

Helper 主要做：

1. `ping` 测试；
2. 校验 PDF 文件头；
3. 计算 MD5 和文件大小；
4. 上传到 Ablesci 返回的 OSS 地址；
5. 按扩展设置决定是否删除上传成功后的本地 PDF；
6. 管理配置文件（读取/写入 JSON 配置）。

通知默认**不依赖 Helper**。默认提醒方式是浏览器通知；只有你手动切到 `Native Helper（实验）` 时，才会调用 helper 的本地通知路径。

### Helper 兼容性说明

某些 Windows 电脑会拦截未签名 EXE，表现为：

```text
测试 Native Helper 失败：
Error when communicating with the native messaging host
```

这不会影响浏览器通知，但会影响自动上传链路。

`install_host.ps1` 安装时会自动：

1. 将 `icon.ico`（多分辨率）复制到安装目录；
2. 在开始菜单 `\Programs\Ablesci PDF Watcher\` 创建 `.lnk` 快捷方式；
3. 快捷方式设置 `AppUserModelID = AblesciPDFWatcher` 并关联图标。

如果你显式选择 Native 通知模式，Helper 会通过 PowerShell 桥接 WinRT Toast API 发通知。这个路径更容易被安全策略拦截，所以只保留为实验选项。

## 从源码构建 Helper（可选）

只有在以下情况才需要这一步：

- 仓库里没有预编译 helper
- 你修改了 `native-helper` 源码
- 你需要自己重新产出 EXE

编译 `ablesci_pdf_helper.exe`，同时生成通知所需的 `icon48.png` 和 `icon.ico`（多分辨率图标）：

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

## 扩展图标（仅改图标时需要）

图标源码位于 `extension/icons/source.svg`。**只有当你修改了 SVG 颜色或形状时**，才需要重新生成浏览器使用的 PNG：

```powershell
python .\scripts\build_icons.py
```

脚本会生成 `extension/icons/icon16.png`、`icon32.png`、`icon48.png` 和 `icon128.png`。开发者模式下需要在扩展管理页重新加载扩展后生效。

## 卸载

这个项目分成两部分：

1. **浏览器扩展**
   - 直接在 Chrome / Edge 的扩展管理页移除即可
   - 这部分不写系统注册表

2. **Native Helper**
   - 会写入当前用户注册表：
     - `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ablesci.pdf_watcher`
     - `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.ablesci.pdf_watcher`
   - 会在本地安装目录放置：
     - `ablesci_pdf_helper.exe`
     - Native host manifest
     - 图标文件
   - 会创建一个开始菜单快捷方式，用于通知图标来源

所以如果你只删除扩展，**Helper 不会自动消失**。

只移除 Native Helper 注册信息和开始菜单快捷方式：

```powershell
.\native-host\uninstall_host.ps1
```

连同安装目录一起删除：

```powershell
.\native-host\uninstall_host.ps1 -RemoveFiles
```

现在的卸载脚本是保守模式：

- 只删除**已知属于本插件**的文件：
  - `ablesci_pdf_helper.exe`
  - `com.ablesci.pdf_watcher.json`
  - `icon48.png`
  - `icon.ico`
  - 安装标记文件
- 只有在目录被清空后，才会删除安装目录本身
- 如果目录里有别的文件，脚本会停止目录删除并提示你手动检查
- 如果安装目录里缺少插件标记或 manifest 不匹配，脚本会拒绝删文件，只建议你手动检查

如果你想手动确认再删，可以先打开安装目录：

```powershell
.\native-host\uninstall_host.ps1 -OpenInstallDir
```

建议顺序：

1. 在浏览器扩展管理页移除扩展
2. 运行 `.\native-host\uninstall_host.ps1`
3. 如果确认不再使用，再运行 `.\native-host\uninstall_host.ps1 -RemoveFiles`

如果你更偏向手动处理，也可以只运行：

```powershell
.\native-host\uninstall_host.ps1 -OpenInstallDir
```

然后自行删除打开的安装目录。这样更适合排查“另一台电脑脚本看起来没生效”这种情况，因为你可以直接看到 Helper 文件是否还在。
