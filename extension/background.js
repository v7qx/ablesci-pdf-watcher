'use strict';

importScripts(
  'common_config.js',
  'common_storage.js',
  'common_logging.js',
  'common_worktime.js',
  'background_publishers.js',
  'background_port_utils.js',
  'background_native.js',
  'background_file_utils.js',
  'background_diagnostics.js',
  'background_upload.js',
  'background_task_snapshot.js',
  'background_tab_registry.js',
  'background_journal_rules.js'
);

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
  LAST_DIAGNOSTIC_KEY,
  JOURNAL_ACCESS_STATS_KEY,
  JOURNAL_ACCESS_LOOKUP_KEY,
  loadOptionsFromStorage
} = globalThis.AblesciWatcherStorage;
const {
  hostnameOf,
  urlHostPath,
  maskId,
  redactLocalPaths
} = globalThis.AblesciWatcherLogging;
const {
  isScienceDirectUrl,
  extractScienceDirectPii,
  isDoiHost,
  isNatureUrl,
  isRscDirectPdfUrl,
  isRscUrl,
  publisherForUrl,
  isScienceDirectPdfUrl,
  isDoiUrl,
  isScienceDirectRelatedHost,
  isScienceDirectAssetPdfUrl,
  natureArticleUrlFromPdfUrl,
  rscArticleUrlFromPdfUrl,
  scienceDirectArticleUrlFromPdfUrl,
  publisherArticleUrlFromPdfUrl,
  looksLikePdfDownloadUrl,
  isLikelyTargetDownload,
  isExpectedPublisherPage
} = globalThis.AblesciBackgroundPublishers;
const { createBackgroundTaskSnapshotApi } = globalThis.AblesciBackgroundTaskSnapshot;
const { createBackgroundTabRegistryApi } = globalThis.AblesciBackgroundTabRegistry;
const { createBackgroundJournalRulesApi } = globalThis.AblesciBackgroundJournalRules;
const { createBackgroundPortUtilsApi } = globalThis.AblesciBackgroundPortUtils;
const { createBackgroundNativeApi } = globalThis.AblesciBackgroundNative;
const { createBackgroundFileUtilsApi } = globalThis.AblesciBackgroundFileUtils;
const { createBackgroundDiagnosticsApi } = globalThis.AblesciBackgroundDiagnostics;
const { createBackgroundUploadApi } = globalThis.AblesciBackgroundUpload;

const PUBLISHER_TAB_REGISTRY_KEY = 'publisherTabRegistry';
const UPLOAD_TASK_SNAPSHOT_KEY = 'uploadTaskSnapshot';
const NATIVE_MESSAGE_DEFAULT_TIMEOUT_MS = 30 * 1000;
const NATIVE_MESSAGE_LONG_TIMEOUT_MS = 5 * 60 * 1000;
const ORPHAN_PUBLISHER_TAB_MAX_AGE_MS = 5 * 60 * 1000;
const HTML_DOWNLOAD_MESSAGE = '浏览器下载到了 HTML 页面，而不是 PDF。可能是未登录、没有权限、机构认证失效、验证码或出版商错误页。插件已停止，不会上传。';
let resolveJournalAccessRulesForRuntime = null;

// tabId -> pending publisher task. 只对插件主动打开的出版商页生效，避免污染普通浏览。
const pendingPublisherTabs = new Map();

async function getOptions() {
  const opts = await loadOptionsFromStorage();
  if (typeof resolveJournalAccessRulesForRuntime === 'function') {
    return resolveJournalAccessRulesForRuntime(opts, { persist: true });
  }
  return opts;
}

const {
  post,
  makeAbortError,
  abortReason,
  throwIfAborted
} = createBackgroundPortUtilsApi();

const { sendNativeMessage } = createBackgroundNativeApi({
  chromeApi: chrome,
  defaultTimeoutMs: NATIVE_MESSAGE_DEFAULT_TIMEOUT_MS
});

