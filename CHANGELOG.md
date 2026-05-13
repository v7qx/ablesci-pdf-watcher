# Changelog

## v0.10.0

### 新增

- 安装脚本支持 `-Browser Chrome|Edge|All`。
- 配置页增加自动上传 PDF 体积范围设置，默认 1 MB 到 99 MB。
- 设置页增加“复制最近一次诊断信息”。

### 安全

- Helper 拒绝上传到固定 OSS host 之外的地址。
- Helper 不跟随重定向到非白名单 host。
- 下载结果为 HTML MIME 或 `.htm/.html` 文件时，在调用 Native Helper 前停止。
- 下载到非 PDF、HTML、登录页、验证码页、错误页时继续停止。

### 优化

- 配置页改为安装检查页结构。
- 配置页移除下载策略、下载子目录和移动目录表单，默认使用浏览器下载目录和 auto 下载策略。
- Native Helper 上传 OSS 改为流式 multipart，避免大 PDF 全部进入内存。
- 去掉独立 `config.json` 用户配置入口，简化安装和说明。
- Edge 安装说明和卸载脚本支持。

## v0.9.0

- 采用 ScienceDirect 原生 View PDF 流程，不伪造或复用 `crasolve`、`token`、`rack`、`original` 等参数。
- 对 Ablesci 页面上的 SI/补充材料、驳回、举报、系统提示、备注和小于 1 MB 的 PDF 进入“仅下载不上传”模式。
- 保留全局串行队列，避免多个求助页之间串 PDF。
- 增强 Ablesci `direct-pdf` 直下处理，并对 Frontiers、IOPscience 等少量样本做基础验证。
- GitHub 仓库和 Release 改为源码发布，不打包本地编译出的 helper 可执行文件。
