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
  watcherSkipHighRiskJournal: true,
  watcherDailyReportEnabled: true,
  watcherReportDir: '',
  watcherNotifyMode: 'native',
  watcherCfPauseThreshold: 3,
  watcherQuantSchedulerEnabled: true,
  watcherObserveOnly: false,
  watcherDemandObserveUrl: 'https://www.ablesci.com/assist/index?status=waiting',
  watcherObserveTimes: '09:30\n11:30\n14:00\n16:30\n18:00',
  watcherObserveFallbackMinutes: 180,
  watcherWorkdays: '1,2,3,4,5',
  watcherWorkWindows: '09:00-12:00\n13:30-18:00',
  watcherMonthlyTarget: 500,
  watcherMinDailyTarget: 5,
  watcherMaxDailyTarget: 40,
  watcherMaxPerSession: 1
};

const LAST_DIAGNOSTIC_KEY = 'latestDiagnostic';
const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
const HTML_DOWNLOAD_MESSAGE = '浏览器下载到了 HTML 页面，而不是 PDF。可能是未登录、没有权限、机构认证失效、验证码或出版商错误页。插件已停止，不会上传。';

// tabId -> pending publisher task. 只对插件主动打开的出版商页生效，避免污染普通浏览。
const pendingPublisherTabs = new Map();

// v0.7: 可取消的全局串行队列。
// v0.7 已经解决“多个页面同时下载导致 PDF 错配”的问题，但有一个副作用：
// 如果第一个页面没有权限、出版商验证页迟迟不触发下载，队列会一直等待，后面的页面也无法开始。
// v0.7 将每个任务绑定到它的 Ablesci 页面 Port：页面关闭/刷新/扩展断开时，
// 立即取消该任务、关闭它创建的出版商标签页，并继续处理队列里的下一个任务。
let taskQueue = [];
let activeTask = null;
let nextTaskId = 1;

function post(port, type, message, extra = {}) {
  try {
    port.postMessage({ type, message, ...extra });
  } catch (e) {
    const text = String(e?.message || e || '');
    if (/disconnected port object/i.test(text)) return;
    console.error(e);
  }
}

function makeAbortError(reason) {
  return new Error(reason || '任务已取消');
}

function abortReason(signal, fallback = '任务已取消') {
  if (!signal) return fallback;
  const r = signal.reason;
  if (!r) return fallback;
  if (r instanceof Error) return r.message || fallback;
  return String(r);
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw makeAbortError(abortReason(signal));
}

async function getOptions() {
  const keys = Object.keys(DEFAULT_OPTIONS);
  const local = await chrome.storage.local.get(keys);
  const normalizeOptions = opts => ({
    ...opts,
    nativeHostName: opts.nativeHostName === 'com.ablesci.pdf_uploader' ? DEFAULT_OPTIONS.nativeHostName : String(opts.nativeHostName || DEFAULT_OPTIONS.nativeHostName).trim(),
    downloadSubdir: sanitizePathPart(opts.downloadSubdir || ''),
    moveToDir: String(opts.moveToDir || '').trim(),
    downloadMode: 'auto',
    scienceDirectTabMode: 'silent_then_visible',
    minAutoUploadUnit: normalizeSizeUnit(opts.minAutoUploadUnit),
    maxAutoUploadUnit: normalizeSizeUnit(opts.maxAutoUploadUnit),
    watcherIntervalMinutes: clampNumber(opts.watcherIntervalMinutes, 30, 10, 60),
    watcherMinIntervalMinutes: clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 60),
    watcherMaxIntervalMinutes: clampNumber(opts.watcherMaxIntervalMinutes, 60, 10, 1440),
    watcherMaxCandidatesPerRun: 1,
    watcherListUrls: normalizeWatcherListUrls(opts.watcherListUrls),
    watcherUploadCountdownSeconds: clampNumber(opts.watcherUploadCountdownSeconds, 10, 0, 120),
    watcherDailyLimit: clampNumber(opts.watcherDailyLimit, 10, 0, 100),
    watcherSkipHighRiskJournal: opts.watcherSkipHighRiskJournal !== false,
    watcherDailyReportEnabled: opts.watcherDailyReportEnabled !== false,
    watcherReportDir: String(opts.watcherReportDir || '').trim(),
    watcherNotifyMode: opts.watcherNotifyMode === 'browser' ? 'browser' : 'native',
    watcherCfPauseThreshold: clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10),
    watcherQuantSchedulerEnabled: opts.watcherQuantSchedulerEnabled !== false,
    watcherObserveOnly: opts.watcherObserveOnly === true,
    watcherDemandObserveUrl: normalizeWatcherListUrls([opts.watcherDemandObserveUrl])[0] || DEFAULT_OPTIONS.watcherDemandObserveUrl,
    watcherObserveTimes: String(opts.watcherObserveTimes || DEFAULT_OPTIONS.watcherObserveTimes).trim(),
    watcherObserveFallbackMinutes: clampNumber(opts.watcherObserveFallbackMinutes, 180, 30, 720),
    watcherWorkdays: String(opts.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays).trim(),
    watcherWorkWindows: String(opts.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows).trim(),
    watcherMonthlyTarget: clampNumber(opts.watcherMonthlyTarget, 500, 0, 5000),
    watcherMinDailyTarget: clampNumber(opts.watcherMinDailyTarget, 5, 0, 500),
    watcherMaxDailyTarget: clampNumber(opts.watcherMaxDailyTarget, 40, 1, 500),
    watcherMaxPerSession: clampNumber(opts.watcherMaxPerSession, 1, 1, 4)
  });
  const missingLocal = keys.some(k => local[k] === undefined);
  if (!missingLocal) return normalizeOptions({ ...DEFAULT_OPTIONS, ...local });

  const legacy = await chrome.storage.sync.get(DEFAULT_OPTIONS);
  const migrated = normalizeOptions({ ...DEFAULT_OPTIONS, ...legacy, ...local });
  await chrome.storage.local.set(migrated);
  return migrated;
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
        return /^https:$/.test(u.protocol) && /(^|\.)ablesci\.com$/i.test(u.hostname);
      } catch (_) {
        return false;
      }
    });
  return urls.length ? urls : DEFAULT_OPTIONS.watcherListUrls.slice();
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 2 : 1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatConfiguredSize(value, unit) {
  const n = Number(value);
  const normalizedUnit = normalizeSizeUnit(unit);
  if (!Number.isFinite(n) || n < 0) return `0 ${normalizedUnit}`;
  const digits = normalizedUnit === 'KB' ? 0 : (Number.isInteger(n) ? 0 : 1);
  return `${n.toFixed(digits)} ${normalizedUnit}`;
}

