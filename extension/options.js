'use strict';

const DEFAULT_OPTIONS = {
  nativeHostName: 'com.ablesci.pdf_watcher_private',
  downloadSubdir: '',
  downloadMode: 'auto',
  scienceDirectTabMode: 'silent_then_visible',
  moveToDir: '',
  deleteAfterUpload: false,
  keepDownloadHistory: true,
  browserDownloadConfigured: false,
  minAutoUploadMB: 1,
  minAutoUploadUnit: 'MB',
  maxAutoUploadMB: 99,
  maxAutoUploadUnit: 'MB',
  debugDownloadOnly: false,
  autoRemoveHtmlDownloads: false,
  smartRecommendPush: true,
  openAssistLinksInCurrentTab: false,
  buttonLabel: '上传PDF',
  buttonColor: '#FF5722',
  buttonTextColor: '#ffffff',
  buttonPosition: 'end',
  watcherEnabled: false,
  watcherSchedulerMode: 'quant',
  watcherIntervalMinutes: 30,
  watcherMinIntervalMinutes: 10,
  watcherMaxIntervalMinutes: 60,
  watcherMaxCandidatesPerRun: 1,
  watcherListUrls: [
    'https://www.ablesci.com/assist/index?status=waiting&publisher=elsevier&page=3',
    'https://www.ablesci.com/assist/index?status=waiting&publisher=rsc'
  ],
  watcherRequireDoi: true,
  watcherSkipReported: true,
  watcherSkipRejected: true,
  watcherSkipSupplement: true,
  watcherSkipRiskText: true,
  watcherOpenDetail: true,
  watcherAutoDownload: true,
  watcherAutoUpload: false,
  watcherUploadConfirmRequired: true,
  watcherUploadCountdownSeconds: 10,
  watcherDailyLimit: 10,
  watcherStopOnCfChallenge: true,
  watcherSkipHighRiskJournal: true,
  watcherDailyReportEnabled: true,
  watcherReportDir: '',
  watcherNoDownloadTimeoutMinutes: 1,
  watcherDownloadTimeoutMinutes: 5,
  watcherTaskTimeoutMinutes: 10,
  watcherNotifyMode: 'native',
  watcherTelegramNotifyEnabled: false,
  watcherTelegramConfigPath: '',
  watcherCfPauseThreshold: 3,
  watcherQuantSchedulerEnabled: true,
  watcherAdvancedSchedulerEnabled: false,
  watcherRiskBudgetLimit: 10,
  watcherObserveOnly: false,
  watcherObserveMode: 'assist',
  watcherDemandObserveUrl: 'https://www.ablesci.com/assist/index?status=waiting',
  watcherObserveTimes: '09:30\n11:30\n14:00\n16:30\n18:00',
  watcherObserveIntervalMinutes: 5,
  watcherObserveFallbackMinutes: 180,
  watcherWorkdays: '1,2,3,4,5',
  watcherWorkWindows: '09:00-12:00\n13:30-18:00',
  watcherMonthlyTarget: 2000,
  watcherMinDailyTarget: 5,
  watcherMaxDailyTarget: 40,
  watcherMaxPerSession: 1
};

const ids = Object.keys(DEFAULT_OPTIONS);
const LAST_DIAGNOSTIC_KEY = 'latestDiagnostic';
const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
const AUTO_WATCHER_TRACE_KEY = 'autoWatcherTraceLogs';
const DEMAND_SNAPSHOTS_KEY = 'demandSnapshots';

function el(id) { return document.getElementById(id); }

function normalizeButtonLabel(value) {
  const s = String(value || '').trim();
  return s.slice(0, 20) || DEFAULT_OPTIONS.buttonLabel;
}

