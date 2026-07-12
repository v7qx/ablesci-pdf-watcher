'use strict';

// Responsibility: target progress math and candidate source helpers used by the auto watcher.
(function () {
  function createWatcherTargetApi(config) {
    const {
      todayKey,
      normalizeText,
      clampNumber,
      formatBeijingDateTime,
      riskSnapshot,
      publisherAlias
    } = config;

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
        .reduce((sum, [, value]) => sum + Number(value.uploaded || 0), 0);
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

    function monthRunCount(state) {
      const prefix = monthKey() + '-';
      return Object.entries(state.daily || {})
        .filter(([key]) => key.startsWith(prefix))
        .reduce((sum, [, value]) => sum + Number(value.totalRuns || 0), 0);
    }

    function availabilitySnapshot(state, opts, progressDetails = null) {
      const details = progressDetails || calendarProgressDetails();
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

    function speedModeFromTarget({ error, monthlyTarget, riskExhausted = false }) {
      if (riskExhausted) return 'normal';
      const severeLag = Math.max(20, Math.max(1, Number(monthlyTarget || 0)) * 0.12);
      if (error >= severeLag) return 'fast';
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
      const progress = calendarProgressDetails();
      const availability = availabilitySnapshot(state, opts, progress);
      const effectiveProgress = availability.enoughData ? availability.activeTimeProgressRatio : progress.ratio;
      const expectedDone = effectiveTarget;
      const lag = expectedDone - done;
      // The 20% pressure factor only influences adaptive speed selection. User-facing
      // expected/deficit values must continue to reflect the configured monthly target.
      const pressureTarget = Math.round(effectiveTarget * 1.2);
      const pressureLag = pressureTarget - done;

      const key = todayKey();
      const [year, month, day] = key.split('-').map(Number);
      const daysInMonth = new Date(year, month, 0).getDate();
      const remainingCalendarDays = Math.max(1, daysInMonth - day + 1);
      const calculatedTodayTarget = Math.max(0, Math.ceil((monthlyTarget - done) / remainingCalendarDays));
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
          calendarProgressRatio: Number(progress.ratio.toFixed(4)),
          activeTimeProgressRatio: availability.activeTimeProgressRatio,
          availabilityFactor: availability.availabilityFactor,
          schedulerModelMode: 'calendar_target',
          actualDone: done,
          targetError: 0,
          todayTarget: 0,
          riskLimit
        };
      }
      const rawSpeedMode = speedModeFromTarget({ error: pressureLag, monthlyTarget: pressureTarget || monthlyTarget });
      const speedMode = determineSpeedMode(state, opts, rawSpeedMode);
      return {
        monthKey: monthKey(),
        monthDone: done,
        actualDone: done,
        expectedDone,
        lag,
        targetError: lag,
        speedMode,
        calendarProgressRatio: Number(progress.ratio.toFixed(4)),
        activeTimeProgressRatio: availability.activeTimeProgressRatio,
        availabilityFactor: availability.availabilityFactor,
        todayTarget: calculatedTodayTarget,
        riskLimit,
        schedulerModelMode: 'calendar_target'
      };
    }

    function candidateSource(candidate, payload = null) {
      return publisherAlias(payload?.publisherName || payload?.journalName || candidate?.publisherName || candidate?.journalShortName || candidate?.rowText || candidate?.title || '');
    }

    return {
      monthKey,
      monthDone,
      daysInCurrentMonth,
      calendarProgressDetails,
      monthRunCount,
      availabilitySnapshot,
      speedModeFromTarget,
      calculateTargetState,
      candidateSource
    };
  }

  globalThis.AblesciWatcherTargetModule = {
    createWatcherTargetApi
  };
}());