function sanitizeFilename(s) {
  s = String(s || 'paper.pdf')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\.pdf$/i.test(s)) s += '.pdf';
  return s || 'paper.pdf';
}

function makeDownloadFilename(subdir, filename) {
  const cleanFile = sanitizeFilename(filename);
  const cleanDir = sanitizePathPart(subdir || '');
  if (!cleanDir) return cleanFile;
  return cleanDir.replace(/\/+$/g, '') + '/' + cleanFile;
}

function hostnameOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

function urlHostPath(url) {
  try {
    const u = new URL(url || '');
    return { host: u.hostname.toLowerCase(), path: u.pathname || '/' };
  } catch (_) {
    return { host: '', path: '' };
  }
}

function basenameOf(path) {
  const s = String(path || '').replace(/\\/g, '/');
  return s.split('/').filter(Boolean).pop() || '';
}

function extensionOf(path) {
  const base = basenameOf(path).toLowerCase();
  const m = base.match(/\.([a-z0-9]{1,8})$/i);
  return m ? '.' + m[1] : '';
}

function maskId(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 4) return '***';
  return '***' + s.slice(-4);
}

function redactLocalPaths(text) {
  return String(text || '')
    .replace(/[a-zA-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]+)/g, '<local>\\$1')
    .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^/\s"']+)*\/([^/\s"']+)/g, '<local>/$1');
}

function makeDiagnosticBase(payload, opts) {
  return {
    time: new Date().toISOString(),
    assistId: maskId(payload?.assistId),
    doi: payload?.doi || '',
    journalName: payload?.journalName || '',
    assistDetailUrl: payload?.pageUrl || '',
    publisherHost: hostnameOf(payload?.pdfUrl || ''),
    pickedUrl: urlHostPath(payload?.pdfUrl || ''),
    source: payload?.pdfUrlSource || '',
    downloadMode: opts?.downloadMode || 'auto'
  };
}

async function recordJournalAccessResult(payload, result) {
  const journal = String(payload?.journalName || '').trim();
  if (!journal) return;

  const stored = await chrome.storage.local.get(JOURNAL_ACCESS_STATS_KEY);
  const stats = stored[JOURNAL_ACCESS_STATS_KEY] || {};
  const item = stats[journal] || {
    failCount: 0,
    successCount: 0,
    lastFailAt: '',
    lastSuccessAt: '',
    lastReason: '',
    lastDoi: '',
    lastTitle: ''
  };

  if (result?.ok) {
    item.successCount += 1;
    item.lastSuccessAt = new Date().toISOString();
  } else {
    item.failCount += 1;
    item.lastFailAt = new Date().toISOString();
    item.lastReason = result?.reason || 'unknown';
    item.lastDoi = payload?.doi || '';
    item.lastTitle = payload?.title || payload?.suggestedFilename || '';
  }

  stats[journal] = item;
  await chrome.storage.local.set({ [JOURNAL_ACCESS_STATS_KEY]: stats });
}

function classifyJournalAccessFailureReason(err) {
  const raw = String(err?.message || err || '');
  if (!raw) return '';
  if (/任务已取消|Ablesci 页面已关闭或刷新|页面已关闭|已停止等待下载/i.test(raw)) return 'user_cancelled';
  if (raw.includes(HTML_DOWNLOAD_MESSAGE)) return 'html_login_or_error_page';
  if (/file header is not %PDF-|likely html\/login\/error page/i.test(raw)) return 'not_pdf';
  if (/There was a problem providing the content you requested/i.test(raw)) return 'publisher_error_page';
  if (/等待出版商页面触发 PDF 下载超时/i.test(raw)) return 'publisher_timeout';
  if (/下载中断/i.test(raw)) return 'download_interrupted';
  return '';
}

function sanitizeDownloadItem(item) {
  if (!item) return null;
  return {
    id: item.id,
    createdByPlugin: !!item._ablesciCreatedByPlugin,
    publisherTabId: item._ablesciPublisherTabId || null,
    matchSource: item._ablesciMatchSource || '',
    url: urlHostPath(item.url || ''),
    finalUrl: urlHostPath(item.finalUrl || ''),
    mime: item.mime || '',
    filename: basenameOf(item.filename || ''),
    extension: extensionOf(item.filename || ''),
    fileSize: Number(item.fileSize || 0),
    totalBytes: Number(item.totalBytes || 0),
    state: item.state || '',
    error: item.error || ''
  };
}

async function saveDiagnostic(diag) {
  const clean = JSON.parse(JSON.stringify(diag || {}));
  await chrome.storage.local.set({ [LAST_DIAGNOSTIC_KEY]: clean });
  console.debug('[Ablesci PDF Uploader Diagnostic]', clean);
}

async function saveErrorDiagnostic(payload, err) {
  const raw = redactLocalPaths(err && err.message ? err.message : String(err || '未知错误'));
  try {
    const opts = await getOptions();
    const stored = await chrome.storage.local.get(LAST_DIAGNOSTIC_KEY);
    const previous = stored[LAST_DIAGNOSTIC_KEY] || {};
    const base = previous && previous.assistId === maskId(payload?.assistId)
      ? { ...previous, assistDetailUrl: previous.assistDetailUrl || payload?.pageUrl || '' }
      : makeDiagnosticBase(payload, opts);
    const stage = base.downloadItem && base.stage ? base.stage : 'error';
    await saveDiagnostic({ ...base, stage, error: raw });
  } catch (_) {}
}

function isNonPdfAccessPageError(err) {
  const raw = err && err.message ? err.message : String(err || '');
  return raw.includes(HTML_DOWNLOAD_MESSAGE) ||
    /file header is not %PDF-|likely html\/login\/error page/i.test(raw);
}

function isHtmlDownloadItem(item) {
  const mime = String(item?.mime || '').toLowerCase();
  const ext = extensionOf(item?.filename || '');

  if (mime.includes('text/html') || mime.includes('application/xhtml+xml')) {
    return true;
  }

  return ext === '.htm' || ext === '.html';
}

function isHtmlExtension(pathOrName) {
  const ext = extensionOf(pathOrName || '');
  return ext === '.html' || ext === '.htm';
}

function canRemoveHtmlDownloadItem(item) {
  if (!item || !item.id) return false;
  if (!isHtmlExtension(item.filename || '')) return false;
  return isHtmlDownloadItem(item);
}

async function removeDownloadArtifact(item) {
  if (!canRemoveHtmlDownloadItem(item)) {
    console.warn(
      '[Ablesci PDF Uploader] refuse to remove non-html download artifact',
      sanitizeDownloadItem(item)
    );
    return false;
  }

  try {
    await chrome.downloads.removeFile(item.id);
    return true;
  } catch (_) {
    return false;
  }
}

