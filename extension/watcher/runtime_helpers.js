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

    function normalizeObserveTimes(value) {
      const raw = Array.isArray(value) ? value : String(value || '09:30\n11:30\n14:00\n16:30\n18:00').split(/\r?\n|,/);
      const values = raw
        .map(item => String(item || '').trim())
        .filter(item => /^([01]\d|2[0-3]):[0-5]\d$/.test(item));
      return Array.from(new Set(values)).sort();
    }

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
        watcherObserveTimes: normalizeObserveTimes(shared.watcherObserveTimes),
        watcherWorkdays: normalizeWorkdays(shared.watcherWorkdays),
        watcherWorkWindows: normalizeWorkWindows(shared.watcherWorkWindows),
        watcherMaxPerSession: clampNumber(shared.watcherMaxPerSession, 1, 1, maxSessionCandidatesConst)
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
      if (!opts.watcherQuantSchedulerEnabled) return true;
      return isInWorkScheduleBySet(opts.watcherWorkdays, opts.watcherWorkWindows, date);
    }

    function nextWorkDelayMinutes(opts, date = new Date()) {
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
      return Math.round(clampNumber(opts?.watcherMaxPerSession, 1, 1, maxSessionCandidatesConst));
    }

    function dailyDownloadedFromState(state) {
      return Number(state?.daily?.[todayKey()]?.downloaded || 0);
    }

    function sessionExecutionCap(opts, state, respectTodayTarget = true) {
      let cap = maxSessionCandidates(opts);
      const downloaded = dailyDownloadedFromState(state);
      if (Number(opts?.watcherDailyLimit || 0) > 0) {
        cap = Math.min(cap, Math.max(0, Number(opts.watcherDailyLimit || 0) - downloaded));
      }
      if (respectTodayTarget && Number(state?.todayTarget || 0) > 0) {
        cap = Math.min(cap, Math.max(0, Number(state.todayTarget || 0) - downloaded));
      }
      return Math.max(0, Math.floor(cap));
    }

    function quotaResetDelayMinutes(opts, date = new Date()) {
      const nowMinute = beijingMinutesNow(date);
      const minutesUntilMidnight = 24 * 60 - nowMinute;
      if (!opts?.watcherQuantSchedulerEnabled) return Math.max(1, minutesUntilMidnight + Math.random() * 5);
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
        todayTarget: state.todayTarget || 0,
        hourTarget: state.hourTarget || 0,
        rateMultiplier: state.rateMultiplier || 1,
        targetError: state.targetError ?? state.lag ?? 0,
        lag: state.lag ?? state.targetError ?? 0,
        workTimeProgressRatio: state.workTimeProgressRatio || 0,
        activeTimeProgressRatio: state.activeTimeProgressRatio || 0,
        availabilityFactor: state.availabilityFactor || 1,
        availabilityActualWakeCount: state.availabilityActualWakeCount || 0,
        availabilityExpectedWakeCount: state.availabilityExpectedWakeCount || 0,
        demandFactor: state.demandFactor || 1,
        trendFactor: state.trendFactor || 1,
        marketRegime: state.marketRegime || state.marketData?.marketRegime || state.demandRegime || '',
        recentH1DemandDelta: state.recentH1DemandDelta || state.marketData?.h1Delta || 0,
        recentD1DemandDelta: state.recentD1DemandDelta || state.marketData?.d1Delta || 0,
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
        actualDone: liveTarget.actualDone ?? liveTarget.monthDone,
        monthDone: liveTarget.monthDone,
        riskUsed: liveTarget.riskUsed ?? frozenTarget.riskUsed,
        riskLimit: liveTarget.riskLimit ?? frozenTarget.riskLimit,
        riskRemaining: liveTarget.riskRemaining ?? frozenTarget.riskRemaining,
        riskExhausted: liveTarget.riskExhausted === true
      };
    }

    return {
      normalizeOptions,
      hydrateJournalAccessRulesFromConfig,
      normalizeObserveTimes,
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
      mergeFrozenTargetState
    };
  }

  globalThis.AblesciWatcherRuntimeHelpersModule = {
    createWatcherRuntimeHelpersApi
  };
}());
