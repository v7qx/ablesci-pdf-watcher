'use strict';

const {
  DEFAULT_OPTIONS,
  WATCHER_DAILY_LIMIT_MAX,
  normalizeSizeUnit,
  clampNumber,
  normalizeSchedulerMode,
  normalizeWatcherIntervals,
  normalizeWatcherListUrls,
  normalizeOptions,
  sanitizePathPart,
  validateOptions
} = globalThis.AblesciWatcherConfig;
const {
  OPTION_IDS: ids,
  LAST_DIAGNOSTIC_KEY,
  AUTO_WATCHER_STATE_KEY,
  AUTO_WATCHER_LOG_KEY,
  AUTO_WATCHER_TRACE_KEY,
  loadOptionsFromStorage
} = globalThis.AblesciWatcherStorage;
const {
  normalizeWorkdaysSet,
  normalizeWorkWindowsDetailed,
  weekdayNumber,
  beijingMinutesNow,
  isInWorkSchedule
} = globalThis.AblesciWatcherWorktime;
const { createOptionsHelpersApi } = globalThis.AblesciOptionsHelpers;
const { createOptionsStatusApi } = globalThis.AblesciOptionsStatus;
const { createOptionsActionsApi } = globalThis.AblesciOptionsActions;
const {
  normalizeButtonLabel,
  normalizeHexColor,
  normalizeButtonPosition,
  formatBeijingDateTime,
  countdownText,
  normalizeWorkdays,
  normalizeWorkWindows,
  nextDisplaySchedule,
  todayKeyBeijing,
  sanitizeUrlForExport,
  watcherOptionSnapshot
} = createOptionsHelpersApi({
  defaultOptions: DEFAULT_OPTIONS,
  normalizeWorkdaysSet,
  normalizeWorkWindowsDetailed,
  normalizeWatcherListUrls
});
const { createOptionsNativeApi } = globalThis.AblesciOptionsNative;
const {
  nativeFailureHelp,
  // PRIVATE_WATCHER_ONLY
  openLocalStorageDir: openLocalStorageDirFromNative
} = createOptionsNativeApi({
  chromeApi: chrome,
  defaultOptions: DEFAULT_OPTIONS,
  el,
  setText,
  showPill
});

