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
  DEMAND_SNAPSHOTS_KEY,
  loadOptionsFromStorage
} = globalThis.AblesciWatcherStorage;
let advancedStatusCache = null;
let advancedCountdownTimer = null;

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
  await renderJournalAccessConfigStatus(opts);
}

function setText(id, value) {
  const node = el(id);
  if (node) {
    node.textContent = value;
    node.title = String(value ?? '');
  }
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

function countdownText(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '-';
  const seconds = Math.max(0, Math.round((date.getTime() - Date.now()) / 1000));
  if (seconds <= 0) return '到点';
  const minutes = Math.floor(seconds / 60);
  const sec = seconds % 60;
  if (minutes < 60) return `${minutes}分${String(sec).padStart(2, '0')}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}时${String(minutes % 60).padStart(2, '0')}分`;
}

function parseMinuteOfDay(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return NaN;
  return hour * 60 + minute;
}

function normalizeWorkdays(value) {
  const items = String(value || DEFAULT_OPTIONS.watcherWorkdays)
    .split(/[,\s]+/)
    .map(item => Number(item.trim()))
    .filter(day => Number.isInteger(day) && day >= 1 && day <= 7);
  return new Set(items);
}

function normalizeWorkWindows(value) {
  return String(value || DEFAULT_OPTIONS.watcherWorkWindows)
    .split(/\r?\n|,/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [startRaw, endRaw] = line.split('-').map(part => part.trim());
      const start = parseMinuteOfDay(startRaw);
      const end = parseMinuteOfDay(endRaw);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
      return { start, end };
    })
    .filter(Boolean);
}

function weekdayNumber(date = new Date()) {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();
  return utc === 0 ? 7 : utc;
}

function beijingMinutesNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date).reduce((acc, item) => {
    acc[item.type] = item.value;
    return acc;
  }, {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function isInWorkSchedule(workdays, workWindows, date = new Date()) {
  if (!workdays.has(weekdayNumber(date))) return false;
  const minute = beijingMinutesNow(date);
  return workWindows.some(win => minute >= win.start && minute < win.end);
}

function nextDisplaySchedule(state = {}) {
  const schedulerMode = state.currentSchedulerMode || '';
  const assistAt = state.nextAssistRunAt || '';
  const wakeAt = state.chromeAlarmScheduledAt || state.nextScheduledAt || '';
  if (schedulerMode === 'fixed') {
    return { nextAssistAt: wakeAt, assistCountdownAt: wakeAt };
  }
  return { nextAssistAt: assistAt, assistCountdownAt: assistAt };
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
    'watcherWorkWindows',
    'watcherEnabled'
  ]);
  const state = stored[AUTO_WATCHER_STATE_KEY] || {};
  const daily = state.daily?.[todayKeyBeijing()] || {};
  const workdays = normalizeWorkdays(stored.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays);
  const workWindows = normalizeWorkWindows(stored.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows);
  const pausedUntilMs = state.riskPausedUntil ? new Date(state.riskPausedUntil).getTime() : 0;
  const workStatus = stored.watcherEnabled !== true
    ? '已关闭'
    : (Number.isFinite(pausedUntilMs) && pausedUntilMs > Date.now()
      ? `风险暂停至 ${formatBeijingDateTime(state.riskPausedUntil)}`
      : ((state.currentSchedulerMode === 'fixed' || isInWorkSchedule(workdays, workWindows)) ? '工作时段内' : '非工作时段'));
  const schedule = nextDisplaySchedule(state);
  advancedStatusCache = { state, schedule };
  setText('advancedMarketRegime', state.marketRegime || state.marketData?.marketRegime || '-');
  setText('watcherWorkStatus', workStatus);
  setText('advancedWorkProgress', `${Math.round(Number(state.workTimeProgressRatio || 0) * 100)}%`);
  setText('advancedActiveProgress', `${Math.round(Number(state.activeTimeProgressRatio || state.workTimeProgressRatio || 0) * 100)}%`);
  setText('advancedAvailability', `${Math.round(Number(state.availabilityFactor || 1) * 100)}%`);
  setText('advancedExpectedActual', `${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)}`);
  setText('advancedError', String(Number(state.targetError || state.lag || 0)));
  setText('advancedRateMultiplier', Number(state.rateMultiplier || 1).toFixed(3));
  setText('advancedRiskBudget', `${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`);
  setText('advancedH1Delta', String(Number(state.recentH1DemandDelta || state.marketData?.h1Delta || 0)));
  setText('advancedSessionStatus', state.currentSession?.status || state.lastSession?.status || '-');
  setText('watcherRuntimeLogic', `${state.currentSchedulerMode || '-'} / ${state.currentExecutionModel || '-'}`);
  setText('watcherNextRunAt', formatBeijingDateTime(state.chromeAlarmScheduledAt || state.nextScheduledAt));
  setText('watcherNextAssistAt', formatBeijingDateTime(schedule.nextAssistAt));
  setText('watcherAssistCountdown', countdownText(schedule.assistCountdownAt));
  setText('watcherWakeCountdown', countdownText(state.chromeAlarmScheduledAt || state.nextScheduledAt));
  setText('watcherRunCounts', `A:${Number(daily.autoRuns || 0)} M:${Number(daily.manualRuns || 0)} O:${Number(daily.manualObserveRuns || 0)}`);
  setText('watcherSavedWorkdays', String(stored.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays));
  const top = (state.banditTopPublishers || [])
    .slice(0, 5)
    .map(item => `${item.source}:${Number(item.score || 0).toFixed(2)}`)
    .join(', ');
  setText('advancedBanditTop', `Bandit top publishers: ${top || '-'}`);
}

