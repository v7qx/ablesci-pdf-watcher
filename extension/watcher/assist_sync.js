'use strict';

// Best-effort helpers extracted from orchestrator.js to keep that file focused:
//  - syncActualAssistCount: syncs the web total-assist count into scheduling state.
//  - readBlacklistedIds: reads the requester blacklist via the native helper.
// Both are try/catch-wrapped and degrade gracefully. Instantiated inside
// createWatcherOrchestratorApi via globalThis with the deps they need; behavior
// is identical to the previous inline implementation.
(function () {
  function createWatcherAssistSyncApi(config) {
    const {
      depsRef,
      appendWatcherTrace,
      saveWatcherStateSafe,
      todayKey
    } = config;

    async function syncActualAssistCount(state, opts) {
      const now = Date.now();
      const lastSynced = state.lastAssistCountSyncedAt ? new Date(state.lastAssistCountSyncedAt).getTime() : 0;
      if (Number.isFinite(lastSynced) && now - lastSynced < 15 * 60 * 1000) {
        return;
      }
      try {
        const res = await fetch('https://www.ablesci.com/my/home', { credentials: 'include' });
        if (!res.ok) {
          await appendWatcherTrace('sync_web_assist_count_failed', {
            reason: 'http_not_ok',
            status: res.status
          });
          return;
        }
        const html = await res.text();
        const match = html.match(/最近应助[^\d]*(\d+)/);
        if (match) {
          const totalCount = parseInt(match[1], 10);
          const currentMonth = todayKey().slice(0, 7);
          state.firstSyncTotalAssists = state.firstSyncTotalAssists || {};
          state.firstSyncProgressRatio = state.firstSyncProgressRatio || {};
          if (state.firstSyncTotalAssists[currentMonth] === undefined) {
            state.firstSyncTotalAssists[currentMonth] = totalCount;
            // Calculate progress ratio at first sync (no calendar-progress truncation in the first week)
            let ratio = 0;
            const dayOfMonth = parseInt(todayKey().slice(8, 10), 10);
            if (dayOfMonth > 7) {
              const year = new Date(now).getFullYear();
              const month = new Date(now).getMonth();
              const startOfMonth = new Date(year, month, 1).getTime();
              const startOfNextMonth = new Date(year, month + 1, 1).getTime();
              const totalMonthMs = startOfNextMonth - startOfMonth;
              const currentMs = now - startOfMonth;
              ratio = totalMonthMs > 0 ? Math.max(0, Math.min(1, currentMs / totalMonthMs)) : 0;
            }
            state.firstSyncProgressRatio[currentMonth] = ratio;
          }

          state.monthlyInitialAssists = state.monthlyInitialAssists || {};
          if (state.monthlyInitialAssists[currentMonth] === undefined) {
            state.monthlyInitialAssists[currentMonth] = totalCount;
          }
          state.actualTotalAssists = totalCount;
          state.lastAssistCountSyncedAt = new Date().toISOString();
          await saveWatcherStateSafe(state);
          await appendWatcherTrace('sync_web_assist_count', {
            totalCount,
            currentMonth,
            firstSyncTotal: state.firstSyncTotalAssists[currentMonth],
            firstSyncRatio: state.firstSyncProgressRatio[currentMonth],
            initialCount: state.monthlyInitialAssists[currentMonth]
          });
        } else {
          await appendWatcherTrace('sync_web_assist_count_failed', {
            reason: 'count_pattern_not_found'
          });
        }
      } catch (err) {
        console.warn('[Ablesci Watcher] Failed to sync actual assist count:', err);
        await appendWatcherTrace('sync_web_assist_count_failed', {
          reason: 'exception',
          error: String(err?.message || err || '').slice(0, 240)
        });
      }
    }

    async function readBlacklistedIds(opts, trigger) {
      const blacklistedIds = [];
      if (!opts.watcherEnableBlacklist) return blacklistedIds;
      try {
        const res = await depsRef.sendNativeMessage(opts.nativeHostName, {
          action: 'read_text_file',
          path: opts.watcherBlacklistPath || '',
          extra: {
            allowed_path: opts.watcherBlacklistPath || '',
            perf_category: opts.watcherBlacklistPath ? 'blacklist_custom' : 'blacklist_default'
          }
        });
        if (res && res.ok && res.body) {
          const lines = res.body.split(/\r?\n/);
          for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#') || line.startsWith('//')) continue;
            const commentIdx = line.indexOf('#') >= 0 ? line.indexOf('#') : (line.indexOf('//') >= 0 ? line.indexOf('//') : -1);
            if (commentIdx >= 0) line = line.substring(0, commentIdx).trim();
            const parts = line.split(/[\s,，]+/).map(p => p.trim()).filter(Boolean);
            blacklistedIds.push(...parts);
          }
        }
      } catch (err) {
        console.error('[Blacklist] failed to read blacklist file in auto watcher:', err);
        await appendWatcherTrace('blacklist_read_error_ignored', {
          reason: 'blacklist_read_error_ignored',
          trigger,
          error: err.message || String(err)
        });
      }
      return blacklistedIds;
    }

    return { syncActualAssistCount, readBlacklistedIds };
  }

  globalThis.AblesciWatcherAssistSyncModule = { createWatcherAssistSyncApi };
})();
