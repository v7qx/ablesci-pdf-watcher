'use strict';

(function () {
  function createOptionsStatusApi(deps = {}) {
    const {
      chromeApi,
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
    let lastAutoTriggerTime = 0;

    function formatCurrentListScan(scan = {}) {
      if (!scan || typeof scan !== 'object') return '';
      const publisher = scan.publisher ? String(scan.publisher).toUpperCase() : '';
      const page = scan.page ? `第 ${scan.page} 页` : '';
      const phaseMap = {
        start: '启动',
        source_selected: '选源',
        page_selected: '选页',
        parsing_list: '解析列表',
        filtering_candidates: '筛候选',
        trying_candidate: '打开详情',
        downloading: '下载/上传',
        finalizing: '写报告',
        done: '已完成'
      };
      const phase = phaseMap[scan.phase] || '';
      const counts = scan.queueableCount !== '' && scan.queueableCount != null
        ? `可处理 ${scan.queueableCount}/${scan.candidateCount || '?'}`
        : '';
      const assist = scan.assistId ? `ID ${scan.assistId}` : '';
      const result = scan.status && scan.status !== 'running' && scan.reason ? String(scan.reason) : '';
      return [phase, publisher, page, counts, assist, result].filter(Boolean).join(' ');
    }

    async function renderAdvancedWatcherStatus() {
      const stored = await chromeApi.storage.local.get([
        autoWatcherStateKey,
        'watcherEnabled',
        'watcherLanguage'
      ]);
      const lang = stored.watcherLanguage || 'auto';
      if (typeof globalThis.getActualLanguage === 'function') {
        globalThis.watcherActiveLanguage = globalThis.getActualLanguage(lang);
      }
      const state = stored[autoWatcherStateKey] || {};
      const isEnabled = stored.watcherEnabled !== false;
      const daily = state.daily?.[todayKeyBeijing()] || {};
      const downloaded = Math.max(0, Number(daily.downloaded || 0));
      const schedule = nextDisplaySchedule(state);
      advancedStatusCache = { state, schedule, isEnabled };
      setText('advancedExpectedActual', `${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.expectedDone || 0)}`);
      
      let syncText = '-';
      if (Number.isFinite(state.actualTotalAssists)) {
        syncText = String(state.actualTotalAssists);
      }
      setText('watcherWebTotalAssists', syncText);

      setText('advancedError', String(Number(state.targetError || state.lag || 0)));
      setText('advancedRiskBudget', `${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`);
      setText('advancedSessionStatus', formatCurrentListScan(state.currentListScan) || state.currentSession?.status || state.lastSession?.status || '-');
      
      setText('watcherNextRunAt', isEnabled ? formatBeijingDateTime(schedule.nextRunAt) : '值守已关闭');
      setText('watcherAssistCountdown', isEnabled ? countdownText(schedule.assistCountdownAt) : '已停止');
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

      const text = countdownText(schedule.assistCountdownAt);
      setText('watcherAssistCountdown', text);

      // 当值守开启、倒计时到点、后台没有在运行，并且过了冷却期时，主动向后台发送强制 alarm 触发，以消除 chrome.alarms 定时延迟
      if (isEnabled && !state.autoWatcherRunning) {
        const date = schedule.assistCountdownAt ? new Date(schedule.assistCountdownAt) : null;
        if (date && !Number.isNaN(date.getTime())) {
          const seconds = Math.round((date.getTime() - Date.now()) / 1000);
          if (seconds <= 0 && (Date.now() - lastAutoTriggerTime > 15000)) {
            lastAutoTriggerTime = Date.now();
            chromeApi.runtime.sendMessage({ type: 'ablesciRunAutoWatcherNow', trigger: 'alarm' })
              .catch(err => console.warn('[Ablesci PDF Watcher] Failed to auto-trigger watcher on due:', err));
          }
        }
      }
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