function renderAdvancedWatcherCountdowns() {
  if (!advancedStatusCache) return;
  const state = advancedStatusCache.state || {};
  const schedule = advancedStatusCache.schedule || nextDisplaySchedule(state);
  setText('watcherAssistCountdown', countdownText(schedule.assistCountdownAt));
  setText('watcherWakeCountdown', countdownText(state.chromeAlarmScheduledAt || state.nextScheduledAt));
}

function startAdvancedCountdownTimer() {
  if (advancedCountdownTimer || document.hidden) return;
  advancedCountdownTimer = setInterval(renderAdvancedWatcherCountdowns, 1000);
}

function stopAdvancedCountdownTimer() {
  if (!advancedCountdownTimer) return;
  clearInterval(advancedCountdownTimer);
  advancedCountdownTimer = null;
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
  if (String(opts.watcherJournalAccessRules || '').trim()) {
    try {
      const parsed = JSON.parse(opts.watcherJournalAccessRules || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('期刊访问名单必须是 JSON 对象。');
      for (const key of ['blocked', 'allowed', 'partial']) {
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
  opts.watcherNotifyMode = opts.watcherNotifyMode === 'browser' ? 'browser' : 'native';
  opts.watcherTelegramNotifyEnabled = opts.watcherTelegramNotifyEnabled === true;
  opts.watcherTelegramConfigPath = String(opts.watcherTelegramConfigPath || '').trim();
  opts.watcherJournalAccessConfigPath = String(opts.watcherJournalAccessConfigPath || '').trim();
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
  opts.watcherAllowZeroSession = opts.watcherAllowZeroSession === true;
  opts.watcherJournalAccessRules = String(opts.watcherJournalAccessRules || '').trim();
  Object.assign(opts, normalizeOptions(opts, { normalizeButtonLabel, normalizeHexColor, normalizeButtonPosition }));

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
    const ok = await copyTextToClipboard(text);
    if (!ok) throw new Error('copy_failed');
    showPill('diagnosticStatus', '已复制');
  } catch (_) {
    showPill('diagnosticStatus', '复制失败', true);
  }
}

function parseJournalAccessRules(raw) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { blocked: [], allowed: [], partial: [] };
    return {
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
      allowed: Array.isArray(parsed.allowed) ? parsed.allowed : [],
      partial: Array.isArray(parsed.partial) ? parsed.partial : []
    };
  } catch (_) {
    return { blocked: [], allowed: [], partial: [] };
  }
}

function journalAccessSummary(raw) {
  const rules = parseJournalAccessRules(raw);
  return `blocked ${rules.blocked.length} / partial ${rules.partial.length} / allowed ${rules.allowed.length}`;
}

function nativeConfigMessage(action, extra = {}) {
  const hostName = el('nativeHostName')?.value.trim() || DEFAULT_OPTIONS.nativeHostName;
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(hostName, { action, ...extra }, response => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return resolve({ ok: false, error: lastErr.message });
      resolve(response || { ok: false, error: 'Native Helper 没有返回内容' });
    });
  });
}