const TEXT_MAP = {
  "设置下载、上传、按钮显示和低频值守。": "Configure download, upload, button styles, and auto watcher.",
  "浏览器下载设置": "Browser Download Settings",
  "请手动关闭\"下载前询问保存位置\"，并设置 PDF 直接下载；否则 PDF 可能会在浏览器内置阅读器中打开，插件无法继续。": "Please manually disable \"Ask where to save each file before downloading\" and configure PDFs to download directly; otherwise, PDFs may open in the browser's built-in viewer and halt the plugin.",
  "Native Helper": "Native Helper",
  "测试本地 Helper 是否可用。": "Test if the local helper is available.",
  "打开本地目录": "Open Directory",
  "测试": "Test",
  "未测试": "Untested",
  "测试中": "Testing",
  "返回异常": "Response Exception",
  "正常：": "OK: ",

  "上传规则": "Upload Rules",
  "自动上传范围": "Auto Upload Range",
  "超出范围时只下载和校验。最大值固定为 150 MB。": "Only download and verify when out of range. Maximum is fixed at 150 MB.",
  "超出范围时只下载和校验。最大值填 0 表示不限制。": "Only download and verify when out of range. 0 means unlimited.",
  "最小体积": "Min Size",
  "最小体积单位": "Min Size Unit",
  "最大体积": "Max Size",
  "最大体积单位": "Max Size Unit",
  "0 为不限": "0 for unlimited",
  "到": "to",
  "上传完成后删除本地 PDF": "Delete PDF After Upload",
  "关闭时会保留本地 PDF。": "Keep local PDF when disabled.",
  "调试模式": "Debug Mode",
  "调试模式：仅下载不上传": "Debug mode: download only",
  "只下载并校验 PDF，不自动上传；完成时显示准备上传的文件信息。": "Download and verify PDF only, do not upload; show details when done.",
  "智能推送": "Smart Recommendations",
  "提交后显示智能推送": "Show smart recommendations after upload",
  "提交成功后，按网站返回结果决定是否显示相关文献的智能推送提示。": "Display paper recommendation popups after successful upload based on response.",

  "更多设置": "More Settings",
  "按钮显示名称": "Button Label",
  "显示在 Ablesci 页面按钮上的文字。": "Label displayed on the button in Ablesci details page.",
  "按钮颜色": "Button Color",
  "默认状态下的按钮背景和文字颜色。": "Background and text color of the button.",
  "背景": "BG",
  "文字": "Text",
  "按钮显示位置": "Button Position",
  "没有快捷应助区域时，回退到 DOI 区域最后。": "Fallback to end of DOI section if assist area is missing.",
  "现有快捷应助按钮之后": "After existing assist buttons",
  "现有快捷应助按钮之前": "Before existing assist buttons",
  "显示语言": "Display Language",
  "设置插件配置页和应助按钮的显示语言。": "Set the language for both options page and injected buttons.",
  "自动 / Auto": "Auto",
  "中文 / Chinese": "Chinese",
  "英文 / English": "English",
  "保留浏览器下载记录": "Keep Browser Download History",
  "异常 HTML 下载会保留记录，便于确认。": "Keep download history for failed HTML pages for debugging.",
  "求助链接当前窗口打开": "Open Links in Current Tab",
  "开启后，求助列表和上传成功后的推荐链接会在当前窗口打开；Ctrl、Command 和中键点击仍保留浏览器默认行为。": "Open helper list and recommended links in the current tab; Ctrl/Cmd/middle click still use browser default behavior.",
  "ScienceDirect 打开模式": "ScienceDirect Tab Mode",
  "可见模式最接近手动点击；半可见为后台静默 60 秒后切前台；静默模式不会主动切前台。": "Visible is closest to manual use; semi-visible waits in the background for 60 seconds before foregrounding; silent never foregrounds automatically.",
  "立即可见": "Visible",
  "后台后可见": "Semi-visible",
  "一直后台": "Silent",
  "自动删除 HTML 错误页": "Auto Remove HTML Error Pages",
  "默认关闭。开启后，下载到 HTML/登录页/错误页时会尝试删除本地异常文件。": "Disabled by default. When enabled, attempts to delete local downloaded HTML/login/error pages.",
  "每日应助上限": "Daily Assist Limit",
  "按 PDF 下载/应助尝试计数，0 表示不限制。用于防止异常时连续下载。": "Counted by PDF download/assist attempts. 0 means unlimited.",
  "诊断信息": "Diagnostic Info",
  "复制最近一次脱敏诊断信息。": "Copy the latest anonymized diagnostic information.",
  "默认关闭。开启后才记录最近一次诊断和出版商链路。": "Off by default. Records the latest diagnostic and publisher trace only when enabled.",
  "记录诊断信息": "Record diagnostic information",
  "诊断未开启": "Diagnostics disabled",
  "复制": "Copy",
  "未复制": "Not Copied",
  "已清除 watcher 已处理记录。": "Watcher processed records cleared.",
  "已清除 watcher 日志和 trace。": "Watcher logs and traces cleared.",
  "清除失败：": "Clear failed: ",
  "未知错误": "Unknown error",
  "暂无诊断信息。": "No diagnostic info available.",
  "已复制诊断信息。": "Diagnostic info copied.",

  "运行数据": "Running Status",
  "值守状态": "Watcher Status",
  "从本地 watcher 状态读取，仅用于排查。": "Retrieved from local watcher state, for debugging only.",
  "实际 / 预计": "Actual / Expected",
  "网页总应助": "Web Total Assists",
  "目标差额": "Target Deficit",
  "运行模式": "Running Mode",
  "下次应助": "Next Run",
  "计划应助": "Planned Run",
  "应助倒计时": "Countdown",
  "今日应助计数": "Today Assists",

  "实验：低频值守": "Experimental: Auto Watcher",
  "值守参数配置": "Watcher Parameter Settings",
  "基础设置": "Basic Settings",
  "启用低频值守": "Enable Auto Watcher",
  "默认关闭。只在浏览器运行且扩展启用时按低频 alarm 检查。": "Disabled by default. Periodically checks via low-frequency alarm when browser is running.",
  "值守速度模式": "Watcher Speed Mode",
  "控制自动值守的运行速率。极速与快速模式下将获得更密集的应助响应。": "Controls the execution rate of the auto watcher. Faster modes run checks more frequently.",
  "极速模式 (中位数 2 分钟)": "Fast Mode (Median 2 min)",
  "常规速度 (中位数 4 分钟)": "Normal Mode (Median 4 min)",
  "普通慢速 (中位数 6 分钟)": "Slow Mode (Median 6 min)",
  "月目标": "Monthly Target",
  "按本月时间进度估算当前应完成量，用于自适应模式下计算调度间隔。": "Target used to compute dynamic scheduling interval based on monthly progress.",

  "候选筛选": "Candidate Filter",
  "列表 URL": "List URLs",
  "每行一个 Ablesci 求助列表链接。追加 <code>&amp;page_min=1&amp;page_max=5&amp;order=desc</code> 可按页码倒序依次扫描。": "One Ablesci helper list link per line. Add <code>&amp;page_min=1&amp;page_max=5&amp;order=desc</code> for sequential reverse scanning.",
  "非 SD 最低求助量": "Min Non-SD Requests",
  "除 Elsevier / ScienceDirect 外，如果当前出版社列表页统计到的求助量低于这个值，则整页直接跳过，不打开详情页。填 0 关闭，默认 200。": "Min waiting count required to parse non-SD pages. 0 to disable, defaults to 200.",
  "控制哪些求助在列表页和详情页被跳过。": "Control which requests are skipped on list and details pages.",
  "有 DOI": "Has DOI",
  "举报": "Reported",
  "驳回": "Rejected",
  "补充材料": "Supplement",
  "备注": "Has Remarks",
  "书籍章节": "Book Chapter",
  "专利/报告": "Patent/Report",
  "异常文本": "Risk Text",
  "更正/Corrigendum": "Corrigendum",
  "求助人黑名单": "Requester Blacklist",
  "黑名单文件路径": "Blacklist File Path",
  "设置本地黑名单 .txt 文件的绝对路径（留空默认读取并生成“本地目录”下的 blacklist.txt）。多个 ID 用逗号、空格或换行分隔。": "Specify the absolute path of the local blacklist .txt file (leave empty to default to blacklist.txt under local directory). IDs separated by commas, spaces, or newlines.",
  "可选。开启黑名单后，留空会读取并自动生成 Helper 本地目录下的 blacklist.txt；填写路径时若 .txt 不存在也会自动创建。读取失败时本次会跳过黑名单检查，不阻断应助。": "Optional. When enabled, leaving this empty reads and auto-creates blacklist.txt in the Helper local directory; a custom .txt path is also auto-created if missing. Read failures skip blacklist checking for the current task and do not block assisting.",
  "例如：D:\\path\\to\\blacklist.txt": "e.g., D:\\path\\to\\blacklist.txt",


  "任务超时": "Task Timeout",
  "区分未触发下载、下载中超时和任务最长时间；超时会取消当前任务并释放队列。": "Set different timeouts. Unresponsive tasks will be cancelled and queue released.",
  "未触发下载": "No Download Initiated",
  "未触发下载超时分钟": "No-download Timeout Minutes",
  "下载中": "Downloading",
  "下载中超时分钟": "Active-download Timeout Minutes",
  "单任务最长": "Max Per Task",
  "单任务最长超时分钟": "Max Task Timeout Minutes",

  "报告与通知": "Report & Notification",
  "连续遇阻自动暂停（实验）": "Auto Pause on CF Challenge",
  "启用连续遇阻自动暂停": "Enable auto pause on consecutive blocks",
  "启用后，当连续遇到人机验证页面达到设定次数时，自动暂停值守，以防频繁撞墙被封。": "When enabled, automatically pauses the watcher after consecutive Cloudflare/challenges to prevent IP bans.",
  "连续遇阻": "Pause after",
  "连续遇阻暂停次数": "Consecutive block pause threshold",
  "次后暂停": "consecutive blocks",
  "CF 提醒": "CF Alert",
  "遇到 CF 或 challenge 时立即发浏览器提醒": "Send browser notification on CF/challenge",
  "提醒与日报": "Alert & Daily Report",
  "提醒默认走浏览器通知并带独立声音；日报由 Helper 直接写入本地。": "Alerts use browser notifications with sound. Daily reports are written locally by the Go Helper.",
  "启用提醒通知": "Enable notifications",
  "生成每日统计报表": "Generate daily report",
  "图标倒计时": "Badge Countdown",
  "扩展图标显示下一次应助倒计时": "Show next assist countdown on the extension icon",
  "浏览器通知": "Browser Notification",
  "Native Helper（实验）": "Native Helper (Exp)",
  "提醒方式": "Notification Mode",
  "测试提醒": "Test Alert",
  "日报目录": "Report Directory",
  "可选绝对路径。留空时 Native Helper 写入用户 Downloads 下的 ablesci-watcher-reports。": "Optional absolute path. If empty, Go Helper writes to ablesci-watcher-reports under user Downloads.",
  "Trace 级别": "Trace Level",
  "默认关闭。需要排查时再打开，避免长期占用本地存储。": "Off by default. Enable only for debugging to save local storage.",
  "默认关闭。需要排查时再打开，避免长期占用本地存储；性能 Trace 可单独开启。": "Off by default. Enable only for debugging to save local storage; performance trace can be enabled separately.",
  "性能记录": "Performance Recording",
  "记录值守阶段耗时；本地 JSONL 会通过 Helper 写入日报目录下的 performance 文件夹。": "Record watcher stage timings. Local JSONL is written by Helper under the performance folder in the report directory.",
  "写入 Trace": "Write Trace",
  "本地 JSONL": "Local JSONL",
  "关闭": "Off",
  "简略": "Compact",
  "标准": "Normal",
  "详细": "Verbose",

  "本地记录维护": "Local Cache Cleanup",
  "仅清理本机保存的已处理记录、watcher 日志和 trace。": "Clears local processed records, watcher logs, and traces.",
  "仅清理本机保存的已处理记录、watcher 日志和 trace；不会清理 ScienceDirect 无权限期刊缓存。": "Clears local processed records, watcher logs, and traces; does not clear the ScienceDirect no-access journal cache.",
  "清除已处理": "Clear Processed Cache",
  "清除日志/Trace": "Clear Logs & Traces",
  "ScienceDirect 无权限期刊缓存": "ScienceDirect No-Access Journal Cache",
  "记录明确无订阅权限的期刊短名，用于列表页标注和自动值守预过滤。": "Stores journal short names with explicit no-subscription results for list-page markers and auto-watcher prefiltering.",
  "隐藏列表命中项": "Hide Matched Rows",
  "在求助列表页隐藏命中本地无权限缓存的 ScienceDirect 求助": "Hide ScienceDirect requests matched by the local no-access cache on list pages.",
  "清空": "Clear",
  "未加载": "Not Loaded",
  "暂无缓存。": "No cache entries.",
  "已清空 ScienceDirect 无权限期刊缓存。": "ScienceDirect no-access journal cache cleared.",
  "有效缓存": "Valid Cache",
  "条": "entries",
  "最近": "Recent",

  "值守操作": "Watcher Actions",
  "手动触发一次检查，或复制当前排查日志。": "Run a manual check or copy troubleshooting logs.",
  "立即检查": "Run Watcher Now",
  "复制日志": "Copy Logs",

  "值守已关闭": "Watcher Disabled",
  "已停止": "Stopped",
  "不限制": "Unlimited",
  "发送中": "Sending",

  "保存": "Save",

  // Background/Watcher errors & status messages for options display
  "当前出版商无正文订阅权限，任务已跳过。": "No subscription access, task skipped.",
  "当前出版商页面显示无正文订阅权限，已跳过本次任务并记录期刊权限状态。": "The publisher page shows no full-text subscription access. This task has been skipped and the journal permission status recorded.",
  "ScienceDirect 需要登录或机构访问后才能继续。插件已保留这次为登录阻塞，不计入无权限期刊；完成登录后可重新触发。": "ScienceDirect requires login or institutional access. The plugin has flagged this as login blocked, which is excluded from no-access journals; you can retry after logging in.",
  "检测到出版商验证页，已中断本次任务并计入验证次数；达到阈值后会自动暂停低频值守。": "Publisher verification page (Cloudflare) detected. Task aborted and challenge count incremented; auto watcher will pause if threshold is reached.",
  "DOI 解析失败或不存在，已跳过本次任务。": "DOI resolution failed or does not exist. Task skipped.",
  "已排队：等待当前 PDF 任务完成；关闭本页可取消。": "Queued: Waiting for current PDF task to complete; close this page to cancel.",
  "已跳过": "Skipped",
  "current task skipped": "Current task skipped",
  "当前任务已跳过": "Current task skipped",
  "上传成功": "Upload Successful",
  "上传失败": "Upload Failed",
  "仅下载完成": "Downloaded Only",

  // Additional translations
  "未检查": "Never checked",
  "检查中": "Checking...",
  "已完成": "Completed",

  // Candidate Filter hover tooltips
  "只处理有 DOI 的求助": "Only process requests with DOI",
  "跳过举报": "Skip reported requests",
  "跳过驳回": "Skip rejected requests",
  "跳过补充材料": "Skip supplement materials",
  "跳过存在备注的求助": "Skip requests with remarks",
  "跳过书籍章节": "Skip book chapters",
  "跳过专利或报告类": "Skip patents or reports",
  "跳过异常文本": "Skip abnormal text",
  "跳过更正类求助": "Skip corrigendum requests",
  "启用求助人黑名单": "Enable requester blacklist",

  // Watcher Status card metric grid hover tooltips
  "实际：以本月首次同步网页总应助数为基准，统计之后新增的应助量；预计：月初开始时按当前月进度推算，月中首次同步时会扣除已过去比例，只保留剩余月份目标。": "Actual: Assists done since first sync of this month; Expected: Calculated based on elapsed month duration, deducting elapsed proportion upon first sync.",
  "从科研通个人中心静默同步到的历史累计总应助数（包含其他设备及手动应助）。": "Total cumulative assists synced silently from Ablesci profile (includes other devices and manual assists).",
  "本月预计应助数与本月实际应助数的差值（预计 - 实际）。正数表示落后于进度，负数表示超前。": "Difference between expected and actual assists for this month (Expected - Actual). Positive means behind schedule, negative means ahead.",
  "当前生效的定时调度逻辑与决策模式。": "Currently active scheduling logic and decision model.",
  "下一次自动应助的具体北京时间。量化模式下这里与实际唤醒时间保持一致，不再额外提前唤醒做观察。": "Next scheduled automatic assist run time (Beijing time).",
  "与下次应助保持同一时间口径，便于复制和核对。": "Matches the time scale of the next run for easy comparison and copying.",
  "距离下一次自动应助的剩余时间。到点后应直接进入自动应助，而不是再等待另一套计划时间。": "Time remaining before the next auto assist run.",
  "当前配置的每日应助上限。这里只显示总上限，不再显示内部 todayTarget 等派生目标。": "Current daily assist limit. Shows total limit only.",
  "今日进入下载/校验流程的应助次数，按自动和手动分开显示；用于每日上限，不代表上传成功数。": "Assists that entered download/validation today, split by automatic and manual runs. Used for the daily limit; not the successful upload count.",

  // Watcher outcome translations
  "candidate_handled": "Candidate assist processed successfully",
  "session_candidates_handled": "All session candidates processed successfully",
  "disabled": "Auto watcher is disabled",
  "already_running": "Watcher is already running",
  "active_task": "Another assist task is currently active",
  "outside_work_schedule": "Outside configured working hours",
  "assist_not_due": "Next check is not due yet",
  "daily_limit": "Reached daily assist limit",
  "session_size_zero": "Target session size is zero",
  "cf_challenge": "Cloudflare challenge or verification page encountered",
  "session_target_reached": "Session target reached",
  "no_candidate": "No waiting candidates found",
  "upload_failed_stop_run": "Upload failed, run terminated",
  "manual_run_preserve_existing_schedule": "Manual check trigger preserving existing schedule",

  // Options validation errors translations
  "最小体积必须大于或等于 0。": "Min size must be greater than or equal to 0.",
  "最大体积必须大于或等于 0。": "Max size must be greater than or equal to 0.",
  "最小体积不能大于最大体积。": "Min size cannot be greater than max size.",
  "每日应助上限不能小于 0。": "Daily assist limit cannot be less than 0.",
  "非 SD 最低求助量不能小于 0。": "Min non-SD requests cannot be less than 0.",
  "任务超时时间必须大于 0。": "Task timeout must be greater than 0.",
  "任务最长时间不能小于未触发下载或下载中超时时间。": "Max task time cannot be less than download or idle timeouts.",
  "低频值守列表 URL 不能为空。": "List URLs cannot be empty.",
  "PDF 去水印 (Experimental)": "PDF Watermark Cleaner (Exp)",
  "启用 PDF 去水印": "Enable PDF Watermark Cleaner",
  "在下载 PDF 完成后、上传到科研通之前，自动调用本地去水印工具清理水印。": "Automatically clean watermarks using the local CLI tool after PDF download and before upload.",
  "去水印工具路径": "Watermark Cleaner Path",
  "zotero-access-cleaner.exe 的绝对路径。": "Absolute path to zotero-access-cleaner.exe.",
  "例如：D:\\path\\to\\zotero-access-cleaner.exe": "e.g., D:\\path\\to\\zotero-access-cleaner.exe",
  "规则库文件路径": "Patterns File Path",
  "patterns.json 的绝对路径。留空则尝试自动从工具路径推导。": "Absolute path to patterns.json. Leave empty to auto-derive from the tool path.",
  "例如：D:\\path\\to\\patterns.json": "e.g., D:\\path\\to\\patterns.json",
  "处理引擎": "Processing Engine",
  "默认自适应模式。": "Default is adaptive mode.",
  "自适应 (Auto)": "Adaptive (Auto)",
  "pdfcpu 引擎 (严格校验)": "pdfcpu Engine (Strict)",
  "qpdf 引擎 (高容错性)": "qpdf Engine (High Tolerance)",
  "单文件超时时间": "Single File Timeout",
  "去水印进程的最长允许运行时间（单位：秒）。": "Maximum allowed run time for the watermark cleaning process (in seconds).",
  "去水印出错时的策略": "Error Handling Strategy",
  "如果去水印失败或超时，是继续上传原 PDF 还是终止上传。": "Choose whether to proceed with uploading the original PDF or stop upload if cleaning fails/times out.",
  "上传原始 PDF": "Upload Original PDF",
  "终止上传并报错": "Abort Upload and Report Error",
  "去水印调试模式": "Watermark Debug Mode",
  "保留去水印前的原始 PDF 文件（清洗成功时在同一目录下生成 filename.original.pdf）。": "Preserve original PDF file as filename.original.pdf when cleaned successfully.",
  "去水印超时时间必须在 5 到 300 秒之间。": "Watermark cleaner timeout must be between 5 and 300 seconds."
};

