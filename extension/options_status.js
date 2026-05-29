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
      setText,
      el
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
      const isEnabled = stored.watcherEnabled !== false;
      const daily = state.daily?.[todayKeyBeijing()] || {};
      const downloaded = Math.max(0, Number(daily.downloaded || 0));
      const dailyLimit = Math.max(0, Number(stored.watcherDailyLimit || defaultOptions.watcherDailyLimit || 0));
      const schedule = nextDisplaySchedule(state);
      advancedStatusCache = { state, schedule, isEnabled };
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
      
      const runtimeLogicStr = `${state.currentSchedulerMode || '-'} / ${state.currentExecutionModel || '-'}`;
      setText('watcherRuntimeLogic', isEnabled ? runtimeLogicStr : `${runtimeLogicStr} (值守已关闭)`);
      
      setText('watcherNextRunAt', isEnabled ? formatBeijingDateTime(schedule.nextRunAt) : '值守已关闭');
      setText('watcherNextAssistAt', isEnabled ? formatBeijingDateTime(schedule.nextAssistAt) : '值守已关闭');
      setText('watcherAssistCountdown', isEnabled ? countdownText(schedule.assistCountdownAt) : '已停止');
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
      const isEnabled = advancedStatusCache.isEnabled !== false;
      if (!isEnabled) {
        setText('watcherAssistCountdown', '已停止');
        return;
      }
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
