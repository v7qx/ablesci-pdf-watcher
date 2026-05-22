'use strict';

// Responsibility: top-level auto watcher run orchestration without changing scheduling behavior.
(function () {
  function createWatcherOrchestratorApi(config) {
    const {
      depsRef,
      stateRef,
      normalizeOptions,
      hydrateJournalAccessRulesFromConfig,
      recordRunStart,
      getWatcherState,
      saveWatcherState,
      dailyCounterSnapshot,
      appendWatcherTrace,
      collectDemandIfDue,
      recordCfChallenge,
      isInWorkSchedule,
      formatBeijingDateTime,
      resetCfChallengeStreak,
      hydrateJournalAccessStatsIndex,
      isAssistDue,
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
      saveWatcherStateSafe,
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
      appendWatcherLog,
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
    } = config;

    async function runAutoWatcherOnce(trigger = 'alarm') {
      if (stateRef.autoWatcherRunning) {
        await appendWatcherTrace('run_skip_already_running', { reason: 'already_running', trigger });
        return { ok: false, reason: 'already_running' };
      }
      stateRef.autoWatcherRunning = true;
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
        let opts = normalizeOptions(await depsRef.getOptions());
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
        await saveWatcherStateSafe(stateForTargets);
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
          await saveWatcherStateSafe(stateForTargets);
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
          await saveWatcherStateSafe(stateForTargets);
          await incrementDaily('checked');
          const parsed = await parseListUrl(pickedListUrl);
          if (parsed.cfChallenge) {
            if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, pickedListUrl);
            return finish({ ok: false, reason: 'cf_challenge' });
          }
          const sourceGate = minSeekingGateForList(parsed, pickedListUrl, pagePick.publisher, opts);
          if (!sourceGate.ok) {
            await appendWatcherTrace('list_scan_skip_source_gate', {
              reason: sourceGate.reason,
              trigger,
              listUrl: pickedListUrl,
              publisher: sourceGate.publisher,
              count: sourceGate.count,
              threshold: sourceGate.threshold
            });
            continue;
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
              if (handledCount >= targetSessionSize || depsRef.hasActiveTask()) {
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
        stateRef.autoWatcherRunning = false;
      }
    }

    return { runAutoWatcherOnce };
  }

  globalThis.AblesciWatcherOrchestratorModule = {
    createWatcherOrchestratorApi
  };
})();
