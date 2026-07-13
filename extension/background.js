'use strict';

importScripts(
  'common/common_config.js',
  'common/common_storage.js',
  'common/common_logging.js',
  'common/common_worktime.js',
  'common/publisher_capabilities.js',
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
  'background/tab_registry.js',
  'background/watcher_metrics.js'
);

const {
  DEFAULT_OPTIONS,
  WATCHER_DAILY_LIMIT_MAX,
  sanitizePathPart,
  normalizeSizeUnit,
  clampNumber,
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
  extractAllScienceDirectPiis,
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
  isAcsBookUrl,
  isIeeeUrl,
  isOxfordUrl,
  publisherForUrl,
  publisherForDoi,
  validatePublisherLanding,
  isScienceDirectPdfUrl,
  isDoiUrl,
  isScienceDirectRelatedHost,
  isScienceDirectAssetPdfUrl,
  natureArticleUrlFromPdfUrl,
  isCnpeUrl,
  isSageUrl,
  isSageKnowledgeUrl,
  classifySageKnowledgeUrl,
  classifyUnsupportedPublisherContentUrl,
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
const { createBackgroundWatcherMetricsApi } = globalThis.AblesciBackgroundWatcherMetrics;

const PUBLISHER_TAB_REGISTRY_KEY = 'publisherTabRegistry';
const UPLOAD_TASK_SNAPSHOT_KEY = 'uploadTaskSnapshot';
const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
const NATIVE_MESSAGE_DEFAULT_TIMEOUT_MS = 30 * 1000;
const NATIVE_MESSAGE_LONG_TIMEOUT_MS = 5 * 60 * 1000;
const ORPHAN_PUBLISHER_TAB_MAX_AGE_MS = 5 * 60 * 1000;
const HTML_DOWNLOAD_MESSAGE = '浏览器下载到了 HTML 页面，而不是 PDF。可能是未登录、没有权限、机构认证失效、验证码或出版商错误页。插件已停止，不会上传。';

// tabId -> pending publisher task. 只对插件主动打开的出版商页生效，避免污染普通浏览。
const pendingPublisherTabs = new Map();

const { recordManualWatcherDaily } = createBackgroundWatcherMetricsApi({
  chromeApi: chrome,
  autoWatcherStateKey: AUTO_WATCHER_STATE_KEY
});

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
  appendDiagnosticTrace,
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
  recordPublisherCfChallenge,
  recordPublisherDailyLimit,
  reserveScienceDirectAttempt,
  clearPublisherCfChallengeState
} = createBackgroundUploadGuardsApi({
  chromeApi: chrome,
  defaultOptions: DEFAULT_OPTIONS,
  getOptions,
  urlHostPath
});
const {
  handlePublisherTabUpdated,
  handlePublisherRuntimeMessage,
  postDebugLog
} = createBackgroundPublisherMessagesApi({
  chromeApi: chrome,
  pendingPublisherTabs,
  post,
  hostnameOf,
  isScienceDirectUrl,
  extractScienceDirectPii,
  extractAllScienceDirectPiis,
  isDoiHost,
  isNatureUrl,
  isCnpeUrl,
  isSageUrl,
  isSageKnowledgeUrl,
  classifySageKnowledgeUrl,
  classifyUnsupportedPublisherContentUrl,
  isSpringerUrl,
  isRscUrl,
  isAipUrl,
  isWileyUrl,
  isAcsUrl,
  isAcsBookUrl,
  isIeeeUrl,
  isOxfordUrl,
  isIopUrl,
  isScienceDirectAssetPdfUrl,
  publisherForUrl,
  publisherForDoi,
  validatePublisherLanding,
  isExpectedPublisherPage,
  recordPublisherCfChallenge,
  recordPublisherDailyLimit,
  reserveScienceDirectAttempt,
  appendDiagnosticTrace
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
  isCnpeUrl,
  isSageUrl,
  isSageKnowledgeUrl,
  classifyUnsupportedPublisherContentUrl,
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
  publisherForDoi,
  validatePublisherLanding,
  publisherArticleUrlFromPdfUrl,
  looksLikePdfDownloadUrl,
  isLikelyTargetDownload,
  registerPublisherTab,
  unregisterPublisherTab,
  makeDownloadFilename,
  isHtmlDownloadItem,
  appendDiagnosticTrace,
  postDebugLog
});
const {
  enqueueUpload,
  attachRuntimeListeners,
  hasActiveTask,
  hasPublisherTask
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
  isScienceDirectAssetPdfUrl,
  extractScienceDirectPii,
  cleanupOrphanPublisherTabs,
  post,
  downloadPdf,
  recordPublisherDailyLimit,
  reserveScienceDirectAttempt,
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
  appendDiagnosticTrace,
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
  importScripts('watcher/auto_watcher_utils.js', 'watcher/publisher_limits.js', 'watcher/state.js', 'watcher/report_i18n.js', 'watcher/report.js', 'watcher/candidate.js', 'watcher/candidate_queue.js', 'watcher/list_fetcher.js', 'watcher/runner.js', 'watcher/target.js', 'watcher/market.js', 'watcher/session.js', 'watcher/notification.js', 'watcher/schedule.js', 'watcher/logging.js', 'watcher/runtime_helpers.js', 'watcher/bootstrap.js', 'watcher/list_scan_status.js', 'watcher/assist_sync.js', 'watcher/candidate_processor.js', 'watcher/publisher_counts.js', 'watcher/orchestrator.js', 'watcher/entry.js', 'watcher/auto_watcher.js');
globalThis.initAutoWatcher({
  getOptions,
  enqueueUpload,
  sendNativeMessage,
  hasActiveTask,
  hasPublisherTask,
  urlHostPath,
  defaultListUrls: DEFAULT_OPTIONS.watcherListUrls.slice()
});
