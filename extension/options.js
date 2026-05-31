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
  sanitizePathPart
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
  updateSubdirVisibility();
  await renderAdvancedWatcherStatus();
}

function updateSubdirVisibility() {
  const checkbox = el('enableDownloadSubdir');
  const row = el('downloadSubdirRow');
  if (checkbox && row) {
    row.style.display = checkbox.checked ? '' : 'none';
  }
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

  if (opts.watcherDailyLimit < 0) throw new Error('每日应助上限不能小于 0。');
  if (opts.watcherMinNonSdSeekingCount < 0) throw new Error('非 SD 最低求助量不能小于 0。');
  if (opts.watcherNoDownloadTimeoutMinutes <= 0 || opts.watcherDownloadTimeoutMinutes <= 0 || opts.watcherTaskTimeoutMinutes <= 0) {
    throw new Error('任务超时时间必须大于 0。');
  }
  if (opts.watcherTaskTimeoutMinutes < opts.watcherNoDownloadTimeoutMinutes || opts.watcherTaskTimeoutMinutes < opts.watcherDownloadTimeoutMinutes) {
    throw new Error('任务最长时间不能小于未触发下载或下载中超时时间。');
  }
  if (!opts.watcherListUrls.length) throw new Error('低频值守列表 URL 不能为空。');
}

async function save(saveOptions = {}) {
  const opts = await loadOptions();
  for (const id of ids) {
    const node = el(id);
    if (!node) continue;
    opts[id] = node.type === 'checkbox' ? node.checked : node.value.trim();
  }

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
  opts.watcherOpenDetail = true;
  opts.watcherAutoDownload = true;
  opts.watcherAutoUpload = true;
  opts.watcherUploadConfirmRequired = false;
  opts.watcherMinNonSdSeekingCount = clampNumber(opts.watcherMinNonSdSeekingCount, DEFAULT_OPTIONS.watcherMinNonSdSeekingCount, 0, 100000);
  opts.watcherListUrls = normalizeWatcherListUrls(opts.watcherListUrls);
  opts.watcherUploadCountdownSeconds = clampNumber(opts.watcherUploadCountdownSeconds, DEFAULT_OPTIONS.watcherUploadCountdownSeconds, 0, 120);
  opts.watcherDailyLimit = clampNumber(opts.watcherDailyLimit, DEFAULT_OPTIONS.watcherDailyLimit, 0, WATCHER_DAILY_LIMIT_MAX);
  opts.watcherSkipHighRiskJournal = false;
  opts.watcherDailyReportEnabled = opts.watcherDailyReportEnabled !== false;
  opts.watcherBadgeCountdownEnabled = opts.watcherBadgeCountdownEnabled !== false;
  opts.watcherNotificationEnabled = opts.watcherNotificationEnabled !== false;
  // PRIVATE_WATCHER_ONLY: Add compact trace level
  opts.watcherTraceLevel = ['off', 'compact', 'normal', 'verbose'].includes(opts.watcherTraceLevel) ? opts.watcherTraceLevel : DEFAULT_OPTIONS.watcherTraceLevel;
  opts.watcherReportDir = String(opts.watcherReportDir || '').trim();
  opts.watcherConfigDir = String(opts.watcherConfigDir || '').trim();
  opts.watcherNoDownloadTimeoutMinutes = clampNumber(opts.watcherNoDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherNoDownloadTimeoutMinutes, 0.25, 60);
  opts.watcherDownloadTimeoutMinutes = clampNumber(opts.watcherDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherDownloadTimeoutMinutes, 1, 120);
  opts.watcherTaskTimeoutMinutes = clampNumber(opts.watcherTaskTimeoutMinutes, DEFAULT_OPTIONS.watcherTaskTimeoutMinutes, 1, 180);
  opts.watcherNotifyMode = opts.watcherNotifyMode === 'native' ? 'native' : 'browser';
  opts.watcherJournalAccessConfigPath = '';
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
  opts.watcherJournalAccessRules = '';
  Object.assign(opts, normalizeOptions(opts, { normalizeButtonLabel, normalizeHexColor, normalizeButtonPosition }));

  try {
    validateOptions(opts);
    if (saveOptions.suppressWatcherReplan) {
      opts.ablesciSuppressWatcherReplanUntil = Date.now() + 30 * 1000;
    }
    await chrome.storage.local.set(opts);
    await chrome.storage.local.remove(['journalAccessStats', 'journalAccessLookupIndex']);
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
    startAdvancedCountdownTimer();
  });

  el('enableDownloadSubdir')?.addEventListener('change', updateSubdirVisibility);

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
// PRIVATE_WATCHER_ONLY
el('openLocalStorageDir')?.addEventListener('click', openLocalStorageDir);
el('copyDiagnostic').addEventListener('click', copyDiagnostic);
el('runAutoWatcherNow')?.addEventListener('click', runAutoWatcherNow);
el('testWatcherNotification')?.addEventListener('click', testWatcherNotification);
el('copyAutoWatcherConfig')?.addEventListener('click', copyAutoWatcherConfig);
el('clearAutoWatcherState')?.addEventListener('click', clearAutoWatcherState);
el('clearAutoWatcherLogs')?.addEventListener('click', clearAutoWatcherLogs);