async function stopForNonPdfDownload(port, diag, item, downloadMeta, stage, reason, opts = {}) {
  let removed = false;
  let removeReason = 'autoRemoveHtmlDownloads disabled';

  if (opts.autoRemoveHtmlDownloads) {
    if (canRemoveHtmlDownloadItem(item)) {
      removed = await removeDownloadArtifact(item);
      removeReason = removed
        ? 'removed html/htm download artifact'
        : 'failed to remove html/htm download artifact';
    } else {
      removeReason = 'refuse to remove non-html download artifact';
    }
  }

  const message = HTML_DOWNLOAD_MESSAGE + (removed
    ? ' 已删除本地 HTML 异常文件，并保留浏览器下载记录。'
    : ' 已保留本地异常文件，未自动删除。');

  await saveDiagnostic({
    ...diag,
    stage,
    downloadItem: downloadMeta || sanitizeDownloadItem(item),
    error: reason || HTML_DOWNLOAD_MESSAGE,
    removedDownloadFile: removed,
    removeReason
  });
  await recordJournalAccessResult(diag, {
    ok: false,
    reason: 'html_login_or_error_page'
  });

  post(port, 'done', message, {
    html: escapeHtml(message),
    recomend: false,
    reload: false,
    downloadOnly: true,
    blocked: true
  });
}

function isScienceDirectUrl(url) {
  return /(^|\.)sciencedirect\.com$/i.test(hostnameOf(url));
}

