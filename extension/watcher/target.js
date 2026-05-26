'use strict';

// Responsibility: target progress math, market-snapshot aggregation, and
// bandit scoring helpers used by the auto watcher.
(function () {
  function createWatcherTargetApi(config) {
    const {
      chromeApi,
      demandSnapshotsKey,
      maxDemandSnapshots,
      marketRawRetentionMs,
      marketTopPublishers,
      fallbackPublisherWeights,
      advancedModelMinDays,
      todayKey,
      normalizeText,
      clampNumber,
      formatBeijingDateTime,
      beijingMinutesNow,
      weekdayNumber,
      demandFactorByRegime,
      trendFactorFromModel,
      riskSnapshot,
      journalAccessRuleFor,
      getWatcherState,
      saveWatcherState
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

    function aggregatePublisherCountsLocal(counts) {
      const out = {};
      for (const [name, count] of Object.entries(counts || {})) {
        const alias = publisherAliasLocal(name);
        out[alias] = (out[alias] || 0) + Math.max(0, Number(count) || 0);
      }
      return out;
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

    async function getDemandSnapshots() {
      const stored = await chromeApi.storage.local.get(demandSnapshotsKey);
      return Array.isArray(stored[demandSnapshotsKey]) ? stored[demandSnapshotsKey] : [];
    }

    function percentileRank(values, value) {
      const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (!nums.length || !Number.isFinite(value)) return 0.5;
      const below = nums.filter(n => n <= value).length;
      return below / nums.length;
    }

    function medianNumber(values) {
      const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      if (!nums.length) return null;
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
    }

    function sumNumbers(values) {
      return values.map(Number).filter(Number.isFinite).reduce((sum, n) => sum + n, 0);
    }

    function floorTime(value, intervalMs) {
      const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
      if (!Number.isFinite(t)) return 0;
      return Math.floor(t / intervalMs) * intervalMs;
    }

    function candleFromSamples(samples, intervalMs, field) {
      const groups = new Map();
      for (const sample of samples) {
        const t = new Date(sample.timestamp).getTime();
        if (!Number.isFinite(t)) continue;
        const key = floorTime(t, intervalMs);
        const value = Number(field(sample));
        const list = groups.get(key) || [];
        list.push({ t, value, valid: Number.isFinite(value) && value >= 0 });
        groups.set(key, list);
      }
      return Array.from(groups.entries()).sort((a, b) => b[0] - a[0]).map(([start, list]) => {
        const ordered = list.sort((a, b) => a.t - b.t);
        const valid = ordered.filter(item => item.valid);
        const values = valid.map(item => item.value);
        const open = values.length ? values[0] : null;
        const close = values.length ? values[values.length - 1] : null;
        const high = values.length ? Math.max(...values) : null;
        const low = values.length ? Math.min(...values) : null;
        const delta = open === null || close === null ? null : close - open;
        const range = high === null || low === null ? null : high - low;
        return {
          start: new Date(start).toISOString(),
          end: new Date(start + intervalMs).toISOString(),
          open,
          high,
          low,
          close,
          delta,
          range,
          absMove: delta === null ? null : Math.abs(delta),
          sampleCount: ordered.length,
          validSampleCount: valid.length
        };
      });
    }

    function demandSnapshotDays(snapshots) {
      return new Set((snapshots || [])
        .map(item => item.dayKey || formatBeijingDateTime(item.timestamp, true))
        .filter(Boolean));
    }

    function demandRegimeFor(snapshot, history) {
      const stableHistory = history.filter(item => !item.demandAnomaly);
      const p = percentileRank(stableHistory.map(item => item.totalSeeking), snapshot?.totalSeeking);
      if (p < 0.20) return 'quiet';
      if (p < 0.70) return 'normal';
      if (p < 0.90) return 'busy';
      return 'very_busy';
    }

    function classifyDemandSnapshotAnomaly(snapshot, history) {
      const value = Number(snapshot?.totalSeeking);
      if (!Number.isFinite(value) || value <= 0) {
        return { ok: false, type: 'invalid_total', value };
      }
      const recent = (history || [])
        .filter(item => !item.demandAnomaly && Number.isFinite(Number(item.totalSeeking)) && Number(item.totalSeeking) > 0)
        .slice(0, 60);
      if (!recent.length) return { ok: true };
      const latest = Number(recent[0].totalSeeking);
      if (recent.length < 3) {
        const diff = Math.abs(value - latest);
        if (value >= latest * 4 && diff >= 100) return { ok: false, type: 'sudden_high', value, baseline: latest };
        if (value <= latest * 0.2 && diff >= 100) return { ok: false, type: 'sudden_low', value, baseline: latest };
        return { ok: true };
      }
      const values = recent.map(item => Number(item.totalSeeking));
      const median = medianNumber(values);
      const deviations = values.map(n => Math.abs(n - median));
      const mad = medianNumber(deviations) || 0;
      const absoluteBand = Math.max(120, mad * 6);
      if (value > Math.max(median * 2.8, median + absoluteBand)) {
        return { ok: false, type: 'sudden_high', value, baseline: median, mad };
      }
      if (value < Math.min(median * 0.35, median - absoluteBand)) {
        return { ok: false, type: 'sudden_low', value, baseline: median, mad };
      }
      return { ok: true };
    }

    function topPublishersFromSamples(samples, topN = marketTopPublishers) {
      const totals = {};
      for (const sample of samples) {
        const counts = aggregatePublisherCountsLocal(sample.publisherCounts);
        for (const [name, count] of Object.entries(counts)) totals[name] = (totals[name] || 0) + count;
      }
      return Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([name]) => name);
    }

    function minuteOfDayFromTimestamp(value) {
      const s = formatBeijingDateTime(value);
      const m = s.match(/\s(\d{2}):(\d{2}):/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
    }

    function sameSlotPercentile(samples, current) {
      const currentValue = Number(current?.totalSeeking);
      if (!Number.isFinite(currentValue)) return 0.5;
      const minute = minuteOfDayFromTimestamp(current.timestamp);
      const values = samples
        .filter(item => item !== current && !item.demandAnomaly)
        .filter(item => Math.abs(minuteOfDayFromTimestamp(item.timestamp) - minute) <= 30)
        .map(item => item.totalSeeking);
      return percentileRank(values, currentValue);
    }

    function buildMarketDataModel(snapshots) {
      const now = Date.now();
      const raw = (snapshots || [])
        .filter(item => item?.timestamp && now - new Date(item.timestamp).getTime() <= marketRawRetentionMs)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, maxDemandSnapshots);
      const valid = raw.filter(item => !item.demandAnomaly && Number.isFinite(Number(item.totalSeeking)));
      const latest = valid[0] || null;
      const candles = {
        m15: candleFromSamples(valid, 15 * 60 * 1000, item => item.totalSeeking).slice(0, 96 * 7),
        h1: candleFromSamples(valid, 60 * 60 * 1000, item => item.totalSeeking).slice(0, 24 * 7),
        d1: candleFromSamples(valid, 24 * 60 * 60 * 1000, item => item.totalSeeking).slice(0, 7)
      };
      const topPublishers = topPublishersFromSamples(valid);
      const publisherCandles = {};
      const latestCounts = aggregatePublisherCountsLocal(latest?.publisherCounts);
      for (const publisher of topPublishers) {
        publisherCandles[publisher] = {
          m15: candleFromSamples(valid, 15 * 60 * 1000, item => aggregatePublisherCountsLocal(item.publisherCounts)[publisher]).slice(0, 96),
          h1: candleFromSamples(valid, 60 * 60 * 1000, item => aggregatePublisherCountsLocal(item.publisherCounts)[publisher]).slice(0, 24),
          d1: candleFromSamples(valid, 24 * 60 * 60 * 1000, item => aggregatePublisherCountsLocal(item.publisherCounts)[publisher]).slice(0, 7)
        };
      }
      const h1Delta = candles.h1[0]?.delta ?? (candles.h1.length > 1 ? Number(candles.h1[0].close || 0) - Number(candles.h1[1].close || 0) : 0);
      const d1Delta = candles.d1[0]?.delta ?? (candles.d1.length > 1 ? Number(candles.d1[0].close || 0) - Number(candles.d1[1].close || 0) : 0);
      const totalLatest = Math.max(1, sumNumbers(Object.values(latestCounts)));
      const publisherTrend = {};
      for (const [publisher, c] of Object.entries(publisherCandles)) {
        publisherTrend[publisher] = {
          h1Delta: c.h1[0]?.delta ?? 0,
          d1Delta: c.d1[0]?.delta ?? 0,
          pressure: Number(((latestCounts[publisher] || 0) / totalLatest).toFixed(4))
        };
      }
      return {
        generatedAt: new Date().toISOString(),
        rawSampleCount: raw.length,
        validSampleCount: valid.length,
        latestTotalSeeking: Number(latest?.totalSeeking || 0),
        marketRegime: demandRegimeFor(latest, valid.slice(1)),
        sameSlotPercentile: sameSlotPercentile(valid, latest),
        h1Delta,
        d1Delta,
        topPublishers,
        candles,
        publisherCandles,
        publisherTrend
      };
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
      const expectedWakeCount = elapsed > 0
        ? Math.max(1, elapsed / Math.max(1, Number(opts.watcherObserveIntervalMinutes || 5)))
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

    function speedModeFromTarget({ error, monthlyTarget, demandRegime = 'normal', riskExhausted = false, rateMultiplier = 1 }) {
      if (riskExhausted) return 'slow';
      const thresholds = lagThresholds(monthlyTarget);
      if (error >= thresholds.severe || rateMultiplier >= 1.55) return 'fast';
      if (error >= thresholds.medium) return demandRegime === 'very_busy' ? 'fast' : 'normal';
      if (error <= -thresholds.ahead) return 'slow';
      if (demandRegime === 'very_busy') return 'fast';
      if (demandRegime === 'quiet' && rateMultiplier < 1.2) return 'slow';
      return 'normal';
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
      if (monthlyTarget <= 0) {
        return {
          monthKey: monthKey(),
          monthDone: done,
          expectedDone: 0,
          lag: 0,
          speedMode: 'slow',
          workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
          activeTimeProgressRatio: availability.activeTimeProgressRatio,
          availabilityFactor: availability.availabilityFactor,
          schedulerModelMode: 'calendar_target',
          actualDone: done,
          targetError: 0,
          todayTarget: 0,
          demandFactor: 1,
          trendFactor: 1,
          rateMultiplier: 1
        };
      }
      const speedMode = speedModeFromTarget({ error: lag, monthlyTarget: effectiveTarget || monthlyTarget });
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
        todayTarget: 0,
        schedulerModelMode: 'calendar_target',
        demandFactor: 1,
        trendFactor: 1,
        rateMultiplier: 1
      };
    }

    function calculateAdvancedTargetState(state, opts) {
      return calculateTargetState(state, opts);
    }

    function candidateSource(candidate, payload = null) {
      return publisherAliasLocal(payload?.publisherName || payload?.journalName || candidate?.publisherName || candidate?.journalShortName || candidate?.rowText || candidate?.title || '');
    }

    function ensureBanditStats(state) {
      state.banditStats = state.banditStats || {};
      return state.banditStats;
    }

    function banditItem(stats, source) {
      stats[source] = stats[source] || {
        trials: 0,
        success: 0,
        failure: 0,
        htmlFailure: 0,
        cfFailure: 0,
        avgDurationMs: 0,
        lastFailureAt: ''
      };
      return stats[source];
    }

    function banditScore(candidate, state, market) {
      const source = candidateSource(candidate);
      const stats = ensureBanditStats(state);
      const item = banditItem(stats, source);
      const totalTrials = Object.values(stats).reduce((sum, value) => sum + Number(value.trials || 0), 0);
      const trials = Number(item.trials || 0);
      const estimatedSuccessRate = (Number(item.success || 0) + 1) / (trials + 2);
      const explorationBonus = Math.sqrt(2 * Math.log(totalTrials + 2) / (trials + 1));
      const trend = market?.publisherTrend?.[source] || {};
      const demandPressure = Number(trend.pressure || 0);
      const sourceTrend = Math.max(-0.4, Math.min(0.6, Number(trend.h1Delta || 0) / 100));
      const lastFailMs = item.lastFailureAt ? Date.now() - new Date(item.lastFailureAt).getTime() : Infinity;
      const recentFailurePenalty = lastFailMs < 6 * 60 * 60 * 1000 ? 0.35 : 0;
      const avgDurationPenalty = Math.min(0.3, Number(item.avgDurationMs || 0) / (8 * 60 * 1000) * 0.2);
      const doiBonus = candidate?.hasDoi ? 0.15 : 0;
      const accessRule = journalAccessRuleFor(candidate, state?.optionsSnapshot || {});
      const accessBonus = accessRule.state === 'allowed' ? 0.45 : (accessRule.state === 'partial' ? 0.22 : 0);
      const score = estimatedSuccessRate + explorationBonus * 0.35 + demandPressure * 0.8 + sourceTrend * 0.25 + doiBonus + accessBonus - recentFailurePenalty - avgDurationPenalty;
      return {
        source,
        score: Math.max(0.01, Number(score.toFixed(4))),
        estimatedSuccessRate: Number(estimatedSuccessRate.toFixed(4)),
        explorationBonus: Number(explorationBonus.toFixed(4)),
        demandPressure,
        sourceTrend,
        recentFailurePenalty,
        avgDurationPenalty,
        doiBonus,
        accessRule: accessRule.state,
        accessBonus
      };
    }

    function weightedSampleWithoutReplacement(items, count) {
      const pool = items.slice();
      const picked = [];
      while (pool.length && picked.length < count) {
        const total = pool.reduce((sum, item) => sum + Math.max(0.01, Number(item.score) || 0.01), 0);
        let r = Math.random() * total;
        let index = 0;
        for (; index < pool.length; index += 1) {
          r -= Math.max(0.01, Number(pool[index].score) || 0.01);
          if (r <= 0) break;
        }
        picked.push(pool.splice(Math.min(index, pool.length - 1), 1)[0]);
      }
      return picked;
    }

    function selectBanditCandidates(candidates, state, market, count) {
      const scored = (Array.isArray(candidates) ? candidates : [])
        .map((candidate, order) => ({ candidate, order, ...banditScore(candidate, state, market) }))
        .sort((a, b) => (b.score - a.score) || (a.order - b.order));
      const top = scored.slice(0, Math.max(count * 3, Math.min(12, scored.length)));
      const picked = weightedSampleWithoutReplacement(top, count);
      state.banditTopPublishers = scored.slice(0, 8).map(item => ({
        source: item.source,
        score: item.score,
        estimatedSuccessRate: item.estimatedSuccessRate,
        demandPressure: item.demandPressure,
        sourceTrend: item.sourceTrend
      }));
      return picked.map(item => item.candidate);
    }

    async function recordBanditOutcome(source, outcome, durationMs = 0, reason = '') {
      const state = await getWatcherState();
      const stats = ensureBanditStats(state);
      const item = banditItem(stats, source || 'Unknown');
      item.trials += 1;
      if (outcome === 'success') {
        item.success += 1;
      } else {
        item.failure += 1;
        item.lastFailureAt = new Date().toISOString();
        if (/html|login|not_pdf|error_page/i.test(reason)) item.htmlFailure += 1;
        if (/cf|challenge/i.test(reason)) item.cfFailure += 1;
      }
      if (durationMs > 0) {
        item.avgDurationMs = item.avgDurationMs ? Math.round(item.avgDurationMs * 0.75 + durationMs * 0.25) : Math.round(durationMs);
      }
      await saveWatcherState(state);
    }

    return {
      monthKey,
      monthDone,
      daysInCurrentMonth,
      getDemandSnapshots,
      percentileRank,
      medianNumber,
      sumNumbers,
      floorTime,
      candleFromSamples,
      demandSnapshotDays,
      demandRegimeFor,
      classifyDemandSnapshotAnomaly,
      topPublishersFromSamples,
      minuteOfDayFromTimestamp,
      sameSlotPercentile,
      buildMarketDataModel,
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
      candidateSource,
      ensureBanditStats,
      banditItem,
      banditScore,
      weightedSampleWithoutReplacement,
      selectBanditCandidates,
      recordBanditOutcome
    };
  }

  globalThis.AblesciWatcherTargetModule = {
    createWatcherTargetApi
  };
}());
