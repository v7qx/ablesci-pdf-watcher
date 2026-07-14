'use strict';

// Watcher guard helpers used by the upload pipeline.
(function initBackgroundUploadGuards(globalThis) {
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const PUBLISHER_DAILY_LIMIT_STOPS_KEY = 'publisherDailyLimitStops';
  const SCIENCEDIRECT_GUARD_STATE_KEY = 'scienceDirectDownloadGuardState';
  const SCIENCEDIRECT_SITE_SNAPSHOT_KEY = 'scienceDirectSiteCountSnapshot';
  const SCIENCEDIRECT_DAILY_LIMIT = 100;
  const ACCESS_ENV_NOTIFICATION_ICON_URL = 'icons/icon128.png';

  function createBackgroundUploadGuardsApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      getOptions,
      urlHostPath
    } = deps;
    let scienceDirectReservationQueue = Promise.resolve();

    function localDateKey(date = new Date()) {
      return `${date.getFullYear()}_${date.getMonth() + 1}_${date.getDate()}`;
    }

    function nextLocalDayAt(date = new Date()) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
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

    async function recordPublisherDailyLimit(details = {}) {
      // PRIVATE_WATCHER_ONLY
      const reason = String(details.reason || 'daily_count_reached');
      if (/counter_unavailable/.test(reason)) {
        return {
          paused: false,
          temporary: true,
          publisher: String(details.publisher || 'elsevier').trim().toLowerCase() || 'elsevier',
          reason
        };
      }
      const stored = await chromeApi.storage.local.get(PUBLISHER_DAILY_LIMIT_STOPS_KEY);
      const stops = stored[PUBLISHER_DAILY_LIMIT_STOPS_KEY] && typeof stored[PUBLISHER_DAILY_LIMIT_STOPS_KEY] === 'object'
        ? stored[PUBLISHER_DAILY_LIMIT_STOPS_KEY]
        : {};
      const publisherKey = String(details.publisher || 'elsevier').trim().toLowerCase() || 'elsevier';
      const effectiveCount = Math.max(0, Number(details.effectiveCount || 0));
      const limit = Math.max(1, Number(details.limit || 100));
      const expiresAt = Number(details.expiresAt || 0);
      const now = new Date();
      const nextLocalDayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
      stops[publisherKey] = {
        reason,
        siteCount: Number.isFinite(Number(details.siteCount)) ? Number(details.siteCount) : null,
        directAttempts: Math.max(0, Number(details.directAttempts || 0)),
        effectiveCount,
        limit,
        dateKey: String(details.dateKey || ''),
        expiresAt: Number.isFinite(expiresAt) && expiresAt > Date.now() ? expiresAt : nextLocalDayAt,
        detectedAt: new Date().toISOString(),
        pageUrl: urlHostPath(details.pageUrl || '')
      };
      await chromeApi.storage.local.set({ [PUBLISHER_DAILY_LIMIT_STOPS_KEY]: stops });
      const message = reason === 'daily_bulk_download_limit_dialog'
        ? 'ScienceDirect 已显示当日下载限制弹窗，已暂停 ScienceDirect；其他出版社继续。次日自动恢复。'
        : `ScienceDirect 当日下载计数已达到 ${effectiveCount}/${limit}，已暂停 ScienceDirect；其他出版社继续。次日自动恢复。`;
      await notifyAccessEnvironmentAnomaly(message);
      return {
        paused: true,
        publisher: publisherKey,
        effectiveCount,
        limit,
        expiresAt: stops[publisherKey].expiresAt
      };
    }

    async function reserveScienceDirectAttemptUnsafe(details = {}) {
      const date = details.date instanceof Date ? details.date : new Date();
      const dateKey = localDateKey(date);
      const limit = Math.max(1, Number(details.limit || SCIENCEDIRECT_DAILY_LIMIT));
      try {
        const stored = await chromeApi.storage.local.get([
          SCIENCEDIRECT_GUARD_STATE_KEY,
          SCIENCEDIRECT_SITE_SNAPSHOT_KEY
        ]);
        const directState = stored[SCIENCEDIRECT_GUARD_STATE_KEY];
        const siteSnapshot = stored[SCIENCEDIRECT_SITE_SNAPSHOT_KEY];
        const parsedDirectAttempts = Number.parseInt(directState?.directAttempts, 10);
        const parsedSiteCount = Number.parseInt(siteSnapshot?.siteCount, 10);
        if (directState?.dateKey === dateKey && (!Number.isFinite(parsedDirectAttempts) || parsedDirectAttempts < 0)) {
          throw new Error('invalid direct counter state');
        }
        if (siteSnapshot?.dateKey === dateKey && (!Number.isFinite(parsedSiteCount) || parsedSiteCount < 0)) {
          throw new Error('invalid site counter snapshot');
        }
        const directAttempts = directState?.dateKey === dateKey ? parsedDirectAttempts : 0;
        const storedSiteCount = siteSnapshot?.dateKey === dateKey ? parsedSiteCount : 0;
        const observedSiteCount = details.observedSiteCount === undefined || details.observedSiteCount === null
          ? 0
          : Number(details.observedSiteCount);
        if (!Number.isFinite(observedSiteCount) || observedSiteCount < 0) throw new Error('invalid observed site counter');
        const siteCount = Math.max(storedSiteCount, observedSiteCount);
        const effectiveCount = siteCount + directAttempts;
        const base = {
          siteCount,
          directAttempts,
          effectiveCount,
          limit,
          dateKey,
          expiresAt: nextLocalDayAt(date)
        };
        if (effectiveCount >= limit) {
          return { ...base, blocked: true, reason: 'daily_count_reached' };
        }
        const attemptKind = details.attemptKind === 'site' ? 'site' : 'direct';
        const nextDirectAttempts = directAttempts + (attemptKind === 'direct' ? 1 : 0);
        const nextSiteCount = siteCount + (attemptKind === 'site' ? 1 : 0);
        await chromeApi.storage.local.set({
          [SCIENCEDIRECT_GUARD_STATE_KEY]: {
            dateKey,
            directAttempts: nextDirectAttempts,
            updatedAt: date.getTime()
          },
          [SCIENCEDIRECT_SITE_SNAPSHOT_KEY]: {
            dateKey,
            siteCount: nextSiteCount,
            updatedAt: date.getTime()
          }
        });
        return {
          ...base,
          blocked: false,
          reason: '',
          directAttempts: nextDirectAttempts,
          siteCount: nextSiteCount,
          effectiveCount: effectiveCount + 1
        };
      } catch (_) {
        return {
          blocked: true,
          reason: 'direct_counter_unavailable',
          siteCount: null,
          directAttempts: 0,
          effectiveCount: 0,
          limit,
          dateKey,
          expiresAt: nextLocalDayAt(date)
        };
      }
    }

    function reserveScienceDirectAttempt(details = {}) {
      const reservation = scienceDirectReservationQueue.then(
        () => reserveScienceDirectAttemptUnsafe(details),
        () => reserveScienceDirectAttemptUnsafe(details)
      );
      scienceDirectReservationQueue = reservation.then(() => undefined, () => undefined);
      return reservation;
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
      recordPublisherDailyLimit,
      reserveScienceDirectAttempt,
      clearPublisherCfChallengeState
    };
  }

  globalThis.AblesciBackgroundUploadGuards = {
    createBackgroundUploadGuardsApi
  };
})(globalThis);
