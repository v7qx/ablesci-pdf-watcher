'use strict';

// Responsibility: register Chrome listeners and expose watcher init entry.
(function () {
  function createWatcherEntryApi(config) {
    const {
      chromeApi,
      depsRef,
      setDeps,
      alarmName,
      badgeRefreshAlarmName,
      autoWatcherStateKey,
      autoWatcherLogKey,
      autoWatcherTraceKey,
      startBadgeRefreshLoop,
      stopBadgeRefreshLoop,
      updateActionBadge,
      recoverStaleWatcherState,
      refreshAutoWatcherAlarm,
      flushWatcherLogs,
      flushWatcherTrace,
      appendWatcherTrace,
      applyStorageWatcherTraceLevel,
      runAutoWatcherOnce,
      getWatcherState,
      saveWatcherState,
      clearBufferedWatcherLogs,
      clearBufferedWatcherTrace,
      trimStoredWatcherTraceLogs,
      notifyWatcherNeedsAttention,
      stateRef
    } = config;

    function initAutoWatcher(nextDeps) {
      setDeps(nextDeps);
      startBadgeRefreshLoop();

      chromeApi.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === alarmName) runAutoWatcherOnce('alarm');
        if (alarm.name === badgeRefreshAlarmName) updateActionBadge().catch(() => {});
      });
      chromeApi.alarms.create(badgeRefreshAlarmName, { periodInMinutes: 1 });

      chromeApi.runtime.onStartup.addListener(() => {
        recoverStaleWatcherState('runtime_startup').catch(() => {});
        refreshAutoWatcherAlarm(true, 'runtime_startup').catch(() => {});
      });

      chromeApi.runtime.onInstalled.addListener(() => {
        recoverStaleWatcherState('runtime_installed').catch(() => {});
        refreshAutoWatcherAlarm(true, 'runtime_installed').catch(() => {});
      });

      chromeApi.runtime.onSuspend.addListener(() => {
        stopBadgeRefreshLoop();
        flushWatcherLogs().catch(() => {});
        flushWatcherTrace().catch(() => {});
      });

      chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        const watcherKeys = Object.keys(changes).filter(key => key.startsWith('watcher'));
        if (watcherKeys.length) {
          applyStorageWatcherTraceLevel(changes);
          const changedKeys = watcherKeys.slice(0, 12).join(',');
          updateActionBadge().catch(() => {});
          if (watcherKeys.some(key => key !== 'watcherBadgeCountdownEnabled')) {
            const suppressUntil = Number(changes.ablesciSuppressWatcherReplanUntil?.newValue || 0);
            if (Number.isFinite(suppressUntil) && suppressUntil > Date.now()) {
              appendWatcherTrace('alarm_refresh_suppressed', {
                reason: 'manual_run_preserve_existing_schedule',
                changedKeys
              }).catch(() => {});
              return;
            }
            refreshAutoWatcherAlarm(true, `storage_changed:${changedKeys}`).catch(() => {});
          }
        }
      });

      chromeApi.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg?.type === 'ablesciRunAutoWatcherNow') {
          runAutoWatcherOnce('manual')
            .then(sendResponse)
            .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
          return true;
        }
        if (msg?.type === 'ablesciTestWatcherNotification') {
          notifyWatcherNeedsAttention('这是一条低频值守测试提醒，不会执行检查。')
            .then(sendResponse)
            .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
          return true;
        }
        if (msg?.type === 'ablesciClearAutoWatcherState') {
          chromeApi.storage.local.remove(autoWatcherStateKey).then(() => sendResponse({ ok: true }));
          return true;
        }
        if (msg?.type === 'ablesciClearAutoWatcherLogs') {
          Promise.all([clearBufferedWatcherLogs(), clearBufferedWatcherTrace()])
            .then(() => chromeApi.storage.local.remove([autoWatcherLogKey, autoWatcherTraceKey]))
            .then(() => sendResponse({ ok: true }));
          return true;
        }
        return false;
      });

      recoverStaleWatcherState('init').catch(() => {});
      trimStoredWatcherTraceLogs().catch(() => {});
      refreshAutoWatcherAlarm(true, 'init').catch(() => {});
    }

    return { initAutoWatcher };
  }

  globalThis.AblesciWatcherEntryModule = {
    createWatcherEntryApi
  };
})();
