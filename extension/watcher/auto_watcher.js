'use strict';

(function () {
  const ALARM_NAME = 'ablesciAutoWatcher';
  const BADGE_REFRESH_ALARM_NAME = 'ablesciBadgeRefresh';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
  const AUTO_WATCHER_TRACE_KEY = 'autoWatcherTraceLogs';
  const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
  const JOURNAL_ACCESS_LOOKUP_KEY = 'journalAccessLookupIndex';
  const JOURNAL_SHORT_NAME_MAP_KEY = 'journalShortNameMap';
  const MAX_LOGS = 200;
  const MAX_TRACE_LOGS = 300;
  const TRACE_FLUSH_INTERVAL_MS = 5 * 1000;
  const TRACE_FLUSH_BATCH_SIZE = 20;
  const NATIVE_CONFIG_TIMEOUT_MS = 15 * 1000;
  const NATIVE_NOTIFY_TIMEOUT_MS = 10 * 1000;
  const NATIVE_REPORT_TIMEOUT_MS = 30 * 1000;
  const MAX_SESSION_CANDIDATES = 10;
  const ACTIVE_RUN_RETENTION_DAYS = 62;
  const REPORT_DIR = 'ablesci-watcher-reports';
  const WATCHER_DAILY_LIMIT_MAX = 500;
  const DOI_FAILURE_SKIP_THRESHOLD = 5;
  const SESSION_MODES = {
    slow: { median: 6, min: 4, max: 15, sizeWeights: [0, 1] },
    normal: { median: 4, min: 2, max: 10, sizeWeights: [0, 1] },
    fast: { median: 2, min: 1, max: 5, sizeWeights: [0, 1] }
  };

  let deps = null;
  const stateRef = { autoWatcherRunning: false };
  const BADGE_REFRESH_INTERVAL_MS = 30 * 1000;
  const HIGH_RISK_FAIL_THRESHOLD = 10;
  const WATCHER_LOG_FLUSH_INTERVAL_MS = 5 * 1000;
  const WATCHER_LOG_FLUSH_BATCH_SIZE = 20;
  const {
    clampNumber,
    normalizeSchedulerMode,
    normalizeOptions: normalizeSharedOptions
  } = globalThis.AblesciWatcherConfig;
  const {
    normalizeWorkdaysSet,
    normalizeWorkWindowsDetailed,
    weekdayNumber,
    beijingMinutesNow,
    isInWorkSchedule: isInWorkScheduleBySet
  } = globalThis.AblesciWatcherWorktime;
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
    randomizeAssistListUrlWithMeta,
    randomizeAssistListUrl,
    listUrlsForRun
  } = globalThis.AblesciAutoWatcherUtils;
  const { sanitizeTraceValue } = globalThis.AblesciWatcherLogging;
  const { createWatcherStateApi } = globalThis.AblesciWatcherStateModule;
  const { createWatcherReportApi } = globalThis.AblesciWatcherReportModule;
  const { createWatcherCandidateApi } = globalThis.AblesciWatcherCandidateModule;
  const { createWatcherRunnerApi } = globalThis.AblesciWatcherRunnerModule;
  const { createWatcherTargetApi } = globalThis.AblesciWatcherTargetModule;
  const { createWatcherMarketApi } = globalThis.AblesciWatcherMarketModule;
  const { createWatcherSessionApi } = globalThis.AblesciWatcherSessionModule;
  const { createWatcherNotificationApi } = globalThis.AblesciWatcherNotificationModule;
  const { createWatcherScheduleApi } = globalThis.AblesciWatcherScheduleModule;
  const { createWatcherLoggingApi } = globalThis.AblesciWatcherLoggingModule;
  const { createWatcherRuntimeHelpersApi } = globalThis.AblesciWatcherRuntimeHelpersModule;
  const { createWatcherBootstrapApi } = globalThis.AblesciWatcherBootstrapModule;
  const { createWatcherOrchestratorApi } = globalThis.AblesciWatcherOrchestratorModule;
  const { createWatcherEntryApi } = globalThis.AblesciWatcherEntryModule;
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
    dailyCounterSnapshot
  } = createWatcherStateApi({
    chromeApi: globalThis.chrome,
    stateKey: AUTO_WATCHER_STATE_KEY,
    todayKey,
    normalizeText,
    normalizeSchedulerMode,
    activeRunRetentionDays: ACTIVE_RUN_RETENTION_DAYS,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    updateActionBadge: state => updateActionBadge(state)
  });
  const { publisherAlias } = createWatcherMarketApi({ normalizeText });
  const {
    monthDone,
    lagThresholds,
    calculateTargetState,
    calculateAdvancedTargetState,
    candidateSource
  } = createWatcherTargetApi({
    todayKey,
    normalizeText,
    clampNumber,
    formatBeijingDateTime,
    beijingMinutesNow,
    weekdayNumber,
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
    enrichCandidateJournalFromMap,
    rememberJournalShortNameMapping,
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
    updateActionBadge: (...args) => updateActionBadge(...args),
    nextWorkDelayMinutes: (...args) => nextWorkDelayMinutes(...args)
  });
  const {
    normalizeOptions,
    normalizeWorkdays,
    normalizeWorkWindows,
    isInWorkSchedule,
    nextWorkDelayMinutes,
    logNormalMinutes,
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
    normalizeWorkdaysSet,
    normalizeWorkWindowsDetailed,
    isInWorkScheduleBySet,
    beijingMinutesNow,
    weekdayNumber,
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
    maxLogs: MAX_LOGS,
    maxTraceLogs: MAX_TRACE_LOGS,
    traceFlushIntervalMs: TRACE_FLUSH_INTERVAL_MS,
    traceFlushBatchSize: TRACE_FLUSH_BATCH_SIZE,
    watcherLogFlushIntervalMs: WATCHER_LOG_FLUSH_INTERVAL_MS,
    watcherLogFlushBatchSize: WATCHER_LOG_FLUSH_BATCH_SIZE,
    badgeRefreshIntervalMs: BADGE_REFRESH_INTERVAL_MS
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
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    nativeNotifyTimeoutMs: NATIVE_NOTIFY_TIMEOUT_MS
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
    sessionModes: SESSION_MODES,
    logNormalMinutes,
    lagThresholds,
    dailyDownloadedFromState,
    quotaResetDelayMinutes,
    riskSnapshot,
    nextWorkDelayMinutes,
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
    incrementDaily,
    recordRiskEvent,
    notifyWatcherNeedsAttention,
    getProcessedKey,
    candidateSource,
    rememberJournalShortNameMapping,
    parseAssistListPage,
    minSeekingGateForList,
    waitForAssistListDom,
    saveWatcherState,
    describeWatcherReason,
    highRiskFailThreshold: HIGH_RISK_FAIL_THRESHOLD,
    journalAccessStatsKey: JOURNAL_ACCESS_STATS_KEY,
    isDetailAllowedForWatcher,
    isListCandidateAllowed,
    enrichCandidateJournalFromMap
  });
  const { sessionSize } = createWatcherSessionApi({
    sessionModes: SESSION_MODES,
    maxSessionCandidates,
    sessionExecutionCap,
    riskSnapshot
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
    isInWorkSchedule,
    formatBeijingDateTime,
    resetCfChallengeStreak,
    isAssistDue,
    checkShortTermRateLimit,
    calculateAdvancedTargetState,
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
    randomizeAssistListUrlWithMeta,
    incrementDaily,
    parseListUrl,
    minSeekingGateForList,
    orderCandidatesForRun,
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
    recordRunFinish,
    scheduleNextAssistAfterRun,
    refreshAlarmAfterRun,
    recordAttemptFinish,
    writeDailyReports,
    flushWatcherLogs,
    flushWatcherTrace
  });

  const { initAutoWatcher } = createWatcherEntryApi({
    chromeApi: chrome,
    depsRef,
    setDeps(nextDeps) { deps = nextDeps; },
    alarmName: ALARM_NAME,
    badgeRefreshAlarmName: BADGE_REFRESH_ALARM_NAME,
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
    stateRef
  });

  globalThis.initAutoWatcher = initAutoWatcher;
  globalThis.AblesciWatcherState = {
    incrementDaily,
    getWatcherState,
    saveWatcherState,
    updateWatcherState
  };
})();
