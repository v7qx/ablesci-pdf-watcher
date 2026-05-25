// Responsibility: session-size calculation and advanced session burst execution.
(function () {
  function createWatcherSessionApi(config) {
    const {
      sessionModes,
      maxSessionCandidates,
      sessionExecutionCap,
      riskSnapshot,
      weightedPickIndexWithDebug,
      logNormalMinutes,
      advancedItemGap,
      advancedCooldown,
      saveWatcherState,
      getWatcherState,
      appendWatcherTrace,
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
      selectBanditCandidates,
      inspectDetail,
      closeTabQuietly,
      updateProcessed,
      appendWatcherLog,
      isDetailAllowedForWatcher,
      getProcessedKey,
      candidateSource,
      handleAllowedPayload,
      sleepMinutes
    } = config;

    function sessionSize(opts, state) {
      const mode = sessionModes[state?.speedMode || 'normal'] || sessionModes.normal;
      const decision = weightedPickIndexWithDebug(mode.sizeWeights);
      const picked = decision.index;
      const cap = sessionExecutionCap(opts, state, opts?.watcherQuantSchedulerEnabled !== false);
      const finalSize = Math.min(cap, Math.max(0, picked));
      if (state) {
        state.lastSessionSizeDecision = {
          mode: state.speedMode || 'normal',
          picked,
          cap,
          finalSize,
          random: Number(decision.random.toFixed(6)),
          total: Number(decision.total.toFixed(6)),
          weights: decision.weights,
          allowZero: opts?.watcherAllowZeroSession === true
        };
      }
      return finalSize;
    }

    function advancedSessionSize(opts, state) {
      const risk = riskSnapshot(state, opts);
      if (risk.exhausted) return 0;
      const cap = Math.min(sessionExecutionCap(opts, state, true), risk.remaining);
      if (cap <= 0) return 0;
      const mode = sessionModes[state?.speedMode || 'normal'] || sessionModes.normal;
      const decision = weightedPickIndexWithDebug(mode.sizeWeights);
      const modeSize = decision.index;
      const multiplier = Number(state.rateMultiplier || 1);
      const intensity = Number(state.sessionIntensity || 0.4);
      const parentOrderSize = Math.ceil(maxSessionCandidates(opts) * Math.max(0.12, intensity) * 0.75);
      const boost = multiplier > 2.0 ? 2 : (multiplier > 1.45 ? 1 : 0);
      const desired = Math.max(modeSize, parentOrderSize) + boost;
      const finalSize = Math.max(0, Math.min(cap, desired));
      if (state) {
        state.lastSessionSizeDecision = {
          mode: state.speedMode || 'normal',
          picked: modeSize,
          cap,
          finalSize,
          random: Number(decision.random.toFixed(6)),
          total: Number(decision.total.toFixed(6)),
          weights: decision.weights,
          allowZero: opts?.watcherAllowZeroSession === true,
          parentOrderSize,
          boost
        };
      }
      return finalSize;
    }

    async function runAdvancedSchedulerSession(opts, stateForTargets, targetSessionSize, observeResult, trigger = '') {
      stateForTargets.optionsSnapshot = opts;
      const session = {
        id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        trigger,
        startedAt: new Date().toISOString(),
        status: 'planning',
        plannedSize: 0,
        handledCount: 0
      };
      stateForTargets.currentSession = session;
      await saveWatcherState(stateForTargets);
      const runListUrls = listUrlsForRun(opts);
      await appendWatcherTrace('session_start', {
        reason: 'advanced_planning',
        sessionId: session.id,
        sessionSize: targetSessionSize,
        listUrlCount: runListUrls.length
      });
      await appendWatcherTrace('session_source_order', {
        reason: 'randomized_publisher_order',
        sessionId: session.id,
        listUrls: runListUrls
      });

      const plan = [];
      for (const listUrl of runListUrls) {
        if (plan.length >= targetSessionSize) break;
        const pagePick = randomizeAssistListUrlWithMeta(listUrl);
        const pickedListUrl = pagePick.pickedListUrl;
        await appendWatcherTrace('session_plan_url', {
          reason: pickedListUrl === listUrl ? 'configured_url' : 'randomized_page',
          sessionId: session.id,
          listUrl: pickedListUrl,
          configuredUrl: listUrl,
          publisher: pagePick.publisher,
          pageCurve: pagePick.pageCurve,
          pickedPage: pagePick.pickedPage,
          pageMin: pagePick.pageMin,
          pageMax: pagePick.pageMax,
          frontHit: pagePick.frontHit,
          alpha: pagePick.alpha,
          pickedListUrl: pagePick.pickedListUrl
        });
        stateForTargets.lastPickedListUrl = pickedListUrl;
        await saveWatcherState(stateForTargets);
        await incrementDaily('checked');
        const parsed = await parseListUrl(pickedListUrl);
        if (parsed.cfChallenge) {
          if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, pickedListUrl);
          return { ok: false, reason: 'cf_challenge' };
        }
        await resetCfChallengeStreak();
        const allowed = [];
        for (const rawCandidate of parsed.candidates || []) {
          const candidate = enrichCandidateJournalFromMap(rawCandidate, stateForTargets);
          const listAllowed = isListCandidateAllowed(candidate, opts);
          if (!listAllowed.ok) {
            await appendWatcherTrace('candidate_skip_list_filter', {
              reason: listAllowed.reason,
              reasonText: describeWatcherReason(listAllowed.reason),
              sessionId: session.id,
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
              sessionId: session.id,
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
              sessionId: session.id,
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
              sessionId: session.id,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || ''
            });
            continue;
          }
          allowed.push(candidate);
        }
        const selected = selectBanditCandidates(allowed, stateForTargets, stateForTargets.marketData, targetSessionSize);
        await appendWatcherTrace('session_plan_result', {
          reason: 'list_candidates_scored',
          sessionId: session.id,
          listUrl: pickedListUrl,
          parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
          allowedCount: allowed.length,
          selectedCount: selected.length,
          planSizeBefore: plan.length
        });
        plan.push(...selected);
      }

      const stateWithPlan = await getWatcherState();
      stateWithPlan.currentSession = {
        ...session,
        status: 'running',
        plannedSize: plan.length,
        targetSessionSize
      };
      await saveWatcherState(stateWithPlan);
      await appendWatcherTrace('session_plan_done', {
        reason: 'advanced_plan_ready',
        sessionId: session.id,
        plannedSize: plan.length,
        targetSessionSize
      });

      let handledCount = 0;
      const startedMs = Date.now();
      for (const candidate of plan) {
        if (handledCount >= targetSessionSize) break;
        await appendWatcherTrace('candidate_detail_start', {
          reason: 'advanced_candidate_detail',
          sessionId: session.id,
          detailUrl: candidate.detailUrl,
          assistId: candidate.assistId || '',
          title: candidate.title || ''
        });
        const detail = await inspectDetail(candidate);
        if (!detail.ok) {
          await closeTabQuietly(detail.tabId, 'detail_extract_failed');
          await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
          await incrementDaily('failed');
          await recordRiskEvent(opts, detail.reason, 'failed');
          await recordBanditOutcome(candidateSource(candidate), 'failure', 0, detail.reason);
          await appendWatcherLog({ ...candidate, sessionId: session.id, trigger, status: 'failed', reason: detail.reason });
        } else {
          const payload = detail.payload;
          payload.journalShortName = payload.journalShortName || candidate.journalShortName || '';
          const detailAllowed = isDetailAllowedForWatcher(payload, opts);
          const key = getProcessedKey(candidate, payload);
          if (!detailAllowed.ok) {
            await appendWatcherTrace('candidate_skip_detail_filter', { reason: detailAllowed.reason, reasonText: describeWatcherReason(detailAllowed.reason), sessionId: session.id, detailUrl: candidate.detailUrl, tabId: detail.tabId, assistId: key });
            await closeTabQuietly(detail.tabId, 'detail_filter_skipped');
            await updateProcessed(key, 'skipped', detailAllowed.reason);
            await incrementDaily('skipped');
            await recordBanditOutcome(candidateSource(candidate, payload), 'failure', 0, detailAllowed.reason);
            await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, sessionId: session.id, trigger, status: 'skipped', reason: detailAllowed.reason });
          } else {
            const handledResult = await handleAllowedPayload(candidate, payload, opts, detail.tabId, session, trigger);
            const handled = typeof handledResult === 'object' ? handledResult.handled === true : handledResult === true;
            if (!handled) await closeTabQuietly(detail.tabId, 'candidate_not_handled');
            if (handled) handledCount += 1;
            if (handledResult?.stopRun === true) {
              await appendWatcherTrace('session_stopped_after_candidate_failure', {
                reason: handledResult.reason || 'upload_failed_stop_run',
                sessionId: session.id,
                detailUrl: candidate.detailUrl,
                handledCount,
                paused: handledResult.paused === true
              });
              break;
            }
          }
        }

        const afterState = await getWatcherState();
        afterState.currentSession = {
          ...afterState.currentSession,
          status: 'running',
          handledCount,
          sessionDurationMs: Date.now() - startedMs
        };
        await saveWatcherState(afterState);

        if (handledCount < targetSessionSize && plan.indexOf(candidate) < plan.length - 1) {
          const gap = logNormalMinutes(advancedItemGap.median, advancedItemGap.min, advancedItemGap.max);
          await appendWatcherTrace('session_item_gap', { reason: 'between_candidates', sessionId: session.id, gapMinutes: Number(gap.toFixed(2)), handledCount, targetSessionSize });
          await sleepMinutes(gap);
        }
      }

      const finalState = await getWatcherState();
      const durationMs = Date.now() - startedMs;
      const cooldownMinutes = Number((logNormalMinutes(advancedCooldown.median, advancedCooldown.min, advancedCooldown.max) / Math.max(0.25, Number(finalState.rateMultiplier || 1))).toFixed(2));
      finalState.lastSession = {
        ...finalState.currentSession,
        status: 'done',
        finishedAt: new Date().toISOString(),
        handledCount,
        sessionDurationMs: durationMs,
        cooldownMinutes,
        cooldownUntil: new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString()
      };
      finalState.currentSession = { ...finalState.lastSession };
      await saveWatcherState(finalState);
      await appendWatcherTrace('session_done', {
        reason: handledCount ? 'advanced_session_done' : 'advanced_no_candidate',
        sessionId: session.id,
        handledCount,
        targetSessionSize,
        sessionDurationMs: durationMs,
        cooldownMinutes: finalState.lastSession.cooldownMinutes,
        cooldownUntil: finalState.lastSession.cooldownUntil
      });
      return { ok: true, reason: handledCount ? 'advanced_session_done' : 'advanced_no_candidate', observeSnapshot: observeResult?.snapshot ? true : false };
    }

    return {
      sessionSize,
      advancedSessionSize,
      runAdvancedSchedulerSession
    };
  }

  globalThis.AblesciWatcherSessionModule = {
    createWatcherSessionApi
  };
}());
