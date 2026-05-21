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
    slow: { median: 28, min: 15, max: 60, sizeWeights: [0.14, 0.48, 0.25, 0.10, 0.03, 0, 0, 0, 0, 0, 0] },
    normal: { median: 15, min: 8, max: 35, sizeWeights: [0.05, 0.20, 0.34, 0.24, 0.11, 0.04, 0.02, 0, 0, 0, 0] },
    fast: { median: 10, min: 6, max: 25, sizeWeights: [0.02, 0.08, 0.22, 0.27, 0.20, 0.11, 0.06, 0.025, 0.01, 0.004, 0.001] }
  };
  const ADVANCED_ITEM_GAP = { median: 3, min: 1, max: 8 };
  const ADVANCED_COOLDOWN = { median: 18, min: 6, max: 90 };

  let deps = null;
  let autoWatcherRunning = false;
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
    mergeFrozenTargetState
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


  async function runAutoWatcherOnce(trigger = 'alarm') {
    if (autoWatcherRunning) {
      await appendWatcherTrace('run_skip_already_running', { reason: 'already_running', trigger });
      return { ok: false, reason: 'already_running' };
    }
    autoWatcherRunning = true;
    let runResult = null;
    let currentRunOpts = null;
    const attempt = {
      startedAt: new Date().toISOString(),
      trigger,
      resultReason: '',
      observeSnapshot: false,
      observeReason: '',
      nextAssistBefore: '',
      nextAssistAfter: '',
      nextAlarmAfter: '',
      checkedBefore: 0,
      checkedAfter: 0,
      downloadedBefore: 0,
      downloadedAfter: 0,
      failedBefore: 0,
      failedAfter: 0,
      skippedBefore: 0,
      skippedAfter: 0,
      targetSessionSize: '',
      sessionCap: '',
      speedMode: '',
      randomSessionPicked: '',
      randomSessionFinalSize: '',
      randomSessionWeights: '',
      randomValue: '',
      listScanStarted: false,
      pickedListUrl: '',
      pickedPage: '',
      pageCurve: '',
      pageMin: '',
      pageMax: '',
      frontHit: false,
      alpha: ''
    };
    function finish(result) {
      runResult = result;
      return result;
    }
    try {
      await appendWatcherTrace('run_start', { reason: 'watcher_triggered', trigger });
      let opts = normalizeOptions(await deps.getOptions());
      opts = await hydrateJournalAccessRulesFromConfig(opts);
      currentRunOpts = opts;
      await recordRunStart(trigger, opts);
      const initialState = await getWatcherState();
      attempt.nextAssistBefore = initialState.nextAssistRunAt || '';
      Object.assign(attempt, Object.fromEntries(Object.entries(dailyCounterSnapshot(initialState)).map(([key, value]) => [`${key}Before`, value])));
      if (!opts.watcherEnabled && trigger !== 'manual' && trigger !== 'manual-observe') {
        await appendWatcherTrace('run_skip_disabled', { reason: 'disabled', trigger });
        return finish({ ok: false, reason: 'disabled' });
      }
      if (deps.hasActiveTask()) {
        await appendWatcherTrace('run_skip_active_task', { reason: 'active_task', trigger });
        return finish({ ok: false, reason: 'active_task' });
      }

      if (opts.watcherQuantSchedulerEnabled && trigger === 'alarm' && !isInWorkSchedule(opts)) {
        await appendWatcherTrace('run_skip_outside_work_schedule', {
          reason: 'outside_work_schedule',
          trigger
        });
        return finish({ ok: true, reason: 'outside_work_schedule' });
      }
      const observeResult = await collectDemandIfDue(opts, trigger === 'manual-observe');
      attempt.observeSnapshot = observeResult?.snapshot ? true : false;
      attempt.observeReason = observeResult?.reason || '';
      if (observeResult?.reason === 'cf_challenge') {
        if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, opts.watcherDemandObserveUrl);
        return finish({ ok: false, reason: 'cf_challenge' });
      }
      if (trigger === 'manual-observe') {
        return finish({ ok: !!observeResult?.snapshot, reason: observeResult?.snapshot ? 'demand_observed' : 'demand_observe_skipped' });
      }
      if (opts.watcherObserveMode === 'observe_only') {
        return finish({ ok: true, reason: observeResult?.snapshot ? 'observe_only_snapshot' : 'observe_only_waiting' });
      }

      const stateForTargets = await getWatcherState();
      stateForTargets.optionsSnapshot = opts;
      await hydrateJournalAccessStatsIndex(stateForTargets);
      if (trigger === 'alarm' && opts.watcherQuantSchedulerEnabled && !isAssistDue(stateForTargets)) {
        await appendWatcherTrace('run_skip_assist_not_due', {
          reason: observeResult?.snapshot ? 'observed_then_assist_not_due' : 'assist_not_due',
          trigger,
          nextAssistRunAt: stateForTargets.nextAssistRunAt || '',
          nextAssistRunAtBeijing: stateForTargets.nextAssistRunAt ? formatBeijingDateTime(stateForTargets.nextAssistRunAt) : '',
          secondsUntilAssist: stateForTargets.nextAssistRunAt ? Math.round((new Date(stateForTargets.nextAssistRunAt).getTime() - Date.now()) / 1000) : '',
          observeSnapshot: observeResult?.snapshot ? true : false
        });
        return finish({ ok: true, reason: observeResult?.snapshot ? 'observed_assist_not_due' : 'assist_not_due' });
      }
      if (opts.watcherAdvancedSchedulerEnabled && stateForTargets.riskPausedUntil && new Date(stateForTargets.riskPausedUntil).getTime() > Date.now()) {
        await appendWatcherTrace('run_skip_risk_budget_paused', { reason: 'risk_budget_paused', trigger, pausedUntil: stateForTargets.riskPausedUntil });
        return finish({ ok: false, reason: 'risk_budget_paused' });
      }
      if (opts.watcherQuantSchedulerEnabled) await refreshPublisherModelFromSnapshots(stateForTargets);
      const liveTargetState = !opts.watcherQuantSchedulerEnabled
        ? {
            schedulerModelMode: 'fixed',
            speedMode: 'fixed',
            todayTarget: 0,
            demandFactor: 1,
            trendFactor: 1,
            rateMultiplier: 1,
            sessionIntensity: 0
          }
        : opts.watcherAdvancedSchedulerEnabled
        ? calculateAdvancedTargetState(stateForTargets, opts, stateForTargets.marketData || {})
        : calculateTargetState(stateForTargets, opts, stateForTargets.demandRegime || 'normal');
      const frozenTargetState = trigger === 'alarm' && stateForTargets.nextAssistPlanningData?.targetState
        ? stateForTargets.nextAssistPlanningData.targetState
        : null;
      const targetState = mergeFrozenTargetState(liveTargetState, frozenTargetState);
      Object.assign(stateForTargets, targetState);
      stateForTargets.lastAssistDecisionModelData = frozenTargetState ? 'frozen_pending_assist_plan' : 'live_market_data';
      stateForTargets.lastAssistStrategy = opts.watcherAdvancedSchedulerEnabled ? 'advanced_target_market_risk' : (opts.watcherQuantSchedulerEnabled ? 'quant_target_market' : 'fixed_interval');
      stateForTargets.lastAssistDecisionAt = new Date().toISOString();
      stateForTargets.lastAssistDecision = {
        trigger,
        strategy: stateForTargets.lastAssistStrategy,
        modelData: stateForTargets.lastAssistDecisionModelData,
        frozenPlanAt: stateForTargets.nextAssistPlanningData?.plannedAt || '',
        frozenMarketDataAt: stateForTargets.nextAssistPlanningData?.marketDataAt || '',
        speedMode: targetState.speedMode,
        todayTarget: targetState.todayTarget || 0,
        hourTarget: targetState.hourTarget || 0,
        rateMultiplier: targetState.rateMultiplier || 1,
        targetError: targetState.targetError ?? targetState.lag ?? 0,
        workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
        activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
        availabilityFactor: targetState.availabilityFactor || 1,
        availabilityActualWakeCount: targetState.availabilityActualWakeCount || 0,
        availabilityExpectedWakeCount: targetState.availabilityExpectedWakeCount || 0,
        marketRegime: targetState.marketRegime || stateForTargets.demandRegime || '',
        recentH1DemandDelta: targetState.recentH1DemandDelta || 0,
        riskUsed: targetState.riskUsed || 0,
        riskLimit: targetState.riskLimit || 0,
        dailyLimit: opts.watcherDailyLimit || 0
      };
      await saveWatcherState(stateForTargets);
      await appendWatcherTrace('run_target_state', {
        reason: opts.watcherAdvancedSchedulerEnabled ? 'advanced_target' : (opts.watcherQuantSchedulerEnabled ? 'quant_target' : 'fixed_interval'),
        trigger,
        modelData: stateForTargets.lastAssistDecisionModelData,
        speedMode: targetState.speedMode,
        todayTarget: targetState.todayTarget,
        hourTarget: targetState.hourTarget || '',
        rateMultiplier: targetState.rateMultiplier || '',
        targetError: targetState.targetError || targetState.lag || '',
        workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
        activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
        availabilityFactor: targetState.availabilityFactor || 1
      });
      if (targetState.todayTarget > 0 && await getDailyCount('downloaded') >= targetState.todayTarget) {
        await appendWatcherTrace('run_skip_today_target_reached', { reason: 'today_target_reached', trigger, todayTarget: targetState.todayTarget });
        return finish({ ok: false, reason: 'today_target_reached' });
      }
      if (opts.watcherDailyLimit > 0 && await getDailyCount('downloaded') >= opts.watcherDailyLimit) {
        await appendWatcherTrace('run_skip_daily_limit', { reason: 'daily_limit', trigger, dailyLimit: opts.watcherDailyLimit });
        return finish({ ok: false, reason: 'daily_limit' });
      }

      let handledCount = 0;
      const sessionCap = sessionExecutionCap(opts, stateForTargets, opts.watcherQuantSchedulerEnabled !== false);
      const riskForSizing = riskSnapshot(stateForTargets, opts);
      let targetSessionSize = opts.watcherAdvancedSchedulerEnabled
        ? advancedSessionSize(opts, stateForTargets)
        : (opts.watcherQuantSchedulerEnabled ? sessionSize(opts, stateForTargets) : 1);
      const zeroForcedToOne = !opts.watcherAllowZeroSession
        && trigger === 'alarm'
        && opts.watcherObserveMode !== 'observe_only'
        && targetSessionSize <= 0
        && sessionCap > 0
        && (Number(targetState.todayTarget || 0) <= 0 || dailyDownloadedFromState(stateForTargets) < Number(targetState.todayTarget || 0))
        && (Number(opts.watcherDailyLimit || 0) <= 0 || dailyDownloadedFromState(stateForTargets) < Number(opts.watcherDailyLimit || 0));
      if (zeroForcedToOne) {
        targetSessionSize = 1;
        stateForTargets.lastSessionSizeDecision = {
          ...(stateForTargets.lastSessionSizeDecision || {}),
          finalSize: 1,
          forcedMinOne: true,
          forceReason: 'alarm_due_no_zero_session'
        };
        await saveWatcherState(stateForTargets);
      }
      const sizeDecision = stateForTargets.lastSessionSizeDecision || {};
      attempt.targetSessionSize = targetSessionSize;
      attempt.sessionCap = sessionCap;
      attempt.speedMode = targetState.speedMode || '';
      attempt.randomSessionPicked = sizeDecision.picked ?? '';
      attempt.randomSessionFinalSize = sizeDecision.finalSize ?? targetSessionSize;
      attempt.randomSessionWeights = Array.isArray(sizeDecision.weights) ? sizeDecision.weights.join('|') : '';
      attempt.randomValue = sizeDecision.random ?? '';
      await appendWatcherTrace('run_session_size', {
        reason: 'session_size_calculated',
        trigger,
        targetSessionSize,
        zeroForcedToOne,
        decision: stateForTargets.lastSessionSizeDecision || {},
        maxPerSession: maxSessionCandidates(opts),
        sessionCap,
        dailyDownloaded: dailyDownloadedFromState(stateForTargets),
        todayTarget: stateForTargets.todayTarget || 0,
        dailyLimit: opts.watcherDailyLimit || 0,
        riskRemaining: riskForSizing.remaining,
        advanced: opts.watcherAdvancedSchedulerEnabled
      });
      if (targetSessionSize <= 0) return finish({ ok: true, reason: 'session_size_zero', observeSnapshot: observeResult?.snapshot ? true : false });
      if (opts.watcherAdvancedSchedulerEnabled) {
        return finish(await runAdvancedSchedulerSession(opts, stateForTargets, targetSessionSize, observeResult, trigger));
      }

      const runListUrls = listUrlsForRun(opts);
      await appendWatcherTrace('run_source_order', {
        reason: 'randomized_publisher_order',
        trigger,
        listUrls: runListUrls
      });
      for (const listUrl of runListUrls) {
        const pagePick = randomizeAssistListUrlWithMeta(listUrl);
        const pickedListUrl = pagePick.pickedListUrl;
        attempt.listScanStarted = true;
        attempt.pickedListUrl = pickedListUrl;
        attempt.pickedPage = pagePick.pickedPage;
        attempt.pageCurve = pagePick.pageCurve;
        attempt.pageMin = pagePick.pageMin;
        attempt.pageMax = pagePick.pageMax;
        attempt.frontHit = pagePick.frontHit;
        attempt.alpha = pagePick.alpha;
        await appendWatcherTrace('list_scan_start', {
          reason: pickedListUrl === listUrl ? 'configured_url' : 'randomized_page',
          trigger,
          listUrl: pickedListUrl,
          configuredUrl: listUrl,
          publisher: pagePick.publisher,
          pageCurve: pagePick.pageCurve,
          pickedPage: pagePick.pickedPage,
          pageMin: pagePick.pageMin,
          pageMax: pagePick.pageMax,
          frontHit: pagePick.frontHit,
          alpha: pagePick.alpha,
          handledCount,
          targetSessionSize
        });
        stateForTargets.lastPickedListUrl = pickedListUrl;
        await saveWatcherState(stateForTargets);
        await incrementDaily('checked');
        const parsed = await parseListUrl(pickedListUrl);
        if (parsed.cfChallenge) {
          if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, pickedListUrl);
          return finish({ ok: false, reason: 'cf_challenge' });
        }
        await resetCfChallengeStreak();

        const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets, opts, targetSessionSize);
        await appendWatcherTrace('list_scan_candidates', {
          reason: 'ordered_candidates',
          trigger,
          listUrl: pickedListUrl,
          parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
          orderedCount: candidates.length
        });
        for (const rawCandidate of candidates) {
          const candidate = enrichCandidateJournalFromMap(rawCandidate, stateForTargets);
          if (handledCount >= targetSessionSize) return finish({ ok: true, reason: 'session_target_reached' });
          const listAllowed = isListCandidateAllowed(candidate, opts);
          if (!listAllowed.ok) {
            await appendWatcherTrace('candidate_skip_list_filter', {
              reason: listAllowed.reason,
              reasonText: describeWatcherReason(listAllowed.reason),
              trigger,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || '',
              title: candidate.title || ''
            });
            continue;
          }
          if (opts.watcherSkipHighRiskJournal && isListCandidateHighRiskByStats(candidate, stateForTargets)) {
            await appendWatcherTrace('candidate_skip_journal_stats', {
              reason: 'list_high_risk_journal',
              reasonText: describeWatcherReason('list_high_risk_journal'),
              trigger,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || '',
              journalShortName: candidate.journalShortName || '',
              journalFullName: candidate.journalFullName || ''
            });
            continue;
          }
          if (opts.watcherSkipHighRiskJournal && isListCandidateDoiHighRiskByStats(candidate, stateForTargets)) {
            await appendWatcherTrace('candidate_skip_journal_stats', {
              reason: 'list_doi_failure_journal',
              reasonText: describeWatcherReason('list_doi_failure_journal'),
              trigger,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || '',
              journalShortName: candidate.journalShortName || '',
              journalFullName: candidate.journalFullName || ''
            });
            continue;
          }
          if (await wasRecentlyProcessed(candidate)) {
            await appendWatcherTrace('candidate_skip_processed', {
              reason: 'processed_before',
              trigger,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || ''
            });
            continue;
          }

          await appendWatcherTrace('candidate_detail_start', {
            reason: 'candidate_passed_list_filter',
            trigger,
            detailUrl: candidate.detailUrl,
            assistId: candidate.assistId || '',
            title: candidate.title || ''
          });
          const detail = await inspectDetail(candidate);
          if (!detail.ok) {
            await closeTabQuietly(detail.tabId, 'detail_extract_failed');
            await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
            await incrementDaily('failed');
            await appendWatcherLog({ ...candidate, trigger, status: 'failed', reason: detail.reason });
            continue;
          }

          const payload = detail.payload;
          payload.journalShortName = payload.journalShortName || candidate.journalShortName || '';
          const detailAllowed = isDetailAllowedForWatcher(payload, opts);
          const key = getProcessedKey(candidate, payload);
          if (!detailAllowed.ok) {
            await appendWatcherTrace('candidate_skip_detail_filter', { reason: detailAllowed.reason, reasonText: describeWatcherReason(detailAllowed.reason), trigger, detailUrl: candidate.detailUrl, tabId: detail.tabId, assistId: key });
            await closeTabQuietly(detail.tabId, 'detail_filter_skipped');
            await updateProcessed(key, 'skipped', detailAllowed.reason);
            await incrementDaily('skipped');
            await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger, status: 'skipped', reason: detailAllowed.reason });
            continue;
          }

          const handled = await handleAllowedPayload(candidate, payload, opts, detail.tabId, null, trigger);
          if (!handled) await closeTabQuietly(detail.tabId, 'candidate_not_handled');
          if (handled) {
            handledCount += 1;
            await appendWatcherTrace('candidate_handled', { reason: 'handled', trigger, detailUrl: candidate.detailUrl, tabId: detail.tabId, assistId: key, handledCount, targetSessionSize });
            if (handledCount >= targetSessionSize || deps.hasActiveTask()) {
              return finish({ ok: true, reason: handledCount > 1 ? 'session_candidates_handled' : 'candidate_handled' });
            }
          }
        }
      }

      return finish({ ok: true, reason: handledCount ? 'session_candidates_handled' : 'no_candidate' });
    } catch (err) {
      await appendWatcherTrace('run_error', { reason: err?.message || String(err), trigger });
      await incrementDaily('failed');
      await appendWatcherLog({ trigger, status: 'failed', reason: err?.message || String(err) });
      return finish({ ok: false, reason: err?.message || String(err) });
    } finally {
      await appendWatcherTrace('run_finish', { reason: 'finally', trigger });
      await recordRunFinish(trigger, runResult || { ok: false, reason: 'unknown' }).catch(() => {});
      if (currentRunOpts) await scheduleNextAssistAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, trigger).catch(() => {});
      if (currentRunOpts) await refreshAlarmAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, attempt, trigger).catch(() => {});
      await recordAttemptFinish(attempt, runResult || { ok: false, reason: 'unknown' }).catch(() => {});
      try { await writeDailyReports(); } catch (_) {}
      await flushWatcherLogs().catch(() => {});
      await flushWatcherTrace().catch(() => {});
      autoWatcherRunning = false;
    }
  }

  function initPrivateAutoWatcher(nextDeps) {
    deps = nextDeps;
    startBadgeRefreshLoop();

    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM_NAME) runAutoWatcherOnce('alarm');
      if (alarm.name === BADGE_REFRESH_ALARM_NAME) updateActionBadge().catch(() => {});
    });
    chrome.alarms.create(BADGE_REFRESH_ALARM_NAME, { periodInMinutes: 1 });

    chrome.runtime.onStartup.addListener(() => {
      recoverStaleWatcherState('runtime_startup').catch(() => {});
      refreshAutoWatcherAlarm(true, 'runtime_startup').catch(() => {});
    });

    chrome.runtime.onInstalled.addListener(() => {
      recoverStaleWatcherState('runtime_installed').catch(() => {});
      refreshAutoWatcherAlarm(true, 'runtime_installed').catch(() => {});
    });

    chrome.runtime.onSuspend.addListener(() => {
      stopBadgeRefreshLoop();
      flushWatcherLogs().catch(() => {});
      flushWatcherTrace().catch(() => {});
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const watcherKeys = Object.keys(changes).filter(key => key.startsWith('watcher'));
      if (watcherKeys.length) {
        applyStorageWatcherTraceLevel(changes);
        const changedKeys = watcherKeys.slice(0, 12).join(',');
        updateActionBadge().catch(() => {});
        if (watcherKeys.some(key => key !== 'watcherBadgeCountdownEnabled')) {
          refreshAutoWatcherAlarm(true, `storage_changed:${changedKeys}`).catch(() => {});
        }
      }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'ablesciRunAutoWatcherNow') {
        runAutoWatcherOnce('manual')
          .then(sendResponse)
          .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
        return true;
      }
      if (msg?.type === 'ablesciObserveDemandNow') {
        if (autoWatcherRunning) {
          sendResponse({ ok: false, reason: 'already_running' });
          return false;
        }
        getWatcherState()
          .then(state => {
            state.lastManualObserveStartedAt = new Date().toISOString();
            state.lastManualObserveStatus = 'running';
            return saveWatcherState(state);
          })
          .then(() => runAutoWatcherOnce('manual-observe'))
          .then(async result => {
            const state = await getWatcherState();
            state.lastManualObserveFinishedAt = new Date().toISOString();
            state.lastManualObserveStatus = result.ok ? 'ok' : 'failed';
            state.lastManualObserveReason = result.reason || '';
            await saveWatcherState(state);
          })
          .catch(async err => {
            const state = await getWatcherState();
            state.lastManualObserveFinishedAt = new Date().toISOString();
            state.lastManualObserveStatus = 'failed';
            state.lastManualObserveReason = err?.message || String(err);
            await saveWatcherState(state);
          });
        sendResponse({ ok: true, reason: 'demand_observe_started' });
        return false;
      }
      if (msg?.type === 'ablesciTestWatcherNotification') {
        notifyWatcherNeedsAttention('这是一条低频值守测试提醒，不会执行检查。')
          .then(sendResponse)
          .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
        return true;
      }
      if (msg?.type === 'ablesciClearAutoWatcherState') {
        chrome.storage.local.remove(AUTO_WATCHER_STATE_KEY).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg?.type === 'ablesciClearAutoWatcherLogs') {
        Promise.all([clearBufferedWatcherLogs(), clearBufferedWatcherTrace()])
          .then(() => chrome.storage.local.remove([AUTO_WATCHER_LOG_KEY, AUTO_WATCHER_TRACE_KEY]))
          .then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    });

    recoverStaleWatcherState('init').catch(() => {});
    trimStoredWatcherTraceLogs().catch(() => {});
    refreshAutoWatcherAlarm(true, 'init').catch(() => {});
  }

  globalThis.initPrivateAutoWatcher = initPrivateAutoWatcher;
})();
