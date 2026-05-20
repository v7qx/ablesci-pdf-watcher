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
  let badgeRefreshTimer = null;
  let traceBuffer = [];
  let traceFlushTimer = null;
  let traceFlushPromise = Promise.resolve();
  let watcherLogBuffer = [];
  let watcherLogFlushTimer = null;
  let watcherLogFlushPromise = Promise.resolve();
  let cachedTraceLevel = 'normal';
  let traceLevelLoadedAt = 0;
  const BADGE_REFRESH_INTERVAL_MS = 30 * 1000;
  const HIGH_RISK_FAIL_THRESHOLD = 10;
  const WATCHER_LOG_FLUSH_INTERVAL_MS = 5 * 1000;
  const WATCHER_LOG_FLUSH_BATCH_SIZE = 20;
  const {
    clampNumber,
    normalizeSchedulerMode
  } = globalThis.AblesciWatcherConfig;
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
  const { createWatcherMarketApi } = globalThis.AblesciWatcherMarketModule;
  const { createWatcherSessionApi } = globalThis.AblesciWatcherSessionModule;
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
  function getProcessedKey(candidate, payload) {
    return payload?.assistId || candidate?.assistId || candidate?.detailUrl || '';
  }
  async function wasRecentlyProcessed(candidate) {
    const key = getProcessedKey(candidate);
    if (!key) return false;
    const state = await getWatcherState();
    const item = state.processed?.[key];
    if (!item) return false;
    if (item.status === 'skipped' && /^(reported|rejected|supplement|book_chapter|patent_report|risk_text)$/.test(String(item.reason || ''))) {
      return false;
    }
    return true;
  }
  async function sleepMinutes(minutes) {
    if (minutes <= 0) return;
    await new Promise(resolve => setTimeout(resolve, minutes * 60 * 1000));
  }
  function demandSnapshotDays(snapshots) {
    return new Set((snapshots || [])
      .map(item => item.dayKey || formatBeijingDateTime(item.timestamp, true))
      .filter(Boolean));
  }
  function demandRegimeFor(snapshot, history) {
    const stableHistory = history.filter(item => !item.demandAnomaly);
    const p = percentileRank(stableHistory.map(item => item.totalSeeking), snapshot?.totalSeeking);
    if (p < 0.20) return 'quiet';
    if (p < 0.70) return 'normal';
    if (p < 0.90) return 'busy';
    return 'very_busy';
  }
  function classifyDemandSnapshotAnomaly(snapshot, history) {
    const value = Number(snapshot?.totalSeeking);
    if (!Number.isFinite(value) || value <= 0) {
      return { ok: false, type: 'invalid_total', value };
    }
    const recent = (history || [])
      .filter(item => !item.demandAnomaly && Number.isFinite(Number(item.totalSeeking)) && Number(item.totalSeeking) > 0)
      .slice(0, 60);
    if (!recent.length) return { ok: true };
    const latest = Number(recent[0].totalSeeking);
    if (recent.length < 3) {
      const diff = Math.abs(value - latest);
      if (value >= latest * 4 && diff >= 100) return { ok: false, type: 'sudden_high', value, baseline: latest };
      if (value <= latest * 0.2 && diff >= 100) return { ok: false, type: 'sudden_low', value, baseline: latest };
      return { ok: true };
    }
    const values = recent.map(item => Number(item.totalSeeking));
    const median = medianNumber(values);
    const deviations = values.map(n => Math.abs(n - median));
    const mad = medianNumber(deviations) || 0;
    const absoluteBand = Math.max(120, mad * 6);
    if (value > Math.max(median * 2.8, median + absoluteBand)) {
      return { ok: false, type: 'sudden_high', value, baseline: median, mad };
    }
    if (value < Math.min(median * 0.35, median - absoluteBand)) {
      return { ok: false, type: 'sudden_low', value, baseline: median, mad };
    }
    return { ok: true };
  }

  const depsRef = {
    get getOptions() { return deps?.getOptions?.bind(deps); },
    get sendNativeMessage() { return deps?.sendNativeMessage?.bind(deps); },
    get hasActiveTask() { return deps?.hasActiveTask?.bind(deps); },
    get enqueueUpload() { return deps?.enqueueUpload?.bind(deps); },
    get urlHostPath() { return deps?.urlHostPath?.bind(deps); },
    get defaultListUrls() { return deps?.defaultListUrls; }
  };

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

  function nextDisplaySchedule(state = {}, opts = null) {
    const schedulerMode = opts?.watcherSchedulerMode || state.currentSchedulerMode || '';
    const assistAt = state.nextAssistRunAt || '';
    const wakeAt = state.chromeAlarmScheduledAt || state.nextScheduledAt || '';
    if (schedulerMode === 'fixed') {
      return {
        kind: 'scheduled_check',
        time: wakeAt,
        label: '下一次检查'
      };
    }
    if (assistAt) {
      return {
        kind: 'assist',
        time: assistAt,
        label: '下一次应助尝试'
      };
    }
    return {
      kind: 'wake',
      time: wakeAt,
      label: '下一次唤醒'
    };
  }

  async function updateActionBadge(state = null) {
    try {
      const current = state || await getWatcherState();
      const opts = deps?.getOptions ? normalizeOptions(await deps.getOptions()) : {};
      const schedule = nextDisplaySchedule(current, opts);
      const text = countdownText(schedule.time);
      const shortText = text === 'due'
        ? 'due'
        : (text ? text.replace(/(\d+)m\d+s$/, '$1m').replace(/(\d+)h(\d+)m$/, '$1h') : '');
      if (opts.watcherBadgeCountdownEnabled !== false) {
        await chrome.action.setBadgeText({ text: shortText.slice(0, 4) });
        await chrome.action.setBadgeBackgroundColor({ color: text === 'due' ? '#dc2626' : '#2563eb' });
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
      const title = text
        ? `Ablesci PDF Watcher\n${schedule.label}：${formatBeijingDateTime(schedule.time)}\n倒计时：${text}`
        : 'Ablesci PDF Watcher';
      await chrome.action.setTitle({ title });
    } catch (_) {}
  }

  function normalizeOptions(opts) {
    const schedulerMode = normalizeSchedulerMode(opts);
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    return {
      ...opts,
      watcherEnabled: opts.watcherEnabled === true,
      watcherSchedulerMode: schedulerMode,
      watcherIntervalMinutes: clampNumber(opts.watcherIntervalMinutes, 30, min, max),
      watcherMinIntervalMinutes: min,
      watcherMaxIntervalMinutes: max,
      watcherMaxCandidatesPerRun: 1,
      watcherListUrls: normalizeListUrls(opts.watcherListUrls, deps.defaultListUrls),
      watcherUploadCountdownSeconds: clampNumber(opts.watcherUploadCountdownSeconds, 10, 0, 120),
      watcherDailyLimit: clampNumber(opts.watcherDailyLimit, 10, 0, WATCHER_DAILY_LIMIT_MAX),
      watcherSkipReported: opts.watcherSkipReported !== false,
      watcherSkipRejected: opts.watcherSkipRejected !== false,
      watcherSkipSupplement: opts.watcherSkipSupplement !== false,
      watcherSkipRemark: opts.watcherSkipRemark !== false,
      watcherSkipBookChapter: opts.watcherSkipBookChapter !== false,
      watcherSkipPatentReport: opts.watcherSkipPatentReport !== false,
      watcherSkipRiskText: opts.watcherSkipRiskText !== false,
      watcherJournalAccessRules: String(opts.watcherJournalAccessRules || '').trim(),
      watcherSkipHighRiskJournal: opts.watcherSkipHighRiskJournal !== false,
    watcherDailyReportEnabled: opts.watcherDailyReportEnabled !== false,
    watcherBadgeCountdownEnabled: opts.watcherBadgeCountdownEnabled !== false,
    watcherTraceLevel: ['off', 'normal', 'verbose'].includes(opts.watcherTraceLevel) ? opts.watcherTraceLevel : 'normal',
    watcherReportDir: String(opts.watcherReportDir || '').trim(),
      watcherConfigDir: String(opts.watcherConfigDir || '').trim(),
      watcherNoDownloadTimeoutMinutes: clampNumber(opts.watcherNoDownloadTimeoutMinutes, 1, 0.25, 60),
      watcherDownloadTimeoutMinutes: clampNumber(opts.watcherDownloadTimeoutMinutes, 5, 1, 120),
      watcherTaskTimeoutMinutes: clampNumber(opts.watcherTaskTimeoutMinutes, 10, 1, 180),
      watcherNotifyMode: opts.watcherNotifyMode === 'browser' ? 'browser' : 'native',
      watcherTelegramNotifyEnabled: opts.watcherTelegramNotifyEnabled === true,
      watcherTelegramConfigPath: String(opts.watcherTelegramConfigPath || '').trim(),
      watcherJournalAccessConfigPath: String(opts.watcherJournalAccessConfigPath || '').trim(),
      watcherCfPauseThreshold: clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10),
      watcherQuantSchedulerEnabled: schedulerMode !== 'fixed',
      watcherAdvancedSchedulerEnabled: schedulerMode === 'advanced',
      watcherRiskBudgetLimit: clampNumber(opts.watcherRiskBudgetLimit, 10, 1, 100),
      watcherObserveMode: opts.watcherObserveMode === 'observe_only' ? 'observe_only' : 'assist',
      watcherObserveOnly: opts.watcherObserveMode === 'observe_only',
      watcherDemandObserveUrl: normalizeListUrls([opts.watcherDemandObserveUrl], deps.defaultListUrls)[0],
      watcherObserveTimes: normalizeObserveTimes(opts.watcherObserveTimes),
      watcherObserveIntervalMinutes: clampNumber(opts.watcherObserveIntervalMinutes, 5, 1, 60),
      watcherObserveFallbackMinutes: clampNumber(opts.watcherObserveFallbackMinutes, 180, 30, 720),
      watcherWorkdays: normalizeWorkdays(opts.watcherWorkdays),
      watcherWorkWindows: normalizeWorkWindows(opts.watcherWorkWindows),
      watcherMonthlyTarget: clampNumber(opts.watcherMonthlyTarget, 2000, 0, 5000),
      watcherMinDailyTarget: clampNumber(opts.watcherMinDailyTarget, 5, 0, 500),
      watcherMaxDailyTarget: clampNumber(opts.watcherMaxDailyTarget, 40, 1, 500),
      watcherMaxPerSession: clampNumber(opts.watcherMaxPerSession, 1, 1, MAX_SESSION_CANDIDATES),
      watcherAllowZeroSession: opts.watcherAllowZeroSession === true
    };
  }

  async function hydrateJournalAccessRulesFromConfig(opts) {
    if (!deps?.sendNativeMessage) return opts;
    try {
      const res = await deps.sendNativeMessage(opts.nativeHostName, {
        action: 'read_config_file',
        dir: '',
        config_path: '',
        filename: 'journal-access.json'
      }, NATIVE_CONFIG_TIMEOUT_MS);
      if (!res?.body) return opts;
      const parsed = parseJournalAccessRules(res.body);
      const text = JSON.stringify(parsed, null, 2);
      return {
        ...opts,
        watcherJournalAccessRules: text,
        watcherJournalAccessRulesSource: res.path || 'config.local/journal-access.json'
      };
    } catch (_) {
      return {
        ...opts,
        watcherJournalAccessRulesSource: opts.watcherJournalAccessRules ? 'chrome.storage.local cache' : ''
      };
    }
  }

  function normalizeObserveTimes(value) {
    const raw = Array.isArray(value) ? value : String(value || '09:30\n11:30\n14:00\n16:30\n18:00').split(/\r?\n|,/);
    const values = raw
      .map(item => String(item || '').trim())
      .filter(item => /^([01]\d|2[0-3]):[0-5]\d$/.test(item));
    return Array.from(new Set(values)).sort();
  }

  function normalizeWorkdays(value) {
    const days = String(value || '1,2,3,4,5').split(/[,，\s]+/)
      .map(item => Number(item))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 7);
    return new Set(days.length ? days : [1, 2, 3, 4, 5]);
  }

  function normalizeWorkWindows(value) {
    const raw = Array.isArray(value) ? value : String(value || '09:00-12:00\n13:30-18:00').split(/\r?\n/);
    const windows = raw.map(item => {
      const m = String(item || '').trim().match(/^([0-2]\d:[0-5]\d)\s*[-~]\s*([0-2]\d:[0-5]\d)$/);
      if (!m) return null;
      const start = minutesOfDay(m[1]);
      const end = minutesOfDay(m[2]);
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end, label: `${m[1]}-${m[2]}` } : null;
    }).filter(Boolean);
    return windows.length ? windows : [
      { start: minutesOfDay('09:00'), end: minutesOfDay('12:00'), label: '09:00-12:00' },
      { start: minutesOfDay('13:30'), end: minutesOfDay('18:00'), label: '13:30-18:00' }
    ];
  }

  function minutesOfDay(hhmm) {
    const m = String(hhmm || '').match(/^([0-2]\d):([0-5]\d)$/);
    if (!m) return NaN;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23) return NaN;
    return h * 60 + min;
  }

  function weekdayNumber(date = new Date()) {
    const utc = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();
    return utc === 0 ? 7 : utc;
  }

  function beijingMinutesNow(date = new Date()) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date).reduce((acc, item) => {
      acc[item.type] = item.value;
      return acc;
    }, {});
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  function isInWorkSchedule(opts, date = new Date()) {
    if (!opts.watcherQuantSchedulerEnabled) return true;
    if (!opts.watcherWorkdays.has(weekdayNumber(date))) return false;
    const minute = beijingMinutesNow(date);
    return opts.watcherWorkWindows.some(win => minute >= win.start && minute < win.end);
  }

  function nextWorkDelayMinutes(opts, date = new Date()) {
    if (!opts.watcherQuantSchedulerEnabled || isInWorkSchedule(opts, date)) return null;
    const nowMinute = beijingMinutesNow(date);
    const todayStart = opts.watcherWorkWindows.map(w => w.start).filter(start => start > nowMinute).sort((a, b) => a - b)[0];
    if (opts.watcherWorkdays.has(weekdayNumber(date)) && todayStart !== undefined) {
      return Math.max(1, todayStart - nowMinute + Math.random() * 5);
    }
    for (let d = 1; d <= 7; d += 1) {
      const next = new Date(date.getTime() + d * 24 * 60 * 60 * 1000);
      if (!opts.watcherWorkdays.has(weekdayNumber(next))) continue;
      const firstStart = opts.watcherWorkWindows.map(w => w.start).sort((a, b) => a - b)[0];
      const minutesUntilMidnight = 24 * 60 - nowMinute;
      return minutesUntilMidnight + (d - 1) * 24 * 60 + firstStart + Math.random() * 10;
    }
    return 60;
  }

  function logNormalMinutes(median, min, max) {
    const u1 = Math.max(1e-6, Math.random());
    const u2 = Math.max(1e-6, Math.random());
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const value = median * Math.exp(0.35 * normal);
    return Math.min(max, Math.max(min, value));
  }

  function weightedPickIndex(weights) {
    return weightedPickIndexWithDebug(weights).index;
  }

  function weightedPickIndexWithDebug(weights) {
    const normalized = weights.map(value => Math.max(0, Number(value) || 0));
    const total = normalized.reduce((sum, value) => sum + value, 0);
    if (total <= 0) return { index: 0, random: 0, total, weights: normalized };
    const random = Math.random() * total;
    let r = random;
    for (let i = 0; i < normalized.length; i += 1) {
      r -= normalized[i];
      if (r <= 0) return { index: i, random, total, weights: normalized };
    }
    return { index: normalized.length - 1, random, total, weights: normalized };
  }

  function maxSessionCandidates(opts) {
    return Math.round(clampNumber(opts?.watcherMaxPerSession, 1, 1, MAX_SESSION_CANDIDATES));
  }

  function dailyDownloadedFromState(state) {
    return Number(state?.daily?.[todayKey()]?.downloaded || 0);
  }

  function sessionExecutionCap(opts, state, respectTodayTarget = true) {
    let cap = maxSessionCandidates(opts);
    const downloaded = dailyDownloadedFromState(state);
    if (Number(opts?.watcherDailyLimit || 0) > 0) {
      cap = Math.min(cap, Math.max(0, Number(opts.watcherDailyLimit || 0) - downloaded));
    }
    if (respectTodayTarget && Number(state?.todayTarget || 0) > 0) {
      cap = Math.min(cap, Math.max(0, Number(state.todayTarget || 0) - downloaded));
    }
    return Math.max(0, Math.floor(cap));
  }

  function quotaResetDelayMinutes(opts, date = new Date()) {
    const nowMinute = beijingMinutesNow(date);
    const minutesUntilMidnight = 24 * 60 - nowMinute;
    if (!opts?.watcherQuantSchedulerEnabled) return Math.max(1, minutesUntilMidnight + Math.random() * 5);
    for (let d = 1; d <= 8; d += 1) {
      const next = new Date(date.getTime() + d * 24 * 60 * 60 * 1000);
      if (!opts.watcherWorkdays.has(weekdayNumber(next))) continue;
      const firstStart = opts.watcherWorkWindows.map(w => w.start).sort((a, b) => a - b)[0] ?? 0;
      return Math.max(1, minutesUntilMidnight + (d - 1) * 24 * 60 + firstStart + Math.random() * 10);
    }
    return Math.max(1, minutesUntilMidnight + Math.random() * 5);
  }

  function quotaHoldPlan(opts, state = {}) {
    const downloaded = dailyDownloadedFromState(state);
    if (Number(opts?.watcherDailyLimit || 0) > 0 && downloaded >= Number(opts.watcherDailyLimit || 0)) {
      const minutes = quotaResetDelayMinutes(opts);
      return {
        minutes,
        modelDelayMinutes: minutes,
        guardMinutes: 0,
        reason: 'daily_limit_reached',
        strategy: 'quota_hold',
        dailyDownloaded: downloaded,
        dailyLimit: Number(opts.watcherDailyLimit || 0)
      };
    }
    if (Number(state?.todayTarget || 0) > 0 && downloaded >= Number(state.todayTarget || 0)) {
      const minutes = quotaResetDelayMinutes(opts);
      return {
        minutes,
        modelDelayMinutes: minutes,
        guardMinutes: 0,
        reason: 'today_target_reached',
        strategy: 'target_hold',
        dailyDownloaded: downloaded,
        todayTarget: Number(state.todayTarget || 0)
      };
    }
    return null;
  }

  function assistGuardMinutes(opts) {
    return clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
  }

  function applySoftAssistGuard(modelDelay, guardMinutes) {
    const model = Math.max(0, Number(modelDelay) || 0);
    const guard = Math.max(0, Number(guardMinutes) || 0);
    if (guard <= 0 || model >= guard) {
      return {
        minutes: model,
        guardApplied: false,
        guardLiftMinutes: 0,
        guardWeight: 0,
        hardFloorMinutes: 0,
        guardMode: 'none'
      };
    }

    const ratio = Math.max(0, Math.min(1, model / guard));
    const guardWeight = Math.max(0.25, Math.min(0.8, 0.25 + 0.55 * (1 - ratio)));
    const blended = model + (guard - model) * guardWeight;
    const hardFloor = Math.max(1, guard * 0.5);
    const minutes = Math.max(hardFloor, blended);
    return {
      minutes,
      guardApplied: true,
      guardLiftMinutes: minutes - model,
      guardWeight,
      hardFloorMinutes: hardFloor,
      guardMode: 'soft_blend'
    };
  }

  function targetDrivenAssistPlan(opts, state = {}, reason = 'target_model') {
    const hold = quotaHoldPlan(opts, state);
    if (hold) return hold;
    const guardMinutes = assistGuardMinutes(opts);
    const now = Date.now();
    if (opts.watcherAdvancedSchedulerEnabled && state?.riskPausedUntil) {
      const pauseMs = new Date(state.riskPausedUntil).getTime() - now;
      if (pauseMs > 0) {
        const guarded = applySoftAssistGuard(pauseMs / 60000, guardMinutes);
        return {
          minutes: guarded.minutes,
          modelDelayMinutes: pauseMs / 60000,
          guardMinutes,
          ...guarded,
          reason: 'risk_pause',
          strategy: 'risk_pause'
        };
      }
    }
    if (opts.watcherAdvancedSchedulerEnabled && state?.lastSession) {
      const cooldownUntilMs = state.lastSession.cooldownUntil ? new Date(state.lastSession.cooldownUntil).getTime() : 0;
      if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now) {
        const modelDelay = (cooldownUntilMs - now) / 60000;
        const guarded = applySoftAssistGuard(modelDelay, guardMinutes);
        return {
          minutes: guarded.minutes,
          modelDelayMinutes: modelDelay,
          guardMinutes,
          ...guarded,
          reason: 'session_cooldown',
          strategy: 'session_cooldown'
        };
      }
      const finishedAtMs = state.lastSession.finishedAt ? new Date(state.lastSession.finishedAt).getTime() : 0;
      const cooldownMinutes = Number(state.lastSession.cooldownMinutes || 0);
      if (Number.isFinite(finishedAtMs) && finishedAtMs > 0 && cooldownMinutes > 0) {
        const remaining = cooldownMinutes - ((now - finishedAtMs) / 60000);
        if (remaining > 0) {
          const guarded = applySoftAssistGuard(remaining, guardMinutes);
          return {
            minutes: guarded.minutes,
            modelDelayMinutes: remaining,
            guardMinutes,
            ...guarded,
            reason: 'session_cooldown',
            strategy: 'session_cooldown'
          };
        }
      }
    }
    const mode = SESSION_MODES[state?.speedMode || 'normal'] || SESSION_MODES.normal;
    const rawModelDelay = logNormalMinutes(mode.median, mode.min, mode.max);
    const targetError = Number(state.targetError ?? state.lag ?? 0);
    const monthlyTarget = Math.max(1, Number(opts.watcherMonthlyTarget || 0));
    const thresholds = lagThresholds(monthlyTarget);
    const severeLag = targetError >= thresholds.severe;
    const mediumLag = targetError >= thresholds.medium;
    const lagBoost = targetError > 0 ? Math.min(2.2, 1 + Math.min(1, targetError / monthlyTarget) * 3.2) : 1;
    const rateMultiplier = Number(state.rateMultiplier || 1);
    const demandFactor = Number(state.demandFactor || 1);
    const trendFactor = Number(state.trendFactor || 1);
    const h1Delta = Number(state.recentH1DemandDelta || state.marketData?.h1Delta || 0);
    const marketRegime = state.marketRegime || state.demandRegime || state.marketData?.marketRegime || 'normal';
    const marketBoost = marketRegime === 'very_busy' ? 1.25 : (marketRegime === 'quiet' ? (mediumLag ? 0.95 : 0.8) : 1);
    const trendBoost = h1Delta > 20 ? 1.15 : (h1Delta < -20 ? (severeLag ? 0.97 : 0.9) : 1);
    const risk = riskSnapshot(state, opts);
    const riskPenalty = risk.nearLimit ? 0.55 : 1;
    const combined = Math.max(0.25, Math.min(3.5, rateMultiplier * demandFactor * trendFactor * lagBoost * marketBoost * trendBoost * riskPenalty));
    const modelDelay = rawModelDelay / combined;
    const guarded = applySoftAssistGuard(modelDelay, guardMinutes);
    return {
      minutes: guarded.minutes,
      modelDelayMinutes: modelDelay,
      rawModelDelayMinutes: rawModelDelay,
      guardMinutes,
      ...guarded,
      reason,
      strategy: opts.watcherAdvancedSchedulerEnabled ? 'advanced_target_market_risk' : 'quant_target_market',
      speedMode: state.speedMode || 'normal',
      rateMultiplier,
      targetError,
      marketRegime,
      h1Delta,
      severeLag,
      mediumLag,
      combinedMultiplier: combined
    };
  }

  function ensureNextAssistSchedule(opts, state = {}, reason = 'ensure') {
    if (!opts.watcherQuantSchedulerEnabled || opts.watcherObserveMode === 'observe_only') return null;
    const now = Date.now();
    const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
    if (Number.isFinite(nextAssistMs) && nextAssistMs > now) {
      return {
        minutes: Math.max(1, (nextAssistMs - now) / 60000),
        reason: state.nextAssistReason || reason,
        strategy: state.nextAssistStrategy || ''
      };
    }
    const plan = targetDrivenAssistPlan(opts, state, reason);
    state.nextAssistRunAt = new Date(now + plan.minutes * 60 * 1000).toISOString();
    state.nextAssistReason = plan.reason;
    state.nextAssistStrategy = plan.strategy;
    state.nextAssistDelayMinutes = Number(plan.minutes.toFixed(2));
    state.nextAssistModelDelayMinutes = Number((plan.modelDelayMinutes || plan.minutes).toFixed(2));
    state.nextAssistGuardMinutes = Number((plan.guardMinutes || 0).toFixed(2));
    state.nextAssistGuardApplied = plan.guardApplied === true;
    state.nextAssistGuardLiftMinutes = Number((plan.guardLiftMinutes || 0).toFixed(2));
    state.nextAssistGuardWeight = Number((plan.guardWeight || 0).toFixed(3));
    state.nextAssistGuardMode = plan.guardMode || '';
    state.nextAssistPlannedAt = new Date().toISOString();
    state.nextAssistPlanningData = {
      plannedAt: state.nextAssistPlannedAt,
      marketDataAt: state.lastDemandSnapshotAt || state.marketData?.generatedAt || '',
      appliesNewSamplesAfterThisAttempt: true,
      targetState: targetStateSnapshot(state)
    };
    state.nextAssistPlan = {
      strategy: plan.strategy,
      reason: plan.reason,
      speedMode: plan.speedMode || '',
      rateMultiplier: plan.rateMultiplier || '',
      targetError: plan.targetError || 0,
      marketRegime: plan.marketRegime || '',
      h1Delta: plan.h1Delta || 0,
      dailyDownloaded: plan.dailyDownloaded ?? dailyDownloadedFromState(state),
      dailyLimit: plan.dailyLimit ?? Number(opts.watcherDailyLimit || 0),
      todayTarget: plan.todayTarget ?? Number(state.todayTarget || 0),
      combinedMultiplier: plan.combinedMultiplier || '',
      rawModelDelayMinutes: plan.rawModelDelayMinutes ? Number(plan.rawModelDelayMinutes.toFixed(2)) : '',
      modelDelayMinutes: plan.modelDelayMinutes ? Number(plan.modelDelayMinutes.toFixed(2)) : '',
      guardMinutes: plan.guardMinutes ? Number(plan.guardMinutes.toFixed(2)) : '',
      guardSource: plan.guardMinutes ? 'watcherMinIntervalMinutes' : '',
      guardMode: plan.guardMode || '',
      guardApplied: plan.guardApplied === true,
      guardWeight: plan.guardWeight ? Number(plan.guardWeight.toFixed(3)) : '',
      guardLiftMinutes: plan.guardLiftMinutes ? Number(plan.guardLiftMinutes.toFixed(2)) : '',
      hardFloorMinutes: plan.hardFloorMinutes ? Number(plan.hardFloorMinutes.toFixed(2)) : '',
      finalDelayMinutes: Number(plan.minutes.toFixed(2))
    };
    updateActionBadge(state).catch(() => {});
    return plan;
  }

  async function scheduleNextAssistAfterRun(opts, result, trigger) {
    if (!opts?.watcherQuantSchedulerEnabled || opts.watcherObserveMode === 'observe_only') return null;
    if (trigger === 'manual' || trigger === 'manual-observe') return null;
    const reason = String(result?.reason || '');
    if (/assist_not_due|observe_only|outside_work_schedule|already_running|active_task|disabled/i.test(reason)) return null;
    const state = await getWatcherState();
    delete state.nextAssistRunAt;
    delete state.nextAssistReason;
    delete state.nextAssistStrategy;
    delete state.nextAssistDelayMinutes;
    delete state.nextAssistModelDelayMinutes;
    delete state.nextAssistGuardMinutes;
    delete state.nextAssistGuardApplied;
    delete state.nextAssistGuardLiftMinutes;
    delete state.nextAssistGuardWeight;
    delete state.nextAssistGuardMode;
    delete state.nextAssistPlannedAt;
    delete state.nextAssistPlanningData;
    delete state.nextAssistPlan;
    const plan = ensureNextAssistSchedule(opts, state, `after_${reason || 'run'}`);
    await saveWatcherState(state);
    await appendWatcherTrace('assist_next_scheduled', {
      reason: state.nextAssistReason || '',
      trigger,
      nextAssistRunAt: state.nextAssistRunAt || '',
      delayMinutes: state.nextAssistDelayMinutes || '',
      modelDelayMinutes: state.nextAssistModelDelayMinutes || '',
      guardMinutes: state.nextAssistGuardMinutes || '',
      guardApplied: state.nextAssistGuardApplied === true,
      guardLiftMinutes: state.nextAssistGuardLiftMinutes || '',
      guardWeight: state.nextAssistGuardWeight || '',
      strategy: state.nextAssistStrategy || '',
      plan: state.nextAssistPlan || {}
    });
    return plan;
  }

  function isAssistDue(state = null) {
    const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
    return !Number.isFinite(nextAssistMs) || nextAssistMs <= Date.now() + 1000;
  }

  function hasPendingAssist(state = null) {
    const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
    return Number.isFinite(nextAssistMs) && nextAssistMs > Date.now() + 1000;
  }

  function targetStateSnapshot(state = {}) {
    return {
      schedulerModelMode: state.schedulerModelMode || '',
      speedMode: state.speedMode || '',
      todayTarget: state.todayTarget || 0,
      hourTarget: state.hourTarget || 0,
      rateMultiplier: state.rateMultiplier || 1,
      targetError: state.targetError ?? state.lag ?? 0,
      lag: state.lag ?? state.targetError ?? 0,
      workTimeProgressRatio: state.workTimeProgressRatio || 0,
      activeTimeProgressRatio: state.activeTimeProgressRatio || 0,
      availabilityFactor: state.availabilityFactor || 1,
      availabilityActualWakeCount: state.availabilityActualWakeCount || 0,
      availabilityExpectedWakeCount: state.availabilityExpectedWakeCount || 0,
      demandFactor: state.demandFactor || 1,
      trendFactor: state.trendFactor || 1,
      marketRegime: state.marketRegime || state.marketData?.marketRegime || state.demandRegime || '',
      recentH1DemandDelta: state.recentH1DemandDelta || state.marketData?.h1Delta || 0,
      recentD1DemandDelta: state.recentD1DemandDelta || state.marketData?.d1Delta || 0,
      riskUsed: state.riskUsed || 0,
      riskLimit: state.riskLimit || 0,
      riskRemaining: state.riskRemaining || 0,
      riskExhausted: state.riskExhausted === true
    };
  }

  function mergeFrozenTargetState(liveTarget, frozenTarget) {
    if (!frozenTarget) return liveTarget;
    return {
      ...liveTarget,
      ...frozenTarget,
      actualDone: liveTarget.actualDone ?? liveTarget.monthDone,
      monthDone: liveTarget.monthDone,
      riskUsed: liveTarget.riskUsed ?? frozenTarget.riskUsed,
      riskLimit: liveTarget.riskLimit ?? frozenTarget.riskLimit,
      riskRemaining: liveTarget.riskRemaining ?? frozenTarget.riskRemaining,
      riskExhausted: liveTarget.riskExhausted === true
    };
  }

  function randomIntervalMinutes(opts, state = null) {
    const hold = quotaHoldPlan(opts, state || {});
    if (hold && !opts.watcherQuantSchedulerEnabled) return Math.max(1, hold.minutes);
    if (opts.watcherQuantSchedulerEnabled) {
      const outsideDelay = nextWorkDelayMinutes(opts);
      const observeDelay = opts.watcherObserveIntervalMinutes * (0.85 + Math.random() * 0.30);
      if (outsideDelay !== null) return Math.max(1, outsideDelay);
      const assistPlan = ensureNextAssistSchedule(opts, state, 'alarm_schedule');
      const assistDelay = opts.watcherObserveMode === 'observe_only' ? Number.POSITIVE_INFINITY : Number(assistPlan?.minutes || Number.POSITIVE_INFINITY);
      return Math.max(1, Math.min(assistDelay, observeDelay));
    }
    const base = clampNumber(opts.watcherIntervalMinutes, 30, 1, 1440);
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    const jitter = Math.max(1, Math.round(base * 0.2));
    const low = Math.max(min, base - jitter);
    const high = Math.min(max, base + jitter);
    return low + Math.random() * Math.max(1, high - low);
  }

  async function refreshAutoWatcherAlarm(clearExisting = true, reason = 'refresh') {
    const opts = normalizeOptions(await deps.getOptions());
    await appendWatcherTrace('alarm_refresh_start', { reason, clearExisting, watcherEnabled: opts.watcherEnabled });
    if (clearExisting) {
      await chrome.alarms.clear(ALARM_NAME);
      await appendWatcherTrace('alarm_cleared', { reason });
    }
    if (!opts.watcherEnabled) {
      await appendWatcherTrace('alarm_disabled', { reason });
      return;
    }
    const state = await getWatcherState();
    if (String(reason || '').startsWith('storage_changed:')) {
      delete state.nextAssistRunAt;
      delete state.nextAssistReason;
      delete state.nextAssistStrategy;
      delete state.nextAssistDelayMinutes;
      delete state.nextAssistModelDelayMinutes;
      delete state.nextAssistGuardMinutes;
      delete state.nextAssistGuardApplied;
      delete state.nextAssistGuardLiftMinutes;
      delete state.nextAssistGuardWeight;
      delete state.nextAssistGuardMode;
      delete state.nextAssistPlannedAt;
      delete state.nextAssistPlanningData;
      delete state.nextAssistPlan;
    }
    const delay = randomIntervalMinutes(opts, state);
    state.nextScheduledAt = Date.now() + delay * 60 * 1000;
    state.currentSchedulerMode = opts.watcherSchedulerMode;
    state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : (opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval');
    state.lastAlarmRefreshReason = reason;
    await saveWatcherState(state);
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
    const alarm = await chrome.alarms.get(ALARM_NAME).catch(() => null);
    if (alarm?.scheduledTime) {
      state.chromeAlarmScheduledAt = new Date(alarm.scheduledTime).toISOString();
      state.nextScheduledAt = alarm.scheduledTime;
      await saveWatcherState(state);
    } else {
      state.chromeAlarmScheduledAt = '';
    }
    updateActionBadge(state).catch(() => {});
    await appendWatcherTrace('alarm_scheduled', {
      reason,
      delayMinutes: Number(delay.toFixed(2)),
      nextScheduledAt: new Date(state.nextScheduledAt).toISOString(),
      chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
      nextAssistRunAt: state.nextAssistRunAt || '',
      nextAssistStrategy: state.nextAssistStrategy || '',
      nextAssistReason: state.nextAssistReason || '',
      observeIntervalMinutes: opts.watcherObserveIntervalMinutes || '',
      speedMode: state.speedMode || '',
      rateMultiplier: state.rateMultiplier || ''
    });
  }

  async function scheduleWakeForExistingAssist(opts, state, reason = 'existing_assist_due', minDelayMinutes = 0.05) {
    if (!opts?.watcherEnabled || !opts?.watcherQuantSchedulerEnabled || opts.watcherObserveMode === 'observe_only') return null;
    const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
    if (!Number.isFinite(nextAssistMs) || nextAssistMs <= 0) return null;
    await chrome.alarms.clear(ALARM_NAME);
    const delay = Math.max(minDelayMinutes, (nextAssistMs - Date.now()) / 60000);
    state.nextScheduledAt = Date.now() + delay * 60 * 1000;
    state.currentSchedulerMode = opts.watcherSchedulerMode;
    state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : 'quant_rules';
    state.lastAlarmRefreshReason = reason;
    await saveWatcherState(state);
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
    const alarm = await chrome.alarms.get(ALARM_NAME).catch(() => null);
    if (alarm?.scheduledTime) {
      state.chromeAlarmScheduledAt = new Date(alarm.scheduledTime).toISOString();
      state.nextScheduledAt = alarm.scheduledTime;
      await saveWatcherState(state);
    }
    updateActionBadge(state).catch(() => {});
    await appendWatcherTrace('alarm_scheduled_existing_assist', {
      reason,
      delayMinutes: Number(delay.toFixed(2)),
      nextScheduledAt: new Date(state.nextScheduledAt).toISOString(),
      chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
      nextAssistRunAt: state.nextAssistRunAt || ''
    });
    return delay;
  }

  async function refreshAlarmAfterRun(opts, result, attempt, trigger) {
    if (trigger !== 'alarm') return null;
    const reason = String(result?.reason || '');
    if (reason === 'active_task' && attempt?.nextAssistBefore) {
      const state = await getWatcherState();
      if (!state.nextAssistRunAt) {
        state.nextAssistRunAt = attempt.nextAssistBefore;
        state.nextAssistReason = state.nextAssistReason || 'preserved_after_active_task';
        state.nextAssistStrategy = state.nextAssistStrategy || 'quant_target_market';
      }
      const delay = await scheduleWakeForExistingAssist(opts, state, 'retry_after_active_task', 1);
      if (delay !== null) return delay;
    }
    if (reason === 'observed_assist_not_due' && attempt?.nextAssistBefore) {
      const state = await getWatcherState();
      const beforeMs = new Date(attempt.nextAssistBefore).getTime();
      const currentMs = state.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
      if (Number.isFinite(beforeMs) && beforeMs > 0 && (!Number.isFinite(currentMs) || currentMs <= 0 || currentMs > beforeMs)) {
        state.nextAssistRunAt = attempt.nextAssistBefore;
        state.nextAssistReason = state.nextAssistReason || 'preserved_after_observe';
        state.nextAssistStrategy = state.nextAssistStrategy || 'quant_target_market';
      }
      const delay = await scheduleWakeForExistingAssist(opts, state, 'after_observe_assist_not_due');
      if (delay !== null) return delay;
    }
    return refreshAutoWatcherAlarm(true, 'after_alarm_run');
  }

  async function notifyWatcherNeedsAttention(reason, url) {
    const message = normalizeText(reason || '低频值守需要人工处理。').slice(0, 160);
    const opts = normalizeOptions(await deps.getOptions());
    if (opts.watcherNotifyMode === 'native') {
      try {
        await deps.sendNativeMessage(opts.nativeHostName, {
          action: 'notify_user',
          title: 'Ablesci PDF Watcher',
          message
        }, NATIVE_NOTIFY_TIMEOUT_MS);
        if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
        return { ok: true, mode: 'native' };
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] native notify failed', err);
        if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
        return { ok: false, mode: 'native', reason: err?.message || String(err) };
      }
    }
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Ablesci PDF Watcher',
        message,
        priority: 1,
        requireInteraction: false
      });
      if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
      return { ok: true, mode: 'browser' };
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] browser notification failed', err);
      return { ok: false, mode: 'browser', reason: err?.message || String(err) };
    }
    if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
  }

  async function notifyCfChallengeTelegram(opts, listUrl, streak, paused) {
    if (!opts.watcherTelegramNotifyEnabled || !deps.sendNativeMessage) return { ok: false, reason: 'telegram_disabled' };
    const title = paused ? 'Ablesci 值守已因验证暂停' : 'Ablesci 值守遇到验证';
    const hostPath = deps.urlHostPath(listUrl || '');
    const message = [
      `CF / challenge detected`,
      `streak: ${streak}`,
      `paused: ${paused ? 'yes' : 'no'}`,
      `url: ${hostPath?.host || ''}${hostPath?.path || ''}`
    ].join('\n');
    try {
      return await deps.sendNativeMessage(opts.nativeHostName, {
        action: 'send_telegram',
        config_path: opts.watcherTelegramConfigPath || '',
        title,
        message
      }, NATIVE_NOTIFY_TIMEOUT_MS);
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] telegram notify failed', err);
      return { ok: false, reason: err?.message || String(err) };
    }
  }

  async function resetCfChallengeStreak() {
    const state = await getWatcherState();
    if (!state.cfChallengeStreak && !state.pausedByCfChallenge) return;
    state.cfChallengeStreak = 0;
    state.pausedByCfChallenge = false;
    await saveWatcherState(state);
  }

  async function recordCfChallenge(opts, listUrl) {
    const state = await getWatcherState();
    const threshold = clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10);
    state.cfChallengeStreak = Number(state.cfChallengeStreak || 0) + 1;
    const reached = opts.watcherAdvancedSchedulerEnabled || state.cfChallengeStreak >= threshold;
    if (reached) {
      state.pausedByCfChallenge = true;
      await chrome.storage.local.set({ watcherEnabled: false });
      await chrome.alarms.clear(ALARM_NAME);
    }
    await saveWatcherState(state);
    await incrementDaily('failed');
    if (opts.watcherAdvancedSchedulerEnabled) await recordRiskEvent(opts, 'cf_challenge', 'blocked');
    await appendWatcherLog({
      detailUrl: listUrl,
      status: reached ? 'paused' : 'blocked',
      reason: reached ? `cf_challenge_${state.cfChallengeStreak}_paused` : `cf_challenge_${state.cfChallengeStreak}`
    });
    if (reached) {
      await notifyWatcherNeedsAttention(`连续 ${state.cfChallengeStreak} 次遇到 Ablesci 验证页，已暂停低频值守。手动处理后请重新开启。`, listUrl);
      await incrementDaily('notified');
    }
    const tg = await notifyCfChallengeTelegram(opts, listUrl, state.cfChallengeStreak, reached);
    if (tg?.ok) {
      await appendWatcherLog({
        detailUrl: listUrl,
        status: 'notified',
        reason: reached ? 'telegram_cf_paused' : 'telegram_cf_challenge'
      });
    }
    return reached;
  }

  function monthKey() {
    return todayKey().slice(0, 7);
  }

  function monthDone(state) {
    const prefix = monthKey() + '-';
    return Object.entries(state.daily || {})
      .filter(([key]) => key.startsWith(prefix))
      .reduce((sum, [, value]) => sum + Number(value.downloaded || 0), 0);
  }

  function daysInCurrentMonth() {
    const [year, month] = monthKey().split('-').map(Number);
    return new Date(year, month, 0).getDate();
  }

  function calculateTargetState(state, opts, demandRegime) {
    const done = monthDone(state);
    const monthlyTarget = Number(opts.watcherMonthlyTarget || 0);
    const model = state.publisherModel || { ready: false };
    const modelMode = model.ready ? 'advanced' : 'simple';
    const progress = workTimeProgressDetails(opts);
    const availability = availabilitySnapshot(state, opts, progress);
    const effectiveProgress = availability.enoughData ? availability.activeTimeProgressRatio : progress.ratio;
    const expectedDone = Math.round(monthlyTarget * Math.min(1, effectiveProgress));
    const lag = expectedDone - done;
    const speedMode = speedModeFromTarget({ error: lag, monthlyTarget, demandRegime });
    if (monthlyTarget <= 0) {
      return {
        monthKey: monthKey(),
        monthDone: done,
        expectedDone: 0,
        lag: 0,
        speedMode: 'slow',
        workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
        activeTimeProgressRatio: availability.activeTimeProgressRatio,
        availabilityFactor: availability.availabilityFactor,
        todayTarget: 0,
        schedulerModelMode: 'simple',
        demandFactor: 1,
        trendFactor: 1
      };
    }
    const day = Number(todayKey().slice(8, 10));
    const days = daysInCurrentMonth();
    const baseTodayTarget = Math.max(0, monthlyTarget - done) / Math.max(1, days - day + 1);
    const thresholds = lagThresholds(monthlyTarget);
    const rawDemandFactor = modelMode === 'advanced' ? demandFactorByRegime(demandRegime) : 1;
    const demandFactor = demandRegime === 'quiet' && lag >= thresholds.medium ? Math.max(rawDemandFactor, 0.9) : rawDemandFactor;
    const trendFactor = modelMode === 'advanced' ? trendFactorFromModel(model) : 1;
    const rawTodayTarget = Math.ceil(baseTodayTarget * demandFactor * trendFactor);
    const todayTarget = clampNumber(rawTodayTarget, opts.watcherMinDailyTarget, opts.watcherMinDailyTarget, opts.watcherMaxDailyTarget);
    return {
      monthKey: monthKey(),
      monthDone: done,
      expectedDone,
      lag,
      targetError: lag,
      speedMode,
      workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
      activeTimeProgressRatio: availability.activeTimeProgressRatio,
      availabilityFactor: availability.availabilityFactor,
      availabilityExpectedWakeCount: availability.expectedWakeCount,
      availabilityActualWakeCount: availability.actualWakeCount,
      todayTarget,
      schedulerModelMode: modelMode,
      demandFactor,
      trendFactor
    };
  }

  async function getDemandSnapshots() {
    const stored = await chrome.storage.local.get(DEMAND_SNAPSHOTS_KEY);
    return Array.isArray(stored[DEMAND_SNAPSHOTS_KEY]) ? stored[DEMAND_SNAPSHOTS_KEY] : [];
  }

  function percentileRank(values, value) {
    const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!nums.length || !Number.isFinite(value)) return 0.5;
    const below = nums.filter(n => n <= value).length;
    return below / nums.length;
  }

  function medianNumber(values) {
    const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }

  function sumNumbers(values) {
    return values.map(Number).filter(Number.isFinite).reduce((sum, n) => sum + n, 0);
  }

  function floorTime(value, intervalMs) {
    const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(t)) return 0;
    return Math.floor(t / intervalMs) * intervalMs;
  }

  function candleFromSamples(samples, intervalMs, field) {
    const groups = new Map();
    for (const sample of samples) {
      const t = new Date(sample.timestamp).getTime();
      if (!Number.isFinite(t)) continue;
      const key = floorTime(t, intervalMs);
      const value = Number(field(sample));
      const list = groups.get(key) || [];
      list.push({ t, value, valid: Number.isFinite(value) && value >= 0 });
      groups.set(key, list);
    }
    return Array.from(groups.entries()).sort((a, b) => b[0] - a[0]).map(([start, list]) => {
      const ordered = list.sort((a, b) => a.t - b.t);
      const valid = ordered.filter(item => item.valid);
      const values = valid.map(item => item.value);
      const open = values.length ? values[0] : null;
      const close = values.length ? values[values.length - 1] : null;
      const high = values.length ? Math.max(...values) : null;
      const low = values.length ? Math.min(...values) : null;
      const delta = open === null || close === null ? null : close - open;
      const range = high === null || low === null ? null : high - low;
      return {
        start: new Date(start).toISOString(),
        end: new Date(start + intervalMs).toISOString(),
        open,
        high,
        low,
        close,
        delta,
        range,
        absMove: delta === null ? null : Math.abs(delta),
        sampleCount: ordered.length,
        validSampleCount: valid.length
      };
    });
  }

  function topPublishersFromSamples(samples, topN = MARKET_TOP_PUBLISHERS) {
    const totals = {};
    for (const sample of samples) {
      const counts = aggregatePublisherCounts(sample.publisherCounts);
      for (const [name, count] of Object.entries(counts)) totals[name] = (totals[name] || 0) + count;
    }
    return Object.entries(totals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([name]) => name);
  }

  function minuteOfDayFromTimestamp(value) {
    const s = formatBeijingDateTime(value);
    const m = s.match(/\s(\d{2}):(\d{2}):/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  }

  function sameSlotPercentile(samples, current) {
    const currentValue = Number(current?.totalSeeking);
    if (!Number.isFinite(currentValue)) return 0.5;
    const minute = minuteOfDayFromTimestamp(current.timestamp);
    const values = samples
      .filter(item => item !== current && !item.demandAnomaly)
      .filter(item => Math.abs(minuteOfDayFromTimestamp(item.timestamp) - minute) <= 30)
      .map(item => item.totalSeeking);
    return percentileRank(values, currentValue);
  }

  function buildMarketDataModel(snapshots) {
    const now = Date.now();
    const raw = (snapshots || [])
      .filter(item => item?.timestamp && now - new Date(item.timestamp).getTime() <= MARKET_RAW_RETENTION_MS)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const valid = raw.filter(item => !item.demandAnomaly && Number.isFinite(Number(item.totalSeeking)));
    const latest = valid[0] || null;
    const candles = {
      m15: candleFromSamples(valid, 15 * 60 * 1000, item => item.totalSeeking).slice(0, 96 * 7),
      h1: candleFromSamples(valid, 60 * 60 * 1000, item => item.totalSeeking).slice(0, 24 * 7),
      d1: candleFromSamples(valid, 24 * 60 * 60 * 1000, item => item.totalSeeking).slice(0, 7)
    };
    const topPublishers = topPublishersFromSamples(valid);
    const publisherCandles = {};
    const latestCounts = aggregatePublisherCounts(latest?.publisherCounts);
    for (const publisher of topPublishers) {
      publisherCandles[publisher] = {
        m15: candleFromSamples(valid, 15 * 60 * 1000, item => aggregatePublisherCounts(item.publisherCounts)[publisher]).slice(0, 96),
        h1: candleFromSamples(valid, 60 * 60 * 1000, item => aggregatePublisherCounts(item.publisherCounts)[publisher]).slice(0, 24),
        d1: candleFromSamples(valid, 24 * 60 * 60 * 1000, item => aggregatePublisherCounts(item.publisherCounts)[publisher]).slice(0, 7)
      };
    }
    const h1Delta = candles.h1[0]?.delta ?? (candles.h1.length > 1 ? Number(candles.h1[0].close || 0) - Number(candles.h1[1].close || 0) : 0);
    const d1Delta = candles.d1[0]?.delta ?? (candles.d1.length > 1 ? Number(candles.d1[0].close || 0) - Number(candles.d1[1].close || 0) : 0);
    const totalLatest = Math.max(1, sumNumbers(Object.values(latestCounts)));
    const publisherTrend = {};
    for (const [publisher, c] of Object.entries(publisherCandles)) {
      publisherTrend[publisher] = {
        h1Delta: c.h1[0]?.delta ?? 0,
        d1Delta: c.d1[0]?.delta ?? 0,
        pressure: Number(((latestCounts[publisher] || 0) / totalLatest).toFixed(4))
      };
    }
    return {
      generatedAt: new Date().toISOString(),
      rawSampleCount: raw.length,
      validSampleCount: valid.length,
      latestTotalSeeking: Number(latest?.totalSeeking || 0),
      marketRegime: demandRegimeFor(latest, valid.slice(1)),
      sameSlotPercentile: sameSlotPercentile(valid, latest),
      h1Delta,
      d1Delta,
      topPublishers,
      candles,
      publisherCandles,
      publisherTrend
    };
  }

  function workMinutesForDay(opts) {
    return opts.watcherWorkWindows.reduce((sum, win) => sum + Math.max(0, win.end - win.start), 0);
  }

  function workTimeProgressDetails(opts, date = new Date()) {
    const key = todayKey();
    const [year, month, day] = key.split('-').map(Number);
    let total = 0;
    let elapsed = 0;
    const nowMinute = beijingMinutesNow(date);
    const days = new Date(year, month, 0).getDate();
    for (let d = 1; d <= days; d += 1) {
      const current = new Date(year, month - 1, d, 12, 0, 0);
      if (!opts.watcherWorkdays.has(weekdayNumber(current))) continue;
      const dayMinutes = workMinutesForDay(opts);
      total += dayMinutes;
      if (d < day) elapsed += dayMinutes;
      if (d === day) {
        for (const win of opts.watcherWorkWindows) {
          elapsed += Math.max(0, Math.min(nowMinute, win.end) - win.start);
        }
      }
    }
    const ratio = total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 0;
    return { ratio, elapsedMinutes: elapsed, totalMinutes: total };
  }

  function workTimeProgressRatio(opts, date = new Date()) {
    return workTimeProgressDetails(opts, date).ratio;
  }

  function monthRunCount(state) {
    const prefix = monthKey() + '-';
    return Object.entries(state.daily || {})
      .filter(([key]) => key.startsWith(prefix))
      .reduce((sum, [, value]) => sum + Number(value.totalRuns || 0), 0);
  }

  function availabilitySnapshot(state, opts, progressDetails = null) {
    const details = progressDetails || workTimeProgressDetails(opts);
    const elapsed = Number(details.elapsedMinutes || 0);
    const expectedWakeCount = elapsed > 0
      ? Math.max(1, elapsed / Math.max(1, Number(opts.watcherObserveIntervalMinutes || 5)))
      : 0;
    const actualWakeCount = monthRunCount(state);
    const enoughData = expectedWakeCount >= 6 && actualWakeCount >= 3;
    const rawAvailability = expectedWakeCount > 0 ? actualWakeCount / expectedWakeCount : 1;
    const availabilityFactor = enoughData ? Math.max(0.25, Math.min(1, rawAvailability)) : 1;
    const activeTimeProgressRatio = Math.max(0, Math.min(1, Number(details.ratio || 0) * availabilityFactor));
    return {
      expectedWakeCount: Number(expectedWakeCount.toFixed(2)),
      actualWakeCount,
      rawAvailability: Number(rawAvailability.toFixed(3)),
      availabilityFactor: Number(availabilityFactor.toFixed(3)),
      activeTimeProgressRatio: Number(activeTimeProgressRatio.toFixed(4)),
      enoughData
    };
  }

  function lagThresholds(monthlyTarget) {
    const target = Math.max(1, Number(monthlyTarget || 0));
    return {
      medium: Math.max(10, target * 0.04),
      severe: Math.max(20, target * 0.12),
      ahead: Math.max(10, target * 0.05)
    };
  }

  function speedModeFromTarget({ error, monthlyTarget, demandRegime = 'normal', riskExhausted = false, rateMultiplier = 1 }) {
    if (riskExhausted) return 'slow';
    const thresholds = lagThresholds(monthlyTarget);
    if (error >= thresholds.severe || rateMultiplier >= 1.55) return 'fast';
    if (error >= thresholds.medium) return demandRegime === 'very_busy' ? 'fast' : 'normal';
    if (error <= -thresholds.ahead) return 'slow';
    if (demandRegime === 'very_busy') return 'fast';
    if (demandRegime === 'quiet' && rateMultiplier < 1.2) return 'slow';
    return 'normal';
  }

  function riskSnapshot(state, opts) {
    const daily = state.daily?.[todayKey()] || {};
    const used = Number(daily.riskUsed || 0);
    const limit = clampNumber(opts.watcherRiskBudgetLimit, 10, 1, 100);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      ratio: used / Math.max(1, limit),
      exhausted: used >= limit,
      nearLimit: used >= limit * 0.75
    };
  }

  function calculateAdvancedTargetState(state, opts, market) {
    const actualDone = monthDone(state);
    const monthlyTarget = Number(opts.watcherMonthlyTarget || 0);
    const progress = workTimeProgressDetails(opts);
    const availability = availabilitySnapshot(state, opts, progress);
    const effectiveProgress = availability.enoughData ? availability.activeTimeProgressRatio : progress.ratio;
    const expectedDone = Math.round(monthlyTarget * Math.min(1, effectiveProgress));
    const error = expectedDone - actualDone;
    const risk = riskSnapshot(state, opts);
    const daily = state.daily?.[todayKey()] || {};
    const failures = Number(daily.failed || 0);
    const successes = Number(daily.downloaded || 0);
    const failureRate = failures / Math.max(1, failures + successes);
    const p = Number(market?.sameSlotPercentile ?? 0.5);
    const thresholds = lagThresholds(monthlyTarget);
    const demandMultiplier = p >= 0.9
      ? 1.25
      : (p <= 0.2 ? (error >= thresholds.medium ? 0.9 : 0.75) : 1);
    const proportional = monthlyTarget > 0 ? error / Math.max(1, monthlyTarget) : 0;
    let rateMultiplier = 1 + proportional * 3;
    rateMultiplier *= demandMultiplier;
    rateMultiplier *= Math.max(0.35, 1 - failureRate * 0.8);
    rateMultiplier *= risk.nearLimit ? 0.45 : 1;
    if (risk.exhausted) rateMultiplier = 0;
    if (!risk.nearLimit && error >= thresholds.severe) rateMultiplier = Math.max(rateMultiplier, 1.55);
    if (!risk.nearLimit && error >= thresholds.medium) rateMultiplier = Math.max(rateMultiplier, 1.05);
    rateMultiplier = Math.max(0, Math.min(3, rateMultiplier));
    const speedMode = speedModeFromTarget({
      error,
      monthlyTarget,
      demandRegime: market?.marketRegime || 'normal',
      riskExhausted: risk.exhausted,
      rateMultiplier
    });
    const todayTarget = monthlyTarget <= 0 ? 0 : clampNumber(Math.ceil(Math.max(0, error) + (rateMultiplier > 1 ? rateMultiplier : 0)), opts.watcherMinDailyTarget, opts.watcherMinDailyTarget, opts.watcherMaxDailyTarget);
    const hourTarget = Math.max(0, Math.min(opts.watcherMaxPerSession * 3, Math.ceil(rateMultiplier * opts.watcherMaxPerSession)));
    const sessionIntensity = Math.max(0, Math.min(1, rateMultiplier / 3));
    return {
      schedulerModelMode: 'advanced',
      speedMode,
      workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
      activeTimeProgressRatio: availability.activeTimeProgressRatio,
      availabilityFactor: availability.availabilityFactor,
      availabilityExpectedWakeCount: availability.expectedWakeCount,
      availabilityActualWakeCount: availability.actualWakeCount,
      expectedDone,
      actualDone,
      targetError: error,
      rateMultiplier: Number(rateMultiplier.toFixed(3)),
      todayTarget,
      hourTarget,
      sessionIntensity: Number(sessionIntensity.toFixed(3)),
      riskUsed: risk.used,
      riskLimit: risk.limit,
      riskRemaining: risk.remaining,
      riskExhausted: risk.exhausted,
      marketRegime: market?.marketRegime || 'normal',
      recentH1DemandDelta: Number(market?.h1Delta || 0),
      recentD1DemandDelta: Number(market?.d1Delta || 0)
    };
  }

  function candidateSource(candidate, payload = null) {
    return publisherAlias(payload?.publisherName || payload?.journalName || candidate?.publisherName || candidate?.journalShortName || candidate?.rowText || candidate?.title || '');
  }

  function ensureBanditStats(state) {
    state.banditStats = state.banditStats || {};
    return state.banditStats;
  }

  function banditItem(stats, source) {
    stats[source] = stats[source] || {
      trials: 0,
      success: 0,
      failure: 0,
      htmlFailure: 0,
      cfFailure: 0,
      avgDurationMs: 0,
      lastFailureAt: ''
    };
    return stats[source];
  }

  function banditScore(candidate, state, market) {
    const source = candidateSource(candidate);
    const stats = ensureBanditStats(state);
    const item = banditItem(stats, source);
    const totalTrials = Object.values(stats).reduce((sum, value) => sum + Number(value.trials || 0), 0);
    const trials = Number(item.trials || 0);
    const estimatedSuccessRate = (Number(item.success || 0) + 1) / (trials + 2);
    const explorationBonus = Math.sqrt(2 * Math.log(totalTrials + 2) / (trials + 1));
    const trend = market?.publisherTrend?.[source] || {};
    const demandPressure = Number(trend.pressure || 0);
    const sourceTrend = Math.max(-0.4, Math.min(0.6, Number(trend.h1Delta || 0) / 100));
    const lastFailMs = item.lastFailureAt ? Date.now() - new Date(item.lastFailureAt).getTime() : Infinity;
    const recentFailurePenalty = lastFailMs < 6 * 60 * 60 * 1000 ? 0.35 : 0;
    const avgDurationPenalty = Math.min(0.3, Number(item.avgDurationMs || 0) / (8 * 60 * 1000) * 0.2);
    const doiBonus = candidate?.hasDoi ? 0.15 : 0;
    const accessRule = journalAccessRuleFor(candidate, state?.optionsSnapshot || {});
    const accessBonus = accessRule.state === 'allowed' ? 0.45 : (accessRule.state === 'partial' ? 0.22 : 0);
    const score = estimatedSuccessRate + explorationBonus * 0.35 + demandPressure * 0.8 + sourceTrend * 0.25 + doiBonus + accessBonus - recentFailurePenalty - avgDurationPenalty;
    return {
      source,
      score: Math.max(0.01, Number(score.toFixed(4))),
      estimatedSuccessRate: Number(estimatedSuccessRate.toFixed(4)),
      explorationBonus: Number(explorationBonus.toFixed(4)),
      demandPressure,
      sourceTrend,
      recentFailurePenalty,
      avgDurationPenalty,
      doiBonus,
      accessRule: accessRule.state,
      accessBonus
    };
  }

  function weightedSampleWithoutReplacement(items, count) {
    const pool = items.slice();
    const picked = [];
    while (pool.length && picked.length < count) {
      const total = pool.reduce((sum, item) => sum + Math.max(0.01, Number(item.score) || 0.01), 0);
      let r = Math.random() * total;
      let index = 0;
      for (; index < pool.length; index += 1) {
        r -= Math.max(0.01, Number(pool[index].score) || 0.01);
        if (r <= 0) break;
      }
      picked.push(pool.splice(Math.min(index, pool.length - 1), 1)[0]);
    }
    return picked;
  }

  function selectBanditCandidates(candidates, state, market, count) {
    const scored = (Array.isArray(candidates) ? candidates : [])
      .map((candidate, order) => ({ candidate, order, ...banditScore(candidate, state, market) }))
      .sort((a, b) => (b.score - a.score) || (a.order - b.order));
    const top = scored.slice(0, Math.max(count * 3, Math.min(12, scored.length)));
    const picked = weightedSampleWithoutReplacement(top, count);
    state.banditTopPublishers = scored.slice(0, 8).map(item => ({
      source: item.source,
      score: item.score,
      estimatedSuccessRate: item.estimatedSuccessRate,
      demandPressure: item.demandPressure,
      sourceTrend: item.sourceTrend
    }));
    return picked.map(item => item.candidate);
  }

  async function recordBanditOutcome(source, outcome, durationMs = 0, reason = '') {
    const state = await getWatcherState();
    const stats = ensureBanditStats(state);
    const item = banditItem(stats, source || 'Unknown');
    item.trials += 1;
    if (outcome === 'success') {
      item.success += 1;
    } else {
      item.failure += 1;
      item.lastFailureAt = new Date().toISOString();
      if (/html|login|not_pdf|error_page/i.test(reason)) item.htmlFailure += 1;
      if (/cf|challenge/i.test(reason)) item.cfFailure += 1;
    }
    if (durationMs > 0) {
      item.avgDurationMs = item.avgDurationMs ? Math.round(item.avgDurationMs * 0.75 + durationMs * 0.25) : Math.round(durationMs);
    }
    await saveWatcherState(state);
  }

  function riskCostFor(reason, status = '') {
    const text = `${reason || ''} ${status || ''}`;
    if (/cf|challenge/i.test(text)) return 5;
    if (/login|permission|权限|publisher_error_page/i.test(text)) return 3;
    if (/html|not_pdf|PDF 校验失败|file header/i.test(text)) return 2;
    if (/failed|blocked|timeout|interrupted|error/i.test(text)) return 1;
    return 0;
  }

  async function recordRiskEvent(opts, reason, status = '') {
    const cost = riskCostFor(reason, status);
    const state = await getWatcherState();
    const key = todayKey();
    state.daily = state.daily || {};
    state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
    if (cost > 0) {
      state.daily[key].riskUsed = Number(state.daily[key].riskUsed || 0) + cost;
      state.daily[key].consecutiveFailures = Number(state.daily[key].consecutiveFailures || 0) + 1;
      if (state.daily[key].consecutiveFailures >= 3) state.daily[key].riskUsed += 1;
    } else if (/success|queued|download_only|uploaded/i.test(status || reason || '')) {
      state.daily[key].consecutiveFailures = 0;
    }
    const risk = riskSnapshot(state, opts);
    if (opts.watcherAdvancedSchedulerEnabled && risk.exhausted) {
      state.riskPausedUntil = nextRiskResumeAt(opts);
      state.riskPauseReason = 'risk_budget_exhausted';
    }
    await saveWatcherState(state);
    return risk;
  }

  function normalizeTraceLevel(value) {
    return ['off', 'normal', 'verbose'].includes(value) ? value : 'normal';
  }

  async function getTraceLevel() {
    if (traceLevelLoadedAt > 0) return cachedTraceLevel;
    try {
      const stored = await chrome.storage.local.get('watcherTraceLevel');
      cachedTraceLevel = normalizeTraceLevel(stored.watcherTraceLevel);
      traceLevelLoadedAt = Date.now();
    } catch (_) {
      // keep default
    }
    return cachedTraceLevel;
  }

  async function appendWatcherTrace(step, details = {}) {
    try {
      const traceLevel = await getTraceLevel();
      if (traceLevel === 'off') return;
      const url = details.url || details.detailUrl || details.listUrl || '';
      traceBuffer.push({
        time: new Date().toISOString(),
        step: normalizeText(step).slice(0, 80),
        reason: normalizeText(details.reason).slice(0, 160),
        trigger: normalizeText(details.trigger).slice(0, 80),
        sessionId: normalizeText(details.sessionId).slice(0, 80),
        tabId: details.tabId ?? '',
        url: traceLevel === 'verbose' ? sanitizeReportUrl(url) : '',
        urlHostPath: deps?.urlHostPath ? deps.urlHostPath(url || '') : null,
        details: sanitizeTraceValue(details, 0, traceLevel, {
          normalizeText,
          sanitizeFullUrl: sanitizeReportUrl,
          urlHostPath: deps?.urlHostPath
        })
      });
      if (traceBuffer.length >= TRACE_FLUSH_BATCH_SIZE) {
        await flushWatcherTrace();
      } else if (!traceFlushTimer) {
        traceFlushTimer = setTimeout(() => {
          traceFlushTimer = null;
          flushWatcherTrace().catch(() => {});
        }, TRACE_FLUSH_INTERVAL_MS);
      }
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] trace append failed', err);
    }
  }

  async function flushWatcherTrace() {
    const batch = traceBuffer.splice(0, traceBuffer.length);
    if (!batch.length) return;
    traceFlushPromise = traceFlushPromise
      .catch(() => {})
      .then(async () => {
        const stored = await chrome.storage.local.get(AUTO_WATCHER_TRACE_KEY);
        const logs = Array.isArray(stored[AUTO_WATCHER_TRACE_KEY]) ? stored[AUTO_WATCHER_TRACE_KEY] : [];
        const next = batch.slice().reverse().concat(logs).slice(0, MAX_TRACE_LOGS);
        await chrome.storage.local.set({ [AUTO_WATCHER_TRACE_KEY]: next });
      });
    await traceFlushPromise;
  }

  async function clearBufferedWatcherTrace() {
    traceBuffer = [];
    if (traceFlushTimer) {
      clearTimeout(traceFlushTimer);
      traceFlushTimer = null;
    }
  }

  async function trimStoredWatcherTraceLogs() {
    try {
      const stored = await chrome.storage.local.get(AUTO_WATCHER_TRACE_KEY);
      const logs = Array.isArray(stored[AUTO_WATCHER_TRACE_KEY]) ? stored[AUTO_WATCHER_TRACE_KEY] : [];
      if (logs.length <= MAX_TRACE_LOGS) return;
      await chrome.storage.local.set({ [AUTO_WATCHER_TRACE_KEY]: logs.slice(0, MAX_TRACE_LOGS) });
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] trace trim failed', err);
    }
  }

  async function appendWatcherLog(entry) {
    try {
      watcherLogBuffer.push({
        time: new Date().toISOString(),
        assistId: String(entry.assistId || entry.id || '').slice(0, 60),
        title: normalizeText(entry.title || '').slice(0, 160),
        doi: String(entry.doi || '').slice(0, 120),
        journalName: normalizeText(entry.journalName || entry.journalShortName || '').slice(0, 120),
        detailUrl: String(entry.detailUrl || '').slice(0, 500),
        trigger: normalizeText(entry.trigger || '').slice(0, 60),
        sessionId: normalizeText(entry.sessionId || '').slice(0, 60),
        status: String(entry.status || 'unknown').slice(0, 20),
        reason: normalizeText(entry.reason || '').slice(0, 200)
      });
      if (watcherLogBuffer.length >= WATCHER_LOG_FLUSH_BATCH_SIZE) {
        await flushWatcherLogs();
      } else if (!watcherLogFlushTimer) {
        watcherLogFlushTimer = setTimeout(() => {
          watcherLogFlushTimer = null;
          flushWatcherLogs().catch(() => {});
        }, WATCHER_LOG_FLUSH_INTERVAL_MS);
      }
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] log append failed', err);
    }
  }

  async function flushWatcherLogs() {
    const batch = watcherLogBuffer.splice(0, watcherLogBuffer.length);
    if (!batch.length) return;
    watcherLogFlushPromise = watcherLogFlushPromise
      .catch(() => {})
      .then(async () => {
        const stored = await chrome.storage.local.get(AUTO_WATCHER_LOG_KEY);
        const logs = Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [];
        const next = batch.slice().reverse().concat(logs).slice(0, MAX_LOGS);
        await chrome.storage.local.set({ [AUTO_WATCHER_LOG_KEY]: next });
      });
    await watcherLogFlushPromise;
  }

  async function clearBufferedWatcherLogs() {
    watcherLogBuffer = [];
    if (watcherLogFlushTimer) {
      clearTimeout(watcherLogFlushTimer);
      watcherLogFlushTimer = null;
    }
  }

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

  async function recoverStaleWatcherState(reason = 'startup_recovery') {
    try {
      const state = await getWatcherState();
      const session = state.currentSession || null;
      const activeStatuses = new Set(['planning', 'running']);
      let changed = false;
      if (session && activeStatuses.has(String(session.status || ''))) {
        const recovered = {
          ...session,
          status: 'recovered_cancelled',
          finishedAt: new Date().toISOString(),
          recoveryReason: reason
        };
        state.lastSession = recovered;
        state.currentSession = recovered;
        changed = true;
      }
      if (state.lastRunStartedAt && !state.lastRunFinishedAt) {
        state.lastRunFinishedAt = new Date().toISOString();
        state.lastRunResult = { ok: false, reason: 'recovered_cancelled' };
        changed = true;
      }
      if (!changed) return;
      await saveWatcherState(state);
      await appendWatcherTrace('watcher_state_recovered', {
        reason,
        sessionId: state.currentSession?.id || '',
        status: state.currentSession?.status || ''
      });
      updateActionBadge(state).catch(() => {});
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] recovery failed', err);
    }
  }

  function initPrivateAutoWatcher(nextDeps) {
    deps = nextDeps;
    updateActionBadge().catch(() => {});
    if (badgeRefreshTimer) clearInterval(badgeRefreshTimer);
    badgeRefreshTimer = setInterval(() => {
      updateActionBadge().catch(() => {});
    }, BADGE_REFRESH_INTERVAL_MS);

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
      flushWatcherLogs().catch(() => {});
      flushWatcherTrace().catch(() => {});
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const watcherKeys = Object.keys(changes).filter(key => key.startsWith('watcher'));
      if (watcherKeys.length) {
        if (changes.watcherTraceLevel) {
          cachedTraceLevel = normalizeTraceLevel(changes.watcherTraceLevel.newValue);
          traceLevelLoadedAt = Date.now();
        }
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
