'use strict';

// Responsibility: small watcher bootstrap helpers and stale-state recovery.
(function () {
  function createWatcherBootstrapApi(config) {
    const {
      getWatcherState,
      saveWatcherState,
      appendWatcherTrace,
      updateActionBadge
    } = config;

    function getProcessedKey(candidate, payload) {
      return payload?.assistId || candidate?.assistId || candidate?.detailUrl || '';
    }

    function isStaticSkipReason(reason) {
      return /^(reported|rejected|sticky_assist|list_too_fresh_assist|list_supplement|list_book_chapter|list_patent_report|list_corrigendum|list_blacklist_user|detail_reported_warning|detail_rejected_history|detail_supplement|detail_book_chapter|detail_patent_report|detail_corrigendum|detail_blacklist_user|detail_remark|detail_risk_text|detail_system_prompt_si|detail_system_prompt_abnormal)$/.test(String(reason || ''));
    }

    function processedExpiryTime(item = {}) {
      const explicit = Date.parse(item.expiresAt || '');
      if (Number.isFinite(explicit)) return explicit;
      const lastAt = Date.parse(item.lastAt || '');
      if (!Number.isFinite(lastAt)) return 0;
      return lastAt + 48 * 60 * 60 * 1000;
    }

    async function wasRecentlyProcessed(candidate) {
      const key = getProcessedKey(candidate);
      if (!key) return false;
      const state = await getWatcherState();
      const item = state.processed?.[key];
      if (!item) return false;
      if (processedExpiryTime(item) <= Date.now()) {
        if (state.processed && Object.prototype.hasOwnProperty.call(state.processed, key)) {
          delete state.processed[key];
          await saveWatcherState(state);
          await appendWatcherTrace('processed_record_expired', {
            reason: item.reason || 'expired',
            assistId: candidate?.assistId || key,
            detailUrl: candidate?.detailUrl || '',
            expiredAt: item.expiresAt || ''
          });
        }
        return false;
      }
      if (item.status === 'skipped' && isStaticSkipReason(item.reason)) {
        return false;
      }
      return true;
    }

    async function sleepMinutes(minutes) {
      if (minutes <= 0) return;
      await new Promise(resolve => setTimeout(resolve, minutes * 60 * 1000));
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
      recoverStaleWatcherState
    };
  }

  globalThis.AblesciWatcherBootstrapModule = {
    createWatcherBootstrapApi
  };
}());
