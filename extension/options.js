'use strict';

const DEFAULT_OPTIONS = {
  nativeHostName: 'com.ablesci.pdf_uploader',
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
  watcherIntervalMinutes: 30,
  watcherMinIntervalMinutes: 10,
  watcherMaxIntervalMinutes: 60,
  watcherMaxCandidatesPerRun: 1,
  watcherListUrls: [
    'https://www.ablesci.com/assist/index?status=waiting&publisher=elsevier&page=3'
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
  watcherSkipHighRiskJournal: false
};

const ids = Object.keys(DEFAULT_OPTIONS);
const LAST_DIAGNOSTIC_KEY = 'latestDiagnostic';
const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';

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
  return urls.length ? urls : DEFAULT_OPTIONS.watcherListUrls.slice();
}

async function loadOptions() {
  const local = await chrome.storage.local.get(ids);
  const normalizeOptions = opts => ({
    ...opts,
    downloadSubdir: '',
    moveToDir: '',
    downloadMode: 'auto',
    scienceDirectTabMode: 'silent_then_visible',
    minAutoUploadUnit: normalizeSizeUnit(opts.minAutoUploadUnit),
    maxAutoUploadUnit: normalizeSizeUnit(opts.maxAutoUploadUnit),
    buttonLabel: normalizeButtonLabel(opts.buttonLabel),
    buttonColor: normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor),
    buttonTextColor: normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor),
    buttonPosition: normalizeButtonPosition(opts.buttonPosition),
    watcherIntervalMinutes: clampNumber(opts.watcherIntervalMinutes, 30, 10, 60),
    watcherMinIntervalMinutes: clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 60),
    watcherMaxIntervalMinutes: clampNumber(opts.watcherMaxIntervalMinutes, 60, 10, 1440),
    watcherMaxCandidatesPerRun: 1,
    watcherListUrls: normalizeWatcherListUrls(opts.watcherListUrls),
    watcherUploadCountdownSeconds: clampNumber(opts.watcherUploadCountdownSeconds, 10, 0, 120),
    watcherDailyLimit: clampNumber(opts.watcherDailyLimit, 10, 0, 100)
  });
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

  if (opts.watcherIntervalMinutes < 10 || opts.watcherIntervalMinutes > 60) {
    throw new Error('低频值守检查间隔必须在 10–60 分钟之间。');
  }
  if (opts.watcherDailyLimit < 0) throw new Error('每日上传上限不能小于 0。');
  if (!opts.watcherListUrls.length) throw new Error('低频值守列表 URL 不能为空。');
}

async function save() {
  const opts = await loadOptions();
  for (const id of ids) {
    const node = el(id);
    if (!node) continue;
    opts[id] = node.type === 'checkbox' ? node.checked : node.value.trim();
  }

  opts.downloadSubdir = '';
  opts.moveToDir = '';
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
  opts.watcherIntervalMinutes = clampNumber(opts.watcherIntervalMinutes, DEFAULT_OPTIONS.watcherIntervalMinutes, 10, 60);
  opts.watcherMinIntervalMinutes = DEFAULT_OPTIONS.watcherMinIntervalMinutes;
  opts.watcherMaxIntervalMinutes = DEFAULT_OPTIONS.watcherMaxIntervalMinutes;
  opts.watcherMaxCandidatesPerRun = 1;
  opts.watcherListUrls = normalizeWatcherListUrls(opts.watcherListUrls);
  opts.watcherUploadCountdownSeconds = clampNumber(opts.watcherUploadCountdownSeconds, DEFAULT_OPTIONS.watcherUploadCountdownSeconds, 0, 120);
  opts.watcherDailyLimit = clampNumber(opts.watcherDailyLimit, DEFAULT_OPTIONS.watcherDailyLimit, 0, 100);

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

async function clearAutoWatcherState() {
  const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherState' });
  showText('status', res.ok ? '已清除 watcher 已处理记录。' : '清除失败：' + (res.reason || '未知错误'), !res.ok);
}

async function clearAutoWatcherLogs() {
  const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherLogs' });
  showText('status', res.ok ? '已清除 watcher 日志。' : '清除失败：' + (res.reason || '未知错误'), !res.ok);
}

document.addEventListener('DOMContentLoaded', load);
el('save').addEventListener('click', save);
el('testNative').addEventListener('click', testNative);
el('copyDiagnostic').addEventListener('click', copyDiagnostic);
el('clearJournalAccessStats')?.addEventListener('click', clearJournalAccessStats);
el('runAutoWatcherNow')?.addEventListener('click', runAutoWatcherNow);
el('clearAutoWatcherState')?.addEventListener('click', clearAutoWatcherState);
el('clearAutoWatcherLogs')?.addEventListener('click', clearAutoWatcherLogs);
