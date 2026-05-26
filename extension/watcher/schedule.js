// Responsibility: watcher assist scheduling, alarm refresh, and next-assist planning.
(function () {
  function createWatcherScheduleApi(config) {
    const {
      chromeApi,
      alarmName,
      normalizeOptions,
      deps,
      getWatcherState,
      saveWatcherState,
      appendWatcherTrace,
      updateActionBadge,
      clampNumber,
      todayKey,
      sessionModes,
      logNormalMinutes,
      lagThresholds,
      dailyDownloadedFromState,
      quotaResetDelayMinutes,
      nextRiskResumeAt,
      riskSnapshot,
      nextWorkDelayMinutes,
      targetStateSnapshot
    } = config;

    function quotaHoldPlan(opts, state = {}) {
      const downloaded = dailyDownloadedFromState(state);
      if (Number(opts?.watcherDailyLimit || 0) > 0 && downloaded >= Number(opts.watcherDailyLimit || 0)) {
        const minutes = quotaResetDelayMinutes(opts);
        return {
          minutes,
          modelDelayMinutes: minutes,
          guardMinutes: 0,
          reason: 'daily_limit_reached',
          strategy: 'quota_hold',
          dailyDownloaded: downloaded,
          dailyLimit: Number(opts.watcherDailyLimit || 0)
        };
      }
      if (Number(state?.todayTarget || 0) > 0 && downloaded >= Number(state.todayTarget || 0)) {
        const minutes = quotaResetDelayMinutes(opts);
        return {
          minutes,
          modelDelayMinutes: minutes,
          guardMinutes: 0,
          reason: 'today_target_reached',
          strategy: 'target_hold',
          dailyDownloaded: downloaded,
          todayTarget: Number(state.todayTarget || 0)
        };
      }
      return null;
    }

    function assistGuardMinutes(opts) {
      return clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
    }

    function applySoftAssistGuard(modelDelay, guardMinutes) {
      const model = Math.max(0, Number(modelDelay) || 0);
      const guard = Math.max(0, Number(guardMinutes) || 0);
      if (guard <= 0 || model >= guard) {
        return {
          minutes: model,
          guardApplied: false,
          guardLiftMinutes: 0,
          guardWeight: 0,
          hardFloorMinutes: 0,
          guardMode: 'none'
        };
      }

      const ratio = Math.max(0, Math.min(1, model / guard));
      const guardWeight = Math.max(0.25, Math.min(0.8, 0.25 + 0.55 * (1 - ratio)));
      const blended = model + (guard - model) * guardWeight;
      const hardFloor = Math.max(1, guard * 0.5);
      const minutes = Math.max(hardFloor, blended);
      return {
        minutes,
        guardApplied: true,
        guardLiftMinutes: minutes - model,
        guardWeight,
        hardFloorMinutes: hardFloor,
        guardMode: 'soft_blend'
      };
    }

    function targetDrivenAssistPlan(opts, state = {}, reason = 'target_model') {
      const hold = quotaHoldPlan(opts, state);
      if (hold) return hold;
      const guardMinutes = assistGuardMinutes(opts);
      const now = Date.now();
      if (opts.watcherAdvancedSchedulerEnabled && state?.riskPausedUntil) {
        const pauseMs = new Date(state.riskPausedUntil).getTime() - now;
        if (pauseMs > 0) {
          const guarded = applySoftAssistGuard(pauseMs / 60000, guardMinutes);
          return {
            minutes: guarded.minutes,
            modelDelayMinutes: pauseMs / 60000,
            guardMinutes,
            ...guarded,
            reason: 'risk_pause',
            strategy: 'risk_pause'
          };
        }
      }
      if (opts.watcherAdvancedSchedulerEnabled && state?.lastSession) {
        const cooldownUntilMs = state.lastSession.cooldownUntil ? new Date(state.lastSession.cooldownUntil).getTime() : 0;
        if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now) {
          const modelDelay = (cooldownUntilMs - now) / 60000;
          const guarded = applySoftAssistGuard(modelDelay, guardMinutes);
          return {
            minutes: guarded.minutes,
            modelDelayMinutes: modelDelay,
            guardMinutes,
            ...guarded,
            reason: 'session_cooldown',
            strategy: 'session_cooldown'
          };
        }
        const finishedAtMs = state.lastSession.finishedAt ? new Date(state.lastSession.finishedAt).getTime() : 0;
        const cooldownMinutes = Number(state.lastSession.cooldownMinutes || 0);
        if (Number.isFinite(finishedAtMs) && finishedAtMs > 0 && cooldownMinutes > 0) {
          const remaining = cooldownMinutes - ((now - finishedAtMs) / 60000);
          if (remaining > 0) {
            const guarded = applySoftAssistGuard(remaining, guardMinutes);
            return {
              minutes: guarded.minutes,
              modelDelayMinutes: remaining,
              guardMinutes,
              ...guarded,
              reason: 'session_cooldown',
              strategy: 'session_cooldown'
            };
          }
        }
      }
      const mode = sessionModes[state?.speedMode || 'normal'] || sessionModes.normal;
      const rawModelDelay = logNormalMinutes(mode.median, mode.min, mode.max);
      const targetError = Number(state.targetError ?? state.lag ?? 0);
      const monthlyTarget = Math.max(1, Number(opts.watcherMonthlyTarget || 0));
      const thresholds = lagThresholds(monthlyTarget);
      const severeLag = targetError >= thresholds.severe;
      const mediumLag = targetError >= thresholds.medium;
      const lagBoost = targetError > 0 ? Math.min(2.2, 1 + Math.min(1, targetError / monthlyTarget) * 3.2) : 1;
      const rateMultiplier = Number(state.rateMultiplier || 1);
      const demandFactor = Number(state.demandFactor || 1);
      const trendFactor = Number(state.trendFactor || 1);
      const h1Delta = Number(state.recentH1DemandDelta || state.marketData?.h1Delta || 0);
      const marketRegime = state.marketRegime || state.demandRegime || state.marketData?.marketRegime || 'normal';
      const marketBoost = marketRegime === 'very_busy' ? 1.25 : (marketRegime === 'quiet' ? (mediumLag ? 0.95 : 0.8) : 1);
      const trendBoost = h1Delta > 20 ? 1.15 : (h1Delta < -20 ? (severeLag ? 0.97 : 0.9) : 1);
      const risk = riskSnapshot(state, opts);
      const riskPenalty = risk.nearLimit ? 0.55 : 1;
      const combined = Math.max(0.25, Math.min(3.5, rateMultiplier * demandFactor * trendFactor * lagBoost * marketBoost * trendBoost * riskPenalty));
      const modelDelay = rawModelDelay / combined;
      const guarded = applySoftAssistGuard(modelDelay, guardMinutes);
      return {
        minutes: guarded.minutes,
        modelDelayMinutes: modelDelay,
        rawModelDelayMinutes: rawModelDelay,
        guardMinutes,
        ...guarded,
        reason,
        strategy: opts.watcherAdvancedSchedulerEnabled ? 'advanced_target_market_risk' : 'quant_target_market',
        speedMode: state.speedMode || 'normal',
        rateMultiplier,
        targetError,
        marketRegime,
        h1Delta,
        severeLag,
        mediumLag,
        combinedMultiplier: combined
      };
    }

    function ensureNextAssistSchedule(opts, state = {}, reason = 'ensure') {
      if (!opts.watcherQuantSchedulerEnabled || opts.watcherObserveMode === 'observe_only') return null;
      const now = Date.now();
      const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
      if (Number.isFinite(nextAssistMs) && nextAssistMs > now) {
        return {
          minutes: Math.max(1, (nextAssistMs - now) / 60000),
          reason: state.nextAssistReason || reason,
          strategy: state.nextAssistStrategy || ''
        };
      }
      const plan = targetDrivenAssistPlan(opts, state, reason);
      state.nextAssistRunAt = new Date(now + plan.minutes * 60 * 1000).toISOString();
      state.nextAssistReason = plan.reason;
      state.nextAssistStrategy = plan.strategy;
      state.nextAssistDelayMinutes = Number(plan.minutes.toFixed(2));
      state.nextAssistModelDelayMinutes = Number((plan.modelDelayMinutes || plan.minutes).toFixed(2));
      state.nextAssistGuardMinutes = Number((plan.guardMinutes || 0).toFixed(2));
      state.nextAssistGuardApplied = plan.guardApplied === true;
      state.nextAssistGuardLiftMinutes = Number((plan.guardLiftMinutes || 0).toFixed(2));
      state.nextAssistGuardWeight = Number((plan.guardWeight || 0).toFixed(3));
      state.nextAssistGuardMode = plan.guardMode || '';
      state.nextAssistPlannedAt = new Date().toISOString();
      state.nextAssistPlanningData = {
        plannedAt: state.nextAssistPlannedAt,
        marketDataAt: state.lastDemandSnapshotAt || state.marketData?.generatedAt || '',
        appliesNewSamplesAfterThisAttempt: true,
        targetState: targetStateSnapshot(state)
      };
      state.nextAssistPlan = {
        strategy: plan.strategy,
        reason: plan.reason,
        speedMode: plan.speedMode || '',
        rateMultiplier: plan.rateMultiplier || '',
        targetError: plan.targetError || 0,
        marketRegime: plan.marketRegime || '',
        h1Delta: plan.h1Delta || 0,
        dailyDownloaded: plan.dailyDownloaded ?? dailyDownloadedFromState(state),
        dailyLimit: plan.dailyLimit ?? Number(opts.watcherDailyLimit || 0),
        todayTarget: plan.todayTarget ?? Number(state.todayTarget || 0),
        combinedMultiplier: plan.combinedMultiplier || '',
        rawModelDelayMinutes: plan.rawModelDelayMinutes ? Number(plan.rawModelDelayMinutes.toFixed(2)) : '',
        modelDelayMinutes: plan.modelDelayMinutes ? Number(plan.modelDelayMinutes.toFixed(2)) : '',
        guardMinutes: plan.guardMinutes ? Number(plan.guardMinutes.toFixed(2)) : '',
        guardSource: plan.guardMinutes ? 'watcherMinIntervalMinutes' : '',
        guardMode: plan.guardMode || '',
        guardApplied: plan.guardApplied === true,
        guardWeight: plan.guardWeight ? Number(plan.guardWeight.toFixed(3)) : '',
        guardLiftMinutes: plan.guardLiftMinutes ? Number(plan.guardLiftMinutes.toFixed(2)) : '',
        hardFloorMinutes: plan.hardFloorMinutes ? Number(plan.hardFloorMinutes.toFixed(2)) : '',
        finalDelayMinutes: Number(plan.minutes.toFixed(2))
      };
      updateActionBadge(state).catch(() => {});
      return plan;
    }

    async function scheduleNextAssistAfterRun(opts, result, trigger) {
      if (!opts?.watcherQuantSchedulerEnabled || opts.watcherObserveMode === 'observe_only') return null;
      if (trigger === 'manual' || trigger === 'manual-observe') return null;
      const reason = String(result?.reason || '');
      if (/assist_not_due|observe_only|outside_work_schedule|already_running|active_task|disabled/i.test(reason)) return null;
      const state = await getWatcherState();
      delete state.nextAssistRunAt;
      delete state.nextAssistReason;
      delete state.nextAssistStrategy;
      delete state.nextAssistDelayMinutes;
      delete state.nextAssistModelDelayMinutes;
      delete state.nextAssistGuardMinutes;
      delete state.nextAssistGuardApplied;
      delete state.nextAssistGuardLiftMinutes;
      delete state.nextAssistGuardWeight;
      delete state.nextAssistGuardMode;
      delete state.nextAssistPlannedAt;
      delete state.nextAssistPlanningData;
      delete state.nextAssistPlan;
      const plan = ensureNextAssistSchedule(opts, state, `after_${reason || 'run'}`);
      await saveWatcherState(state);
      await appendWatcherTrace('assist_next_scheduled', {
        reason: state.nextAssistReason || '',
        trigger,
        nextAssistRunAt: state.nextAssistRunAt || '',
        delayMinutes: state.nextAssistDelayMinutes || '',
        modelDelayMinutes: state.nextAssistModelDelayMinutes || '',
        guardMinutes: state.nextAssistGuardMinutes || '',
        guardApplied: state.nextAssistGuardApplied === true,
        guardLiftMinutes: state.nextAssistGuardLiftMinutes || '',
        guardWeight: state.nextAssistGuardWeight || '',
        strategy: state.nextAssistStrategy || '',
        plan: state.nextAssistPlan || {}
      });
      return plan;
    }

    function hasPendingAssist(state = null) {
      const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
      return Number.isFinite(nextAssistMs) && nextAssistMs > Date.now() + 1000;
    }

    function randomIntervalMinutes(opts, state = null) {
      const hold = quotaHoldPlan(opts, state || {});
      if (hold && !opts.watcherQuantSchedulerEnabled) return Math.max(1, hold.minutes);
      if (opts.watcherQuantSchedulerEnabled) {
        const outsideDelay = nextWorkDelayMinutes(opts);
        const observeDelay = opts.watcherObserveIntervalMinutes * (0.85 + Math.random() * 0.30);
        if (outsideDelay !== null) return Math.max(1, outsideDelay);
        const assistPlan = ensureNextAssistSchedule(opts, state, 'alarm_schedule');
        const assistDelay = opts.watcherObserveMode === 'observe_only' ? Number.POSITIVE_INFINITY : Number(assistPlan?.minutes || Number.POSITIVE_INFINITY);
        return Math.max(1, Math.min(assistDelay, observeDelay));
      }
      const base = clampNumber(opts.watcherIntervalMinutes, 30, 1, 1440);
      const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
      const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
      const jitter = Math.max(1, Math.round(base * 0.2));
      const low = Math.max(min, base - jitter);
      const high = Math.min(max, base + jitter);
      return low + Math.random() * Math.max(1, high - low);
    }

    async function refreshAutoWatcherAlarm(clearExisting = true, reason = 'refresh') {
      const opts = normalizeOptions(await deps.getOptions());
      await appendWatcherTrace('alarm_refresh_start', { reason, clearExisting, watcherEnabled: opts.watcherEnabled });
      if (clearExisting) {
        await chromeApi.alarms.clear(alarmName);
        await appendWatcherTrace('alarm_cleared', { reason });
      }
      if (!opts.watcherEnabled) {
        await appendWatcherTrace('alarm_disabled', { reason });
        return;
      }
      const state = await getWatcherState();
      if (String(reason || '').startsWith('storage_changed:')) {
        delete state.nextAssistRunAt;
        delete state.nextAssistReason;
        delete state.nextAssistStrategy;
        delete state.nextAssistDelayMinutes;
        delete state.nextAssistModelDelayMinutes;
        delete state.nextAssistGuardMinutes;
        delete state.nextAssistGuardApplied;
        delete state.nextAssistGuardLiftMinutes;
        delete state.nextAssistGuardWeight;
        delete state.nextAssistGuardMode;
        delete state.nextAssistPlannedAt;
        delete state.nextAssistPlanningData;
        delete state.nextAssistPlan;
      }
      const delay = randomIntervalMinutes(opts, state);
      state.nextScheduledAt = Date.now() + delay * 60 * 1000;
      state.currentSchedulerMode = opts.watcherSchedulerMode;
      state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : (opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval');
      state.lastAlarmRefreshReason = reason;
      await saveWatcherState(state);
      await chromeApi.alarms.create(alarmName, { delayInMinutes: delay });
      const alarm = await chromeApi.alarms.get(alarmName).catch(() => null);
      if (alarm?.scheduledTime) {
        state.chromeAlarmScheduledAt = new Date(alarm.scheduledTime).toISOString();
        state.nextScheduledAt = alarm.scheduledTime;
        await saveWatcherState(state);
      } else {
        state.chromeAlarmScheduledAt = '';
      }
      updateActionBadge(state).catch(() => {});
      await appendWatcherTrace('alarm_scheduled', {
        reason,
        delayMinutes: Number(delay.toFixed(2)),
        nextScheduledAt: new Date(state.nextScheduledAt).toISOString(),
        chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
        nextAssistRunAt: state.nextAssistRunAt || '',
        nextAssistStrategy: state.nextAssistStrategy || '',
        nextAssistReason: state.nextAssistReason || '',
        observeIntervalMinutes: opts.watcherObserveIntervalMinutes || '',
        speedMode: state.speedMode || '',
        rateMultiplier: state.rateMultiplier || ''
      });
    }

    async function scheduleWakeForExistingAssist(opts, state, reason = 'existing_assist_due', minDelayMinutes = 0.05) {
      if (!opts?.watcherEnabled || !opts?.watcherQuantSchedulerEnabled || opts.watcherObserveMode === 'observe_only') return null;
      const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
      if (!Number.isFinite(nextAssistMs) || nextAssistMs <= 0) return null;
      await chromeApi.alarms.clear(alarmName);
      const delay = Math.max(minDelayMinutes, (nextAssistMs - Date.now()) / 60000);
      state.nextScheduledAt = Date.now() + delay * 60 * 1000;
      state.currentSchedulerMode = opts.watcherSchedulerMode;
      state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : 'quant_rules';
      state.lastAlarmRefreshReason = reason;
      await saveWatcherState(state);
      await chromeApi.alarms.create(alarmName, { delayInMinutes: delay });
      const alarm = await chromeApi.alarms.get(alarmName).catch(() => null);
      if (alarm?.scheduledTime) {
        state.chromeAlarmScheduledAt = new Date(alarm.scheduledTime).toISOString();
        state.nextScheduledAt = alarm.scheduledTime;
        await saveWatcherState(state);
      }
      updateActionBadge(state).catch(() => {});
      await appendWatcherTrace('alarm_scheduled_existing_assist', {
        reason,
        delayMinutes: Number(delay.toFixed(2)),
        nextScheduledAt: new Date(state.nextScheduledAt).toISOString(),
        chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
        nextAssistRunAt: state.nextAssistRunAt || ''
      });
      return delay;
    }

    async function refreshAlarmAfterRun(opts, result, attempt, trigger) {
      if (trigger !== 'alarm') return null;
      const reason = String(result?.reason || '');
      if (reason.startsWith('rate_limited_')) {
        const state = await getWatcherState();
        const delay = 2;
        state.nextScheduledAt = Date.now() + delay * 60 * 1000;
        state.currentSchedulerMode = opts.watcherSchedulerMode;
        state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : (opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval');
        state.lastAlarmRefreshReason = 'rate_limited_retry';
        await saveWatcherState(state);
        await chromeApi.alarms.clear(alarmName);
        await chromeApi.alarms.create(alarmName, { delayInMinutes: delay });
        const alarm = await chromeApi.alarms.get(alarmName).catch(() => null);
        if (alarm?.scheduledTime) {
          state.chromeAlarmScheduledAt = new Date(alarm.scheduledTime).toISOString();
          state.nextScheduledAt = alarm.scheduledTime;
          await saveWatcherState(state);
        }
        updateActionBadge(state).catch(() => {});
        await appendWatcherTrace('alarm_scheduled_rate_limited_retry', {
          reason: 'rate_limited_retry',
          delayMinutes: delay,
          nextScheduledAt: new Date(state.nextScheduledAt).toISOString()
        });
        return delay;
      }
      if (reason === 'active_task' && attempt?.nextAssistBefore) {
        const state = await getWatcherState();
        if (!state.nextAssistRunAt) {
          state.nextAssistRunAt = attempt.nextAssistBefore;
          state.nextAssistReason = state.nextAssistReason || 'preserved_after_active_task';
          state.nextAssistStrategy = state.nextAssistStrategy || 'quant_target_market';
        }
        const delay = await scheduleWakeForExistingAssist(opts, state, 'retry_after_active_task', 1);
        if (delay !== null) return delay;
      }
      if (reason === 'observed_assist_not_due' && attempt?.nextAssistBefore) {
        const state = await getWatcherState();
        const beforeMs = new Date(attempt.nextAssistBefore).getTime();
        const currentMs = state.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
        if (Number.isFinite(beforeMs) && beforeMs > 0 && (!Number.isFinite(currentMs) || currentMs <= 0 || currentMs > beforeMs)) {
          state.nextAssistRunAt = attempt.nextAssistBefore;
          state.nextAssistReason = state.nextAssistReason || 'preserved_after_observe';
          state.nextAssistStrategy = state.nextAssistStrategy || 'quant_target_market';
        }
        const delay = await scheduleWakeForExistingAssist(opts, state, 'after_observe_assist_not_due');
        if (delay !== null) return delay;
      }
      return refreshAutoWatcherAlarm(true, 'after_alarm_run');
    }

    return {
      quotaHoldPlan,
      targetDrivenAssistPlan,
      ensureNextAssistSchedule,
      scheduleNextAssistAfterRun,
      hasPendingAssist,
      randomIntervalMinutes,
      refreshAutoWatcherAlarm,
      scheduleWakeForExistingAssist,
      refreshAlarmAfterRun
    };
  }

  globalThis.AblesciWatcherScheduleModule = {
    createWatcherScheduleApi
  };
})();
