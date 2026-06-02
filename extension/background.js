'use strict';

importScripts(
  'common/common_config.js',
  'common/common_storage.js',
  'common/common_logging.js',
  'common/common_worktime.js',
  'background/publishers.js',
  'background/port_utils.js',
  'background/native.js',
  'background/file_utils.js',
  'background/diagnostics.js',
  'background/upload_guards.js',
  'background/download_agent.js',
  'background/publisher_messages.js',
  'background/upload_queue.js',
  'background/upload_client.js',
  'background/upload.js',
  'background/task_snapshot.js',
  'background/tab_registry.js'
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
  normalizeOptions
} = globalThis.AblesciWatcherConfig;
const {
  LAST_DIAGNOSTIC_KEY,
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
  isSpringerUrl,
  isRscDirectPdfUrl,
  isRscUrl,
  isAipUrl,
  isWileyUrl,
  aipArticleUrlFromPdfUrl,
  isIopUrl,
  iopArticleUrlFromPdfUrl,
  isAcsUrl,
  isIeeeUrl,
  isOxfordUrl,
  publisherForUrl,
  isScienceDirectPdfUrl,
  isDoiUrl,
  isScienceDirectRelatedHost,
  isScienceDirectAssetPdfUrl,
  natureArticleUrlFromPdfUrl,
  springerArticleUrlFromPdfUrl,
  rscArticleUrlFromPdfUrl,
  wileyArticleUrlFromPdfUrl,
  acsArticleUrlFromPdfUrl,
  scienceDirectArticleUrlFromPdfUrl,
  publisherArticleUrlFromPdfUrl,
  looksLikePdfDownloadUrl,
  isLikelyTargetDownload,
  isExpectedPublisherPage
} = globalThis.AblesciBackgroundPublishers;
const { createBackgroundTaskSnapshotApi } = globalThis.AblesciBackgroundTaskSnapshot;
const { createBackgroundTabRegistryApi } = globalThis.AblesciBackgroundTabRegistry;
const { createBackgroundPortUtilsApi } = globalThis.AblesciBackgroundPortUtils;
const { createBackgroundNativeApi } = globalThis.AblesciBackgroundNative;
const { createBackgroundFileUtilsApi } = globalThis.AblesciBackgroundFileUtils;
const { createBackgroundDiagnosticsApi } = globalThis.AblesciBackgroundDiagnostics;
const { createBackgroundUploadGuardsApi } = globalThis.AblesciBackgroundUploadGuards;
const { createBackgroundDownloadAgentApi } = globalThis.AblesciBackgroundDownloadAgent;
const { createBackgroundPublisherMessagesApi } = globalThis.AblesciBackgroundPublisherMessages;
const { createBackgroundUploadQueueApi } = globalThis.AblesciBackgroundUploadQueue;
const { createBackgroundUploadClientApi } = globalThis.AblesciBackgroundUploadClient;
const { createBackgroundUploadApi } = globalThis.AblesciBackgroundUpload;

const PUBLISHER_TAB_REGISTRY_KEY = 'publisherTabRegistry';
const UPLOAD_TASK_SNAPSHOT_KEY = 'uploadTaskSnapshot';
const NATIVE_MESSAGE_DEFAULT_TIMEOUT_MS = 30 * 1000;
const NATIVE_MESSAGE_LONG_TIMEOUT_MS = 5 * 60 * 1000;
const ORPHAN_PUBLISHER_TAB_MAX_AGE_MS = 5 * 60 * 1000;
const HTML_DOWNLOAD_MESSAGE = '浏览器下载到了 HTML 页面，而不是 PDF。可能是未登录、没有权限、机构认证失效、验证码或出版商错误页。插件已停止，不会上传。';

// tabId -> pending publisher task. 只对插件主动打开的出版商页生效，避免污染普通浏览。
const pendingPublisherTabs = new Map();