function normalizeHexColor(value, fallback) {
  const s = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

function normalizeButtonPosition(value) {
  return value === 'start' ? 'start' : 'end';
}

function normalizeSizeUnit(value) {
  return String(value || '').toUpperCase() === 'KB' ? 'KB' : 'MB';
}

function sanitizePathPart(s) {
  return String(s || '')
    .replace(/^[\\/]+/, '')
    .replace(/\.\.+/g, '_')
    .replace(/[<>:"|?*]+/g, '_')
    .replace(/\\+/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeWatcherListUrls(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const urls = raw
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .filter(url => {
      try {
        const u = new URL(url);
        return u.protocol === 'https:' && /(^|\.)ablesci\.com$/i.test(u.hostname);
      } catch (_) {
        return false;
      }
    });
  const next = urls.length ? urls : DEFAULT_OPTIONS.watcherListUrls.slice();
  const hasRsc = next.some(url => {
    try {
      const u = new URL(url);
      return /rsc/i.test(u.searchParams.get('publisher') || '');
    } catch (_) {
      return false;
    }
  });
  const hasLegacyElsevier = next.some(url => {
    try {
      const u = new URL(url);
      return /elsevier/i.test(u.searchParams.get('publisher') || '') && u.searchParams.get('status') === 'waiting';
    } catch (_) {
      return false;
    }
  });
  if (!hasRsc && hasLegacyElsevier) {
    next.push('https://www.ablesci.com/assist/index?status=waiting&publisher=rsc');
  }
  return next;
}

function normalizeSchedulerMode(opts) {
  const raw = String(opts?.watcherSchedulerMode || '').trim().toLowerCase();
  if (raw === 'fixed' || raw === 'quant' || raw === 'advanced') return raw;
  if (opts?.watcherAdvancedSchedulerEnabled === true) return 'advanced';
  if (opts?.watcherQuantSchedulerEnabled === false) return 'fixed';
  return 'quant';
}

function normalizeWatcherIntervals(opts) {
  const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
  const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
  return {
    watcherIntervalMinutes: clampNumber(opts.watcherIntervalMinutes, 30, min, max),
    watcherMinIntervalMinutes: min,
    watcherMaxIntervalMinutes: max
  };
}

async function loadOptions() {
  const local = await chrome.storage.local.get(ids);
  const normalizeOptions = opts => {
    const schedulerMode = normalizeSchedulerMode(opts);
    const intervals = normalizeWatcherIntervals(opts);
    return {
    ...opts,
    nativeHostName: opts.nativeHostName === 'com.ablesci.pdf_uploader' ? DEFAULT_OPTIONS.nativeHostName : String(opts.nativeHostName || DEFAULT_OPTIONS.nativeHostName).trim(),
    downloadSubdir: sanitizePathPart(opts.downloadSubdir || ''),
    moveToDir: String(opts.moveToDir || '').trim(),
    downloadMode: 'auto',
    scienceDirectTabMode: 'silent_then_visible',
    minAutoUploadUnit: normalizeSizeUnit(opts.minAutoUploadUnit),
    maxAutoUploadUnit: normalizeSizeUnit(opts.maxAutoUploadUnit),
    buttonLabel: normalizeButtonLabel(opts.buttonLabel),
    buttonColor: normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor),
    buttonTextColor: normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor),
    buttonPosition: normalizeButtonPosition(opts.buttonPosition),
    watcherSchedulerMode: schedulerMode,
    ...intervals,
    watcherMaxCandidatesPerRun: 1,
    watcherListUrls: normalizeWatcherListUrls(opts.watcherListUrls),
    watcherUploadCountdownSeconds: clampNumber(opts.watcherUploadCountdownSeconds, 10, 0, 120),
    watcherDailyLimit: clampNumber(opts.watcherDailyLimit, 10, 0, 100),
    watcherSkipHighRiskJournal: opts.watcherSkipHighRiskJournal !== false,
    watcherDailyReportEnabled: opts.watcherDailyReportEnabled !== false,
    watcherReportDir: String(opts.watcherReportDir || '').trim(),
    watcherNoDownloadTimeoutMinutes: clampNumber(opts.watcherNoDownloadTimeoutMinutes, 1, 0.25, 60),
    watcherDownloadTimeoutMinutes: clampNumber(opts.watcherDownloadTimeoutMinutes, 5, 1, 120),
    watcherTaskTimeoutMinutes: clampNumber(opts.watcherTaskTimeoutMinutes, 10, 1, 180),
    watcherNotifyMode: opts.watcherNotifyMode === 'browser' ? 'browser' : 'native',
    watcherTelegramNotifyEnabled: opts.watcherTelegramNotifyEnabled === true,
    watcherTelegramConfigPath: String(opts.watcherTelegramConfigPath || '').trim(),
    watcherCfPauseThreshold: clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10),
    watcherQuantSchedulerEnabled: schedulerMode !== 'fixed',
    watcherAdvancedSchedulerEnabled: schedulerMode === 'advanced',
    watcherRiskBudgetLimit: clampNumber(opts.watcherRiskBudgetLimit, 10, 1, 100),
    watcherObserveMode: opts.watcherObserveMode === 'observe_only' ? 'observe_only' : 'assist',
    watcherObserveOnly: opts.watcherObserveMode === 'observe_only',
    watcherDemandObserveUrl: normalizeWatcherListUrls([opts.watcherDemandObserveUrl])[0] || DEFAULT_OPTIONS.watcherDemandObserveUrl,
    watcherObserveTimes: String(opts.watcherObserveTimes || DEFAULT_OPTIONS.watcherObserveTimes).trim(),
    watcherObserveIntervalMinutes: clampNumber(opts.watcherObserveIntervalMinutes, 5, 1, 60),
    watcherObserveFallbackMinutes: clampNumber(opts.watcherObserveFallbackMinutes, 180, 30, 720),
    watcherWorkdays: String(opts.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays).trim(),
    watcherWorkWindows: String(opts.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows).trim(),
    watcherMonthlyTarget: clampNumber(opts.watcherMonthlyTarget, 2000, 0, 5000),
    watcherMinDailyTarget: clampNumber(opts.watcherMinDailyTarget, 5, 0, 500),
    watcherMaxDailyTarget: clampNumber(opts.watcherMaxDailyTarget, 40, 1, 500),
    watcherMaxPerSession: clampNumber(opts.watcherMaxPerSession, 1, 1, 10)
  };
  };
  const missingLocal = ids.some(id => local[id] === undefined);
  if (!missingLocal) return normalizeOptions({ ...DEFAULT_OPTIONS, ...local });

  const legacy = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  const migrated = normalizeOptions({ ...DEFAULT_OPTIONS, ...legacy, ...local });
  await chrome.storage.local.set(migrated);
  return migrated;
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
}

function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}

function formatBeijingDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '-';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, item) => {
    acc[item.type] = item.value;
    return acc;
  }, {});
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function todayKeyBeijing() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date()).reduce((acc, item) => {
    acc[item.type] = item.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function renderAdvancedWatcherStatus() {
  const stored = await chrome.storage.local.get([
    AUTO_WATCHER_STATE_KEY,
    'watcherWorkdays',
    'watcherWorkWindows'
  ]);
  const state = stored[AUTO_WATCHER_STATE_KEY] || {};
  const daily = state.daily?.[todayKeyBeijing()] || {};
  setText('advancedMarketRegime', state.marketRegime || state.marketData?.marketRegime || '-');
  setText('advancedWorkProgress', `${Math.round(Number(state.workTimeProgressRatio || 0) * 100)}%`);
  setText('advancedExpectedActual', `${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)}`);
  setText('advancedError', String(Number(state.targetError || state.lag || 0)));
  setText('advancedRateMultiplier', Number(state.rateMultiplier || 1).toFixed(3));
  setText('advancedRiskBudget', `${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`);
  setText('advancedH1Delta', String(Number(state.recentH1DemandDelta || state.marketData?.h1Delta || 0)));
  setText('advancedSessionStatus', state.currentSession?.status || state.lastSession?.status || '-');
  setText('watcherRuntimeLogic', `${state.currentSchedulerMode || '-'} / ${state.currentExecutionModel || '-'}`);
  setText('watcherNextRunAt', formatBeijingDateTime(state.nextScheduledAt));
  setText('watcherNextAssistAt', formatBeijingDateTime(state.nextAssistRunAt));
  setText('watcherRunCounts', `A:${Number(daily.autoRuns || 0)} M:${Number(daily.manualRuns || 0)} O:${Number(daily.manualObserveRuns || 0)}`);
  setText('watcherSavedWorkdays', String(stored.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays));
  const top = (state.banditTopPublishers || [])
    .slice(0, 5)
    .map(item => `${item.source}:${Number(item.score || 0).toFixed(2)}`)
    .join(', ');
  setText('advancedBanditTop', `Bandit top publishers: ${top || '-'}`);
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
  if (opts.watcherDailyLimit < 0) throw new Error('每日上传上限不能小于 0。');
  if (opts.watcherMaxPerSession < 1 || opts.watcherMaxPerSession > 10) {
    throw new Error('每会话最多候选必须在 1–10 之间。');
  }
  if (opts.watcherNoDownloadTimeoutMinutes <= 0 || opts.watcherDownloadTimeoutMinutes <= 0 || opts.watcherTaskTimeoutMinutes <= 0) {
    throw new Error('任务超时时间必须大于 0。');
  }
  if (opts.watcherTaskTimeoutMinutes < opts.watcherNoDownloadTimeoutMinutes || opts.watcherTaskTimeoutMinutes < opts.watcherDownloadTimeoutMinutes) {
    throw new Error('任务最长时间不能小于未触发下载或下载中超时时间。');
  }
  if (!opts.watcherListUrls.length) throw new Error('低频值守列表 URL 不能为空。');
  if (opts.watcherMinDailyTarget > opts.watcherMaxDailyTarget) throw new Error('最小日目标不能大于最大日目标。');
  if (!normalizeWatcherListUrls([opts.watcherDemandObserveUrl]).length) throw new Error('需求采样 URL 必须是 Ablesci HTTPS 链接。');
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
  opts.watcherListUrls = normalizeWatcherListUrls(opts.watcherListUrls);
  opts.watcherUploadCountdownSeconds = clampNumber(opts.watcherUploadCountdownSeconds, DEFAULT_OPTIONS.watcherUploadCountdownSeconds, 0, 120);
  opts.watcherDailyLimit = clampNumber(opts.watcherDailyLimit, DEFAULT_OPTIONS.watcherDailyLimit, 0, 100);
  opts.watcherSkipHighRiskJournal = opts.watcherSkipHighRiskJournal !== false;
  opts.watcherDailyReportEnabled = opts.watcherDailyReportEnabled !== false;
  opts.watcherReportDir = String(opts.watcherReportDir || '').trim();
  opts.watcherNoDownloadTimeoutMinutes = clampNumber(opts.watcherNoDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherNoDownloadTimeoutMinutes, 0.25, 60);
  opts.watcherDownloadTimeoutMinutes = clampNumber(opts.watcherDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherDownloadTimeoutMinutes, 1, 120);
  opts.watcherTaskTimeoutMinutes = clampNumber(opts.watcherTaskTimeoutMinutes, DEFAULT_OPTIONS.watcherTaskTimeoutMinutes, 1, 180);
  opts.watcherNotifyMode = opts.watcherNotifyMode === 'browser' ? 'browser' : 'native';
  opts.watcherTelegramNotifyEnabled = opts.watcherTelegramNotifyEnabled === true;
  opts.watcherTelegramConfigPath = String(opts.watcherTelegramConfigPath || '').trim();
  opts.watcherCfPauseThreshold = clampNumber(opts.watcherCfPauseThreshold, DEFAULT_OPTIONS.watcherCfPauseThreshold, 1, 10);
  opts.watcherQuantSchedulerEnabled = opts.watcherSchedulerMode !== 'fixed';
  opts.watcherAdvancedSchedulerEnabled = opts.watcherSchedulerMode === 'advanced';
  opts.watcherRiskBudgetLimit = clampNumber(opts.watcherRiskBudgetLimit, DEFAULT_OPTIONS.watcherRiskBudgetLimit, 1, 100);
  opts.watcherObserveMode = opts.watcherObserveMode === 'observe_only' ? 'observe_only' : 'assist';
  opts.watcherObserveOnly = opts.watcherObserveMode === 'observe_only';
  opts.watcherDemandObserveUrl = normalizeWatcherListUrls([opts.watcherDemandObserveUrl])[0] || DEFAULT_OPTIONS.watcherDemandObserveUrl;
  opts.watcherObserveTimes = String(opts.watcherObserveTimes || DEFAULT_OPTIONS.watcherObserveTimes).trim();
  opts.watcherObserveIntervalMinutes = clampNumber(opts.watcherObserveIntervalMinutes, DEFAULT_OPTIONS.watcherObserveIntervalMinutes, 1, 60);
  opts.watcherObserveFallbackMinutes = clampNumber(opts.watcherObserveFallbackMinutes, DEFAULT_OPTIONS.watcherObserveFallbackMinutes, 30, 720);
  opts.watcherWorkdays = String(opts.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays).trim();
  opts.watcherWorkWindows = String(opts.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows).trim();
  opts.watcherMonthlyTarget = clampNumber(opts.watcherMonthlyTarget, DEFAULT_OPTIONS.watcherMonthlyTarget, 0, 5000);
  opts.watcherMinDailyTarget = clampNumber(opts.watcherMinDailyTarget, DEFAULT_OPTIONS.watcherMinDailyTarget, 0, 500);
  opts.watcherMaxDailyTarget = clampNumber(opts.watcherMaxDailyTarget, DEFAULT_OPTIONS.watcherMaxDailyTarget, 1, 500);
  opts.watcherMaxPerSession = clampNumber(opts.watcherMaxPerSession, DEFAULT_OPTIONS.watcherMaxPerSession, 1, 10);

  try {
    validateOptions(opts);
    await chrome.storage.local.set(opts);
    showText('status', '已保存。已打开的 Ablesci 页面会自动更新，少数情况下刷新页面后生效。');
  } catch (err) {
    showText('status', err.message || String(err), true);
  }
}

function showText(id, msg, isErr) {
  const node = el(id);
  node.textContent = msg;
  node.style.color = isErr ? 'var(--danger)' : 'var(--ok)';
  setTimeout(() => { node.textContent = ''; }, 7000);
}

function showPill(id, msg, isErr) {
  const node = el(id);
  node.textContent = msg;
  node.classList.toggle('ok', !isErr);
  node.classList.toggle('error', !!isErr);
}

function nativeFailureHelp(message) {
  return '失败：' + message;
}

function testNative() {
  const hostName = el('nativeHostName').value.trim() || DEFAULT_OPTIONS.nativeHostName;
  const status = el('nativeStatus');
  status.classList.remove('ok', 'error');
  status.textContent = '测试中';
  chrome.runtime.sendNativeMessage(hostName, { action: 'ping' }, response => {
    const lastErr = chrome.runtime.lastError;
    if (lastErr) return showPill('nativeStatus', nativeFailureHelp(lastErr.message), true);
    if (!response || !response.ok) return showPill('nativeStatus', '返回异常', true);
    showPill('nativeStatus', '正常：' + response.action);
  });
}

async function copyDiagnostic() {
  const stored = await chrome.storage.local.get(LAST_DIAGNOSTIC_KEY);
  const diagnostic = stored[LAST_DIAGNOSTIC_KEY];
  if (!diagnostic) {
    showPill('diagnosticStatus', '暂无信息', true);
    return;
  }

  const text = JSON.stringify(diagnostic, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    showPill('diagnosticStatus', '已复制');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    showPill('diagnosticStatus', ok ? '已复制' : '复制失败', !ok);
  }
}

function sanitizeUrlForExport(value) {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|cookie|csrf|signature|credential|key|secret|auth/i.test(key)) {
        url.searchParams.set(key, '<redacted>');
      }
    }
    return url.href;
  } catch (_) {
    return String(value || '').replace(/(token|cookie|csrf|signature|credential|key|secret|auth)=([^&\s]+)/ig, '$1=<redacted>');
  }
}

