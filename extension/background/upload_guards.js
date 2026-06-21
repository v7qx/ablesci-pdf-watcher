'use strict';

// Watcher guard helpers used by the upload pipeline.
(function initBackgroundUploadGuards(globalThis) {
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const ACCESS_ENV_NOTIFICATION_ICON_URL = 'icons/icon128.png';

  function createBackgroundUploadGuardsApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      getOptions,
      urlHostPath
    } = deps;

    async function notifyAccessEnvironmentAnomaly(message) {
      try {
        await chromeApi.notifications.create({
          type: 'basic',
          iconUrl: ACCESS_ENV_NOTIFICATION_ICON_URL,
          title: 'Ablesci PDF Watcher',
          message,
          priority: 2,
          requireInteraction: true
        });
      } catch (err) {
        console.warn('[Ablesci PDF Watcher] anomaly notification failed', err);
      }
    }

    async function recordPublisherCfChallenge(pageUrl = '') {
      // PRIVATE_WATCHER_ONLY
      const opts = await getOptions();
      if (opts.watcherStopOnCfChallenge === false) {
        return { paused: false, streak: 0, threshold: 0, notified: false };
      }
      const stored = await chromeApi.storage.local.get([AUTO_WATCHER_STATE_KEY, 'watcherEnabled']);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      const threshold = Math.max(1, Number(opts.watcherCfPauseThreshold || defaultOptions.watcherCfPauseThreshold || 3));
      state.publisherCfChallengeStreak = Number(state.publisherCfChallengeStreak || 0) + 1;
      const reached = opts.watcherAdvancedSchedulerEnabled === true || state.publisherCfChallengeStreak >= threshold;
      if (reached) {
        state.pausedByPublisherCfChallenge = true;
        await chromeApi.storage.local.set({
          watcherEnabled: false,
          [AUTO_WATCHER_STATE_KEY]: state
        });
        await chromeApi.alarms.clear('ablesciAutoWatcher');
      } else {
        await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
      }

      let notified = false;
      if (opts.watcherCfNotificationEnabled !== false) {
        const message = reached
          ? `连续 ${state.publisherCfChallengeStreak} 次遇到出版商验证页，已暂停低频值守。请完成验证后手动重新开启。`
          : `检测到出版商验证页（第 ${state.publisherCfChallengeStreak} 次）。请恢复浏览器窗口并完成验证；达到 ${threshold} 次后会自动暂停值守。`;
        await notifyAccessEnvironmentAnomaly(message);
        notified = true;
      }
      return {
        paused: reached,
        streak: state.publisherCfChallengeStreak,
        threshold,
        notified,
        pageUrl: urlHostPath(pageUrl || '')
      };
    }

    async function clearPublisherCfChallengeState() {
      // PRIVATE_WATCHER_ONLY
      const stored = await chromeApi.storage.local.get(AUTO_WATCHER_STATE_KEY);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      if (!state.publisherCfChallengeStreak && !state.pausedByPublisherCfChallenge) return;
      state.publisherCfChallengeStreak = 0;
      state.pausedByPublisherCfChallenge = false;
      await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
    }

    return {
      recordPublisherCfChallenge,
      clearPublisherCfChallengeState
    };
  }

  globalThis.AblesciBackgroundUploadGuards = {
    createBackgroundUploadGuardsApi
  };
})(globalThis);
