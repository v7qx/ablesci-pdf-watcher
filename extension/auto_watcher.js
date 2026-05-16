'use strict';

(function () {
  const ALARM_NAME = 'ablesciAutoWatcher';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
  const AUTO_WATCHER_TRACE_KEY = 'autoWatcherTraceLogs';
  const DEMAND_SNAPSHOTS_KEY = 'demandSnapshots';
  const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
  const MAX_LOGS = 200;
  const MAX_TRACE_LOGS = 1200;
  const MAX_DEMAND_SNAPSHOTS = 500;
  const MARKET_RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const MARKET_TOP_PUBLISHERS = 8;
  const REPORT_DIR = 'ablesci-watcher-reports';
  const ASSIST_RANDOM_PAGE_RANGES = {
    elsevier: { min: 3, max: 100 },
    rsc: { min: 1, max: 5 }
  };
  const ADVANCED_MODEL_MIN_DAYS = 2;
  const FALLBACK_PUBLISHER_WEIGHTS = {
    Elsevier: 2.8,
    ScienceDirect: 2.8,
    Wiley: 1.2,
    Springer: 1.1,
    Nature: 1.0,
    Oxford: 0.9,
    IEEE: 0.7,
    RSC: 0.65,
    Unknown: 0.4
  };
  const SESSION_MODES = {
    slow: { median: 28, min: 15, max: 60, sizeWeights: [0.15, 0.45, 0.30, 0.10, 0.00] },
    normal: { median: 15, min: 8, max: 35, sizeWeights: [0.05, 0.20, 0.40, 0.25, 0.10] },
    fast: { median: 10, min: 6, max: 25, sizeWeights: [0.02, 0.10, 0.35, 0.35, 0.18] }
  };
  const ADVANCED_ITEM_GAP = { median: 3, min: 1, max: 8 };
  const ADVANCED_COOLDOWN = { median: 18, min: 6, max: 90 };

  let deps = null;
  let autoWatcherRunning = false;

  function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function formatBeijingDateTime(value, dateOnly = false) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return String(value || '');
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date).reduce((acc, item) => {
      acc[item.type] = item.value;
      return acc;
    }, {});
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (dateOnly) return day;
    return `${day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function todayKey() {
    return formatBeijingDateTime(new Date(), true);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeListUrls(value, fallback) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
    const urls = raw
      .map(s => String(s || '').trim())
      .filter(Boolean)
      .filter(url => {
        try {
          const u = new URL(url);
          return u.protocol === 'https:' && /(^|\.)ablesci\.com$/i.test(u.hostname);
        } catch (_) {
          return false;
        }
      });
    return urls.length ? urls : fallback.slice();
  }

  function normalizeSchedulerMode(opts) {
    const raw = String(opts?.watcherSchedulerMode || '').trim().toLowerCase();
    if (raw === 'fixed' || raw === 'quant' || raw === 'advanced') return raw;
    if (opts?.watcherAdvancedSchedulerEnabled === true) return 'advanced';
    if (opts?.watcherQuantSchedulerEnabled === false) return 'fixed';
    return 'quant';
  }

  function randomIntInclusive(min, max) {
    const low = Math.ceil(min);
    const high = Math.floor(max);
    return low + Math.floor(Math.random() * Math.max(1, high - low + 1));
  }

  function randomizeAssistListUrl(url) {
    try {
      const u = new URL(url);
      const isAblesci = /(^|\.)ablesci\.com$/i.test(u.hostname);
      const isAssistList = /\/assist\/index$/i.test(u.pathname);
      const publisher = String(u.searchParams.get('publisher') || '').toLowerCase();
      const range = ASSIST_RANDOM_PAGE_RANGES[publisher];
      if (isAblesci && isAssistList && u.searchParams.get('status') === 'waiting' && range) {
        u.searchParams.set('page', String(randomIntInclusive(range.min, range.max)));
        return u.toString();
      }
    } catch (_) {
      // Keep the configured URL if it cannot be parsed.
    }
    return url;
  }

  function listUrlsForRun(opts) {
    const urls = Array.isArray(opts.watcherListUrls) ? opts.watcherListUrls.slice() : [];
    for (let i = urls.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [urls[i], urls[j]] = [urls[j], urls[i]];
    }
    return urls;
  }

  function normalizeOptions(opts) {
    const schedulerMode = normalizeSchedulerMode(opts);
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    return {
      ...opts,
      watcherEnabled: opts.watcherEnabled === true,
      watcherSchedulerMode: schedulerMode,
      watcherIntervalMinutes: clampNumber(opts.watcherIntervalMinutes, 30, min, max),
      watcherMinIntervalMinutes: min,
      watcherMaxIntervalMinutes: max,
      watcherMaxCandidatesPerRun: 1,
      watcherListUrls: normalizeListUrls(opts.watcherListUrls, deps.defaultListUrls),
      watcherUploadCountdownSeconds: clampNumber(opts.watcherUploadCountdownSeconds, 10, 0, 120),
      watcherDailyLimit: clampNumber(opts.watcherDailyLimit, 10, 0, 100),
      watcherSkipHighRiskJournal: opts.watcherSkipHighRiskJournal !== false,
      watcherDailyReportEnabled: opts.watcherDailyReportEnabled !== false,
      watcherReportDir: String(opts.watcherReportDir || '').trim(),
      watcherNotifyMode: opts.watcherNotifyMode === 'browser' ? 'browser' : 'native',
      watcherTelegramNotifyEnabled: opts.watcherTelegramNotifyEnabled === true,
      watcherTelegramConfigPath: String(opts.watcherTelegramConfigPath || '').trim(),
      watcherCfPauseThreshold: clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10),
      watcherQuantSchedulerEnabled: schedulerMode !== 'fixed',
      watcherAdvancedSchedulerEnabled: schedulerMode === 'advanced',
      watcherRiskBudgetLimit: clampNumber(opts.watcherRiskBudgetLimit, 10, 1, 100),
      watcherObserveMode: opts.watcherObserveMode === 'observe_only' ? 'observe_only' : 'assist',
      watcherObserveOnly: opts.watcherObserveMode === 'observe_only',
      watcherDemandObserveUrl: normalizeListUrls([opts.watcherDemandObserveUrl], deps.defaultListUrls)[0],
      watcherObserveTimes: normalizeObserveTimes(opts.watcherObserveTimes),
      watcherObserveIntervalMinutes: clampNumber(opts.watcherObserveIntervalMinutes, 5, 1, 60),
      watcherObserveFallbackMinutes: clampNumber(opts.watcherObserveFallbackMinutes, 180, 30, 720),
      watcherWorkdays: normalizeWorkdays(opts.watcherWorkdays),
      watcherWorkWindows: normalizeWorkWindows(opts.watcherWorkWindows),
      watcherMonthlyTarget: clampNumber(opts.watcherMonthlyTarget, 2000, 0, 5000),
      watcherMinDailyTarget: clampNumber(opts.watcherMinDailyTarget, 5, 0, 500),
      watcherMaxDailyTarget: clampNumber(opts.watcherMaxDailyTarget, 40, 1, 500),
      watcherMaxPerSession: clampNumber(opts.watcherMaxPerSession, 1, 1, 4)
    };
  }

  function normalizeObserveTimes(value) {
    const raw = Array.isArray(value) ? value : String(value || '09:30\n11:30\n14:00\n16:30\n18:00').split(/\r?\n|,/);
    const values = raw
      .map(item => String(item || '').trim())
      .filter(item => /^([01]\d|2[0-3]):[0-5]\d$/.test(item));
    return Array.from(new Set(values)).sort();
  }

  function normalizeWorkdays(value) {
    const days = String(value || '1,2,3,4,5').split(/[,，\s]+/)
      .map(item => Number(item))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 7);
    return new Set(days.length ? days : [1, 2, 3, 4, 5]);
  }

  function normalizeWorkWindows(value) {
    const raw = Array.isArray(value) ? value : String(value || '09:00-12:00\n13:30-18:00').split(/\r?\n/);
    const windows = raw.map(item => {
      const m = String(item || '').trim().match(/^([0-2]\d:[0-5]\d)\s*[-~]\s*([0-2]\d:[0-5]\d)$/);
      if (!m) return null;
      const start = minutesOfDay(m[1]);
      const end = minutesOfDay(m[2]);
      return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end, label: `${m[1]}-${m[2]}` } : null;
    }).filter(Boolean);
    return windows.length ? windows : [
      { start: minutesOfDay('09:00'), end: minutesOfDay('12:00'), label: '09:00-12:00' },
      { start: minutesOfDay('13:30'), end: minutesOfDay('18:00'), label: '13:30-18:00' }
    ];
  }

  function minutesOfDay(hhmm) {
    const m = String(hhmm || '').match(/^([0-2]\d):([0-5]\d)$/);
    if (!m) return NaN;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23) return NaN;
    return h * 60 + min;
  }

  function weekdayNumber(date = new Date()) {
    const utc = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();
    return utc === 0 ? 7 : utc;
  }

  function beijingMinutesNow(date = new Date()) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date).reduce((acc, item) => {
      acc[item.type] = item.value;
      return acc;
    }, {});
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  function isInWorkSchedule(opts, date = new Date()) {
    if (!opts.watcherQuantSchedulerEnabled) return true;
    if (!opts.watcherWorkdays.has(weekdayNumber(date))) return false;
    const minute = beijingMinutesNow(date);
    return opts.watcherWorkWindows.some(win => minute >= win.start && minute < win.end);
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
    const total = weights.reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    if (total <= 0) return 0;
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i += 1) {
      r -= Math.max(0, Number(weights[i]) || 0);
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  function randomIntervalMinutes(opts, state = null) {
    if (opts.watcherQuantSchedulerEnabled) {
      const outsideDelay = nextWorkDelayMinutes(opts);
      if (outsideDelay !== null) return outsideDelay;
      if (opts.watcherAdvancedSchedulerEnabled && state?.riskPausedUntil) {
        const pauseMs = new Date(state.riskPausedUntil).getTime() - Date.now();
        if (pauseMs > 0) return Math.max(1, pauseMs / 60000);
      }
      if (opts.watcherAdvancedSchedulerEnabled && Number(state?.lastSession?.cooldownMinutes || 0) > 0) {
        return Math.max(1, Number(state.lastSession.cooldownMinutes));
      }
      const mode = SESSION_MODES[state?.speedMode || 'normal'] || SESSION_MODES.normal;
      const sessionDelay = logNormalMinutes(mode.median, mode.min, mode.max);
      const observeDelay = opts.watcherObserveIntervalMinutes * (0.85 + Math.random() * 0.30);
      return Math.max(1, Math.min(sessionDelay, observeDelay));
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
      await chrome.alarms.clear(ALARM_NAME);
      await appendWatcherTrace('alarm_cleared', { reason });
    }
    if (!opts.watcherEnabled) {
      await appendWatcherTrace('alarm_disabled', { reason });
      return;
    }
    const state = await getWatcherState();
    const delay = randomIntervalMinutes(opts, state);
    state.nextScheduledAt = Date.now() + delay * 60 * 1000;
    state.currentSchedulerMode = opts.watcherSchedulerMode;
    state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : (opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval');
    state.lastAlarmRefreshReason = reason;
    await saveWatcherState(state);
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
    await appendWatcherTrace('alarm_scheduled', {
      reason,
      delayMinutes: Number(delay.toFixed(2)),
      nextScheduledAt: new Date(state.nextScheduledAt).toISOString(),
      speedMode: state.speedMode || '',
      rateMultiplier: state.rateMultiplier || ''
    });
  }

  async function notifyWatcherNeedsAttention(reason, url) {
    const message = normalizeText(reason || '低频值守需要人工处理。').slice(0, 160);
    const opts = normalizeOptions(await deps.getOptions());
    if (opts.watcherNotifyMode === 'native') {
      try {
        await deps.sendNativeMessage(opts.nativeHostName, {
          action: 'notify_user',
          title: 'Ablesci PDF Watcher',
          message
        });
        if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
        return { ok: true, mode: 'native' };
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] native notify failed', err);
        if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
        return { ok: false, mode: 'native', reason: err?.message || String(err) };
      }
    }
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Ablesci PDF Watcher',
        message,
        priority: 1,
        requireInteraction: false
      });
      if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
      return { ok: true, mode: 'browser' };
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] browser notification failed', err);
      return { ok: false, mode: 'browser', reason: err?.message || String(err) };
    }
    if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
  }

  async function notifyCfChallengeTelegram(opts, listUrl, streak, paused) {
    if (!opts.watcherTelegramNotifyEnabled || !deps.sendNativeMessage) return { ok: false, reason: 'telegram_disabled' };
    const title = paused ? 'Ablesci 值守已因验证暂停' : 'Ablesci 值守遇到验证';
    const hostPath = deps.urlHostPath(listUrl || '');
    const message = [
      `CF / challenge detected`,
      `streak: ${streak}`,
      `paused: ${paused ? 'yes' : 'no'}`,
      `url: ${hostPath?.host || ''}${hostPath?.path || ''}`
    ].join('\n');
    try {
      return await deps.sendNativeMessage(opts.nativeHostName, {
        action: 'send_telegram',
        config_path: opts.watcherTelegramConfigPath || '',
        title,
        message
      });
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] telegram notify failed', err);
      return { ok: false, reason: err?.message || String(err) };
    }
  }

  async function getWatcherState() {
    const stored = await chrome.storage.local.get(AUTO_WATCHER_STATE_KEY);
    return stored[AUTO_WATCHER_STATE_KEY] || { processed: {}, daily: {} };
  }

  async function saveWatcherState(state) {
    await chrome.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
  }

  async function resetCfChallengeStreak() {
    const state = await getWatcherState();
    if (!state.cfChallengeStreak && !state.pausedByCfChallenge) return;
    state.cfChallengeStreak = 0;
    state.pausedByCfChallenge = false;
    await saveWatcherState(state);
  }

  async function recordCfChallenge(opts, listUrl) {
    const state = await getWatcherState();
    const threshold = clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10);
    state.cfChallengeStreak = Number(state.cfChallengeStreak || 0) + 1;
    const reached = opts.watcherAdvancedSchedulerEnabled || state.cfChallengeStreak >= threshold;
    if (reached) {
      state.pausedByCfChallenge = true;
      await chrome.storage.local.set({ watcherEnabled: false });
      await chrome.alarms.clear(ALARM_NAME);
    }
    await saveWatcherState(state);
    await incrementDaily('failed');
    if (opts.watcherAdvancedSchedulerEnabled) await recordRiskEvent(opts, 'cf_challenge', 'blocked');
    await appendWatcherLog({
      detailUrl: listUrl,
      status: reached ? 'paused' : 'blocked',
      reason: reached ? `cf_challenge_${state.cfChallengeStreak}_paused` : `cf_challenge_${state.cfChallengeStreak}`
    });
    if (reached) {
      await notifyWatcherNeedsAttention(`连续 ${state.cfChallengeStreak} 次遇到 Ablesci 验证页，已暂停低频值守。手动处理后请重新开启。`, listUrl);
      await incrementDaily('notified');
    }
    const tg = await notifyCfChallengeTelegram(opts, listUrl, state.cfChallengeStreak, reached);
    if (tg?.ok) {
      await appendWatcherLog({
        detailUrl: listUrl,
        status: 'notified',
        reason: reached ? 'telegram_cf_paused' : 'telegram_cf_challenge'
      });
    }
    return reached;
  }

  async function updateProcessed(key, status, reason) {
    if (!key) return;
    const state = await getWatcherState();
    state.processed = state.processed || {};
    state.processed[key] = {
      lastAt: new Date().toISOString(),
      status,
      reason: normalizeText(reason).slice(0, 160)
    };
    await saveWatcherState(state);
  }

  async function incrementDaily(field) {
    const state = await getWatcherState();
    const key = todayKey();
    state.daily = state.daily || {};
    state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
    state.daily[key][field] = Number(state.daily[key][field] || 0) + 1;
    await saveWatcherState(state);
  }

  function triggerMetricKey(trigger) {
    if (trigger === 'alarm') return 'autoRuns';
    if (trigger === 'manual-observe') return 'manualObserveRuns';
    return 'manualRuns';
  }

  async function recordRunStart(trigger, opts) {
    const state = await getWatcherState();
    const key = todayKey();
    const now = new Date().toISOString();
    state.daily = state.daily || {};
    state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
    const daily = state.daily[key];
    daily.totalRuns = Number(daily.totalRuns || 0) + 1;
    daily[triggerMetricKey(trigger)] = Number(daily[triggerMetricKey(trigger)] || 0) + 1;
    state.runStats = state.runStats || {};
    state.runStats.totalRuns = Number(state.runStats.totalRuns || 0) + 1;
    state.runStats[triggerMetricKey(trigger)] = Number(state.runStats[triggerMetricKey(trigger)] || 0) + 1;
    state.lastRunStartedAt = now;
    state.lastRunTrigger = trigger;
    state.currentSchedulerMode = opts.watcherSchedulerMode || normalizeSchedulerMode(opts);
    state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : (opts.watcherQuantSchedulerEnabled ? 'quant_rules' : 'fixed_interval');
    await saveWatcherState(state);
    return state;
  }

  async function recordRunFinish(trigger, result) {
    const state = await getWatcherState();
    state.lastRunFinishedAt = new Date().toISOString();
    state.lastRunTrigger = trigger;
    state.lastRunResult = {
      ok: result?.ok === true,
      reason: normalizeText(result?.reason || '').slice(0, 160)
    };
    await saveWatcherState(state);
  }

  async function getDailyCount(field) {
    const state = await getWatcherState();
    const item = state.daily?.[todayKey()] || {};
    return Number(item[field] || 0);
  }

  function monthKey() {
    return todayKey().slice(0, 7);
  }

  function monthDone(state) {
    const prefix = monthKey() + '-';
    return Object.entries(state.daily || {})
      .filter(([key]) => key.startsWith(prefix))
      .reduce((sum, [, value]) => sum + Number(value.downloaded || 0), 0);
  }

  function daysInCurrentMonth() {
    const [year, month] = monthKey().split('-').map(Number);
    return new Date(year, month, 0).getDate();
  }

  function calculateTargetState(state, opts, demandRegime) {
    const done = monthDone(state);
    const day = Number(todayKey().slice(8, 10));
    const days = daysInCurrentMonth();
    const monthlyTarget = Number(opts.watcherMonthlyTarget || 0);
    const model = state.publisherModel || { ready: false };
    const modelMode = model.ready ? 'advanced' : 'simple';
    const expectedDone = Math.round(monthlyTarget * Math.min(1, day / days));
    const lag = expectedDone - done;
    let speedMode = 'normal';
    if (lag > Math.max(10, monthlyTarget * 0.08) || demandRegime === 'very_busy') speedMode = 'fast';
    if (lag < -Math.max(10, monthlyTarget * 0.05) || demandRegime === 'quiet') speedMode = 'slow';
    if (monthlyTarget <= 0) {
      return {
        monthKey: monthKey(),
        monthDone: done,
        expectedDone: 0,
        lag: 0,
        speedMode: 'slow',
        todayTarget: 0,
        schedulerModelMode: 'simple',
        demandFactor: 1,
        trendFactor: 1
      };
    }
    const baseTodayTarget = Math.max(0, monthlyTarget - done) / Math.max(1, days - day + 1);
    const demandFactor = modelMode === 'advanced' ? demandFactorByRegime(demandRegime) : 1;
    const trendFactor = modelMode === 'advanced' ? trendFactorFromModel(model) : 1;
    const rawTodayTarget = Math.ceil(baseTodayTarget * demandFactor * trendFactor);
    const todayTarget = clampNumber(rawTodayTarget, opts.watcherMinDailyTarget, opts.watcherMinDailyTarget, opts.watcherMaxDailyTarget);
    return { monthKey: monthKey(), monthDone: done, expectedDone, lag, speedMode, todayTarget, schedulerModelMode: modelMode, demandFactor, trendFactor };
  }

  async function getDemandSnapshots() {
    const stored = await chrome.storage.local.get(DEMAND_SNAPSHOTS_KEY);
    return Array.isArray(stored[DEMAND_SNAPSHOTS_KEY]) ? stored[DEMAND_SNAPSHOTS_KEY] : [];
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

  function topPublishersFromSamples(samples, topN = MARKET_TOP_PUBLISHERS) {
    const totals = {};
    for (const sample of samples) {
      const counts = aggregatePublisherCounts(sample.publisherCounts);
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
      .filter(item => item?.timestamp && now - new Date(item.timestamp).getTime() <= MARKET_RAW_RETENTION_MS)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const valid = raw.filter(item => !item.demandAnomaly && Number.isFinite(Number(item.totalSeeking)));
    const latest = valid[0] || null;
    const candles = {
      m15: candleFromSamples(valid, 15 * 60 * 1000, item => item.totalSeeking).slice(0, 96 * 7),
      h1: candleFromSamples(valid, 60 * 60 * 1000, item => item.totalSeeking).slice(0, 24 * 7),
      d1: candleFromSamples(valid, 24 * 60 * 60 * 1000, item => item.totalSeeking).slice(0, 7)
    };
    const topPublishers = topPublishersFromSamples(valid);
    const publisherCandles = {};
    const latestCounts = aggregatePublisherCounts(latest?.publisherCounts);
    for (const publisher of topPublishers) {
      publisherCandles[publisher] = {
        m15: candleFromSamples(valid, 15 * 60 * 1000, item => aggregatePublisherCounts(item.publisherCounts)[publisher]).slice(0, 96),
        h1: candleFromSamples(valid, 60 * 60 * 1000, item => aggregatePublisherCounts(item.publisherCounts)[publisher]).slice(0, 24),
        d1: candleFromSamples(valid, 24 * 60 * 60 * 1000, item => aggregatePublisherCounts(item.publisherCounts)[publisher]).slice(0, 7)
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

  function workMinutesForDay(opts) {
    return opts.watcherWorkWindows.reduce((sum, win) => sum + Math.max(0, win.end - win.start), 0);
  }

  function workTimeProgressRatio(opts, date = new Date()) {
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
    return total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 0;
  }

  function riskSnapshot(state, opts) {
    const daily = state.daily?.[todayKey()] || {};
    const used = Number(daily.riskUsed || 0);
    const limit = clampNumber(opts.watcherRiskBudgetLimit, 10, 1, 100);
    return {
      used,
      limit,
      remaining: Math.max(0, limit - used),
      ratio: used / Math.max(1, limit),
      exhausted: used >= limit,
      nearLimit: used >= limit * 0.75
    };
  }

  function calculateAdvancedTargetState(state, opts, market) {
    const actualDone = monthDone(state);
    const monthlyTarget = Number(opts.watcherMonthlyTarget || 0);
    const progress = workTimeProgressRatio(opts);
    const expectedDone = Math.round(monthlyTarget * progress);
    const error = expectedDone - actualDone;
    const risk = riskSnapshot(state, opts);
    const daily = state.daily?.[todayKey()] || {};
    const failures = Number(daily.failed || 0);
    const successes = Number(daily.downloaded || 0);
    const failureRate = failures / Math.max(1, failures + successes);
    const p = Number(market?.sameSlotPercentile ?? 0.5);
    const demandMultiplier = p >= 0.9 ? 1.25 : p <= 0.2 ? 0.75 : 1;
    const proportional = monthlyTarget > 0 ? error / Math.max(1, monthlyTarget) : 0;
    let rateMultiplier = 1 + proportional * 3;
    rateMultiplier *= demandMultiplier;
    rateMultiplier *= Math.max(0.35, 1 - failureRate * 0.8);
    rateMultiplier *= risk.nearLimit ? 0.45 : 1;
    if (risk.exhausted) rateMultiplier = 0;
    rateMultiplier = Math.max(0, Math.min(2.5, rateMultiplier));
    const speedMode = risk.exhausted || rateMultiplier < 0.65 ? 'slow' : rateMultiplier > 1.35 ? 'fast' : 'normal';
    const todayTarget = monthlyTarget <= 0 ? 0 : clampNumber(Math.ceil(Math.max(0, error) + (rateMultiplier > 1 ? rateMultiplier : 0)), opts.watcherMinDailyTarget, opts.watcherMinDailyTarget, opts.watcherMaxDailyTarget);
    const hourTarget = Math.max(0, Math.min(opts.watcherMaxPerSession * 3, Math.ceil(rateMultiplier * opts.watcherMaxPerSession)));
    const sessionIntensity = Math.max(0, Math.min(1, rateMultiplier / 2.5));
    return {
      schedulerModelMode: 'advanced',
      speedMode,
      workTimeProgressRatio: Number(progress.toFixed(4)),
      expectedDone,
      actualDone,
      targetError: error,
      rateMultiplier: Number(rateMultiplier.toFixed(3)),
      todayTarget,
      hourTarget,
      sessionIntensity: Number(sessionIntensity.toFixed(3)),
      riskUsed: risk.used,
      riskLimit: risk.limit,
      riskRemaining: risk.remaining,
      riskExhausted: risk.exhausted,
      marketRegime: market?.marketRegime || 'normal',
      recentH1DemandDelta: Number(market?.h1Delta || 0),
      recentD1DemandDelta: Number(market?.d1Delta || 0)
    };
  }

  function candidateSource(candidate, payload = null) {
    return publisherAlias(payload?.publisherName || payload?.journalName || candidate?.journalShortName || candidate?.rowText || candidate?.title || '');
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
    const score = estimatedSuccessRate + explorationBonus * 0.35 + demandPressure * 0.8 + sourceTrend * 0.25 + doiBonus - recentFailurePenalty - avgDurationPenalty;
    return {
      source,
      score: Math.max(0.01, Number(score.toFixed(4))),
      estimatedSuccessRate: Number(estimatedSuccessRate.toFixed(4)),
      explorationBonus: Number(explorationBonus.toFixed(4)),
      demandPressure,
      sourceTrend,
      recentFailurePenalty,
      avgDurationPenalty,
      doiBonus
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

  function riskCostFor(reason, status = '') {
    const text = `${reason || ''} ${status || ''}`;
    if (/cf|challenge/i.test(text)) return 5;
    if (/login|permission|权限|publisher_error_page/i.test(text)) return 3;
    if (/html|not_pdf|PDF 校验失败|file header/i.test(text)) return 2;
    if (/failed|blocked|timeout|interrupted|error/i.test(text)) return 1;
    return 0;
  }

  async function recordRiskEvent(opts, reason, status = '') {
    const cost = riskCostFor(reason, status);
    const state = await getWatcherState();
    const key = todayKey();
    state.daily = state.daily || {};
    state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
    if (cost > 0) {
      state.daily[key].riskUsed = Number(state.daily[key].riskUsed || 0) + cost;
      state.daily[key].consecutiveFailures = Number(state.daily[key].consecutiveFailures || 0) + 1;
      if (state.daily[key].consecutiveFailures >= 3) state.daily[key].riskUsed += 1;
    } else if (/success|queued|download_only|uploaded/i.test(status || reason || '')) {
      state.daily[key].consecutiveFailures = 0;
    }
    const risk = riskSnapshot(state, opts);
    if (opts.watcherAdvancedSchedulerEnabled && risk.exhausted) {
      state.riskPausedUntil = nextRiskResumeAt(opts);
      state.riskPauseReason = 'risk_budget_exhausted';
    }
    await saveWatcherState(state);
    return risk;
  }

  function nextRiskResumeAt(opts) {
    const delay = nextWorkDelayMinutes(opts);
    const minutes = delay === null ? 60 : Math.max(15, delay);
    return new Date(Date.now() + minutes * 60 * 1000).toISOString();
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

  function demandSnapshotDays(snapshots) {
    return new Set((snapshots || [])
      .map(item => item.dayKey || formatBeijingDateTime(item.timestamp, true))
      .filter(Boolean));
  }

  function publisherAlias(name) {
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

  function aggregatePublisherCounts(counts) {
    const out = {};
    for (const [name, count] of Object.entries(counts || {})) {
      const alias = publisherAlias(name);
      out[alias] = (out[alias] || 0) + Math.max(0, Number(count) || 0);
    }
    return out;
  }

  function buildFallbackPublisherModel(snapshot) {
    const counts = aggregatePublisherCounts(snapshot?.publisherCounts);
    const entries = Object.entries(counts).filter(([, count]) => count > 0);
    const total = entries.reduce((sum, [, count]) => sum + count, 0);
    if (!entries.length || total <= 0) return { ready: false, source: 'empty', days: 0, publishers: {} };
    const publishers = {};
    for (const [name, count] of entries) {
      const base = FALLBACK_PUBLISHER_WEIGHTS[name] || FALLBACK_PUBLISHER_WEIGHTS.Unknown;
      const share = count / total;
      publishers[name] = {
        count,
        pressure: Number(share.toFixed(4)),
        weight: Number((base * (0.8 + share * 0.6)).toFixed(3)),
        successRate: Number(Math.min(0.95, 0.45 + base * 0.08).toFixed(3))
      };
    }
    return { ready: false, source: 'fallback_current_snapshot', days: 1, publishers };
  }

  function buildAdvancedPublisherModel(snapshots) {
    const clean = (snapshots || []).filter(item => item && item.publisherCounts && !item.demandAnomaly);
    const days = demandSnapshotDays(clean);
    const latest = clean[0] || null;
    if (days.size < ADVANCED_MODEL_MIN_DAYS) return buildFallbackPublisherModel(latest);
    const previous = clean.find(item => item.dayKey && item.dayKey !== latest?.dayKey) || clean[1] || null;
    const latestCounts = aggregatePublisherCounts(latest?.publisherCounts);
    const previousCounts = aggregatePublisherCounts(previous?.publisherCounts);
    const latestTotal = Math.max(1, Object.values(latestCounts).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0));
    const publishers = {};
    for (const [name, rawCount] of Object.entries(latestCounts)) {
      const count = Math.max(0, Number(rawCount) || 0);
      const previousCount = Math.max(0, Number(previousCounts[name] || 0) || 0);
      const delta = count - previousCount;
      const pressure = count / latestTotal;
      const trend = Math.max(-0.4, Math.min(0.6, delta / Math.max(1, previousCount || count)));
      const base = FALLBACK_PUBLISHER_WEIGHTS[name] || FALLBACK_PUBLISHER_WEIGHTS.Unknown;
      publishers[name] = {
        count,
        previousCount,
        delta,
        pressure: Number(pressure.toFixed(4)),
        trend: Number(trend.toFixed(4)),
        weight: Number((base * (0.85 + pressure * 0.8 + trend * 0.35)).toFixed(3)),
        successRate: Number(Math.min(0.97, 0.5 + base * 0.07 + Math.max(0, trend) * 0.12).toFixed(3))
      };
    }
    return { ready: true, source: 'advanced_2day_delta', days: days.size, publishers };
  }

  function demandFactorByRegime(regime) {
    if (regime === 'quiet') return 0.65;
    if (regime === 'busy') return 1.2;
    if (regime === 'very_busy') return 1.4;
    return 1;
  }

  function trendFactorFromModel(model) {
    const values = Object.values(model?.publishers || {});
    if (!values.length) return 1;
    const pressure = values.reduce((sum, item) => sum + Math.max(0, Number(item.pressure) || 0), 0) / values.length;
    const trend = values.reduce((sum, item) => sum + Number(item.trend || 0), 0) / values.length;
    return Math.max(0.75, Math.min(1.35, 1 + pressure * 0.4 + trend * 0.2));
  }

  async function refreshPublisherModelFromSnapshots(state) {
    const snapshots = await getDemandSnapshots();
    if (!snapshots.length) return state;
    const model = buildAdvancedPublisherModel(snapshots);
    const market = buildMarketDataModel(snapshots);
    state.publisherModel = model;
    state.marketData = market;
    state.schedulerModelMode = model.ready ? 'advanced' : 'simple';
    return state;
  }

  async function recordDemandSnapshot(snapshot) {
    if (!snapshot || !Number.isFinite(Number(snapshot.totalSeeking))) return null;
    const snapshots = (await getDemandSnapshots())
      .filter(item => item?.timestamp && Date.now() - new Date(item.timestamp).getTime() <= MARKET_RAW_RETENTION_MS);
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
      const nextSnapshots = [normalized, ...snapshots].slice(0, MAX_DEMAND_SNAPSHOTS);
      await chrome.storage.local.set({ [DEMAND_SNAPSHOTS_KEY]: nextSnapshots });
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
    const nextSnapshots = [normalized, ...snapshots].slice(0, MAX_DEMAND_SNAPSHOTS);
    await chrome.storage.local.set({ [DEMAND_SNAPSHOTS_KEY]: nextSnapshots });
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
    Object.assign(state, target);
    await saveWatcherState(state);
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

  function sessionSize(opts, state) {
    const mode = SESSION_MODES[state?.speedMode || 'normal'] || SESSION_MODES.normal;
    const picked = weightedPickIndex(mode.sizeWeights);
    return Math.min(opts.watcherMaxPerSession, Math.max(0, picked));
  }

  function advancedSessionSize(opts, state) {
    const risk = riskSnapshot(state, opts);
    if (risk.exhausted) return 0;
    const multiplier = Number(state.rateMultiplier || 1);
    const intensity = Number(state.sessionIntensity || 0.4);
    const base = Math.ceil(opts.watcherMaxPerSession * Math.max(0.2, intensity));
    const boosted = multiplier > 1.4 ? base + 1 : base;
    const cappedByRisk = Math.min(boosted, risk.remaining);
    return Math.max(0, Math.min(4, opts.watcherMaxPerSession, cappedByRisk));
  }

  async function sleepMinutes(minutes) {
    if (minutes <= 0) return;
    await new Promise(resolve => setTimeout(resolve, minutes * 60 * 1000));
  }

  async function appendWatcherLog(entry) {
    const stored = await chrome.storage.local.get(AUTO_WATCHER_LOG_KEY);
    const logs = Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [];
    logs.unshift({
      time: new Date().toISOString(),
      sessionId: normalizeText(entry.sessionId).slice(0, 80),
      trigger: normalizeText(entry.trigger).slice(0, 80),
      assistId: entry.assistId || '',
      title: normalizeText(entry.title).slice(0, 160),
      doi: normalizeText(entry.doi).slice(0, 160),
      journalName: normalizeText(entry.journalName).slice(0, 160),
      detailUrl: sanitizeReportUrl(entry.detailUrl || ''),
      detailUrlHostPath: deps.urlHostPath(entry.detailUrl || ''),
      status: normalizeText(entry.status).slice(0, 80),
      reason: normalizeText(entry.reason).slice(0, 160)
    });
    await chrome.storage.local.set({ [AUTO_WATCHER_LOG_KEY]: logs.slice(0, MAX_LOGS) });
  }

  function sanitizeTraceValue(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      const text = value.length > 500 ? value.slice(0, 500) + '...' : value;
      if (/^https?:\/\//i.test(text)) return sanitizeReportUrl(text);
      return text;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      if (depth >= 2) return `[array:${value.length}]`;
      return value.slice(0, 20).map(item => sanitizeTraceValue(item, depth + 1));
    }
    if (typeof value === 'object') {
      if (depth >= 2) return '[object]';
      const output = {};
      for (const [key, item] of Object.entries(value).slice(0, 30)) {
        if (/token|cookie|csrf|signature|credential|secret|auth|password/i.test(key)) {
          output[key] = '<redacted>';
        } else if (/url$/i.test(key) || key === 'url' || key === 'detailUrl' || key === 'listUrl') {
          output[key] = sanitizeReportUrl(item);
        } else {
          output[key] = sanitizeTraceValue(item, depth + 1);
        }
      }
      return output;
    }
    return String(value);
  }

  async function appendWatcherTrace(step, details = {}) {
    try {
      const stored = await chrome.storage.local.get(AUTO_WATCHER_TRACE_KEY);
      const logs = Array.isArray(stored[AUTO_WATCHER_TRACE_KEY]) ? stored[AUTO_WATCHER_TRACE_KEY] : [];
      const url = details.url || details.detailUrl || details.listUrl || '';
      logs.unshift({
        time: new Date().toISOString(),
        step: normalizeText(step).slice(0, 80),
        reason: normalizeText(details.reason).slice(0, 160),
        trigger: normalizeText(details.trigger).slice(0, 80),
        sessionId: normalizeText(details.sessionId).slice(0, 80),
        tabId: details.tabId ?? '',
        url: sanitizeReportUrl(url),
        urlHostPath: deps?.urlHostPath ? deps.urlHostPath(url || '') : null,
        details: sanitizeTraceValue(details)
      });
      await chrome.storage.local.set({ [AUTO_WATCHER_TRACE_KEY]: logs.slice(0, MAX_TRACE_LOGS) });
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] trace append failed', err);
    }
  }

  function csvEscape(value) {
    return '"' + String(value ?? '').replace(/"/g, '""') + '"';
  }

  function dataUrl(content, mime) {
    return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  }

  function sanitizeReportUrl(value) {
    try {
      const url = new URL(value);
      for (const key of Array.from(url.searchParams.keys())) {
        if (/token|cookie|csrf|signature|credential|key|secret|auth/i.test(key)) {
          url.searchParams.set(key, '<redacted>');
        }
      }
      return url.href;
    } catch (_) {
      return String(value || '');
    }
  }

  function reportDetailValue(log) {
    if (log.detailUrl) return log.detailUrl;
    return `${log.detailUrlHostPath?.host || ''}${log.detailUrlHostPath?.path || ''}`;
  }

  async function writeReportFile(filename, content, mime, opts) {
    if (opts.watcherDailyReportEnabled && deps.sendNativeMessage) {
      try {
        await deps.sendNativeMessage(opts.nativeHostName, {
          action: 'write_text_file',
          dir: opts.watcherReportDir || '',
          filename,
          content
        });
        return;
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] native report write failed', err);
        return;
      }
    }
    try {
      await chrome.downloads.download({
        url: dataUrl(content, mime),
        filename: `${REPORT_DIR}/${filename}`,
        conflictAction: 'overwrite',
        saveAs: false
      });
    } catch (err) {
      console.warn('[Ablesci Auto Watcher] report download failed', err);
    }
  }

  async function writeDailyReports() {
    const opts = normalizeOptions(await deps.getOptions());
    if (!opts.watcherDailyReportEnabled) return;

    const date = todayKey();
    const stored = await chrome.storage.local.get([AUTO_WATCHER_STATE_KEY, AUTO_WATCHER_LOG_KEY, AUTO_WATCHER_TRACE_KEY, DEMAND_SNAPSHOTS_KEY]);
    const state = stored[AUTO_WATCHER_STATE_KEY] || {};
    const daily = state.daily?.[date] || {};
    const demandSnapshots = (Array.isArray(stored[DEMAND_SNAPSHOTS_KEY]) ? stored[DEMAND_SNAPSHOTS_KEY] : [])
      .filter(item => item.dayKey === date);
    const logs = (Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [])
      .filter(log => formatBeijingDateTime(log.time, true) === date);
    const traces = (Array.isArray(stored[AUTO_WATCHER_TRACE_KEY]) ? stored[AUTO_WATCHER_TRACE_KEY] : [])
      .filter(log => formatBeijingDateTime(log.time, true) === date);

    const csvHeader = [
      'record_type', 'time', 'sessionId', 'assistId', 'doi', 'journalName', 'detailUrl', 'status', 'reason',
      'marketRegime', 'totalSeeking', 'supplementCount', 'publisher', 'open', 'high', 'low', 'close', 'delta',
      'range', 'absMove', 'sampleCount', 'validSampleCount', 'workTimeProgressRatio', 'expectedDone', 'actualDone',
      'targetError', 'rateMultiplier', 'riskUsed', 'riskLimit', 'sessionSize', 'sessionHandledCount',
      'sessionDurationMs', 'score', 'estimatedSuccessRate', 'demandPressure', 'sourceTrend',
      'step', 'trigger', 'tabId', 'url', 'details'
    ];
    const baseReportFields = {
      marketRegime: state.marketRegime || state.marketData?.marketRegime || state.demandRegime || '',
      workTimeProgressRatio: state.workTimeProgressRatio || '',
      expectedDone: state.expectedDone || '',
      actualDone: state.actualDone || state.monthDone || '',
      targetError: state.targetError || state.lag || '',
      rateMultiplier: state.rateMultiplier || '',
      riskUsed: daily.riskUsed || state.riskUsed || '',
      riskLimit: state.riskLimit || '',
      sessionSize: state.lastSession?.targetSessionSize || '',
      sessionHandledCount: state.lastSession?.handledCount || '',
      sessionDurationMs: state.lastSession?.sessionDurationMs || ''
    };
    function reportRow(type, values = {}) {
      const row = { record_type: type, ...baseReportFields, ...values };
      return csvHeader.map(key => row[key] ?? '');
    }
    const csvRows = [
      csvHeader,
      reportRow('summary', {
        time: formatBeijingDateTime(new Date()),
        status: state.currentExecutionModel || state.schedulerModelMode || 'simple',
        reason: `runs=${Number(daily.totalRuns || 0)} auto=${Number(daily.autoRuns || 0)} manual=${Number(daily.manualRuns || 0)} observe=${Number(daily.manualObserveRuns || 0)} checked=${Number(daily.checked || 0)} downloaded=${Number(daily.downloaded || 0)} failed=${Number(daily.failed || 0)}`,
        totalSeeking: state.lastDemandSnapshot?.totalSeeking || '',
        supplementCount: state.lastDemandSnapshot?.supplementCount || '',
        delta: state.recentH1DemandDelta || state.marketData?.h1Delta || ''
      }),
      reportRow('session', {
        time: formatBeijingDateTime(state.lastSession?.finishedAt || state.lastSession?.startedAt || new Date()),
        sessionId: state.lastSession?.id || '',
        status: state.lastSession?.status || '',
        reason: state.lastSession?.cooldownMinutes ? `cooldown=${state.lastSession.cooldownMinutes}m` : ''
      }),
      ...(state.banditTopPublishers || []).slice(0, 20).map(item => reportRow('bandit', {
        time: formatBeijingDateTime(new Date()),
        publisher: item.source || '',
        score: item.score || '',
        estimatedSuccessRate: item.estimatedSuccessRate || '',
        demandPressure: item.demandPressure || '',
        sourceTrend: item.sourceTrend || ''
      })),
      ...demandSnapshots.map(item => reportRow('demand_sample', {
        time: formatBeijingDateTime(item.timestamp),
        status: item.regime || '',
        reason: item.demandAnomaly ? item.anomalyType || 'anomaly' : '',
        totalSeeking: item.totalSeeking || '',
        supplementCount: item.supplementCount || '',
        publisher: Object.entries(item.publisherCounts || {}).sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0)).slice(0, 8).map(([name, count]) => `${name}:${count}`).join(';')
      })),
      ...['m15', 'h1', 'd1'].flatMap(frame => (state.marketData?.candles?.[frame] || []).slice(0, frame === 'm15' ? 96 : 24).map(candle => reportRow(`candle_${frame}`, {
        time: formatBeijingDateTime(candle.start),
        status: frame,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        delta: candle.delta,
        range: candle.range,
        absMove: candle.absMove,
        sampleCount: candle.sampleCount,
        validSampleCount: candle.validSampleCount
      }))),
      ...logs.map(log => reportRow('log', {
        time: formatBeijingDateTime(log.time),
        sessionId: log.sessionId || '',
        trigger: log.trigger || '',
        assistId: log.assistId || '',
        doi: log.doi || '',
        journalName: log.journalName || '',
        detailUrl: reportDetailValue(log),
        status: log.status || '',
        reason: log.reason || ''
      })),
      ...traces.map(trace => reportRow('trace', {
        time: formatBeijingDateTime(trace.time),
        sessionId: trace.sessionId || '',
        status: trace.step || '',
        reason: trace.reason || '',
        step: trace.step || '',
        trigger: trace.trigger || '',
        tabId: trace.tabId || '',
        url: trace.url || `${trace.urlHostPath?.host || ''}${trace.urlHostPath?.path || ''}`,
        details: JSON.stringify(trace.details || {})
      }))
    ];
    const csv = csvRows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n';

    const md = [
      `# Ablesci Watcher Daily Report ${date}`,
      '',
      '## Summary',
      '',
      `- Checked: ${Number(daily.checked || 0)}`,
      `- Downloaded or queued: ${Number(daily.downloaded || 0)}`,
      `- Uploaded: ${Number(daily.uploaded || 0)}`,
      `- Skipped: ${Number(daily.skipped || 0)}`,
      `- Failed: ${Number(daily.failed || 0)}`,
      `- Notified: ${Number(daily.notified || 0)}`,
      `- Speed mode: ${state.speedMode || 'normal'}`,
      `- Demand regime: ${state.demandRegime || 'normal'}`,
      `- Scheduler model: ${state.schedulerModelMode || 'simple'}`,
      `- Runtime logic: ${state.currentSchedulerMode || ''} / ${state.currentExecutionModel || ''}`,
      `- Next run: ${state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : ''}`,
      `- Runs auto / manual / observe: ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)} / ${Number(daily.manualObserveRuns || 0)}`,
      `- Last run: ${state.lastRunTrigger || ''} ${state.lastRunResult?.reason || ''}`,
      `- Demand factor: ${Number(state.demandFactor || 1).toFixed(2)}`,
      `- Trend factor: ${Number(state.trendFactor || 1).toFixed(2)}`,
      `- Work time progress: ${Number(state.workTimeProgressRatio || 0).toFixed(4)}`,
      `- Expected / actual / error: ${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.targetError || state.lag || 0)}`,
      `- Rate multiplier: ${Number(state.rateMultiplier || 1).toFixed(3)}`,
      `- Hour target: ${Number(state.hourTarget || 0)}`,
      `- Risk used / limit: ${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`,
      `- Recent 1h demand delta: ${Number(state.recentH1DemandDelta || state.marketData?.h1Delta || 0)}`,
      `- Today target: ${Number(state.todayTarget || 0)}`,
      `- Latest demand: ${Number(state.lastDemandSnapshot?.totalSeeking || 0)}`,
      `- Latest demand anomaly: ${state.lastDemandAnomaly?.dayKey === date ? `${state.lastDemandAnomaly.anomalyType || 'yes'} (${Number(state.lastDemandAnomaly.totalSeeking || 0)})` : 'none'}`,
      `- Session ID: ${state.lastSession?.id || ''}`,
      `- Session size: ${Number(state.lastSession?.targetSessionSize || 0)}`,
      `- Session handled: ${Number(state.lastSession?.handledCount || 0)}`,
      `- Session duration seconds: ${Math.round(Number(state.lastSession?.sessionDurationMs || 0) / 1000)}`,
      `- Trace events: ${traces.length}`,
      '',
      '## Bandit',
      '',
      '| Publisher | Score | Estimated Success | Demand Pressure |',
      '| --- | --- | --- | --- |',
      ...(state.banditTopPublishers || []).slice(0, 8).map(item =>
        `| ${String(item.source || '').replace(/\|/g, '\\|')} | ${Number(item.score || 0).toFixed(4)} | ${Number(item.estimatedSuccessRate || 0).toFixed(4)} | ${Number(item.demandPressure || 0).toFixed(4)} |`
      ),
      '',
      '## Recent Events',
      '',
      '| Time | Trigger | Status | Reason | Journal | DOI | Detail |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...logs.slice(0, 12).map(log => [
        formatBeijingDateTime(log.time),
        log.trigger || '',
        log.status || '',
        log.reason || '',
        log.journalName || '',
        log.doi || '',
        reportDetailValue(log)
      ].map(v => String(v).replace(/\|/g, '\\|')).join(' | '))
        .map(row => `| ${row} |`),
      ''
    ].join('\n');

    await writeReportFile(`${date}.csv`, csv, 'text/csv', opts);
    await writeReportFile(`${date}.md`, md, 'text/markdown', opts);
  }

  function getProcessedKey(candidate, payload) {
    return payload?.assistId || candidate?.assistId || candidate?.detailUrl || '';
  }

  async function wasRecentlyProcessed(candidate) {
    const key = getProcessedKey(candidate);
    if (!key) return false;
    const state = await getWatcherState();
    return !!state.processed?.[key];
  }

  function candidatePublisherName(candidate) {
    return publisherAlias(candidate?.journalShortName || candidate?.rowText || candidate?.title || '');
  }

  function candidateModelScore(candidate, state) {
    const model = state?.publisherModel || {};
    const publisher = candidatePublisherName(candidate);
    const item = model.publishers?.[publisher] || model.publishers?.Unknown || {};
    const doiBonus = candidate?.hasDoi ? 0.25 : 0;
    const demandWeight = Number(item.weight || 0.4);
    const successRate = Number(item.successRate || 0.5);
    return demandWeight * successRate + doiBonus;
  }

  function orderCandidatesForRun(candidates, state, opts = {}, count = 1) {
    const list = Array.isArray(candidates) ? candidates.slice() : [];
    if (opts.watcherAdvancedSchedulerEnabled) return selectBanditCandidates(list, state, state.marketData, Math.max(1, count));
    if (state?.schedulerModelMode !== 'advanced') return list;
    const scored = list.map(candidate => candidateModelScore(candidate, state));
    const median = medianNumber(scored) ?? 0;
    const preferred = [];
    const fallback = [];
    list.forEach((candidate, index) => {
      (scored[index] >= median ? preferred : fallback).push(candidate);
    });
    return preferred.concat(fallback);
  }

  function parseAssistListPage() {
    function text(el) {
      return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function numberFromText(value) {
      const m = String(value || '').replace(/,/g, '').match(/\d+/);
      return m ? Number(m[0]) : null;
    }
    function absUrl(href) {
      try { return new URL(href, location.href).href; } catch (_) { return ''; }
    }
    function doiFrom(textValue) {
      const match = String(textValue || '').match(/10\.\d{4,9}\/[\S"'<>]+/i);
      if (!match) return '';
      return match[0].split('#')[0].split('?')[0].replace(/[)\].,;，。]+$/, '');
    }
    const bodyText = text(document.body);
    if (/Cloudflare|Just a moment|请完成验证|验证你是真人|人机验证|安全检查/i.test(bodyText)) {
      return { cfChallenge: true, candidates: [] };
    }

    const totalSeeking = numberFromText(text(Array.from(document.querySelectorAll('.fly-filter a'))
      .find(a => /求助中/.test(text(a)))));
    const supplementCount = numberFromText(text(Array.from(document.querySelectorAll('.fly-filter a'))
      .find(a => /补充材料/.test(text(a)))));
    const publisherCounts = {};
    Array.from(document.querySelectorAll('.waiting-publisher-item')).forEach(item => {
      const imgTitle = item.querySelector('img[title]')?.getAttribute('title') || '';
      const title = imgTitle || String(item.getAttribute('title') || '').replace(/^查看\s+|\s+的所有求助$/g, '');
      const count = numberFromText(text(item.querySelector('.waiting-publisher-item-num')));
      if (title && Number.isFinite(count)) publisherCounts[title] = count;
    });
    const demandSnapshot = {
      sourceUrl: location.href,
      totalSeeking: Number.isFinite(totalSeeking) ? totalSeeking : null,
      supplementCount: Number.isFinite(supplementCount) ? supplementCount : null,
      publisherCounts
    };

    const rows = Array.from(document.querySelectorAll('ul.assist-list > li, .assist-list li'));
    const candidates = rows.map((row, index) => {
      const detailAnchor = row.querySelector('a[href*="/assist/detail"][title*="查看详情"]') ||
        row.querySelector('.assist-list-title a[href*="/assist/detail"]') ||
        row.querySelector('a[href*="/assist/detail"]');
      const handleAnchor = row.querySelector('.assist-status-badge');
      const title = text(detailAnchor).replace(/^\[高分\]\s*/, '');
      const rowText = text(row);
      const detailUrl = absUrl(detailAnchor?.getAttribute('href') || detailAnchor?.href || '');
      const assistId = row.querySelector('.assist-id-val')?.value || new URLSearchParams(detailUrl.split('?')[1] || '').get('id') || '';
      const classText = [detailAnchor?.className || '', row.className || ''].join(' ');
      const statusText = text(row.querySelector('.assist-badge')) || text(handleAnchor);
      const journalShortName = detailAnchor?.querySelector('span[title]')?.getAttribute('title') ||
        row.querySelector('.paper-publisher img[title]')?.getAttribute('title') || '';
      const doi = doiFrom(rowText);
      return {
        assistId,
        detailUrl,
        title,
        rowText,
        doi,
        hasDoi: !!doi,
        journalShortName,
        reported: /举报|被举报|涉嫌违规/.test(rowText),
        rejected: /驳回|已驳回/.test(rowText),
        supplement: /补充材料|Supplement|supporting information|学位论文/i.test(rowText),
        statusText,
        sticky: /stick-assist|置顶/.test(classText + ' ' + rowText),
        index
      };
    }).filter(item => item.detailUrl);

    return { cfChallenge: false, candidates: candidates.reverse(), demandSnapshot };
  }

  function isListCandidateAllowed(candidate, opts) {
    const textValue = [candidate.rowText, candidate.title, candidate.statusText].join(' ');
    if (!candidate.detailUrl) return { ok: false, reason: 'missing_detail_url' };
    if (candidate.sticky) return { ok: false, reason: 'sticky_assist' };
    if (!/求助中|waiting|我要应助|可应助/i.test(textValue)) return { ok: false, reason: 'not_waiting' };
    if (opts.watcherSkipReported && candidate.reported) return { ok: false, reason: 'reported' };
    if (opts.watcherSkipRejected && candidate.rejected) return { ok: false, reason: 'rejected' };
    if (opts.watcherSkipSupplement && candidate.supplement) return { ok: false, reason: 'supplement' };
    if (opts.watcherSkipRiskText && /特殊文件|指定版本|不是全文|网页即可阅读|CAJ|epub/i.test(textValue)) {
      return { ok: false, reason: 'risk_text' };
    }
    return { ok: true };
  }

  function isDetailAllowedForWatcher(payload, opts) {
    if (!payload?.assistId) return { ok: false, reason: 'missing_assist_id' };
    if (opts.watcherRequireDoi && !payload?.doi) return { ok: false, reason: 'missing_doi' };
    if (!payload?.pdfUrl) return { ok: false, reason: 'missing_pdf_url' };

    const textValue = [
      payload.statusText || '',
      payload.riskText || '',
      payload.title || '',
      ...(Array.isArray(payload.riskReasons) ? payload.riskReasons : [])
    ].join(' ');

    if (/举报|被举报|驳回|已驳回|投诉|补充材料|Supplement|supporting information/i.test(textValue)) {
      return { ok: false, reason: 'detail_risk_text' };
    }
    return { ok: true };
  }

  function isRscPayload(payload) {
    let host = '';
    try { host = new URL(payload?.pdfUrl || 'https://invalid.local').hostname; } catch (_) {}
    return /(^|\.)pubs\.rsc\.org$/i.test(host) ||
      /\brsc\b|royal\s+society\s+of\s+chemistry/i.test([payload?.journalName, payload?.publisherName, payload?.pdfUrl].join(' '));
  }

  async function isHighRiskJournal(journalName, payload = null) {
    const journal = normalizeText(journalName);
    if (!journal) return false;
    const stored = await chrome.storage.local.get(JOURNAL_ACCESS_STATS_KEY);
    const stats = stored[JOURNAL_ACCESS_STATS_KEY] || {};
    const item = stats[journal];
    if (!item) return false;
    const failCount = Number(item.failCount || 0);
    const successCount = Number(item.successCount || 0);
    if (isRscPayload(payload)) return failCount >= 1 && failCount > successCount;
    return failCount >= 2 && failCount > successCount;
  }

  async function waitForTabComplete(tabId, timeoutMs = 45000) {
    return await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(false, new Error('tab_load_timeout')), timeoutMs);
      function finish(ok, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        ok ? resolve(value) : reject(value);
      }
      function listener(updatedTabId, changeInfo, tab) {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === 'complete') finish(true, tab);
      }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then(tab => {
        if (tab.status === 'complete') finish(true, tab);
      }).catch(err => finish(false, err));
    });
  }

  async function openHiddenTab(url, purpose = 'hidden') {
    await appendWatcherTrace('tab_open_request', { reason: purpose, url });
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      await appendWatcherTrace('tab_opened', { reason: purpose, url: tab.url || url, tabId: tab.id, active: tab.active === true });
      const completedTab = await waitForTabComplete(tab.id);
      await appendWatcherTrace('tab_complete', { reason: purpose, url: completedTab?.url || tab.url || url, tabId: tab.id });
      return tab;
    } catch (err) {
      await appendWatcherTrace('tab_open_failed', { reason: purpose, url, error: err?.message || String(err) });
      throw err;
    }
  }

  async function closeTabQuietly(tabId, reason = 'cleanup') {
    if (!tabId) return;
    await appendWatcherTrace('tab_close_request', { reason, tabId });
    try {
      await chrome.tabs.remove(tabId);
      await appendWatcherTrace('tab_closed', { reason, tabId });
    } catch (err) {
      await appendWatcherTrace('tab_close_failed', { reason, tabId, error: err?.message || String(err) });
    }
  }

  async function parseListUrl(url) {
    const tab = await openHiddenTab(url, 'parse_list');
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: parseAssistListPage
      });
      const parsed = result?.[0]?.result || { cfChallenge: false, candidates: [] };
      await appendWatcherTrace('list_parse_result', {
        reason: 'parse_list',
        url,
        tabId: tab.id,
        cfChallenge: parsed.cfChallenge === true,
        candidateCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
        totalSeeking: parsed.demandSnapshot?.totalSeeking ?? '',
        publisherCount: Object.keys(parsed.demandSnapshot?.publisherCounts || {}).length
      });
      return parsed;
    } finally {
      await closeTabQuietly(tab.id, 'list_parse_finished');
    }
  }

  async function sendDetailMessage(tabId) {
    return await chrome.tabs.sendMessage(tabId, { type: 'ablesciExtractDetailPayload' });
  }

  async function extractDetailPayload(tabId) {
    for (let i = 0; i < 5; i += 1) {
      try {
        const response = await sendDetailMessage(tabId);
        if (response) return response;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['adapters.js', 'content_ablesci.js']
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    return await sendDetailMessage(tabId);
  }

  async function inspectDetail(candidate) {
    const tab = await openHiddenTab(candidate.detailUrl, 'inspect_detail');
    try {
      const response = await extractDetailPayload(tab.id);
      if (!response?.ok) {
        await appendWatcherTrace('detail_extract_failed', {
          reason: response?.error || 'extract_detail_failed',
          detailUrl: candidate.detailUrl,
          tabId: tab.id,
          assistId: candidate.assistId || ''
        });
        return { ok: false, reason: response?.error || 'extract_detail_failed', tabId: tab.id };
      }
      await appendWatcherTrace('detail_extract_result', {
        reason: 'detail_payload_ok',
        detailUrl: candidate.detailUrl,
        tabId: tab.id,
        assistId: response.payload?.assistId || candidate.assistId || '',
        doi: response.payload?.doi || candidate.doi || '',
        journalName: response.payload?.journalName || ''
      });
      return { ok: true, payload: response.payload, tabId: tab.id };
    } catch (err) {
      await appendWatcherTrace('detail_extract_error', {
        reason: err?.message || String(err),
        detailUrl: candidate.detailUrl,
        tabId: tab.id,
        assistId: candidate.assistId || ''
      });
      return { ok: false, reason: err?.message || String(err), tabId: tab.id };
    }
  }

  function makeWatcherPort(context) {
    function settle(result) {
      if (!context || context.settled) return;
      context.settled = true;
      if (context.resolve) context.resolve(result);
    }
    return {
      name: 'ablesci-auto-watcher',
      postMessage(msg) {
        if (!msg || !context) return;
        if (msg.type === 'error') {
          const durationMs = Date.now() - Number(context.startedAt || Date.now());
          appendWatcherTrace('queue_message_error', {
            reason: msg.message || 'upload_failed',
            detailUrl: context.detailUrl,
            sessionId: context.sessionId || '',
            assistId: context.key,
            durationMs
          }).catch(() => {});
          updateProcessed(context.key, 'failed', msg.message || 'upload_failed').catch(() => {});
          incrementDaily('failed').catch(() => {});
          recordRiskEvent(context.opts || {}, msg.message || 'upload_failed', 'failed').catch(() => {});
          recordBanditOutcome(context.source, 'failure', durationMs, msg.message || 'upload_failed').catch(() => {});
          appendWatcherLog({
            ...context.payload,
            detailUrl: context.detailUrl,
            sessionId: context.sessionId || '',
            status: 'failed',
            reason: msg.message || 'upload_failed'
          }).then(writeDailyReports).catch(() => {});
          settle({ ok: false, reason: msg.message || 'upload_failed', durationMs });
        }
        if (msg.type === 'done' && msg.blocked) {
          const durationMs = Date.now() - Number(context.startedAt || Date.now());
          appendWatcherTrace('queue_message_blocked', {
            reason: msg.message || 'blocked',
            detailUrl: context.detailUrl,
            sessionId: context.sessionId || '',
            assistId: context.key,
            durationMs
          }).catch(() => {});
          updateProcessed(context.key, 'failed', msg.message || 'blocked').catch(() => {});
          incrementDaily('failed').catch(() => {});
          recordRiskEvent(context.opts || {}, msg.message || 'blocked', 'blocked').catch(() => {});
          recordBanditOutcome(context.source, 'failure', durationMs, msg.message || 'blocked').catch(() => {});
          appendWatcherLog({
            ...context.payload,
            detailUrl: context.detailUrl,
            sessionId: context.sessionId || '',
            status: 'failed',
            reason: msg.message || 'blocked'
          }).then(writeDailyReports).catch(() => {});
          settle({ ok: false, reason: msg.message || 'blocked', durationMs });
        } else if (msg.type === 'done') {
          const durationMs = Date.now() - Number(context.startedAt || Date.now());
          appendWatcherTrace('queue_message_done', {
            reason: msg.message || 'done',
            detailUrl: context.detailUrl,
            sessionId: context.sessionId || '',
            assistId: context.key,
            durationMs
          }).catch(() => {});
          recordRiskEvent(context.opts || {}, msg.message || 'success', 'success').catch(() => {});
          recordBanditOutcome(context.source, 'success', durationMs, msg.message || 'success').catch(() => {});
          settle({ ok: true, reason: msg.message || 'done', durationMs });
        }
      },
      onDisconnect: {
        addListener() {}
      }
    };
  }

  function makeSessionPortContext(context) {
    let timer = null;
    const result = new Promise(resolve => {
      context.resolve = value => {
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => resolve({ ok: false, reason: 'auto_watcher_task_timeout', durationMs: 12 * 60 * 1000 }), 12 * 60 * 1000);
    });
    return { port: makeWatcherPort(context), result };
  }

  async function handleAllowedPayload(candidate, payload, opts, detailTabId, session = null, trigger = '') {
    payload.triggeredBy = 'auto_watcher';
    const key = getProcessedKey(candidate, payload);
    const source = candidateSource(candidate, payload);
    await appendWatcherTrace('candidate_payload_allowed', {
      reason: 'ready_to_handle',
      detailUrl: candidate.detailUrl,
      tabId: detailTabId,
      sessionId: session?.id || '',
      trigger: trigger || session?.trigger || '',
      assistId: key,
      source,
      autoDownload: opts.watcherAutoDownload,
      autoUpload: opts.watcherAutoUpload,
      uploadConfirmRequired: opts.watcherUploadConfirmRequired
    });

    if (opts.watcherSkipHighRiskJournal && await isHighRiskJournal(payload.journalName, payload)) {
      await appendWatcherTrace('candidate_skip_high_risk_journal', { reason: 'high_risk_journal', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
      await closeTabQuietly(detailTabId, 'high_risk_journal');
      await updateProcessed(key, 'skipped', 'high_risk_journal');
      await incrementDaily('skipped');
      await recordBanditOutcome(source, 'failure', 0, 'high_risk_journal');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: '本地记录近期多次失败，可能无权限' });
      return false;
    }

    if (!opts.watcherAutoDownload) {
      await appendWatcherTrace('candidate_manual_detail_kept', { reason: 'auto_download_disabled', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
      await notifyWatcherNeedsAttention('低频值守发现候选，已保留求助详情页等待人工处理。', candidate.detailUrl);
      await incrementDaily('notified');
      await updateProcessed(key, 'skipped', 'manual_detail_opened');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: 'manual_detail_opened' });
      return true;
    }

    if (!opts.watcherAutoUpload || opts.watcherUploadConfirmRequired) {
      payload.downloadOnly = true;
      payload.riskReasons = [
        ...(Array.isArray(payload.riskReasons) ? payload.riskReasons : []),
        '低频值守默认仅下载并校验 PDF，上传需要人工确认。'
      ];
    }

    if (deps.hasActiveTask()) {
      await appendWatcherTrace('candidate_skip_active_task', { reason: 'active_task', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
      await updateProcessed(key, 'skipped', 'active_task');
      await incrementDaily('skipped');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: 'active_task' });
      return false;
    }

    const portContext = {
      key,
      payload,
      detailUrl: candidate.detailUrl,
      opts,
      source,
      sessionId: session?.id || '',
      trigger: trigger || session?.trigger || '',
      startedAt: Date.now()
    };
    const sessionPort = opts.watcherAdvancedSchedulerEnabled ? makeSessionPortContext(portContext) : null;
    await appendWatcherTrace('candidate_enqueue', {
      reason: payload.downloadOnly ? 'download_only' : 'auto_upload',
      detailUrl: candidate.detailUrl,
      tabId: detailTabId,
      sessionId: session?.id || '',
      trigger: trigger || session?.trigger || '',
      assistId: key,
      source,
      downloadOnly: payload.downloadOnly === true
    });
    deps.enqueueUpload(sessionPort?.port || makeWatcherPort(portContext), payload);
    if (!payload.downloadOnly) await closeTabQuietly(detailTabId, 'auto_upload_enqueued');
    await incrementDaily('downloaded');
    if (opts.watcherAutoUpload && !opts.watcherUploadConfirmRequired) await incrementDaily('uploaded');
    await updateProcessed(key, 'success', payload.downloadOnly ? 'queued_download_only' : 'queued_upload');
    await appendWatcherLog({
      ...payload,
      detailUrl: candidate.detailUrl,
      sessionId: session?.id || '',
      trigger: trigger || session?.trigger || '',
      status: payload.downloadOnly ? 'download_only' : 'queued_upload',
      reason: payload.downloadOnly ? 'upload_confirmation_required' : 'auto_upload_enabled'
    });
    await notifyWatcherNeedsAttention(payload.downloadOnly ? '低频值守已排队下载校验一个候选，并保留求助详情页等待人工上传确认。' : '低频值守已排队处理一个候选。');
    await incrementDaily('notified');
    if (sessionPort) {
      const result = await sessionPort.result;
      return result.ok;
    }
    return true;
  }

  async function runAdvancedSchedulerSession(opts, stateForTargets, targetSessionSize, observeResult, trigger = '') {
    const session = {
      id: `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      trigger,
      startedAt: new Date().toISOString(),
      status: 'planning',
      plannedSize: 0,
      handledCount: 0
    };
    stateForTargets.currentSession = session;
    await saveWatcherState(stateForTargets);
    const runListUrls = listUrlsForRun(opts);
    await appendWatcherTrace('session_start', {
      reason: 'advanced_planning',
      sessionId: session.id,
      sessionSize: targetSessionSize,
      listUrlCount: runListUrls.length
    });
    await appendWatcherTrace('session_source_order', {
      reason: 'randomized_publisher_order',
      sessionId: session.id,
      listUrls: runListUrls
    });

    const plan = [];
    for (const listUrl of runListUrls) {
      if (plan.length >= targetSessionSize) break;
      const pickedListUrl = randomizeAssistListUrl(listUrl);
      await appendWatcherTrace('session_plan_url', {
        reason: pickedListUrl === listUrl ? 'configured_url' : 'randomized_page',
        sessionId: session.id,
        listUrl: pickedListUrl,
        configuredUrl: listUrl
      });
      stateForTargets.lastPickedListUrl = pickedListUrl;
      await saveWatcherState(stateForTargets);
      await incrementDaily('checked');
      const parsed = await parseListUrl(pickedListUrl);
      if (parsed.cfChallenge) {
        if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, pickedListUrl);
        return { ok: false, reason: 'cf_challenge' };
      }
      await resetCfChallengeStreak();
      const allowed = [];
      for (const candidate of parsed.candidates || []) {
        const listAllowed = isListCandidateAllowed(candidate, opts);
        if (!listAllowed.ok) {
          await appendWatcherTrace('candidate_skip_list_filter', {
            reason: listAllowed.reason,
            sessionId: session.id,
            detailUrl: candidate.detailUrl,
            assistId: candidate.assistId || '',
            title: candidate.title || ''
          });
          continue;
        }
        if (await wasRecentlyProcessed(candidate)) {
          await appendWatcherTrace('candidate_skip_processed', {
            reason: 'processed_before',
            sessionId: session.id,
            detailUrl: candidate.detailUrl,
            assistId: candidate.assistId || ''
          });
          continue;
        }
        allowed.push(candidate);
      }
      const selected = selectBanditCandidates(allowed, stateForTargets, stateForTargets.marketData, targetSessionSize);
      await appendWatcherTrace('session_plan_result', {
        reason: 'list_candidates_scored',
        sessionId: session.id,
        listUrl: pickedListUrl,
        parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
        allowedCount: allowed.length,
        selectedCount: selected.length,
        planSizeBefore: plan.length
      });
      plan.push(...selected);
    }

    const stateWithPlan = await getWatcherState();
    stateWithPlan.currentSession = {
      ...session,
      status: 'running',
      plannedSize: plan.length,
      targetSessionSize
    };
    await saveWatcherState(stateWithPlan);
    await appendWatcherTrace('session_plan_done', {
      reason: 'advanced_plan_ready',
      sessionId: session.id,
      plannedSize: plan.length,
      targetSessionSize
    });

    let handledCount = 0;
    const startedMs = Date.now();
    for (const candidate of plan) {
      if (handledCount >= targetSessionSize) break;
      const risk = riskSnapshot(await getWatcherState(), opts);
      if (risk.exhausted) {
        await appendWatcherTrace('session_stop_risk_budget', { reason: 'risk_budget_exhausted', sessionId: session.id, riskUsed: risk.used, riskLimit: risk.limit });
        break;
      }

      await appendWatcherTrace('session_candidate_start', {
        reason: 'inspect_planned_candidate',
        sessionId: session.id,
        detailUrl: candidate.detailUrl,
        assistId: candidate.assistId || '',
        title: candidate.title || ''
      });
      const detail = await inspectDetail(candidate);
      if (!detail.ok) {
        await closeTabQuietly(detail.tabId, 'detail_extract_failed');
        await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
        await incrementDaily('failed');
        await recordRiskEvent(opts, detail.reason, 'failed');
        await recordBanditOutcome(candidateSource(candidate), 'failure', 0, detail.reason);
          await appendWatcherLog({ ...candidate, sessionId: session.id, trigger, status: 'failed', reason: detail.reason });
      } else {
        const payload = detail.payload;
        const detailAllowed = isDetailAllowedForWatcher(payload, opts);
        const key = getProcessedKey(candidate, payload);
        if (!detailAllowed.ok) {
          await appendWatcherTrace('candidate_skip_detail_filter', { reason: detailAllowed.reason, sessionId: session.id, detailUrl: candidate.detailUrl, tabId: detail.tabId, assistId: key });
          await closeTabQuietly(detail.tabId, 'detail_filter_skipped');
          await updateProcessed(key, 'skipped', detailAllowed.reason);
          await incrementDaily('skipped');
          await recordBanditOutcome(candidateSource(candidate, payload), 'failure', 0, detailAllowed.reason);
          await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, sessionId: session.id, trigger, status: 'skipped', reason: detailAllowed.reason });
        } else {
          const handled = await handleAllowedPayload(candidate, payload, opts, detail.tabId, session, trigger);
          if (!handled) await closeTabQuietly(detail.tabId, 'candidate_not_handled');
          if (handled) handledCount += 1;
        }
      }

      const afterState = await getWatcherState();
      afterState.currentSession = {
        ...afterState.currentSession,
        status: 'running',
        handledCount,
        sessionDurationMs: Date.now() - startedMs
      };
      await saveWatcherState(afterState);

      if (handledCount < targetSessionSize && plan.indexOf(candidate) < plan.length - 1) {
        const gap = logNormalMinutes(ADVANCED_ITEM_GAP.median, ADVANCED_ITEM_GAP.min, ADVANCED_ITEM_GAP.max);
        await appendWatcherTrace('session_item_gap', { reason: 'between_candidates', sessionId: session.id, gapMinutes: Number(gap.toFixed(2)), handledCount, targetSessionSize });
        await sleepMinutes(gap);
      }
    }

    const finalState = await getWatcherState();
    const durationMs = Date.now() - startedMs;
    finalState.lastSession = {
      ...finalState.currentSession,
      status: 'done',
      finishedAt: new Date().toISOString(),
      handledCount,
      sessionDurationMs: durationMs,
      cooldownMinutes: Number((logNormalMinutes(ADVANCED_COOLDOWN.median, ADVANCED_COOLDOWN.min, ADVANCED_COOLDOWN.max) / Math.max(0.25, Number(finalState.rateMultiplier || 1))).toFixed(2))
    };
    finalState.currentSession = { ...finalState.lastSession };
    await saveWatcherState(finalState);
    await appendWatcherTrace('session_done', {
      reason: handledCount ? 'advanced_session_done' : 'advanced_no_candidate',
      sessionId: session.id,
      handledCount,
      targetSessionSize,
      sessionDurationMs: durationMs,
      cooldownMinutes: finalState.lastSession.cooldownMinutes
    });
    return { ok: true, reason: handledCount ? 'advanced_session_done' : (observeResult?.snapshot ? 'observe_only_session' : 'advanced_no_candidate') };
  }

  async function runAutoWatcherOnce(trigger = 'alarm') {
    if (autoWatcherRunning) {
      await appendWatcherTrace('run_skip_already_running', { reason: 'already_running', trigger });
      return { ok: false, reason: 'already_running' };
    }
    autoWatcherRunning = true;
    let runResult = null;
    function finish(result) {
      runResult = result;
      return result;
    }
    try {
      await appendWatcherTrace('run_start', { reason: 'watcher_triggered', trigger });
      const opts = normalizeOptions(await deps.getOptions());
      await recordRunStart(trigger, opts);
      if (!opts.watcherEnabled && trigger !== 'manual' && trigger !== 'manual-observe') {
        await appendWatcherTrace('run_skip_disabled', { reason: 'disabled', trigger });
        return finish({ ok: false, reason: 'disabled' });
      }
      if (deps.hasActiveTask()) {
        await appendWatcherTrace('run_skip_active_task', { reason: 'active_task', trigger });
        return finish({ ok: false, reason: 'active_task' });
      }
      if (opts.watcherQuantSchedulerEnabled && trigger !== 'manual' && !isInWorkSchedule(opts)) {
        await appendWatcherTrace('run_skip_outside_work_schedule', { reason: 'outside_work_schedule', trigger });
        return finish({ ok: true, reason: 'outside_work_schedule' });
      }

      const observeResult = await collectDemandIfDue(opts, trigger === 'manual-observe');
      if (observeResult?.reason === 'cf_challenge') {
        if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, opts.watcherDemandObserveUrl);
        return finish({ ok: false, reason: 'cf_challenge' });
      }
      if (trigger === 'manual-observe') {
        return finish({ ok: !!observeResult?.snapshot, reason: observeResult?.snapshot ? 'demand_observed' : 'demand_observe_skipped' });
      }
      if (opts.watcherObserveMode === 'observe_only') {
        return finish({ ok: true, reason: observeResult?.snapshot ? 'observe_only_snapshot' : 'observe_only_waiting' });
      }

      const stateForTargets = await getWatcherState();
      if (opts.watcherAdvancedSchedulerEnabled && stateForTargets.riskPausedUntil && new Date(stateForTargets.riskPausedUntil).getTime() > Date.now()) {
        await appendWatcherTrace('run_skip_risk_budget_paused', { reason: 'risk_budget_paused', trigger, pausedUntil: stateForTargets.riskPausedUntil });
        return finish({ ok: false, reason: 'risk_budget_paused' });
      }
      if (opts.watcherQuantSchedulerEnabled) await refreshPublisherModelFromSnapshots(stateForTargets);
      const targetState = !opts.watcherQuantSchedulerEnabled
        ? {
            schedulerModelMode: 'fixed',
            speedMode: 'fixed',
            todayTarget: 0,
            demandFactor: 1,
            trendFactor: 1,
            rateMultiplier: 1,
            sessionIntensity: 0
          }
        : opts.watcherAdvancedSchedulerEnabled
        ? calculateAdvancedTargetState(stateForTargets, opts, stateForTargets.marketData || {})
        : calculateTargetState(stateForTargets, opts, stateForTargets.demandRegime || 'normal');
      Object.assign(stateForTargets, targetState);
      await saveWatcherState(stateForTargets);
      await appendWatcherTrace('run_target_state', {
        reason: opts.watcherAdvancedSchedulerEnabled ? 'advanced_target' : (opts.watcherQuantSchedulerEnabled ? 'quant_target' : 'fixed_interval'),
        trigger,
        speedMode: targetState.speedMode,
        todayTarget: targetState.todayTarget,
        hourTarget: targetState.hourTarget || '',
        rateMultiplier: targetState.rateMultiplier || '',
        targetError: targetState.targetError || targetState.lag || ''
      });
      if (targetState.todayTarget > 0 && await getDailyCount('downloaded') >= targetState.todayTarget) {
        await appendWatcherTrace('run_skip_today_target_reached', { reason: 'today_target_reached', trigger, todayTarget: targetState.todayTarget });
        return finish({ ok: false, reason: 'today_target_reached' });
      }
      if (opts.watcherDailyLimit > 0 && await getDailyCount('downloaded') >= opts.watcherDailyLimit) {
        await appendWatcherTrace('run_skip_daily_limit', { reason: 'daily_limit', trigger, dailyLimit: opts.watcherDailyLimit });
        return finish({ ok: false, reason: 'daily_limit' });
      }

      let handledCount = 0;
      const targetSessionSize = opts.watcherAdvancedSchedulerEnabled
        ? advancedSessionSize(opts, stateForTargets)
        : (opts.watcherQuantSchedulerEnabled ? sessionSize(opts, stateForTargets) : 1);
      await appendWatcherTrace('run_session_size', { reason: 'session_size_calculated', trigger, targetSessionSize, advanced: opts.watcherAdvancedSchedulerEnabled });
      if (targetSessionSize <= 0) return finish({ ok: true, reason: observeResult?.snapshot ? 'observe_only_session' : 'session_size_zero' });
      if (opts.watcherAdvancedSchedulerEnabled) {
        return finish(await runAdvancedSchedulerSession(opts, stateForTargets, targetSessionSize, observeResult, trigger));
      }

      const runListUrls = listUrlsForRun(opts);
      await appendWatcherTrace('run_source_order', {
        reason: 'randomized_publisher_order',
        trigger,
        listUrls: runListUrls
      });
      for (const listUrl of runListUrls) {
        const pickedListUrl = randomizeAssistListUrl(listUrl);
        await appendWatcherTrace('list_scan_start', {
          reason: pickedListUrl === listUrl ? 'configured_url' : 'randomized_page',
          trigger,
          listUrl: pickedListUrl,
          configuredUrl: listUrl,
          handledCount,
          targetSessionSize
        });
        stateForTargets.lastPickedListUrl = pickedListUrl;
        await saveWatcherState(stateForTargets);
        await incrementDaily('checked');
        const parsed = await parseListUrl(pickedListUrl);
        if (parsed.cfChallenge) {
          if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, pickedListUrl);
          return finish({ ok: false, reason: 'cf_challenge' });
        }
        await resetCfChallengeStreak();

        const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets, opts, targetSessionSize);
        await appendWatcherTrace('list_scan_candidates', {
          reason: 'ordered_candidates',
          trigger,
          listUrl: pickedListUrl,
          parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
          orderedCount: candidates.length
        });
        for (const candidate of candidates) {
          if (handledCount >= targetSessionSize) return finish({ ok: true, reason: 'session_target_reached' });
          const listAllowed = isListCandidateAllowed(candidate, opts);
          if (!listAllowed.ok) {
            await appendWatcherTrace('candidate_skip_list_filter', {
              reason: listAllowed.reason,
              trigger,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || '',
              title: candidate.title || ''
            });
            continue;
          }
          if (await wasRecentlyProcessed(candidate)) {
            await appendWatcherTrace('candidate_skip_processed', {
              reason: 'processed_before',
              trigger,
              detailUrl: candidate.detailUrl,
              assistId: candidate.assistId || ''
            });
            continue;
          }

          await appendWatcherTrace('candidate_detail_start', {
            reason: 'candidate_passed_list_filter',
            trigger,
            detailUrl: candidate.detailUrl,
            assistId: candidate.assistId || '',
            title: candidate.title || ''
          });
          const detail = await inspectDetail(candidate);
          if (!detail.ok) {
            await closeTabQuietly(detail.tabId, 'detail_extract_failed');
            await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
            await incrementDaily('failed');
            await appendWatcherLog({ ...candidate, trigger, status: 'failed', reason: detail.reason });
            continue;
          }

          const payload = detail.payload;
          const detailAllowed = isDetailAllowedForWatcher(payload, opts);
          const key = getProcessedKey(candidate, payload);
          if (!detailAllowed.ok) {
            await appendWatcherTrace('candidate_skip_detail_filter', { reason: detailAllowed.reason, trigger, detailUrl: candidate.detailUrl, tabId: detail.tabId, assistId: key });
            await closeTabQuietly(detail.tabId, 'detail_filter_skipped');
            await updateProcessed(key, 'skipped', detailAllowed.reason);
            await incrementDaily('skipped');
            await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger, status: 'skipped', reason: detailAllowed.reason });
            continue;
          }

          const handled = await handleAllowedPayload(candidate, payload, opts, detail.tabId, null, trigger);
          if (!handled) await closeTabQuietly(detail.tabId, 'candidate_not_handled');
          if (handled) {
            handledCount += 1;
            await appendWatcherTrace('candidate_handled', { reason: 'handled', trigger, detailUrl: candidate.detailUrl, tabId: detail.tabId, assistId: key, handledCount, targetSessionSize });
            if (handledCount >= targetSessionSize || deps.hasActiveTask()) {
              return finish({ ok: true, reason: handledCount > 1 ? 'session_candidates_handled' : 'candidate_handled' });
            }
          }
        }
      }

      return finish({ ok: true, reason: handledCount ? 'session_candidates_handled' : 'no_candidate' });
    } catch (err) {
      await appendWatcherTrace('run_error', { reason: err?.message || String(err), trigger });
      await incrementDaily('failed');
      await appendWatcherLog({ trigger, status: 'failed', reason: err?.message || String(err) });
      return finish({ ok: false, reason: err?.message || String(err) });
    } finally {
      await appendWatcherTrace('run_finish', { reason: 'finally', trigger });
      await recordRunFinish(trigger, runResult || { ok: false, reason: 'unknown' }).catch(() => {});
      try { await writeDailyReports(); } catch (_) {}
      if (trigger === 'alarm') refreshAutoWatcherAlarm(true, 'after_alarm_run').catch(() => {});
      autoWatcherRunning = false;
    }
  }

  function initPrivateAutoWatcher(nextDeps) {
    deps = nextDeps;
    try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}

    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM_NAME) runAutoWatcherOnce('alarm');
    });

    chrome.runtime.onStartup.addListener(() => {
      refreshAutoWatcherAlarm(true, 'runtime_startup').catch(() => {});
    });

    chrome.runtime.onInstalled.addListener(() => {
      refreshAutoWatcherAlarm(true, 'runtime_installed').catch(() => {});
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (Object.keys(changes).some(key => key.startsWith('watcher'))) {
        const changedKeys = Object.keys(changes).filter(key => key.startsWith('watcher')).slice(0, 12).join(',');
        refreshAutoWatcherAlarm(true, `storage_changed:${changedKeys}`).catch(() => {});
      }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'ablesciRunAutoWatcherNow') {
        runAutoWatcherOnce('manual')
          .then(sendResponse)
          .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
        return true;
      }
      if (msg?.type === 'ablesciObserveDemandNow') {
        if (autoWatcherRunning) {
          sendResponse({ ok: false, reason: 'already_running' });
          return false;
        }
        getWatcherState()
          .then(state => {
            state.lastManualObserveStartedAt = new Date().toISOString();
            state.lastManualObserveStatus = 'running';
            return saveWatcherState(state);
          })
          .then(() => runAutoWatcherOnce('manual-observe'))
          .then(async result => {
            const state = await getWatcherState();
            state.lastManualObserveFinishedAt = new Date().toISOString();
            state.lastManualObserveStatus = result.ok ? 'ok' : 'failed';
            state.lastManualObserveReason = result.reason || '';
            await saveWatcherState(state);
          })
          .catch(async err => {
            const state = await getWatcherState();
            state.lastManualObserveFinishedAt = new Date().toISOString();
            state.lastManualObserveStatus = 'failed';
            state.lastManualObserveReason = err?.message || String(err);
            await saveWatcherState(state);
          });
        sendResponse({ ok: true, reason: 'demand_observe_started' });
        return false;
      }
      if (msg?.type === 'ablesciTestWatcherNotification') {
        notifyWatcherNeedsAttention('这是一条低频值守测试提醒，不会执行检查。')
          .then(sendResponse)
          .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
        return true;
      }
      if (msg?.type === 'ablesciClearAutoWatcherState') {
        chrome.storage.local.remove(AUTO_WATCHER_STATE_KEY).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg?.type === 'ablesciClearAutoWatcherLogs') {
        chrome.storage.local.remove([AUTO_WATCHER_LOG_KEY, AUTO_WATCHER_TRACE_KEY]).then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    });

    refreshAutoWatcherAlarm(true, 'init').catch(() => {});
  }

  globalThis.initPrivateAutoWatcher = initPrivateAutoWatcher;
})();
