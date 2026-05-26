'use strict';

// Watcher guard helpers used by the upload pipeline.
(function initBackgroundUploadGuards(globalThis) {
  const ACCESS_ENV_ANOMALY_KEY = 'watcherAccessEnvironmentAnomaly';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const ACCESS_ENV_WINDOW_MS = 15 * 60 * 1000;
  const ACCESS_ENV_THRESHOLD = 3;
  const ACCESS_ENV_DISTINCT_JOURNALS_THRESHOLD = 3;
  const ACCESS_ENV_NOTIFICATION_ICON_URL = 'icons/icon128.png';

  function createBackgroundUploadGuardsApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      getOptions,
      publisherForUrl,
      urlHostPath
    } = deps;

    function payloadJournalKey(payload = {}) {
      return String(payload?.journalName || '').trim().toLowerCase();
    }

    function payloadPublisherKey(payload = {}) {
      return String(publisherForUrl(payload?.pdfUrl || payload?.pickedUrl || '') || '').trim().toLowerCase();
    }

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

    async function pauseWatcherForAccessEnvironment(payload) {
      const now = Date.now();
      const journalKey = payloadJournalKey(payload);
      const publisherKey = payloadPublisherKey(payload);
      const stored = await chromeApi.storage.local.get([ACCESS_ENV_ANOMALY_KEY, AUTO_WATCHER_STATE_KEY, 'watcherEnabled']);
      const current = stored[ACCESS_ENV_ANOMALY_KEY] || {};
      const recent = Array.isArray(current.events)
        ? current.events.filter(item => item && Number(item.at || 0) > now - ACCESS_ENV_WINDOW_MS)
        : [];
      recent.push({
        at: now,
        journal: journalKey,
        publisher: publisherKey,
        assistId: String(payload?.assistId || '').trim()
      });
      const distinctJournals = new Set(recent.map(item => item.journal).filter(Boolean));
      const distinctPublishers = new Set(recent.map(item => item.publisher).filter(Boolean));
      const shouldPause = recent.length >= ACCESS_ENV_THRESHOLD && distinctJournals.size >= ACCESS_ENV_DISTINCT_JOURNALS_THRESHOLD;
      const nextState = {
        updatedAt: new Date(now).toISOString(),
        events: recent.slice(-10),
        lastPublisher: publisherKey,
        paused: shouldPause
      };
      await chromeApi.storage.local.set({ [ACCESS_ENV_ANOMALY_KEY]: nextState });
      if (!shouldPause) {
        return {
          paused: false,
          count: recent.length,
          distinctJournals: distinctJournals.size,
          distinctPublishers: distinctPublishers.size
        };
      }

      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      state.accessEnvironmentPausedAt = new Date(now).toISOString();
      state.accessEnvironmentPauseReason = 'consecutive_no_access_anomaly';
      state.accessEnvironmentAnomaly = {
        count: recent.length,
        distinctJournals: distinctJournals.size,
        distinctPublishers: distinctPublishers.size,
        publisher: publisherKey
      };
      await chromeApi.storage.local.set({
        watcherEnabled: false,
        [AUTO_WATCHER_STATE_KEY]: state,
        [ACCESS_ENV_ANOMALY_KEY]: nextState
      });
      await chromeApi.alarms.clear('ablesciAutoWatcher');
      const message = `短时间内连续出现 ${recent.length} 次无正文权限，且涉及 ${distinctJournals.size} 个期刊。已暂停值守，请检查代理、登录态或机构访问环境。`;
      await notifyAccessEnvironmentAnomaly(message);
      return {
        paused: true,
        count: recent.length,
        distinctJournals: distinctJournals.size,
        distinctPublishers: distinctPublishers.size,
        message
      };
    }

    async function recordAccessEnvironmentSuccess(payload) {
      const stored = await chromeApi.storage.local.get(ACCESS_ENV_ANOMALY_KEY);
      const current = stored[ACCESS_ENV_ANOMALY_KEY] || {};
      const journalKey = payloadJournalKey(payload);
      const publisherKey = payloadPublisherKey(payload);
      const recent = Array.isArray(current.events)
        ? current.events.filter(item => item && item.journal !== journalKey && item.publisher !== publisherKey)
        : [];
      await chromeApi.storage.local.set({
        [ACCESS_ENV_ANOMALY_KEY]: {
          updatedAt: new Date().toISOString(),
          events: recent.slice(-10),
          lastPublisher: publisherKey,
          paused: false
        }
      });
    }

    async function recordPublisherCfChallenge(pageUrl = '') {
      const opts = await getOptions();
      if (opts.watcherStopOnCfChallenge === false) {
        return { paused: false, streak: 0, threshold: 0, notified: false };
      }
      const stored = await chromeApi.storage.local.get([AUTO_WATCHER_STATE_KEY, 'watcherEnabled']);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      const threshold = Math.max(1, Number(opts.watcherCfPauseThreshold || defaultOptions.watcherCfPauseThreshold || 3));
      state.cfChallengeStreak = Number(state.cfChallengeStreak || 0) + 1;
      const reached = opts.watcherAdvancedSchedulerEnabled === true || state.cfChallengeStreak >= threshold;
      if (reached) {
        state.pausedByCfChallenge = true;
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
          ? `连续 ${state.cfChallengeStreak} 次遇到出版商验证页，已暂停低频值守。请完成验证后手动重新开启。`
          : `检测到出版商验证页（第 ${state.cfChallengeStreak} 次）。请恢复浏览器窗口并完成验证；达到 ${threshold} 次后会自动暂停值守。`;
        await notifyAccessEnvironmentAnomaly(message);
        notified = true;
      }
      return {
        paused: reached,
        streak: state.cfChallengeStreak,
        threshold,
        notified,
        pageUrl: urlHostPath(pageUrl || '')
      };
    }

    async function clearPublisherCfChallengeState() {
      const stored = await chromeApi.storage.local.get(AUTO_WATCHER_STATE_KEY);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      if (!state.cfChallengeStreak && !state.pausedByCfChallenge) return;
      state.cfChallengeStreak = 0;
      state.pausedByCfChallenge = false;
      await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
    }

    return {
      pauseWatcherForAccessEnvironment,
      recordAccessEnvironmentSuccess,
      recordPublisherCfChallenge,
      clearPublisherCfChallengeState
    };
  }

  globalThis.AblesciBackgroundUploadGuards = {
    createBackgroundUploadGuardsApi
  };
})(globalThis);
