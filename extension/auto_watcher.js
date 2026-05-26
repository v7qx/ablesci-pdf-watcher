'use strict';

(function () {
  const ALARM_NAME = 'ablesciAutoWatcher';
  const BADGE_REFRESH_ALARM_NAME = 'ablesciBadgeRefresh';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
  const AUTO_WATCHER_TRACE_KEY = 'autoWatcherTraceLogs';
  const DEMAND_SNAPSHOTS_KEY = 'demandSnapshots';
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
  const MAX_DEMAND_SNAPSHOTS = 500;
  const MAX_SESSION_CANDIDATES = 10;
  const ACTIVE_RUN_RETENTION_DAYS = 62;
  const MARKET_RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const MARKET_TOP_PUBLISHERS = 8;
  const REPORT_DIR = 'ablesci-watcher-reports';
  const WATCHER_DAILY_LIMIT_MAX = 500;
  const DOI_FAILURE_SKIP_THRESHOLD = 5;
  const ADVANCED_MODEL_MIN_DAYS = 2;
  const FALLBACK_PUBLISHER_WEIGHTS = {
    Elsevier: 2.8,
    ScienceDirect: 2.8,
    Wiley: 1.2,
    Springer: 1.1,
    Nature: 1.0,
    Oxford: 0.9,
    IEEE: 0.7,
    RSC: 0.65,
    Unknown: 0.4
  };
  const SESSION_MODES = {
    slow: { median: 18, min: 10, max: 35, sizeWeights: [0.14, 0.48, 0.25, 0.10, 0.03, 0, 0, 0, 0, 0, 0] },
    normal: { median: 10, min: 5, max: 20, sizeWeights: [0.05, 0.20, 0.34, 0.24, 0.11, 0.04, 0.02, 0, 0, 0, 0] },
    fast: { median: 6, min: 4, max: 15, sizeWeights: [0.02, 0.08, 0.22, 0.27, 0.20, 0.11, 0.06, 0.025, 0.01, 0.004, 0.001] }
  };
  const ADVANCED_ITEM_GAP = { median: 3, min: 1, max: 8 };
  const ADVANCED_COOLDOWN = { median: 18, min: 6, max: 90 };

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
    minutesOfDay,
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
  const { createWatcherDemandApi } = globalThis.AblesciWatcherDemandModule;
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
  const {
    monthKey,
    monthDone,
    daysInCurrentMonth,
    getDemandSnapshots,
    percentileRank,
    medianNumber,
    sumNumbers,
    floorTime,
    candleFromSamples,
    demandSnapshotDays,
    demandRegimeFor,
    classifyDemandSnapshotAnomaly,
    topPublishersFromSamples,
    minuteOfDayFromTimestamp,
    sameSlotPercentile,
    buildMarketDataModel,
    workMinutesForDay,
    workTimeProgressDetails,
    workTimeProgressRatio,
    monthRunCount,
    availabilitySnapshot,
    lagThresholds,
    speedModeFromTarget,
    calculateTargetState,
    calculateAdvancedTargetState,
    candidateSource,
    ensureBanditStats,
    banditItem,
    banditScore,
    weightedSampleWithoutReplacement,
    selectBanditCandidates,
    recordBanditOutcome
  } = createWatcherTargetApi({
    chromeApi: globalThis.chrome,
    demandSnapshotsKey: DEMAND_SNAPSHOTS_KEY,
    maxDemandSnapshots: MAX_DEMAND_SNAPSHOTS,
    marketRawRetentionMs: MARKET_RAW_RETENTION_MS,
    marketTopPublishers: MARKET_TOP_PUBLISHERS,
    fallbackPublisherWeights: FALLBACK_PUBLISHER_WEIGHTS,
    advancedModelMinDays: ADVANCED_MODEL_MIN_DAYS,
    todayKey,
    normalizeText,
    clampNumber,
    formatBeijingDateTime,
    beijingMinutesNow,
    weekdayNumber,
    demandFactorByRegime: regime => demandFactorByRegime(regime),
    trendFactorFromModel: model => trendFactorFromModel(model),
    riskSnapshot: (state, opts) => riskSnapshot(state, opts),
    journalAccessRuleFor: (...args) => journalAccessRuleFor(...args),
    getWatcherState,
    saveWatcherState
  });
  const {
    publisherAlias,
    aggregatePublisherCounts,
    buildFallbackPublisherModel,
    buildAdvancedPublisherModel,
    demandFactorByRegime,
    trendFactorFromModel,
    refreshPublisherModelFromSnapshots
  } = createWatcherMarketApi({
    normalizeText,
    demandSnapshotDays,
    getDemandSnapshots,
    buildMarketDataModel,
    fallbackPublisherWeights: FALLBACK_PUBLISHER_WEIGHTS,
    advancedModelMinDays: ADVANCED_MODEL_MIN_DAYS
  });
  const {
    candidatePublisherName,
    normalizeDocumentType,
    normalizeJournalKey,
    journalRuleNames,
    parseJournalAccessRules,
    candidateJournalNames,
    journalShortNameMapFromState,
    journalShortNameMapEntry,
    enrichCandidateJournalFromMap,
    rememberJournalShortNameMapping,
    journalAccessStatsRank,
    journalAccessStatsIndexFromStats,
    hydrateJournalAccessStatsIndex,
    journalAccessStatsStateFor,
    isListCandidateHighRiskByStats,
    isLikelyRscCandidate,
    isListCandidateDoiHighRiskByStats,
    journalAccessRuleFor,
    describeWatcherReason,
    candidateModelScore,
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
    selectBanditCandidates: (...args) => selectBanditCandidates(...args),
    medianNumber: (...args) => medianNumber(...args),
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
    hydrateJournalAccessRulesFromConfig,
    normalizeObserveTimes,
    normalizeWorkdays,
    normalizeWorkWindows,
    isInWorkSchedule,
    nextWorkDelayMinutes,
    logNormalMinutes,
    weightedPickIndex,
    weightedPickIndexWithDebug,
    maxSessionCandidates,
    dailyDownloadedFromState,
    sessionExecutionCap,
    quotaResetDelayMinutes,
    isAssistDue,
    targetStateSnapshot,
    mergeFrozenTargetState,
    checkShortTermRateLimit
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
    parseJournalAccessRules,
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
    hydrateJournalAccessRulesFromConfig,
    todayKey,
    flushWatcherLogs: () => flushWatcherLogs(),
    flushWatcherTrace: () => flushWatcherTrace(),
    formatBeijingDateTime,
    formatBeijingTimeOnly,
    formatBeijingDateOnly,
    reportJson,
    reportValueForJson,
    getWatcherState,
    journalAccessStatsIndexFromStats,
    parseJournalAccessRules,
    reportDir: REPORT_DIR,
    nativeReportTimeoutMs: NATIVE_REPORT_TIMEOUT_MS,
    autoWatcherStateKey: AUTO_WATCHER_STATE_KEY,
    autoWatcherLogKey: AUTO_WATCHER_LOG_KEY,
    autoWatcherTraceKey: AUTO_WATCHER_TRACE_KEY,
    demandSnapshotsKey: DEMAND_SNAPSHOTS_KEY,
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
    nextRiskResumeAt,
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
    nextRiskResumeAt,
    riskSnapshot,
    nextWorkDelayMinutes,
    targetStateSnapshot
  });
  const {
    isHighRiskJournal,
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
    recordBanditOutcome,
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
    isListCandidateHighRiskByStats,
    isListCandidateDoiHighRiskByStats,
    enrichCandidateJournalFromMap
  });
  const {
    recordDemandSnapshot,
    shouldObserveDemand,
    markObservedSlot,
    collectDemandIfDue
  } = createWatcherDemandApi({
    chromeApi: globalThis.chrome,
    deps: depsRef,
    normalizeOptions,
    todayKey,
    formatBeijingDateTime,
    minutesOfDay,
    beijingMinutesNow,
    getDemandSnapshots,
    classifyDemandSnapshotAnomaly,
    buildMarketDataModel,
    buildAdvancedPublisherModel,
    demandRegimeFor,
    calculateAdvancedTargetState,
    calculateTargetState,
    hasPendingAssist,
    getWatcherState,
    saveWatcherState,
    appendWatcherLog: entry => appendWatcherLog(entry),
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    parseListUrl: url => parseListUrl(url),
    demandSnapshotsKey: DEMAND_SNAPSHOTS_KEY,
    marketRawRetentionMs: MARKET_RAW_RETENTION_MS,
    maxDemandSnapshots: MAX_DEMAND_SNAPSHOTS
  });
  const {
    sessionSize,
    advancedSessionSize,
    runAdvancedSchedulerSession
  } = createWatcherSessionApi({
    sessionModes: SESSION_MODES,
    maxSessionCandidates,
    sessionExecutionCap,
    riskSnapshot,
    weightedPickIndexWithDebug,
    logNormalMinutes,
    advancedItemGap: ADVANCED_ITEM_GAP,
    advancedCooldown: ADVANCED_COOLDOWN,
    saveWatcherState,
    getWatcherState,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    listUrlsForRun,
    randomizeAssistListUrlWithMeta,
    incrementDaily,
    parseListUrl,
    recordCfChallenge,
    resetCfChallengeStreak,
    enrichCandidateJournalFromMap,
    isListCandidateAllowed,
    describeWatcherReason,
    isListCandidateHighRiskByStats,
    isListCandidateDoiHighRiskByStats,
    wasRecentlyProcessed,
    selectBanditCandidates: (...args) => selectBanditCandidates(...args),
    inspectDetail,
    closeTabQuietly,
    updateProcessed,
    appendWatcherLog: entry => appendWatcherLog(entry),
    isDetailAllowedForWatcher,
    getProcessedKey,
    candidateSource,
    handleAllowedPayload,
    sleepMinutes,
    recordRiskEvent,
    recordBanditOutcome
  });
  const { runAutoWatcherOnce } = createWatcherOrchestratorApi({
    depsRef,
    stateRef,
    normalizeOptions,
    hydrateJournalAccessRulesFromConfig,
    recordRunStart,
    getWatcherState,
    saveWatcherState,
    dailyCounterSnapshot,
    todayKey,
    monthDone,
    appendWatcherTrace: (step, details) => appendWatcherTrace(step, details),
    collectDemandIfDue,
    recordCfChallenge,
    isInWorkSchedule,
    formatBeijingDateTime,
    resetCfChallengeStreak,
    hydrateJournalAccessStatsIndex,
    isAssistDue,
    checkShortTermRateLimit,
    refreshPublisherModelFromSnapshots,
    calculateAdvancedTargetState,
    calculateTargetState,
    mergeFrozenTargetState,
    getDailyCount,
    sessionExecutionCap,
    riskSnapshot,
    advancedSessionSize,
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
    isListCandidateHighRiskByStats,
    isListCandidateDoiHighRiskByStats,
    wasRecentlyProcessed,
    inspectDetail,
    closeTabQuietly,
    updateProcessed,
    appendWatcherLog: entry => appendWatcherLog(entry),
    getProcessedKey,
    isDetailAllowedForWatcher,
    handleAllowedPayload,
    runAdvancedSchedulerSession,
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
})();
