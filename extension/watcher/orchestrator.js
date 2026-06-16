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
      calculateAdvancedTargetState,
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
      randomizeAssistListUrlWithMeta,
      incrementDaily,
      parseListUrl,
      minSeekingGateForList,
      appendWatcherLog,
      recordRunFinish,
      scheduleNextAssistAfterRun,
      refreshAlarmAfterRun,
      recordAttemptFinish,
      writeDailyReports,
      flushWatcherLogs,
      flushWatcherTrace,
      enqueueParsedCandidates,
      queueableCandidatesFromList,
      consumeQueuedCandidates,
      sourceDetailAttemptBudget,
      shouldSkipBackedOffPage,
      stateWithQueueRefillCursor,
      auditParsedListCandidates,
      auditEnqueueResult,
      listUrlWithAuditPage,
      normalizeParsedListCandidateContext,
      buildCurrentListScan,
      describeCurrentListScan,
      clearCurrentListScan,
      initCurrentPageData
    } = config;

    function sourceKeyFromUrl(url = '') {
      try {
        const u = new URL(url);
        const publisher = String(u.searchParams.get('publisher') || '').trim().toLowerCase();
        if (publisher) return publisher;
      } catch (_) {}
      const text = String(url || '').toLowerCase();
      if (/sciencedirect|elsevier/.test(text)) return 'elsevier';
      if (/ieee/.test(text)) return 'ieee';
      if (/\brsc\b|royal\s+society\s+of\s+chemistry/.test(text)) return 'rsc';
      if (/wiley/.test(text)) return 'wiley';
      if (/springer/.test(text)) return 'springer';
      if (/sage/.test(text)) return 'sage';
      if (/\bacs\b/.test(text)) return 'acs';
      return text.slice(0, 80) || 'unknown';
    }

    const RUNNING_LOCK_STALE_MS = 20 * 60 * 1000;

    function rotateRecentSource(urls = [], state = {}) {
      const lastKey = String(state.lastHandledPublisherKey || '').toLowerCase();
      if (!lastKey || urls.length <= 1) return urls;
      const otherSources = [];
      const recentSources = [];
      for (const url of urls) {
        const key = sourceKeyFromUrl(url);
        if (key === lastKey) {
          recentSources.push(url);
        } else {
          otherSources.push(url);
        }
      }
      if (otherSources.length <= 0 || recentSources.length <= 0) return urls;
      return [...otherSources, ...recentSources];
    }

    async function syncActualAssistCount(state, opts) {
      const now = Date.now();
      const lastSynced = state.lastAssistCountSyncedAt ? new Date(state.lastAssistCountSyncedAt).getTime() : 0;
      if (Number.isFinite(lastSynced) && now - lastSynced < 15 * 60 * 1000) {
        return;
      }
      try {
        const res = await fetch('https://www.ablesci.com/my/home');
        if (!res.ok) {
          await appendWatcherTrace('sync_web_assist_count_failed', {
            reason: 'http_not_ok',
            status: res.status
          });
          return;
        }
        const html = await res.text();
        const match = html.match(/最近应助[^\d]*(\d+)/);
        if (match) {
          const totalCount = parseInt(match[1], 10);
          const currentMonth = todayKey().slice(0, 7);
          state.firstSyncTotalAssists = state.firstSyncTotalAssists || {};
          state.firstSyncProgressRatio = state.firstSyncProgressRatio || {};
          if (state.firstSyncTotalAssists[currentMonth] === undefined) {
            state.firstSyncTotalAssists[currentMonth] = totalCount;
            // Calculate progress ratio at first sync (no calendar-progress truncation in the first week)
            let ratio = 0;
            const dayOfMonth = parseInt(todayKey().slice(8, 10), 10);
            if (dayOfMonth > 7) {
              const year = new Date(now).getFullYear();
              const month = new Date(now).getMonth();
              const startOfMonth = new Date(year, month, 1).getTime();
              const startOfNextMonth = new Date(year, month + 1, 1).getTime();
              const totalMonthMs = startOfNextMonth - startOfMonth;
              const currentMs = now - startOfMonth;
              ratio = totalMonthMs > 0 ? Math.max(0, Math.min(1, currentMs / totalMonthMs)) : 0;
            }
            state.firstSyncProgressRatio[currentMonth] = ratio;
          }

          state.monthlyInitialAssists = state.monthlyInitialAssists || {};
          if (state.monthlyInitialAssists[currentMonth] === undefined) {
            state.monthlyInitialAssists[currentMonth] = totalCount;
          }
          state.actualTotalAssists = totalCount;
          state.lastAssistCountSyncedAt = new Date().toISOString();
          await saveWatcherStateSafe(state);
          await appendWatcherTrace('sync_web_assist_count', {
            totalCount,
            currentMonth,
            firstSyncTotal: state.firstSyncTotalAssists[currentMonth],
            firstSyncRatio: state.firstSyncProgressRatio[currentMonth],
            initialCount: state.monthlyInitialAssists[currentMonth]
          });
        } else {
          await appendWatcherTrace('sync_web_assist_count_failed', {
            reason: 'count_pattern_not_found'
          });
        }
      } catch (err) {
        console.warn('[Ablesci Watcher] Failed to sync actual assist count:', err);
        await appendWatcherTrace('sync_web_assist_count_failed', {
          reason: 'exception',
          error: String(err?.message || err || '').slice(0, 240)
        });
      }
    }

    async function readBlacklistedIds(opts, trigger) {
      const blacklistedIds = [];
      if (!opts.watcherEnableBlacklist) return blacklistedIds;
      try {
        const res = await depsRef.sendNativeMessage(opts.nativeHostName, {
          action: 'read_text_file',
          path: opts.watcherBlacklistPath || '',
          extra: {
            allowed_path: opts.watcherBlacklistPath || '',
            perf_category: opts.watcherBlacklistPath ? 'blacklist_custom' : 'blacklist_default'
          }
        });
        if (res && res.ok && res.body) {
          const lines = res.body.split(/\r?\n/);
          for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#') || line.startsWith('//')) continue;
            const commentIdx = line.indexOf('#') >= 0 ? line.indexOf('#') : (line.indexOf('//') >= 0 ? line.indexOf('//') : -1);
            if (commentIdx >= 0) line = line.substring(0, commentIdx).trim();
            const parts = line.split(/[\s,，]+/).map(p => p.trim()).filter(Boolean);
            blacklistedIds.push(...parts);
          }
        }
      } catch (err) {
        console.error('[Blacklist] failed to read blacklist file in auto watcher:', err);
        await appendWatcherTrace('blacklist_read_error_ignored', {
          reason: 'blacklist_read_error_ignored',
          trigger,
          error: err.message || String(err)
        });
      }
      return blacklistedIds;
    }

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
        'nextAssistGuardMinutes',
        'nextAssistGuardApplied',
        'nextAssistGuardLiftMinutes',
        'nextAssistGuardWeight',
        'nextAssistGuardMode',
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

    function createRunContext(trigger) {
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
        backoffSkippedPages: []
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
      state.lastPickedPageMax = pagePick.pageMax || '';
      state.lastPickedPublisher = pagePick.publisher || '';
      state.lastPickedPageOrder = pagePick.pageOrder || '';
      state.lastPickedUrlKey = pagePick.urlKey || '';
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

    function canContinueScan(scan) {
      return scan.pageScanCount < scan.maxPageScans && scan.backoffSkipCount < scan.maxBackoffSkips;
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

    function recordBackoffSkippedPage(scan, page) {
      scan.run.backoffSkippedPages.push(page);
      scan.run.attempt.backoffSkippedPages = scan.run.backoffSkippedPages.join(',');
      scan.run.attempt.listScanBackoffSkipped = scan.run.backoffSkippedPages.length;
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

    async function consumeQueuePhase(details) {
      const {
        run,
        opts,
        blacklistedIds,
        targetSessionSize,
        handledCountRef,
        lastHandledReasonRef,
        runListUrls,
        phase,
        onlyListUrl = null
      } = details;
      const listUrls = onlyListUrl ? [onlyListUrl] : runListUrls;
      let queuedResult = null;
      await appendWatcherTrace('queue_consume_phase_start', {
        reason: phase,
        phase,
        trigger: run.trigger,
        runId: run.runId,
        listUrlCount: listUrls.length,
        targetSessionSize,
        handledCount: handledCountRef.value
      });
      for (const listUrl of listUrls) {
        const isHighFreq = /sciencedirect|elsevier/i.test(listUrl);
        if (isHighFreq && handledCountRef.value >= targetSessionSize) continue;
        const handledBeforeSource = handledCountRef.value;
        queuedResult = await consumeQueuedCandidates(
          run.trigger,
          opts,
          blacklistedIds,
          targetSessionSize,
          handledCountRef,
          lastHandledReasonRef,
          [listUrl],
          sourceDetailAttemptBudget(listUrl, runListUrls.length)
        );
        const handledCount = handledCountRef.value;
        if (phase === 'queue_consume_after_refill') {
          await appendPerfCheckpoint(run, 'queue_consumed_after_refill_source', { listUrl, handledCount, stop: queuedResult.stop === true });
        }
        if (queuedResult.stop) {
          await appendWatcherTrace('queue_consume_phase_done', {
            reason: queuedResult.result?.reason || phase,
            phase,
            trigger: run.trigger,
            runId: run.runId,
            handledCount,
            stopRun: true
          });
          return { stopRun: true, result: queuedResult.result, handledCount };
        }
        if (runListUrls.length > 1 && handledCount > handledBeforeSource) {
          await appendWatcherTrace('queue_consume_phase_done', {
            reason: lastHandledReasonRef.value || 'candidate_handled',
            phase,
            trigger: run.trigger,
            runId: run.runId,
            handledCount,
            stopRun: true
          });
          return { stopRun: true, result: { ok: true, reason: lastHandledReasonRef.value || 'candidate_handled' }, handledCount };
        }
      }
      await appendWatcherTrace('queue_consume_phase_done', {
        reason: phase,
        phase,
        trigger: run.trigger,
        runId: run.runId,
        handledCount: handledCountRef.value
      });
      return { stopRun: false, result: null, handledCount: handledCountRef.value };
    }

    async function prepareTargetPhase(run, opts) {
      const trigger = run.trigger;
      const stateForTargets = await getWatcherState();
      stateForTargets.optionsSnapshot = opts;
      await syncActualAssistCount(stateForTargets, opts);
      if (trigger === 'alarm' && opts.watcherQuantSchedulerEnabled && !isAssistDue(stateForTargets)) {
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
      if (trigger !== 'manual') {
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
      stateForTargets.lastAssistStrategy = opts.watcherQuantSchedulerEnabled ? 'calendar_target_lognormal' : 'fixed_interval';
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
        reason: opts.watcherQuantSchedulerEnabled ? 'calendar_target' : 'fixed_interval',
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
      await recordRunFinish(run.trigger, result).catch(() => {});
      if (run.trigger !== 'manual' && run.opts) {
        await scheduleNextAssistAfterRun(run.opts, result, run.trigger).catch(() => {});
        await refreshAlarmAfterRun(run.opts, result, run.attempt, run.trigger).catch(() => {});
      }
      await restoreManualScheduleSnapshot(run).catch(() => {});
      await recordAttemptFinish(run.attempt, result).catch(() => {});
      try { await writeDailyReports(); } catch (_) {}
      await flushWatcherLogs().catch(() => {});
      await flushWatcherTrace().catch(() => {});
      await clearCurrentListScan();
      stateRef.autoWatcherRunning = false;
      stateRef.autoWatcherStartedAt = 0;
    }

    async function runAutoWatcherOnce(trigger = 'alarm') {
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
      const run = createRunContext(trigger);
      const { attempt } = run;
      const finish = result => finishRun(run, result);
      try {
        await appendWatcherTrace('run_start', { reason: 'watcher_triggered', phase: 'run_start', trigger, runId: run.runId });
        await appendPerfCheckpoint(run, 'run_start');
        const opts = normalizeOptions(await depsRef.getOptions());
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
        if (depsRef.hasActiveTask()) {
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

        let handledCount = 0;
        const handledCountRef = { value: 0 };
        const lastHandledReasonRef = { value: '' };
        const sessionPhase = await prepareSessionPhase(run, opts, stateForTargets, targetState);
        if (sessionPhase.stopRun) return finish(sessionPhase.result);
        const { targetSessionSize } = sessionPhase;

        const runListUrls = rotateRecentSource(listUrlsForRun(opts), stateForTargets);
        const hasHighFreqSource = runListUrls.some(url => /sciencedirect|elsevier/i.test(url));
        const hasLowFreqSource = runListUrls.some(url => !/sciencedirect|elsevier/i.test(url));
        const firstSourceIsHighFreq = /sciencedirect|elsevier/i.test(runListUrls[0] || '');
        let queuedResult = null;
        await appendWatcherTrace('run_source_order', {
          reason: runListUrls.length > 1
            ? (hasHighFreqSource && hasLowFreqSource
                ? (firstSourceIsHighFreq ? 'weighted_high_first' : 'weighted_low_first')
                : 'random_source_order')
            : 'single_list_url',
          trigger,
          lastHandledPublisherKey: stateForTargets.lastHandledPublisherKey || '',
          listUrls: runListUrls
        });
        const blacklistedIds = await readBlacklistedIds(opts, trigger);
        await appendPerfCheckpoint(run, 'blacklist_loaded', { blacklistCount: blacklistedIds.length });

        queuedResult = await consumeQueuePhase({
          run,
          opts,
          blacklistedIds,
          targetSessionSize,
          handledCountRef,
          lastHandledReasonRef,
          runListUrls,
          phase: 'queue_consume_before_refill'
        });
        handledCount = queuedResult.handledCount;
        if (queuedResult.stopRun) return finish(queuedResult.result);
        await appendPerfCheckpoint(run, 'queue_consumed_before_refill', { handledCount });
        if (handledCount >= targetSessionSize) return finish({ ok: true, reason: handledCount > 1 ? 'session_candidates_handled' : (lastHandledReasonRef.value || 'candidate_handled') });

        for (const listUrl of runListUrls) {
          const isHighFreq = /sciencedirect|elsevier/i.test(listUrl);
          if (isHighFreq && handledCount >= targetSessionSize) {
            continue;
          }
          const scan = createScanContext(run, listUrl, runListUrls.length);
          while (canContinueScan(scan)) {
          const pagePick = randomizeAssistListUrlWithMeta(listUrl, stateWithQueueRefillCursor(listUrl, stateForTargets));
          let pickedListUrl = pagePick.pickedListUrl;
          const isSequentialPageScan = pagePick.pageOrder === 'desc' || pagePick.pageOrder === 'asc';
          if (await shouldSkipBackedOffPage(pagePick)) {
            await appendWatcherTrace('list_scan_skip_backoff', {
              reason: 'candidate_queue_page_backoff',
              phase: 'list_scan',
              trigger,
              runId: run.runId,
              configuredUrl: listUrl,
              publisher: pagePick.publisher,
              pageOrder: pagePick.pageOrder,
              urlKey: pagePick.urlKey,
              pickedPage: pagePick.pickedPage
            });
            if (isSequentialPageScan && pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
              const skippedPage = Number(pagePick.pickedPage);
              recordBackoffSkippedPage(scan, skippedPage);
              applyAttemptPagePick(attempt, pagePick, pickedListUrl);
              stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
              stateForTargets.lastVisitedPages[pagePick.urlKey] = skippedPage;
              updateStateLastPicked(stateForTargets, pagePick, pickedListUrl);
              stateForTargets.currentListScan = buildScanStatus(scan, pagePick, pickedListUrl, 'background_fetch_rebase');
              await saveWatcherStateSafe(stateForTargets);
              await appendWatcherTrace('list_scan_page_progress_saved', {
                reason: 'sequential_page_backoff_skipped',
                phase: 'list_scan',
                trigger,
                runId: run.runId,
                listUrl: pickedListUrl,
                configuredUrl: listUrl,
                publisher: pagePick.publisher,
                pageOrder: pagePick.pageOrder,
                urlKey: pagePick.urlKey,
                pickedPage: skippedPage,
                backoffSkippedPages: run.backoffSkippedPages.slice(-10),
                maxSequentialBackoffSkips: scan.maxBackoffSkips
              });
              scan.backoffSkipCount += 1;
              continue;
            }
            break;
          }
          attempt.listScanStarted = true;
          scan.startedAt = Date.now();
          applyAttemptPagePick(attempt, pagePick, pickedListUrl, { listScanStarted: true });
          await appendWatcherTrace('list_scan_start', {
            reason: pickedListUrl === listUrl ? 'configured_url' : 'picked_page',
            phase: 'list_scan',
            trigger,
            runId: run.runId,
            listUrl: pickedListUrl,
            configuredUrl: listUrl,
            publisher: pagePick.publisher,
            pageCurve: pagePick.pageCurve,
            pageOrder: pagePick.pageOrder,
            urlKey: pagePick.urlKey,
            pickedPage: pagePick.pickedPage,
            pageMin: pagePick.pageMin,
            pageMax: pagePick.pageMax,
            frontHit: pagePick.frontHit,
            alpha: pagePick.alpha,
            handledCount,
            targetSessionSize
          });
          updateStateLastPicked(stateForTargets, pagePick, pickedListUrl);
          stateForTargets.currentListScan = buildScanStatus(scan, pagePick, pickedListUrl);
          await saveWatcherStateSafe(stateForTargets);
          await incrementDaily('checked', trigger);
          const parseStartedAt = Date.now();
          let parsed = await parseListUrl(pickedListUrl);
          recordScannedPage(scan, pickedListUrl, pagePick);
          await appendWatcherTrace('perf_list_parse', {
            reason: 'list_parse_done',
            phase: 'list_scan',
            trigger,
            runId: run.runId,
            durationMs: Date.now() - parseStartedAt,
            pickedPage: pagePick.pickedPage,
            urlKey: pagePick.urlKey,
            parsedCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
            maxPage: parsed?.listStats?.maxPage || ''
          });
          if (parsed.isErrorPage) {
            await appendWatcherLog({
              type: 'warning',
              message: `🔄 ⚠️ 无法扫描列表：科研通网站返回服务错误 (${parsed.errorTitle || '502 Bad Gateway'})，值守已暂停并等待下一次轮询。`
            });
            return finish({ ok: false, reason: 'site_error' });
          }
          if (parsed.cfChallenge) {
            await recordCfChallenge(opts, pickedListUrl, trigger);
            return finish({ ok: false, reason: 'cf_challenge' });
          }

          if (isSequentialPageScan && parsed?.listStats?.currentPage && Number.isFinite(parsed.listStats.currentPage)) {
            const realCurrentPage = Number(parsed.listStats.currentPage);
            if (realCurrentPage < Number(pagePick.pickedPage)) {
              await appendWatcherTrace('list_scan_page_corrected', {
                reason: 'requested_page_exceeds_max_page',
                phase: 'list_scan',
                trigger,
                runId: run.runId,
                requestedPage: pagePick.pickedPage,
                correctedPage: realCurrentPage,
                maxPage: parsed.listStats.maxPage
              });
              pagePick.pickedPage = realCurrentPage;
              attempt.pickedPage = realCurrentPage;
              stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
              if (pagePick.pageOrder === 'desc') {
                stateForTargets.lastVisitedPages[pagePick.urlKey] = realCurrentPage + 1;
              } else if (pagePick.pageOrder === 'asc') {
                stateForTargets.lastVisitedPages[pagePick.urlKey] = realCurrentPage - 1;
              } else {
                stateForTargets.lastVisitedPages[pagePick.urlKey] = realCurrentPage;
              }

              if (parsed.listStats.maxPage && Number.isFinite(parsed.listStats.maxPage)) {
                pagePick.pageMax = Number(parsed.listStats.maxPage);
                attempt.pageMax = Number(parsed.listStats.maxPage);
                stateForTargets.detectedMaxPages = stateForTargets.detectedMaxPages || {};
                stateForTargets.detectedMaxPages[pagePick.urlKey] = Number(parsed.listStats.maxPage);
              }
              await saveWatcherStateSafe(stateForTargets);
            }
          }
          normalizeParsedListCandidateContext(parsed, pagePick, pickedListUrl);
          const auditPickedListUrl = listUrlWithAuditPage(pickedListUrl, pagePick.pickedPage);
          await initCurrentPageData(auditPickedListUrl, pagePick, parsed);
          await auditParsedListCandidates(parsed, pagePick, auditPickedListUrl, trigger);

          let detectedMaxPage = Number(parsed?.listStats?.maxPage || 0);
          if (Number.isFinite(detectedMaxPage) && detectedMaxPage > 0) {
            stateForTargets.lastPickedPageMax = detectedMaxPage;
            await saveWatcherStateSafe(stateForTargets);
          }
          if (
            isSequentialPageScan &&
            pagePick.urlKey &&
            Number.isFinite(detectedMaxPage) &&
            detectedMaxPage > 0
          ) {
            const adjustedState = stateWithQueueRefillCursor(listUrl, stateForTargets, detectedMaxPage);
            const adjustedPagePick = randomizeAssistListUrlWithMeta(listUrl, adjustedState);
            const adjustedPage = Number(adjustedPagePick.pickedPage);
            const currentPickedPage = Number(pagePick.pickedPage);
            if (
              adjustedPagePick.urlKey === pagePick.urlKey &&
              adjustedPagePick.pageOrder === pagePick.pageOrder &&
              Number.isFinite(adjustedPage) &&
              Number.isFinite(currentPickedPage) &&
              adjustedPage > 0 &&
              adjustedPage !== currentPickedPage
            ) {
              await appendWatcherTrace('list_scan_refill_cursor_rebased', {
                reason: 'detected_max_page_changed',
                phase: 'list_scan',
                trigger,
                runId: run.runId,
                configuredUrl: listUrl,
                previousListUrl: pickedListUrl,
                previousPickedPage: pagePick.pickedPage,
                adjustedPickedPage: adjustedPage,
                detectedMaxPage,
                urlKey: pagePick.urlKey
              });
              pickedListUrl = adjustedPagePick.pickedListUrl;
              Object.assign(pagePick, adjustedPagePick);
              applyAttemptPagePick(attempt, pagePick, pickedListUrl);
              updateStateLastPicked(stateForTargets, pagePick, pickedListUrl);
              await saveWatcherStateSafe(stateForTargets);
              await incrementDaily('checked', trigger);
              const reparseStartedAt = Date.now();
              parsed = await parseListUrl(pickedListUrl);
              recordScannedPage(scan, pickedListUrl, pagePick);
              await appendWatcherTrace('perf_list_parse', {
                reason: 'list_reparse_after_rebase_done',
                phase: 'list_scan',
                trigger,
                runId: run.runId,
                durationMs: Date.now() - reparseStartedAt,
                pickedPage: pagePick.pickedPage,
                urlKey: pagePick.urlKey,
                parsedCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
                maxPage: parsed?.listStats?.maxPage || ''
              });
              if (parsed.isErrorPage) {
                await appendWatcherLog({
                  type: 'warning',
                  message: `🔄 ⚠️ 无法扫描列表：科研通网站返回服务错误 (${parsed.errorTitle || '502 Bad Gateway'})，值守已暂停并等待下一次轮询。`
                });
                return finish({ ok: false, reason: 'site_error' });
              }
              if (parsed.cfChallenge) {
                await recordCfChallenge(opts, pickedListUrl, trigger);
                return finish({ ok: false, reason: 'cf_challenge' });
              }
              normalizeParsedListCandidateContext(parsed, pagePick, pickedListUrl);
              const auditRebasedListUrl = listUrlWithAuditPage(pickedListUrl, pagePick.pickedPage);
              await initCurrentPageData(auditRebasedListUrl, pagePick, parsed);
              await auditParsedListCandidates(parsed, pagePick, auditRebasedListUrl, trigger, 'parsed_after_rebase');
              detectedMaxPage = Number(parsed?.listStats?.maxPage || 0);
            }
          }

          if (
            trigger === 'manual' &&
            pagePick.pageOrder === 'desc' &&
            pagePick.hasExplicitPageMax !== true &&
            Number.isFinite(detectedMaxPage) &&
            detectedMaxPage > Number(pagePick.pageMax || 0) &&
            pagePick.urlKey
          ) {
            stateForTargets.detectedMaxPages = stateForTargets.detectedMaxPages || {};
            stateForTargets.detectedMaxPages[pagePick.urlKey] = detectedMaxPage;
            await saveWatcherStateSafe(stateForTargets);
            await appendWatcherTrace('list_scan_detected_tail_page_saved', {
              reason: 'manual_order_desc_detected_max_page_saved',
              phase: 'list_scan',
              trigger,
              runId: run.runId,
              configuredUrl: listUrl,
              listUrl: pickedListUrl,
              publisher: pagePick.publisher,
              urlKey: pagePick.urlKey,
              detectedMaxPage
            });
          }

          const sourceGate = minSeekingGateForList(parsed, pickedListUrl, pagePick.publisher, opts);
          if (!sourceGate.ok) {
            await appendWatcherTrace('list_scan_skip_source_gate', {
              reason: sourceGate.reason,
              phase: 'list_scan',
              trigger,
              runId: run.runId,
              listUrl: pickedListUrl,
              publisher: sourceGate.publisher,
              count: sourceGate.count,
              threshold: sourceGate.threshold
            });
            if (isSequentialPageScan) {
              if (pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
                stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
                stateForTargets.lastVisitedPages[pagePick.urlKey] = Number(pagePick.pickedPage);
                await saveWatcherStateSafe(stateForTargets);
                await appendWatcherTrace('list_scan_page_progress_saved', {
                  reason: 'sequential_page_exhausted_source_gate',
                  phase: 'list_scan',
                  trigger,
                  runId: run.runId,
                  listUrl: pickedListUrl,
                  configuredUrl: listUrl,
                  publisher: pagePick.publisher,
                  pageOrder: pagePick.pageOrder,
                  urlKey: pagePick.urlKey,
                  pickedPage: Number(pagePick.pickedPage),
                  currentPage: parsed?.listStats?.currentPage || '',
                  maxPage: parsed?.listStats?.maxPage || ''
                });
              }
              scan.pageScanCount += 1;
              continue;
            }
            break;
          }
          await resetCfChallengeStreak();

          const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets, opts, targetSessionSize);
          const refillStartedAt = Date.now();
          const queueableCandidates = await queueableCandidatesFromList(candidates, opts, trigger, pagePick, blacklistedIds);
          const enqueueResult = await enqueueParsedCandidates(parsed, pagePick, pickedListUrl, trigger, queueableCandidates);
          await auditEnqueueResult(enqueueResult, pagePick, pickedListUrl, trigger);
          await appendWatcherTrace('perf_queue_refill', {
            reason: 'queue_refill_done',
            phase: 'queue_refill',
            trigger,
            runId: run.runId,
            durationMs: Date.now() - refillStartedAt,
            pickedPage: pagePick.pickedPage,
            parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            orderedCount: candidates.length,
            queueableCount: queueableCandidates.length,
            queueAdded: enqueueResult.added,
            queueRefreshed: enqueueResult.refreshed,
            queueSeenSkipped: enqueueResult.seenSkipped
          });
          const latestStateAfterQueue = await getWatcherState();
          stateForTargets.assistCandidateQueue = latestStateAfterQueue.assistCandidateQueue;
          stateForTargets.detectedMaxPages = latestStateAfterQueue.detectedMaxPages || stateForTargets.detectedMaxPages;
          if (isSequentialPageScan && pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
            stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
            stateForTargets.lastVisitedPages[pagePick.urlKey] = Number(pagePick.pickedPage);
            await appendWatcherTrace('list_scan_page_cursor_advanced', {
              reason: 'sequential_page_snapshot_enqueued_in_memory',
              phase: 'list_scan',
              trigger,
              runId: run.runId,
              listUrl: pickedListUrl,
              configuredUrl: listUrl,
              publisher: pagePick.publisher,
              pageOrder: pagePick.pageOrder,
              urlKey: pagePick.urlKey,
              pickedPage: Number(pagePick.pickedPage),
              currentPage: parsed?.listStats?.currentPage || ''
            });
          }
          await appendWatcherTrace('list_scan_candidates', {
            reason: 'ordered_candidates',
            phase: 'queue_refill',
            trigger,
            runId: run.runId,
            listUrl: pickedListUrl,
            parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            orderedCount: candidates.length,
            queueableCount: queueableCandidates.length
          });

          if (isSequentialPageScan) {
            scan.pageScanCount += 1;
            if (scan.pageScanCount < scan.maxPageScans) {
              await appendWatcherTrace('list_scan_continue_next_page', {
                reason: 'sequential_page_snapshot_enqueued',
                phase: 'list_scan',
                trigger,
                runId: run.runId,
                listUrl: pickedListUrl,
                configuredUrl: listUrl,
                publisher: pagePick.publisher,
                pageOrder: pagePick.pageOrder,
                urlKey: pagePick.urlKey,
                pickedPage: pagePick.pickedPage,
                nextScanIndex: scan.pageScanCount + 1,
                maxSequentialPageScans: scan.maxPageScans,
                parsedListPages: run.parsedListPages.slice(-10),
                backoffSkippedPages: run.backoffSkippedPages.slice(-10)
              });
              continue;
            }
          }
          await appendWatcherTrace('perf_list_scan_page', {
            reason: 'list_scan_page_done',
            phase: 'list_scan',
            trigger,
            runId: run.runId,
            durationMs: Date.now() - scan.startedAt,
            pickedPage: pagePick.pickedPage,
            parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            queueableCount: queueableCandidates.length
          });
          break;
          }

          queuedResult = await consumeQueuePhase({
            run,
            opts,
            blacklistedIds,
            targetSessionSize,
            handledCountRef,
            lastHandledReasonRef,
            runListUrls,
            phase: 'queue_consume_after_refill',
            onlyListUrl: listUrl
          });
          handledCount = queuedResult.handledCount;
          if (queuedResult.stopRun) return finish(queuedResult.result);
        }

        const reason = handledCount
          ? (handledCount > 1 ? 'session_candidates_handled' : (lastHandledReasonRef.value || 'candidate_handled'))
          : (run.parsedListPages.length <= 0 && run.backoffSkippedPages.length > 0 ? 'list_pages_backoff_only' : 'no_candidate');
        const finalResult = { ok: true, reason };
        if (reason === 'no_candidate' || reason === 'list_pages_backoff_only') {
          finalResult.scannedUrl = run.scannedUrl;
          finalResult.scannedPublisher = run.scannedPublisher;
          finalResult.scannedPage = run.scannedPage;
          finalResult.parsedListPages = run.parsedListPages.slice(-20);
          finalResult.backoffSkippedPages = run.backoffSkippedPages.slice(-30);
        }
        return finish(finalResult);
      } catch (err) {
        await appendWatcherTrace('run_error', { reason: err?.message || String(err), trigger });
        await incrementDaily('failed', trigger);
        await appendWatcherLog({ trigger, status: 'failed', reason: err?.message || String(err), page: typeof pagePick !== 'undefined' ? pagePick?.pickedPage : '' });
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
