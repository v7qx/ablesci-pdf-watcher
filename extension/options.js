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
  maxAutoUploadMB: 99,
  debugDownloadOnly: false,
  autoRemoveHtmlDownloads: false,
  smartRecommendPush: true,
  buttonLabel: '上传PDF',
  buttonColor: '#FF5722',
  buttonTextColor: '#ffffff',
  buttonPosition: 'end'
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

async function loadOptions() {
  const local = await chrome.storage.local.get(ids);
  const normalizeOptions = opts => ({
    ...opts,
    downloadSubdir: '',
    moveToDir: '',
    downloadMode: 'auto',
    scienceDirectTabMode: 'silent_then_visible',
    buttonLabel: normalizeButtonLabel(opts.buttonLabel),
    buttonColor: normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor),
    buttonTextColor: normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor),
    buttonPosition: normalizeButtonPosition(opts.buttonPosition)
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
    else node.value = opts[id] ?? '';
  }
}

function validateOptions(opts) {
  const minMB = Number(opts.minAutoUploadMB);
  const maxMB = Number(opts.maxAutoUploadMB);
  if (!Number.isFinite(minMB) || minMB < 0) throw new Error('最小体积必须大于或等于 0。');
  if (!Number.isFinite(maxMB) || maxMB < 0) throw new Error('最大体积必须大于或等于 0。');
  if (maxMB > 0 && minMB > maxMB) throw new Error('最小体积不能大于最大体积。');
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
  opts.maxAutoUploadMB = Number(opts.maxAutoUploadMB);
  opts.buttonLabel = normalizeButtonLabel(opts.buttonLabel);
  opts.buttonColor = normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor);
  opts.buttonTextColor = normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor);
  opts.buttonPosition = normalizeButtonPosition(opts.buttonPosition);

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

document.addEventListener('DOMContentLoaded', load);
el('save').addEventListener('click', save);
el('testNative').addEventListener('click', testNative);
el('copyDiagnostic').addEventListener('click', copyDiagnostic);
el('clearJournalAccessStats')?.addEventListener('click', clearJournalAccessStats);
