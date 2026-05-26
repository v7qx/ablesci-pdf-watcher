'use strict';

// Responsibility: watcher runtime option normalization and scheduling helpers.
(function () {
  function createWatcherRuntimeHelpersApi(config) {
    const {
      depsRef,
      maxSessionCandidatesConst,
      defaultOptions,
      normalizeSharedOptions,
      clampNumber,
      normalizeListUrls,
      normalizeWorkdaysSet,
      normalizeWorkWindowsDetailed,
      isInWorkScheduleBySet,
      beijingMinutesNow,
      weekdayNumber,
      normalizeText,
      parseJournalAccessRules,
      nativeConfigTimeoutMs,
      countdownText,
      formatBeijingDateTime,
      todayKey,
      dailyCounterSnapshot
    } = config;

    function normalizeWorkdays(value) {
      return normalizeWorkdaysSet(value);
    }

    function normalizeWorkWindows(value) {
      return normalizeWorkWindowsDetailed(value);
    }

    function normalizeOptions(opts) {
      const shared = normalizeSharedOptions(opts || {});
      return {
        ...shared,
        watcherEnabled: shared.watcherEnabled === true,
        watcherListUrls: normalizeListUrls(shared.watcherListUrls, depsRef.defaultListUrls),
        watcherJournalAccessRules: String(shared.watcherJournalAccessRules || '').trim(),
        watcherWorkdays: normalizeWorkdays(shared.watcherWorkdays),
        watcherWorkWindows: normalizeWorkWindows(shared.watcherWorkWindows),
        watcherObserveTimes: [],
        watcherMaxPerSession: 1
      };
    }

    async function hydrateJournalAccessRulesFromConfig(opts) {
      if (!depsRef?.sendNativeMessage) return opts;
      try {
        const res = await depsRef.sendNativeMessage(opts.nativeHostName, {
          action: 'read_config_file',
          dir: '',
          config_path: '',
          filename: 'journal-access.json'
        }, nativeConfigTimeoutMs);
        if (!res?.body) return opts;
        const parsed = parseJournalAccessRules(res.body);
        const text = JSON.stringify(parsed, null, 2);
        return {
          ...opts,
          watcherJournalAccessRules: text,
          watcherJournalAccessRulesSource: res.path || 'journal-access.json'
        };
      } catch (_) {
        return {
          ...opts,
          watcherJournalAccessRulesSource: opts.watcherJournalAccessRules ? 'chrome.storage.local cache' : ''
        };
      }
    }

    function isInWorkSchedule(opts, date = new Date()) {
      if (opts?.watcherUseCalendarProgress) return true;
      if (!opts.watcherQuantSchedulerEnabled) return true;
      return isInWorkScheduleBySet(opts.watcherWorkdays, opts.watcherWorkWindows, date);
    }

    function nextWorkDelayMinutes(opts, date = new Date()) {
      if (opts?.watcherUseCalendarProgress) return null;
      if (!opts.watcherQuantSchedulerEnabled || isInWorkSchedule(opts, date)) return null;
      const nowMinute = beijingMinutesNow(date);
      const todayStart = opts.watcherWorkWindows.map(w => w.start).filter(start => start > nowMinute).sort((a, b) => a - b)[0];
      if (opts.watcherWorkdays.has(weekdayNumber(date)) && todayStart !== undefined) {
        return Math.max(1, todayStart - nowMinute + Math.random() * 5);
      }
      for (let d = 1; d <= 7; d += 1) {
        const next = new Date(date.getTime() + d * 24 * 60 * 60 * 1000);
        if (!opts.watcherWorkdays.has(weekdayNumber(next))) continue;
        const firstStart = opts.watcherWorkWindows.map(w => w.start).sort((a, b) => a - b)[0];
        const minutesUntilMidnight = 24 * 60 - nowMinute;
        return minutesUntilMidnight + (d - 1) * 24 * 60 + firstStart + Math.random() * 10;
      }
      return 60;
    }

    function logNormalMinutes(median, min, max) {
      const u1 = Math.max(1e-6, Math.random());
      const u2 = Math.max(1e-6, Math.random());
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const value = median * Math.exp(0.35 * normal);
      return Math.min(max, Math.max(min, value));
    }

    function weightedPickIndex(weights) {
      return weightedPickIndexWithDebug(weights).index;
    }

    function weightedPickIndexWithDebug(weights) {
      const normalized = weights.map(value => Math.max(0, Number(value) || 0));
      const total = normalized.reduce((sum, value) => sum + value, 0);
      if (total <= 0) return { index: 0, random: 0, total, weights: normalized };
      const random = Math.random() * total;
      let r = random;
      for (let i = 0; i < normalized.length; i += 1) {
        r -= normalized[i];
        if (r <= 0) return { index: i, random, total, weights: normalized };
      }
      return { index: normalized.length - 1, random, total, weights: normalized };
    }

    function maxSessionCandidates(opts) {
      return 1;
    }

    function dailyDownloadedFromState(state) {
      return Number(state?.daily?.[todayKey()]?.downloaded || 0);
    }

    function sessionExecutionCap(opts, state) {
      let cap = 1;
      const downloaded = dailyDownloadedFromState(state);
      if (Number(opts?.watcherDailyLimit || 0) > 0) {
        cap = Math.min(cap, Math.max(0, Number(opts.watcherDailyLimit || 0) - downloaded));
      }
      return Math.max(0, Math.floor(cap));
    }

    function quotaResetDelayMinutes(opts, date = new Date()) {
      const nowMinute = beijingMinutesNow(date);
      const minutesUntilMidnight = 24 * 60 - nowMinute;
      if (opts?.watcherUseCalendarProgress || !opts?.watcherQuantSchedulerEnabled) return Math.max(1, minutesUntilMidnight + Math.random() * 5);
      for (let d = 1; d <= 8; d += 1) {
        const next = new Date(date.getTime() + d * 24 * 60 * 60 * 1000);
        if (!opts.watcherWorkdays.has(weekdayNumber(next))) continue;
        const firstStart = opts.watcherWorkWindows.map(w => w.start).sort((a, b) => a - b)[0] ?? 0;
        return Math.max(1, minutesUntilMidnight + (d - 1) * 24 * 60 + firstStart + Math.random() * 10);
      }
      return Math.max(1, minutesUntilMidnight + Math.random() * 5);
    }

    function isAssistDue(state = null) {
      const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
      return !Number.isFinite(nextAssistMs) || nextAssistMs <= Date.now() + 1000;
    }

    function targetStateSnapshot(state = {}) {
      return {
        schedulerModelMode: state.schedulerModelMode || '',
        speedMode: state.speedMode || '',
        todayTarget: 0,
        hourTarget: 0,
        rateMultiplier: 1,
        targetError: state.targetError ?? state.lag ?? 0,
        lag: state.lag ?? state.targetError ?? 0,
        workTimeProgressRatio: state.workTimeProgressRatio || 0,
        activeTimeProgressRatio: state.activeTimeProgressRatio || 0,
        availabilityFactor: state.availabilityFactor || 1,
        availabilityActualWakeCount: state.availabilityActualWakeCount || 0,
        availabilityExpectedWakeCount: state.availabilityExpectedWakeCount || 0,
        demandFactor: 1,
        trendFactor: 1,
        marketRegime: '',
        recentH1DemandDelta: 0,
        recentD1DemandDelta: 0,
        riskUsed: state.riskUsed || 0,
        riskLimit: state.riskLimit || 0,
        riskRemaining: state.riskRemaining || 0,
        riskExhausted: state.riskExhausted === true
      };
    }

    function mergeFrozenTargetState(liveTarget, frozenTarget) {
      if (!frozenTarget) return liveTarget;
      return {
        ...liveTarget,
        ...frozenTarget,
        expectedDone: liveTarget.expectedDone ?? frozenTarget.expectedDone,
        actualDone: liveTarget.actualDone ?? liveTarget.monthDone,
        monthDone: liveTarget.monthDone,
        targetError: liveTarget.targetError ?? liveTarget.lag ?? frozenTarget.targetError ?? frozenTarget.lag ?? 0,
        lag: liveTarget.lag ?? liveTarget.targetError ?? frozenTarget.lag ?? frozenTarget.targetError ?? 0,
        todayTarget: 0,
        hourTarget: 0,
        rateMultiplier: 1,
        demandFactor: 1,
        trendFactor: 1,
        marketRegime: '',
        recentH1DemandDelta: 0,
        recentD1DemandDelta: 0,
        riskUsed: liveTarget.riskUsed ?? frozenTarget.riskUsed,
        riskLimit: liveTarget.riskLimit ?? frozenTarget.riskLimit,
        riskRemaining: liveTarget.riskRemaining ?? frozenTarget.riskRemaining,
        riskExhausted: liveTarget.riskExhausted === true
      };
    }

    function checkShortTermRateLimit(state) {
      const recent = Array.isArray(state?.recentDownloads) ? state.recentDownloads : [];
      const now = Date.now();
      const cutoff = now - 30 * 60 * 1000;
      const valid = recent.filter(t => t >= cutoff && t <= now);
      
      const count1m = valid.filter(t => t >= now - 1 * 60 * 1000).length;
      if (count1m >= 1) {
        return { limited: true, window: '1m', count: count1m, limit: 1 };
      }
      
      const count5m = valid.filter(t => t >= now - 5 * 60 * 1000).length;
      if (count5m >= 10) {
        return { limited: true, window: '5m', count: count5m, limit: 10 };
      }
      
      const count30m = valid.filter(t => t >= now - 30 * 60 * 1000).length;
      if (count30m >= 15) {
        return { limited: true, window: '30m', count: count30m, limit: 15 };
      }
      
      return { limited: false };
    }

    function nextRateLimitClearDelayMinutes(state) {
      const recent = Array.isArray(state?.recentDownloads) ? state.recentDownloads : [];
      const now = Date.now();
      const cutoff = now - 30 * 60 * 1000;
      const valid = recent.filter(t => t >= cutoff && t <= now);
      const sorted = [...valid].sort((a, b) => b - a);
      
      let maxDelayMs = 0;
      
      const count1m = sorted.filter(t => t >= now - 1 * 60 * 1000).length;
      if (count1m >= 1) {
        const delay = (sorted[0] + 1 * 60 * 1000) - now;
        if (delay > maxDelayMs) maxDelayMs = delay;
      }
      
      const count5m = sorted.filter(t => t >= now - 5 * 60 * 1000).length;
      if (count5m >= 10) {
        const delay = (sorted[9] + 5 * 60 * 1000) - now;
        if (delay > maxDelayMs) maxDelayMs = delay;
      }
      
      const count30m = sorted.filter(t => t >= now - 30 * 60 * 1000).length;
      if (count30m >= 15) {
        const delay = (sorted[14] + 30 * 60 * 1000) - now;
        if (delay > maxDelayMs) maxDelayMs = delay;
      }
      
      if (maxDelayMs <= 0) return 0;
      return maxDelayMs / 60000;
    }

    return {
      normalizeOptions,
      hydrateJournalAccessRulesFromConfig,
      normalizeWorkdays,
      normalizeWorkWindows,
      isInWorkSchedule,
      nextWorkDelayMinutes,
      logNormalMinutes,
      weightedPickIndex,
      weightedPickIndexWithDebug,
      maxSessionCandidates,
      dailyDownloadedFromState,
      sessionExecutionCap,
      quotaResetDelayMinutes,
      isAssistDue,
      targetStateSnapshot,
      mergeFrozenTargetState,
      checkShortTermRateLimit,
      nextRateLimitClearDelayMinutes
    };
  }

  globalThis.AblesciWatcherRuntimeHelpersModule = {
    createWatcherRuntimeHelpersApi
  };
}());