function watcherOptionSnapshot(opts) {
  const snapshot = {};
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (!key.startsWith('watcher')) continue;
    snapshot[key] = key === 'watcherListUrls'
      ? normalizeWatcherListUrls(opts[key]).map(sanitizeUrlForExport)
      : opts[key];
  }
  return snapshot;
}

async function copyAutoWatcherConfig() {
  const opts = await loadOptions();
  const stored = await chrome.storage.local.get([
    AUTO_WATCHER_STATE_KEY,
    AUTO_WATCHER_LOG_KEY,
    AUTO_WATCHER_TRACE_KEY,
    DEMAND_SNAPSHOTS_KEY,
    LAST_DIAGNOSTIC_KEY
  ]);
  const logs = Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [];
  const traceLogs = Array.isArray(stored[AUTO_WATCHER_TRACE_KEY]) ? stored[AUTO_WATCHER_TRACE_KEY] : [];
  const demandSnapshots = Array.isArray(stored[DEMAND_SNAPSHOTS_KEY]) ? stored[DEMAND_SNAPSHOTS_KEY] : [];
  const state = stored[AUTO_WATCHER_STATE_KEY] || {};
  const processed = state.processed || {};
  const diagnostic = stored[LAST_DIAGNOSTIC_KEY] || null;
  const manifest = chrome.runtime.getManifest();

  const payload = {
    exportedAt: new Date().toISOString(),
    extension: {
      name: manifest.name,
      version: manifest.version
    },
    watcherOptions: watcherOptionSnapshot(opts),
    watcherStateSummary: {
      processedCount: Object.keys(processed).length,
      today: state.daily?.[todayKeyBeijing()] || null,
      currentSchedulerMode: state.currentSchedulerMode || '',
      currentExecutionModel: state.currentExecutionModel || '',
      nextScheduledAt: state.nextScheduledAt ? new Date(state.nextScheduledAt).toISOString() : '',
      nextAssistRunAt: state.nextAssistRunAt || '',
      nextAssistStrategy: state.nextAssistStrategy || '',
      nextAssistReason: state.nextAssistReason || '',
      nextAssistDelayMinutes: state.nextAssistDelayMinutes || '',
      nextAssistModelDelayMinutes: state.nextAssistModelDelayMinutes || '',
      nextAssistGuardMinutes: state.nextAssistGuardMinutes || '',
      nextAssistPlan: state.nextAssistPlan || null,
      lastAssistStrategy: state.lastAssistStrategy || '',
      lastAssistDecisionAt: state.lastAssistDecisionAt || '',
      lastAssistDecision: state.lastAssistDecision || null,
      lastRunTrigger: state.lastRunTrigger || '',
      lastRunStartedAt: state.lastRunStartedAt || '',
      lastRunFinishedAt: state.lastRunFinishedAt || '',
      lastRunResult: state.lastRunResult || null,
      runStats: state.runStats || {},
      schedulerModelMode: state.schedulerModelMode || '',
      marketRegime: state.marketRegime || state.marketData?.marketRegime || '',
      workTimeProgressRatio: state.workTimeProgressRatio || 0,
      expectedDone: state.expectedDone || 0,
      actualDone: state.actualDone || state.monthDone || 0,
      targetError: state.targetError || state.lag || 0,
      rateMultiplier: state.rateMultiplier || 1,
      riskUsed: state.riskUsed || 0,
      riskLimit: state.riskLimit || 0,
      recentH1DemandDelta: state.recentH1DemandDelta || state.marketData?.h1Delta || 0,
      currentSession: state.currentSession || null,
      banditTopPublishers: state.banditTopPublishers || []
    },
    latestWatcherLog: logs[0] || null,
    latestTraceLogs: traceLogs.slice(0, 80),
    latestDemandSnapshot: demandSnapshots[0] || null,
    latestDiagnostic: diagnostic ? {
      time: diagnostic.time || '',
      stage: diagnostic.stage || '',
      assistId: diagnostic.assistId || '',
      doi: diagnostic.doi || '',
      journalName: diagnostic.journalName || '',
      assistDetailUrl: diagnostic.assistDetailUrl || diagnostic.pageUrl || '',
      publisherHost: diagnostic.publisherHost || '',
      pickedUrl: diagnostic.pickedUrl || null,
      source: diagnostic.source || '',
      error: diagnostic.error || ''
    } : null
  };

  const text = JSON.stringify(payload, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    showPill('watcherConfigStatus', '已复制');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    showPill('watcherConfigStatus', ok ? '已复制' : '复制失败', !ok);
  }
}