async function readJournalAccessConfig() {
  return nativeConfigMessage('read_config_file', {
    dir: '',
    config_path: '',
    filename: 'journal-access.json'
  });
}

async function renderJournalAccessConfigStatus(opts = null) {
  const current = opts || await loadOptions();
  const cached = String(current.watcherJournalAccessRules || '').trim();
  setText('journalAccessCacheSummary', cached ? journalAccessSummary(cached) : '缓存为空');
  setText('journalAccessConfigSource', 'Native Helper 目录 / journal-access.json');
  const res = await readJournalAccessConfig();
  if (res.ok) {
    const rules = parseJournalAccessRules(res.body || '');
    const text = JSON.stringify(rules, null, 2);
    const hidden = el('watcherJournalAccessRules');
    if (hidden) hidden.value = text;
    setText('journalAccessFileSummary', `${journalAccessSummary(text)}，已读取`);
    setText('journalAccessConfigSource', res.path || 'Native Helper 目录 / journal-access.json');
    showPill('journalAccessConfigStatus', '已加载文件');
    return;
  }
  setText('journalAccessFileSummary', `未读取文件，使用缓存：${cached ? journalAccessSummary(cached) : '空名单'}`);
  showPill('journalAccessConfigStatus', '使用缓存', false);
}

async function reloadJournalAccessConfig() {
  await save();
  const opts = await loadOptions();
  const res = await readJournalAccessConfig();
  if (!res.ok) {
    showPill('journalAccessConfigStatus', '读取失败：' + (res.error || '未找到文件'), true);
    return;
  }
  try {
    const parsed = parseJournalAccessRules(res.body || '');
    const text = JSON.stringify(parsed, null, 2);
    await chrome.storage.local.set({ watcherJournalAccessRules: text });
    const hidden = el('watcherJournalAccessRules');
    if (hidden) hidden.value = text;
    setText('journalAccessCacheSummary', journalAccessSummary(text));
    setText('journalAccessFileSummary', `${journalAccessSummary(text)}，已同步到缓存`);
    setText('journalAccessConfigSource', res.path || '');
    showPill('journalAccessConfigStatus', '已重载');
  } catch (err) {
    showPill('journalAccessConfigStatus', 'JSON 无效：' + (err?.message || String(err)), true);
  }
}

