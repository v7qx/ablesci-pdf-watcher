'use strict';

const {
  DEFAULT_OPTIONS,
  WATCHER_DAILY_LIMIT_MAX,
  sanitizePathPart,
  normalizeSizeUnit,
  clampNumber,
  normalizeSchedulerMode,
  normalizeWatcherIntervals,
  normalizeWatcherListUrls,
  parseJournalAccessRules,
  normalizeOptions
} = globalThis.AblesciWatcherConfig;
const {
  OPTION_IDS: ids,
  LAST_DIAGNOSTIC_KEY,
  JOURNAL_ACCESS_STATS_KEY,
  JOURNAL_ACCESS_LOOKUP_KEY,
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
  journalAccessSummary,
  sanitizeUrlForExport,
  watcherOptionSnapshot
} = createOptionsHelpersApi({
  defaultOptions: DEFAULT_OPTIONS,
  normalizeWorkdaysSet,
  normalizeWorkWindowsDetailed,
  parseJournalAccessRules,
  normalizeWatcherListUrls
});
const { createOptionsNativeApi } = globalThis.AblesciOptionsNative;
const {
  nativeFailureHelp,
  renderJournalAccessConfigStatus: renderJournalAccessConfigStatusFromNative,
  reloadJournalAccessConfig: reloadJournalAccessConfigFromNative,
  openConfigDir: openConfigDirFromNative
} = createOptionsNativeApi({
  chromeApi: chrome,
  defaultOptions: DEFAULT_OPTIONS,
  parseJournalAccessRules,
  el,
  setText,
  showPill
});

function el(id) { return document.getElementById(id); }

async function loadOptions() {
  const uiNormalizers = { normalizeButtonLabel, normalizeHexColor, normalizeButtonPosition };
  return loadOptionsFromStorage(uiNormalizers);
}

async function load() {
  const opts = await loadOptions();
  for (const id of ids) {
    const node = el(id);
    if (!node) continue;
    if (node.type === 'checkbox') node.checked = !!opts[id];
    else if (id === 'watcherListUrls') node.value = normalizeWatcherListUrls(opts[id]).join('\n');
    else node.value = opts[id] ?? '';
  }
  await renderAdvancedWatcherStatus();
  await renderJournalAccessConfigStatusFromNative(opts, loadOptions);
}

function setText(id, value) {
  const node = el(id);
  if (node) {
    node.textContent = value;
    node.title = String(value ?? '');
  }
}

