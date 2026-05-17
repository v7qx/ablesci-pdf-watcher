'use strict';

(function () {
  const ALARM_NAME = 'ablesciAutoWatcher';
  const BADGE_REFRESH_ALARM_NAME = 'ablesciBadgeRefresh';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
  const AUTO_WATCHER_TRACE_KEY = 'autoWatcherTraceLogs';
  const DEMAND_SNAPSHOTS_KEY = 'demandSnapshots';
  const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
  const MAX_LOGS = 200;
  const MAX_TRACE_LOGS = 1200;
  const MAX_DEMAND_SNAPSHOTS = 500;
  const MAX_SESSION_CANDIDATES = 10;
  const ACTIVE_RUN_RETENTION_DAYS = 62;
  const MARKET_RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const MARKET_TOP_PUBLISHERS = 8;
  const REPORT_DIR = 'ablesci-watcher-reports';
  const ASSIST_RANDOM_PAGE_RANGES = {
    elsevier: {
      min: 3,
      max: 200,
      curve: 'mixed_backlog_power',
      frontProbability: 0.20,
      frontMin: 3,
      frontMax: 50,
      alpha: 1.2
    },
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
    slow: { median: 28, min: 15, max: 60, sizeWeights: [0.14, 0.48, 0.25, 0.10, 0.03, 0, 0, 0, 0, 0, 0] },
    normal: { median: 15, min: 8, max: 35, sizeWeights: [0.05, 0.20, 0.34, 0.24, 0.11, 0.04, 0.02, 0, 0, 0, 0] },
    fast: { median: 10, min: 6, max: 25, sizeWeights: [0.02, 0.08, 0.22, 0.27, 0.20, 0.11, 0.06, 0.025, 0.01, 0.004, 0.001] }
  };
  const ADVANCED_ITEM_GAP = { median: 3, min: 1, max: 8 };
  const ADVANCED_COOLDOWN = { median: 18, min: 6, max: 90 };

  let deps = null;
  let autoWatcherRunning = false;
  let badgeRefreshTimer = null;
  const BADGE_REFRESH_INTERVAL_MS = 30 * 1000;
  const HIGH_RISK_FAIL_THRESHOLD = 10;

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

  function formatBeijingTimeOnly(value) {
    const full = formatBeijingDateTime(value);
    const match = String(full).match(/\s(\d{2}:\d{2}:\d{2})$/);
    return match ? match[1] : full;
  }

  function formatBeijingDateOnly(value) {
    return formatBeijingDateTime(value, true);
  }

  function looksLikeIsoDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
  }

  function looksLikeTimestampMs(value) {
    return Number.isFinite(Number(value)) && Number(value) > 1600000000000 && Number(value) < 4100000000000;
  }

  function reportValueForJson(value, key = '') {
    if (looksLikeIsoDate(value)) return formatBeijingDateTime(value);
    if (/at$|time|until|scheduled/i.test(String(key || '')) && looksLikeTimestampMs(value)) return formatBeijingDateTime(Number(value));
    if (Array.isArray(value)) return value.map(item => reportValueForJson(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reportValueForJson(v, k)]));
    }
    return value;
  }

  function reportJson(value) {
    return JSON.stringify(reportValueForJson(value || {}));
  }

  function countdownText(value, now = Date.now()) {
    const t = value ? new Date(value).getTime() : 0;
    if (!Number.isFinite(t) || t <= 0) return '';
    const seconds = Math.max(0, Math.round((t - now) / 1000));
    if (seconds <= 0) return 'due';
    const minutes = Math.floor(seconds / 60);
    const sec = seconds % 60;
    if (minutes < 60) return `${minutes}m${String(sec).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  }

  function nextDisplaySchedule(state = {}, opts = null) {
    const schedulerMode = opts?.watcherSchedulerMode || state.currentSchedulerMode || '';
    const assistAt = state.nextAssistRunAt || '';
    const wakeAt = state.chromeAlarmScheduledAt || state.nextScheduledAt || '';
    if (schedulerMode === 'fixed') {
      return {
        kind: 'scheduled_check',
        time: wakeAt,
        label: '下一次检查'
      };
    }
    if (assistAt) {
      return {
        kind: 'assist',
        time: assistAt,
        label: '下一次应助尝试'
      };
    }
    return {
      kind: 'wake',
      time: wakeAt,
      label: '下一次唤醒'
    };
  }

  async function updateActionBadge(state = null) {
    try {
      const current = state || await getWatcherState();
      const opts = deps?.getOptions ? normalizeOptions(await deps.getOptions()) : {};
      const schedule = nextDisplaySchedule(current, opts);
      const text = countdownText(schedule.time);
      const shortText = text === 'due'
        ? 'due'
        : (text ? text.replace(/(\d+)m\d+s$/, '$1m').replace(/(\d+)h(\d+)m$/, '$1h') : '');
      if (opts.watcherBadgeCountdownEnabled !== false) {
        await chrome.action.setBadgeText({ text: shortText.slice(0, 4) });
        await chrome.action.setBadgeBackgroundColor({ color: text === 'due' ? '#dc2626' : '#2563eb' });
      } else {
        await chrome.action.setBadgeText({ text: '' });
      }
      const title = text
        ? `Ablesci PDF Watcher\n${schedule.label}：${formatBeijingDateTime(schedule.time)}\n倒计时：${text}`
        : 'Ablesci PDF Watcher';
      await chrome.action.setTitle({ title });
    } catch (_) {}
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

  function clampInt(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  function pageRangeMetaFromUrl(url) {
    try {
      const u = new URL(url);
      const isAblesci = /(^|\.)ablesci\.com$/i.test(u.hostname);
      const isAssistList = /\/assist\/index$/i.test(u.pathname);
      const publisher = String(u.searchParams.get('publisher') || '').toLowerCase();
      const range = ASSIST_RANDOM_PAGE_RANGES[publisher];
      if (!isAblesci || !isAssistList || u.searchParams.get('status') !== 'waiting' || !range) {
        return null;
      }
      return { publisher, range };
    } catch (_) {
      return null;
    }
  }

  function pickAssistPage(range) {
    const min = clampInt(range?.min ?? 1, 1, 9999);
    const max = clampInt(range?.max ?? min, min, 9999);
    const curve = String(range?.curve || 'uniform').trim().toLowerCase();
    if (curve !== 'mixed_backlog_power') {
      return {
        pickedPage: randomIntInclusive(min, max),
        pageCurve: 'uniform',
        pageMin: min,
        pageMax: max,
        frontHit: false,
        alpha: ''
      };
    }

    const frontProbability = clampNumber(range?.frontProbability, 0.20, 0, 1);
    const frontMin = clampInt(range?.frontMin ?? min, min, max);
    const frontMax = clampInt(range?.frontMax ?? frontMin, frontMin, max);
    const alpha = clampNumber(range?.alpha, 1.2, 0, 4);
    const frontHit = Math.random() < frontProbability;
    const pickedPage = frontHit
      ? randomIntInclusive(frontMin, frontMax)
      : clampInt(min + Math.pow(Math.random(), 1 / (alpha + 1)) * (max - min), min, max);
    return {
      pickedPage,
      pageCurve: 'mixed_backlog_power',
      pageMin: min,
      pageMax: max,
      frontHit,
      alpha
    };
  }

  function randomizeAssistListUrlWithMeta(url) {
    const meta = {
      configuredUrl: url,
      pickedListUrl: url,
      publisher: '',
      pageCurve: '',
      pickedPage: '',
      pageMin: '',
      pageMax: '',
      frontHit: false,
      alpha: ''
    };
    try {
      const u = new URL(url);
      const pageMeta = pageRangeMetaFromUrl(url);
      if (!pageMeta) return meta;
      const picked = pickAssistPage(pageMeta.range);
      u.searchParams.set('page', String(picked.pickedPage));
      return {
        ...picked,
        publisher: pageMeta.publisher,
        configuredUrl: url,
        pickedListUrl: u.toString()
      };
    } catch (_) {
      return meta;
    }
  }

  function randomizeAssistListUrl(url) {
    return randomizeAssistListUrlWithMeta(url).pickedListUrl || url;
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
      watcherBadgeCountdownEnabled: opts.watcherBadgeCountdownEnabled !== false,
      watcherReportDir: String(opts.watcherReportDir || '').trim(),
      watcherNoDownloadTimeoutMinutes: clampNumber(opts.watcherNoDownloadTimeoutMinutes, 1, 0.25, 60),
      watcherDownloadTimeoutMinutes: clampNumber(opts.watcherDownloadTimeoutMinutes, 5, 1, 120),
      watcherTaskTimeoutMinutes: clampNumber(opts.watcherTaskTimeoutMinutes, 10, 1, 180),
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
      watcherMaxPerSession: clampNumber(opts.watcherMaxPerSession, 1, 1, MAX_SESSION_CANDIDATES),
      watcherAllowZeroSession: opts.watcherAllowZeroSession === true
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
    return Math.round(clampNumber(opts?.watcherMaxPerSession, 1, 1, MAX_SESSION_CANDIDATES));
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
    const mode = SESSION_MODES[state?.speedMode || 'normal'] || SESSION_MODES.normal;
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

  function isAssistDue(state = null) {
    const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
    return !Number.isFinite(nextAssistMs) || nextAssistMs <= Date.now() + 1000;
  }

  function hasPendingAssist(state = null) {
    const nextAssistMs = state?.nextAssistRunAt ? new Date(state.nextAssistRunAt).getTime() : 0;
    return Number.isFinite(nextAssistMs) && nextAssistMs > Date.now() + 1000;
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
      await chrome.alarms.clear(ALARM_NAME);
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
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
    const alarm = await chrome.alarms.get(ALARM_NAME).catch(() => null);
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
    await chrome.alarms.clear(ALARM_NAME);
    const delay = Math.max(minDelayMinutes, (nextAssistMs - Date.now()) / 60000);
    state.nextScheduledAt = Date.now() + delay * 60 * 1000;
    state.currentSchedulerMode = opts.watcherSchedulerMode;
    state.currentExecutionModel = opts.watcherAdvancedSchedulerEnabled ? 'advanced_session' : 'quant_rules';
    state.lastAlarmRefreshReason = reason;
    await saveWatcherState(state);
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay });
    const alarm = await chrome.alarms.get(ALARM_NAME).catch(() => null);
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
    state.activeRunDays = state.activeRunDays || {};
    state.activeRunDays[key] = Number(state.activeRunDays[key] || 0) + 1;
    const keepAfter = Date.now() - ACTIVE_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const dayKey of Object.keys(state.activeRunDays)) {
      const t = new Date(`${dayKey}T00:00:00+08:00`).getTime();
      if (!Number.isFinite(t) || t < keepAfter) delete state.activeRunDays[dayKey];
    }
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

  async function recordAttemptFinish(attempt, result) {
    const state = await getWatcherState();
    const counters = dailyCounterSnapshot(state);
    const finished = {
      ...attempt,
      finishedAt: new Date().toISOString(),
      resultReason: normalizeText(result?.reason || 'unknown').slice(0, 160),
      nextAssistAfter: state.nextAssistRunAt || '',
      nextAlarmAfter: state.nextScheduledAt || '',
      chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
      checkedAfter: counters.checked,
      downloadedAfter: counters.downloaded,
      failedAfter: counters.failed,
      skippedAfter: counters.skipped
    };
    finished.checkedDelta = Number(finished.checkedAfter || 0) - Number(finished.checkedBefore || 0);
    finished.downloadedDelta = Number(finished.downloadedAfter || 0) - Number(finished.downloadedBefore || 0);
    finished.failedDelta = Number(finished.failedAfter || 0) - Number(finished.failedBefore || 0);
    finished.skippedDelta = Number(finished.skippedAfter || 0) - Number(finished.skippedBefore || 0);
    state.lastAttempt = finished;
    await saveWatcherState(state);
    updateActionBadge(state).catch(() => {});
    await appendWatcherTrace('run_attempt_summary', {
      reason: finished.resultReason,
      trigger: finished.trigger,
      observeSnapshot: finished.observeSnapshot,
      targetSessionSize: finished.targetSessionSize,
      checkedDelta: finished.checkedDelta,
      downloadedDelta: finished.downloadedDelta,
      listScanStarted: finished.listScanStarted,
      pickedListUrl: finished.pickedListUrl,
      pickedPage: finished.pickedPage,
      pageCurve: finished.pageCurve,
      nextAssistBefore: finished.nextAssistBefore,
      nextAssistAfter: finished.nextAssistAfter,
      nextAlarmAfter: finished.nextAlarmAfter
    });
  }

  async function getDailyCount(field) {
    const state = await getWatcherState();
    const item = state.daily?.[todayKey()] || {};
    return Number(item[field] || 0);
  }

  function dailyCounterSnapshot(state) {
    const item = state?.daily?.[todayKey()] || {};
    return {
      checked: Number(item.checked || 0),
      downloaded: Number(item.downloaded || 0),
      failed: Number(item.failed || 0),
      skipped: Number(item.skipped || 0)
    };
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
    const monthlyTarget = Number(opts.watcherMonthlyTarget || 0);
    const model = state.publisherModel || { ready: false };
    const modelMode = model.ready ? 'advanced' : 'simple';
    const progress = workTimeProgressDetails(opts);
    const availability = availabilitySnapshot(state, opts, progress);
    const effectiveProgress = availability.enoughData ? availability.activeTimeProgressRatio : progress.ratio;
    const expectedDone = Math.round(monthlyTarget * Math.min(1, effectiveProgress));
    const lag = expectedDone - done;
    const speedMode = speedModeFromTarget({ error: lag, monthlyTarget, demandRegime });
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
        todayTarget: 0,
        schedulerModelMode: 'simple',
        demandFactor: 1,
        trendFactor: 1
      };
    }
    const day = Number(todayKey().slice(8, 10));
    const days = daysInCurrentMonth();
    const baseTodayTarget = Math.max(0, monthlyTarget - done) / Math.max(1, days - day + 1);
    const thresholds = lagThresholds(monthlyTarget);
    const rawDemandFactor = modelMode === 'advanced' ? demandFactorByRegime(demandRegime) : 1;
    const demandFactor = demandRegime === 'quiet' && lag >= thresholds.medium ? Math.max(rawDemandFactor, 0.9) : rawDemandFactor;
    const trendFactor = modelMode === 'advanced' ? trendFactorFromModel(model) : 1;
    const rawTodayTarget = Math.ceil(baseTodayTarget * demandFactor * trendFactor);
    const todayTarget = clampNumber(rawTodayTarget, opts.watcherMinDailyTarget, opts.watcherMinDailyTarget, opts.watcherMaxDailyTarget);
    return {
      monthKey: monthKey(),
      monthDone: done,
      expectedDone,
      lag,
      targetError: lag,
      speedMode,
      workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
      activeTimeProgressRatio: availability.activeTimeProgressRatio,
      availabilityFactor: availability.availabilityFactor,
      availabilityExpectedWakeCount: availability.expectedWakeCount,
      availabilityActualWakeCount: availability.actualWakeCount,
      todayTarget,
      schedulerModelMode: modelMode,
      demandFactor,
      trendFactor
    };
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
    const progress = workTimeProgressDetails(opts);
    const availability = availabilitySnapshot(state, opts, progress);
    const effectiveProgress = availability.enoughData ? availability.activeTimeProgressRatio : progress.ratio;
    const expectedDone = Math.round(monthlyTarget * Math.min(1, effectiveProgress));
    const error = expectedDone - actualDone;
    const risk = riskSnapshot(state, opts);
    const daily = state.daily?.[todayKey()] || {};
    const failures = Number(daily.failed || 0);
    const successes = Number(daily.downloaded || 0);
    const failureRate = failures / Math.max(1, failures + successes);
    const p = Number(market?.sameSlotPercentile ?? 0.5);
    const thresholds = lagThresholds(monthlyTarget);
    const demandMultiplier = p >= 0.9
      ? 1.25
      : (p <= 0.2 ? (error >= thresholds.medium ? 0.9 : 0.75) : 1);
    const proportional = monthlyTarget > 0 ? error / Math.max(1, monthlyTarget) : 0;
    let rateMultiplier = 1 + proportional * 3;
    rateMultiplier *= demandMultiplier;
    rateMultiplier *= Math.max(0.35, 1 - failureRate * 0.8);
    rateMultiplier *= risk.nearLimit ? 0.45 : 1;
    if (risk.exhausted) rateMultiplier = 0;
    if (!risk.nearLimit && error >= thresholds.severe) rateMultiplier = Math.max(rateMultiplier, 1.55);
    if (!risk.nearLimit && error >= thresholds.medium) rateMultiplier = Math.max(rateMultiplier, 1.05);
    rateMultiplier = Math.max(0, Math.min(3, rateMultiplier));
    const speedMode = speedModeFromTarget({
      error,
      monthlyTarget,
      demandRegime: market?.marketRegime || 'normal',
      riskExhausted: risk.exhausted,
      rateMultiplier
    });
    const todayTarget = monthlyTarget <= 0 ? 0 : clampNumber(Math.ceil(Math.max(0, error) + (rateMultiplier > 1 ? rateMultiplier : 0)), opts.watcherMinDailyTarget, opts.watcherMinDailyTarget, opts.watcherMaxDailyTarget);
    const hourTarget = Math.max(0, Math.min(opts.watcherMaxPerSession * 3, Math.ceil(rateMultiplier * opts.watcherMaxPerSession)));
    const sessionIntensity = Math.max(0, Math.min(1, rateMultiplier / 3));
    return {
      schedulerModelMode: 'advanced',
      speedMode,
      workTimeProgressRatio: Number(progress.ratio.toFixed(4)),
      activeTimeProgressRatio: availability.activeTimeProgressRatio,
      availabilityFactor: availability.availabilityFactor,
      availabilityExpectedWakeCount: availability.expectedWakeCount,
      availabilityActualWakeCount: availability.actualWakeCount,
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

  function sessionSize(opts, state) {
    const mode = SESSION_MODES[state?.speedMode || 'normal'] || SESSION_MODES.normal;
    const decision = weightedPickIndexWithDebug(mode.sizeWeights);
    const picked = decision.index;
    const cap = sessionExecutionCap(opts, state, opts?.watcherQuantSchedulerEnabled !== false);
    const finalSize = Math.min(cap, Math.max(0, picked));
    if (state) {
      state.lastSessionSizeDecision = {
        mode: state.speedMode || 'normal',
        picked,
        cap,
        finalSize,
        random: Number(decision.random.toFixed(6)),
        total: Number(decision.total.toFixed(6)),
        weights: decision.weights,
        allowZero: opts?.watcherAllowZeroSession === true
      };
    }
    return finalSize;
  }

  function advancedSessionSize(opts, state) {
    const risk = riskSnapshot(state, opts);
    if (risk.exhausted) return 0;
    const cap = Math.min(sessionExecutionCap(opts, state, true), risk.remaining);
    if (cap <= 0) return 0;
    const mode = SESSION_MODES[state?.speedMode || 'normal'] || SESSION_MODES.normal;
    const decision = weightedPickIndexWithDebug(mode.sizeWeights);
    const modeSize = decision.index;
    const multiplier = Number(state.rateMultiplier || 1);
    const intensity = Number(state.sessionIntensity || 0.4);
    const parentOrderSize = Math.ceil(maxSessionCandidates(opts) * Math.max(0.12, intensity) * 0.75);
    const boost = multiplier > 2.0 ? 2 : (multiplier > 1.45 ? 1 : 0);
    const desired = Math.max(modeSize, parentOrderSize) + boost;
    const finalSize = Math.max(0, Math.min(cap, desired));
    if (state) {
      state.lastSessionSizeDecision = {
        mode: state.speedMode || 'normal',
        picked: modeSize,
        cap,
        finalSize,
        random: Number(decision.random.toFixed(6)),
        total: Number(decision.total.toFixed(6)),
        weights: decision.weights,
        allowZero: opts?.watcherAllowZeroSession === true,
        parentOrderSize,
        boost
      };
    }
    return finalSize;
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
    const chromeAlarm = await chrome.alarms.get(ALARM_NAME).catch(() => null);
    const chromeAlarmScheduledAt = chromeAlarm?.scheduledTime ? new Date(chromeAlarm.scheduledTime).toISOString() : (state.chromeAlarmScheduledAt || '');
    const lastAttempt = state.lastAttempt || {};
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
      'targetError', 'activeTimeProgressRatio', 'availabilityFactor', 'availabilityActualWakeCount', 'availabilityExpectedWakeCount',
      'rateMultiplier', 'riskUsed', 'riskLimit', 'sessionSize', 'sessionHandledCount',
      'sessionDurationMs', 'score', 'estimatedSuccessRate', 'demandPressure', 'sourceTrend',
      'currentStrategy', 'nextAssistRunAt', 'nextAssistStrategy', 'nextAssistReason', 'nextAssistDelayMinutes',
      'nextAssistModelDelayMinutes', 'nextAssistGuardMinutes', 'nextAssistGuardMode', 'nextAssistGuardLiftMinutes',
      'nextAssistGuardWeight', 'nextAssistPlannedAt', 'nextAssistMarketDataAt', 'nextWakeAt', 'chromeAlarmScheduledAt',
      'lastAttemptStartedAt', 'lastAttemptFinishedAt', 'lastAttemptResult', 'lastAttemptObserveSnapshot',
      'lastAttemptTargetSessionSize', 'lastAttemptCheckedDelta', 'lastAttemptDownloadedDelta',
      'lastAttemptListScanStarted', 'lastAttemptPickedListUrl', 'pickedPage', 'pageCurve', 'pageMin', 'pageMax',
      'pageFrontHit', 'pageAlpha', 'randomSessionPicked', 'randomSessionFinalSize',
      'randomValue', 'step', 'trigger', 'tabId', 'url', 'details'
    ];
    const baseReportFields = {
      marketRegime: state.marketRegime || state.marketData?.marketRegime || state.demandRegime || '',
      workTimeProgressRatio: state.workTimeProgressRatio || '',
      expectedDone: state.expectedDone || '',
      actualDone: state.actualDone || state.monthDone || '',
      targetError: state.targetError || state.lag || '',
      activeTimeProgressRatio: state.activeTimeProgressRatio || '',
      availabilityFactor: state.availabilityFactor || '',
      availabilityActualWakeCount: state.availabilityActualWakeCount || '',
      availabilityExpectedWakeCount: state.availabilityExpectedWakeCount || '',
      rateMultiplier: state.rateMultiplier || '',
      riskUsed: daily.riskUsed || state.riskUsed || '',
      riskLimit: state.riskLimit || '',
      sessionSize: state.lastSession?.targetSessionSize || '',
      sessionHandledCount: state.lastSession?.handledCount || '',
      sessionDurationMs: state.lastSession?.sessionDurationMs || '',
      currentStrategy: state.lastAssistStrategy || state.currentExecutionModel || '',
      nextAssistRunAt: state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : '',
      nextAssistStrategy: state.nextAssistStrategy || '',
      nextAssistReason: state.nextAssistReason || '',
      nextAssistDelayMinutes: state.nextAssistDelayMinutes || '',
      nextAssistModelDelayMinutes: state.nextAssistModelDelayMinutes || '',
      nextAssistGuardMinutes: state.nextAssistGuardMinutes || '',
      nextAssistGuardMode: state.nextAssistGuardMode || '',
      nextAssistGuardLiftMinutes: state.nextAssistGuardLiftMinutes || '',
      nextAssistGuardWeight: state.nextAssistGuardWeight || '',
      nextAssistPlannedAt: state.nextAssistPlannedAt ? formatBeijingDateTime(state.nextAssistPlannedAt) : '',
      nextAssistMarketDataAt: state.nextAssistPlanningData?.marketDataAt ? formatBeijingDateTime(state.nextAssistPlanningData.marketDataAt) : '',
      nextWakeAt: chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : ''),
      chromeAlarmScheduledAt: chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : '',
      lastAttemptStartedAt: lastAttempt.startedAt ? formatBeijingDateTime(lastAttempt.startedAt) : '',
      lastAttemptFinishedAt: lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : '',
      lastAttemptResult: lastAttempt.resultReason || '',
      lastAttemptObserveSnapshot: lastAttempt.observeSnapshot === true ? 'true' : '',
      lastAttemptTargetSessionSize: lastAttempt.targetSessionSize ?? '',
      lastAttemptCheckedDelta: lastAttempt.checkedDelta ?? '',
      lastAttemptDownloadedDelta: lastAttempt.downloadedDelta ?? '',
      lastAttemptListScanStarted: lastAttempt.listScanStarted === true ? 'true' : '',
      lastAttemptPickedListUrl: lastAttempt.pickedListUrl || '',
      pickedPage: lastAttempt.pickedPage ?? '',
      pageCurve: lastAttempt.pageCurve || '',
      pageMin: lastAttempt.pageMin ?? '',
      pageMax: lastAttempt.pageMax ?? '',
      pageFrontHit: lastAttempt.frontHit === true ? 'true' : '',
      pageAlpha: lastAttempt.alpha ?? '',
      randomSessionPicked: lastAttempt.randomSessionPicked ?? '',
      randomSessionFinalSize: lastAttempt.randomSessionFinalSize ?? '',
      randomValue: lastAttempt.randomValue ?? ''
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
      reportRow('assist_strategy', {
        time: state.lastAssistDecisionAt ? formatBeijingDateTime(state.lastAssistDecisionAt) : formatBeijingDateTime(new Date()),
        status: state.lastAssistStrategy || '',
        reason: reportJson(state.lastAssistDecision || {})
      }),
      reportRow('next_assist', {
        time: state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : '',
        status: state.nextAssistStrategy || '',
        reason: reportJson(state.nextAssistPlan || {})
      }),
      reportRow('last_attempt', {
        time: lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : '',
        status: lastAttempt.resultReason || '',
        reason: reportJson(lastAttempt || {}),
        trigger: lastAttempt.trigger || '',
        url: lastAttempt.pickedListUrl || ''
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
        details: reportJson(trace.details || {})
      }))
    ];
    const csv = csvRows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
    const skipDecisionRows = [
      ...logs
        .filter(log => /skipped|failed/i.test(String(log.status || '')) || /skip|filter|not_due|limit|risk|zero|no_candidate/i.test(String(log.reason || '')))
        .map(log => ({
          time: log.time,
          trigger: log.trigger || '',
          step: log.status || '',
          reason: log.reason || '',
          detail: reportDetailValue(log) || log.journalName || log.doi || ''
        })),
      ...traces
        .filter(trace => /skip|not_due|session_size|zero|outside|limit|risk|no_candidate|filter/i.test(`${trace.step || ''} ${trace.reason || ''}`))
        .map(trace => ({
          time: trace.time,
          trigger: trace.trigger || '',
          step: trace.step || '',
          reason: trace.reason || '',
          detail: reportJson(trace.details || {}).slice(0, 220)
        }))
    ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 30);

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
      `- Current assist strategy: ${state.lastAssistStrategy || ''}`,
      `- Next wake: ${chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : '')}`,
      `- Next assist attempt: ${state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : ''}`,
      `- Next assist strategy: ${state.nextAssistStrategy || ''} / ${state.nextAssistReason || ''}`,
      `- Next assist plan data: planned=${state.nextAssistPlannedAt ? formatBeijingDateTime(state.nextAssistPlannedAt) : ''}, market=${state.nextAssistPlanningData?.marketDataAt ? formatBeijingDateTime(state.nextAssistPlanningData.marketDataAt) : ''}`,
      `- Latest sample affects: ${state.marketDataAffects || ''}`,
      `- Next assist delay model / guard / final: ${Number(state.nextAssistModelDelayMinutes || 0)} / ${Number(state.nextAssistGuardMinutes || 0)} / ${Number(state.nextAssistDelayMinutes || 0)} minutes`,
      `- Next assist guard: ${state.nextAssistGuardMode || 'none'}, lift=${Number(state.nextAssistGuardLiftMinutes || 0)}m, weight=${Number(state.nextAssistGuardWeight || 0)}`,
      `- Runs auto / manual / observe: ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)} / ${Number(daily.manualObserveRuns || 0)}`,
      `- Last run: ${state.lastRunTrigger || ''} ${state.lastRunResult?.reason || ''}`,
      `- Last attempt time: ${lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : ''}`,
      `- Last attempt trigger: ${lastAttempt.trigger || ''}`,
      `- Last attempt result: ${lastAttempt.resultReason || ''}`,
      `- Last attempt observe: ${lastAttempt.observeSnapshot === true ? 'yes' : 'no'} ${lastAttempt.observeReason || ''}`,
      `- Last attempt target session size: ${lastAttempt.targetSessionSize ?? ''}`,
      `- Last attempt checked delta: ${lastAttempt.checkedDelta ?? ''}`,
      `- Last attempt downloaded delta: ${lastAttempt.downloadedDelta ?? ''}`,
      `- Last attempt list scan started: ${lastAttempt.listScanStarted === true ? 'yes' : 'no'}`,
      `- Last attempt picked list URL: ${lastAttempt.pickedListUrl || ''}`,
      `- Last attempt random session: picked=${lastAttempt.randomSessionPicked ?? ''}, final=${lastAttempt.randomSessionFinalSize ?? ''}, random=${lastAttempt.randomValue ?? ''}`,
      `- Demand factor: ${Number(state.demandFactor || 1).toFixed(2)}`,
      `- Trend factor: ${Number(state.trendFactor || 1).toFixed(2)}`,
      `- Work time progress: ${Number(state.workTimeProgressRatio || 0).toFixed(4)}`,
      `- Active progress / availability: ${Number(state.activeTimeProgressRatio || 0).toFixed(4)} / ${Number(state.availabilityFactor || 1).toFixed(3)}`,
      `- Active wake count expected / actual: ${Number(state.availabilityExpectedWakeCount || 0)} / ${Number(state.availabilityActualWakeCount || 0)}`,
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
      '## Skips And Decisions',
      '',
      '| Time | Trigger | Step | Reason | Detail | Date |',
      '| --- | --- | --- | --- | --- | --- |',
      ...skipDecisionRows.map(row => [
        formatBeijingTimeOnly(row.time),
        row.trigger,
        row.step,
        row.reason,
        row.detail,
        formatBeijingDateOnly(row.time)
      ].map(v => String(v).replace(/\|/g, '\\|')).join(' | ')),
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

  function normalizeDocumentType(text) {
    const value = normalizeText(text);
    if (!value) return '';
    if (/补充材料|supporting information|supplement/i.test(value)) return 'supplement';
    if (/书籍（章节）|书籍章节|book chapter|chapter/i.test(value)) return 'book_chapter';
    if (/专利、报告等|专利|patent|report/i.test(value)) return 'patent_report';
    return '';
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
      const typeText = text(row.querySelector('.layui-badge[title="文献类型"], .paper-type, .title-hint[title="Book Chapter"]'));
      const documentType = normalizeDocumentType(typeText || rowText);
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
        supplement: documentType === 'supplement' || /补充材料|Supplement|supporting information|学位论文/i.test(rowText),
        documentType,
        documentTypeText: normalizeText(typeText),
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
    if (candidate.documentType === 'book_chapter') return { ok: false, reason: 'book_chapter' };
    if (candidate.documentType === 'patent_report') return { ok: false, reason: 'patent_report' };
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
      payload.documentTypeLabel || '',
      ...(Array.isArray(payload.riskReasons) ? payload.riskReasons : [])
    ].join(' ');

    if (payload.documentType === 'book_chapter') return { ok: false, reason: 'detail_book_chapter' };
    if (payload.documentType === 'patent_report') return { ok: false, reason: 'detail_patent_report' };
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
    const consecutiveFailCount = Number(item.consecutiveFailCount || 0);
    const successCount = Number(item.successCount || 0);
    const accessState = String(item.accessState || '');
    if (accessState === 'has_access' || accessState === 'partial_access') return false;
    if (successCount > 0) return false;
    return consecutiveFailCount >= HIGH_RISK_FAIL_THRESHOLD;
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
            trigger: context.trigger || '',
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
            trigger: context.trigger || '',
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
      const timeoutMs = Math.max(60 * 1000, (Number(context.opts?.watcherTaskTimeoutMinutes || 10) + 1) * 60 * 1000);
      timer = setTimeout(() => resolve({ ok: false, reason: 'auto_watcher_task_timeout', durationMs: timeoutMs }), timeoutMs);
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
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: `本地记录连续失败达到 ${HIGH_RISK_FAIL_THRESHOLD} 次，暂按无权限跳过` });
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
    const sessionPort = makeSessionPortContext(portContext);
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
      if (!payload.downloadOnly) {
        await closeTabQuietly(detailTabId, result.ok ? 'auto_upload_done' : 'auto_upload_failed');
      }
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
      const pagePick = randomizeAssistListUrlWithMeta(listUrl);
      const pickedListUrl = pagePick.pickedListUrl;
      await appendWatcherTrace('session_plan_url', {
        reason: pickedListUrl === listUrl ? 'configured_url' : 'randomized_page',
        sessionId: session.id,
        listUrl: pickedListUrl,
        configuredUrl: listUrl,
        publisher: pagePick.publisher,
        pageCurve: pagePick.pageCurve,
        pickedPage: pagePick.pickedPage,
        pageMin: pagePick.pageMin,
        pageMax: pagePick.pageMax,
        frontHit: pagePick.frontHit,
        alpha: pagePick.alpha,
        pickedListUrl: pagePick.pickedListUrl
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
    const cooldownMinutes = Number((logNormalMinutes(ADVANCED_COOLDOWN.median, ADVANCED_COOLDOWN.min, ADVANCED_COOLDOWN.max) / Math.max(0.25, Number(finalState.rateMultiplier || 1))).toFixed(2));
    finalState.lastSession = {
      ...finalState.currentSession,
      status: 'done',
      finishedAt: new Date().toISOString(),
      handledCount,
      sessionDurationMs: durationMs,
      cooldownMinutes,
      cooldownUntil: new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString()
    };
    finalState.currentSession = { ...finalState.lastSession };
    await saveWatcherState(finalState);
    await appendWatcherTrace('session_done', {
      reason: handledCount ? 'advanced_session_done' : 'advanced_no_candidate',
      sessionId: session.id,
      handledCount,
      targetSessionSize,
      sessionDurationMs: durationMs,
      cooldownMinutes: finalState.lastSession.cooldownMinutes,
      cooldownUntil: finalState.lastSession.cooldownUntil
    });
    return { ok: true, reason: handledCount ? 'advanced_session_done' : 'advanced_no_candidate', observeSnapshot: observeResult?.snapshot ? true : false };
  }

  async function runAutoWatcherOnce(trigger = 'alarm') {
    if (autoWatcherRunning) {
      await appendWatcherTrace('run_skip_already_running', { reason: 'already_running', trigger });
      return { ok: false, reason: 'already_running' };
    }
    autoWatcherRunning = true;
    let runResult = null;
    let currentRunOpts = null;
    const attempt = {
      startedAt: new Date().toISOString(),
      trigger,
      resultReason: '',
      observeSnapshot: false,
      observeReason: '',
      nextAssistBefore: '',
      nextAssistAfter: '',
      nextAlarmAfter: '',
      checkedBefore: 0,
      checkedAfter: 0,
      downloadedBefore: 0,
      downloadedAfter: 0,
      failedBefore: 0,
      failedAfter: 0,
      skippedBefore: 0,
      skippedAfter: 0,
      targetSessionSize: '',
      sessionCap: '',
      speedMode: '',
      randomSessionPicked: '',
      randomSessionFinalSize: '',
      randomSessionWeights: '',
      randomValue: '',
      listScanStarted: false,
      pickedListUrl: '',
      pickedPage: '',
      pageCurve: '',
      pageMin: '',
      pageMax: '',
      frontHit: false,
      alpha: ''
    };
    function finish(result) {
      runResult = result;
      return result;
    }
    try {
      await appendWatcherTrace('run_start', { reason: 'watcher_triggered', trigger });
      const opts = normalizeOptions(await deps.getOptions());
      currentRunOpts = opts;
      await recordRunStart(trigger, opts);
      const initialState = await getWatcherState();
      attempt.nextAssistBefore = initialState.nextAssistRunAt || '';
      Object.assign(attempt, Object.fromEntries(Object.entries(dailyCounterSnapshot(initialState)).map(([key, value]) => [`${key}Before`, value])));
      if (!opts.watcherEnabled && trigger !== 'manual' && trigger !== 'manual-observe') {
        await appendWatcherTrace('run_skip_disabled', { reason: 'disabled', trigger });
        return finish({ ok: false, reason: 'disabled' });
      }
      if (deps.hasActiveTask()) {
        await appendWatcherTrace('run_skip_active_task', { reason: 'active_task', trigger });
        return finish({ ok: false, reason: 'active_task' });
      }

      if (opts.watcherQuantSchedulerEnabled && trigger === 'alarm' && !isInWorkSchedule(opts)) {
        await appendWatcherTrace('run_skip_outside_work_schedule', {
          reason: 'outside_work_schedule',
          trigger
        });
        return finish({ ok: true, reason: 'outside_work_schedule' });
      }
      const observeResult = await collectDemandIfDue(opts, trigger === 'manual-observe');
      attempt.observeSnapshot = observeResult?.snapshot ? true : false;
      attempt.observeReason = observeResult?.reason || '';
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
      if (trigger === 'alarm' && opts.watcherQuantSchedulerEnabled && !isAssistDue(stateForTargets)) {
        await appendWatcherTrace('run_skip_assist_not_due', {
          reason: observeResult?.snapshot ? 'observed_then_assist_not_due' : 'assist_not_due',
          trigger,
          nextAssistRunAt: stateForTargets.nextAssistRunAt || '',
          nextAssistRunAtBeijing: stateForTargets.nextAssistRunAt ? formatBeijingDateTime(stateForTargets.nextAssistRunAt) : '',
          secondsUntilAssist: stateForTargets.nextAssistRunAt ? Math.round((new Date(stateForTargets.nextAssistRunAt).getTime() - Date.now()) / 1000) : '',
          observeSnapshot: observeResult?.snapshot ? true : false
        });
        return finish({ ok: true, reason: observeResult?.snapshot ? 'observed_assist_not_due' : 'assist_not_due' });
      }
      if (opts.watcherAdvancedSchedulerEnabled && stateForTargets.riskPausedUntil && new Date(stateForTargets.riskPausedUntil).getTime() > Date.now()) {
        await appendWatcherTrace('run_skip_risk_budget_paused', { reason: 'risk_budget_paused', trigger, pausedUntil: stateForTargets.riskPausedUntil });
        return finish({ ok: false, reason: 'risk_budget_paused' });
      }
      if (opts.watcherQuantSchedulerEnabled) await refreshPublisherModelFromSnapshots(stateForTargets);
      const liveTargetState = !opts.watcherQuantSchedulerEnabled
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
      const frozenTargetState = trigger === 'alarm' && stateForTargets.nextAssistPlanningData?.targetState
        ? stateForTargets.nextAssistPlanningData.targetState
        : null;
      const targetState = mergeFrozenTargetState(liveTargetState, frozenTargetState);
      Object.assign(stateForTargets, targetState);
      stateForTargets.lastAssistDecisionModelData = frozenTargetState ? 'frozen_pending_assist_plan' : 'live_market_data';
      stateForTargets.lastAssistStrategy = opts.watcherAdvancedSchedulerEnabled ? 'advanced_target_market_risk' : (opts.watcherQuantSchedulerEnabled ? 'quant_target_market' : 'fixed_interval');
      stateForTargets.lastAssistDecisionAt = new Date().toISOString();
      stateForTargets.lastAssistDecision = {
        trigger,
        strategy: stateForTargets.lastAssistStrategy,
        modelData: stateForTargets.lastAssistDecisionModelData,
        frozenPlanAt: stateForTargets.nextAssistPlanningData?.plannedAt || '',
        frozenMarketDataAt: stateForTargets.nextAssistPlanningData?.marketDataAt || '',
        speedMode: targetState.speedMode,
        todayTarget: targetState.todayTarget || 0,
        hourTarget: targetState.hourTarget || 0,
        rateMultiplier: targetState.rateMultiplier || 1,
        targetError: targetState.targetError ?? targetState.lag ?? 0,
        workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
        activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
        availabilityFactor: targetState.availabilityFactor || 1,
        availabilityActualWakeCount: targetState.availabilityActualWakeCount || 0,
        availabilityExpectedWakeCount: targetState.availabilityExpectedWakeCount || 0,
        marketRegime: targetState.marketRegime || stateForTargets.demandRegime || '',
        recentH1DemandDelta: targetState.recentH1DemandDelta || 0,
        riskUsed: targetState.riskUsed || 0,
        riskLimit: targetState.riskLimit || 0,
        dailyLimit: opts.watcherDailyLimit || 0
      };
      await saveWatcherState(stateForTargets);
      await appendWatcherTrace('run_target_state', {
        reason: opts.watcherAdvancedSchedulerEnabled ? 'advanced_target' : (opts.watcherQuantSchedulerEnabled ? 'quant_target' : 'fixed_interval'),
        trigger,
        modelData: stateForTargets.lastAssistDecisionModelData,
        speedMode: targetState.speedMode,
        todayTarget: targetState.todayTarget,
        hourTarget: targetState.hourTarget || '',
        rateMultiplier: targetState.rateMultiplier || '',
        targetError: targetState.targetError || targetState.lag || '',
        workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
        activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
        availabilityFactor: targetState.availabilityFactor || 1
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
      const sessionCap = sessionExecutionCap(opts, stateForTargets, opts.watcherQuantSchedulerEnabled !== false);
      const riskForSizing = riskSnapshot(stateForTargets, opts);
      let targetSessionSize = opts.watcherAdvancedSchedulerEnabled
        ? advancedSessionSize(opts, stateForTargets)
        : (opts.watcherQuantSchedulerEnabled ? sessionSize(opts, stateForTargets) : 1);
      const zeroForcedToOne = !opts.watcherAllowZeroSession
        && trigger === 'alarm'
        && opts.watcherObserveMode !== 'observe_only'
        && targetSessionSize <= 0
        && sessionCap > 0
        && (Number(targetState.todayTarget || 0) <= 0 || dailyDownloadedFromState(stateForTargets) < Number(targetState.todayTarget || 0))
        && (Number(opts.watcherDailyLimit || 0) <= 0 || dailyDownloadedFromState(stateForTargets) < Number(opts.watcherDailyLimit || 0));
      if (zeroForcedToOne) {
        targetSessionSize = 1;
        stateForTargets.lastSessionSizeDecision = {
          ...(stateForTargets.lastSessionSizeDecision || {}),
          finalSize: 1,
          forcedMinOne: true,
          forceReason: 'alarm_due_no_zero_session'
        };
        await saveWatcherState(stateForTargets);
      }
      const sizeDecision = stateForTargets.lastSessionSizeDecision || {};
      attempt.targetSessionSize = targetSessionSize;
      attempt.sessionCap = sessionCap;
      attempt.speedMode = targetState.speedMode || '';
      attempt.randomSessionPicked = sizeDecision.picked ?? '';
      attempt.randomSessionFinalSize = sizeDecision.finalSize ?? targetSessionSize;
      attempt.randomSessionWeights = Array.isArray(sizeDecision.weights) ? sizeDecision.weights.join('|') : '';
      attempt.randomValue = sizeDecision.random ?? '';
      await appendWatcherTrace('run_session_size', {
        reason: 'session_size_calculated',
        trigger,
        targetSessionSize,
        zeroForcedToOne,
        decision: stateForTargets.lastSessionSizeDecision || {},
        maxPerSession: maxSessionCandidates(opts),
        sessionCap,
        dailyDownloaded: dailyDownloadedFromState(stateForTargets),
        todayTarget: stateForTargets.todayTarget || 0,
        dailyLimit: opts.watcherDailyLimit || 0,
        riskRemaining: riskForSizing.remaining,
        advanced: opts.watcherAdvancedSchedulerEnabled
      });
      if (targetSessionSize <= 0) return finish({ ok: true, reason: 'session_size_zero', observeSnapshot: observeResult?.snapshot ? true : false });
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
        const pagePick = randomizeAssistListUrlWithMeta(listUrl);
        const pickedListUrl = pagePick.pickedListUrl;
        attempt.listScanStarted = true;
        attempt.pickedListUrl = pickedListUrl;
        attempt.pickedPage = pagePick.pickedPage;
        attempt.pageCurve = pagePick.pageCurve;
        attempt.pageMin = pagePick.pageMin;
        attempt.pageMax = pagePick.pageMax;
        attempt.frontHit = pagePick.frontHit;
        attempt.alpha = pagePick.alpha;
        await appendWatcherTrace('list_scan_start', {
          reason: pickedListUrl === listUrl ? 'configured_url' : 'randomized_page',
          trigger,
          listUrl: pickedListUrl,
          configuredUrl: listUrl,
          publisher: pagePick.publisher,
          pageCurve: pagePick.pageCurve,
          pickedPage: pagePick.pickedPage,
          pageMin: pagePick.pageMin,
          pageMax: pagePick.pageMax,
          frontHit: pagePick.frontHit,
          alpha: pagePick.alpha,
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
      if (currentRunOpts) await scheduleNextAssistAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, trigger).catch(() => {});
      if (currentRunOpts) await refreshAlarmAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, attempt, trigger).catch(() => {});
      await recordAttemptFinish(attempt, runResult || { ok: false, reason: 'unknown' }).catch(() => {});
      try { await writeDailyReports(); } catch (_) {}
      autoWatcherRunning = false;
    }
  }

  function initPrivateAutoWatcher(nextDeps) {
    deps = nextDeps;
    updateActionBadge().catch(() => {});
    if (badgeRefreshTimer) clearInterval(badgeRefreshTimer);
    badgeRefreshTimer = setInterval(() => {
      updateActionBadge().catch(() => {});
    }, BADGE_REFRESH_INTERVAL_MS);

    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM_NAME) runAutoWatcherOnce('alarm');
      if (alarm.name === BADGE_REFRESH_ALARM_NAME) updateActionBadge().catch(() => {});
    });
    chrome.alarms.create(BADGE_REFRESH_ALARM_NAME, { periodInMinutes: 1 });

    chrome.runtime.onStartup.addListener(() => {
      refreshAutoWatcherAlarm(true, 'runtime_startup').catch(() => {});
    });

    chrome.runtime.onInstalled.addListener(() => {
      refreshAutoWatcherAlarm(true, 'runtime_installed').catch(() => {});
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      const watcherKeys = Object.keys(changes).filter(key => key.startsWith('watcher'));
      if (watcherKeys.length) {
        const changedKeys = watcherKeys.slice(0, 12).join(',');
        updateActionBadge().catch(() => {});
        if (watcherKeys.some(key => key !== 'watcherBadgeCountdownEnabled')) {
          refreshAutoWatcherAlarm(true, `storage_changed:${changedKeys}`).catch(() => {});
        }
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