function getActualLanguage(langOption) {
  if (langOption === 'zh') return 'zh';
  if (langOption === 'en') return 'en';
  const browserLang = (navigator.language || '').toLowerCase();
  return browserLang.startsWith('zh') ? 'zh' : 'en';
}

function translateTextNodes(node, map) {
  if (node.nodeType === Node.TEXT_NODE) {
    const trimmed = node.nodeValue.trim();
    if (map[trimmed]) {
      const match = node.nodeValue.match(/^(\s*)(.*?)(\s*)$/);
      if (match) {
        node.nodeValue = match[1] + map[trimmed] + match[3];
      } else {
        node.nodeValue = map[trimmed];
      }
    }
  } else {
    if (node.placeholder && map[node.placeholder.trim()]) {
      node.placeholder = map[node.placeholder.trim()];
    }
    if (node.title && map[node.title.trim()]) {
      node.title = map[node.title.trim()];
    }
    if (node.getAttribute && node.getAttribute('aria-label') && map[node.getAttribute('aria-label').trim()]) {
      node.setAttribute('aria-label', map[node.getAttribute('aria-label').trim()]);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      translateTextNodes(child, map);
    }
  }
}

function t(msg) {
  const trimmed = String(msg || '').trim();
  const isEn = globalThis.watcherActiveLanguage === 'en';
  if (isEn) {
    if (trimmed === 'quant / quant_rules') return 'Adaptive Monthly Target';
    if (trimmed === 'quant / fixed_interval') return 'Fixed Interval';
    if (trimmed === 'quant / quant_rules (值守已关闭)') return 'Adaptive Monthly Target (Disabled)';
    if (trimmed === 'quant / fixed_interval (值守已关闭)') return 'Fixed Interval (Disabled)';
    if (TEXT_MAP[trimmed]) return TEXT_MAP[trimmed];

    if (trimmed.startsWith('正常：')) {
      const rest = trimmed.substring(3).trim();
      return 'OK: ' + t(rest);
    }
    if (trimmed.startsWith('失败：')) {
      const rest = trimmed.substring(3).trim();
      return 'Failed: ' + t(rest);
    }
    if (trimmed.startsWith('正常: ')) {
      const rest = trimmed.substring(4).trim();
      return 'OK: ' + t(rest);
    }
    if (trimmed.startsWith('失败: ')) {
      const rest = trimmed.substring(4).trim();
      return 'Failed: ' + t(rest);
    }
    if (trimmed.startsWith('自动: ')) {
      return trimmed.replace('自动:', 'Auto:').replace('手动:', 'Manual:');
    }
    if (trimmed.startsWith('自动:')) {
      return trimmed.replace('自动:', 'Auto:').replace('手动:', 'Manual:');
    }
    if (trimmed.includes('已保存')) {
      return 'Saved. Opened Ablesci pages will auto-update, or refresh to apply.';
    }

    const m = trimmed.match(/^短时间内连续出现\s*(\d+)\s*次无正文权限，且涉及\s*(\d+)\s*个期刊。已暂停值守，请检查代理、登录态或机构访问环境。$/);
    if (m) {
      return `Consecutive no-access occurred ${m[1]} times in a short period, involving ${m[2]} journals. Watcher paused. Please check proxy, login status, or institutional access environment.`;
    }
    const mCf = trimmed.match(/^连续\s*(\d+)\s*次遇到出版商验证页，已暂停低频值守。请完成验证后手动重新开启。$/);
    if (mCf) {
      return `Encountered publisher verification page for ${mCf[1]} consecutive times. Auto watcher paused. Please re-enable manually after resolving in browser.`;
    }
    const mCfW = trimmed.match(/^检测到出版商验证页（第\s*(\d+)\s*次）。请恢复浏览器窗口并完成验证；达到\s*(\d+)\s*次后会自动暂停值守。$/);
    if (mCfW) {
      return `Publisher verification page detected (${mCfW[1]} times). Please resolve in browser; auto watcher will pause after ${mCfW[2]} times.`;
    }
  } else {
    if (trimmed === 'quant / quant_rules') return '月目标自适应调度';
    if (trimmed === 'quant / fixed_interval') return '固定间隔调度';
    if (trimmed === 'quant / quant_rules (值守已关闭)') return '月目标自适应调度 (值守已关闭)';
    if (trimmed === 'quant / fixed_interval (值守已关闭)') return '固定间隔调度 (值守已关闭)';

    const zhMap = {
      "candidate_handled": "候选求助处理完成",
      "session_candidates_handled": "本次值守所有候选处理完成",
      "disabled": "低频值守未启用",
      "already_running": "值守检查已在运行中",
      "active_task": "存在其他活动中的应助任务",
      "outside_work_schedule": "当前处于非工作时间段",
      "assist_not_due": "未到下一次检查时间点",
      "daily_limit": "已达到今日应助上限",
      "session_size_zero": "本次调度预计应助数为 0",
      "cf_challenge": "遇到人机验证/验证码，已跳过",
      "session_target_reached": "已达到本次应助目标数",
      "no_candidate": "未在列表页发现待应助的候选",
      "upload_failed_stop_run": "上传失败，检查中止",
      "manual_run_preserve_existing_schedule": "手动触发并保留现有日程调度"
    };
    if (zhMap[trimmed]) return zhMap[trimmed];
  }
  return msg;
}

