'use strict';

(function () {
  const WATCHER_DAILY_LIMIT_MAX = 1000;

  const DEFAULT_OPTIONS = {
    nativeHostName: 'com.ablesci.pdf_watcher',
    downloadMode: 'auto',
    scienceDirectTabMode: 'silent_then_visible',
    deleteAfterUpload: false,
    keepDownloadHistory: false,
    diagnosticsEnabled: false,
    browserDownloadConfigured: false,
    minAutoUploadMB: 1,
    minAutoUploadUnit: 'MB',
    maxAutoUploadMB: 150,
    maxAutoUploadUnit: 'MB',
    debugDownloadOnly: false,
    autoRemoveHtmlDownloads: true,
    hideScienceDirectNoAccessRows: false,
    buttonLabel: '上传PDF',
    buttonColor: '#FF5722',
    buttonTextColor: '#ffffff',
    buttonPosition: 'start',
    watcherEnabled: false,
    // LOCKED: scheduler identity is force-set in normalizeOptions; kept here only
    // so storage has a value. The name 'quant' is historical. The interval itself
    // is now a uniform random sample around a speed-tier median (watcher/
    // schedule.js sampleAssistDelayMinutes), not the old lognormal model — but the
    // *tier* can still be chosen adaptively from monthly-target lag (see
    // watcherSpeedMode + watcher/target.js determineSpeedMode).
    watcherSchedulerMode: 'quant',
    watcherIntervalMinutes: 10,
    watcherMinIntervalMinutes: 1,
    watcherMaxIntervalMinutes: 30,
    // Speed mode: 'adaptive' (default) lets watcher/target.js pick fast/normal
    // from monthly-target lag + daily progress; fast/normal/slow pin a fixed tier.
    // The chosen tier sets the random interval median. NOTE: the options UI only
    // exposes fast/normal/slow, so the 'adaptive' default has no matching control —
    // collapsing this to an explicit tier is a scheduler-behaviour change deferred
    // to a browser-tested branch, not a no-op rename.
    watcherSpeedMode: 'adaptive',
    watcherMaxCandidatesPerRun: 1,
    watcherMinNonSdSeekingCount: 200,
    watcherListUrls: [
      'https://www.ablesci.com/assist/index?status=waiting&publisher=elsevier&page=3'
    ],
    watcherRequireDoi: true,
    watcherSkipReported: true,
    watcherSkipRejected: true,
    watcherSkipSupplement: true,
    watcherSkipRemark: true,
    watcherSkipBookChapter: true,
    watcherSkipPatentReport: true,
    watcherSkipRiskText: true,
    watcherOpenDetail: true,
    watcherAutoDownload: true,
    watcherAutoUpload: true,
    watcherUploadConfirmRequired: false,
    watcherUploadCountdownSeconds: 10,
    watcherDailyLimit: 100,
    watcherStopOnCfChallenge: true,
    watcherCfNotificationEnabled: false,
    watcherDailyReportEnabled: false,
    watcherBadgeCountdownEnabled: true,
    watcherNotificationEnabled: false,
    // PRIVATE_WATCHER_ONLY: default trace level to off
    watcherTraceLevel: 'off',
    watcherPerfTraceEnabled: false,
    watcherPerfFileEnabled: false,
    watcherReportDir: '',
    watcherNoDownloadTimeoutMinutes: 1.5,
    watcherDownloadTimeoutMinutes: 6,
    watcherTaskTimeoutMinutes: 9,
    watcherNotifyMode: 'browser',
    watcherCfPauseThreshold: 6,
    watcherQuantSchedulerEnabled: true,
    watcherRiskBudgetLimit: 10,
    watcherWorkdays: '1,2,3,4,5',
    watcherWorkWindows: '09:00-12:00\n13:30-18:00',
    watcherMonthlyTarget: 2000,
    watcherMinDailyTarget: 0,
    watcherMaxDailyTarget: WATCHER_DAILY_LIMIT_MAX,
    watcherMaxPerSession: 1,
    watcherAllowZeroSession: false,
    watcherUseCalendarProgress: true,
    watcherLanguage: 'auto',
    pdfCleanerEnabled: false,
    pdfCleanerCliPath: '',
    pdfCleanerPatternsPath: '',
    pdfCleanerEngine: 'auto',
    pdfCleanerTimeoutSeconds: 60,
    pdfCleanerOnError: 'upload_original',
    pdfCleanerPreserveOriginal: false,
    watcherSkipCorrigendum: true,
    watcherEnableBlacklist: true,
    watcherBlacklistPath: ''
  };

  function sanitizePathPart(s) {
    return String(s || '')
      .replace(/^[\\/]+/, '')
      .replace(/\.\.+/g, '_')
      .replace(/[<>:"|?*]+/g, '_')
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeSizeUnit(value) {
    return String(value || '').toUpperCase() === 'KB' ? 'KB' : 'MB';
  }

  function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // FORCE scheduler mode to 'quant' and enable quant scheduler.
  function normalizeSchedulerMode(opts) {
    return 'quant';
  }

  function normalizeWatcherIntervals(opts) {
    return {
      watcherIntervalMinutes: 10,
      watcherMinIntervalMinutes: 1,
      watcherMaxIntervalMinutes: 30
    };
  }

  function normalizeWatcherListUrls(value) {
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
    return urls.length ? urls : DEFAULT_OPTIONS.watcherListUrls.slice();
  }

  function parseJournalAccessRules(raw) {
    return { blocked: [], allowed: [], partial: [], unknown: [] };
  }

  function normalizeOptions(raw = {}, uiNormalizers = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...(raw || {}) };
    const schedulerMode = 'quant';
    const intervals = normalizeWatcherIntervals(opts);
    const normalizeButtonLabel = typeof uiNormalizers.normalizeButtonLabel === 'function'
      ? uiNormalizers.normalizeButtonLabel
      : value => String(value || '').trim().slice(0, 20) || DEFAULT_OPTIONS.buttonLabel;
    const normalizeHexColor = typeof uiNormalizers.normalizeHexColor === 'function'
      ? uiNormalizers.normalizeHexColor
      : (value, fallback) => (/^#[0-9a-fA-F]{6}$/.test(String(value || '').trim()) ? String(value || '').trim() : fallback);
    const normalizeButtonPosition = typeof uiNormalizers.normalizeButtonPosition === 'function'
      ? uiNormalizers.normalizeButtonPosition
      : value => (value === 'start' ? 'start' : 'end');

    const speedMode = ['adaptive', 'slow', 'normal', 'fast'].includes(raw.watcherSpeedMode) ? raw.watcherSpeedMode : 'adaptive';
    // LOCKED defaults: the fields force-assigned below are intentionally not
    // user-configurable. The product is "one random assist per run inside work
    // hours", so download/upload flow, the single-candidate/single-session caps,
    // the skip rules, fixed timeouts and the (vestigially named) quant scheduler
    // flag are pinned to safe values regardless of stored input. They are kept in
    // DEFAULT_OPTIONS for storage shape only and are deliberately absent from the
    // options UI. Do not re-expose them without re-checking watcher/schedule.js.
    return {
      ...opts,
      nativeHostName: opts.nativeHostName === 'com.ablesci.pdf_uploader' ? DEFAULT_OPTIONS.nativeHostName : String(opts.nativeHostName || DEFAULT_OPTIONS.nativeHostName).trim(),
      downloadMode: 'auto',
      scienceDirectTabMode: ['visible', 'silent_then_visible', 'silent'].includes(opts.scienceDirectTabMode) ? opts.scienceDirectTabMode : DEFAULT_OPTIONS.scienceDirectTabMode,
      minAutoUploadMB: isNaN(Number(opts.minAutoUploadMB)) || Number(opts.minAutoUploadMB) < 0
        ? DEFAULT_OPTIONS.minAutoUploadMB
        : Number(opts.minAutoUploadMB),
      minAutoUploadUnit: normalizeSizeUnit(opts.minAutoUploadUnit),
      maxAutoUploadMB: 150,
      maxAutoUploadUnit: 'MB',
      diagnosticsEnabled: opts.diagnosticsEnabled === true,
      buttonLabel: normalizeButtonLabel(opts.buttonLabel),
      buttonColor: normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor),
      buttonTextColor: normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor),
      buttonPosition: 'start',
      hideScienceDirectNoAccessRows: opts.hideScienceDirectNoAccessRows === true,
      watcherSchedulerMode: schedulerMode,
      watcherSpeedMode: speedMode,
      ...intervals,
      watcherMaxCandidatesPerRun: 1,
      watcherMinNonSdSeekingCount: clampNumber(opts.watcherMinNonSdSeekingCount, DEFAULT_OPTIONS.watcherMinNonSdSeekingCount, 0, 100000),
      watcherListUrls: normalizeWatcherListUrls(opts.watcherListUrls),
      watcherOpenDetail: true,
      watcherAutoDownload: true,
      watcherAutoUpload: true,
      watcherUploadConfirmRequired: false,
      watcherUploadCountdownSeconds: clampNumber(opts.watcherUploadCountdownSeconds, DEFAULT_OPTIONS.watcherUploadCountdownSeconds, 0, 120),
      watcherDailyLimit: clampNumber(opts.watcherDailyLimit, DEFAULT_OPTIONS.watcherDailyLimit, 0, WATCHER_DAILY_LIMIT_MAX),
      watcherCfNotificationEnabled: opts.watcherCfNotificationEnabled !== false,
      watcherRequireDoi: true,
      watcherSkipReported: true,
      watcherSkipRejected: true,
      watcherSkipSupplement: true,
      watcherSkipRemark: true,
      watcherSkipBookChapter: true,
      watcherSkipPatentReport: true,
      watcherSkipRiskText: true,
      watcherDailyReportEnabled: opts.watcherDailyReportEnabled === true,
      watcherBadgeCountdownEnabled: opts.watcherBadgeCountdownEnabled !== false,
      watcherNotificationEnabled: opts.watcherNotificationEnabled !== false,
      // PRIVATE_WATCHER_ONLY: Add compact trace level
      watcherTraceLevel: ['off', 'compact', 'normal', 'verbose'].includes(opts.watcherTraceLevel) ? opts.watcherTraceLevel : DEFAULT_OPTIONS.watcherTraceLevel,
      watcherPerfTraceEnabled: opts.watcherPerfTraceEnabled === true,
      watcherPerfFileEnabled: opts.watcherPerfFileEnabled === true,
      watcherReportDir: String(opts.watcherReportDir || '').trim(),
      watcherNoDownloadTimeoutMinutes: 1.5,
      watcherDownloadTimeoutMinutes: 6,
      watcherTaskTimeoutMinutes: 9,
      watcherNotifyMode: opts.watcherNotifyMode === 'native' ? 'native' : 'browser',
      watcherCfPauseThreshold: clampNumber(opts.watcherCfPauseThreshold, DEFAULT_OPTIONS.watcherCfPauseThreshold, 1, 10),
      watcherQuantSchedulerEnabled: true,
      watcherRiskBudgetLimit: clampNumber(opts.watcherRiskBudgetLimit, DEFAULT_OPTIONS.watcherRiskBudgetLimit, 1, 100),
      watcherWorkdays: String(opts.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays).trim(),
      watcherWorkWindows: String(opts.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows).trim(),
      watcherMonthlyTarget: clampNumber(opts.watcherMonthlyTarget, DEFAULT_OPTIONS.watcherMonthlyTarget, 0, 5000),
      watcherMinDailyTarget: 0,
      watcherMaxDailyTarget: WATCHER_DAILY_LIMIT_MAX,
      watcherMaxPerSession: 1,
      watcherAllowZeroSession: opts.watcherAllowZeroSession === true,
      watcherUseCalendarProgress: opts.watcherUseCalendarProgress !== false,
      watcherLanguage: ['auto', 'zh', 'en'].includes(opts.watcherLanguage) ? opts.watcherLanguage : 'auto',
      pdfCleanerEnabled: opts.pdfCleanerEnabled === true,
      pdfCleanerCliPath: String(opts.pdfCleanerCliPath || '').trim(),
      pdfCleanerPatternsPath: String(opts.pdfCleanerPatternsPath || '').trim(),
      pdfCleanerEngine: ['auto', 'pdfcpu', 'qpdf'].includes(opts.pdfCleanerEngine) ? opts.pdfCleanerEngine : 'auto',
      pdfCleanerTimeoutSeconds: clampNumber(opts.pdfCleanerTimeoutSeconds, 60, 5, 300),
      pdfCleanerOnError: ['upload_original', 'stop_upload'].includes(opts.pdfCleanerOnError) ? opts.pdfCleanerOnError : 'upload_original',
      pdfCleanerPreserveOriginal: false,
      watcherSkipCorrigendum: true,
      watcherEnableBlacklist: true,
      watcherBlacklistPath: String(opts.watcherBlacklistPath !== undefined ? opts.watcherBlacklistPath : DEFAULT_OPTIONS.watcherBlacklistPath).trim()
    };
  }

  const CONFIG_SCHEMA = {
    minAutoUploadMB: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
      message: '最小体积必须大于或等于 0。'
    },
    maxAutoUploadMB: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
      message: '最大体积必须大于或等于 0。'
    },
    watcherDailyLimit: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
      message: '每日应助上限不能小于 0。'
    },
    watcherMinNonSdSeekingCount: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) >= 0,
      message: '非 SD 最低求助量不能小于 0。'
    },
    watcherNoDownloadTimeoutMinutes: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
      message: '任务超时时间必须大于 0。'
    },
    watcherDownloadTimeoutMinutes: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
      message: '任务超时时间必须大于 0。'
    },
    watcherTaskTimeoutMinutes: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) > 0,
      message: '任务超时时间必须大于 0。'
    },
    pdfCleanerTimeoutSeconds: {
      validate: (v) => Number.isFinite(Number(v)) && Number(v) >= 5 && Number(v) <= 300,
      message: '去水印超时时间必须在 5 到 300 秒之间。'
    }
  };

  function validateOptions(opts) {
    for (const [key, rule] of Object.entries(CONFIG_SCHEMA)) {
      if (opts[key] !== undefined && !rule.validate(opts[key])) {
        throw new Error(rule.message);
      }
    }

    const minValue = Number(opts.minAutoUploadMB);
    const maxValue = Number(opts.maxAutoUploadMB);
    const unitFactor = unit => normalizeSizeUnit(unit) === 'KB' ? 1024 : 1024 * 1024;
    const minBytes = Math.round(minValue * unitFactor(opts.minAutoUploadUnit));
    const maxBytes = Math.round(maxValue * unitFactor(opts.maxAutoUploadUnit));
    if (maxBytes > 0 && minBytes > maxBytes) {
      throw new Error('最小体积不能大于最大体积。');
    }

    if (opts.watcherTaskTimeoutMinutes < opts.watcherNoDownloadTimeoutMinutes ||
        opts.watcherTaskTimeoutMinutes < opts.watcherDownloadTimeoutMinutes) {
      throw new Error('任务最长时间不能小于未触发下载或下载中超时时间。');
    }

    const rawUrls = Array.isArray(opts.watcherListUrls) ? opts.watcherListUrls : String(opts.watcherListUrls || '').split(/\r?\n/);
    const validUrls = rawUrls.map(s => String(s || '').trim()).filter(Boolean);
    if (!validUrls.length) {
      throw new Error('低频值守列表 URL 不能为空。');
    }
  }

  globalThis.AblesciWatcherConfig = {
    DEFAULT_OPTIONS,
    WATCHER_DAILY_LIMIT_MAX,
    sanitizePathPart,
    normalizeSizeUnit,
    clampNumber,
    normalizeSchedulerMode,
    normalizeWatcherIntervals,
    normalizeWatcherListUrls,
    parseJournalAccessRules,
    normalizeOptions,
    validateOptions
  };
})();
