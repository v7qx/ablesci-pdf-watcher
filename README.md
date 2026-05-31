# Ablesci PDF Watcher

Chrome / Edge 扩展 + Go Native Messaging Helper，用于在 Ablesci 求助详情页辅助完成正文 PDF 的下载、校验与上传。

## 安装与配置

本项目包含 **浏览器扩展** 与 **Native Helper (本地助手)** 两部分：

- **浏览器扩展**：提供用户界面、选项设置页、页面辅助应助按钮及状态提示等核心交互逻辑。
- **Native Helper**：运行在本地的辅助进程，提供自动上传、PDF 文件头校验、计算 MD5/文件大小以及本地应助日志写入等功能（如需自动上传则为必需）。

建议按照以下步骤完成系统配置与安装：

### 一、安装与配置浏览器扩展

#### 1. 准备专用浏览器 Profile（推荐）

为了避免日常浏览器的 PDF 预览与下载设置受到干扰，建议为本插件创建一个专用的 Chrome/Edge 浏览器 Profile。运行以下初始化脚本可自动生成专用 Profile 及其桌面启动快捷方式：

**Chrome**：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Chrome -Launch
```

**Edge**：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\init_browser_profile.ps1 -Browser Edge -Launch
```

#### 2. 加载浏览器扩展

1. 打开刚才创建的专用浏览器，访问 `chrome://extensions/`（或 `edge://extensions/`）。
2. 开启页面右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**。
4. 选择本仓库的 `extension` 文件夹。

#### 3. 检查 PDF 下载设置与端侧 AI 模型拦截

为确保下载机制正常运行并节省磁盘空间，请核对以下设置：

- **PDF 自动下载**：关闭“下载前询问每个文件的保存位置”，并配置 PDF 为“直接下载”（而非在浏览器内置阅读器中预览）。
  - Chrome 设置路径：`chrome://settings/downloads` 与 `chrome://settings/content/pdfDocuments`
  - Edge 设置路径：`edge://settings/downloads` 与 `edge://settings/content/pdfDocuments`（*注：必须在 Windows 系统中将默认 PDF 查看器设置为非 Edge 软件，否则 Edge 会强制自动打开 PDF 而不触发下载*）
