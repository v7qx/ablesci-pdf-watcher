'use strict';

// Responsibility: watcher trace/log buffering and action-badge countdown UI.
(function () {
  function createWatcherLoggingApi(config) {
    const {
      chromeApi,
      depsRef,
      getWatcherState,
      normalizeOptions,
      normalizeText,
      formatBeijingDateTime,
      countdownText,
      sanitizeTraceValue,
      sanitizeReportUrl,
      autoWatcherLogKey,
      autoWatcherTraceKey,
      maxLogs,
      maxTraceLogs,
      traceFlushIntervalMs,
      traceFlushBatchSize,
      watcherLogFlushIntervalMs,
      watcherLogFlushBatchSize,
      badgeRefreshIntervalMs
    } = config;

    let badgeRefreshTimer = null;
    let traceBuffer = [];
    let traceFlushTimer = null;
    let traceFlushPromise = Promise.resolve();
    let watcherLogBuffer = [];
    let watcherLogFlushTimer = null;
    let watcherLogFlushPromise = Promise.resolve();
    let cachedTraceLevel = 'normal';
    let traceLevelLoadedAt = 0;

    function nextDisplaySchedule(state = {}, opts = null) {
      const unifiedAt = state.nextAssistRunAt || state.chromeAlarmScheduledAt || state.nextScheduledAt || '';
      return {
        kind: 'run',
        time: unifiedAt,
        assistTime: unifiedAt,
        label: '下一次应助'
      };
    }

    async function updateActionBadge(state = null) {
      try {
        const current = state || await getWatcherState();
        const opts = depsRef?.getOptions ? normalizeOptions(await depsRef.getOptions()) : {};
        if (opts.watcherEnabled !== true) {
          await chromeApi.action.setBadgeText({ text: '' });
          await chromeApi.action.setTitle({ title: 'Ablesci PDF Watcher' });
          return;
        }
        const schedule = nextDisplaySchedule(current, opts);
        const text = countdownText(schedule.time);
        const shortText = text === 'due'
          ? 'due'
          : (text ? text.replace(/(\d+)m\d+s$/, '$1m').replace(/(\d+)h(\d+)m$/, '$1h') : '');
        if (opts.watcherBadgeCountdownEnabled !== false) {
          await chromeApi.action.setBadgeText({ text: shortText.slice(0, 4) });
          await chromeApi.action.setBadgeBackgroundColor({ color: text === 'due' ? '#dc2626' : '#2563eb' });
        } else {
          await chromeApi.action.setBadgeText({ text: '' });
        }
        const lang = opts.watcherLanguage || 'auto';
        const isEn = (lang === 'en') || (lang === 'auto' && !(navigator.language || '').toLowerCase().startsWith('zh'));
        const label = isEn ? 'Next Run' : (schedule.label || '下一次应助');
        const countdownLabel = isEn ? 'Countdown' : '倒计时';
        const title = text
          ? `Ablesci PDF Watcher\n${label}: ${formatBeijingDateTime(schedule.time)}\n${countdownLabel}: ${text}`
          : 'Ablesci PDF Watcher';
        await chromeApi.action.setTitle({ title });
      } catch (_) {}
    }

    function normalizeTraceLevel(value) {
      return ['off', 'compact', 'normal', 'verbose'].includes(value) ? value : 'normal';
    }

    async function getTraceLevel() {
      if (traceLevelLoadedAt > 0) return cachedTraceLevel;
      try {
        const stored = await chromeApi.storage.local.get('watcherTraceLevel');
        cachedTraceLevel = normalizeTraceLevel(stored.watcherTraceLevel);
        traceLevelLoadedAt = Date.now();
      } catch (_) {}
      return cachedTraceLevel;
    }

    async function appendWatcherTrace(step, details = {}) {
      try {
        const traceLevel = await getTraceLevel();
        if (traceLevel === 'off') return;
        if (traceLevel === 'compact') {
          const noisySteps = [
            'candidate_skip_list_filter',
            'candidate_skip_processed',
            'session_plan_url',
            'session_plan_result',
            'session_plan_done',
            'session_source_order',
            'run_session_size',
            'session_size_calculated',
            'tab_open_request',
            'tab_opened',
            'tab_complete',
            'tab_close_request',
            'tab_closed',
            'tab_open_failed',
            'tab_close_failed',
            'list_dom_ready',
            'list_parse_result',
            'alarm_refresh_start',
            'alarm_cleared',
            'alarm_disabled',
            'alarm_scheduled',
            'alarm_scheduled_existing_assist',
            'alarm_scheduled_rate_limited_retry',
            'sync_web_assist_count',
            'assist_next_scheduled'
          ];
          if (noisySteps.includes(step)) return;
        }
        const url = details.url || details.detailUrl || details.listUrl || '';
        traceBuffer.push({
          time: new Date().toISOString(),
          step: normalizeText(step).slice(0, 80),
          reason: normalizeText(details.reason).slice(0, 160),
          trigger: normalizeText(details.trigger).slice(0, 80),
          sessionId: normalizeText(details.sessionId).slice(0, 80),
          tabId: details.tabId ?? '',
          url: traceLevel === 'verbose' ? sanitizeReportUrl(url) : '',
          urlHostPath: depsRef?.urlHostPath ? depsRef.urlHostPath(url || '') : null,
          details: sanitizeTraceValue(details, 0, traceLevel, {
            normalizeText,
            sanitizeFullUrl: sanitizeReportUrl,
            urlHostPath: depsRef?.urlHostPath
          })
        });
        if (traceBuffer.length >= traceFlushBatchSize) {
          await flushWatcherTrace();
        } else if (!traceFlushTimer) {
          traceFlushTimer = setTimeout(() => {
            traceFlushTimer = null;
            flushWatcherTrace().catch(() => {});
          }, traceFlushIntervalMs);
        }
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] trace append failed', err);
      }
    }

    async function flushWatcherTrace() {
      const batch = traceBuffer.splice(0, traceBuffer.length);
      if (!batch.length) return;
      traceFlushPromise = traceFlushPromise
        .catch(() => {})
        .then(async () => {
          const stored = await chromeApi.storage.local.get(autoWatcherTraceKey);
          const logs = Array.isArray(stored[autoWatcherTraceKey]) ? stored[autoWatcherTraceKey] : [];
          const next = batch.slice().reverse().concat(logs).slice(0, maxTraceLogs);
          await chromeApi.storage.local.set({ [autoWatcherTraceKey]: next });
        });
      await traceFlushPromise;
    }

    async function clearBufferedWatcherTrace() {
      traceBuffer = [];
      if (traceFlushTimer) {
        clearTimeout(traceFlushTimer);
        traceFlushTimer = null;
      }
    }

    async function trimStoredWatcherTraceLogs() {
      try {
        const stored = await chromeApi.storage.local.get(autoWatcherTraceKey);
        const logs = Array.isArray(stored[autoWatcherTraceKey]) ? stored[autoWatcherTraceKey] : [];
        if (logs.length <= maxTraceLogs) return;
        await chromeApi.storage.local.set({ [autoWatcherTraceKey]: logs.slice(0, maxTraceLogs) });
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] trace trim failed', err);
      }
    }

    async function syncCurrentPageDataStatus(entry) {
      try {
        const assistId = String(entry.assistId || entry.id || '').slice(0, 60);
        if (!assistId) return;
        const key = 'autoWatcherCurrentPageData';
        const stored = await chromeApi.storage.local.get(key);
        const pageData = stored[key];
        if (pageData && Array.isArray(pageData.candidates)) {
          let updated = false;
          for (const cand of pageData.candidates) {
            if (String(cand.assistId) === assistId) {
              cand.status = String(entry.status || 'unknown');
              cand.reason = String(entry.reason || '');
              cand.time = Date.now();
              updated = true;
            }
          }
          if (updated) {
            await chromeApi.storage.local.set({ [key]: pageData });
          }
        }
      } catch (_) {}
    }

    async function appendWatcherLog(entry) {
      try {
        await syncCurrentPageDataStatus(entry);
        watcherLogBuffer.push({
          time: new Date().toISOString(),
          page: entry.page ? String(entry.page) : '',
          assistId: String(entry.assistId || entry.id || '').slice(0, 60),
          title: normalizeText(entry.title || '').slice(0, 160),
          doi: String(entry.doi || '').slice(0, 120),
          journalShortName: normalizeText(entry.journalShortName || '').slice(0, 120),
          journalName: normalizeText(entry.journalName || entry.journalShortName || '').slice(0, 120),
          detailUrl: String(entry.detailUrl || '').slice(0, 500),
          trigger: normalizeText(entry.trigger || '').slice(0, 60),
          sessionId: normalizeText(entry.sessionId || '').slice(0, 60),
          status: String(entry.status || 'unknown').slice(0, 20),
          reason: normalizeText(entry.reason || '').slice(0, 200)
        });
        if (watcherLogBuffer.length >= watcherLogFlushBatchSize) {
          await flushWatcherLogs();
        } else if (!watcherLogFlushTimer) {
          watcherLogFlushTimer = setTimeout(() => {
            watcherLogFlushTimer = null;
            flushWatcherLogs().catch(() => {});
          }, watcherLogFlushIntervalMs);
        }
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] log append failed', err);
      }
    }

    async function flushWatcherLogs() {
      const batch = watcherLogBuffer.splice(0, watcherLogBuffer.length);
      if (!batch.length) return;
      watcherLogFlushPromise = watcherLogFlushPromise
        .catch(() => {})
        .then(async () => {
          const stored = await chromeApi.storage.local.get(autoWatcherLogKey);
          const logs = Array.isArray(stored[autoWatcherLogKey]) ? stored[autoWatcherLogKey] : [];
          const next = batch.slice().reverse().concat(logs).slice(0, maxLogs);
          await chromeApi.storage.local.set({ [autoWatcherLogKey]: next });
        });
      await watcherLogFlushPromise;
    }

    async function clearBufferedWatcherLogs() {
      watcherLogBuffer = [];
      if (watcherLogFlushTimer) {
        clearTimeout(watcherLogFlushTimer);
        watcherLogFlushTimer = null;
      }
    }

    function startBadgeRefreshLoop() {
      updateActionBadge().catch(() => {});
      if (badgeRefreshTimer) clearInterval(badgeRefreshTimer);
      badgeRefreshTimer = setInterval(() => {
        updateActionBadge().catch(() => {});
      }, badgeRefreshIntervalMs);
    }

    function stopBadgeRefreshLoop() {
      if (badgeRefreshTimer) {
        clearInterval(badgeRefreshTimer);
        badgeRefreshTimer = null;
      }
    }

    function applyStorageWatcherTraceLevel(changes) {
      if (changes.watcherTraceLevel) {
        cachedTraceLevel = normalizeTraceLevel(changes.watcherTraceLevel.newValue);
        traceLevelLoadedAt = Date.now();
      }
    }

    return {
      nextDisplaySchedule,
      updateActionBadge,
      normalizeTraceLevel,
      getTraceLevel,
      appendWatcherTrace,
      flushWatcherTrace,
      clearBufferedWatcherTrace,
      trimStoredWatcherTraceLogs,
      appendWatcherLog,
      flushWatcherLogs,
      clearBufferedWatcherLogs,
      startBadgeRefreshLoop,
      stopBadgeRefreshLoop,
      applyStorageWatcherTraceLevel
    };
  }

  globalThis.AblesciWatcherLoggingModule = {
    createWatcherLoggingApi
  };
}());