function validateOptions(opts) {
  const minValue = Number(opts.minAutoUploadMB);
  const maxValue = Number(opts.maxAutoUploadMB);
  if (!Number.isFinite(minValue) || minValue < 0) throw new Error('最小体积必须大于或等于 0。');
  if (!Number.isFinite(maxValue) || maxValue < 0) throw new Error('最大体积必须大于或等于 0。');
  const unitFactor = unit => normalizeSizeUnit(unit) === 'KB' ? 1024 : 1024 * 1024;
  const minBytes = Math.round(minValue * unitFactor(opts.minAutoUploadUnit));
  const maxBytes = Math.round(maxValue * unitFactor(opts.maxAutoUploadUnit));
  if (maxBytes > 0 && minBytes > maxBytes) throw new Error('最小体积不能大于最大体积。');

  if (opts.watcherIntervalMinutes < 1 || opts.watcherIntervalMinutes > 1440) {
    throw new Error('低频值守应助间隔必须在 1–1440 分钟之间。');
  }
  if (opts.watcherMinIntervalMinutes < 1 || opts.watcherMaxIntervalMinutes > 1440 || opts.watcherMinIntervalMinutes > opts.watcherMaxIntervalMinutes) {
    throw new Error('随机应助间隔范围必须在 1–1440 分钟之间，且最小值不能大于最大值。');
  }
  if (opts.watcherDailyLimit < 0) throw new Error('每日应助上限不能小于 0。');
  if (opts.watcherMinNonSdSeekingCount < 0) throw new Error('非 SD 最低求助量不能小于 0。');
  if (opts.watcherNoDownloadTimeoutMinutes <= 0 || opts.watcherDownloadTimeoutMinutes <= 0 || opts.watcherTaskTimeoutMinutes <= 0) {
    throw new Error('任务超时时间必须大于 0。');
  }
  if (opts.watcherTaskTimeoutMinutes < opts.watcherNoDownloadTimeoutMinutes || opts.watcherTaskTimeoutMinutes < opts.watcherDownloadTimeoutMinutes) {
    throw new Error('任务最长时间不能小于未触发下载或下载中超时时间。');
  }
  if (!opts.watcherListUrls.length) throw new Error('低频值守列表 URL 不能为空。');
  if (String(opts.watcherJournalAccessRules || '').trim()) {
    try {
      const parsed = JSON.parse(opts.watcherJournalAccessRules || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('期刊访问名单必须是 JSON 对象。');
      for (const key of ['blocked', 'allowed', 'partial', 'unknown']) {
        if (parsed[key] !== undefined && !Array.isArray(parsed[key])) throw new Error(`${key} 必须是数组。`);
      }
    } catch (err) {
      throw new Error('期刊访问名单 JSON 无效：' + (err?.message || String(err)));
    }
  }
}

async function save() {
  const opts = await loadOptions();
  for (const id of ids) {
    const node = el(id);
    if (!node) continue;
    opts[id] = node.type === 'checkbox' ? node.checked : node.value.trim();
  }

  opts.downloadSubdir = sanitizePathPart(opts.downloadSubdir || '');
  opts.moveToDir = String(opts.moveToDir || '').trim();
  opts.downloadMode = 'auto';
  opts.scienceDirectTabMode = 'silent_then_visible';
  opts.minAutoUploadMB = Number(opts.minAutoUploadMB);
  opts.minAutoUploadUnit = normalizeSizeUnit(opts.minAutoUploadUnit);
  opts.maxAutoUploadMB = Number(opts.maxAutoUploadMB);
  opts.maxAutoUploadUnit = normalizeSizeUnit(opts.maxAutoUploadUnit);
  opts.buttonLabel = normalizeButtonLabel(opts.buttonLabel);
  opts.buttonColor = normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor);
  opts.buttonTextColor = normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor);
  opts.buttonPosition = normalizeButtonPosition(opts.buttonPosition);
  opts.watcherSchedulerMode = normalizeSchedulerMode(opts);
  Object.assign(opts, normalizeWatcherIntervals(opts));
  opts.watcherMaxCandidatesPerRun = 1;
  opts.watcherMinNonSdSeekingCount = clampNumber(opts.watcherMinNonSdSeekingCount, DEFAULT_OPTIONS.watcherMinNonSdSeekingCount, 0, 100000);
  opts.watcherListUrls = normalizeWatcherListUrls(opts.watcherListUrls);
  opts.watcherUploadCountdownSeconds = clampNumber(opts.watcherUploadCountdownSeconds, DEFAULT_OPTIONS.watcherUploadCountdownSeconds, 0, 120);
  opts.watcherDailyLimit = clampNumber(opts.watcherDailyLimit, DEFAULT_OPTIONS.watcherDailyLimit, 0, WATCHER_DAILY_LIMIT_MAX);
  opts.watcherSkipHighRiskJournal = opts.watcherSkipHighRiskJournal !== false;
  opts.watcherDailyReportEnabled = opts.watcherDailyReportEnabled !== false;
  opts.watcherBadgeCountdownEnabled = opts.watcherBadgeCountdownEnabled !== false;
  opts.watcherNotificationEnabled = opts.watcherNotificationEnabled !== false;
  opts.watcherTraceLevel = ['off', 'normal', 'verbose'].includes(opts.watcherTraceLevel) ? opts.watcherTraceLevel : DEFAULT_OPTIONS.watcherTraceLevel;
  opts.watcherReportDir = String(opts.watcherReportDir || '').trim();
  opts.watcherConfigDir = String(opts.watcherConfigDir || '').trim();
  opts.watcherNoDownloadTimeoutMinutes = clampNumber(opts.watcherNoDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherNoDownloadTimeoutMinutes, 0.25, 60);
  opts.watcherDownloadTimeoutMinutes = clampNumber(opts.watcherDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherDownloadTimeoutMinutes, 1, 120);
  opts.watcherTaskTimeoutMinutes = clampNumber(opts.watcherTaskTimeoutMinutes, DEFAULT_OPTIONS.watcherTaskTimeoutMinutes, 1, 180);
  opts.watcherNotifyMode = opts.watcherNotifyMode === 'native' ? 'native' : 'browser';
  opts.watcherTelegramNotifyEnabled = opts.watcherTelegramNotifyEnabled === true;
  opts.watcherTelegramConfigPath = String(opts.watcherTelegramConfigPath || '').trim();
  opts.watcherJournalAccessConfigPath = String(opts.watcherJournalAccessConfigPath || '').trim();
  opts.watcherCfPauseThreshold = clampNumber(opts.watcherCfPauseThreshold, DEFAULT_OPTIONS.watcherCfPauseThreshold, 1, 10);
  opts.watcherQuantSchedulerEnabled = opts.watcherSchedulerMode !== 'fixed';
  opts.watcherAdvancedSchedulerEnabled = false;
  opts.watcherRiskBudgetLimit = clampNumber(opts.watcherRiskBudgetLimit, DEFAULT_OPTIONS.watcherRiskBudgetLimit, 1, 100);
  opts.watcherObserveMode = 'assist';
  opts.watcherObserveOnly = false;
  opts.watcherDemandObserveUrl = DEFAULT_OPTIONS.watcherDemandObserveUrl;
  opts.watcherObserveTimes = DEFAULT_OPTIONS.watcherObserveTimes;
  opts.watcherObserveIntervalMinutes = DEFAULT_OPTIONS.watcherObserveIntervalMinutes;
  opts.watcherObserveFallbackMinutes = DEFAULT_OPTIONS.watcherObserveFallbackMinutes;
  opts.watcherWorkdays = String(opts.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays).trim();
  opts.watcherWorkWindows = String(opts.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows).trim();
  opts.watcherMonthlyTarget = clampNumber(opts.watcherMonthlyTarget, DEFAULT_OPTIONS.watcherMonthlyTarget, 0, 5000);
  opts.watcherMinDailyTarget = 0;
  opts.watcherMaxDailyTarget = WATCHER_DAILY_LIMIT_MAX;
  opts.watcherMaxPerSession = 1;
  opts.watcherAllowZeroSession = opts.watcherAllowZeroSession === true;
  opts.watcherUseCalendarProgress = opts.watcherUseCalendarProgress !== false;
  opts.watcherJournalAccessRules = String(opts.watcherJournalAccessRules || '').trim();
  Object.assign(opts, normalizeOptions(opts, { normalizeButtonLabel, normalizeHexColor, normalizeButtonPosition }));

  try {
    validateOptions(opts);
    await chrome.storage.local.set(opts);
    showText('status', '已保存。已打开的 Ablesci 页面会自动更新，少数情况下刷新页面后生效。');
    return true;
  } catch (err) {
    showText('status', err.message || String(err), true);
    return false;
  }
}

