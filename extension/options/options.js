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

// Translation table (zh source text -> en) lives in options/options_i18n.js,
// loaded before this file in options.html.
const { TEXT_MAP } = globalThis.AblesciOptionsI18n;

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
      descNode.textContent = 'One Ablesci assist list URL per line. Each run randomly picks one source and one page, then processes at most one candidate. Add &page_min=1&page_max=5 to limit the page range.';
    }
  }

  syncPublisherChecksFromUrls();
  await renderAdvancedWatcherStatus();
}

const WATCHER_PUBLISHER_LIST_BASE = 'https://www.ablesci.com/assist/index?status=waiting&publisher=';

// Publisher quick-pick: convenience that writes editable list URLs (one per
// checked publisher) into the watcherListUrls textarea. The textarea stays the
// source of truth; advanced users can edit page ranges or fix a slug by hand.
function generateListUrlsFromPublishers() {
  const slugs = Array.from(document.querySelectorAll('.watcher-publisher'))
    .filter(box => box.checked)
    .map(box => (box.getAttribute('data-slug') || '').trim())
    .filter(Boolean);
  if (!slugs.length) return;
  const textarea = el('watcherListUrls');
  if (textarea) textarea.value = slugs.map(slug => WATCHER_PUBLISHER_LIST_BASE + slug).join('\n');
}

function syncPublisherChecksFromUrls() {
  const textarea = el('watcherListUrls');
  if (!textarea) return;
  const slugs = new Set();
  for (const match of String(textarea.value || '').matchAll(/[?&]publisher=([a-z0-9_-]+)/ig)) {
    slugs.add(match[1].toLowerCase());
  }
  document.querySelectorAll('.watcher-publisher').forEach(box => {
    const slug = (box.getAttribute('data-slug') || '').toLowerCase();
    box.checked = !!slug && slugs.has(slug);
  });
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
  exportJournalAccessCache,
  importJournalAccessCache,
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
el('exportJournalAccessCache')?.addEventListener('click', exportJournalAccessCache);
el('importJournalAccessCache')?.addEventListener('click', importJournalAccessCache);
el('clearJournalAccessCache')?.addEventListener('click', clearJournalAccessCache);
el('btnDebugSimulate')?.addEventListener('click', simulateAssist);
el('watcherPublisherGenerate')?.addEventListener('click', generateListUrlsFromPublishers);
