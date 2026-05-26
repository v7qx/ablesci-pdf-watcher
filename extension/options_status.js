'use strict';

(function () {
  function createOptionsStatusApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      autoWatcherStateKey,
      formatBeijingDateTime,
      countdownText,
      nextDisplaySchedule,
      todayKeyBeijing,
      setText
    } = deps;

    let advancedStatusCache = null;
    let advancedCountdownTimer = null;

    async function renderAdvancedWatcherStatus() {
      const stored = await chromeApi.storage.local.get([
        autoWatcherStateKey,
        'watcherEnabled',
        'watcherDailyLimit'
      ]);
      const state = stored[autoWatcherStateKey] || {};
      const daily = state.daily?.[todayKeyBeijing()] || {};
      const downloaded = Math.max(0, Number(daily.downloaded || 0));
      const dailyLimit = Math.max(0, Number(stored.watcherDailyLimit || defaultOptions.watcherDailyLimit || 0));
      const schedule = nextDisplaySchedule(state);
      advancedStatusCache = { state, schedule };
      setText('advancedWorkProgress', `${Math.round(Number(state.workTimeProgressRatio || 0) * 100)}%`);
      setText('advancedActiveProgress', `${Math.round(Number(state.activeTimeProgressRatio || state.workTimeProgressRatio || 0) * 100)}%`);
      setText('advancedAvailability', `${Math.round(Number(state.availabilityFactor || 1) * 100)}%`);
      setText('advancedExpectedActual', `${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.expectedDone || 0)}`);
      
      let syncText = '-';
      if (Number.isFinite(state.actualTotalAssists)) {
        syncText = String(state.actualTotalAssists);
      }
      setText('watcherWebTotalAssists', syncText);

      setText('advancedError', String(Number(state.targetError || state.lag || 0)));
      setText('advancedRateMultiplier', Number(state.rateMultiplier || 1).toFixed(3));
      setText('advancedRiskBudget', `${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`);
      setText('advancedSessionStatus', state.currentSession?.status || state.lastSession?.status || '-');
      setText('watcherRuntimeLogic', `${state.currentSchedulerMode || '-'} / ${state.currentExecutionModel || '-'}`);
      setText('watcherNextRunAt', formatBeijingDateTime(schedule.nextRunAt));
      setText('watcherNextAssistAt', formatBeijingDateTime(schedule.nextAssistAt));
      setText('watcherAssistCountdown', countdownText(schedule.assistCountdownAt));
      setText('watcherWakeCountdown', dailyLimit > 0 ? String(dailyLimit) : '-');
      const downloadedAuto = Math.max(0, Number(daily.downloadedAuto || 0));
      let downloadedManual = Math.max(0, Number(daily.downloadedManual || 0));
      if (downloaded > 0 && downloadedAuto === 0 && downloadedManual === 0) {
        downloadedManual = downloaded;
      }
      setText('watcherRunCounts', `自动: ${downloadedAuto} / 手动: ${downloadedManual}`);
    }

    function renderAdvancedWatcherCountdowns() {
      if (!advancedStatusCache) return;
      const state = advancedStatusCache.state || {};
      const schedule = advancedStatusCache.schedule || nextDisplaySchedule(state);
      setText('watcherAssistCountdown', countdownText(schedule.assistCountdownAt));
    }

    function startAdvancedCountdownTimer() {
      if (advancedCountdownTimer || document.hidden) return;
      advancedCountdownTimer = setInterval(renderAdvancedWatcherCountdowns, 1000);
    }

    function stopAdvancedCountdownTimer() {
      if (!advancedCountdownTimer) return;
      clearInterval(advancedCountdownTimer);
      advancedCountdownTimer = null;
    }

    return {
      renderAdvancedWatcherStatus,
      renderAdvancedWatcherCountdowns,
      startAdvancedCountdownTimer,
      stopAdvancedCountdownTimer
    };
  }

  globalThis.AblesciOptionsStatus = {
    createOptionsStatusApi
  };
})();
