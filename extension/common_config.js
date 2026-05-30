'use strict';

(function () {
  const WATCHER_DAILY_LIMIT_MAX = 500;

  const DEFAULT_OPTIONS = {
    nativeHostName: 'com.ablesci.pdf_watcher',
    downloadSubdir: '',
    downloadMode: 'auto',
    scienceDirectTabMode: 'silent_then_visible',
    moveToDir: '',
    deleteAfterUpload: true,
    keepDownloadHistory: false,
    browserDownloadConfigured: false,
    minAutoUploadMB: 1,
    minAutoUploadUnit: 'MB',
    maxAutoUploadMB: 99,
    maxAutoUploadUnit: 'MB',
    debugDownloadOnly: false,
    autoRemoveHtmlDownloads: true,
    smartRecommendPush: true,
    openAssistLinksInCurrentTab: false,
    buttonLabel: '上传PDF',
    buttonColor: '#FF5722',
    buttonTextColor: '#ffffff',
    buttonPosition: 'start',
    watcherEnabled: false,
    watcherSchedulerMode: 'quant',
    watcherIntervalMinutes: 10,
    watcherMinIntervalMinutes: 1,
    watcherMaxIntervalMinutes: 30,
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
    watcherJournalAccessRules: '{\n  "blocked": [],\n  "allowed": [],\n  "partial": []\n}',
    watcherOpenDetail: true,
    watcherAutoDownload: true,
    watcherAutoUpload: true,
    watcherUploadConfirmRequired: false,
    watcherUploadCountdownSeconds: 10,
    watcherDailyLimit: 100,
    watcherStopOnCfChallenge: true,
    watcherCfNotificationEnabled: false,
    watcherSkipHighRiskJournal: true,
    watcherDailyReportEnabled: true,
    watcherBadgeCountdownEnabled: true,
    watcherNotificationEnabled: false,
    // PRIVATE_WATCHER_ONLY: default trace level to off
    watcherTraceLevel: 'off',
    watcherReportDir: '',
    watcherConfigDir: '',
    watcherNoDownloadTimeoutMinutes: 1,
    watcherDownloadTimeoutMinutes: 5,
    watcherTaskTimeoutMinutes: 10,
    watcherNotifyMode: 'browser',
    watcherTelegramNotifyEnabled: false,
    watcherTelegramConfigPath: '',
    watcherJournalAccessConfigPath: '',
    watcherCfPauseThreshold: 6,
    watcherQuantSchedulerEnabled: true,
    watcherAdvancedSchedulerEnabled: false,
    watcherRiskBudgetLimit: 10,
    watcherObserveOnly: false,
    watcherObserveMode: 'assist',
    watcherDemandObserveUrl: 'https://www.ablesci.com/assist/index?status=waiting',
    watcherObserveTimes: '',
    watcherObserveIntervalMinutes: 5,
    watcherObserveFallbackMinutes: 180,
    watcherWorkdays: '1,2,3,4,5',
    watcherWorkWindows: '09:00-12:00\n13:30-18:00',
    watcherMonthlyTarget: 2000,
    watcherMinDailyTarget: 0,
    watcherMaxDailyTarget: WATCHER_DAILY_LIMIT_MAX,
    watcherMaxPerSession: 1,
    watcherAllowZeroSession: false,
    watcherUseCalendarProgress: true
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

  function normalizeSchedulerMode(opts) {
    const raw = String(opts?.watcherSchedulerMode || '').trim().toLowerCase();
    if (raw === 'fixed' || raw === 'quant') return raw;
    if (raw === 'advanced' || opts?.watcherAdvancedSchedulerEnabled === true) return 'quant';
    if (opts?.watcherQuantSchedulerEnabled === false) return 'fixed';
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
    try {
      const parsed = JSON.parse(String(raw || '{}'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { blocked: [], allowed: [], partial: [], unknown: [] };
      }
      return {
        blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
        allowed: Array.isArray(parsed.allowed) ? parsed.allowed : [],
        partial: Array.isArray(parsed.partial) ? parsed.partial : [],
        unknown: Array.isArray(parsed.unknown) ? parsed.unknown : []
      };
    } catch (_) {
      return { blocked: [], allowed: [], partial: [], unknown: [] };
    }
  }

  function normalizeOptions(raw = {}, uiNormalizers = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...(raw || {}) };
    const schedulerMode = normalizeSchedulerMode(opts);
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

    return {
      ...opts,
      nativeHostName: opts.nativeHostName === 'com.ablesci.pdf_uploader' ? DEFAULT_OPTIONS.nativeHostName : String(opts.nativeHostName || DEFAULT_OPTIONS.nativeHostName).trim(),
      downloadSubdir: sanitizePathPart(opts.downloadSubdir || ''),
      moveToDir: String(opts.moveToDir || '').trim(),
      downloadMode: 'auto',
      scienceDirectTabMode: 'silent_then_visible',
      minAutoUploadUnit: normalizeSizeUnit(opts.minAutoUploadUnit),
      maxAutoUploadUnit: normalizeSizeUnit(opts.maxAutoUploadUnit),
      buttonLabel: normalizeButtonLabel(opts.buttonLabel),
      buttonColor: normalizeHexColor(opts.buttonColor, DEFAULT_OPTIONS.buttonColor),
      buttonTextColor: normalizeHexColor(opts.buttonTextColor, DEFAULT_OPTIONS.buttonTextColor),
      buttonPosition: normalizeButtonPosition(opts.buttonPosition),
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
      watcherSkipReported: opts.watcherSkipReported !== false,
      watcherSkipRejected: opts.watcherSkipRejected !== false,
      watcherSkipSupplement: opts.watcherSkipSupplement !== false,
      watcherSkipRemark: opts.watcherSkipRemark !== false,
      watcherSkipBookChapter: opts.watcherSkipBookChapter !== false,
      watcherSkipPatentReport: opts.watcherSkipPatentReport !== false,
      watcherSkipRiskText: opts.watcherSkipRiskText !== false,
      watcherJournalAccessRules: String(opts.watcherJournalAccessRules || DEFAULT_OPTIONS.watcherJournalAccessRules).trim(),
      watcherSkipHighRiskJournal: opts.watcherSkipHighRiskJournal !== false,
      watcherDailyReportEnabled: opts.watcherDailyReportEnabled !== false,
      watcherBadgeCountdownEnabled: opts.watcherBadgeCountdownEnabled !== false,
      watcherNotificationEnabled: opts.watcherNotificationEnabled !== false,
      // PRIVATE_WATCHER_ONLY: Add compact trace level
      watcherTraceLevel: ['off', 'compact', 'normal', 'verbose'].includes(opts.watcherTraceLevel) ? opts.watcherTraceLevel : DEFAULT_OPTIONS.watcherTraceLevel,
      watcherReportDir: String(opts.watcherReportDir || '').trim(),
      watcherConfigDir: String(opts.watcherConfigDir || '').trim(),
      watcherNoDownloadTimeoutMinutes: clampNumber(opts.watcherNoDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherNoDownloadTimeoutMinutes, 0.25, 60),
      watcherDownloadTimeoutMinutes: clampNumber(opts.watcherDownloadTimeoutMinutes, DEFAULT_OPTIONS.watcherDownloadTimeoutMinutes, 1, 120),
      watcherTaskTimeoutMinutes: clampNumber(opts.watcherTaskTimeoutMinutes, DEFAULT_OPTIONS.watcherTaskTimeoutMinutes, 1, 180),
      watcherNotifyMode: opts.watcherNotifyMode === 'native' ? 'native' : 'browser',
      watcherTelegramNotifyEnabled: opts.watcherTelegramNotifyEnabled === true,
      watcherTelegramConfigPath: String(opts.watcherTelegramConfigPath || '').trim(),
      watcherJournalAccessConfigPath: String(opts.watcherJournalAccessConfigPath || '').trim(),
      watcherCfPauseThreshold: clampNumber(opts.watcherCfPauseThreshold, DEFAULT_OPTIONS.watcherCfPauseThreshold, 1, 10),
      watcherQuantSchedulerEnabled: schedulerMode !== 'fixed',
      watcherAdvancedSchedulerEnabled: false,
      watcherRiskBudgetLimit: clampNumber(opts.watcherRiskBudgetLimit, DEFAULT_OPTIONS.watcherRiskBudgetLimit, 1, 100),
      watcherObserveMode: 'assist',
      watcherObserveOnly: false,
      watcherDemandObserveUrl: DEFAULT_OPTIONS.watcherDemandObserveUrl,
      watcherObserveTimes: DEFAULT_OPTIONS.watcherObserveTimes,
      watcherObserveIntervalMinutes: DEFAULT_OPTIONS.watcherObserveIntervalMinutes,
      watcherObserveFallbackMinutes: DEFAULT_OPTIONS.watcherObserveFallbackMinutes,
      watcherWorkdays: String(opts.watcherWorkdays || DEFAULT_OPTIONS.watcherWorkdays).trim(),
      watcherWorkWindows: String(opts.watcherWorkWindows || DEFAULT_OPTIONS.watcherWorkWindows).trim(),
      watcherMonthlyTarget: clampNumber(opts.watcherMonthlyTarget, DEFAULT_OPTIONS.watcherMonthlyTarget, 0, 5000),
      watcherMinDailyTarget: 0,
      watcherMaxDailyTarget: WATCHER_DAILY_LIMIT_MAX,
      watcherMaxPerSession: 1,
      watcherAllowZeroSession: opts.watcherAllowZeroSession === true,
      watcherUseCalendarProgress: opts.watcherUseCalendarProgress !== false
    };
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
    normalizeOptions
  };
})();