function showPill(id, msg, isErr) {
  const node = el(id);
  node.textContent = msg;
  node.title = msg || '';
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
  setText
});
const {
  showText,
  testNative,
  copyDiagnostic,
  reloadJournalAccessConfig,
  openConfigDir,
  copyAutoWatcherConfig,
  clearJournalAccessStats,
  runAutoWatcherNow,
  testWatcherNotification,
  clearAutoWatcherState,
  clearAutoWatcherLogs,
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
  journalAccessStatsKey: JOURNAL_ACCESS_STATS_KEY,
  journalAccessLookupKey: JOURNAL_ACCESS_LOOKUP_KEY,
  loadOptions,
  watcherOptionSnapshot,
  todayKeyBeijing,
  nativeFailureHelp,
  showPill,
  setText,
  save,
  reloadJournalAccessConfigFromNative,
  openConfigDirFromNative
});

document.addEventListener('copy', handleDocumentCopy);

document.addEventListener('DOMContentLoaded', () => {
  load().then(() => {
    startAdvancedCountdownTimer();
    const calendarProgressInput = el('watcherUseCalendarProgress');
    const workTimeRow = el('watcherWorkTimeRow');
    if (calendarProgressInput && workTimeRow) {
      const updateVisibility = () => {
        workTimeRow.style.display = calendarProgressInput.checked ? 'none' : '';
      };
      calendarProgressInput.addEventListener('change', updateVisibility);
      updateVisibility();
    }
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
});
window.addEventListener('blur', () => {
  handleWindowBlur();
});
el('save').addEventListener('click', save);
el('testNative').addEventListener('click', testNative);
el('copyDiagnostic').addEventListener('click', copyDiagnostic);
el('clearJournalAccessStats')?.addEventListener('click', clearJournalAccessStats);
el('runAutoWatcherNow')?.addEventListener('click', runAutoWatcherNow);
el('testWatcherNotification')?.addEventListener('click', testWatcherNotification);
el('copyAutoWatcherConfig')?.addEventListener('click', copyAutoWatcherConfig);
el('clearAutoWatcherState')?.addEventListener('click', clearAutoWatcherState);
el('clearAutoWatcherLogs')?.addEventListener('click', clearAutoWatcherLogs);
el('openWatcherConfigDir')?.addEventListener('click', openConfigDir);
el('reloadJournalAccessConfig')?.addEventListener('click', reloadJournalAccessConfig);
