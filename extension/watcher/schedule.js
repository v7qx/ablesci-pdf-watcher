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
      targetStateSnapshot,
      nextRateLimitClearDelayMinutes
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
      return null;
    }

    function assistGuardMinutes(opts) {
      return clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
    }

    function clampAssistDelayMinutes(opts, minutes) {
      const min = clampNumber(opts.watcherMinIntervalMinutes, 4, 1, 1440);
      const max = clampNumber(opts.watcherMaxIntervalMinutes, 30, min, 1440);
      return Math.min(max, Math.max(min, Number(minutes) || min));
    }

    function sampleAssistDelayMinutes(opts, speedMode) {
      const modeName = ['slow', 'normal', 'fast'].includes(speedMode) ? speedMode : 'normal';
      const mode = sessionModes[modeName] || sessionModes.normal;
      const min = clampNumber(opts.watcherMinIntervalMinutes, 4, 1, 1440);
      const max = clampNumber(opts.watcherMaxIntervalMinutes, 30, min, 1440);
      if (max <= min) return min;
      const modeMin = Math.max(min, Number(mode.min || min));
      const modeMax = Math.min(max, Number(mode.max || max));
      if (modeMax > modeMin && Number(mode.median || 0) >= modeMin && Number(mode.median || 0) <= modeMax) {
        return logNormalMinutes(Number(mode.median), modeMin, modeMax);
      }

      const span = max - min;
      const medianRatio = modeName === 'fast' ? 0.45 : 0.6;
      const median = min + span * medianRatio;
      return logNormalMinutes(median, min, max);
    }

    function effectiveAssistSpeedMode(opts, state = {}) {
      const configured = String(opts?.watcherSpeedMode || 'adaptive').trim();
      if (['slow', 'normal', 'fast'].includes(configured)) return configured;
      return ['slow', 'normal', 'fast'].includes(state?.speedMode) ? state.speedMode : 'normal';
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
      const speedMode = effectiveAssistSpeedMode(opts, state);
      const rawModelDelay = sampleAssistDelayMinutes(opts, speedMode);
      const targetError = Number(state.targetError ?? state.lag ?? 0);
      const monthlyTarget = Math.max(1, Number(opts.watcherMonthlyTarget || 0));
      const thresholds = lagThresholds(monthlyTarget);
      const severeLag = targetError >= thresholds.severe;
      const mediumLag = targetError >= thresholds.medium;
      const modelDelay = rawModelDelay;
      const guarded = applySoftAssistGuard(modelDelay, guardMinutes);
      guarded.minutes = clampAssistDelayMinutes(opts, guarded.minutes);
      return {
        minutes: guarded.minutes,
        modelDelayMinutes: modelDelay,
        rawModelDelayMinutes: rawModelDelay,
        guardMinutes,
        ...guarded,
        reason,
        strategy: 'calendar_target_lognormal',
        speedMode,
        rateMultiplier: 1,
        targetError,
        severeLag,
        mediumLag,
        combinedMultiplier: 1
      };
    }

    function ensureNextAssistSchedule(opts, state = {}, reason = 'ensure') {
      if (!opts.watcherQuantSchedulerEnabled) return null;
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
      if (plan.speedMode) state.speedMode = plan.speedMode;
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
        appliesNewSamplesAfterThisAttempt: true,
        targetState: targetStateSnapshot(state)
      };
      state.nextAssistPlan = {
        strategy: plan.strategy,
        reason: plan.reason,
        speedMode: plan.speedMode || '',
        rateMultiplier: plan.rateMultiplier || '',
        targetError: plan.targetError || 0,
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
      if (!opts?.watcherQuantSchedulerEnabled) return null;
      if (trigger === 'manual') return null;
      const reason = String(result?.reason || '');
      if (/assist_not_due|outside_work_schedule|already_running|active_task|disabled|rate_limited/i.test(reason)) return null;
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
        if (outsideDelay !== null) return Math.max(1, outsideDelay);
        const assistPlan = ensureNextAssistSchedule(opts, state, 'alarm_schedule');
        return Math.max(1, Number(assistPlan?.minutes || Number.POSITIVE_INFINITY));
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
        state.nextScheduledAt = '';
        state.chromeAlarmScheduledAt = '';
        await saveWatcherState(state);
        await updateActionBadge(state);
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
      state.currentExecutionModel = opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval';
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
        speedMode: state.speedMode || '',
        rateMultiplier: state.rateMultiplier || ''
      });
    }

    async function scheduleWakeForExistingAssist(opts, state, reason = 'existing_assist_due', minDelayMinutes = 0.05) {
      if (!opts?.watcherEnabled || !opts?.watcherQuantSchedulerEnabled) return null;
      const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
      if (!Number.isFinite(nextAssistMs) || nextAssistMs <= 0) return null;
      await chromeApi.alarms.clear(alarmName);
      const delay = Math.max(minDelayMinutes, (nextAssistMs - Date.now()) / 60000);
      state.nextScheduledAt = Date.now() + delay * 60 * 1000;
      state.currentSchedulerMode = opts.watcherSchedulerMode;
      state.currentExecutionModel = 'quant_rules';
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
        let delay = nextRateLimitClearDelayMinutes ? nextRateLimitClearDelayMinutes(state) : 0;
        if (delay <= 0) {
          delay = 1;
        } else {
          delay = delay + 0.05;
        }
        const clearTimeMs = Date.now() + delay * 60 * 1000;
        state.nextAssistRunAt = new Date(clearTimeMs).toISOString();
        state.nextAssistReason = 'rate_limited_retry';
        state.nextAssistStrategy = 'rate_limited_retry';
        state.nextScheduledAt = clearTimeMs;
        state.currentSchedulerMode = opts.watcherSchedulerMode;
        state.currentExecutionModel = opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval';
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
          delayMinutes: Number(delay.toFixed(2)),
          nextScheduledAt: new Date(state.nextScheduledAt).toISOString(),
          nextAssistRunAt: state.nextAssistRunAt
        });
        return delay;
      }
      if (reason === 'active_task' && attempt?.nextAssistBefore) {
        const state = await getWatcherState();
        if (!state.nextAssistRunAt) {
          state.nextAssistRunAt = attempt.nextAssistBefore;
          state.nextAssistReason = state.nextAssistReason || 'preserved_after_active_task';
          state.nextAssistStrategy = state.nextAssistStrategy || 'calendar_target_lognormal';
        }
        const delay = await scheduleWakeForExistingAssist(opts, state, 'retry_after_active_task', 1);
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
