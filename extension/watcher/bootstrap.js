'use strict';

// Responsibility: small watcher bootstrap helpers and stale-state recovery.
(function () {
  function createWatcherBootstrapApi(config) {
    const {
      getWatcherState,
      saveWatcherState,
      appendWatcherTrace,
      updateActionBadge,
      nextWorkDelayMinutes
    } = config;

    function getProcessedKey(candidate, payload) {
      return payload?.assistId || candidate?.assistId || candidate?.detailUrl || '';
    }

    async function wasRecentlyProcessed(candidate) {
      const key = getProcessedKey(candidate);
      if (!key) return false;
      const state = await getWatcherState();
      const item = state.processed?.[key];
      if (!item) return false;
      if (item.status === 'skipped' && /^(reported|rejected|supplement|book_chapter|patent_report|risk_text)$/.test(String(item.reason || ''))) {
        return false;
      }
      return true;
    }

    async function sleepMinutes(minutes) {
      if (minutes <= 0) return;
      await new Promise(resolve => setTimeout(resolve, minutes * 60 * 1000));
    }

    function nextRiskResumeAt(opts) {
      const delay = nextWorkDelayMinutes(opts);
      const minutes = delay === null ? 60 : Math.max(15, delay);
      return new Date(Date.now() + minutes * 60 * 1000).toISOString();
    }

    async function recoverStaleWatcherState(reason = 'startup_recovery') {
      try {
        const state = await getWatcherState();
        const session = state.currentSession || null;
        const activeStatuses = new Set(['planning', 'running']);
        let changed = false;
        if (session && activeStatuses.has(String(session.status || ''))) {
          const recovered = {
            ...session,
            status: 'recovered_cancelled',
            finishedAt: new Date().toISOString(),
            recoveryReason: reason
          };
          state.lastSession = recovered;
          state.currentSession = recovered;
          changed = true;
        }
        if (state.lastRunStartedAt && !state.lastRunFinishedAt) {
          state.lastRunFinishedAt = new Date().toISOString();
          state.lastRunResult = { ok: false, reason: 'recovered_cancelled' };
          changed = true;
        }
        if (!changed) return;
        await saveWatcherState(state);
        await appendWatcherTrace('watcher_state_recovered', {
          reason,
          sessionId: state.currentSession?.id || '',
          status: state.currentSession?.status || ''
        });
        updateActionBadge(state).catch(() => {});
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] recovery failed', err);
      }
    }

    return {
      getProcessedKey,
      wasRecentlyProcessed,
      sleepMinutes,
      nextRiskResumeAt,
      recoverStaleWatcherState
    };
  }

  globalThis.AblesciWatcherBootstrapModule = {
    createWatcherBootstrapApi
  };
}());
