'use strict';

// Responsibility: top-level auto watcher run orchestration without changing scheduling behavior.
(function () {
  function createWatcherOrchestratorApi(config) {
    const {
      depsRef,
      stateRef,
      normalizeOptions,
      recordRunStart,
      getWatcherState,
      saveWatcherState,
      dailyCounterSnapshot,
      todayKey,
      monthDone,
      appendWatcherTrace,
      recordCfChallenge,
      isInWorkSchedule,
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
      saveWatcherStateSafe,
      listUrlsForRun,
      preparePublisherPool,
      refreshPublisherCountCacheFromParsedIfDue,
      pageRangeMetaFromUrl,
      randomizeAssistListUrlWithMeta,
      incrementDaily,
      parseListUrl,
      minSeekingGateForList,
      orderCandidatesForRun,
      appendWatcherLog,
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
    } = config;

    const RUNNING_LOCK_STALE_MS = 20 * 60 * 1000;

    // syncActualAssistCount / readBlacklistedIds live in watcher/assist_sync.js
    // (loaded before this module in background.js importScripts).
    const { syncActualAssistCount, readBlacklistedIds } = globalThis.AblesciWatcherAssistSyncModule.createWatcherAssistSyncApi({
      depsRef,
      appendWatcherTrace,
      saveWatcherStateSafe,
      todayKey
    });

    function createRunId() {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    function createAttempt(trigger) {
      return {
        startedAt: new Date().toISOString(),
        trigger,
        resultReason: '',
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
        listScanStarted: false,
        pickedListUrl: '',
        pickedPage: '',
        pageCurve: '',
        pageMin: '',
        pageMax: '',
        parsedListPages: '',
        backoffSkippedPages: '',
        listScanBackoffSkipped: 0,
        frontHit: false,
        alpha: ''
      };
    }

    function snapshotScheduleFields(state = {}) {
      const keys = [
        'nextAssistRunAt',
        'nextAssistReason',
        'nextAssistStrategy',
        'nextAssistDelayMinutes',
        'nextAssistModelDelayMinutes',
        'nextAssistPlannedAt',
        'nextAssistPlanningData',
        'nextAssistPlan',
        'nextScheduledAt',
        'chromeAlarmScheduledAt'
      ];
      return Object.fromEntries(keys.map(key => {
        if (state[key] !== undefined) return [key, state[key]];
        return [key, key === 'nextAssistPlanningData' || key === 'nextAssistPlan' ? null : ''];
      }));
    }

    function createRunContext(trigger, execution = {}) {
      const startedAt = Date.now();
      return {
        trigger,
        runId: createRunId(),
        startedAt,
        lastPerfAt: startedAt,
        result: null,
        opts: null,
        attempt: createAttempt(trigger),
        manualScheduleSnapshot: null,
        scannedUrl: '',
        scannedPublisher: '',
        scannedPage: '',
        parsedListPages: [],
        backoffSkippedPages: [],
        execution
      };
    }

    function finishRun(run, result) {
      run.result = result;
      return result;
    }

    async function appendPerfCheckpoint(run, name, extra = {}) {
      const now = Date.now();
      await appendWatcherTrace('perf_watcher_checkpoint', {
        reason: name,
        phase: name,
        trigger: run.trigger,
        runId: run.runId,
        elapsedMs: now - run.startedAt,
        deltaMs: now - run.lastPerfAt,
        ...extra
      });
      run.lastPerfAt = now;
    }

    function applyAttemptPagePick(attempt, pagePick = {}, pickedListUrl = '', extra = {}) {
      if (extra.listScanStarted !== undefined) attempt.listScanStarted = extra.listScanStarted;
      if (pickedListUrl !== undefined) attempt.pickedListUrl = pickedListUrl;
      attempt.pickedPage = pagePick.pickedPage;
      attempt.pageCurve = pagePick.pageCurve;
      attempt.pageMin = pagePick.pageMin;
      attempt.pageMax = pagePick.pageMax;
      attempt.pageOrder = pagePick.pageOrder;
      attempt.listUrlKey = pagePick.urlKey;
      if (pagePick.frontHit !== undefined) attempt.frontHit = pagePick.frontHit;
      if (pagePick.alpha !== undefined) attempt.alpha = pagePick.alpha;
    }

    function updateStateLastPicked(state, pagePick = {}, pickedListUrl = '') {
      state.lastPickedListUrl = pickedListUrl;
      state.lastPickedPage = pagePick.pickedPage || '';
      state.lastPickedPublisher = pagePick.publisher || '';
      delete state.lastPickedPageMax;
      delete state.lastPickedPageOrder;
      delete state.lastPickedUrlKey;
    }

    function createScanContext(run, listUrl, urlCount) {
      return {
        run,
        listUrl,
        pageScanCount: 0,
        backoffSkipCount: 0,
        maxPageScans: urlCount > 1 ? 1 : 5,
        maxBackoffSkips: urlCount > 1 ? 5 : 25,
        startedAt: 0
      };
    }

    function scanDisplayIndex(scan) {
      return scan.pageScanCount + 1;
    }

    function buildScanStatus(scan, pagePick, pickedListUrl, mode = 'background_fetch') {
      return buildCurrentListScan({
        mode,
        trigger: scan.run.trigger,
        pickedListUrl,
        listUrl: scan.listUrl,
        pagePick,
        scanIndex: scanDisplayIndex(scan),
        scanLimit: scan.maxPageScans
      });
    }

    function recordParsedListPage(scan, page) {
      if (!Number.isFinite(Number(page))) return;
      scan.run.parsedListPages.push(Number(page));
      scan.run.attempt.parsedListPages = scan.run.parsedListPages.join(',');
    }

    function recordScannedPage(scan, pickedListUrl, pagePick) {
      scan.run.scannedUrl = pickedListUrl;
      scan.run.scannedPublisher = pagePick.publisher || '';
      scan.run.scannedPage = pagePick.pickedPage || '';
      recordParsedListPage(scan, pagePick.pickedPage);
    }

    function shuffledListUrls(listUrls = []) {
      const shuffled = listUrls.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }

    async function detectMaxPageForUrl(run, urlToTry, trigger) {
      const urlPageMeta = pageRangeMetaFromUrl(urlToTry);
      if (!urlPageMeta?.needsMaxDetection) return null;
      let detectedMaxPage = null;
      try {
        const detectUrl = new URL(urlToTry);
        detectUrl.searchParams.delete('page_min');
        detectUrl.searchParams.delete('page_max');
        detectUrl.searchParams.set('page', String(urlPageMeta.pageMin));
        const parsedPage1 = await parseListUrl(detectUrl.href, {
          trigger,
          publisher: urlPageMeta.publisher,
          pickedPage: 1
        });
        if (parsedPage1 && !parsedPage1.isErrorPage && !parsedPage1.cfChallenge) {
          detectedMaxPage = parsedPage1.listStats?.maxPage || urlPageMeta.pageMin;
        }
        await appendWatcherTrace('random_single_page_range_detected', {
          reason: 'max_page_detected_from_pagination',
          phase: 'single_random_run',
          trigger,
          runId: run.runId,
          configuredUrl: urlToTry,
          pageMin: urlPageMeta.pageMin,
          detectedMaxPage,
          publisher: urlPageMeta.publisher
        });
      } catch (_) {}
      return detectedMaxPage;
    }

    async function appendListParsePerf(run, trigger, pagePick, parsed, parseStartedAt, parseFinishedAt) {
      await appendWatcherTrace('perf_list_parse', {
        reason: 'single_random_list_parse_done',
        phase: 'single_random_run',
        trigger,
        runId: run.runId,
        durationMs: parseFinishedAt - parseStartedAt,
        pickedPage: pagePick.pickedPage,
        parsedCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
        maxPage: parsed?.listStats?.maxPage || ''
      });
    }

    async function appendListPipelinePerf(run, trigger, pagePick, pickedListUrl, parsed, timings = {}, extra = {}) {
      await appendWatcherTrace('perf_list_pipeline', {
        reason: extra.reason || 'list_pipeline_done',
        phase: 'single_random_run',
        trigger,
        runId: run.runId,
        listUrl: pickedListUrl,
        publisher: pagePick.publisher,
        pickedPage: pagePick.pickedPage,
        parsedCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
        ...extra,
        ...timings
      });
    }

    async function prepareTargetPhase(run, opts) {
      const trigger = run.trigger;
      const stateForTargets = await getWatcherState();
      stateForTargets.optionsSnapshot = opts;
      await syncActualAssistCount(stateForTargets, opts);
      // Parallel publisher lanes are paced by their own independent Chrome
      // alarms, so the single-lane due check is intentionally skipped there.
      if (trigger === 'alarm' && !run.execution.parallelDispatch && opts.watcherQuantSchedulerEnabled && !isAssistDue(stateForTargets)) {
        await appendWatcherTrace('run_skip_assist_not_due', {
          reason: 'assist_not_due',
          phase: 'target_decision',
          trigger,
          runId: run.runId,
          nextAssistRunAt: stateForTargets.nextAssistRunAt || '',
          nextAssistRunAtBeijing: stateForTargets.nextAssistRunAt ? formatBeijingDateTime(stateForTargets.nextAssistRunAt) : '',
          secondsUntilAssist: stateForTargets.nextAssistRunAt ? Math.round((new Date(stateForTargets.nextAssistRunAt).getTime() - Date.now()) / 1000) : ''
        });
        return { stopRun: true, result: { ok: true, reason: 'assist_not_due' } };
      }
      // Parallel lanes use per-lane randomized alarms as their short-term
      // throttle; daily limit and risk-budget gates still apply below.
      if (trigger !== 'manual' && !run.execution.parallelDispatch) {
        const rateLimit = checkShortTermRateLimit(stateForTargets);
        if (rateLimit.limited) {
          const reason = `rate_limited_${rateLimit.window}`;
          await appendWatcherTrace('run_skip_rate_limit', {
            reason,
            phase: 'target_decision',
            window: rateLimit.window,
            count: rateLimit.count,
            limit: rateLimit.limit,
            trigger,
            runId: run.runId
          });
          return { stopRun: true, result: { ok: false, reason } };
        }
      }
      const liveTargetState = !opts.watcherQuantSchedulerEnabled
        ? {
            schedulerModelMode: 'fixed',
            speedMode: 'fixed',
            todayTarget: 0,
            actualDone: 0,
            expectedDone: 0,
            targetError: 0,
            sessionIntensity: 0,
            riskLimit: Number(opts.watcherRiskBudgetLimit || 10)
          }
        : calculateTargetState(stateForTargets, opts);
      const frozenTargetState = trigger === 'alarm' && stateForTargets.nextAssistPlanningData?.targetState
        ? stateForTargets.nextAssistPlanningData.targetState
        : null;
      const targetState = mergeFrozenTargetState(liveTargetState, frozenTargetState);
      Object.assign(stateForTargets, targetState);
      stateForTargets.lastAssistDecisionModelData = frozenTargetState ? 'frozen_pending_assist_plan' : 'live_schedule_state';
      stateForTargets.lastAssistStrategy = 'random_interval';
      stateForTargets.lastAssistDecisionAt = new Date().toISOString();
      stateForTargets.lastAssistDecision = {
        trigger,
        strategy: stateForTargets.lastAssistStrategy,
        modelData: stateForTargets.lastAssistDecisionModelData,
        frozenPlanAt: stateForTargets.nextAssistPlanningData?.plannedAt || '',
        speedMode: targetState.speedMode,
        todayTarget: 0,
        hourTarget: 0,
        targetError: targetState.targetError ?? targetState.lag ?? 0,
        workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
        activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
        availabilityFactor: targetState.availabilityFactor || 1,
        riskUsed: targetState.riskUsed || 0,
        riskLimit: targetState.riskLimit || 0,
        dailyLimit: opts.watcherDailyLimit || 0
      };
      await saveWatcherStateSafe(stateForTargets);
      await appendWatcherTrace('run_target_state', {
        reason: 'calendar_target',
        phase: 'target_decision',
        trigger,
        runId: run.runId,
        modelData: stateForTargets.lastAssistDecisionModelData,
        speedMode: targetState.speedMode,
        todayTarget: '',
        hourTarget: '',
        targetError: targetState.targetError || targetState.lag || '',
        workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
        activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
        availabilityFactor: targetState.availabilityFactor || 1
      });
      if (opts.watcherDailyLimit > 0 && await getDailyCount('downloaded') >= opts.watcherDailyLimit) {
        await appendWatcherTrace('run_skip_daily_limit', {
          reason: 'daily_limit',
          phase: 'target_decision',
          trigger,
          runId: run.runId,
          dailyLimit: opts.watcherDailyLimit
        });
        return { stopRun: true, result: { ok: false, reason: 'daily_limit' } };
      }
      return { stopRun: false, stateForTargets, targetState };
    }

    async function prepareSessionPhase(run, opts, stateForTargets, targetState) {
      const trigger = run.trigger;
      const attempt = run.attempt;
      const sessionCap = sessionExecutionCap(opts, stateForTargets, false);
      const riskForSizing = riskSnapshot(stateForTargets, opts);
      let targetSessionSize = opts.watcherQuantSchedulerEnabled ? sessionSize(opts, stateForTargets) : Math.min(1, sessionCap);
      const zeroForcedToOne = !opts.watcherAllowZeroSession
        && trigger === 'alarm'
        && targetSessionSize <= 0
        && sessionCap > 0
        && (Number(opts.watcherDailyLimit || 0) <= 0 || dailyDownloadedFromState(stateForTargets) < Number(opts.watcherDailyLimit || 0));
      if (zeroForcedToOne) {
        targetSessionSize = 1;
        stateForTargets.lastSessionCapacityDecision = {
          ...(stateForTargets.lastSessionCapacityDecision || {}),
          finalSize: 1,
          forcedMinOne: true,
          forceReason: 'alarm_due_no_zero_session'
        };
        delete stateForTargets.lastSessionSizeDecision;
        await saveWatcherStateSafe(stateForTargets);
      }
      attempt.targetSessionSize = targetSessionSize;
      attempt.sessionCap = sessionCap;
      attempt.speedMode = targetState.speedMode || '';
      await appendWatcherTrace('run_session_size', {
        reason: 'session_size_calculated',
        phase: 'target_decision',
        trigger,
        runId: run.runId,
        targetSessionSize,
        zeroForcedToOne,
        decision: stateForTargets.lastSessionCapacityDecision || {},
        maxPerSession: maxSessionCandidates(opts),
        sessionCap,
        dailyDownloaded: dailyDownloadedFromState(stateForTargets),
        todayTarget: '',
        dailyLimit: opts.watcherDailyLimit || 0,
        riskRemaining: riskForSizing.remaining,
        sessionMode: 'single'
      });
      if (targetSessionSize <= 0) {
        return { stopRun: true, result: { ok: true, reason: 'session_size_zero' }, targetSessionSize };
      }
      return { stopRun: false, targetSessionSize, sessionCap };
    }

    async function restoreManualScheduleSnapshot(run) {
      if (!run.manualScheduleSnapshot) return;
      const state = await getWatcherState();
      Object.assign(state, run.manualScheduleSnapshot);
      await saveWatcherState(state);
      await appendWatcherTrace('manual_run_schedule_preserved', {
        reason: 'manual_run_does_not_replan_auto_schedule',
        trigger: run.trigger,
        runId: run.runId,
        nextAssistRunAt: state.nextAssistRunAt || '',
        chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
        nextScheduledAt: state.nextScheduledAt || ''
      });
    }

    async function finalizeRun(run) {
      const result = run.result || { ok: false, reason: 'unknown' };
      await appendWatcherTrace('perf_watcher_run', {
        reason: 'run_finish',
        phase: 'run_finalize',
        trigger: run.trigger,
        runId: run.runId,
        durationMs: Date.now() - run.startedAt,
        ok: result.ok === true,
        resultReason: result.reason || 'unknown'
      });
      await appendWatcherTrace('run_finish', { reason: 'finally', phase: 'run_finalize', trigger: run.trigger, runId: run.runId });
      await setRunFinalizeScan(run, result, 'finalizing', 'running', result.reason || '');
      await recordRunFinish(run.trigger, result).catch(() => {});
      if (run.trigger !== 'manual' && run.opts && !run.execution.skipScheduleRefresh) {
        await scheduleNextAssistAfterRun(run.opts, result, run.trigger).catch(() => {});
        await refreshAlarmAfterRun(run.opts, result, run.attempt, run.trigger).catch(() => {});
      }
      await restoreManualScheduleSnapshot(run).catch(() => {});
      await recordAttemptFinish(run.attempt, result).catch(() => {});
      try { await writeDailyReports(); } catch (_) {}
      await flushWatcherLogs().catch(() => {});
      await flushWatcherTrace().catch(() => {});
      await setRunFinalizeScan(run, result, 'done', result.ok === true ? 'done' : 'failed', result.reason || 'unknown');
      stateRef.autoWatcherRunning = false;
      stateRef.autoWatcherStartedAt = 0;
    }

    async function setRunFinalizeScan(run, result, phase, status, reason) {
      await setCurrentListScan?.(buildCurrentListScan({
        trigger: run.trigger,
        pickedListUrl: result.scannedUrl || run.attempt.pickedListUrl || '',
        pagePick: {
          publisher: result.scannedPublisher || run.attempt.scannedPublisher || run.attempt.publisher || '',
          pickedPage: result.scannedPage || run.attempt.scannedPage || run.attempt.pickedPage || '',
          pageOrder: run.attempt.pageOrder || '',
          pageMin: run.attempt.pageMin || '',
          pageMax: run.attempt.pageMax || ''
        },
        phase,
        status,
        reason
      })).catch(() => {});
    }

    async function runAutoWatcherOnce(trigger = 'alarm', execution = {}) {
      if (stateRef.autoWatcherRunning) {
        const runningSince = Number(stateRef.autoWatcherStartedAt || 0);
        const elapsedMs = Number.isFinite(runningSince) && runningSince > 0 ? Date.now() - runningSince : 0;
        const currentState = await getWatcherState().catch(() => ({}));
        const scanText = describeCurrentListScan(currentState.currentListScan || {});
        if (elapsedMs > RUNNING_LOCK_STALE_MS) {
          await appendWatcherTrace('run_stale_lock_recovered', {
            reason: 'stale_auto_watcher_running_lock',
            trigger,
            elapsedMs,
            currentListScan: currentState.currentListScan || null
          });
          stateRef.autoWatcherRunning = false;
          stateRef.autoWatcherStartedAt = 0;
          await clearCurrentListScan();
        } else {
          await appendWatcherTrace('run_skip_already_running', {
            reason: 'already_running',
            trigger,
            elapsedMs,
            currentListScan: currentState.currentListScan || null
          });
          return {
            ok: false,
            reason: scanText ? `already_running：${scanText}` : 'already_running'
          };
        }
      }
      stateRef.autoWatcherRunning = true;
      stateRef.autoWatcherStartedAt = Date.now();
      const run = createRunContext(trigger, execution);
      const { attempt } = run;
      const finish = result => finishRun(run, result);
      // Declared at function scope so the catch block can still read the last
      // scanned page if runAutoWatcherOnce throws; otherwise a ReferenceError
      // here would mask the original failure and skip the failed-run log entry.
      let lastScan = { url: '', publisher: '', page: '' };
      try {
        await appendWatcherTrace('run_start', { reason: 'watcher_triggered', phase: 'run_start', trigger, runId: run.runId });
        await appendPerfCheckpoint(run, 'run_start');
        await emergencyStorageTrim().catch(() => {});
        await pruneWatcherState().catch(() => {});
        const opts = normalizeOptions(await depsRef.getOptions());
        if (Array.isArray(execution.listUrls) && execution.listUrls.length) {
          opts.watcherListUrls = execution.listUrls.slice();
        }
        opts.watcherDispatchPublisher = String(execution.publisher || '').trim().toLowerCase();
        opts.watcherDispatchLane = String(execution.lane || '').trim();
        run.opts = opts;
        await recordRunStart(trigger, opts);
        await appendPerfCheckpoint(run, 'options_loaded', {
          perfTraceEnabled: opts.watcherPerfTraceEnabled === true,
          perfFileEnabled: opts.watcherPerfFileEnabled === true
        });
        const initialState = await getWatcherState();
        await appendPerfCheckpoint(run, 'initial_state_loaded');
        if (trigger === 'manual') {
          run.manualScheduleSnapshot = snapshotScheduleFields(initialState);
        }
        attempt.nextAssistBefore = initialState.nextAssistRunAt || '';
        Object.assign(attempt, Object.fromEntries(Object.entries(dailyCounterSnapshot(initialState)).map(([key, value]) => [`${key}Before`, value])));
        if (!opts.watcherEnabled && trigger !== 'manual') {
          await appendWatcherTrace('run_skip_disabled', { reason: 'disabled', trigger });
          return finish({ ok: false, reason: 'disabled' });
        }
        if (!opts.watcherMultiPublisherEnabled && depsRef.hasActiveTask()) {
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
        const targetPhase = await prepareTargetPhase(run, opts);
        if (targetPhase.stopRun) return finish(targetPhase.result);
        const { stateForTargets, targetState } = targetPhase;

        const sessionPhase = await prepareSessionPhase(run, opts, stateForTargets, targetState);
        if (sessionPhase.stopRun) return finish(sessionPhase.result);
        const { targetSessionSize } = sessionPhase;

        const configuredListUrls = Array.isArray(opts.watcherListUrls) ? opts.watcherListUrls.slice() : [];
        const publisherCountThreshold = Math.max(0, Number(opts.watcherMinNonSdSeekingCount || 0));
        const publisherPool = await preparePublisherPool({
          urls: configuredListUrls,
          state: stateForTargets,
          opts,
          parseListUrl,
          saveState: saveWatcherStateSafe,
          appendTrace: appendWatcherTrace,
          trigger,
          runId: run.runId,
          publisherFromUrl: url => pageRangeMetaFromUrl(url)?.publisher || ''
        });
        const singleRunListUrls = listUrlsForRun({ ...opts, watcherListUrls: publisherPool.eligible });
        const singleListUrl = singleRunListUrls[0] || '';
        await setCurrentListScan?.(buildCurrentListScan({
          trigger,
          listUrl: singleListUrl,
          pickedListUrl: singleListUrl,
          phase: 'source_selected',
          status: 'running'
        })).catch(() => {});
        await appendWatcherTrace('random_single_assist_source', {
          reason: singleListUrl ? 'single_random_source_selected' : 'no_list_url',
          phase: 'single_random_run',
          trigger,
          runId: run.runId,
          configuredUrlCount: configuredListUrls.length,
          eligibleUrlCount: singleRunListUrls.length,
          excludedPublishers: publisherPool.excluded.map(item => `${item.publisher}:${item.count}`),
          publisherCountCacheFresh: publisherPool.cacheFresh === true,
          listUrl: singleListUrl
        });
        if (!singleListUrl) {
          await appendWatcherLog({
            trigger,
            status: 'skipped',
            reason: configuredListUrls.length ? 'no_eligible_publisher_count' : 'no_list_url',
            message: configuredListUrls.length
              ? 'random single-assist run: all enabled non-SD publishers are below the configured request-count threshold.'
              : 'random single-assist run: no valid list URL configured.'
          });
          return finish({ ok: true, reason: configuredListUrls.length ? 'no_eligible_publisher_count' : 'no_list_url' });
        }

        const singleBlacklistedIds = await readBlacklistedIds(opts, trigger);
        await appendPerfCheckpoint(run, 'blacklist_loaded', { blacklistCount: singleBlacklistedIds.length });

        // --- Retry-aware single-candidate scan ---
        // Try multiple candidates per page, multiple pages per URL, multiple URLs.
        const MAX_URLS_TO_TRY = Math.min(singleRunListUrls.length, 2);
        const MAX_PAGES_PER_URL = 3;
        const MAX_CANDIDATES_PER_PAGE = 5;

        const scan = createScanContext(run, singleListUrl, singleRunListUrls.length);
        scan.startedAt = Date.now();
        attempt.listScanStarted = true;

        const singleHandledCountRef = { value: 0 };
        const singleLastHandledReasonRef = { value: '' };

        // Shuffle URLs so retry doesn't always hit the same order
        const shuffledUrls = shuffledListUrls(singleRunListUrls);

        for (let urlIdx = 0; urlIdx < MAX_URLS_TO_TRY && singleHandledCountRef.value === 0; urlIdx++) {
          const urlToTry = shuffledUrls[urlIdx];

          // If page_min is present but page_max is not, fetch page 1 first to detect the real max page from pagination.
          const detectedMaxPage = await detectMaxPageForUrl(run, urlToTry, trigger);

          for (let pageRetry = 0; pageRetry < MAX_PAGES_PER_URL && singleHandledCountRef.value === 0; pageRetry++) {
            const pagePick = randomizeAssistListUrlWithMeta(urlToTry, detectedMaxPage);
            const pickedListUrl = pagePick.pickedListUrl;
            lastScan = { url: pickedListUrl, publisher: pagePick.publisher, page: pagePick.pickedPage };

            applyAttemptPagePick(attempt, pagePick, pickedListUrl, {});
            updateStateLastPicked(stateForTargets, pagePick, pickedListUrl);
            stateForTargets.currentListScan = buildScanStatus(scan, pagePick, pickedListUrl, 'single_random_page');
            stateForTargets.currentListScan.phase = 'page_selected';
            stateForTargets.currentListScan.status = 'running';
            await saveWatcherStateSafe(stateForTargets);

            await appendWatcherTrace('random_single_assist_page', {
              reason: 'single_random_page_selected',
              phase: 'single_random_run',
              trigger,
              runId: run.runId,
              listUrl: pickedListUrl,
              configuredUrl: urlToTry,
              publisher: pagePick.publisher,
              pickedPage: pagePick.pickedPage,
              pageMin: pagePick.pageMin,
              pageMax: pagePick.pageMax,
              urlRetry: urlIdx,
              pageRetry
            });
            await incrementDaily('checked', trigger);

            await setCurrentListScan?.(buildCurrentListScan({
              pagePick,
              trigger,
              listUrl: urlToTry,
              pickedListUrl,
              phase: 'parsing_list',
              status: 'running'
            })).catch(() => {});
            const parseStartedAt = Date.now();
            const parsed = await parseListUrl(pickedListUrl, {
              trigger,
              publisher: pagePick.publisher,
              pickedPage: pagePick.pickedPage
            });
            const parseFinishedAt = Date.now();
            recordScannedPage(scan, pickedListUrl, pagePick);
            await appendListParsePerf(run, trigger, pagePick, parsed, parseStartedAt, parseFinishedAt);

            if (parsed.isErrorPage) {
              await appendWatcherLog({
                type: 'warning',
                message: `random single-assist run: AbleSci returned an error page (${parsed.errorTitle || 'site_error'}); retrying.`
              });
              continue;
            }
            if (parsed.cfChallenge) {
              await recordCfChallenge(opts, pickedListUrl, trigger);
              return finish({ ok: false, reason: 'cf_challenge', scannedUrl: pickedListUrl, scannedPublisher: pagePick.publisher, scannedPage: pagePick.pickedPage });
            }

            if (publisherCountThreshold > 0) {
              await refreshPublisherCountCacheFromParsedIfDue({
                state: stateForTargets,
                parsed,
                urls: configuredListUrls,
                opts,
                saveState: saveWatcherStateSafe
              });
            }

            const listPipelineStartedAt = Date.now();
            const normalizeStartedAt = Date.now();
            normalizeParsedListCandidateContext(parsed, pagePick, pickedListUrl);
            const normalizeMs = Date.now() - normalizeStartedAt;
            const initPageDataStartedAt = Date.now();
            await initCurrentPageData(pickedListUrl, pagePick, parsed);
            const initPageDataMs = Date.now() - initPageDataStartedAt;

            const sourceGateStartedAt = Date.now();
            const sourceGate = minSeekingGateForList(parsed, pickedListUrl, pagePick.publisher, opts);
            const sourceGateMs = Date.now() - sourceGateStartedAt;
            const basePipelineTimings = {
              normalizeMs,
              initPageDataMs,
              sourceGateMs
            };
            if (!sourceGate.ok) {
              await appendListPipelinePerf(run, trigger, pagePick, pickedListUrl, parsed, {
                ...basePipelineTimings,
                totalMs: Date.now() - listPipelineStartedAt
              }, {
                reason: 'list_pipeline_source_gate_skip',
              });
              await appendWatcherTrace('random_single_assist_source_gate_skip', {
                reason: sourceGate.reason,
                phase: 'single_random_run',
                trigger,
                runId: run.runId,
                listUrl: pickedListUrl,
                publisher: sourceGate.publisher,
                count: sourceGate.count,
                threshold: sourceGate.threshold
              });
              await appendWatcherLog({
                trigger,
                status: 'skipped',
                reason: sourceGate.reason,
                page: pagePick.pickedPage,
                message: `random single-assist run: current page skipped (${sourceGate.reason}); retrying.`
              });
              continue;
            }
            await resetCfChallengeStreak();

            const orderStartedAt = Date.now();
            const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets, opts, 1);
            const orderMs = Date.now() - orderStartedAt;
            const listFilterStartedAt = Date.now();
            const queueableCandidates = await queueableCandidatesFromList(candidates, opts, trigger, pagePick, singleBlacklistedIds);
            const listFilterMs = Date.now() - listFilterStartedAt;
            await appendListPipelinePerf(run, trigger, pagePick, pickedListUrl, parsed, {
              ...basePipelineTimings,
              orderMs,
              listFilterMs,
              totalMs: Date.now() - listPipelineStartedAt
            }, {
              reason: 'list_pipeline_done',
              orderedCount: candidates.length,
              queueableCount: queueableCandidates.length,
            });
            await setCurrentListScan?.(buildCurrentListScan({
              pagePick,
              trigger,
              listUrl: urlToTry,
              pickedListUrl,
              phase: 'filtering_candidates',
              status: 'running',
              candidateCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
              queueableCount: queueableCandidates.length
            })).catch(() => {});
            await appendWatcherTrace('random_single_assist_candidates', {
              reason: 'single_random_candidates_filtered',
              phase: 'single_random_run',
              trigger,
              runId: run.runId,
              listUrl: pickedListUrl,
              parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
              queueableCount: queueableCandidates.length
            });

            if (queueableCandidates.length <= 0) {
              await appendWatcherLog({
                trigger,
                status: 'skipped',
                reason: 'no_candidate',
                page: pagePick.pickedPage,
                message: `random single-assist run: no available candidate on page ${pagePick.pickedPage || ''}; retrying.`
              });
              continue;
            }

            // Try up to MAX_CANDIDATES_PER_PAGE candidates in priority order (pre-sorted by orderCandidatesForRun)
            const toTry = Math.min(queueableCandidates.length, MAX_CANDIDATES_PER_PAGE);
            await appendWatcherTrace('perf_list_to_detail_start', {
              reason: 'list_to_detail_start',
              phase: 'single_random_run',
              trigger,
              runId: run.runId,
              listUrl: pickedListUrl,
              publisher: pagePick.publisher,
              pickedPage: pagePick.pickedPage,
              parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
              queueableCount: queueableCandidates.length,
              toTry,
              sinceRunStartMs: Date.now() - run.startedAt,
              sinceListParseStartMs: Date.now() - parseStartedAt,
              sinceListParseDoneMs: Date.now() - parseFinishedAt
            });
            await appendWatcherTrace('random_single_assist_page_try', {
              reason: 'single_page_candidate_try',
              phase: 'single_random_run',
              trigger,
              runId: run.runId,
              listUrl: pickedListUrl,
              pickedPage: pagePick.pickedPage,
              urlRetry: urlIdx,
              pageRetry,
              candidateCount: queueableCandidates.length,
              toTry
            });

            for (let ci = 0; ci < toTry && singleHandledCountRef.value === 0; ci++) {
              const candidate = queueableCandidates[ci];
              await setCurrentListScan?.(buildCurrentListScan({
                pagePick,
                trigger,
                listUrl: urlToTry,
                pickedListUrl,
                phase: 'trying_candidate',
                status: 'running',
                candidateCount: queueableCandidates.length,
                queueableCount: queueableCandidates.length,
                assistId: candidate?.assistId || ''
              })).catch(() => {});
              await appendWatcherTrace('random_single_candidate_selected', {
                reason: 'single_random_candidate_selected',
                phase: 'single_random_run',
                trigger,
                runId: run.runId,
                listUrl: pickedListUrl,
                pickedPage: pagePick.pickedPage,
                candidateCount: queueableCandidates.length,
                candidateIndex: ci,
                assistId: candidate?.assistId || '',
                detailUrl: candidate?.detailUrl || '',
                journalShortName: candidate?.journalShortName || ''
              });

              const singleResult = await processCandidateBatch([candidate], {
                opts,
                trigger,
                blacklistedIds: singleBlacklistedIds,
                targetSessionSize: 1,
                getHandledCount: () => singleHandledCountRef.value,
                setHandledCount: value => { singleHandledCountRef.value = value; },
                setLastHandledReason: value => { singleLastHandledReasonRef.value = value; },
                pagePick,
                maxDetailAttempts: 1
              });

              if (singleResult.stop) {
                return finish(singleResult.result || { ok: true, reason: singleLastHandledReasonRef.value || 'candidate_handled' });
              }
            }

            if (singleHandledCountRef.value > 0) {
              return finish({
                ok: true,
                reason: singleLastHandledReasonRef.value || 'candidate_handled',
                scannedUrl: lastScan.url,
                scannedPublisher: lastScan.publisher,
                scannedPage: lastScan.page
              });
            }
            // Page exhausted → try next page
          }
          // URL exhausted → try next URL
        }

        // All retries exhausted, nothing handled
        return finish({
          ok: true,
          reason: 'single_candidate_skipped',
          scannedUrl: lastScan.url,
          scannedPublisher: lastScan.publisher,
          scannedPage: lastScan.page
        });

      } catch (err) {
        await appendWatcherTrace('run_error', { reason: err?.message || String(err), trigger });
        await incrementDaily('failed', trigger);
        await appendWatcherLog({ trigger, status: 'failed', reason: err?.message || String(err), page: lastScan.page || '' });
        return finish({ ok: false, reason: err?.message || String(err) });
      } finally {
        await finalizeRun(run);
      }
    }

    return { runAutoWatcherOnce };
  }

  globalThis.AblesciWatcherOrchestratorModule = {
    createWatcherOrchestratorApi
  };
})();