- **禁用 Chrome 端侧 AI 模型下载**：
  Chrome 会在后台自动下载端侧生成式 AI 模型（大小约 4GB），可通过以下官方推荐的两种方式进行禁用并清理空间：

  **方法 1：管理设备上的端侧生成式 AI 模型**
  1. 在计算机上打开 Chrome 浏览器。
  2. 在右上角依次选择“更多”（三个点图标）->“设置”->“系统”。
  3. 开启或关闭“端侧 AI” (On-device AI)。
  （详情可参考 Google 官方支持文档：[管理设备上的生成式 AI 模型](https://support.google.com/chrome/answer/16961953)）

  **方法 2：配置 Chrome Flags（针对单个 Profile）**
  1. 在地址栏输入 `chrome://flags` 并按回车。
  2. 搜索 `optimization-guide-on-device-model`。
  3. 将该项状态从 `Default` 修改为 **`Disabled`**。

---

### 二、编译与安装 Native Helper

#### 1. 编译可执行文件

编译需要本机已准备好 Go 语言开发环境。请在项目根目录下执行编译脚本：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\build_helper.ps1 -TargetOS windows -TargetArch amd64
```

如果只是使用 Chrome / Edge 扩展，通常只需要 Windows 版本的 Helper。其他平台可按需调整 `-TargetOS` 与 `-TargetArch` 重新编译。

#### 2. 注册 Native Host

运行安装脚本将 Native Host 注册到系统。安装脚本会从专用 Profile 中自动识别已加载扩展的 ID 并完成注册：

**Chrome**：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -Browser Chrome -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile_Chrome"
```

**Edge**：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\native-host\install_host.ps1 -Browser Edge -ProfileDir "$env:LOCALAPPDATA\AblesciPdfWatcher\BrowserProfile_Edge"
```

若自动识别失败，可手动指定扩展 ID 运行安装：

```powershell
.\native-host\install_host.ps1 -Browser Chrome -ExtensionId <你的扩展ID>
```

---

### 三、验证与测试

1. 打开浏览器扩展的“选项”设置页面。
2. 点击 **测试提醒**，验证浏览器桌面通知是否正常触发。
3. 点击 **测试** 以校验 Native Helper。若状态框提示 `正常：pong`，说明扩展程序与本地助手的通信链路已打通。

*若提示 `Error when communicating with the native messaging host`，说明通信失败。可能原因包括：注册表未正确导入、扩展 ID 变动未重新注册、或可执行文件启动被系统拦截。此时仅本地自动上传与本地日报功能受阻，页面辅助按钮仍可工作。*

## PDF 下载与校验上传逻辑

- **链接提取**：若求助详情页提供直接 PDF 链接，优先采用该链接下载；针对 ScienceDirect、Nature 等出版商，将自动分析并请求页面中的原生 PDF 入口。
- **文件校验**：插件监听浏览器下载完成事件，捕获下载文件并递交给 Native Helper。Helper 将校验文件是否包含 `%PDF-` 头部特征，并计算 MD5 和文件大小。
- **异常拦截**：若下载的为 HTML、登录页、验证码或错误提示页，插件将中止后续流程，不会执行上传。
- **安全过滤**：若命中期刊黑名单、补充材料备注、求助已驳回/举报或超出体积限制，将仅下载并校验文件，不触发自动上传。
- **串行处理**：任务采用串行队列，同一时间仅下载/校验一个求助任务。
- **上传地址限制**：Native Helper 会校验上传目标是否属于预期的服务端存储地址。若平台后续更换上传存储域名或接口格式，插件会停止上传并提示上传链路异常，而不是自动放宽到未知地址。

---

## 运行须知与文件清理

- **避免误上传**：插件基于浏览器下载事件（Downloads API）进行监听，在排队或等待下载期间，请勿手动在同浏览器中下载其他 PDF 文档，以防触发误上传。
- **文件保留规则**：默认不会删除本地下载的文件。如启用“上传成功后删除本地 PDF”，插件仅在检测到 PDF 上传成功且通过文件头校验后，才会清除该本地文件。若下载失败或未触发上传，文件将继续留存。

---

## Native Helper 运行机制

- **轻量无状态**：`ablesci_pdf_helper.exe` 基于 Native Messaging 协议，仅在浏览器扩展发起请求时由浏览器拉起运行，执行完毕后立即退出。非后台常驻进程，不监听任何端口，不占用系统网络服务。
- **核心职责**：
  1. 通信响应（`ping/pong` 校验）；
  2. PDF 文件头 `%PDF-` 特征码校验；
  3. 计算文件 MD5 与文件大小；
  4. 将通过校验的 PDF 文件上传至目标云存储（OSS）地址；
  5. 依据扩展配置自动清理已上传的 PDF 文件；
  6. 写入本地应助日报和辅助排查文件。

## 扩展图标重新生成

图标源文件默认为 `extension/icons/source.svg`。如果只是修改 SVG 颜色或简单形状，可重新生成不同尺寸的 PNG 文件：

```powershell
python .\scripts\build_icons.py
```

脚本将生成 `icon16.png`、`icon32.png`、`icon48.png`、`icon64.png`、`icon128.png`、`icon256.png` 和 `icon.ico`。默认渲染器只支持项目自带 `source.svg` 使用的简单 SVG 子集，不支持任意复杂 SVG。

生成后不需要修改 `manifest.json`。在 Chrome / Edge 扩展管理页点击“重新加载”即可看到新图标；如果浏览器缓存旧图标，可关闭并重新打开专用浏览器。

如果想使用 PNG 图标，请先用图片工具自行导出以下文件并放到 `extension/icons/`：

- `icon16.png`
- `icon32.png`
- `icon48.png`
- `icon128.png`

然后运行：

```powershell
python .\scripts\build_icons.py --ico-only
```

该模式只会检查现有 PNG 尺寸并生成 `icon.ico`，不会缩放图片。

---

## 卸载

本项目由浏览器扩展与本地 Helper 两部分组成，需分别卸载：

### 1. 卸载浏览器扩展

在 Chrome / Edge 扩展程序管理页面直接移除扩展即可。此部分不写入系统注册表。

### 2. 卸载 Native Helper

按照以下步骤清理系统注册表及本地物理文件：

- **第一步：注销注册表项及快捷方式**
  在项目根目录下打开 PowerShell 并运行注销脚本，清理当前用户下的 Native Messaging 注册表项和开始菜单快捷方式：

  ```powershell
  .\native-host\uninstall_host.ps1
  ```

- **第二步：清理本地物理文件**
  - **手动删除（推荐）**：运行以下命令打开 Helper 本地安装目录，手动将 `AblesciPdfWatcher` 文件夹彻底删除：

    ```powershell
    .\native-host\uninstall_host.ps1 -OpenInstallDir
    ```

  - **自动删除（可选）**：若需使用脚本自动清理文件，可运行以下命令（若目录下存在非已知文件或自定义配置文件，脚本将不会执行删除）：

    ```powershell
    .\native-host\uninstall_host.ps1 -RemoveFiles
    ```

---

## 责任与使用边界

本项目是社区维护的浏览器辅助工具，不隶属于 Ablesci、任何出版社或机构平台。使用者需要自行确认账号状态、机构订阅、文献版权、网站条款以及所在地适用规则。

插件只能在浏览器和网站当前允许的范围内辅助处理 PDF 下载、校验和上传，不保证所有出版商页面长期可用。出版商页面结构、登录状态、验证码、机构认证、上传存储服务或浏览器安全策略变化，都可能导致任务跳过、暂停或失败。

建议始终使用专用 Chrome / Edge Profile 运行本插件，不要在日常浏览器 Profile 中混用下载任务。