async function clearJournalAccessStats() {
  await chrome.storage.local.remove(JOURNAL_ACCESS_STATS_KEY);
  showText('status', '已清除本地期刊失败记录。');
}

function sendRuntimeMessage(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return resolve({ ok: false, reason: lastErr.message });
      resolve(response || { ok: true });
    });
  });
}

async function runAutoWatcherNow() {
  showPill('watcherRunStatus', '检查中');
  const res = await sendRuntimeMessage({ type: 'ablesciRunAutoWatcherNow' });
  showPill('watcherRunStatus', res.ok ? (res.reason || '已完成') : ('失败：' + (res.reason || '未知错误')), !res.ok);
}

async function observeDemandNow() {
  showPill('watcherRunStatus', '采样中');
  const res = await sendRuntimeMessage({ type: 'ablesciObserveDemandNow' });
  showPill('watcherRunStatus', res.ok ? (res.reason || '已采样') : ('失败：' + (res.reason || '未知错误')), !res.ok);
}

async function testWatcherNotification() {
  await save();
  showPill('watcherNotifyStatus', '发送中');
  const res = await sendRuntimeMessage({ type: 'ablesciTestWatcherNotification' });
  const mode = res.mode === 'browser' ? '浏览器' : 'Native';
  showPill(
    'watcherNotifyStatus',
    res.ok ? `${mode} 已发送` : `${mode} 失败：${res.reason || '未知错误'}`,
    !res.ok
  );
}

async function clearAutoWatcherState() {
  const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherState' });
  showText('status', res.ok ? '已清除 watcher 已处理记录。' : '清除失败：' + (res.reason || '未知错误'), !res.ok);
}

async function clearAutoWatcherLogs() {
  const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherLogs' });
  showText('status', res.ok ? '已清除 watcher 日志和 trace。' : '清除失败：' + (res.reason || '未知错误'), !res.ok);
}

document.addEventListener('DOMContentLoaded', load);
el('save').addEventListener('click', save);
el('testNative').addEventListener('click', testNative);
el('copyDiagnostic').addEventListener('click', copyDiagnostic);
el('clearJournalAccessStats')?.addEventListener('click', clearJournalAccessStats);
el('runAutoWatcherNow')?.addEventListener('click', runAutoWatcherNow);
el('observeDemandNow')?.addEventListener('click', observeDemandNow);
el('testWatcherNotification')?.addEventListener('click', testWatcherNotification);
el('copyAutoWatcherConfig')?.addEventListener('click', copyAutoWatcherConfig);
el('clearAutoWatcherState')?.addEventListener('click', clearAutoWatcherState);
el('clearAutoWatcherLogs')?.addEventListener('click', clearAutoWatcherLogs);
