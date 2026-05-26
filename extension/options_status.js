'use strict';

(function () {
  function createOptionsStatusApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      autoWatcherStateKey,
      normalizeWorkdays,
      normalizeWorkWindows,
      isInWorkSchedule,
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
        'watcherWorkdays',
        'watcherWorkWindows',
        'watcherEnabled',
        'watcherDailyLimit'
      ]);
      const state = stored[autoWatcherStateKey] || {};
      const daily = state.daily?.[todayKeyBeijing()] || {};
      const downloaded = Math.max(0, Number(daily.downloaded || 0));
      const todayTarget = Math.max(0, Number(state.todayTarget || 0));
      const dailyLimit = Math.max(0, Number(stored.watcherDailyLimit || defaultOptions.watcherDailyLimit || 0));
      const assistCap = dailyLimit > 0 && todayTarget > 0
        ? Math.min(dailyLimit, todayTarget)
        : Math.max(dailyLimit, todayTarget);
      const workdays = normalizeWorkdays(stored.watcherWorkdays || defaultOptions.watcherWorkdays);
      const workWindows = normalizeWorkWindows(stored.watcherWorkWindows || defaultOptions.watcherWorkWindows);
      const pausedUntilMs = state.riskPausedUntil ? new Date(state.riskPausedUntil).getTime() : 0;
      const workStatus = stored.watcherEnabled !== true
        ? '已关闭'
        : (Number.isFinite(pausedUntilMs) && pausedUntilMs > Date.now()
          ? `风险暂停至 ${formatBeijingDateTime(state.riskPausedUntil)}`
          : ((state.currentSchedulerMode === 'fixed' || isInWorkSchedule(workdays, workWindows)) ? '工作时段内' : '非工作时段'));
      const schedule = nextDisplaySchedule(state);
      advancedStatusCache = { state, schedule };
      setText('watcherWorkStatus', workStatus);
      setText('advancedWorkProgress', `${Math.round(Number(state.workTimeProgressRatio || 0) * 100)}%`);
      setText('advancedActiveProgress', `${Math.round(Number(state.activeTimeProgressRatio || state.workTimeProgressRatio || 0) * 100)}%`);
      setText('advancedAvailability', `${Math.round(Number(state.availabilityFactor || 1) * 100)}%`);
      setText('advancedExpectedActual', `${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.expectedDone || 0)}`);
      
      let syncText = '-';
      if (Number.isFinite(state.actualTotalAssists)) {
        const syncTime = state.lastAssistCountSyncedAt ? formatBeijingDateTime(state.lastAssistCountSyncedAt).slice(6) : '-';
        syncText = `${state.actualTotalAssists} (同步: ${syncTime})`;
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
      setText('watcherWakeCountdown', formatBeijingDateTime(schedule.nextAssistAt));
      setText('watcherRunCounts', assistCap > 0 ? `${downloaded} / ${assistCap}` : String(downloaded));
      setText('watcherSavedWorkdays', String(stored.watcherWorkdays || defaultOptions.watcherWorkdays));
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