function todayKeyBeijingForMetrics() {
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

async function recordManualWatcherDaily(field) {
  const key = todayKeyBeijingForMetrics();
  const stored = await chrome.storage.local.get(AUTO_WATCHER_STATE_KEY);
  const state = stored[AUTO_WATCHER_STATE_KEY] && typeof stored[AUTO_WATCHER_STATE_KEY] === 'object'
    ? stored[AUTO_WATCHER_STATE_KEY]
    : { processed: {}, daily: {} };
  state.daily = state.daily || {};
  const daily = state.daily[key] || {};
  state.daily[key] = daily;
  daily.checked = Number(daily.checked || 0);
  daily.downloaded = Number(daily.downloaded || 0);
  daily.downloadedAuto = Number(daily.downloadedAuto || 0);
  daily.downloadedManual = Number(daily.downloadedManual || 0);
  daily.uploaded = Number(daily.uploaded || 0);
  daily.skipped = Number(daily.skipped || 0);
  daily.failed = Number(daily.failed || 0);
  daily.notified = Number(daily.notified || 0);
  daily[field] = Number(daily[field] || 0) + 1;
  if (field === 'downloaded') {
    daily.downloadedManual = Number(daily.downloadedManual || 0) + 1;
    state.monthDone = Number(state.monthDone || 0) + 1;
    state.actualDone = Number(state.actualDone || 0) + 1;
    const previousTargetError = Number(state.targetError || state.lag || 0);
    const previousLag = Number(state.lag || state.targetError || 0);
    state.targetError = previousTargetError - 1;
    state.lag = previousLag - 1;
    if (Number.isFinite(Number(state.actualTotalAssists))) {
      state.actualTotalAssists = Number(state.actualTotalAssists) + 1;
    }
  }
  state.lastManualAssistMetricAt = new Date().toISOString();
  state._version = Number(state._version || 0) + 1;
  await chrome.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
}

async function getOptions() {
  return loadOptionsFromStorage();
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
  pauseWatcherForAccessEnvironment,
  recordAccessEnvironmentSuccess,
  recordPublisherCfChallenge,
  clearPublisherCfChallengeState
} = createBackgroundUploadGuardsApi({
  chromeApi: chrome,
  defaultOptions: DEFAULT_OPTIONS,
  getOptions,
  publisherForUrl,
  urlHostPath
});
const { downloadPdf } = createBackgroundDownloadAgentApi({
  chromeApi: chrome,
  pendingPublisherTabs,
  defaultOptions: DEFAULT_OPTIONS,
  post,
  makeAbortError,
  abortReason,
  throwIfAborted,
  hostnameOf,
  isScienceDirectUrl,
  isDoiUrl,
  isNatureUrl,
  isSpringerUrl,
  isRscDirectPdfUrl,
  isRscUrl,
  isAipUrl,
  isWileyUrl,
  isAcsUrl,
  isIeeeUrl,
  isOxfordUrl,
  isIopUrl,
  publisherForUrl,
  publisherArticleUrlFromPdfUrl,
  looksLikePdfDownloadUrl,
  isLikelyTargetDownload,
  registerPublisherTab,
  unregisterPublisherTab,
  makeDownloadFilename,
  isHtmlDownloadItem
});
const {
  handlePublisherTabUpdated,
  handlePublisherRuntimeMessage
} = createBackgroundPublisherMessagesApi({
  chromeApi: chrome,
  pendingPublisherTabs,
  post,
  hostnameOf,
  isScienceDirectUrl,
  extractScienceDirectPii,
  isDoiHost,
  isNatureUrl,
  isSpringerUrl,
  isRscUrl,
  isAipUrl,
  isWileyUrl,
  isAcsUrl,
  isIeeeUrl,
  isOxfordUrl,
  isIopUrl,
  isScienceDirectAssetPdfUrl,
  isExpectedPublisherPage,
  recordPublisherCfChallenge
});
const {
  enqueueUpload,
  attachRuntimeListeners,
  hasActiveTask
} = createBackgroundUploadApi({
  chromeApi: chrome,
  // PRIVATE_WATCHER_ONLY
  pendingPublisherTabs,
  defaultOptions: DEFAULT_OPTIONS,
  htmlDownloadMessage: HTML_DOWNLOAD_MESSAGE,
  nativeMessageLongTimeoutMs: NATIVE_MESSAGE_LONG_TIMEOUT_MS,
  getOptions,
  throwIfAborted,
  isDoiUrl,
  cleanupOrphanPublisherTabs,
  post,
  downloadPdf,
  pauseWatcherForAccessEnvironment,
  recordAccessEnvironmentSuccess,
  clearPublisherCfChallengeState,
  sendNativeMessage,
  formatBytes,
  formatConfiguredSize,
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
  clearUploadTaskSnapshot,
  createBackgroundUploadQueueApi,
  createBackgroundUploadClientApi,
  handlePublisherTabUpdated,
  handlePublisherRuntimeMessage,
  recordManualWatcherDaily
});
attachRuntimeListeners();

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
  importScripts('watcher/auto_watcher_utils.js', 'watcher/state.js', 'watcher/report.js', 'watcher/candidate.js', 'watcher/runner.js', 'watcher/target.js', 'watcher/market.js', 'watcher/session.js', 'watcher/notification.js', 'watcher/schedule.js', 'watcher/logging.js', 'watcher/runtime_helpers.js', 'watcher/bootstrap.js', 'watcher/orchestrator.js', 'watcher/entry.js', 'watcher/auto_watcher.js');
globalThis.initAutoWatcher({
  getOptions,
  enqueueUpload,
  sendNativeMessage,
  hasActiveTask,
  urlHostPath,
  defaultListUrls: DEFAULT_OPTIONS.watcherListUrls.slice()
});
