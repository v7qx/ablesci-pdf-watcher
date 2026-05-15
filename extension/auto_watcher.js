'use strict';

(function () {
  const ALARM_NAME = 'ablesciAutoWatcher';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
  const DEMAND_SNAPSHOTS_KEY = 'demandSnapshots';
  const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
  const MAX_LOGS = 200;
  const MAX_DEMAND_SNAPSHOTS = 500;
  const REPORT_DIR = 'ablesci-watcher-reports';
  const ASSIST_RANDOM_PAGE_MIN = 3;
  const ASSIST_RANDOM_PAGE_MAX = 100;
  const ADVANCED_MODEL_MIN_DAYS = 2;
  const FALLBACK_PUBLISHER_WEIGHTS = {
    Elsevier: 2.8,
    ScienceDirect: 2.8,
    Wiley: 1.2,
    Springer: 1.1,
    Nature: 1.0,
    Oxford: 0.9,
    IEEE: 0.7,
    Unknown: 0.4
  };
  const SESSION_MODES = {
    slow: { median: 28, min: 15, max: 60, sizeWeights: [0.15, 0.45, 0.30, 0.10, 0.00] },
    normal: { median: 15, min: 8, max: 35, sizeWeights: [0.05, 0.20, 0.40, 0.25, 0.10] },
    fast: { median: 10, min: 6, max: 25, sizeWeights: [0.02, 0.10, 0.35, 0.35, 0.18] }
  };

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
      const isElsevierWaiting = u.searchParams.get('status') === 'waiting' &&
        /elsevier/i.test(u.searchParams.get('publisher') || '');
      if (isAblesci && isAssistList && isElsevierWaiting) {
        u.searchParams.set('page', String(randomIntInclusive(ASSIST_RANDOM_PAGE_MIN, ASSIST_RANDOM_PAGE_MAX)));
        return u.toString();
      }
    } catch (_) {
      // Keep the configured URL if it cannot be parsed.
    }
    return url;
  }

  function normalizeOptions(opts) {
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 60);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    return {
      ...opts,
      watcherEnabled: opts.watcherEnabled === true,
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
      watcherCfPauseThreshold: clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10),
      watcherQuantSchedulerEnabled: opts.watcherQuantSchedulerEnabled !== false,
      watcherObserveMode: opts.watcherObserveMode === 'observe_only' ? 'observe_only' : 'assist',
      watcherObserveOnly: opts.watcherObserveMode === 'observe_only',
      watcherDemandObserveUrl: normalizeListUrls([opts.watcherDemandObserveUrl], deps.defaultListUrls)[0],
      watcherObserveTimes: normalizeObserveTimes(opts.watcherObserveTimes),
      watcherObserveIntervalMinutes: clampNumber(opts.watcherObserveIntervalMinutes, 5, 1, 60),
      watcherObserveFallbackMinutes: clampNumber(opts.watcherObserveFallbackMinutes, 180, 30, 720),
      watcherWorkdays: normalizeWorkdays(opts.watcherWorkdays),
      watcherWorkWindows: normalizeWorkWindows(opts.watcherWorkWindows),
      watcherMonthlyTarget: clampNumber(opts.watcherMonthlyTarget, 500, 0, 5000),
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
      const mode = SESSION_MODES[state?.speedMode || 'normal'] || SESSION_MODES.normal;
      const sessionDelay = logNormalMinutes(mode.median, mode.min, mode.max);
      const observeDelay = opts.watcherObserveIntervalMinutes * (0.85 + Math.random() * 0.30);
      return Math.max(1, Math.min(sessionDelay, observeDelay));
    }
    const base = clampNumber(opts.watcherIntervalMinutes, 30, 10, 60);
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 60);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    const jitter = Math.max(1, Math.round(base * 0.2));
    const low = Math.max(min, base - jitter);
    const high = Math.min(max, base + jitter);
    return low + Math.random() * Math.max(1, high - low);
  }

  async function refreshAutoWatcherAlarm(clearExisting = true) {
    const opts = normalizeOptions(await deps.getOptions());
    if (clearExisting) await chrome.alarms.clear(ALARM_NAME);
    if (!opts.watcherEnabled) return;
    const state = await getWatcherState();
    const delay = randomIntervalMinutes(opts, state);
    state.nextScheduledAt = Date.now() + delay * 60 * 1000;
    await saveWatcherState(state);
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
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
    const reached = state.cfChallengeStreak >= threshold;
    if (reached) {
      state.pausedByCfChallenge = true;
      await chrome.storage.local.set({ watcherEnabled: false });
      await chrome.alarms.clear(ALARM_NAME);
    }
    await saveWatcherState(state);
    await incrementDaily('failed');
    await appendWatcherLog({
      detailUrl: listUrl,
      status: reached ? 'paused' : 'blocked',
      reason: reached ? `cf_challenge_${state.cfChallengeStreak}_paused` : `cf_challenge_${state.cfChallengeStreak}`
    });
    if (reached) {
      await notifyWatcherNeedsAttention(`连续 ${state.cfChallengeStreak} 次遇到 Ablesci 验证页，已暂停低频值守。手动处理后请重新开启。`, listUrl);
      await incrementDaily('notified');
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
    state.publisherModel = model;
    state.schedulerModelMode = model.ready ? 'advanced' : 'simple';
    return state;
  }

  async function recordDemandSnapshot(snapshot) {
    if (!snapshot || !Number.isFinite(Number(snapshot.totalSeeking))) return null;
    const snapshots = await getDemandSnapshots();
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
    state.lastDemandSnapshotAt = normalized.timestamp;
    state.lastDemandSnapshot = normalized;
    state.demandRegime = regime;
    state.publisherModel = model;
    state.schedulerModelMode = model.ready ? 'advanced' : 'simple';
    const target = calculateTargetState(state, normalizeOptions(await deps.getOptions()), regime);
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
    if (!due.due) return null;
    const parsed = await parseListUrl(opts.watcherDemandObserveUrl);
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

  async function appendWatcherLog(entry) {
    const stored = await chrome.storage.local.get(AUTO_WATCHER_LOG_KEY);
    const logs = Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [];
    logs.unshift({
      time: new Date().toISOString(),
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
    const stored = await chrome.storage.local.get([AUTO_WATCHER_STATE_KEY, AUTO_WATCHER_LOG_KEY, DEMAND_SNAPSHOTS_KEY]);
    const state = stored[AUTO_WATCHER_STATE_KEY] || {};
    const daily = state.daily?.[date] || {};
    const demandSnapshots = (Array.isArray(stored[DEMAND_SNAPSHOTS_KEY]) ? stored[DEMAND_SNAPSHOTS_KEY] : [])
      .filter(item => item.dayKey === date);
    const logs = (Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [])
      .filter(log => formatBeijingDateTime(log.time, true) === date);

    const csvRows = [
      ['time', 'assistId', 'doi', 'journalName', 'detailUrl', 'status', 'reason'],
      ...logs.map(log => [
        formatBeijingDateTime(log.time),
        log.assistId || '',
        log.doi || '',
        log.journalName || '',
        reportDetailValue(log),
        log.status || '',
        log.reason || ''
      ])
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
      `- Demand factor: ${Number(state.demandFactor || 1).toFixed(2)}`,
      `- Trend factor: ${Number(state.trendFactor || 1).toFixed(2)}`,
      `- Today target: ${Number(state.todayTarget || 0)}`,
      `- Latest demand: ${Number(state.lastDemandSnapshot?.totalSeeking || 0)}`,
      `- Latest demand anomaly: ${state.lastDemandAnomaly?.dayKey === date ? `${state.lastDemandAnomaly.anomalyType || 'yes'} (${Number(state.lastDemandAnomaly.totalSeeking || 0)})` : 'none'}`,
      '',
      '## Demand Snapshots',
      '',
      '| Time | Total | Supplement | Regime | Anomaly | Top Publishers |',
      '| --- | --- | --- | --- | --- | --- |',
      ...demandSnapshots.slice(0, 20).map(item => {
        const top = Object.entries(item.publisherCounts || {})
          .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
          .slice(0, 5)
          .map(([name, count]) => `${name}:${count}`)
          .join(', ');
        return `| ${formatBeijingDateTime(item.timestamp)} | ${Number(item.totalSeeking || 0)} | ${Number(item.supplementCount || 0)} | ${item.regime || ''} | ${item.demandAnomaly ? item.anomalyType || 'yes' : ''} | ${top.replace(/\|/g, '\\|')} |`;
      }),
      '',
      '## Recent Logs',
      '',
      '| Time | Status | Reason | Journal | DOI | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      ...logs.slice(0, 80).map(log => [
        formatBeijingDateTime(log.time),
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

  function orderCandidatesForRun(candidates, state) {
    const list = Array.isArray(candidates) ? candidates.slice() : [];
    if (state?.schedulerModelMode !== 'advanced') return list;
    return list
      .map((candidate, index) => ({ candidate, index, score: candidateModelScore(candidate, state) }))
      .sort((a, b) => (b.score - a.score) || (a.index - b.index))
      .map(item => item.candidate);
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

  async function isHighRiskJournal(journalName) {
    const journal = normalizeText(journalName);
    if (!journal) return false;
    const stored = await chrome.storage.local.get(JOURNAL_ACCESS_STATS_KEY);
    const stats = stored[JOURNAL_ACCESS_STATS_KEY] || {};
    const item = stats[journal];
    if (!item) return false;
    const failCount = Number(item.failCount || 0);
    const successCount = Number(item.successCount || 0);
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

  async function openHiddenTab(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id);
    return tab;
  }

  async function closeTabQuietly(tabId) {
    try { await chrome.tabs.remove(tabId); } catch (_) {}
  }

  async function parseListUrl(url) {
    const tab = await openHiddenTab(url);
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: parseAssistListPage
      });
      return result?.[0]?.result || { cfChallenge: false, candidates: [] };
    } finally {
      await closeTabQuietly(tab.id);
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
    const tab = await openHiddenTab(candidate.detailUrl);
    try {
      const response = await extractDetailPayload(tab.id);
      if (!response?.ok) {
        return { ok: false, reason: response?.error || 'extract_detail_failed', tabId: tab.id };
      }
      return { ok: true, payload: response.payload, tabId: tab.id };
    } catch (err) {
      return { ok: false, reason: err?.message || String(err), tabId: tab.id };
    }
  }

  function makeWatcherPort(context) {
    return {
      name: 'ablesci-auto-watcher',
      postMessage(msg) {
        if (!msg || !context) return;
        if (msg.type === 'error') {
          updateProcessed(context.key, 'failed', msg.message || 'upload_failed').catch(() => {});
          incrementDaily('failed').catch(() => {});
          appendWatcherLog({
            ...context.payload,
            detailUrl: context.detailUrl,
            status: 'failed',
            reason: msg.message || 'upload_failed'
          }).then(writeDailyReports).catch(() => {});
        }
        if (msg.type === 'done' && msg.blocked) {
          updateProcessed(context.key, 'failed', msg.message || 'blocked').catch(() => {});
          incrementDaily('failed').catch(() => {});
          appendWatcherLog({
            ...context.payload,
            detailUrl: context.detailUrl,
            status: 'failed',
            reason: msg.message || 'blocked'
          }).then(writeDailyReports).catch(() => {});
        }
      },
      onDisconnect: {
        addListener() {}
      }
    };
  }

  async function handleAllowedPayload(candidate, payload, opts, detailTabId) {
    payload.triggeredBy = 'auto_watcher';
    const key = getProcessedKey(candidate, payload);

    if (opts.watcherSkipHighRiskJournal && await isHighRiskJournal(payload.journalName)) {
      await closeTabQuietly(detailTabId);
      await updateProcessed(key, 'skipped', 'high_risk_journal');
      await incrementDaily('skipped');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: '本地记录近期多次失败，可能无权限' });
      return false;
    }

    if (!opts.watcherAutoDownload) {
      await notifyWatcherNeedsAttention('低频值守发现候选，已保留求助详情页等待人工处理。', candidate.detailUrl);
      await incrementDaily('notified');
      await updateProcessed(key, 'skipped', 'manual_detail_opened');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: 'manual_detail_opened' });
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
      await updateProcessed(key, 'skipped', 'active_task');
      await incrementDaily('skipped');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: 'active_task' });
      return false;
    }

    deps.enqueueUpload(makeWatcherPort({ key, payload, detailUrl: candidate.detailUrl }), payload);
    if (!payload.downloadOnly) await closeTabQuietly(detailTabId);
    await incrementDaily('downloaded');
    if (opts.watcherAutoUpload && !opts.watcherUploadConfirmRequired) await incrementDaily('uploaded');
    await updateProcessed(key, 'success', payload.downloadOnly ? 'queued_download_only' : 'queued_upload');
    await appendWatcherLog({
      ...payload,
      detailUrl: candidate.detailUrl,
      status: payload.downloadOnly ? 'download_only' : 'queued_upload',
      reason: payload.downloadOnly ? 'upload_confirmation_required' : 'auto_upload_enabled'
    });
    await notifyWatcherNeedsAttention(payload.downloadOnly ? '低频值守已排队下载校验一个候选，并保留求助详情页等待人工上传确认。' : '低频值守已排队处理一个候选。');
    await incrementDaily('notified');
    return true;
  }

  async function runAutoWatcherOnce(trigger = 'alarm') {
    if (autoWatcherRunning) return { ok: false, reason: 'already_running' };
    autoWatcherRunning = true;
    try {
      const opts = normalizeOptions(await deps.getOptions());
      if (!opts.watcherEnabled && trigger !== 'manual' && trigger !== 'manual-observe') return { ok: false, reason: 'disabled' };
      if (deps.hasActiveTask()) return { ok: false, reason: 'active_task' };
      if (opts.watcherQuantSchedulerEnabled && trigger !== 'manual' && !isInWorkSchedule(opts)) {
        return { ok: true, reason: 'outside_work_schedule' };
      }

      const observeResult = await collectDemandIfDue(opts, trigger === 'manual-observe');
      if (observeResult?.reason === 'cf_challenge') {
        if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, opts.watcherDemandObserveUrl);
        return { ok: false, reason: 'cf_challenge' };
      }
      if (trigger === 'manual-observe') {
        return { ok: !!observeResult?.snapshot, reason: observeResult?.snapshot ? 'demand_observed' : 'demand_observe_skipped' };
      }
      if (opts.watcherObserveMode === 'observe_only') {
        return { ok: true, reason: observeResult?.snapshot ? 'observe_only_snapshot' : 'observe_only_waiting' };
      }

      const stateForTargets = await getWatcherState();
      if (opts.watcherQuantSchedulerEnabled) await refreshPublisherModelFromSnapshots(stateForTargets);
      const targetState = calculateTargetState(stateForTargets, opts, stateForTargets.demandRegime || 'normal');
      Object.assign(stateForTargets, targetState);
      await saveWatcherState(stateForTargets);
      if (targetState.todayTarget > 0 && await getDailyCount('downloaded') >= targetState.todayTarget) {
        return { ok: false, reason: 'today_target_reached' };
      }
      if (opts.watcherDailyLimit > 0 && await getDailyCount('downloaded') >= opts.watcherDailyLimit) {
        return { ok: false, reason: 'daily_limit' };
      }

      let handledCount = 0;
      const targetSessionSize = opts.watcherQuantSchedulerEnabled ? sessionSize(opts, stateForTargets) : 1;
      if (targetSessionSize <= 0) return { ok: true, reason: observeResult?.snapshot ? 'observe_only_session' : 'session_size_zero' };

      for (const listUrl of opts.watcherListUrls) {
        const pickedListUrl = randomizeAssistListUrl(listUrl);
        stateForTargets.lastPickedListUrl = pickedListUrl;
        await saveWatcherState(stateForTargets);
        await incrementDaily('checked');
        const parsed = await parseListUrl(pickedListUrl);
        if (parsed.cfChallenge) {
          if (opts.watcherStopOnCfChallenge) await recordCfChallenge(opts, pickedListUrl);
          return { ok: false, reason: 'cf_challenge' };
        }
        await resetCfChallengeStreak();

        const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets);
        for (const candidate of candidates) {
          if (handledCount >= targetSessionSize) return { ok: true, reason: 'session_target_reached' };
          const listAllowed = isListCandidateAllowed(candidate, opts);
          if (!listAllowed.ok) continue;
          if (await wasRecentlyProcessed(candidate)) continue;

          const detail = await inspectDetail(candidate);
          if (!detail.ok) {
            await closeTabQuietly(detail.tabId);
            await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
            await incrementDaily('failed');
            await appendWatcherLog({ ...candidate, status: 'failed', reason: detail.reason });
            continue;
          }

          const payload = detail.payload;
          const detailAllowed = isDetailAllowedForWatcher(payload, opts);
          const key = getProcessedKey(candidate, payload);
          if (!detailAllowed.ok) {
            await closeTabQuietly(detail.tabId);
            await updateProcessed(key, 'skipped', detailAllowed.reason);
            await incrementDaily('skipped');
            await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: detailAllowed.reason });
            continue;
          }

          const handled = await handleAllowedPayload(candidate, payload, opts, detail.tabId);
          if (!handled) await closeTabQuietly(detail.tabId);
          if (handled) {
            handledCount += 1;
            if (handledCount >= targetSessionSize || deps.hasActiveTask()) {
              return { ok: true, reason: handledCount > 1 ? 'session_candidates_handled' : 'candidate_handled' };
            }
          }
        }
      }

      return { ok: true, reason: handledCount ? 'session_candidates_handled' : 'no_candidate' };
    } catch (err) {
      await incrementDaily('failed');
      await appendWatcherLog({ status: 'failed', reason: err?.message || String(err) });
      return { ok: false, reason: err?.message || String(err) };
    } finally {
      try { await writeDailyReports(); } catch (_) {}
      if (trigger === 'alarm') refreshAutoWatcherAlarm().catch(() => {});
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
      refreshAutoWatcherAlarm().catch(() => {});
    });

    chrome.runtime.onInstalled.addListener(() => {
      refreshAutoWatcherAlarm().catch(() => {});
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (Object.keys(changes).some(key => key.startsWith('watcher'))) {
        refreshAutoWatcherAlarm().catch(() => {});
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
        chrome.storage.local.remove(AUTO_WATCHER_LOG_KEY).then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    });

    refreshAutoWatcherAlarm().catch(() => {});
  }

  globalThis.initPrivateAutoWatcher = initPrivateAutoWatcher;
})();
