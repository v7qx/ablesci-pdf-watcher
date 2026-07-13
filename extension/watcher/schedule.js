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
      dailyDownloadedFromState,
      quotaResetDelayMinutes,
      targetStateSnapshot,
      nextRateLimitClearDelayMinutes,
      calculateTargetState
    } = config;

    function clearNextAssistSchedule(state) {
      // saveWatcherState merges incoming state over current storage, so top-level
      // deletes would be revived. Assign blank values explicitly to migrate stale
      // planned-assist fields, including legacy guard* fields from older builds.
      state.nextAssistRunAt = '';
      state.nextAssistReason = '';
      state.nextAssistStrategy = '';
      state.nextAssistDelayMinutes = '';
      state.nextAssistModelDelayMinutes = '';
      state.nextAssistGuardMinutes = '';
      state.nextAssistGuardApplied = false;
      state.nextAssistGuardLiftMinutes = '';
      state.nextAssistGuardWeight = '';
      state.nextAssistGuardMode = '';
      state.nextAssistPlannedAt = '';
      state.nextAssistPlanningData = null;
      state.nextAssistPlan = null;
    }

    function quotaHoldPlan(opts, state = {}) {
      const downloaded = dailyDownloadedFromState(state);
      if (Number(opts?.watcherDailyLimit || 0) > 0 && downloaded >= Number(opts.watcherDailyLimit || 0)) {
        const minutes = quotaResetDelayMinutes(opts);
        return {
          minutes,
          modelDelayMinutes: minutes,
          reason: 'daily_limit_reached',
          strategy: 'quota_hold',
          dailyDownloaded: downloaded,
          dailyLimit: Number(opts.watcherDailyLimit || 0)
        };
      }
      return null;
    }

    function clampAssistDelayMinutes(opts, minutes) {
      const min = clampNumber(opts.watcherMinIntervalMinutes, 4, 1, 1440);
      const max = clampNumber(opts.watcherMaxIntervalMinutes, 30, min, 1440);
      return Math.min(max, Math.max(min, Number(minutes) || min));
    }

    function sampleAssistDelayMinutes(opts, speedMode, state = {}) {
      // Transparent random interval: the speed mode sets a median (fast 2 /
      // normal 4 / slow 6 minutes) and the delay is uniform in
      // [median*0.5, median*1.5], clamped to the configured min/max. No adaptive
      // lognormal / monthly-target / risk model drives the interval anymore.
      const medians = { fast: 2, normal: 4, slow: 6 };
      const mode = ['slow', 'normal', 'fast'].includes(speedMode) ? speedMode : 'normal';
      const median = medians[mode] || medians.normal;
      const min = clampNumber(opts.watcherMinIntervalMinutes, 1, 1, 1440);
      const max = clampNumber(opts.watcherMaxIntervalMinutes, 30, min, 1440);
      const low = Math.max(min, median * 0.5);
      const high = Math.min(max, median * 1.5);
      if (high <= low) return Math.min(max, Math.max(min, median));
      return low + Math.random() * (high - low);
    }

    function effectiveAssistSpeedMode(opts, state = {}) {
      const configured = String(opts?.watcherSpeedMode || 'adaptive').trim();
      if (['slow', 'normal', 'fast'].includes(configured)) return configured;
      return ['slow', 'normal', 'fast'].includes(state?.speedMode) ? state.speedMode : 'normal';
    }

    function targetDrivenAssistPlan(opts, state = {}, reason = 'target_model') {
      const hold = quotaHoldPlan(opts, state);
      if (hold) return hold;
      const speedMode = effectiveAssistSpeedMode(opts, state);
      const modelDelay = sampleAssistDelayMinutes(opts, speedMode, state);
      let minutes = clampAssistDelayMinutes(opts, modelDelay);

      // CF backoff: after consecutive verification pages, exponentially lengthen
      // the interval (capped at 3 hours) to avoid hammering the site.
      const cfStreak = Number(state.cfChallengeStreak || 0);
      let cfBackoffApplied = false;
      if (cfStreak > 0) {
        minutes = Math.min(180, minutes * Math.pow(2, cfStreak - 1));
        cfBackoffApplied = true;
      }

      return {
        minutes,
        modelDelayMinutes: modelDelay,
        rawModelDelayMinutes: modelDelay,
        reason: cfBackoffApplied ? `${reason}_cf_backoff_${cfStreak}` : reason,
        strategy: 'random_interval',
        speedMode,
        targetError: Number(state.targetError ?? state.lag ?? 0)
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
        targetError: plan.targetError || 0,
        dailyDownloaded: plan.dailyDownloaded ?? dailyDownloadedFromState(state),
        dailyLimit: plan.dailyLimit ?? Number(opts.watcherDailyLimit || 0),
        todayTarget: plan.todayTarget ?? Number(state.todayTarget || 0),
        rawModelDelayMinutes: plan.rawModelDelayMinutes ? Number(plan.rawModelDelayMinutes.toFixed(2)) : '',
        modelDelayMinutes: plan.modelDelayMinutes ? Number(plan.modelDelayMinutes.toFixed(2)) : '',
        finalDelayMinutes: Number(plan.minutes.toFixed(2))
      };
      updateActionBadge(state).catch(() => {});
      return plan;
    }

    async function scheduleNextAssistAfterRun(opts, result, trigger) {
      if (!opts?.watcherQuantSchedulerEnabled) return null;
      if (trigger === 'manual') return null;
      const reason = String(result?.reason || '');
      if (/assist_not_due|already_running|active_task|disabled|rate_limited/i.test(reason)) return null;
      const state = await getWatcherState();
      clearNextAssistSchedule(state);
      const plan = ensureNextAssistSchedule(opts, state, `after_${reason || 'run'}`);
      await saveWatcherState(state);
      await appendWatcherTrace('assist_next_scheduled', {
        reason: state.nextAssistReason || '',
        trigger,
        nextAssistRunAt: state.nextAssistRunAt || '',
        delayMinutes: state.nextAssistDelayMinutes || '',
        modelDelayMinutes: state.nextAssistModelDelayMinutes || '',
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
      // watcherQuantSchedulerEnabled is LOCKED true (common_config.js), so the
      // random-interval planner always drives scheduling. The legacy
      // fixed-interval fallback (watcherIntervalMinutes base ± jitter) was
      // unreachable and has been removed; quota holds are applied inside
      // ensureNextAssistSchedule -> targetDrivenAssistPlan.
      const assistPlan = ensureNextAssistSchedule(opts, state, 'alarm_schedule');
      return Math.max(1, Number(assistPlan?.minutes || Number.POSITIVE_INFINITY));
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
        clearNextAssistSchedule(state);
        state.nextScheduledAt = '';
        state.chromeAlarmScheduledAt = '';
        await saveWatcherState(state);
        await updateActionBadge(state);
        await appendWatcherTrace('alarm_disabled', { reason });
        return;
      }
      const state = await getWatcherState();
      if (String(reason || '').startsWith('storage_changed:')) {
        clearNextAssistSchedule(state);
      }
      const delay = randomIntervalMinutes(opts, state);
      state.nextScheduledAt = Date.now() + delay * 60 * 1000;
      state.currentSchedulerMode = opts.watcherSchedulerMode;
      state.currentExecutionModel = opts.watcherMultiPublisherEnabled
        ? 'multi_publisher_random_interval'
        : 'quant_rules';
      state.lastAlarmRefreshReason = reason;
      if (calculateTargetState) {
        const targetState = calculateTargetState(state, opts);
        Object.assign(state, targetState);
      }
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
        speedMode: state.speedMode || ''
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
      if (reason === 'ablesci_service_error') {
        const delay = 5;
        const state = await getWatcherState();
        const retryAt = Date.now() + delay * 60 * 1000;
        state.nextAssistRunAt = new Date(retryAt).toISOString();
        state.nextAssistReason = 'ablesci_service_error_continue';
        state.nextAssistStrategy = 'service_error_backoff';
        state.nextAssistDelayMinutes = delay;
        state.nextAssistPlannedAt = new Date().toISOString();
        state.nextScheduledAt = retryAt;
        state.lastAlarmRefreshReason = 'ablesci_service_error_continue';
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
        await appendWatcherTrace('alarm_scheduled_service_error_continue', {
          reason: 'ablesci_service_error_continue',
          delayMinutes: delay,
          failureTotal: Number(state.ablesciUploadServiceFailures?.total || 0),
          failureConsecutive: Number(state.ablesciUploadServiceFailures?.consecutive || 0),
          nextScheduledAt: new Date(state.nextScheduledAt).toISOString()
        });
        return delay;
      }
      if (reason.startsWith('rate_limited_')) {
        const state = await getWatcherState();
        const rateLimit = result?.rateLimit && typeof result.rateLimit === 'object'
          ? result.rateLimit
          : {};
        const rateLimitWindow = String(rateLimit.window || reason.slice('rate_limited_'.length) || '');
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
        state.nextAssistDelayMinutes = Number(delay.toFixed(2));
        state.nextAssistPlannedAt = new Date().toISOString();
        state.nextAssistPlan = {
          strategy: 'rate_limited_retry',
          reason: 'rate_limited_retry',
          rateLimitWindow,
          rateLimitCount: Number(rateLimit.count || 0),
          rateLimitLimit: Number(rateLimit.limit || 0),
          finalDelayMinutes: Number(delay.toFixed(2))
        };
        state.nextScheduledAt = clearTimeMs;
        state.currentSchedulerMode = opts.watcherSchedulerMode;
        state.currentExecutionModel = 'quant_rules';
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
          rateLimitWindow,
          rateLimitCount: Number(rateLimit.count || 0),
          rateLimitLimit: Number(rateLimit.limit || 0),
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
          state.nextAssistStrategy = state.nextAssistStrategy || 'random_interval';
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