globalThis.t = t;

function el(id) { return document.getElementById(id); }

async function loadOptions() {
  const uiNormalizers = { normalizeButtonLabel, normalizeHexColor, normalizeButtonPosition };
  return loadOptionsFromStorage(uiNormalizers);
}

async function load() {
  const opts = await loadOptions();
  const activeLang = getActualLanguage(opts.watcherLanguage);
  globalThis.watcherActiveLanguage = activeLang;

  for (const id of ids) {
    const node = el(id);
    if (!node) continue;
    if (node.type === 'checkbox') node.checked = !!opts[id];
    else if (id === 'watcherListUrls') node.value = normalizeWatcherListUrls(opts[id]).join('\n');
    else node.value = opts[id] ?? '';
  }
  if (activeLang === 'en') {
    translateTextNodes(document.body, TEXT_MAP);
    document.title = 'Ablesci PDF Watcher Settings';
    const descNode = el('watcherListUrlsDesc');
    if (descNode) {
      descNode.textContent = 'One Ablesci assist list URL per line. Add &page_min=1&page_max=5&order=desc for reverse sequential scanning.';
    }
  }

  await renderAdvancedWatcherStatus();
}

function setText(id, value) {
  const node = el(id);
  if (node) {
    const val = typeof value === 'string' ? t(value) : value;
    node.textContent = val;
    node.title = String(val ?? '');
  }
}

