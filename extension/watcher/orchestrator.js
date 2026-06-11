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
      orderCandidatesForRun,
      enrichCandidateJournalFromMap,
      isListCandidateAllowed,
      describeWatcherReason,
      wasRecentlyProcessed,
      inspectDetail,
      closeTabQuietly,
      updateProcessed,
      appendWatcherLog,
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
    } = config;

    async function syncActualAssistCount(state, opts) {
      const now = Date.now();
      const lastSynced = state.lastAssistCountSyncedAt ? new Date(state.lastAssistCountSyncedAt).getTime() : 0;
      if (Number.isFinite(lastSynced) && now - lastSynced < 15 * 60 * 1000) {
        return;
      }
      try {
        const res = await fetch('https://www.ablesci.com/my/home');
        if (!res.ok) return;
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
        }
      } catch (err) {
        console.warn('[Ablesci Watcher] Failed to sync actual assist count:', err);
      }
    }

    async function initCurrentPageData(pickedListUrl, pagePick, parsed) {
      try {
        const chromeApi = typeof chrome !== 'undefined' ? chrome : browser;
        const currentPageKey = 'autoWatcherCurrentPageData';
        const storedPageData = (await chromeApi.storage.local.get(currentPageKey))[currentPageKey];
        const latestIds = new Set((parsed.candidates || []).map(c => String(c.assistId || '')));

        if (!storedPageData || storedPageData.url !== pickedListUrl) {
          const initialCandidates = (parsed.candidates || []).slice().reverse().map(c => ({
            assistId: String(c.assistId || ''),
            title: c.title || '',
            doi: c.doi || '',
            detailUrl: c.detailUrl || '',
            status: 'pending',
            reason: '',
            time: 0
          }));
          await chromeApi.storage.local.set({
            [currentPageKey]: {
              page: pagePick.pickedPage,
              url: pickedListUrl,
              order: pagePick.pageOrder,
              candidates: initialCandidates
            }
          });
        } else {
          let updated = false;
          const pageData = storedPageData;
          if (Array.isArray(pageData.candidates)) {
            const oldMap = new Map();
            for (const cand of pageData.candidates) {
              oldMap.set(String(cand.assistId), cand);
            }

            const latestCandidatesOrdered = (parsed.candidates || []).slice().reverse();
            const orderedCandidates = [];

            // 1. 遍历最新在线列表候选（保证其从上到下的物理顺序与网页100%一致）
            for (const c of latestCandidatesOrdered) {
              const cid = String(c.assistId || '');
              if (!cid) continue;

              if (oldMap.has(cid)) {
                orderedCandidates.push(oldMap.get(cid));
                oldMap.delete(cid);
              } else {
                orderedCandidates.push({
                  assistId: cid,
                  title: c.title || '',
                  doi: c.doi || '',
                  detailUrl: c.detailUrl || '',
                  status: 'pending',
                  reason: '',
                  time: 0
                });
                updated = true;
              }
            }

            // 2. Map 中剩下的是消失的候选（已被他人完成、机器人关闭，或之前成功/失败而消失的）
            if (oldMap.size > 0) {
              for (const [cid, cand] of oldMap.entries()) {
                if (cand.status === 'pending' || cand.status === 'processing') {
                  cand.status = 'closed';
                  cand.reason = 'assist_closed_or_resolved';
                  cand.time = Date.now();
                }
                orderedCandidates.push(cand);
                updated = true;
              }
            }

            if (updated || orderedCandidates.length !== pageData.candidates.length) {
              pageData.candidates = orderedCandidates;
              await chromeApi.storage.local.set({ [currentPageKey]: pageData });
            }
          }
        }
      } catch (err) {
        console.warn('[initCurrentPageData] failed', err);
      }
    }

    async function updateCurrentPageCandidateStatus(assistId, status, reason) {
      try {
        const chromeApi = typeof chrome !== 'undefined' ? chrome : browser;
        const key = 'autoWatcherCurrentPageData';
        const stored = await chromeApi.storage.local.get(key);
        const pageData = stored[key];
        if (pageData && Array.isArray(pageData.candidates)) {
          let updated = false;
          const assistIdStr = String(assistId || '');
          for (const cand of pageData.candidates) {
            if (String(cand.assistId) === assistIdStr) {
              cand.status = status;
              cand.reason = reason;
              cand.time = Date.now();
              updated = true;
            }
          }
          if (updated) {
            await chromeApi.storage.local.set({ [key]: pageData });
          }
        }
      } catch (err) {
        console.warn('[updateCurrentPageCandidateStatus] failed', err);
      }
    }

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
      let manualScheduleSnapshot = null;
      function finish(result) {
        runResult = result;
        return result;
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
      async function restoreManualScheduleSnapshot() {
        if (!manualScheduleSnapshot) return;
        const state = await getWatcherState();
        Object.assign(state, manualScheduleSnapshot);
        await saveWatcherState(state);
        await appendWatcherTrace('manual_run_schedule_preserved', {
          reason: 'manual_run_does_not_replan_auto_schedule',
          nextAssistRunAt: state.nextAssistRunAt || '',
          chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
          nextScheduledAt: state.nextScheduledAt || ''
        });
      }
      try {
        await appendWatcherTrace('run_start', { reason: 'watcher_triggered', trigger });
        const opts = normalizeOptions(await depsRef.getOptions());
        currentRunOpts = opts;
        await recordRunStart(trigger, opts);
        const initialState = await getWatcherState();
        if (trigger === 'manual') {
          manualScheduleSnapshot = snapshotScheduleFields(initialState);
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
        const stateForTargets = await getWatcherState();
        stateForTargets.optionsSnapshot = opts;
        await syncActualAssistCount(stateForTargets, opts);
        if (trigger === 'alarm' && opts.watcherQuantSchedulerEnabled && !isAssistDue(stateForTargets)) {
          await appendWatcherTrace('run_skip_assist_not_due', {
            reason: 'assist_not_due',
            trigger,
            nextAssistRunAt: stateForTargets.nextAssistRunAt || '',
            nextAssistRunAtBeijing: stateForTargets.nextAssistRunAt ? formatBeijingDateTime(stateForTargets.nextAssistRunAt) : '',
            secondsUntilAssist: stateForTargets.nextAssistRunAt ? Math.round((new Date(stateForTargets.nextAssistRunAt).getTime() - Date.now()) / 1000) : ''
          });
          return finish({ ok: true, reason: 'assist_not_due' });
        }
        if (trigger !== 'manual') {
          const rateLimit = checkShortTermRateLimit(stateForTargets);
          if (rateLimit.limited) {
            const reason = `rate_limited_${rateLimit.window}`;
            await appendWatcherTrace('run_skip_rate_limit', {
              reason,
              window: rateLimit.window,
              count: rateLimit.count,
              limit: rateLimit.limit,
              trigger
            });
            return finish({ ok: false, reason });
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
              rateMultiplier: 1,
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
          rateMultiplier: 1,
          targetError: targetState.targetError ?? targetState.lag ?? 0,
          workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
          activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
          availabilityFactor: targetState.availabilityFactor || 1,
          availabilityActualWakeCount: targetState.availabilityActualWakeCount || 0,
          availabilityExpectedWakeCount: targetState.availabilityExpectedWakeCount || 0,
          riskUsed: targetState.riskUsed || 0,
          riskLimit: targetState.riskLimit || 0,
          dailyLimit: opts.watcherDailyLimit || 0
        };
        await saveWatcherStateSafe(stateForTargets);
        await appendWatcherTrace('run_target_state', {
          reason: opts.watcherQuantSchedulerEnabled ? 'calendar_target' : 'fixed_interval',
          trigger,
          modelData: stateForTargets.lastAssistDecisionModelData,
          speedMode: targetState.speedMode,
          todayTarget: '',
          hourTarget: '',
          rateMultiplier: '',
          targetError: targetState.targetError || targetState.lag || '',
          workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
          activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
          availabilityFactor: targetState.availabilityFactor || 1
        });
        if (opts.watcherDailyLimit > 0 && await getDailyCount('downloaded') >= opts.watcherDailyLimit) {
          await appendWatcherTrace('run_skip_daily_limit', { reason: 'daily_limit', trigger, dailyLimit: opts.watcherDailyLimit });
          return finish({ ok: false, reason: 'daily_limit' });
        }

        let handledCount = 0;
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
          todayTarget: '',
          dailyLimit: opts.watcherDailyLimit || 0,
          riskRemaining: riskForSizing.remaining,
          sessionMode: 'single'
        });
        if (targetSessionSize <= 0) return finish({ ok: true, reason: 'session_size_zero' });

        const runListUrls = listUrlsForRun(opts);
        await appendWatcherTrace('run_source_order', {
          reason: 'randomized_publisher_order',
          trigger,
          listUrls: runListUrls
        });
        for (const listUrl of runListUrls) {
          let sequentialPageScanCount = 0;
          const maxSequentialPageScans = trigger === 'manual' ? 1 : 5;
          while (sequentialPageScanCount < maxSequentialPageScans) {
          const pagePick = randomizeAssistListUrlWithMeta(listUrl, stateForTargets);
          let pickedListUrl = pagePick.pickedListUrl;
          const isSequentialPageScan = pagePick.pageOrder === 'desc' || pagePick.pageOrder === 'asc';
          attempt.listScanStarted = true;
          attempt.pickedListUrl = pickedListUrl;
          attempt.pickedPage = pagePick.pickedPage;
          attempt.pageCurve = pagePick.pageCurve;
          attempt.pageMin = pagePick.pageMin;
          attempt.pageMax = pagePick.pageMax;
          attempt.frontHit = pagePick.frontHit;
          attempt.alpha = pagePick.alpha;
          attempt.pageOrder = pagePick.pageOrder;
          attempt.listUrlKey = pagePick.urlKey;
          await appendWatcherTrace('list_scan_start', {
            reason: pickedListUrl === listUrl ? 'configured_url' : 'picked_page',
            trigger,
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
          stateForTargets.lastPickedListUrl = pickedListUrl;
          await saveWatcherStateSafe(stateForTargets);
          await incrementDaily('checked', trigger);
          let parsed = await parseListUrl(pickedListUrl);
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
          await initCurrentPageData(pickedListUrl, pagePick, parsed);

          if (isSequentialPageScan && parsed?.listStats?.currentPage && Number.isFinite(parsed.listStats.currentPage)) {
            const realCurrentPage = Number(parsed.listStats.currentPage);
            if (realCurrentPage < Number(pagePick.pickedPage)) {
              await appendWatcherTrace('list_scan_page_corrected', {
                reason: 'requested_page_exceeds_max_page',
                trigger,
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

          const detectedMaxPage = Number(parsed?.listStats?.maxPage || 0);
          const shouldRescanDetectedTail = pagePick.pageOrder === 'desc'
            && trigger !== 'manual'
            && pagePick.hasExplicitPageMax !== true
            && Number.isFinite(detectedMaxPage)
            && detectedMaxPage > Number(pagePick.pageMax || 0);
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
              trigger,
              configuredUrl: listUrl,
              listUrl: pickedListUrl,
              publisher: pagePick.publisher,
              urlKey: pagePick.urlKey,
              detectedMaxPage
            });
          }
          if (shouldRescanDetectedTail) {
            let tailListUrl = '';
            try {
              const tailUrl = new URL(pickedListUrl);
              tailUrl.searchParams.set('page', String(detectedMaxPage));
              tailListUrl = tailUrl.toString();
            } catch (_) {}
            if (tailListUrl) {
              pickedListUrl = tailListUrl;
              pagePick.pickedListUrl = pickedListUrl;
              pagePick.pickedPage = detectedMaxPage;
              pagePick.pageMax = detectedMaxPage;
              attempt.pickedListUrl = pickedListUrl;
              attempt.pickedPage = detectedMaxPage;
              attempt.pageMax = detectedMaxPage;
              await appendWatcherTrace('list_scan_detected_tail_page', {
                reason: 'order_desc_detected_max_page',
                trigger,
                configuredUrl: listUrl,
                previousListUrl: stateForTargets.lastPickedListUrl,
                listUrl: pickedListUrl,
                publisher: pagePick.publisher,
                urlKey: pagePick.urlKey,
                detectedMaxPage
              });
              stateForTargets.lastPickedListUrl = pickedListUrl;
              await saveWatcherStateSafe(stateForTargets);
              await incrementDaily('checked', trigger);
              parsed = await parseListUrl(pickedListUrl);
              if (parsed.cfChallenge) {
                await recordCfChallenge(opts, pickedListUrl, trigger);
                return finish({ ok: false, reason: 'cf_challenge' });
              }
              await initCurrentPageData(pickedListUrl, pagePick, parsed);
            }
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
            if (isSequentialPageScan) {
              if (pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
                stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
                stateForTargets.lastVisitedPages[pagePick.urlKey] = Number(pagePick.pickedPage);
                await saveWatcherStateSafe(stateForTargets);
                await appendWatcherTrace('list_scan_page_progress_saved', {
                  reason: 'sequential_page_exhausted_source_gate',
                  trigger,
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
              sequentialPageScanCount += 1;
              continue;
            }
            break;
          }
          await resetCfChallengeStreak();

          const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets, opts, targetSessionSize);
          const handledBeforePage = handledCount;
          await appendWatcherTrace('list_scan_candidates', {
            reason: 'ordered_candidates',
            trigger,
            listUrl: pickedListUrl,
            parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            orderedCount: candidates.length
          });

          let blacklistedIds = [];
          if (opts.watcherEnableBlacklist) {
            try {
              const res = await depsRef.sendNativeMessage(opts.nativeHostName, {
                action: 'read_text_file',
                path: opts.watcherBlacklistPath || ''
              });
              if (res && res.ok && res.body) {
                const lines = res.body.split(/\r?\n/);
                for (let line of lines) {
                  line = line.trim();
                  if (!line || line.startsWith('#') || line.startsWith('//')) {
                    continue;
                  }
                  const commentIdx = line.indexOf('#') >= 0 ? line.indexOf('#') : (line.indexOf('//') >= 0 ? line.indexOf('//') : -1);
                  if (commentIdx >= 0) {
                    line = line.substring(0, commentIdx).trim();
                  }
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
          }

          for (const rawCandidate of candidates) {
            const candidate = enrichCandidateJournalFromMap(rawCandidate, stateForTargets);
            if (handledCount >= targetSessionSize) return finish({ ok: true, reason: 'session_target_reached' });
            const listAllowed = isListCandidateAllowed(candidate, opts, stateForTargets);
            if (!listAllowed.ok) {
              const candidateKey = getProcessedKey(candidate);
              await appendWatcherTrace('candidate_skip_list_filter', {
                reason: listAllowed.reason,
                reasonText: describeWatcherReason(listAllowed.reason),
                trigger,
                detailUrl: candidate.detailUrl,
                assistId: candidate.assistId || '',
                title: candidate.title || '',
                journalShortName: candidate.journalShortName || '',
                journalAccess: listAllowed.journalAccess || null
              });
              if (candidateKey && listAllowed.reason === 'not_waiting') {
                await updateProcessed(candidateKey, 'skipped', listAllowed.reason);
              }
              if (listAllowed.reason === 'journal_blocked_rule') {
                await appendWatcherLog({
                  ...candidate,
                  trigger,
                  status: 'skipped',
                  reason: listAllowed.reason,
                  page: pagePick.pickedPage,
                  journalShortName: listAllowed.journalAccess?.shortName || candidate.journalShortName || ''
                });
              }
              await updateCurrentPageCandidateStatus(candidate.assistId, 'skipped', listAllowed.reason);
              continue;
            }
            if (await wasRecentlyProcessed(candidate)) {
              await appendWatcherTrace('candidate_skip_processed', {
                reason: 'processed_before',
                trigger,
                detailUrl: candidate.detailUrl,
                assistId: candidate.assistId || ''
              });
              await updateCurrentPageCandidateStatus(candidate.assistId, 'skipped', 'processed_before');
              continue;
            }

            await appendWatcherTrace('candidate_detail_start', {
              reason: 'candidate_passed_list_filter',
              trigger,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || '',
              title: candidate.title || ''
            });
            await updateCurrentPageCandidateStatus(candidate.assistId, 'processing', '检查详情页...');
            const detail = await inspectDetail(candidate);
            if (!detail.ok) {
              await closeTabQuietly(detail.tabId, 'detail_extract_failed');
              if (/502 Bad Gateway|科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|没有找到 csrf-token|504 Gateway Time|500 Internal Server/i.test(detail.reason)) {
                await appendWatcherLog({
                  type: 'warning',
                  message: `🔄 ⚠️ 无法提取详情：科研通网站返回服务错误 (${detail.reason})，值守已暂停并等待下一次轮询。`
                });
                return finish({ ok: false, reason: 'site_error' });
              }
              await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
              await incrementDaily('failed', trigger);
              await appendWatcherLog({ ...candidate, trigger, status: 'failed', reason: detail.reason, page: pagePick.pickedPage });
              continue;
            }

            const payload = detail.payload;
            payload.journalShortName = payload.journalShortName || candidate.journalShortName || '';
            payload.page = pagePick.pickedPage;
            const detailAllowed = isDetailAllowedForWatcher(payload, opts, blacklistedIds);
            const key = getProcessedKey(candidate, payload);
            if (!detailAllowed.ok) {
              await appendWatcherTrace('candidate_skip_detail_filter', { reason: detailAllowed.reason, reasonText: describeWatcherReason(detailAllowed.reason), trigger, detailUrl: candidate.detailUrl, tabId: detail.tabId, assistId: key });
              await closeTabQuietly(detail.tabId, 'detail_filter_skipped');
              await updateProcessed(key, 'skipped', detailAllowed.reason);
              await incrementDaily('skipped', trigger);
              await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger, status: 'skipped', reason: detailAllowed.reason, page: pagePick.pickedPage });
              continue;
            }

            const handledResult = await handleAllowedPayload(candidate, payload, opts, detail.tabId, null, trigger);
            const handled = typeof handledResult === 'object' ? handledResult.handled === true : handledResult === true;
            if (!handled) await closeTabQuietly(detail.tabId, 'candidate_not_handled');
            if (handled) {
              handledCount += 1;
              await appendWatcherTrace('candidate_handled', {
                reason: handledResult?.reason || 'handled',
                trigger,
                detailUrl: candidate.detailUrl,
                tabId: detail.tabId,
                assistId: key,
                handledCount,
                targetSessionSize,
                stopRun: handledResult?.stopRun === true,
                paused: handledResult?.paused === true
              });
              if (handledResult?.stopRun === true) {
                return finish({ ok: false, reason: handledResult.reason || 'upload_failed_stop_run' });
              }
              if (handledCount >= targetSessionSize || depsRef.hasActiveTask()) {
                return finish({ ok: true, reason: handledCount > 1 ? 'session_candidates_handled' : 'candidate_handled' });
              }
            }
          }
          if (isSequentialPageScan && handledCount === handledBeforePage) {
            if (pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
              stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
              stateForTargets.lastVisitedPages[pagePick.urlKey] = Number(pagePick.pickedPage);
              await saveWatcherStateSafe(stateForTargets);
              await appendWatcherTrace('list_scan_page_progress_saved', {
                reason: 'sequential_page_exhausted_no_handled_candidate',
                trigger,
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
            sequentialPageScanCount += 1;
            if (sequentialPageScanCount < maxSequentialPageScans) {
              await appendWatcherTrace('list_scan_continue_next_page', {
                reason: 'sequential_page_no_handled_candidate',
                trigger,
                listUrl: pickedListUrl,
                configuredUrl: listUrl,
                publisher: pagePick.publisher,
                pageOrder: pagePick.pageOrder,
                urlKey: pagePick.urlKey,
                pickedPage: pagePick.pickedPage,
                nextScanIndex: sequentialPageScanCount + 1,
                maxSequentialPageScans
              });
              continue;
            }
          }
          break;
          }
        }

        return finish({ ok: true, reason: handledCount ? 'session_candidates_handled' : 'no_candidate' });
      } catch (err) {
        await appendWatcherTrace('run_error', { reason: err?.message || String(err), trigger });
        await incrementDaily('failed', trigger);
        await appendWatcherLog({ trigger, status: 'failed', reason: err?.message || String(err), page: typeof pagePick !== 'undefined' ? pagePick?.pickedPage : '' });
        return finish({ ok: false, reason: err?.message || String(err) });
      } finally {
        await appendWatcherTrace('run_finish', { reason: 'finally', trigger });
        await recordRunFinish(trigger, runResult || { ok: false, reason: 'unknown' }).catch(() => {});
        if (trigger !== 'manual' && currentRunOpts) {
          await scheduleNextAssistAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, trigger).catch(() => {});
          await refreshAlarmAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, attempt, trigger).catch(() => {});
        }
        await restoreManualScheduleSnapshot().catch(() => {});
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
