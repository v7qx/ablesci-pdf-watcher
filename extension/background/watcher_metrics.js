'use strict';

(function () {
  function createBackgroundWatcherMetricsApi(config) {
    const {
      chromeApi,
      autoWatcherStateKey
    } = config;

    function todayKeyBeijingForMetrics() {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date()).reduce((acc, item) => {
        acc[item.type] = item.value;
        return acc;
      }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    }

    async function getAutoWatcherStateForMetrics() {
      const stored = await chromeApi.storage.local.get(autoWatcherStateKey);
      const state = stored[autoWatcherStateKey] && typeof stored[autoWatcherStateKey] === 'object'
        ? stored[autoWatcherStateKey]
        : { processed: {}, daily: {} };
      if (!Number.isFinite(Number(state._version))) state._version = 0;
      return state;
    }

    async function updateAutoWatcherStateForMetrics(mutator) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await getAutoWatcherStateForMetrics();
        const baseVersion = Number(state._version || 0);
        await mutator(state);
        state._version = baseVersion + 1;
        await chromeApi.storage.local.set({ [autoWatcherStateKey]: state });
        const latest = await getAutoWatcherStateForMetrics();
        if (Number(latest._version || 0) === baseVersion + 1) return latest;
      }
      const state = await getAutoWatcherStateForMetrics();
      await mutator(state);
      state._version = Number(state._version || 0) + 1;
      await chromeApi.storage.local.set({ [autoWatcherStateKey]: state });
      return state;
    }

    async function recordManualWatcherDaily(field) {
      const key = todayKeyBeijingForMetrics();
      await updateAutoWatcherStateForMetrics(state => {
        state.daily = state.daily || {};
        const daily = state.daily[key] || {};
        state.daily[key] = daily;
        daily.checked = Number(daily.checked || 0);
        daily.downloaded = Number(daily.downloaded || 0);
        daily.downloadedAuto = Number(daily.downloadedAuto || 0);
        daily.downloadedManual = Number(daily.downloadedManual || 0);
        daily.uploaded = Number(daily.uploaded || 0);
        daily.skipped = Number(daily.skipped || 0);
        daily.failed = Number(daily.failed || 0);
        daily.notified = Number(daily.notified || 0);
        daily[field] = Number(daily[field] || 0) + 1;
        if (field === 'downloaded') {
          daily.downloadedManual = Number(daily.downloadedManual || 0) + 1;
        }
        if (field === 'uploaded') {
          state.monthDone = Number(state.monthDone || 0) + 1;
          state.actualDone = Number(state.actualDone || 0) + 1;
          const previousTargetError = Number(state.targetError || state.lag || 0);
          const previousLag = Number(state.lag || state.targetError || 0);
          state.targetError = previousTargetError - 1;
          state.lag = previousLag - 1;
          if (Number.isFinite(Number(state.actualTotalAssists))) {
            state.actualTotalAssists = Number(state.actualTotalAssists) + 1;
          }
        }
        state.lastManualAssistMetricAt = new Date().toISOString();
      });
    }

    return {
      recordManualWatcherDaily
    };
  }

  globalThis.AblesciBackgroundWatcherMetrics = {
    createBackgroundWatcherMetricsApi
  };
}());