// validateOptions is imported from globalThis.AblesciWatcherConfig

async function save(saveOptions = {}) {
  const opts = await loadOptions();
  for (const id of ids) {
    const node = el(id);
    if (!node) continue;
    opts[id] = node.type === 'checkbox' ? node.checked : node.value.trim();
  }

  opts.downloadMode = 'auto';
  opts.scienceDirectTabMode = ['visible', 'silent_then_visible', 'silent'].includes(opts.scienceDirectTabMode)
    ? opts.scienceDirectTabMode
    : DEFAULT_OPTIONS.scienceDirectTabMode;
  const minVal = Number(opts.minAutoUploadMB);
  opts.minAutoUploadMB = isNaN(minVal) || minVal < 0 ? DEFAULT_OPTIONS.minAutoUploadMB : minVal;
  opts.minAutoUploadUnit = normalizeSizeUnit(opts.minAutoUploadUnit);
  opts.maxAutoUploadMB = 150;
  opts.maxAutoUploadUnit = 'MB';
  opts.buttonLabel = normalizeButtonLabel(opts.buttonLabel);
  opts.buttonColor = normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor);
  opts.buttonTextColor = normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor);
  opts.buttonPosition = normalizeButtonPosition(opts.buttonPosition);
  opts.watcherSchedulerMode = normalizeSchedulerMode(opts);
  Object.assign(opts, normalizeWatcherIntervals(opts));
  opts.watcherMaxCandidatesPerRun = 1;
  opts.watcherOpenDetail = true;
  opts.watcherAutoDownload = true;
  opts.watcherAutoUpload = true;
  opts.watcherUploadConfirmRequired = false;
  opts.watcherMinNonSdSeekingCount = clampNumber(opts.watcherMinNonSdSeekingCount, DEFAULT_OPTIONS.watcherMinNonSdSeekingCount, 0, 100000);
  opts.watcherListUrls = normalizeWatcherListUrls(opts.watcherListUrls);
  opts.watcherUploadCountdownSeconds = clampNumber(opts.watcherUploadCountdownSeconds, DEFAULT_OPTIONS.watcherUploadCountdownSeconds, 0, 120);
  opts.watcherDailyLimit = clampNumber(opts.watcherDailyLimit, DEFAULT_OPTIONS.watcherDailyLimit, 0, WATCHER_DAILY_LIMIT_MAX);
  opts.watcherDailyReportEnabled = opts.watcherDailyReportEnabled === true;
  opts.watcherBadgeCountdownEnabled = opts.watcherBadgeCountdownEnabled !== false;
  opts.watcherNotificationEnabled = opts.watcherNotificationEnabled !== false;
  // PRIVATE_WATCHER_ONLY: Add compact trace level
  opts.watcherTraceLevel = ['off', 'compact', 'normal', 'verbose'].includes(opts.watcherTraceLevel) ? opts.watcherTraceLevel : DEFAULT_OPTIONS.watcherTraceLevel;
  opts.watcherPerfTraceEnabled = opts.watcherPerfTraceEnabled === true;
  opts.watcherPerfFileEnabled = opts.watcherPerfFileEnabled === true;
  opts.watcherReportDir = String(opts.watcherReportDir || '').trim();
  opts.watcherNoDownloadTimeoutMinutes = clampNumber(opts.watcherNoDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherNoDownloadTimeoutMinutes, 0.25, 60);
  opts.watcherDownloadTimeoutMinutes = clampNumber(opts.watcherDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherDownloadTimeoutMinutes, 1, 120);
  opts.watcherTaskTimeoutMinutes = clampNumber(opts.watcherTaskTimeoutMinutes, DEFAULT_OPTIONS.watcherTaskTimeoutMinutes, 1, 180);
  opts.watcherNotifyMode = opts.watcherNotifyMode === 'native' ? 'native' : 'browser';
  opts.watcherCfPauseThreshold = clampNumber(opts.watcherCfPauseThreshold, DEFAULT_OPTIONS.watcherCfPauseThreshold, 1, 10);
  opts.watcherQuantSchedulerEnabled = opts.watcherSchedulerMode !== 'fixed';
  opts.watcherRiskBudgetLimit = clampNumber(opts.watcherRiskBudgetLimit, DEFAULT_OPTIONS.watcherRiskBudgetLimit, 1, 100);
  opts.watcherWorkdays = String(opts.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays).trim();
  opts.watcherWorkWindows = String(opts.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows).trim();
  opts.watcherMonthlyTarget = clampNumber(opts.watcherMonthlyTarget, DEFAULT_OPTIONS.watcherMonthlyTarget, 0, 5000);
  opts.watcherMinDailyTarget = 0;
  opts.watcherMaxDailyTarget = WATCHER_DAILY_LIMIT_MAX;
  opts.watcherMaxPerSession = 1;
  opts.watcherAllowZeroSession = opts.watcherAllowZeroSession === true;
  opts.watcherUseCalendarProgress = opts.watcherUseCalendarProgress !== false;
  Object.assign(opts, normalizeOptions(opts, { normalizeButtonLabel, normalizeHexColor, normalizeButtonPosition }));

  try {
    validateOptions(opts);
    if (saveOptions.suppressWatcherReplan) {
      opts.ablesciSuppressWatcherReplanUntil = Date.now() + 30 * 1000;
    }
    await chrome.storage.local.set(opts);
    if (opts.diagnosticsEnabled !== true) {
      await chrome.storage.local.remove(LAST_DIAGNOSTIC_KEY);
    }
    showText('status', '已保存。已打开的 Ablesci 页面会自动更新，少数情况下刷新页面后生效。');
    const activeLangBefore = globalThis.watcherActiveLanguage;
    const activeLangAfter = getActualLanguage(opts.watcherLanguage);
    if (activeLangBefore !== activeLangAfter) {
      setTimeout(() => { location.reload(); }, 1200);
    }
    return true;
  } catch (err) {
    showText('status', err.message || String(err), true);
    return false;
  }
}

