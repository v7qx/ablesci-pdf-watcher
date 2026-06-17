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

    const PROCESSED_MAX_TTL_MS = 5 * 24 * 60 * 60 * 1000;
    const PROCESSED_MIN_TTL_MS = 6 * 60 * 60 * 1000;
    const PROCESSED_DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
    const MAX_DAILY_ENTRIES = 60;
    const MAX_PROCESSED_ENTRIES = 5000;
    const EMERGENCY_PROCESSED_ENTRIES = 2000;

    async function getWatcherState() {
      const stored = await chromeApi.storage.local.get(stateKey);
      const state = stored[stateKey] || { processed: {}, daily: {} };
      if (!state || typeof state !== 'object') return { processed: {}, daily: {}, _version: 0 };
      if (!Number.isFinite(Number(state._version))) state._version = 0;
      return state;
    }

    function pruneExpiredProcessed(state) {
      if (!state.processed || typeof state.processed !== 'object') return 0;
      const now = Date.now();
      let removed = 0;
      const keys = Object.keys(state.processed);
      for (const key of keys) {
        const entry = state.processed[key];
        if (!entry || typeof entry !== 'object') {
          delete state.processed[key];
          removed += 1;
          continue;
        }
        const expiresAt = Date.parse(entry.expiresAt || '');
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
          delete state.processed[key];
          removed += 1;
        }
      }
      return removed;
    }

    function pruneOldDaily(state) {
      if (!state.daily || typeof state.daily !== 'object') return 0;
      const keys = Object.keys(state.daily).sort();
      if (keys.length <= MAX_DAILY_ENTRIES) return 0;
      const toRemove = keys.slice(0, keys.length - MAX_DAILY_ENTRIES);
      for (const key of toRemove) {
        delete state.daily[key];
      }
      return toRemove.length;
    }

    function pruneExpiredJournalAccessStats(state) {
      if (!state.journalAccessStats || typeof state.journalAccessStats !== 'object' || Array.isArray(state.journalAccessStats)) return 0;
      const now = Date.now();
      let removed = 0;
      const keys = Object.keys(state.journalAccessStats);
      for (const key of keys) {
        const entry = state.journalAccessStats[key];
        if (!entry || typeof entry !== 'object') {
          delete state.journalAccessStats[key];
          removed += 1;
          continue;
        }
        const expiresAt = Date.parse(entry.expiresAt || '');
        if (!Number.isFinite(expiresAt) || expiresAt <= now) {
          delete state.journalAccessStats[key];
          removed += 1;
        }
      }
      return removed;
    }

    function trimProcessedToMax(state, max) {
      if (!state.processed || typeof state.processed !== 'object') return 0;
      const keys = Object.keys(state.processed);
      const limit = Number.isFinite(max) ? max : MAX_PROCESSED_ENTRIES;
      if (keys.length <= limit) return 0;
      const entries = keys.map(k => ({ k, ts: Date.parse(state.processed[k]?.lastAt || '') || 0 }));
      entries.sort((a, b) => a.ts - b.ts);
      const toRemove = entries.slice(0, entries.length - limit);
      for (const entry of toRemove) {
        delete state.processed[entry.k];
      }
      return toRemove.length;
    }

    async function emergencyStorageTrim() {
      const allLargeKeys = config.largeStorageKeys;
      if (!allLargeKeys || !allLargeKeys.length) return 0;
      try {
        const stored = await chromeApi.storage.local.get(allLargeKeys);
        let dirty = false;
        for (const key of allLargeKeys) {
          const val = stored[key];
          if (Array.isArray(val)) {
            const newLen = Math.min(val.length, 30);
            if (val.length > newLen) {
              stored[key] = val.slice(0, newLen);
              dirty = true;
            }
          }
        }
        if (!dirty) return 0;
        const keysWritten = [];
        for (const key of allLargeKeys) {
          if (stored[key] !== undefined) keysWritten.push(key);
        }
        if (keysWritten.length > 0) {
          const patch = {};
          for (const key of keysWritten) {
            patch[key] = stored[key];
          }
          await chromeApi.storage.local.set(patch);
        }
        return keysWritten.length;
      } catch (_) { return 0; }
    }

    async function pruneWatcherState(state) {
      if (!state) state = await getWatcherState();
      const prC = pruneExpiredProcessed(state);
      const prD = pruneOldDaily(state);
      const prJ = pruneExpiredJournalAccessStats(state);
      const prT = trimProcessedToMax(state);
      const totalRemoved = prC + prD + prJ + prT;
      if (totalRemoved > 0) {
        await saveStateRaw(state);
        try { await appendWatcherTrace('state_pruned', { processedRemoved: prC, dailyRemoved: prD, journalAccessRemoved: prJ, trimmedToMax: prT, totalRemoved, processedRemaining: Object.keys(state.processed || {}).length, dailyRemaining: Object.keys(state.daily || {}).length }); } catch (_) {}
      }
      return totalRemoved;
    }

    async function saveStateRaw(state) {
      try {
        await chromeApi.storage.local.set({ [stateKey]: state });
      } catch (err) {
        if (String(err && err.message || '').includes('quota')) {
          await emergencyStorageTrim();
          pruneExpiredProcessed(state);
          pruneOldDaily(state);
          pruneExpiredJournalAccessStats(state);
          trimProcessedToMax(state, EMERGENCY_PROCESSED_ENTRIES);
          await chromeApi.storage.local.set({ [stateKey]: state });
        } else {
          throw err;
        }
      }
    }

    async function setStorageSafe(obj) {
      try {
        await chromeApi.storage.local.set(obj);
      } catch (err) {
        if (String(err && err.message || '').includes('quota')) {
          await emergencyStorageTrim();
          const st = obj[stateKey];
          if (st) {
            pruneExpiredProcessed(st);
            pruneOldDaily(st);
            pruneExpiredJournalAccessStats(st);
            trimProcessedToMax(st, EMERGENCY_PROCESSED_ENTRIES);
          }
          try {
            await chromeApi.storage.local.set(obj);
          } catch (err2) {
            if (String(err2 && err2.message || '').includes('quota')) {
              console.warn('[Ablesci Auto Watcher] storage quota still exceeded after emergency trim, clearing processed');
              if (st) {
                st.processed = {};
                st.daily = {};
                if (st.journalAccessStats && typeof st.journalAccessStats === 'object') {
                  const entries = Object.entries(st.journalAccessStats);
                  entries.sort((a, b) => Date.parse(b[1]?.expiresAt || '') - Date.parse(a[1]?.expiresAt || ''));
                  st.journalAccessStats = Object.fromEntries(entries.slice(0, 100));
                }
              }
              await chromeApi.storage.local.set(obj);
            } else {
              throw err2;
            }
          }
        } else {
          throw err;
        }
      }
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
          journalAccessStats: { ...(current.journalAccessStats || {}), ...(incoming.journalAccessStats || {}) },
          _version: currentVersion + 1
        };
        await setStorageSafe({ [stateKey]: next });
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
        journalAccessStats: { ...(current.journalAccessStats || {}), ...(incoming.journalAccessStats || {}) },
        _version: Number(current._version || 0) + 1
      };
      await setStorageSafe({ [stateKey]: next });
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

    function normalizeProcessedMeta(meta = {}) {
      return meta && typeof meta === 'object' ? meta : {};
    }

    function processedTtlMs(meta = {}) {
      meta = normalizeProcessedMeta(meta);
      const ageSeconds = Number(meta.assistAgeSeconds);
      if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
        const remaining = PROCESSED_MAX_TTL_MS - ageSeconds * 1000;
        return Math.min(PROCESSED_MAX_TTL_MS, Math.max(PROCESSED_MIN_TTL_MS, remaining));
      }
      return PROCESSED_DEFAULT_TTL_MS;
    }

    function sanitizeProcessedMeta(meta = {}) {
      meta = normalizeProcessedMeta(meta);
      return {
        assistAgeSeconds: Number.isFinite(Number(meta.assistAgeSeconds)) ? Number(meta.assistAgeSeconds) : '',
        assistTimeText: normalizeText(meta.assistTimeText || '').slice(0, 80),
        listUrl: String(meta.listUrl || '').slice(0, 500),
        page: Number.isFinite(Number(meta.page)) ? Number(meta.page) : '',
        publisherName: normalizeText(meta.publisherName || meta.publisher || '').slice(0, 160),
        journalShortName: normalizeText(meta.journalShortName || '').slice(0, 160)
      };
    }

    async function updateProcessed(key, status, reason, meta = {}) {
      if (!key) return;
      meta = normalizeProcessedMeta(meta);
      const ttlMs = processedTtlMs(meta);
      const now = Date.now();
      const metaFields = sanitizeProcessedMeta(meta);
      await updateWatcherState(state => {
        state.processed = state.processed || {};
        state.processed[key] = {
          lastAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttlMs).toISOString(),
          ttlMs,
          status,
          reason: normalizeText(reason).slice(0, 160),
          ...metaFields
        };
      });
    }

    async function incrementDaily(field, trigger = '') {
      await updateWatcherState(state => {
        const key = todayKey();
        state.daily = state.daily || {};
        state.daily[key] = state.daily[key] || {
          checked: 0,
          downloaded: 0,
          downloadedAuto: 0,
          downloadedManual: 0,
          uploaded: 0,
          skipped: 0,
          failed: 0,
          notified: 0
        };
        state.daily[key][field] = Number(state.daily[key][field] || 0) + 1;
        if (field === 'downloaded') {
          const isAuto = trigger === 'alarm';
          if (isAuto) {
            state.daily[key].downloadedAuto = Number(state.daily[key].downloadedAuto || 0) + 1;
            state.recentDownloads = state.recentDownloads || [];
            state.recentDownloads.push(Date.now());
            const cutOff = Date.now() - 30 * 60 * 1000;
            state.recentDownloads = state.recentDownloads.filter(t => t >= cutOff);
          } else {
            state.daily[key].downloadedManual = Number(state.daily[key].downloadedManual || 0) + 1;
          }
        }
        if (field === 'uploaded') {
          if (Number.isFinite(Number(state.actualTotalAssists))) {
            state.actualTotalAssists = Number(state.actualTotalAssists) + 1;
          }
        }
      });
    }

    function triggerMetricKey(trigger) {
      if (trigger === 'alarm') return 'autoRuns';
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
        state.currentExecutionModel = opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval';
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
        scannedUrl: result?.scannedUrl || attempt.scannedUrl || '',
        scannedPublisher: result?.scannedPublisher || attempt.scannedPublisher || '',
        scannedPage: result?.scannedPage || attempt.scannedPage || '',
        parsedListPages: Array.isArray(result?.parsedListPages)
          ? result.parsedListPages.join(',')
          : (attempt.parsedListPages || ''),
        backoffSkippedPages: Array.isArray(result?.backoffSkippedPages)
          ? result.backoffSkippedPages.join(',')
          : (attempt.backoffSkippedPages || ''),
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
        targetSessionSize: finished.targetSessionSize,
        checkedDelta: finished.checkedDelta,
        downloadedDelta: finished.downloadedDelta,
        listScanStarted: finished.listScanStarted,
        pickedListUrl: finished.pickedListUrl,
        pickedPage: finished.pickedPage,
        scannedPage: finished.scannedPage,
        parsedListPages: finished.parsedListPages,
        backoffSkippedPages: finished.backoffSkippedPages,
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
      dailyCounterSnapshot,
      pruneWatcherState,
      emergencyStorageTrim
    };
  }

  globalThis.AblesciWatcherStateModule = {
    createWatcherStateApi
  };
})();
