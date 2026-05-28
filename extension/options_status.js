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

    function updatePillFromCookie(cookie, elementId) {
      const cookieEl = el(elementId);
      if (!cookieEl) return;

      if (cookie) {
        const expiryMs = cookie.expirationDate ? cookie.expirationDate * 1000 : 0;
        if (expiryMs > 0) {
          const remainingMs = expiryMs - Date.now();
          if (remainingMs > 0) {
            const remainingMinutes = Math.floor(remainingMs / 60000);
            const expiryDate = new Date(expiryMs);
            const expiryTimeStr = expiryDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            cookieEl.textContent = `剩 ${remainingMinutes} 分钟 (${expiryTimeStr})`;
            cookieEl.title = `域: ${cookie.domain}\n失效时间: ${expiryDate.toLocaleString('zh-CN')}`;
            cookieEl.className = 'pill ok';
          } else {
            cookieEl.textContent = '已失效 (需验证)';
            cookieEl.className = 'pill error';
          }
        } else {
          cookieEl.textContent = '会话有效';
          cookieEl.className = 'pill ok';
        }
      } else {
        cookieEl.textContent = '未检测到 (需验证)';
        cookieEl.className = 'pill error';
      }
    }

    async function updateCfCookieCountdown() {
      if (!chromeApi.cookies) {
        const elsevierEl = el('watcherElsevierCookieStatus');
        if (elsevierEl) {
          elsevierEl.textContent = '无权限';
          elsevierEl.className = 'pill error';
        }
        const sdEl = el('watcherSdCookieStatus');
        if (sdEl) {
          sdEl.textContent = '无权限';
          sdEl.className = 'pill error';
        }
        return;
      }

      try {
        const cookies = await chromeApi.cookies.getAll({ name: 'cf_clearance' });

        let elsevierCookie = null;
        let sdCookie = null;

        for (const c of cookies) {
          const dom = String(c.domain || '').toLowerCase();
          if (dom.includes('elsevier.com')) {
            elsevierCookie = c;
          } else if (dom.includes('sciencedirect.com')) {
            sdCookie = c;
          }
        }

        updatePillFromCookie(elsevierCookie, 'watcherElsevierCookieStatus');
        updatePillFromCookie(sdCookie, 'watcherSdCookieStatus');
      } catch (err) {
        console.warn('[Ablesci PDF Watcher] Failed to query cf_clearance cookies:', err);
      }
    }

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
      await updateCfCookieCountdown();
    }

    function renderAdvancedWatcherCountdowns() {
      if (!advancedStatusCache) return;
      const state = advancedStatusCache.state || {};
      const schedule = advancedStatusCache.schedule || nextDisplaySchedule(state);
      setText('watcherAssistCountdown', countdownText(schedule.assistCountdownAt));
      updateCfCookieCountdown().catch(() => {});
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