function showPill(id, msg, isErr) {
  const node = el(id);
  if (!node) return;
  const val = t(msg);
  node.textContent = val;
  node.title = val || '';
  node.classList.toggle('ok', !isErr);
  node.classList.toggle('error', !!isErr);
}
const {
  renderAdvancedWatcherStatus,
  startAdvancedCountdownTimer,
  stopAdvancedCountdownTimer
} = createOptionsStatusApi({
  chromeApi: chrome,
  defaultOptions: DEFAULT_OPTIONS,
  autoWatcherStateKey: AUTO_WATCHER_STATE_KEY,
  normalizeWorkdays,
  normalizeWorkWindows,
  isInWorkSchedule,
  formatBeijingDateTime,
  countdownText,
  nextDisplaySchedule,
  todayKeyBeijing,
  setText,
  el
});
const {
  showText,
  testNative,
  copyDiagnostic,
  // PRIVATE_WATCHER_ONLY
  openLocalStorageDir,
  copyAutoWatcherConfig,
  runAutoWatcherNow,
  testWatcherNotification,
  clearAutoWatcherState,
  clearAutoWatcherLogs,
  refreshJournalAccessCacheSummary,
  clearJournalAccessCache,
  simulateAssist,
  handleDocumentCopy,
  handleWindowBlur
} = createOptionsActionsApi({
  chromeApi: chrome,
  el,
  defaultOptions: DEFAULT_OPTIONS,
  lastDiagnosticKey: LAST_DIAGNOSTIC_KEY,
  autoWatcherStateKey: AUTO_WATCHER_STATE_KEY,
  autoWatcherLogKey: AUTO_WATCHER_LOG_KEY,
  autoWatcherTraceKey: AUTO_WATCHER_TRACE_KEY,
  loadOptions,
  watcherOptionSnapshot,
  todayKeyBeijing,
  nativeFailureHelp,
  showPill,
  setText,
  save,
  // PRIVATE_WATCHER_ONLY
  openLocalStorageDirFromNative
});