function extractScienceDirectPii(url) {
  const s = String(url || '');
  return (
    s.match(/\/science\/article\/pii\/([^/?#]+)/i)?.[1] ||
    s.match(/\/1-s2\.0-([^/?#]+)\/main\.pdf/i)?.[1] ||
    s.match(/1-s2\.0-([^/?#-]+)(?:-main)?\.pdf/i)?.[1] ||
    ''
  );
}

function isDoiHost(host) {
  return /^(dx\.)?doi\.org$/i.test(host || '');
}

function isNatureUrl(url) {
  return /(^|\.)nature\.com$/i.test(hostnameOf(url));
}

function isRscDirectPdfUrl(url) {
  return /(^|\.)pubs\.rsc\.org$/i.test(hostnameOf(url)) && /\/content\/articlepdf\//i.test(url || '');
}

function isScienceDirectPdfUrl(url) {
  return isScienceDirectUrl(url) && /\/science\/article\/pii\/[^/?#]+\/(?:pdf|pdfft)/i.test(url || '');
}

function isDoiUrl(url) {
  return /^https?:\/\/(?:dx\.)?doi\.org\/10\./i.test(url || '');
}

function isScienceDirectRelatedHost(h) {
  return /(^|\.)(sciencedirect\.com|sciencedirectassets\.com|elsevier\.com|els-cdn\.com)$/i.test(h || '');
}

function isScienceDirectAssetPdfUrl(url) {
  return /(^|\.)sciencedirectassets\.com$/i.test(hostnameOf(url)) &&
    /\/1-s2\.0-[^/?#]+\/main\.pdf(?:[?#]|$)/i.test(String(url || ''));
}

function natureArticleUrlFromPdfUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)nature\.com$/i.test(u.hostname)) return url;
    const article = u.pathname.match(/^(\/articles\/[^/?#]+?)(?:_reference)?\.pdf$/i);
    if (article) return u.origin + article[1];
    return u.href;
  } catch (_) {
    return url;
  }
}

function publisherArticleUrlFromPdfUrl(url) {
  if (isScienceDirectUrl(url)) return scienceDirectArticleUrlFromPdfUrl(url);
  if (isNatureUrl(url)) return natureArticleUrlFromPdfUrl(url);
  return url;
}

function isLikelyTargetDownload(item, expectedHost, sourceUrl) {
  if (!item) return false;

  const itemUrl = item.finalUrl || item.url || '';
  const h = hostnameOf(itemUrl);
  const expectedPii = extractScienceDirectPii(sourceUrl);
  const itemPii = extractScienceDirectPii(itemUrl) || extractScienceDirectPii(item.filename || '');

  if (expectedPii && itemPii && expectedPii !== itemPii) {
    console.warn('[Ablesci PDF Uploader] reject ScienceDirect PDF with mismatched PII', {
      expectedPii,
      itemPii,
      item: sanitizeDownloadItem(item)
    });
    return false;
  }

  const haystack = [
    item.url || '',
    item.finalUrl || '',
    item.filename || '',
    item.mime || '',
    sourceUrl || ''
  ].join(' ').toLowerCase();

  // 明确 PDF 特征：后缀、mime、下载链接关键词。
  if (/\.pdf(\?|#|$)/i.test(haystack)) return true;
  if (/application\/pdf/i.test(item.mime || '')) return true;
  if (/\b(pdfft|pdfdownload|download\?download=true)\b/i.test(haystack)) return true;
  if (/\/(doi\/pdf|doi\/epdf|content\/pdf)\//i.test(haystack)) return true;

  // ScienceDirect 的真实文件可能来自 sciencedirectassets / elsevier / els-cdn，
  // 不能只按 www.sciencedirect.com 精确匹配，否则会“已下载但插件没接住”。
  if (isScienceDirectUrl(sourceUrl) && isScienceDirectRelatedHost(h)) return true;

  // 其他出版商：同 host 且 URL 看起来和源链接相关。
  if (expectedHost && h === expectedHost) {
    if (/pdf|download|article|content|doi/i.test(haystack)) return true;
  }

  return false;
}

function isExpectedPublisherPage(pending, pageUrl) {
  if (!pending) return false;
  if (!pageUrl) return true;
  const expectedArticle = pending.articleUrl || pending.pdfUrl || '';
  const expectedHost = hostnameOf(expectedArticle);
  const actualHost = hostnameOf(pageUrl);
  if (!expectedHost || !actualHost) return false;
  if (isDoiHost(expectedHost)) {
    if (isScienceDirectUrl(pageUrl) || isNatureUrl(pageUrl)) {
      pending.articleUrl = pageUrl;
      pending.publisher = isScienceDirectUrl(pageUrl) ? 'sciencedirect' : 'nature';
      if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(pageUrl);
      return true;
    }
  }
  if (expectedHost !== actualHost) return false;
  if (isScienceDirectUrl(expectedArticle)) {
    const expectedPii = extractScienceDirectPii(expectedArticle);
    const actualPii = extractScienceDirectPii(pageUrl);
    return !expectedPii || !actualPii || expectedPii === actualPii;
  }
  return true;
}

function searchRecentDownloads(query) {
  return new Promise(resolve => {
    chrome.downloads.search(query, items => resolve(items || []));
  });
}

function scienceDirectArticleUrlFromPdfUrl(url) {
  const m = String(url || '').match(/^(https?:\/\/(?:www\.)?sciencedirect\.com\/science\/article\/pii\/[^/?#]+)(?:\/(?:pdf|pdfft)(?:[?#].*)?|[?#].*)?$/i);
  return m ? m[1] : url;
}

function onceDownloadComplete(downloadId, timeoutMs = 180000, signal = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let statePoller = null;
    let abortListener = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (statePoller) clearInterval(statePoller);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      chrome.downloads.onChanged.removeListener(listener);
    }

    function finishOk(item) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(item);
    }

    function finishError(msg) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    }

    function checkCurrentState() {
      chrome.downloads.search({ id: downloadId }, items => {
        if (settled) return;

        const item = items && items[0];
        if (!item) return;

        if (item.state === 'complete') {
          return finishOk(item);
        }

        if (item.state === 'interrupted') {
          return finishError('下载中断：' + (item.error || 'unknown'));
        }
      });
    }

    function listener(delta) {
      if (delta.id !== downloadId) return;

      if (delta.state && delta.state.current === 'complete') {
        chrome.downloads.search({ id: downloadId }, items => {
          const item = items && items[0];
          if (!item) return finishError('下载完成但找不到 DownloadItem');
          finishOk(item);
        });
        return;
      }

      if (delta.state && delta.state.current === 'interrupted') {
        chrome.downloads.search({ id: downloadId }, items => {
          const item = items && items[0];
          finishError('下载中断：' + (item?.error || 'unknown'));
        });
        return;
      }

      if (delta.error && delta.error.current) {
        finishError('下载失败：' + delta.error.current);
      }
    }

    if (signal) {
      abortListener = () => {
        try { chrome.downloads.cancel(downloadId); } catch (_) {}
        finishError(abortReason(signal, '任务已取消，已停止等待下载'));
      };

      if (signal.aborted) {
        abortListener();
        return;
      }

      signal.addEventListener('abort', abortListener, { once: true });
    }

    timer = setTimeout(() => {
      finishError('下载超时');
    }, timeoutMs);

    chrome.downloads.onChanged.addListener(listener);

    // 立即查一次，防止下载已经完成。
    checkCurrentState();

    // 持续轮询该 downloadId，防止 onChanged complete 事件漏掉。
    statePoller = setInterval(checkCurrentState, 1000);
  });
}

async function downloadByDownloadsAPI(pdfUrl, filenameRel, signal = null) {
  throwIfAborted(signal);
  const downloadId = await chrome.downloads.download({
    url: pdfUrl,
    filename: filenameRel,
    conflictAction: 'uniquify',
    saveAs: false
  });
  const item = await onceDownloadComplete(downloadId, 180000, signal);
  item._ablesciCreatedByPlugin = true;
  item._ablesciMatchSource = 'chrome.downloads.download';
  return item;
}

async function downloadByBackgroundTab(pdfUrl, timeoutMs = 180000, signal = null) {
  return await new Promise(async (resolve, reject) => {
    let tabId = null;
    let downloadId = null;
    let timer = null;
    let abortListener = null;

    function cleanup() {
      if (timer) clearTimeout(timer);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      chrome.downloads.onCreated.removeListener(onCreated);
      if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
    }

    function onCreated(item) {
      if (downloadId !== null) return;
      if (!isLikelyTargetDownload(item, hostnameOf(pdfUrl), pdfUrl)) return;
      downloadId = item.id;
      onceDownloadComplete(downloadId, timeoutMs, signal)
        .then(item => {
          item._ablesciCreatedByPlugin = true;
          item._ablesciPublisherTabId = tabId;
          item._ablesciMatchSource = 'background_tab';
          cleanup();
          resolve(item);
        })
        .catch(err => { cleanup(); reject(err); });
    }

    try {
      throwIfAborted(signal);
      if (signal) {
        abortListener = () => { cleanup(); reject(makeAbortError(abortReason(signal))); };
        signal.addEventListener('abort', abortListener, { once: true });
      }
      chrome.downloads.onCreated.addListener(onCreated);
      const tab = await chrome.tabs.create({ url: pdfUrl, active: false });
      tabId = tab.id;
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('后台标签页没有触发 PDF 下载；请确认 Chrome 已设置“下载 PDF，而不是在 Chrome 中打开”。'));
      }, timeoutMs);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function downloadByInteractivePublisherTab(pdfUrl, port, options = {}) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const active = options.active !== false;
  const revealAfterMs = Number(options.revealAfterMs || 0);
  const signal = options.signal || null;

  return await new Promise(async (resolve, reject) => {
    let tabId = null;
    let downloadId = null;
    let timer = null;
    let poller = null;
    let settled = false;
    let revealed = active;
    let revealTimer = null;
    let abortListener = null;
    let sourceUrlForMatching = pdfUrl;
    let expectedHost = hostnameOf(sourceUrlForMatching);
    const articleUrl = publisherArticleUrlFromPdfUrl(pdfUrl);
    const startedAfter = new Date(Date.now() - 2000).toISOString();
    const seenIds = new Set();

    function cleanup(closeTab = true) {
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      if (revealTimer) clearTimeout(revealTimer);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      chrome.downloads.onCreated.removeListener(onCreated);
      if (tabId !== null) {
        pendingPublisherTabs.delete(tabId);
        if (closeTab) chrome.tabs.remove(tabId).catch(() => {});
      }
    }

    function finishOk(item) {
      if (settled) return;
      settled = true;
      cleanup(true);
      resolve(item);
    }

    function finishError(err) {
      if (settled) return;
      settled = true;
      // v0.7: 失败/超时后关闭本任务创建的出版商页，避免它稍后又触发下载，
      // 被后续排队任务误认为自己的 PDF。
      cleanup(true);
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    function revealPublisherTab(reason) {
      if (settled || tabId === null || revealed) return;
      revealed = true;
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
      post(port, 'progress', reason || '后台静默等待较久，已切到出版商标签页；如有验证，请完成后插件会继续。');
    }

    function acceptCandidate(item, source) {
      if (settled || !item || seenIds.has(item.id)) return;
      if (!isLikelyTargetDownload(item, expectedHost, sourceUrlForMatching)) return;

      seenIds.add(item.id);
      downloadId = item.id;
      post(port, 'progress', `检测到浏览器下载 #${item.id}（${source}），等待完成...`);
      onceDownloadComplete(downloadId, timeoutMs, signal)
        .then(item => {
          item._ablesciCreatedByPlugin = true;
          item._ablesciPublisherTabId = tabId;
          item._ablesciMatchSource = source;
          finishOk(item);
        })
        .catch(finishError);
    }

    function onCreated(item) {
      acceptCandidate(item, 'onCreated');
    }

    async function pollDownloads() {
      if (settled) return;
      const items = await searchRecentDownloads({ startedAfter, orderBy: ['-startTime'], limit: 20 });
      for (const item of items) {
        acceptCandidate(item, 'poll');
        if (downloadId !== null) break;
      }
    }

    try {
      throwIfAborted(signal);
      if (signal) {
        abortListener = () => finishError(makeAbortError(abortReason(signal)));
        signal.addEventListener('abort', abortListener, { once: true });
      }
      chrome.downloads.onCreated.addListener(onCreated);
      const tab = await chrome.tabs.create({ url: articleUrl, active });
      tabId = tab.id;
      pendingPublisherTabs.set(tabId, {
        pdfUrl,
        articleUrl,
        createdAt: Date.now(),
        port,
        finishError,
        revealPublisherTab,
        publisher: isScienceDirectUrl(articleUrl) ? 'sciencedirect' : (isNatureUrl(articleUrl) ? 'nature' : ''),
        lastNativePdfUrl: '',
        setExpectedDownloadUrl(url) {
          sourceUrlForMatching = url || sourceUrlForMatching;
          expectedHost = hostnameOf(sourceUrlForMatching);
        }
      });

      if (active) {
        post(port, 'progress', '已打开可见出版商页面。若出现验证页，请在新标签页完成验证；进入文章页后插件会查找原生 View PDF 入口。');
      } else if (revealAfterMs > 0) {
        post(port, 'progress', `已用后台静默标签页打开出版商页面；${Math.round(revealAfterMs / 1000)} 秒内若未触发下载，会自动切到前台供你验证。`);
        revealTimer = setTimeout(() => revealPublisherTab('ScienceDirect 后台静默等待较久，已切到出版商标签页；如有验证，请完成后手动点击 View PDF，插件会继续监听下载。'), revealAfterMs);
      } else {
        post(port, 'progress', '已用后台静默标签页打开出版商页面；不会主动切到前台。');
      }
      post(port, 'progress', '正在等待浏览器下载事件；如果 PDF 已经下载但无后续进度，会通过轮询下载记录继续接管。');

      poller = setInterval(pollDownloads, 1000);
      setTimeout(pollDownloads, 500);
      setTimeout(pollDownloads, 2000);

      timer = setTimeout(() => {
        finishError(new Error('等待出版商页面触发 PDF 下载超时；可能没有通过验证、没有权限，Chrome 没有设置为直接下载 PDF，或下载记录被清理。'));
      }, timeoutMs);
    } catch (err) {
      finishError(err);
    }
  });
}

async function downloadPdf(pdfUrl, suggestedFilename, opts, port, signal = null) {
  const filenameRel = makeDownloadFilename(opts.downloadSubdir, suggestedFilename);
  const mode = opts.downloadMode || 'auto';

  // ScienceDirect 必须从原生 article 页进入 View PDF。不要用 PII 拼接
  // /pdfft?download=true；站点现在会生成带 crasolve/token/original/rack 等
  // 会话参数的 pdfft URL，只有页面原生流程拿到的 URL 才可靠。
  if (isScienceDirectUrl(pdfUrl) || isDoiUrl(pdfUrl)) {
    const sdMode = opts.scienceDirectTabMode || 'silent_then_visible';
    if (mode === 'publisher_tab' || sdMode === 'visible') {
      post(port, 'progress', 'ScienceDirect 使用可见原生 View PDF 模式。');
      return await downloadByInteractivePublisherTab(pdfUrl, port, { active: true, signal });
    }
    if (mode === 'background_tab' || sdMode === 'silent') {
      post(port, 'progress', 'ScienceDirect 使用后台静默原生 View PDF 模式。');
      return await downloadByInteractivePublisherTab(pdfUrl, port, { active: false, revealAfterMs: 0, signal });
    }
    post(port, 'progress', 'ScienceDirect 使用后台静默原生 View PDF 模式；如 30 秒内未触发下载，会自动切到前台。');
    return await downloadByInteractivePublisherTab(pdfUrl, port, { active: false, revealAfterMs: 30000, signal });
  }

  if (isNatureUrl(pdfUrl)) {
    if (mode === 'publisher_tab') {
      post(port, 'progress', 'Nature 使用可见文章页原生 PDF 下载模式。');
      return await downloadByInteractivePublisherTab(pdfUrl, port, { active: true, signal });
    }
    post(port, 'progress', 'Nature 使用后台文章页原生 PDF 下载模式；如 30 秒内未触发下载，会自动切到前台。');
    return await downloadByInteractivePublisherTab(pdfUrl, port, { active: false, revealAfterMs: 30000, signal });
  }

  if (isRscDirectPdfUrl(pdfUrl)) {
    post(port, 'progress', 'RSC articlepdf 使用 chrome.downloads 直接下载。');
    return await downloadByDownloadsAPI(pdfUrl, filenameRel, signal);
  }

  if (mode === 'publisher_tab') {
    post(port, 'progress', '通过可见出版商标签页触发下载...');
    return await downloadByInteractivePublisherTab(pdfUrl, port, { active: true, signal });
  }

  if (mode === 'background_tab') {
    post(port, 'progress', '通过后台标签页触发下载...');
    return await downloadByBackgroundTab(pdfUrl, 180000, signal);
  }

  if (mode === 'chrome_downloads') {
    post(port, 'progress', '通过 chrome.downloads 下载...');
    return await downloadByDownloadsAPI(pdfUrl, filenameRel, signal);
  }

  // 其他直链：先 chrome.downloads；只有网络层失败才用后台标签页。
  try {
    post(port, 'progress', '通过 chrome.downloads 下载...');
    return await downloadByDownloadsAPI(pdfUrl, filenameRel, signal);
  } catch (err) {
    post(port, 'progress', '直接下载失败，尝试后台标签页：' + (err.message || err));
    return await downloadByBackgroundTab(pdfUrl, 180000, signal);
  }
}

function sendNativeMessage(hostName, message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(hostName, message, response => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) return reject(new Error(lastErr.message));
      if (!response) return reject(new Error('Native Helper 没有返回内容'));
      if (!response.ok) return reject(new Error(response.error || 'Native Helper 返回失败'));
      resolve(response);
    });
  });
}

function sizeToBytes(value, unit, fallback, fallbackUnit = 'MB') {
  const n = Number(value);
  const size = Number.isFinite(n) && n >= 0 ? n : fallback;
  const normalizedUnit = normalizeSizeUnit(unit || fallbackUnit);
  const factor = normalizedUnit === 'KB' ? 1024 : 1024 * 1024;
  return Math.round(size * factor);
}

function formatTaskError(err) {
  const raw = redactLocalPaths(err && err.message ? err.message : String(err || '未知错误'));
  if (raw.includes(HTML_DOWNLOAD_MESSAGE)) return HTML_DOWNLOAD_MESSAGE;
  if (/file header is not %PDF-|likely html\/login\/error page/i.test(raw)) {
    return HTML_DOWNLOAD_MESSAGE + '\n\n原始错误：' + raw;
  }
  return raw;
}

async function uploadRequest(payload, stat) {
  const body = new URLSearchParams();
  body.set(payload.csrfParam || '_csrf', payload.csrfToken);
  body.set('assist_id', payload.assistId);
  body.set('filename', stat.filename);
  body.set('file_md5', stat.md5);
  body.set('filesize', String(stat.size));

  const resp = await fetch('https://www.ablesci.com/assist/upload-request?t=' + Date.now(), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest'
    },
    body
  });
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error('upload-request 返回不是 JSON：' + raw.slice(0, 200)); }
  if (!resp.ok) throw new Error('upload-request HTTP ' + resp.status + '：' + (data.msg || raw.slice(0, 200)));
  return data;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isRecommendResponse(res) {
  return res && (res.recomend === 1 || res.recomend === '1' || res.recommend === 1 || res.recommend === '1');
}

function postDoneFromSiteResponse(port, res, fallbackMsg) {
  const rawHtml = res && res.msg ? String(res.msg) : (fallbackMsg || '上传成功');
  post(port, 'done', stripHtml(rawHtml), {
    html: rawHtml,
    recomend: isRecommendResponse(res),
    reload: true,
    responseCode: res && res.code
  });
}

function isAssistStateChangedMessage(text) {
  const plain = stripHtml(text || '');
  return /该求助状态已经发生改变|请刷新页面查看或下载|已经有人上传了文献|请等待求助人确认|待确认|已完成|已关闭|不在求助中|已被修改状态|状态.*发生改变/.test(plain);
}

function postAssistStateChangedDone(port, text) {
  const plain = stripHtml(text || '该求助状态已经发生改变，请刷新页面查看或下载。');
  post(port, 'done', plain, {
    html: escapeHtml(plain),
    recomend: false,
    reload: true,
    blocked: true,
    stateChanged: true
  });
}

function downloadOnlyDone(port, reasons, stat) {
  const reasonText = Array.isArray(reasons) && reasons.length
    ? reasons.join('；')
    : '当前任务需要人工核对';
  post(port, 'done', `已仅下载并校验 PDF，未自动上传。${reasonText}`, {
    html: `已仅下载并校验 PDF，未自动上传。<br>原因：${escapeHtml(reasonText)}<br>文件：${escapeHtml(stat?.filename || 'paper.pdf')}`,
    recomend: false,
    reload: false,
    downloadOnly: true
  });
}

function debugDownloadOnlyDone(port, stat) {
  const name = stat?.filename || basenameOf(stat?.path || '') || 'paper.pdf';
  const size = Number(stat?.size || 0);
  const md5 = stat?.md5 || '';
  const message = `调试模式已开启，未自动上传。准备上传文件：${name}`;
  post(port, 'done', message, {
    html: escapeHtml(message),
    recomend: false,
    reload: false,
    downloadOnly: true,
    debugOnly: true
  });
}

function normalizeOSSData(data) {
  const d = data || {};
  return {
    host: d.host,
    key: d.key || ((d.dir || '') + (d.randFilename || '')),
    policy: d.policy,
    accessid: d.accessid || d.OSSAccessKeyId,
    signature: d.signature,
    callback: d.callback,
    assist_id: d.assist_id,
    user_id: d.user_id,
    filename: d.filename,
    dir: d.dir,
    randFilename: d.randFilename
  };
}

async function handleUpload(port, payload, signal = null) {
  throwIfAborted(signal);
  const opts = await getOptions();
  const diag = makeDiagnosticBase(payload, opts);

  if (!payload?.pdfUrl) throw new Error('缺少 pdfUrl');
  if (!payload?.assistId) throw new Error('缺少 assistId');
  if (!payload?.csrfToken) throw new Error('缺少 csrfToken');

  if (payload.downloadOnly) {
    const reasons = Array.isArray(payload.riskReasons) && payload.riskReasons.length
      ? payload.riskReasons.join('；')
      : '当前求助需要人工核对';
    post(port, 'progress', `当前任务命中仅下载保护：${reasons}；下载完成后不会自动提交。`);
  }

  await saveDiagnostic({ ...diag, stage: 'picked' });
  post(port, 'progress', 'PDF URL：' + payload.pdfUrl);
  const item = await downloadPdf(payload.pdfUrl, payload.suggestedFilename || 'paper.pdf', opts, port, signal);
  throwIfAborted(signal);
  if (!item.filename) throw new Error('下载完成但没有得到本地文件路径');

  const downloadMeta = sanitizeDownloadItem(item);
  await saveDiagnostic({ ...diag, stage: 'download-complete', downloadItem: downloadMeta });
  if (isHtmlDownloadItem(item)) {
    await stopForNonPdfDownload(port, diag, item, downloadMeta, 'blocked-html-download', HTML_DOWNLOAD_MESSAGE, opts);
    return;
  }

  post(port, 'progress', '下载完成，调用本地 Helper 校验 PDF 和计算 MD5...');
  throwIfAborted(signal);
  let stat;
  try {
    stat = await sendNativeMessage(opts.nativeHostName, {
      action: 'stat_pdf',
      path: item.filename,
      move_to_dir: opts.moveToDir || ''
    });
  } catch (err) {
    if (isNonPdfAccessPageError(err)) {
      await stopForNonPdfDownload(port, diag, item, downloadMeta, 'blocked-non-pdf-download', formatTaskError(err), opts);
      return;
    }
    throw err;
  }

  throwIfAborted(signal);
  if (!opts.keepDownloadHistory) {
    try { await chrome.downloads.erase({ id: item.id }); } catch (_) {}
  }
  await saveDiagnostic({
    ...diag,
    stage: 'pdf-validated',
    downloadItem: downloadMeta,
    file: {
      filename: stat.filename || basenameOf(stat.path || ''),
      extension: extensionOf(stat.filename || stat.path || ''),
      size: Number(stat.size || 0)
    }
  });
  post(port, 'progress', `PDF 校验通过：${stat.filename}，${formatBytes(stat.size)}，MD5=${stat.md5}`);
  const downloadOnlyReasons = Array.isArray(payload.riskReasons) && payload.riskReasons.length
    ? payload.riskReasons.slice()
    : [];
  const size = Number(stat.size || 0);
  if (opts.debugDownloadOnly) {
    await saveDiagnostic({
      ...diag,
      stage: 'debug-download-only',
      downloadItem: downloadMeta,
      file: {
        filename: stat.filename || basenameOf(stat.path || ''),
        extension: extensionOf(stat.filename || stat.path || ''),
        size,
        md5: stat.md5 || ''
      },
      message: 'debug mode: download and validate only; upload-request and OSS upload skipped'
    });
    post(port, 'progress', `调试模式：准备上传文件 ${stat.filename}，${formatBytes(size)}，MD5=${stat.md5}；已跳过自动上传。`);
    debugDownloadOnlyDone(port, stat);
    return;
  }
  const minAutoUploadBytes = sizeToBytes(opts.minAutoUploadMB, opts.minAutoUploadUnit, DEFAULT_OPTIONS.minAutoUploadMB, DEFAULT_OPTIONS.minAutoUploadUnit);
  const maxAutoUploadBytes = sizeToBytes(opts.maxAutoUploadMB, opts.maxAutoUploadUnit, DEFAULT_OPTIONS.maxAutoUploadMB, DEFAULT_OPTIONS.maxAutoUploadUnit);
  if (size > 0 && minAutoUploadBytes > 0 && size < minAutoUploadBytes) {
    downloadOnlyReasons.push(`PDF 文件小于 ${formatConfiguredSize(opts.minAutoUploadMB || DEFAULT_OPTIONS.minAutoUploadMB, opts.minAutoUploadUnit || DEFAULT_OPTIONS.minAutoUploadUnit)}（当前 ${formatBytes(size)}），已改为仅下载。`);
    await saveDiagnostic({ ...diag, stage: 'download-only-small-file', downloadItem: downloadMeta, fileSize: size });
    downloadOnlyDone(port, downloadOnlyReasons, stat);
    return;
  }
  if (size > 0 && maxAutoUploadBytes > 0 && size > maxAutoUploadBytes) {
    downloadOnlyReasons.push(`PDF 文件大于 ${formatConfiguredSize(opts.maxAutoUploadMB || DEFAULT_OPTIONS.maxAutoUploadMB, opts.maxAutoUploadUnit || DEFAULT_OPTIONS.maxAutoUploadUnit)}（当前 ${formatBytes(size)}），超过自动上传范围，已改为仅下载。`);
    await saveDiagnostic({ ...diag, stage: 'download-only-large-file', downloadItem: downloadMeta, fileSize: size });
    downloadOnlyDone(port, downloadOnlyReasons, stat);
    return;
  }

  if (payload.downloadOnly) {
    await saveDiagnostic({ ...diag, stage: 'download-only-risk', downloadItem: downloadMeta, fileSize: size, reasons: downloadOnlyReasons });
    downloadOnlyDone(port, downloadOnlyReasons.length ? downloadOnlyReasons : ['当前求助需要人工核对'], stat);
    return;
  }

  const permit = await uploadRequest(payload, stat);
  console.log('[Ablesci PDF Uploader] upload-request code', permit && permit.code);

  if (permit.code === 10) {
    if (opts.deleteAfterUpload) {
      try { await sendNativeMessage(opts.nativeHostName, { action: 'delete_file', path: stat.path }); } catch (e) { console.warn(e); }
    }
    await recordJournalAccessResult(payload, { ok: true });
    postDoneFromSiteResponse(port, permit, '上传成功');
    return;
  }

  if (permit.code !== 0) {
    if (isAssistStateChangedMessage(permit.msg || '')) {
      await saveDiagnostic({ ...diag, stage: 'assist-state-changed-before-upload', downloadItem: downloadMeta, fileSize: size });
      postAssistStateChangedDone(port, permit.msg || '该求助状态已经发生改变，请刷新页面查看或下载。');
      return;
    }
    throw new Error(stripHtml(permit.msg || 'upload-request 未允许上传'));
  }

  throwIfAborted(signal);
  post(port, 'progress', '开始上传到 OSS...');
  const oss = normalizeOSSData(permit.data);
  const ossRes = await sendNativeMessage(opts.nativeHostName, {
    action: 'upload_oss',
    path: stat.path,
    csrf_param: payload.csrfParam || '_csrf',
    csrf_token: payload.csrfToken,
    assist_id: payload.assistId,
    oss
  });

  let parsed = null;
  try { parsed = JSON.parse(ossRes.body || '{}'); } catch (_) {}
  if (parsed && parsed.code === 1) {
    if (isAssistStateChangedMessage(parsed.msg || '')) {
      await saveDiagnostic({ ...diag, stage: 'assist-state-changed-after-upload', downloadItem: downloadMeta, fileSize: size });
      postAssistStateChangedDone(port, parsed.msg || '该求助状态已经发生改变，请刷新页面查看或下载。');
      return;
    }
    throw new Error(stripHtml(parsed.msg || 'OSS 回调返回上传失败'));
  }
  if (opts.deleteAfterUpload) {
    try { await sendNativeMessage(opts.nativeHostName, { action: 'delete_file', path: stat.path }); } catch (e) { console.warn(e); }
  }
  if (parsed && parsed.msg) {
    await saveDiagnostic({ ...diag, stage: 'uploaded', downloadItem: downloadMeta, fileSize: size });
    await recordJournalAccessResult(payload, { ok: true });
    postDoneFromSiteResponse(port, parsed, '上传成功');
  } else {
    await saveDiagnostic({ ...diag, stage: 'uploaded', downloadItem: downloadMeta, fileSize: size });
    await recordJournalAccessResult(payload, { ok: true });
    post(port, 'done', 'OSS 上传完成，请检查 Ablesci 页面状态。', {
      html: 'OSS 上传完成，请检查 Ablesci 页面状态。',
      recomend: false,
      reload: true
    });
  }
}

function uploadLabel(payload) {
  const id = payload?.assistId || '';
  const doi = payload?.doi || '';
  const title = payload?.suggestedFilename || '';
  return [id, doi || title].filter(Boolean).join(' / ') || '当前任务';
}

function removeQueuedTask(task) {
  const idx = taskQueue.indexOf(task);
  if (idx >= 0) taskQueue.splice(idx, 1);
}

function cancelTask(task, reason) {
  if (!task || task.cancelled) return;
  task.cancelled = true;
  task.cancelReason = reason || '任务已取消';
  removeQueuedTask(task);

  if (activeTask === task && task.abortController) {
    try { task.abortController.abort(task.cancelReason); } catch (_) {}
  }
}

function processQueue() {
  if (activeTask) return;

  while (taskQueue.length && taskQueue[0].cancelled) taskQueue.shift();
  const task = taskQueue.shift();
  if (!task) return;

  activeTask = task;
  const { port, payload, label, abortController } = task;

  (async () => {
    post(port, 'progress', `开始处理任务：${label}`);
    try {
      await handleUpload(port, payload, abortController.signal);
    } catch (err) {
      const failureReason = classifyJournalAccessFailureReason(err);
      if (failureReason) {
        await recordJournalAccessResult(payload, {
          ok: false,
          reason: failureReason
        });
      }

      if (!task.cancelled) {
        await saveErrorDiagnostic(payload, err);
        if (isNonPdfAccessPageError(err)) {
          post(port, 'done', HTML_DOWNLOAD_MESSAGE, {
            html: escapeHtml(HTML_DOWNLOAD_MESSAGE),
            recomend: false,
            reload: false,
            downloadOnly: true,
            blocked: true
          });
        } else {
          console.error('[Ablesci PDF Uploader Error]', err);
          post(port, 'error', formatTaskError(err));
        }
      }
    } finally {
      if (activeTask === task) activeTask = null;
      processQueue();
    }
  })();
}

function enqueueUpload(port, payload) {
  const label = uploadLabel(payload);
  const task = {
    id: nextTaskId++,
    port,
    payload,
    label,
    cancelled: false,
    cancelReason: '',
    abortController: new AbortController()
  };

  const hadActiveOrQueued = !!activeTask || taskQueue.length > 0;
  if (hadActiveOrQueued) {
    post(port, 'progress', `已有 PDF 上传任务正在处理（${activeTask?.label || '队列中'}），当前任务已进入队列。为避免多个页面下载错配，插件会按点击顺序逐个处理。关闭本 Ablesci 页面会自动取消该任务。`);
  }

  port.onDisconnect.addListener(() => {
    // 关键修复：Ablesci 页面关闭/刷新后，不再让这个任务继续占用串行队列。
    // 如果它正在等待 ScienceDirect 验证/下载，会立刻关闭本任务创建的出版商页，并启动下一个队列任务。
    cancelTask(task, `Ablesci 页面已关闭或刷新，取消任务：${label}`);
    processQueue();
  });

  taskQueue.push(task);
  processQueue();
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ablesci-pdf-upload') return;
  port.onMessage.addListener(msg => {
    if (!msg || msg.type !== 'startUpload') return;
    enqueueUpload(port, msg.payload);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const pending = pendingPublisherTabs.get(tabId);
  if (!pending) return;

  const url = changeInfo.url || tab?.url || '';
  if (!url) return;

  const expectedHost = hostnameOf(pending.articleUrl || pending.pdfUrl || '');

  if (isDoiHost(expectedHost) && (isScienceDirectUrl(url) || isNatureUrl(url))) {
    pending.articleUrl = url;
    pending.publisher = isScienceDirectUrl(url) ? 'sciencedirect' : 'nature';
    if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(url);
    return;
  }

  if (isScienceDirectAssetPdfUrl(url)) {
    const expectedPii = extractScienceDirectPii(pending.articleUrl || pending.pdfUrl || '');
    const actualPii = extractScienceDirectPii(url);

    if (expectedPii && actualPii && expectedPii !== actualPii) {
      pending.finishError?.(new Error(`ScienceDirect PDF PII 不匹配：期望 ${expectedPii}，实际 ${actualPii}`));
      return;
    }

    if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(url);
    pending.lastNativePdfUrl = url;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  const pending = tabId != null ? pendingPublisherTabs.get(tabId) : null;

  if (msg?.type === 'ablesciPublisherCanControl') {
    if (!pending) {
      sendResponse({ ok: false, reason: 'no pending publisher task for this tab' });
      return;
    }
    if (msg.publisher && pending.publisher && msg.publisher !== pending.publisher) {
      sendResponse({ ok: false, reason: 'publisher mismatch' });
      return;
    }
    if (!isExpectedPublisherPage(pending, msg.pageUrl || '')) {
      sendResponse({ ok: false, reason: 'publisher page mismatch' });
      return;
    }
    sendResponse({ ok: true });
    return;
  }

  if (!msg || msg.type !== 'ablesciPublisherArticleReady') return;

  if (!pending) {
    sendResponse({ ok: false, ignored: true, reason: 'no pending publisher task' });
    return;
  }
  if (!isExpectedPublisherPage(pending, msg.pageUrl || '')) {
    sendResponse({ ok: false, ignored: true, reason: 'publisher page mismatch' });
    return;
  }

  if (msg.publisher === 'sciencedirect' && msg.error) {
    pending.finishError(new Error(msg.error));
    sendResponse({ ok: true, action: 'science_direct_error' });
    return;
  }

  if (msg.publisher === 'sciencedirect' && msg.clicked) {
    post(pending.port, 'progress', '已在 ScienceDirect 页面触发原生 View PDF 按钮，继续监听浏览器下载。');
    sendResponse({ ok: true, action: 'clicked_native_view_pdf' });
    return;
  }

  if (msg.publisher === 'sciencedirect' && msg.pdfUrl) {
    if (pending.lastNativePdfUrl === msg.pdfUrl) {
      sendResponse({ ok: true, ignored: true, reason: 'same native pdf url already handled' });
      return;
    }
    pending.lastNativePdfUrl = msg.pdfUrl;
    if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
    post(pending.port, 'progress', '已从 ScienceDirect 原生 View PDF 入口取得下载链接，正在打开该链接。');
    chrome.tabs.update(tabId, { url: msg.pdfUrl })
      .then(() => sendResponse({ ok: true, action: 'navigate_to_pdf', pdfUrl: msg.pdfUrl }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.publisher === 'nature' && msg.pdfUrl) {
    if (pending.lastNativePdfUrl === msg.pdfUrl) {
      sendResponse({ ok: true, ignored: true, reason: 'same native pdf url already handled' });
      return;
    }
    pending.lastNativePdfUrl = msg.pdfUrl;
    if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);

    if (msg.clicked) {
      post(pending.port, 'progress', '已在 Nature 文章页触发原生正文 PDF 下载按钮，继续监听浏览器下载。');
      sendResponse({ ok: true, action: 'clicked_nature_pdf', pdfUrl: msg.pdfUrl });
      return;
    }

    post(pending.port, 'progress', '已从 Nature 文章页取得正文 PDF 下载链接，正在打开该链接。');
    chrome.tabs.update(tabId, { url: msg.pdfUrl })
      .then(() => sendResponse({ ok: true, action: 'navigate_to_nature_pdf', pdfUrl: msg.pdfUrl }))
      .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  sendResponse({ ok: false, ignored: true, reason: 'unsupported publisher' });
});

// PRIVATE_WATCHER_ONLY
importScripts('auto_watcher.js');
globalThis.initPrivateAutoWatcher({
  getOptions,
  enqueueUpload,
  sendNativeMessage,
  hasActiveTask: () => !!activeTask || taskQueue.length > 0,
  urlHostPath,
  defaultListUrls: DEFAULT_OPTIONS.watcherListUrls.slice()
});
