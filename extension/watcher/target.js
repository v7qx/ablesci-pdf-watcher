'use strict';

// Responsibility: target progress math and candidate source helpers used by the auto watcher.
(function () {
  function createWatcherTargetApi(config) {
    const {
      todayKey,
      normalizeText,
      clampNumber,
      formatBeijingDateTime,
      beijingMinutesNow,
      weekdayNumber,
      riskSnapshot
    } = config;

    function publisherAliasLocal(name) {
      const s = normalizeText(name);
      if (!s) return 'Unknown';
      if (/elsevier|science\s*direct/i.test(s)) return 'Elsevier';
      if (/wiley/i.test(s)) return 'Wiley';
      if (/springer/i.test(s)) return 'Springer';
      if (/nature/i.test(s)) return 'Nature';
      if (/oxford/i.test(s)) return 'Oxford';
      if (/ieee/i.test(s)) return 'IEEE';
      if (/\brsc\b|royal\s+society\s+of\s+chemistry|pubs\.rsc\.org/i.test(s)) return 'RSC';
      return s.split(/[\/|,，;；\s]+/).filter(Boolean)[0] || 'Unknown';
    }

    function monthKey() {
      return todayKey().slice(0, 7);
    }

    function monthDone(state, opts) {
      const currentMonth = monthKey();
      if (state.firstSyncTotalAssists && state.firstSyncTotalAssists[currentMonth] !== undefined &&
          state.actualTotalAssists !== undefined) {
        const firstSyncTotal = state.firstSyncTotalAssists[currentMonth];
        return Math.max(0, state.actualTotalAssists - firstSyncTotal);
      }
      if (state.monthlyInitialAssists && state.monthlyInitialAssists[currentMonth] !== undefined && state.actualTotalAssists !== undefined) {
        return Math.max(0, state.actualTotalAssists - state.monthlyInitialAssists[currentMonth]);
      }
      const prefix = currentMonth + '-';
      return Object.entries(state.daily || {})
        .filter(([key]) => key.startsWith(prefix))
        .reduce((sum, [, value]) => sum + Number(value.downloaded || 0), 0);
    }

    function firstSyncProgressRatio(state) {
      const currentMonth = monthKey();
      const raw = state.firstSyncProgressRatio && state.firstSyncProgressRatio[currentMonth];
      return Math.max(0, Math.min(1, Number(raw || 0)));
    }

    function effectiveMonthlyTarget(state, monthlyTarget) {
      const target = Math.max(0, Number(monthlyTarget || 0));
      const ratio = firstSyncProgressRatio(state);
      if (ratio <= 0) return target;
      return Math.round(target * Math.max(0, 1 - ratio));
    }

    function daysInCurrentMonth() {
      const [year, month] = monthKey().split('-').map(Number);
      return new Date(year, month, 0).getDate();
    }

    function calendarProgressDetails(date = new Date()) {
      const year = date.getFullYear();
      const month = date.getMonth();
      const startOfMonth = new Date(year, month, 1);
      const startOfNextMonth = new Date(year, month + 1, 1);
      const totalMonthMs = startOfNextMonth.getTime() - startOfMonth.getTime();
      const currentMs = date.getTime() - startOfMonth.getTime();
      const ratio = totalMonthMs > 0 ? Math.max(0, Math.min(1, currentMs / totalMonthMs)) : 0;
      const totalMinutes = Math.round(totalMonthMs / (60 * 1000));
      const elapsedMinutes = Math.round(currentMs / (60 * 1000));
      return { ratio, elapsedMinutes, totalMinutes };
    }

    function workMinutesForDay(opts) {
      return opts.watcherWorkWindows.reduce((sum, win) => sum + Math.max(0, win.end - win.start), 0);
    }

    function workTimeProgressDetails(opts, date = new Date()) {
      const key = todayKey();
      const [year, month, day] = key.split('-').map(Number);
      let total = 0;
      let elapsed = 0;
      const nowMinute = beijingMinutesNow(date);
      const days = new Date(year, month, 0).getDate();
      for (let d = 1; d <= days; d += 1) {
        const current = new Date(year, month - 1, d, 12, 0, 0);
        if (!opts.watcherWorkdays.has(weekdayNumber(current))) continue;
        const dayMinutes = workMinutesForDay(opts);
        total += dayMinutes;
        if (d < day) elapsed += dayMinutes;
        if (d === day) {
          for (const win of opts.watcherWorkWindows) {
            elapsed += Math.max(0, Math.min(nowMinute, win.end) - win.start);
          }
        }
      }
      const ratio = total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 0;
      return { ratio, elapsedMinutes: elapsed, totalMinutes: total };
    }

    function workTimeProgressRatio(opts, date = new Date()) {
      return workTimeProgressDetails(opts, date).ratio;
    }

    function monthRunCount(state) {
      const prefix = monthKey() + '-';
      return Object.entries(state.daily || {})
        .filter(([key]) => key.startsWith(prefix))
        .reduce((sum, [, value]) => sum + Number(value.totalRuns || 0), 0);
    }

    function availabilitySnapshot(state, opts, progressDetails = null) {
      const details = progressDetails || workTimeProgressDetails(opts);
      const elapsed = Number(details.elapsedMinutes || 0);
      const expectedInterval = Math.max(1, Number(opts.watcherMinIntervalMinutes || opts.watcherIntervalMinutes || 5));
      const expectedWakeCount = elapsed > 0
        ? Math.max(1, elapsed / expectedInterval)
        : 0;
      const actualWakeCount = monthRunCount(state);
      const enoughData = expectedWakeCount >= 6 && actualWakeCount >= 3;
      const rawAvailability = expectedWakeCount > 0 ? actualWakeCount / expectedWakeCount : 1;
      const availabilityFactor = enoughData ? Math.max(0.25, Math.min(1, rawAvailability)) : 1;
      const activeTimeProgressRatio = Math.max(0, Math.min(1, Number(details.ratio || 0) * availabilityFactor));
      return {
        expectedWakeCount: Number(expectedWakeCount.toFixed(2)),
        actualWakeCount,
        rawAvailability: Number(rawAvailability.toFixed(3)),
        availabilityFactor: Number(availabilityFactor.toFixed(3)),
        activeTimeProgressRatio: Number(activeTimeProgressRatio.toFixed(4)),
        enoughData
      };
    }

    function lagThresholds(monthlyTarget) {
      const target = Math.max(1, Number(monthlyTarget || 0));
      return {
        medium: Math.max(10, target * 0.04),
        severe: Math.max(20, target * 0.12),
        ahead: Math.max(10, target * 0.05)
      };
    }

    function speedModeFromTarget({ error, monthlyTarget, riskExhausted = false, rateMultiplier = 1 }) {
      if (riskExhausted) return 'normal';
      const thresholds = lagThresholds(monthlyTarget);
      if (error >= thresholds.severe || rateMultiplier >= 1.55) return 'fast';
      if (error >= thresholds.medium) return 'normal';
      return 'normal';
    }

    function determineSpeedMode(state, opts, calculatedSpeedMode) {
      const configMode = opts?.watcherSpeedMode || 'adaptive';
      if (configMode === 'adaptive') {
        const downloadedAuto = Number(state?.daily?.[todayKey()]?.downloadedAuto || 0);
        if (downloadedAuto === 0) {
          return 'fast';
        }
        return calculatedSpeedMode;
      }
      return configMode;
    }
    function calculateTargetState(state, opts) {
      const done = monthDone(state, opts);
      const monthlyTarget = Number(opts.watcherMonthlyTarget || 0);
      const effectiveTarget = effectiveMonthlyTarget(state, monthlyTarget);
      const progress = opts?.watcherUseCalendarProgress ? calendarProgressDetails() : workTimeProgressDetails(opts);
      const availability = availabilitySnapshot(state, opts, progress);
      const effectiveProgress = availability.enoughData ? availability.activeTimeProgressRatio : progress.ratio;
      const firstSyncRatio = firstSyncProgressRatio(state);
      const expectedDone = firstSyncRatio > 0
        ? effectiveTarget
        : Math.round(monthlyTarget * Math.min(1, effectiveProgress));
      const lag = expectedDone - done;

      const key = todayKey();
      const [year, month, day] = key.split('-').map(Number);
      const daysInMonth = new Date(year, month, 0).getDate();
      let remainingWorkdays = 0;
      for (let d = 1; d <= daysInMonth; d += 1) {
        const current = new Date(year, month - 1, d, 12, 0, 0);
        if (opts.watcherWorkdays && opts.watcherWorkdays.has && opts.watcherWorkdays.has(weekdayNumber(current))) {
          if (d >= day) {
            remainingWorkdays += 1;
          }
        }
      }
      const calculatedTodayTarget = Math.max(0, Math.ceil((monthlyTarget - done) / Math.max(1, remainingWorkdays)));
      const riskLimit = Number(opts.watcherRiskBudgetLimit || 10);

      if (monthlyTarget <= 0) {
        const rawSpeedMode = 'normal';
        const speedMode = determineSpeedMode(state, opts, rawSpeedMode);
        return {
          monthKey: monthKey(),
          monthDone: done,
          expectedDone: 0,
          lag: 0,
          speedMode,
          workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
          activeTimeProgressRatio: availability.activeTimeProgressRatio,
          availabilityFactor: availability.availabilityFactor,
          schedulerModelMode: 'calendar_target',
          actualDone: done,
          targetError: 0,
          todayTarget: 0,
          riskLimit,
          rateMultiplier: 1
        };
      }
      const rawSpeedMode = speedModeFromTarget({ error: lag, monthlyTarget: effectiveTarget || monthlyTarget });
      const speedMode = determineSpeedMode(state, opts, rawSpeedMode);
      return {
        monthKey: monthKey(),
        monthDone: done,
        actualDone: done,
        expectedDone,
        lag,
        targetError: lag,
        speedMode,
        workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
        activeTimeProgressRatio: availability.activeTimeProgressRatio,
        availabilityFactor: availability.availabilityFactor,
        availabilityExpectedWakeCount: availability.expectedWakeCount,
        availabilityActualWakeCount: availability.actualWakeCount,
        todayTarget: calculatedTodayTarget,
        riskLimit,
        schedulerModelMode: 'calendar_target',
        rateMultiplier: 1
      };
    }

    function calculateAdvancedTargetState(state, opts) {
      return calculateTargetState(state, opts);
    }

    function candidateSource(candidate, payload = null) {
      return publisherAliasLocal(payload?.publisherName || payload?.journalName || candidate?.publisherName || candidate?.journalShortName || candidate?.rowText || candidate?.title || '');
    }

    return {
      monthKey,
      monthDone,
      daysInCurrentMonth,
      workMinutesForDay,
      calendarProgressDetails,
      workTimeProgressDetails,
      workTimeProgressRatio,
      monthRunCount,
      availabilitySnapshot,
      lagThresholds,
      speedModeFromTarget,
      calculateTargetState,
      calculateAdvancedTargetState,
      candidateSource
    };
  }

  globalThis.AblesciWatcherTargetModule = {
    createWatcherTargetApi
  };
}());