document.addEventListener('copy', handleDocumentCopy);

document.addEventListener('DOMContentLoaded', () => {
  load().then(() => {
    refreshJournalAccessCacheSummary?.();
    startAdvancedCountdownTimer();
  });



  // 防止快速双击/连击 summary 展开/收起时导致页面文本被全选或选中
  document.querySelectorAll('summary').forEach(summary => {
    summary.addEventListener('mousedown', e => {
      if (e.detail > 1) {
        e.preventDefault();
      }
    });
  });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAdvancedCountdownTimer();
  } else {
    renderAdvancedWatcherStatus().then(startAdvancedCountdownTimer);
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[AUTO_WATCHER_STATE_KEY] || changes.watcherWorkdays || changes.watcherWorkWindows || changes.watcherEnabled) {
    renderAdvancedWatcherStatus().catch(() => {});
  }
  if (changes[AUTO_WATCHER_STATE_KEY]) {
    refreshJournalAccessCacheSummary?.();
  }
});
window.addEventListener('blur', () => {
  handleWindowBlur();
});
el('save').addEventListener('click', save);
el('testNative').addEventListener('click', testNative);
// PRIVATE_WATCHER_ONLY
el('openLocalStorageDir')?.addEventListener('click', openLocalStorageDir);
el('copyDiagnostic').addEventListener('click', copyDiagnostic);
el('runAutoWatcherNow')?.addEventListener('click', runAutoWatcherNow);
el('testWatcherNotification')?.addEventListener('click', testWatcherNotification);
el('copyAutoWatcherConfig')?.addEventListener('click', copyAutoWatcherConfig);
el('clearAutoWatcherState')?.addEventListener('click', clearAutoWatcherState);
el('clearAutoWatcherLogs')?.addEventListener('click', clearAutoWatcherLogs);
el('clearJournalAccessCache')?.addEventListener('click', clearJournalAccessCache);
el('btnDebugSimulate')?.addEventListener('click', simulateAssist);