const {
  formatBytes,
  formatConfiguredSize,
  sanitizeFilename,
  makeDownloadFilename,
  basenameOf,
  extensionOf,
  sizeToBytes,
  formatTaskError,
  stripHtml,
  escapeHtml
} = createBackgroundFileUtilsApi({
  normalizeSizeUnit,
  sanitizePathPart,
  redactLocalPaths,
  htmlDownloadMessage: HTML_DOWNLOAD_MESSAGE,
  defaultOptions: DEFAULT_OPTIONS
});

const {
  getPublisherTabRegistry,
  savePublisherTabRegistry,
  registerPublisherTab,
  unregisterPublisherTab,
  cleanupOrphanPublisherTabs
} = createBackgroundTabRegistryApi({
  chromeApi: chrome,
  publisherTabRegistryKey: PUBLISHER_TAB_REGISTRY_KEY,
  pendingPublisherTabs,
  orphanPublisherTabMaxAgeMs: ORPHAN_PUBLISHER_TAB_MAX_AGE_MS
});

const {
  normalizeJournalKey,
  journalRuleNames,
  readJournalAccessRulesFromConfig,
  writeJournalAccessRulesToConfig,
  removeRuleMatchingJournal,
  promoteJournalAccessRuleAfterSuccess,
  journalAccessRuleSummary,
  resolveJournalAccessRulesForOptions,
  reloadJournalAccessRulesFromConfig,
  recordJournalAccessResult,
  recordJournalAccessResultNow
} = createBackgroundJournalRulesApi({
  chromeApi: chrome,
  parseJournalAccessRules,
  journalAccessStatsKey: JOURNAL_ACCESS_STATS_KEY,
  journalAccessLookupKey: JOURNAL_ACCESS_LOOKUP_KEY,
  sendNativeMessage,
  getOptions,
  normalizeText: value => String(value || '').trim(),
  readConfigTimeoutMs: NATIVE_MESSAGE_DEFAULT_TIMEOUT_MS
});
resolveJournalAccessRulesForRuntime = resolveJournalAccessRulesForOptions;
const {
  makeDiagnosticBase,
  classifyJournalAccessFailureReason,
  isLikelyRscPayload,
  isExpectedTimeoutFailure,
  formatTimeoutDoneMessage,
  sanitizeDownloadItem,
  saveDiagnostic,
  saveErrorDiagnostic,
  isNonPdfAccessPageError,
  isHtmlDownloadItem,
  isHtmlExtension,
  canRemoveHtmlDownloadItem,
  removeDownloadArtifact,
  stopForNonPdfDownload
} = createBackgroundDiagnosticsApi({
  chromeApi: chrome,
  lastDiagnosticKey: LAST_DIAGNOSTIC_KEY,
  htmlDownloadMessage: HTML_DOWNLOAD_MESSAGE,
  maskId,
  redactLocalPaths,
  hostnameOf,
  urlHostPath,
  basenameOf,
  extensionOf,
  getOptions,
  recordJournalAccessResult,
  post,
  escapeHtml,
  formatTaskError
});
const {
  compactTaskSnapshot,
  saveUploadTaskSnapshot,
  clearUploadTaskSnapshot,
  recoverUploadTaskSnapshot
} = createBackgroundTaskSnapshotApi({
  chromeApi: chrome,
  uploadTaskSnapshotKey: UPLOAD_TASK_SNAPSHOT_KEY,
  urlHostPath,
  maskId,
  saveDiagnostic
});
const {
  enqueueUpload,
  attachRuntimeListeners,
  hasActiveTask
} = createBackgroundUploadApi({
  chromeApi: chrome,
  pendingPublisherTabs,
  defaultOptions: DEFAULT_OPTIONS,
  htmlDownloadMessage: HTML_DOWNLOAD_MESSAGE,
  nativeMessageLongTimeoutMs: NATIVE_MESSAGE_LONG_TIMEOUT_MS,
  getOptions,
  post,
  makeAbortError,
  abortReason,
  throwIfAborted,
  hostnameOf,
  urlHostPath,
  isScienceDirectUrl,
  extractScienceDirectPii,
  isDoiHost,
  isNatureUrl,
  isRscDirectPdfUrl,
  isRscUrl,
  publisherForUrl,
  isDoiUrl,
  isScienceDirectAssetPdfUrl,
  publisherArticleUrlFromPdfUrl,
  looksLikePdfDownloadUrl,
  isLikelyTargetDownload,
  isExpectedPublisherPage,
  registerPublisherTab,
  unregisterPublisherTab,
  cleanupOrphanPublisherTabs,
  recordJournalAccessResult,
  sendNativeMessage,
  formatBytes,
  formatConfiguredSize,
  makeDownloadFilename,
  basenameOf,
  extensionOf,
  sizeToBytes,
  formatTaskError,
  stripHtml,
  escapeHtml,
  makeDiagnosticBase,
  classifyJournalAccessFailureReason,
  isLikelyRscPayload,
  isExpectedTimeoutFailure,
  formatTimeoutDoneMessage,
  sanitizeDownloadItem,
  saveDiagnostic,
  saveErrorDiagnostic,
  isNonPdfAccessPageError,
  isHtmlDownloadItem,
  stopForNonPdfDownload,
  saveUploadTaskSnapshot,
  clearUploadTaskSnapshot
});
attachRuntimeListeners();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'ablesciGetJournalAccessRuntimeStatus') {
    getOptions()
      .then(opts => sendResponse({
        ok: true,
        source: opts.watcherJournalAccessRulesSource || (String(opts.watcherJournalAccessRules || '').trim() ? 'chrome.storage.local cache' : ''),
        path: opts.journalAccessConfigPath || '',
        text: String(opts.watcherJournalAccessRules || '').trim(),
        summary: journalAccessRuleSummary(opts.watcherJournalAccessRules || '')
      }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  if (msg?.type === 'ablesciReloadJournalAccessRules') {
    loadOptionsFromStorage()
      .then(opts => reloadJournalAccessRulesFromConfig(opts))
      .then(opts => sendResponse({
        ok: true,
        source: opts.watcherJournalAccessRulesSource || '',
        path: opts.journalAccessConfigPath || '',
        text: String(opts.watcherJournalAccessRules || '').trim(),
        summary: journalAccessRuleSummary(opts.watcherJournalAccessRules || '')
      }))
      .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  }
  return false;
});

recoverUploadTaskSnapshot('service_worker_init').catch(() => {});
cleanupOrphanPublisherTabs('service_worker_init').catch(() => {});
chrome.runtime.onStartup.addListener(() => {
  recoverUploadTaskSnapshot('runtime_startup').catch(() => {});
  cleanupOrphanPublisherTabs('runtime_startup').catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  recoverUploadTaskSnapshot('runtime_installed').catch(() => {});
  cleanupOrphanPublisherTabs('runtime_installed').catch(() => {});
});

// AUTO_WATCHER
  importScripts('auto_watcher_utils.js', 'watcher/state.js', 'watcher/report.js', 'watcher/demand.js', 'watcher/candidate.js', 'watcher/runner.js', 'watcher/target.js', 'watcher/market.js', 'watcher/session.js', 'watcher/notification.js', 'watcher/schedule.js', 'watcher/logging.js', 'watcher/runtime_helpers.js', 'watcher/bootstrap.js', 'watcher/orchestrator.js', 'watcher/entry.js', 'auto_watcher.js');
globalThis.initAutoWatcher({
  getOptions,
  enqueueUpload,
  sendNativeMessage,
  hasActiveTask,
  urlHostPath,
  defaultListUrls: DEFAULT_OPTIONS.watcherListUrls.slice()
});
