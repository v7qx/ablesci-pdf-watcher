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

    async function recordPublisherCfChallenge(pageUrl = '', publisher = '') {
      // PRIVATE_WATCHER_ONLY
      const opts = await getOptions();
      if (opts.watcherStopOnCfChallenge === false) {
        return { paused: false, streak: 0, threshold: 0, notified: false };
      }
      const stored = await chromeApi.storage.local.get([AUTO_WATCHER_STATE_KEY, 'watcherEnabled']);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      const threshold = Math.max(1, Number(opts.watcherCfPauseThreshold || defaultOptions.watcherCfPauseThreshold || 3));
      const publisherKey = String(publisher || '').trim().toLowerCase();
      const isolated = opts.watcherMultiPublisherEnabled === true && !!publisherKey;
      state.publisherCfChallengeByPublisher = state.publisherCfChallengeByPublisher && typeof state.publisherCfChallengeByPublisher === 'object'
        ? state.publisherCfChallengeByPublisher
        : {};
      const streak = isolated
        ? Number(state.publisherCfChallengeByPublisher[publisherKey] || 0) + 1
        : Number(state.publisherCfChallengeStreak || 0) + 1;
      if (isolated) state.publisherCfChallengeByPublisher[publisherKey] = streak;
      else state.publisherCfChallengeStreak = streak;
      const reached = opts.watcherAdvancedSchedulerEnabled === true || streak >= threshold;
      if (reached) {
        if (isolated) {
          state.pausedPublisherLanes = state.pausedPublisherLanes && typeof state.pausedPublisherLanes === 'object'
            ? state.pausedPublisherLanes
            : {};
          state.pausedPublisherLanes[publisherKey] = true;
          await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
        } else {
          state.pausedByPublisherCfChallenge = true;
          await chromeApi.storage.local.set({ watcherEnabled: false, [AUTO_WATCHER_STATE_KEY]: state });
          await chromeApi.alarms.clear('ablesciAutoWatcher');
        }
      } else {
        await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
      }

      let notified = false;
      if (opts.watcherCfNotificationEnabled !== false) {
        const message = reached
          ? (isolated
              ? `${publisherKey} 连续 ${streak} 次遇到出版商验证页，已暂停该出版社通道。`
              : `连续 ${streak} 次遇到出版商验证页，已暂停低频值守。请完成验证后手动重新开启。`)
          : `检测到出版商验证页（第 ${streak} 次）。请恢复浏览器窗口并完成验证；达到 ${threshold} 次后会自动暂停值守。`;
        await notifyAccessEnvironmentAnomaly(message);
        notified = true;
      }
      return {
        paused: reached,
        streak,
        threshold,
        notified,
        pageUrl: urlHostPath(pageUrl || '')
      };
    }

    async function clearPublisherCfChallengeState(publisher = '') {
      // PRIVATE_WATCHER_ONLY
      const stored = await chromeApi.storage.local.get(AUTO_WATCHER_STATE_KEY);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      const publisherKey = String(publisher || '').trim().toLowerCase();
      if (publisherKey && state.publisherCfChallengeByPublisher) {
        delete state.publisherCfChallengeByPublisher[publisherKey];
        if (state.pausedPublisherLanes) delete state.pausedPublisherLanes[publisherKey];
        await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
        return;
      }
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
