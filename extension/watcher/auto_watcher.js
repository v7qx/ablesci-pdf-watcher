'use strict';

(function () {
  const ALARM_NAME = 'ablesciAutoWatcher';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
  const AUTO_WATCHER_TRACE_KEY = 'autoWatcherTraceLogs';
  const AUTO_WATCHER_ABNORMAL_KEY = 'autoWatcherAbnormalRecords';
  const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
  const JOURNAL_ACCESS_LOOKUP_KEY = 'journalAccessLookupIndex';
  const JOURNAL_SHORT_NAME_MAP_KEY = 'journalShortNameMap';
  const MAX_LOGS = 200;
  const MAX_TRACE_LOGS = 300;
  const TRACE_FLUSH_INTERVAL_MS = 5 * 1000;
  const TRACE_FLUSH_BATCH_SIZE = 20;
  const NATIVE_CONFIG_TIMEOUT_MS = 15 * 1000;
  const NATIVE_REPORT_TIMEOUT_MS = 30 * 1000;
  const MAX_SESSION_CANDIDATES = 10;
  const ACTIVE_RUN_RETENTION_DAYS = 62;
  const REPORT_DIR = 'ablesci-watcher-reports';
  const WATCHER_DAILY_LIMIT_MAX = 2000;
  const DOI_FAILURE_SKIP_THRESHOLD = 5;

  let deps = null;
  const stateRef = { autoWatcherRunning: false };
  const BADGE_REFRESH_INTERVAL_MS = 30 * 1000;
  const HIGH_RISK_FAIL_THRESHOLD = 10;
  const WATCHER_LOG_FLUSH_INTERVAL_MS = 5 * 1000;
  const WATCHER_LOG_FLUSH_BATCH_SIZE = 20;
  const {
    clampNumber,
    normalizeOptions: normalizeSharedOptions
  } = globalThis.AblesciWatcherConfig;
  const { beijingMinutesNow } = globalThis.AblesciWatcherWorktime;
  const {
    formatBeijingDateTime,
    formatBeijingTimeOnly,
    formatBeijingDateOnly,
    reportJson,
    reportValueForJson,
    countdownText,
    todayKey,
    normalizeText,
    normalizeListUrls,
    getListUrlKey,
    pageRangeMetaFromUrl,
    randomizeAssistListUrlWithMeta,
    randomizeAssistListUrl,
    listUrlsForRun
  } = globalThis.AblesciAutoWatcherUtils;
  const { sanitizeTraceValue } = globalThis.AblesciWatcherLogging;
  const { createWatcherStateApi } = globalThis.AblesciWatcherStateModule;
  const { createWatcherReportApi } = globalThis.AblesciWatcherReportModule;
  const { createWatcherCandidateApi } = globalThis.AblesciWatcherCandidateModule;
  const { createWatcherCandidateQueueApi } = globalThis.AblesciWatcherCandidateQueueModule;
  const { createWatcherListFetcherApi } = globalThis.AblesciWatcherListFetcherModule;
  const { createWatcherRunnerApi } = globalThis.AblesciWatcherRunnerModule;
  const { createWatcherTargetApi } = globalThis.AblesciWatcherTargetModule;
  const { createWatcherMarketApi } = globalThis.AblesciWatcherMarketModule;
  const { createWatcherSessionApi } = globalThis.AblesciWatcherSessionModule;
  const { createWatcherNotificationApi } = globalThis.AblesciWatcherNotificationModule;
  const { createWatcherScheduleApi } = globalThis.AblesciWatcherScheduleModule;
  const { createWatcherLoggingApi } = globalThis.AblesciWatcherLoggingModule;
  const { createWatcherRuntimeHelpersApi } = globalThis.AblesciWatcherRuntimeHelpersModule;
  const { createWatcherBootstrapApi } = globalThis.AblesciWatcherBootstrapModule;
  const { createWatcherListScanStatusApi } = globalThis.AblesciWatcherListScanStatusModule;
  const { createWatcherCandidateProcessorApi } = globalThis.AblesciWatcherCandidateProcessorModule;
  const { createWatcherPublisherCountsApi } = globalThis.AblesciWatcherPublisherCountsModule;
  const { createWatcherOrchestratorApi } = globalThis.AblesciWatcherOrchestratorModule;
  const { createWatcherEntryApi } = globalThis.AblesciWatcherEntryModule;
  const WATCHER_STORAGE_KEYS = [
    AUTO_WATCHER_STATE_KEY,
    AUTO_WATCHER_LOG_KEY,
    AUTO_WATCHER_TRACE_KEY,
    'autoWatcherCandidateAudit',
    'autoWatcherCandidateAuditIndex'
  ];

  const {
    getWatcherState,
    saveWatcherState,
    updateWatcherState,
    updateProcessed,
    incrementDaily,
    recordRunStart,
    recordRunFinish,
    recordAttemptFinish,
    getDailyCount,
    dailyCounterSnapshot,
    pruneWatcherState,
    emergencyStorageTrim
  } = createWatcherStateApi({
    chromeApi: globalThis.chrome,
    stateKey: AUTO_WATCHER_STATE_KEY,
    todayKey,
    normalizeText,
    activeRunRetentionDays: ACTIVE_RUN_RETENTION_DAYS,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    updateActionBadge: state => updateActionBadge(state),
    largeStorageKeys: WATCHER_STORAGE_KEYS
  });
  const { publisherAlias } = createWatcherMarketApi({ normalizeText });
  const {
    preparePublisherPool,
    refreshCacheFromParsedIfDue: refreshPublisherCountCacheFromParsedIfDue
  } = createWatcherPublisherCountsApi();
  const {
    monthDone,
    calculateTargetState,
    candidateSource
  } = createWatcherTargetApi({
    todayKey,
    normalizeText,
    clampNumber,
    formatBeijingDateTime,
    riskSnapshot: (state, opts) => riskSnapshot(state, opts),
    publisherAlias
  });
  const {
    candidatePublisherName,
    normalizeDocumentType,
    normalizeJournalKey,
    journalRuleNames,
    candidateJournalNames,
    journalShortNameMapFromState,
    journalShortNameMapEntry,
    journalAccessStatsFromState,
    enrichCandidateJournalFromMap,
    rememberJournalShortNameMapping,
    recordJournalAccessBlocked,
    clearJournalAccessBlocked,
    isLikelyRscCandidate,
    describeWatcherReason,
    orderCandidatesForRun,
    parseAssistListPage,
    minSeekingGateForList,
    waitForAssistListDom,
    isListCandidateAllowed,
    isDetailAllowedForWatcher,
    isRscPayload
  } = createWatcherCandidateApi({
    chromeApi: globalThis.chrome,
    saveWatcherState,
    getWatcherState,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    publisherAlias: value => publisherAlias(value),
    normalizeText,
    journalShortNameMapKey: JOURNAL_SHORT_NAME_MAP_KEY,
    highRiskFailThreshold: HIGH_RISK_FAIL_THRESHOLD,
    doiFailureSkipThreshold: DOI_FAILURE_SKIP_THRESHOLD
  });
  const depsRef = {
    get getOptions() { return deps?.getOptions?.bind(deps); },
    get sendNativeMessage() { return deps?.sendNativeMessage?.bind(deps); },
    get hasActiveTask() { return deps?.hasActiveTask?.bind(deps); },
    get hasPublisherTask() { return deps?.hasPublisherTask?.bind(deps); },
    get enqueueUpload() { return deps?.enqueueUpload?.bind(deps); },
    get urlHostPath() { return deps?.urlHostPath?.bind(deps); },
    get defaultListUrls() { return deps?.defaultListUrls; }
  };
  const {
    getProcessedKey,
    wasRecentlyProcessed,
    sleepMinutes,
    nextRiskResumeAt,
    recoverStaleWatcherState
  } = createWatcherBootstrapApi({
    getWatcherState,
    saveWatcherState,
    appendWatcherTrace: (...args) => appendWatcherTrace(...args),
    updateActionBadge: (...args) => updateActionBadge(...args)
  });
  const {
    normalizeOptions,
    maxSessionCandidates,
    dailyDownloadedFromState,
    sessionExecutionCap,
    quotaResetDelayMinutes,
    isAssistDue,
    targetStateSnapshot,
    mergeFrozenTargetState,
    checkShortTermRateLimit,
    nextRateLimitClearDelayMinutes
  } = createWatcherRuntimeHelpersApi({
    depsRef,
    maxSessionCandidatesConst: MAX_SESSION_CANDIDATES,
    defaultOptions: DEFAULT_OPTIONS,
    normalizeSharedOptions,
    clampNumber,
    normalizeListUrls,
    beijingMinutesNow,
    normalizeText,
    nativeConfigTimeoutMs: NATIVE_CONFIG_TIMEOUT_MS,
    countdownText,
    formatBeijingDateTime,
    todayKey,
    dailyCounterSnapshot
  });
  const {
    nextDisplaySchedule,
    updateActionBadge,
    normalizeTraceLevel,
    getTraceLevel,
    appendWatcherTrace,
    flushWatcherTrace,
    clearBufferedWatcherTrace,
    trimStoredWatcherTraceLogs,
    appendWatcherLog,
    flushWatcherLogs,
    clearBufferedWatcherLogs,
    startBadgeRefreshLoop,
    stopBadgeRefreshLoop,
    applyStorageWatcherTraceLevel
  } = createWatcherLoggingApi({
    chromeApi: globalThis.chrome,
    depsRef,
    getWatcherState,
    normalizeOptions,
    normalizeText,
    formatBeijingDateTime,
    countdownText,
    sanitizeTraceValue,
    sanitizeReportUrl: (...args) => sanitizeReportUrl(...args),
    autoWatcherLogKey: AUTO_WATCHER_LOG_KEY,
    autoWatcherTraceKey: AUTO_WATCHER_TRACE_KEY,
    autoWatcherAbnormalKey: AUTO_WATCHER_ABNORMAL_KEY,
    maxLogs: MAX_LOGS,
    maxTraceLogs: MAX_TRACE_LOGS,
    traceFlushIntervalMs: TRACE_FLUSH_INTERVAL_MS,
    traceFlushBatchSize: TRACE_FLUSH_BATCH_SIZE,
    watcherLogFlushIntervalMs: WATCHER_LOG_FLUSH_INTERVAL_MS,
    watcherLogFlushBatchSize: WATCHER_LOG_FLUSH_BATCH_SIZE,
    badgeRefreshIntervalMs: BADGE_REFRESH_INTERVAL_MS
  });
  const {
    removeQueuedCandidate
  } = createWatcherCandidateQueueApi({
    updateWatcherState
  });
  const {
    fetchListUrl
  } = createWatcherListFetcherApi({
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details)
  });

  const {
    sanitizeReportUrl,
    reportDetailValue,
    writeReportFile,
    writeDailyReports
  } = createWatcherReportApi({
    chromeApi: globalThis.chrome,
    deps: depsRef,
    normalizeOptions,
    todayKey,
    flushWatcherLogs: () => flushWatcherLogs(),
    flushWatcherTrace: () => flushWatcherTrace(),
    formatBeijingDateTime,
    formatBeijingTimeOnly,
    formatBeijingDateOnly,
    reportJson,
    reportValueForJson,
    getWatcherState,
    reportDir: REPORT_DIR,
    nativeReportTimeoutMs: NATIVE_REPORT_TIMEOUT_MS,
    autoWatcherStateKey: AUTO_WATCHER_STATE_KEY,
    autoWatcherLogKey: AUTO_WATCHER_LOG_KEY,
    autoWatcherTraceKey: AUTO_WATCHER_TRACE_KEY,
    autoWatcherAbnormalKey: AUTO_WATCHER_ABNORMAL_KEY,
    journalAccessStatsKey: JOURNAL_ACCESS_STATS_KEY,
    alarmName: ALARM_NAME,
    doiFailureSkipThreshold: DOI_FAILURE_SKIP_THRESHOLD
  });
  const {
    notifyWatcherNeedsAttention,
    resetCfChallengeStreak,
    riskSnapshot,
    recordRiskEvent,
    recordCfChallenge
  } = createWatcherNotificationApi({
    chromeApi: chrome,
    deps: depsRef,
    clampNumber,
    todayKey,
    getWatcherState,
    saveWatcherState,
    incrementDaily,
    appendWatcherLog: entry => appendWatcherLog(entry),
    normalizeText,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details)
  });
  const {
    quotaHoldPlan,
    targetDrivenAssistPlan,
    ensureNextAssistSchedule,
    scheduleNextAssistAfterRun,
    hasPendingAssist,
    randomIntervalMinutes,
    refreshAutoWatcherAlarm,
    scheduleWakeForExistingAssist,
    refreshAlarmAfterRun
  } = createWatcherScheduleApi({
    chromeApi: chrome,
    alarmName: ALARM_NAME,
    normalizeOptions,
    deps: depsRef,
    getWatcherState,
    saveWatcherState,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    updateActionBadge,
    clampNumber,
    todayKey,
    dailyDownloadedFromState,
    quotaResetDelayMinutes,
    riskSnapshot,
    targetStateSnapshot,
    nextRateLimitClearDelayMinutes,
    calculateTargetState
  });
  const {
    waitForTabComplete,
    openHiddenTab,
    closeTabQuietly,
    parseListUrl,
    sendDetailMessage,
    extractDetailPayload,
    inspectDetail,
    makeWatcherPort,
    makeSessionPortContext,
    handleAllowedPayload
  } = createWatcherRunnerApi({
    chromeApi: globalThis.chrome,
    deps: depsRef,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    appendWatcherLog: entry => appendWatcherLog(entry),
    writeDailyReports,
    updateProcessed,
    updateWatcherState,
    incrementDaily,
    recordRiskEvent,
    notifyWatcherNeedsAttention,
    getProcessedKey,
    candidateSource,
    rememberJournalShortNameMapping,
    parseAssistListPage,
    fetchListUrl,
    minSeekingGateForList,
    waitForAssistListDom,
    saveWatcherState,
    describeWatcherReason,
    highRiskFailThreshold: HIGH_RISK_FAIL_THRESHOLD,
    journalAccessStatsKey: JOURNAL_ACCESS_STATS_KEY,
    recordJournalAccessBlocked,
    clearJournalAccessBlocked,
    isDetailAllowedForWatcher,
    isListCandidateAllowed,
    enrichCandidateJournalFromMap
  });
  const { sessionSize } = createWatcherSessionApi({
    maxSessionCandidates,
    sessionExecutionCap,
    riskSnapshot
  });
  const {
    normalizeParsedListCandidateContext,
    buildCurrentListScan,
    describeCurrentListScan,
    clearCurrentListScan,
    setCurrentListScan,
    initCurrentPageData,
    updateCurrentPageCandidateStatus
  } = createWatcherListScanStatusApi({
    chromeApi: globalThis.chrome,
    getWatcherState,
    saveWatcherStateSafe: saveWatcherState
  });
  const {
    queueableCandidatesFromList,
    processCandidateBatch
  } = createWatcherCandidateProcessorApi({
    depsRef,
    getWatcherState,
    saveWatcherStateSafe: saveWatcherState,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    incrementDaily,
    enrichCandidateJournalFromMap,
    isListCandidateAllowed,
    describeWatcherReason,
    wasRecentlyProcessed,
    inspectDetail,
    closeTabQuietly,
    updateProcessed,
    appendWatcherLog: entry => appendWatcherLog(entry),
    getProcessedKey,
    isDetailAllowedForWatcher,
    handleAllowedPayload,
    removeQueuedCandidate,
    updateCurrentPageCandidateStatus
  });
  const { runAutoWatcherOnce } = createWatcherOrchestratorApi({
    depsRef,
    stateRef,
    normalizeOptions,
    recordRunStart,
    getWatcherState,
    saveWatcherState,
    dailyCounterSnapshot,
    todayKey,
    monthDone,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    recordCfChallenge,
    formatBeijingDateTime,
    resetCfChallengeStreak,
    isAssistDue,
    checkShortTermRateLimit,
    calculateTargetState,
    mergeFrozenTargetState,
    getDailyCount,
    sessionExecutionCap,
    riskSnapshot,
    sessionSize,
    maxSessionCandidates,
    dailyDownloadedFromState,
    saveWatcherStateSafe: saveWatcherState,
    listUrlsForRun,
    preparePublisherPool,
    refreshPublisherCountCacheFromParsedIfDue,
    pageRangeMetaFromUrl,
    randomizeAssistListUrlWithMeta,
    incrementDaily,
    parseListUrl,
    minSeekingGateForList,
    orderCandidatesForRun,
    appendWatcherLog: entry => appendWatcherLog(entry),
    recordRunFinish,
    scheduleNextAssistAfterRun,
    refreshAlarmAfterRun,
    recordAttemptFinish,
    writeDailyReports,
    flushWatcherLogs,
    flushWatcherTrace,
    queueableCandidatesFromList,
    processCandidateBatch,
    normalizeParsedListCandidateContext,
    buildCurrentListScan,
    describeCurrentListScan,
    clearCurrentListScan,
    setCurrentListScan,
    initCurrentPageData,
    pruneWatcherState,
    emergencyStorageTrim
  });

  const { initAutoWatcher } = createWatcherEntryApi({
    chromeApi: chrome,
    depsRef,
    setDeps(nextDeps) { deps = nextDeps; },
    alarmName: ALARM_NAME,
    autoWatcherStateKey: AUTO_WATCHER_STATE_KEY,
    autoWatcherLogKey: AUTO_WATCHER_LOG_KEY,
    autoWatcherTraceKey: AUTO_WATCHER_TRACE_KEY,
    startBadgeRefreshLoop,
    stopBadgeRefreshLoop,
    updateActionBadge,
    recoverStaleWatcherState,
    refreshAutoWatcherAlarm,
    flushWatcherLogs,
    flushWatcherTrace,
    appendWatcherTrace,
    applyStorageWatcherTraceLevel,
    runAutoWatcherOnce,
    getWatcherState,
    saveWatcherState,
    clearBufferedWatcherLogs,
    clearBufferedWatcherTrace,
    trimStoredWatcherTraceLogs,
    notifyWatcherNeedsAttention,
    normalizeOptions,
    randomIntervalMinutes,
    stateRef
  });

  globalThis.initAutoWatcher = initAutoWatcher;
  globalThis.AblesciWatcherState = {
    incrementDaily,
    getWatcherState,
    saveWatcherState,
    updateWatcherState,
    appendWatcherTrace
  };
})();
