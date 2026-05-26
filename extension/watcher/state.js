'use strict';

(function () {
  function createWatcherStateApi(config) {
    const {
      chromeApi,
      stateKey,
      todayKey,
      normalizeText,
      normalizeSchedulerMode,
      activeRunRetentionDays,
      appendWatcherTrace,
      updateActionBadge
    } = config;

    async function getWatcherState() {
      const stored = await chromeApi.storage.local.get(stateKey);
      const state = stored[stateKey] || { processed: {}, daily: {} };
      if (!state || typeof state !== 'object') return { processed: {}, daily: {}, _version: 0 };
      if (!Number.isFinite(Number(state._version))) state._version = 0;
      return state;
    }

    async function saveWatcherState(state) {
      const incoming = state && typeof state === 'object' ? state : { processed: {}, daily: {} };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await getWatcherState();
        const currentVersion = Number(current._version || 0);
        const base = { ...current, ...incoming };
        const next = {
          ...base,
          processed: { ...(current.processed || {}), ...(incoming.processed || {}) },
          daily: { ...(current.daily || {}), ...(incoming.daily || {}) },
          _version: currentVersion + 1
        };
        await chromeApi.storage.local.set({ [stateKey]: next });
        const verify = await getWatcherState();
        if (Number(verify._version || 0) === currentVersion + 1) {
          Object.assign(incoming, next);
          return next;
        }
      }
      const current = await getWatcherState();
      const next = {
        ...current,
        ...incoming,
        processed: { ...(current.processed || {}), ...(incoming.processed || {}) },
        daily: { ...(current.daily || {}), ...(incoming.daily || {}) },
        _version: Number(current._version || 0) + 1
      };
      await chromeApi.storage.local.set({ [stateKey]: next });
      Object.assign(incoming, next);
      return next;
    }

    async function updateWatcherState(mutator) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await getWatcherState();
        const baseVersion = Number(state._version || 0);
        const next = { ...state };
        await mutator(next);
        next._version = baseVersion;
        await saveWatcherState(next);
        const latest = await getWatcherState();
        if (Number(latest._version || 0) > baseVersion) return latest;
      }
      const state = await getWatcherState();
      await mutator(state);
      return await saveWatcherState(state);
    }

    async function updateProcessed(key, status, reason) {
      if (!key) return;
      await updateWatcherState(state => {
        state.processed = state.processed || {};
        state.processed[key] = {
          lastAt: new Date().toISOString(),
          status,
          reason: normalizeText(reason).slice(0, 160)
        };
      });
    }

    async function incrementDaily(field) {
      await updateWatcherState(state => {
        const key = todayKey();
        state.daily = state.daily || {};
        state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
        state.daily[key][field] = Number(state.daily[key][field] || 0) + 1;
        if (field === 'downloaded') {
          state.recentDownloads = state.recentDownloads || [];
          state.recentDownloads.push(Date.now());
          const cutOff = Date.now() - 30 * 60 * 1000;
          state.recentDownloads = state.recentDownloads.filter(t => t >= cutOff);
          if (Number.isFinite(state.actualTotalAssists)) {
            state.actualTotalAssists += 1;
          }
        }
      });
    }

    function triggerMetricKey(trigger) {
      if (trigger === 'alarm') return 'autoRuns';
      if (trigger === 'manual-observe') return 'manualObserveRuns';
      return 'manualRuns';
    }

    async function recordRunStart(trigger, opts) {
      return await updateWatcherState(state => {
        const key = todayKey();
        const now = new Date().toISOString();
        state.daily = state.daily || {};
        state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
        const daily = state.daily[key];
        daily.totalRuns = Number(daily.totalRuns || 0) + 1;
        daily[triggerMetricKey(trigger)] = Number(daily[triggerMetricKey(trigger)] || 0) + 1;
        state.runStats = state.runStats || {};
        state.runStats.totalRuns = Number(state.runStats.totalRuns || 0) + 1;
        state.runStats[triggerMetricKey(trigger)] = Number(state.runStats[triggerMetricKey(trigger)] || 0) + 1;
        state.lastRunStartedAt = now;
        state.lastRunTrigger = trigger;
        state.currentSchedulerMode = opts.watcherSchedulerMode || normalizeSchedulerMode(opts);
        state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : (opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval');
        state.activeRunDays = state.activeRunDays || {};
        state.activeRunDays[key] = Number(state.activeRunDays[key] || 0) + 1;
        const keepAfter = Date.now() - activeRunRetentionDays * 24 * 60 * 60 * 1000;
        for (const dayKey of Object.keys(state.activeRunDays)) {
          const t = new Date(`${dayKey}T00:00:00+08:00`).getTime();
          if (!Number.isFinite(t) || t < keepAfter) delete state.activeRunDays[dayKey];
        }
      });
    }

    async function recordRunFinish(trigger, result) {
      const state = await getWatcherState();
      state.lastRunFinishedAt = new Date().toISOString();
      state.lastRunTrigger = trigger;
      state.lastRunResult = {
        ok: result?.ok === true,
        reason: normalizeText(result?.reason || '').slice(0, 160)
      };
      await saveWatcherState(state);
    }

    function dailyCounterSnapshot(state) {
      const item = state?.daily?.[todayKey()] || {};
      return {
        checked: Number(item.checked || 0),
        downloaded: Number(item.downloaded || 0),
        failed: Number(item.failed || 0),
        skipped: Number(item.skipped || 0)
      };
    }

    async function recordAttemptFinish(attempt, result) {
      const state = await getWatcherState();
      const counters = dailyCounterSnapshot(state);
      const finished = {
        ...attempt,
        finishedAt: new Date().toISOString(),
        resultReason: normalizeText(result?.reason || 'unknown').slice(0, 160),
        nextAssistAfter: state.nextAssistRunAt || '',
        nextAlarmAfter: state.nextScheduledAt || '',
        chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
        checkedAfter: counters.checked,
        downloadedAfter: counters.downloaded,
        failedAfter: counters.failed,
        skippedAfter: counters.skipped
      };
      finished.checkedDelta = Number(finished.checkedAfter || 0) - Number(finished.checkedBefore || 0);
      finished.downloadedDelta = Number(finished.downloadedAfter || 0) - Number(finished.downloadedBefore || 0);
      finished.failedDelta = Number(finished.failedAfter || 0) - Number(finished.failedBefore || 0);
      finished.skippedDelta = Number(finished.skippedAfter || 0) - Number(finished.skippedBefore || 0);
      state.lastAttempt = finished;
      await saveWatcherState(state);
      updateActionBadge(state).catch(() => {});
      await appendWatcherTrace('run_attempt_summary', {
        reason: finished.resultReason,
        trigger: finished.trigger,
        observeSnapshot: finished.observeSnapshot,
        targetSessionSize: finished.targetSessionSize,
        checkedDelta: finished.checkedDelta,
        downloadedDelta: finished.downloadedDelta,
        listScanStarted: finished.listScanStarted,
        pickedListUrl: finished.pickedListUrl,
        pickedPage: finished.pickedPage,
        pageCurve: finished.pageCurve,
        nextAssistBefore: finished.nextAssistBefore,
        nextAssistAfter: finished.nextAssistAfter,
        nextAlarmAfter: finished.nextAlarmAfter
      });
    }

    async function getDailyCount(field) {
      const state = await getWatcherState();
      const item = state.daily?.[todayKey()] || {};
      return Number(item[field] || 0);
    }

    return {
      getWatcherState,
      saveWatcherState,
      updateWatcherState,
      updateProcessed,
      incrementDaily,
      triggerMetricKey,
      recordRunStart,
      recordRunFinish,
      recordAttemptFinish,
      getDailyCount,
      dailyCounterSnapshot
    };
  }

  globalThis.AblesciWatcherStateModule = {
    createWatcherStateApi
  };
})();
