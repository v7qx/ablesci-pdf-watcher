// Responsibility: demand observation scheduling and market snapshot persistence
// for the auto watcher. This module only moves existing logic and keeps the
// original storage keys, trace fields, and state shape unchanged.
(function () {
  function createWatcherDemandApi(config) {
    const {
      chromeApi,
      deps,
      normalizeOptions,
      todayKey,
      formatBeijingDateTime,
      minutesOfDay,
      beijingMinutesNow,
      getDemandSnapshots,
      classifyDemandSnapshotAnomaly,
      buildMarketDataModel,
      buildAdvancedPublisherModel,
      demandRegimeFor,
      calculateAdvancedTargetState,
      calculateTargetState,
      hasPendingAssist,
      getWatcherState,
      saveWatcherState,
      appendWatcherLog,
      appendWatcherTrace,
      parseListUrl,
      demandSnapshotsKey,
      marketRawRetentionMs,
      maxDemandSnapshots
    } = config;

    async function recordDemandSnapshot(snapshot) {
      if (!snapshot || !Number.isFinite(Number(snapshot.totalSeeking))) return null;
      const snapshots = (await getDemandSnapshots())
        .filter(item => item?.timestamp && Date.now() - new Date(item.timestamp).getTime() <= marketRawRetentionMs);
      const normalized = {
        ...snapshot,
        timestamp: new Date().toISOString(),
        dayKey: todayKey(),
        slot: formatBeijingDateTime(new Date()).slice(11, 16)
      };
      const anomaly = classifyDemandSnapshotAnomaly(normalized, snapshots);
      if (!anomaly.ok) {
        normalized.demandAnomaly = true;
        normalized.anomalyType = anomaly.type;
        normalized.anomalyBaseline = Number.isFinite(Number(anomaly.baseline)) ? Number(anomaly.baseline) : null;
        normalized.regime = 'anomaly';
        const nextSnapshots = [normalized, ...snapshots].slice(0, maxDemandSnapshots);
        await chromeApi.storage.local.set({ [demandSnapshotsKey]: nextSnapshots });
        const state = await getWatcherState();
        state.marketData = buildMarketDataModel(nextSnapshots);
        state.lastDemandAnomalyAt = normalized.timestamp;
        state.lastDemandAnomaly = normalized;
        await saveWatcherState(state);
        await appendWatcherLog({
          detailUrl: normalized.sourceUrl,
          status: 'skipped',
          reason: `demand_snapshot_${anomaly.type}`
        });
        return normalized;
      }
      const regime = demandRegimeFor(normalized, snapshots);
      normalized.regime = regime;
      const nextSnapshots = [normalized, ...snapshots].slice(0, maxDemandSnapshots);
      await chromeApi.storage.local.set({ [demandSnapshotsKey]: nextSnapshots });
      const state = await getWatcherState();
      const model = buildAdvancedPublisherModel(nextSnapshots);
      const market = buildMarketDataModel(nextSnapshots);
      state.lastDemandSnapshotAt = normalized.timestamp;
      state.lastDemandSnapshot = normalized;
      state.demandRegime = regime;
      state.marketData = market;
      state.publisherModel = model;
      state.schedulerModelMode = model.ready ? 'advanced' : 'simple';
      const opts = normalizeOptions(await deps.getOptions());
      const target = opts.watcherAdvancedSchedulerEnabled ? calculateAdvancedTargetState(state, opts, market) : calculateTargetState(state, opts, regime);
      const deferForPendingAssist = opts.watcherQuantSchedulerEnabled && opts.watcherObserveMode !== 'observe_only' && hasPendingAssist(state);
      state.targetPreview = target;
      state.targetPreviewAt = normalized.timestamp;
      state.marketDataAffects = deferForPendingAssist ? 'next_after_pending_assist' : 'current_plan';
      if (!deferForPendingAssist) {
        Object.assign(state, target);
      }
      await saveWatcherState(state);
      await appendWatcherTrace('market_sample_recorded', {
        reason: deferForPendingAssist ? 'deferred_until_next_assist_plan' : 'applied_to_current_plan',
        totalSeeking: normalized.totalSeeking,
        regime,
        nextAssistRunAt: state.nextAssistRunAt || '',
        targetPreviewSpeedMode: target.speedMode || '',
        targetPreviewRateMultiplier: target.rateMultiplier || ''
      });
      return normalized;
    }

    function shouldObserveDemand(state, opts) {
      if (!opts.watcherQuantSchedulerEnabled) return false;
      const today = todayKey();
      const observedSlots = new Set((state.observedSlots || {})[today] || []);
      const now = beijingMinutesNow();
      const dueSlot = opts.watcherObserveTimes.find(slot => {
        if (observedSlots.has(slot)) return false;
        const minute = minutesOfDay(slot);
        return Number.isFinite(minute) && now >= minute && now <= minute + 45;
      });
      if (dueSlot) return { due: true, slot: dueSlot, reason: 'slot' };
      const last = state.lastDemandSnapshotAt ? new Date(state.lastDemandSnapshotAt).getTime() : 0;
      const intervalMs = opts.watcherObserveIntervalMinutes * 60 * 1000;
      if (!last || Date.now() - last >= intervalMs) return { due: true, slot: 'interval', reason: 'interval' };
      const fallbackMs = opts.watcherObserveFallbackMinutes * 60 * 1000;
      if (!last || Date.now() - last >= fallbackMs) return { due: true, slot: 'fallback', reason: 'fallback' };
      return { due: false };
    }

    async function markObservedSlot(slot) {
      const state = await getWatcherState();
      const today = todayKey();
      state.observedSlots = state.observedSlots || {};
      state.observedSlots[today] = Array.from(new Set([...(state.observedSlots[today] || []), slot]));
      for (const key of Object.keys(state.observedSlots)) {
        if (key !== today) delete state.observedSlots[key];
      }
      await saveWatcherState(state);
    }

    async function collectDemandIfDue(opts, force = false) {
      const state = await getWatcherState();
      const due = force ? { due: true, slot: 'manual', reason: 'manual' } : shouldObserveDemand(state, opts);
      await appendWatcherTrace('observe_due_check', {
        force,
        due: due.due,
        slot: due.slot || '',
        reason: due.reason || '',
        url: opts.watcherDemandObserveUrl
      });
      if (!due.due) return null;
      const parsed = await parseListUrl(opts.watcherDemandObserveUrl);
      await appendWatcherTrace('observe_parsed', {
        reason: due.reason || '',
        url: opts.watcherDemandObserveUrl,
        cfChallenge: parsed.cfChallenge === true,
        totalSeeking: parsed.demandSnapshot?.totalSeeking ?? '',
        candidateCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0
      });
      if (parsed.cfChallenge) return { ok: false, reason: 'cf_challenge' };
      const snapshot = await recordDemandSnapshot(parsed.demandSnapshot);
      if (snapshot) await markObservedSlot(due.slot);
      return { ok: true, reason: due.reason, snapshot };
    }

    return {
      recordDemandSnapshot,
      shouldObserveDemand,
      markObservedSlot,
      collectDemandIfDue
    };
  }

  globalThis.AblesciWatcherDemandModule = {
    createWatcherDemandApi
  };
}());