async function openConfigDir() {
  const hostNode = el('nativeHostName');
  const previousHost = hostNode?.value;
  if (hostNode) hostNode.value = hostNode.value.trim() || DEFAULT_OPTIONS.nativeHostName;
  const res = await nativeConfigMessage('open_config_dir', { dir: '' });
  if (hostNode && previousHost !== undefined) hostNode.value = previousHost;
  showPill('journalAccessConfigStatus', res.ok ? '已打开目录' : '打开失败：' + (res.error || '未知错误'), !res.ok);
  if (res.ok && res.path) setText('journalAccessConfigSource', res.path);
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
    LAST_DIAGNOSTIC_KEY,
    JOURNAL_ACCESS_STATS_KEY,
    JOURNAL_ACCESS_LOOKUP_KEY
  ]);
  const logs = Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [];
  const traceLogs = Array.isArray(stored[AUTO_WATCHER_TRACE_KEY]) ? stored[AUTO_WATCHER_TRACE_KEY] : [];
  const demandSnapshots = Array.isArray(stored[DEMAND_SNAPSHOTS_KEY]) ? stored[DEMAND_SNAPSHOTS_KEY] : [];
  const state = stored[AUTO_WATCHER_STATE_KEY] || {};
  const processed = state.processed || {};
  const diagnostic = stored[LAST_DIAGNOSTIC_KEY] || null;
  const journalAccessStats = stored[JOURNAL_ACCESS_STATS_KEY] || {};
  const journalAccessLookup = stored[JOURNAL_ACCESS_LOOKUP_KEY] || {};
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
      nextAssistGuardMode: state.nextAssistGuardMode || '',
      nextAssistGuardApplied: state.nextAssistGuardApplied === true,
      nextAssistGuardLiftMinutes: state.nextAssistGuardLiftMinutes || '',
      nextAssistGuardWeight: state.nextAssistGuardWeight || '',
      nextAssistPlan: state.nextAssistPlan || null,
      nextAssistPlannedAt: state.nextAssistPlannedAt || '',
      nextAssistPlanningData: state.nextAssistPlanningData || null,
      targetPreview: state.targetPreview || null,
      targetPreviewAt: state.targetPreviewAt || '',
      marketDataAffects: state.marketDataAffects || '',
      chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
      lastAttempt: state.lastAttempt || null,
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
      activeTimeProgressRatio: state.activeTimeProgressRatio || 0,
      availabilityFactor: state.availabilityFactor || 1,
      availabilityActualWakeCount: state.availabilityActualWakeCount || 0,
      availabilityExpectedWakeCount: state.availabilityExpectedWakeCount || 0,
      expectedDone: state.expectedDone || 0,
      actualDone: state.actualDone || state.monthDone || 0,
      targetError: state.targetError || state.lag || 0,
      rateMultiplier: state.rateMultiplier || 1,
      riskUsed: state.riskUsed || 0,
      riskLimit: state.riskLimit || 0,
      recentH1DemandDelta: state.recentH1DemandDelta || state.marketData?.h1Delta || 0,
      currentSession: state.currentSession || null,
      banditTopPublishers: state.banditTopPublishers || [],
      journalAccessStatsCount: Object.keys(journalAccessStats || {}).length,
      journalAccessLookupIndexSize: Object.keys(journalAccessLookup?.index || {}).length,
      journalAccessNoAccessCount: Object.values(journalAccessStats || {}).filter(item => item?.accessState === 'no_access').length,
      journalAccessPartialCount: Object.values(journalAccessStats || {}).filter(item => item?.accessState === 'partial_access').length,
      journalShortNameMapCount: Object.keys(state.journalShortNameMap || {}).length,
      journalShortNameMapPreview: Object.entries(state.journalShortNameMap || {}).slice(0, 10).map(([key, value]) => ({
        key,
        short: typeof value === 'object' ? value.short || '' : '',
        full: typeof value === 'object' ? value.full || '' : String(value || '')
      }))
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
    const ok = await copyTextToClipboard(text);
    if (!ok) throw new Error('copy_failed');
    showPill('watcherConfigStatus', '已复制');
  } catch (_) {
    showPill('watcherConfigStatus', '复制失败', true);
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

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const active = document.activeElement;
    const selection = window.getSelection();
    const savedRanges = [];
    if (selection) {
      for (let i = 0; i < selection.rangeCount; i += 1) savedRanges.push(selection.getRangeAt(i).cloneRange());
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (selection) {
      selection.removeAllRanges();
      savedRanges.forEach(range => selection.addRange(range));
    }
    if (active && typeof active.focus === 'function') active.focus();
    return ok;
  }
}

document.addEventListener('copy', event => {
  const active = document.activeElement;
  const tag = String(active?.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || active?.isContentEditable) return;
  const selection = window.getSelection?.();
  const text = selection ? String(selection.toString() || '') : '';
  if (!text) return;
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[\r\n]+$/, '');
  if (cleaned === text) return;
  event.preventDefault();
  event.clipboardData?.setData('text/plain', cleaned);
});

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

document.addEventListener('DOMContentLoaded', () => {
  load().then(startAdvancedCountdownTimer);
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
  try {
    window.getSelection()?.removeAllRanges();
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  } catch (_) {}
});
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
el('openWatcherConfigDir')?.addEventListener('click', openConfigDir);
el('reloadJournalAccessConfig')?.addEventListener('click', reloadJournalAccessConfig);
