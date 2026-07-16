'use strict';

// Responsibility: register Chrome listeners and expose watcher init entry.
(function () {
  const publisherLimits = globalThis.AblesciWatcherPublisherLimits;

  function createWatcherEntryApi(config) {
    const {
      chromeApi,
      depsRef,
      setDeps,
      alarmName,
      autoWatcherStateKey,
      autoWatcherLogKey,
      autoWatcherTraceKey,
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
      randomIntervalMinutes
    } = config;
    const parallelAlarmNames = {
      elsevier: `${alarmName}:elsevier`,
      secondary1: `${alarmName}:secondary1`,
      secondary2: `${alarmName}:secondary2`
    };
    let parallelScanChain = Promise.resolve();

    function publisherFromListUrl(url) {
      try {
        return String(new URL(url).searchParams.get('publisher') || '').trim().toLowerCase();
      } catch (_) {
        return '';
      }
    }

    function configuredPublishers(opts = {}) {
      const urls = Array.isArray(opts.watcherListUrls) ? opts.watcherListUrls : [];
      const raw = urls
        .map(url => ({ url, publisher: publisherFromListUrl(url) }))
        .filter(item => item.publisher);
      return Array.from(new Map(raw.map(item => [item.publisher, item])).values());
    }

    async function clearParallelAlarms() {
      await Promise.all(Object.values(parallelAlarmNames).map(name => chromeApi.alarms.clear(name)));
      const state = await getWatcherState();
      delete state.parallelLaneSchedules;
      await chromeApi.storage.local.set({ [autoWatcherStateKey]: state });
    }

    async function clearParallelLane(lane) {
      const alarm = parallelAlarmNames[lane];
      if (alarm) await chromeApi.alarms.clear(alarm);
      const state = await getWatcherState();
      if (state.parallelLaneSchedules && typeof state.parallelLaneSchedules === 'object') {
        delete state.parallelLaneSchedules[lane];
        if (!Object.keys(state.parallelLaneSchedules).length) {
          delete state.parallelLaneSchedules;
          await chromeApi.storage.local.set({ [autoWatcherStateKey]: state });
        } else {
          await saveWatcherState(state);
        }
      }
    }

    async function scheduleParallelLane(lane, opts, reason = 'parallel_lane_reschedule', initialOffsetMinutes = 0) {
      const alarm = parallelAlarmNames[lane];
      if (!alarm) return;
      if (!opts?.watcherEnabled || !opts?.watcherMultiPublisherEnabled) {
        await clearParallelLane(lane);
        return;
      }
      const configured = configuredPublishers(opts);
      const hasElsevier = configured.some(item => item.publisher === 'elsevier');
      const secondaryCount = configured.filter(item => item.publisher !== 'elsevier').length;
      const laneAvailable = lane === 'elsevier'
        ? hasElsevier
        : (lane === 'secondary1' ? secondaryCount >= 1 : secondaryCount >= 2);
      if (!laneAvailable) {
        await clearParallelLane(lane);
        return;
      }
      const state = await getWatcherState();
      const resumeAt = lane === 'elsevier'
        ? Number(publisherLimits?.resumeAtForPublisher?.(state, 'elsevier', Date.now()) || 0)
        : 0;
      const delay = resumeAt > Date.now()
        ? Math.max(0.5, (resumeAt - Date.now()) / 60000 + 0.1)
        : Math.max(0.5, Number(randomIntervalMinutes(opts, state) || 1) + initialOffsetMinutes);
      const scheduleReason = resumeAt > Date.now() ? 'publisher_daily_limit_resume' : reason;
      await chromeApi.alarms.create(alarm, { delayInMinutes: delay });
      const scheduled = await chromeApi.alarms.get(alarm).catch(() => null);
      const current = await getWatcherState();
      current.parallelLaneSchedules = current.parallelLaneSchedules && typeof current.parallelLaneSchedules === 'object'
        ? current.parallelLaneSchedules
        : {};
      current.parallelLaneSchedules[lane] = {
        scheduledAt: scheduled?.scheduledTime || Date.now() + delay * 60 * 1000,
        delayMinutes: delay,
        reason: scheduleReason
      };
      await saveWatcherState(current);
      await appendWatcherTrace('parallel_lane_scheduled', { lane, reason: scheduleReason, delayMinutes: Number(delay.toFixed(2)) });
    }

    async function refreshAllWatcherAlarms(reason = 'refresh') {
      const opts = normalizeOptions(await depsRef.getOptions());
      if (!opts.watcherMultiPublisherEnabled) {
        await clearParallelAlarms();
        return refreshAutoWatcherAlarm(true, reason);
      }
      await chromeApi.alarms.clear(alarmName);
      await clearParallelAlarms();
      if (!opts.watcherEnabled) return;
      await scheduleParallelLane('elsevier', opts, reason, 0);
      await scheduleParallelLane('secondary1', opts, reason, 0.5);
      await scheduleParallelLane('secondary2', opts, reason, 1);
    }

    async function runParallelLane(lane) {
      const operation = async () => {
        const opts = normalizeOptions(await depsRef.getOptions());
        if (!opts.watcherEnabled || !opts.watcherMultiPublisherEnabled) return { ok: false, reason: 'disabled' };
        const configured = configuredPublishers(opts);
        const state = await getWatcherState();
        const paused = state.pausedPublisherLanes && typeof state.pausedPublisherLanes === 'object' ? state.pausedPublisherLanes : {};
        const dailyStopped = publisherLimits?.activePublisherStops?.(state, Date.now()) || {};
        const lastStarted = state.parallelPublisherLastStarted && typeof state.parallelPublisherLastStarted === 'object'
          ? { ...state.parallelPublisherLastStarted }
          : {};
        let selection = null;
        if (lane === 'elsevier') {
          const candidate = configured.find(item => item.publisher === 'elsevier');
          if (candidate && !paused.elsevier && !dailyStopped.elsevier && !depsRef.hasPublisherTask?.('elsevier')) selection = candidate;
        } else {
          selection = configured
            .filter(item => item.publisher !== 'elsevier' && !paused[item.publisher] && !dailyStopped[item.publisher] && !depsRef.hasPublisherTask?.(item.publisher))
            .sort((a, b) => Number(lastStarted[a.publisher] || 0) - Number(lastStarted[b.publisher] || 0))[0] || null;
        }
        let result = { ok: true, reason: 'parallel_lane_busy' };
        if (selection) {
          lastStarted[selection.publisher] = Date.now();
          const current = await getWatcherState();
          current.parallelPublisherLastStarted = lastStarted;
          await saveWatcherState(current);
          result = await runAutoWatcherOnce('alarm', {
            parallelDispatch: true,
            skipScheduleRefresh: true,
            listUrls: [selection.url],
            publisher: selection.publisher,
            lane
          });
        }
        return result;
      };
      const next = parallelScanChain.then(operation, operation);
      const rescheduled = next.finally(async () => {
        const latestOpts = normalizeOptions(await depsRef.getOptions());
        await scheduleParallelLane(lane, latestOpts, `after_${lane}_run`);
      });
      parallelScanChain = rescheduled.catch(() => {});
      return rescheduled;
    }

    async function runParallelPublisherDispatch(trigger = 'alarm') {
      const opts = normalizeOptions(await depsRef.getOptions());
      if (!opts?.watcherMultiPublisherEnabled) return runAutoWatcherOnce(trigger);
      const configured = configuredPublishers(opts);
      const initialState = await getWatcherState();
      const lastStarted = initialState.parallelPublisherLastStarted && typeof initialState.parallelPublisherLastStarted === 'object'
        ? { ...initialState.parallelPublisherLastStarted }
        : {};
      const paused = initialState.pausedPublisherLanes && typeof initialState.pausedPublisherLanes === 'object'
        ? initialState.pausedPublisherLanes
        : {};
      const dailyStopped = publisherLimits?.activePublisherStops?.(initialState, Date.now()) || {};
      const selections = [];
      const elsevier = configured.find(item => item.publisher === 'elsevier');
      if (elsevier && !paused.elsevier && !dailyStopped.elsevier && !depsRef.hasPublisherTask?.('elsevier')) selections.push(elsevier);
      const secondary = configured
        .filter(item => item.publisher !== 'elsevier' && !paused[item.publisher] && !dailyStopped[item.publisher] && !depsRef.hasPublisherTask?.(item.publisher))
        .sort((a, b) => Number(lastStarted[a.publisher] || 0) - Number(lastStarted[b.publisher] || 0))
        .slice(0, 2);
      selections.push(...secondary);

      const results = [];
      for (const selection of selections) {
        lastStarted[selection.publisher] = Date.now();
        const currentState = await getWatcherState();
        currentState.parallelPublisherLastStarted = { ...lastStarted };
        await saveWatcherState(currentState);
        results.push(await runAutoWatcherOnce(trigger, {
          parallelDispatch: true,
          skipScheduleRefresh: true,
          listUrls: [selection.url],
          publisher: selection.publisher
        }));
      }
      return { ok: true, reason: selections.length ? 'parallel_dispatch_done' : 'parallel_dispatch_busy', results };
    }

    function initAutoWatcher(nextDeps) {
      setDeps(nextDeps);
      startBadgeRefreshLoop();

      chromeApi.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === alarmName) runParallelPublisherDispatch('alarm').catch(() => {});
        const lane = Object.keys(parallelAlarmNames).find(key => parallelAlarmNames[key] === alarm.name);
        if (lane) runParallelLane(lane).catch(() => {});
      });
      // Badge no longer uses a periodic alarm (which woke the service worker every
      // minute even when idle). The badge is refreshed event-driven instead:
      // on storage changes, after each run, and by the in-memory loop while the
      // worker is alive. Clear any periodic alarm left by older installs.
      chromeApi.alarms.clear('ablesciBadgeRefresh').catch(() => {});

      chromeApi.runtime.onStartup.addListener(() => {
        recoverStaleWatcherState('runtime_startup').catch(() => {});
        getWatcherState().then(state => {
          state.lastStartupTime = Date.now();
          return saveWatcherState(state);
        }).catch(() => {});
        refreshAllWatcherAlarms('runtime_startup').catch(() => {});
      });

      chromeApi.runtime.onInstalled.addListener(() => {
        recoverStaleWatcherState('runtime_installed').catch(() => {});
        getWatcherState().then(state => {
          state.lastStartupTime = Date.now();
          return saveWatcherState(state);
        }).catch(() => {});
        refreshAllWatcherAlarms('runtime_installed').catch(() => {});
      });

      chromeApi.runtime.onSuspend.addListener(() => {
        stopBadgeRefreshLoop();
        flushWatcherLogs().catch(() => {});
        flushWatcherTrace().catch(() => {});
      });

      chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        const watcherKeys = Object.keys(changes).filter(key =>
          key.startsWith('watcher') ||
          key === autoWatcherStateKey ||
          key === 'publisherDailyLimitStops'
        );
        if (watcherKeys.length) {
          applyStorageWatcherTraceLevel(changes);
          const changedKeys = watcherKeys.slice(0, 12).join(',');
          updateActionBadge().catch(() => {});

          if (changes.watcherEnabled && changes.watcherEnabled.newValue === true) {
            // PRIVATE_WATCHER_ONLY
            getWatcherState().then(state => {
              if (state.cfChallengeStreak || state.pausedByCfChallenge || state.publisherCfChallengeStreak || state.pausedByPublisherCfChallenge ||
                  Object.keys(state.pausedPublisherLanes || {}).length) {
                state.cfChallengeStreak = 0;
                state.pausedByCfChallenge = false;
                state.publisherCfChallengeStreak = 0;
                state.pausedByPublisherCfChallenge = false;
                state.publisherCfChallengeByPublisher = {};
                state.pausedPublisherLanes = {};
                return saveWatcherState(state);
              }
            }).catch(err => console.warn('[Ablesci PDF Watcher] Failed to reset CF streak on enable:', err));
          }

          const SCHEDULE_AFFECTING_KEYS = [
            'watcherEnabled',
            'watcherMultiPublisherEnabled',
            'watcherListUrls',
            'watcherSpeedMode',
            'watcherMonthlyTarget',
            'watcherSchedulerMode',
            'watcherIntervalMinutes',
            'watcherMinIntervalMinutes',
            'watcherMaxIntervalMinutes',
            'watcherAllowZeroSession',
            'watcherDailyLimit'
          ];
          const hasScheduleChange = SCHEDULE_AFFECTING_KEYS.some(key => {
            const change = changes[key];
            if (!change) return false;
            return change.newValue !== change.oldValue;
          });

          if (hasScheduleChange) {
            const suppressUntil = Number(changes.ablesciSuppressWatcherReplanUntil?.newValue || 0);
            if (Number.isFinite(suppressUntil) && suppressUntil > Date.now()) {
              appendWatcherTrace('alarm_refresh_suppressed', {
                reason: 'manual_run_preserve_existing_schedule',
                changedKeys
              }).catch(() => {});
              return;
            }
            refreshAllWatcherAlarms(`storage_changed:${changedKeys}`).catch(() => {});
          }
        }
      });

      chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type === 'ablesciRunAutoWatcherNow') {
          const trigger = msg.trigger === 'alarm' ? 'alarm' : 'manual';
          runParallelPublisherDispatch(trigger)
            .then(sendResponse)
            .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
          return true;
        }
        if (msg?.type === 'ablesciTestWatcherNotification') {
          notifyWatcherNeedsAttention('这是一条低频值守测试提醒，不会执行检查。')
            .then(sendResponse)
            .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
          return true;
        }
        if (msg?.type === 'ablesciClearAutoWatcherState') {
          chromeApi.storage.local.get(autoWatcherStateKey)
            .then(stored => {
              const state = stored[autoWatcherStateKey] && typeof stored[autoWatcherStateKey] === 'object'
                ? stored[autoWatcherStateKey]
                : {};
              delete state.processed;
              delete state.doiFailures;
              delete state.recentProcessed;
              delete state.assistCandidateQueue;
              state._version = Number(state._version || 0) + 1;
              state.processedClearedAt = new Date().toISOString();
              return chromeApi.storage.local.set({ [autoWatcherStateKey]: state });
            })
            .then(() => sendResponse({ ok: true }));
          return true;
        }
        if (msg?.type === 'ablesciClearAutoWatcherLogs') {
          Promise.all([clearBufferedWatcherLogs(), clearBufferedWatcherTrace()])
            .then(() => chromeApi.storage.local.remove([autoWatcherLogKey, autoWatcherTraceKey, 'autoWatcherAbnormalRecords', 'autoWatcherCandidateAudit', 'autoWatcherCandidateAuditIndex']))
            .then(() => sendResponse({ ok: true }));
          return true;
        }
        return false;
      });

      recoverStaleWatcherState('init').catch(() => {});
      trimStoredWatcherTraceLogs().catch(() => {});
      refreshAllWatcherAlarms('init').catch(() => {});
    }

    return { initAutoWatcher };
  }

  globalThis.AblesciWatcherEntryModule = {
    createWatcherEntryApi
  };
})();
