'use strict';

// Responsibility: register Chrome listeners and expose watcher init entry.
(function () {
  function createWatcherEntryApi(config) {
    const {
      chromeApi,
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
      notifyWatcherNeedsAttention
    } = config;

    function initAutoWatcher(nextDeps) {
      setDeps(nextDeps);
      startBadgeRefreshLoop();

      chromeApi.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === alarmName) runAutoWatcherOnce('alarm');
      });
      // Badge no longer uses a periodic alarm (which woke the service worker every
      // minute even when idle). The badge is refreshed event-driven instead:
      // on storage changes, after each run, and by the in-memory loop while the
      // worker is alive. Clear any periodic alarm left by older installs.
      chromeApi.alarms.clear(badgeRefreshAlarmName).catch(() => {});

      chromeApi.runtime.onStartup.addListener(() => {
        recoverStaleWatcherState('runtime_startup').catch(() => {});
        getWatcherState().then(state => {
          state.lastStartupTime = Date.now();
          return saveWatcherState(state);
        }).catch(() => {});
        refreshAutoWatcherAlarm(true, 'runtime_startup').catch(() => {});
      });

      chromeApi.runtime.onInstalled.addListener(() => {
        recoverStaleWatcherState('runtime_installed').catch(() => {});
        getWatcherState().then(state => {
          state.lastStartupTime = Date.now();
          return saveWatcherState(state);
        }).catch(() => {});
        refreshAutoWatcherAlarm(true, 'runtime_installed').catch(() => {});
      });

      chromeApi.runtime.onSuspend.addListener(() => {
        stopBadgeRefreshLoop();
        flushWatcherLogs().catch(() => {});
        flushWatcherTrace().catch(() => {});
      });

      chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        const watcherKeys = Object.keys(changes).filter(key => key.startsWith('watcher') && key !== 'watcherAccessEnvironmentAnomaly');
        if (watcherKeys.length) {
          applyStorageWatcherTraceLevel(changes);
          const changedKeys = watcherKeys.slice(0, 12).join(',');
          updateActionBadge().catch(() => {});

          if (changes.watcherEnabled && changes.watcherEnabled.newValue === true) {
            // PRIVATE_WATCHER_ONLY
            getWatcherState().then(state => {
              if (state.cfChallengeStreak || state.pausedByCfChallenge || state.publisherCfChallengeStreak || state.pausedByPublisherCfChallenge) {
                state.cfChallengeStreak = 0;
                state.pausedByCfChallenge = false;
                state.publisherCfChallengeStreak = 0;
                state.pausedByPublisherCfChallenge = false;
                return saveWatcherState(state);
              }
            }).catch(err => console.warn('[Ablesci PDF Watcher] Failed to reset CF streak on enable:', err));
          }

          const SCHEDULE_AFFECTING_KEYS = [
            'watcherEnabled',
            'watcherSpeedMode',
            'watcherMonthlyTarget',
            'watcherWorkdays',
            'watcherWorkWindows',
            'watcherSchedulerMode',
            'watcherIntervalMinutes',
            'watcherMinIntervalMinutes',
            'watcherMaxIntervalMinutes',
            'watcherAllowZeroSession',
            'watcherDailyLimit'
          ];
          const hasScheduleChange = SCHEDULE_AFFECTING_KEYS.some(key => {
            const change = changes[key];
            if (!change) return false;
            return change.newValue !== change.oldValue;
          });

          if (hasScheduleChange) {
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
          const trigger = msg.trigger === 'alarm' ? 'alarm' : 'manual';
          runAutoWatcherOnce(trigger)
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
          chromeApi.storage.local.get(autoWatcherStateKey)
            .then(stored => {
              const state = stored[autoWatcherStateKey] && typeof stored[autoWatcherStateKey] === 'object'
                ? stored[autoWatcherStateKey]
                : {};
              delete state.processed;
              delete state.doiFailures;
              delete state.recentProcessed;
              delete state.assistCandidateQueue;
              state._version = Number(state._version || 0) + 1;
              state.processedClearedAt = new Date().toISOString();
              return chromeApi.storage.local.set({ [autoWatcherStateKey]: state });
            })
            .then(() => sendResponse({ ok: true }));
          return true;
        }
        if (msg?.type === 'ablesciClearAutoWatcherLogs') {
          Promise.all([clearBufferedWatcherLogs(), clearBufferedWatcherTrace()])
            .then(() => chromeApi.storage.local.remove([autoWatcherLogKey, autoWatcherTraceKey, 'autoWatcherCandidateAudit', 'autoWatcherCandidateAuditIndex']))
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
