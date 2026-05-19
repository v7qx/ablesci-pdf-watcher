'use strict';

(function () {
  const DEFAULT_OPTIONS = {
    nativeHostName: 'com.ablesci.pdf_watcher_private',
    downloadSubdir: '',
    downloadMode: 'auto',
    scienceDirectTabMode: 'silent_then_visible',
    moveToDir: '',
    deleteAfterUpload: false,
    keepDownloadHistory: true,
    browserDownloadConfigured: false,
    minAutoUploadMB: 1,
    minAutoUploadUnit: 'MB',
    maxAutoUploadMB: 99,
    maxAutoUploadUnit: 'MB',
    debugDownloadOnly: false,
    autoRemoveHtmlDownloads: false,
    smartRecommendPush: true,
    openAssistLinksInCurrentTab: false,
    buttonLabel: '上传PDF',
    buttonColor: '#FF5722',
    buttonTextColor: '#ffffff',
    buttonPosition: 'end',
    watcherEnabled: false,
    watcherSchedulerMode: 'quant',
    watcherIntervalMinutes: 30,
    watcherMinIntervalMinutes: 10,
    watcherMaxIntervalMinutes: 60,
    watcherMaxCandidatesPerRun: 1,
    watcherListUrls: [
      'https://www.ablesci.com/assist/index?status=waiting&publisher=elsevier&page=3',
      'https://www.ablesci.com/assist/index?status=waiting&publisher=rsc'
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
    watcherAutoUpload: false,
    watcherUploadConfirmRequired: true,
    watcherUploadCountdownSeconds: 10,
    watcherDailyLimit: 10,
    watcherStopOnCfChallenge: true,
    watcherSkipHighRiskJournal: true,
    watcherDailyReportEnabled: true,
    watcherBadgeCountdownEnabled: true,
    watcherTraceLevel: 'normal',
    watcherReportDir: '',
    watcherConfigDir: '',
    watcherNoDownloadTimeoutMinutes: 1,
    watcherDownloadTimeoutMinutes: 5,
    watcherTaskTimeoutMinutes: 10,
    watcherNotifyMode: 'native',
    watcherTelegramNotifyEnabled: false,
    watcherTelegramConfigPath: '',
    watcherJournalAccessConfigPath: '',
    watcherCfPauseThreshold: 3,
    watcherQuantSchedulerEnabled: true,
    watcherAdvancedSchedulerEnabled: false,
    watcherRiskBudgetLimit: 10,
    watcherObserveOnly: false,
    watcherObserveMode: 'assist',
    watcherDemandObserveUrl: 'https://www.ablesci.com/assist/index?status=waiting',
    watcherObserveTimes: '09:30\n11:30\n14:00\n16:30\n18:00',
    watcherObserveIntervalMinutes: 5,
    watcherObserveFallbackMinutes: 180,
    watcherWorkdays: '1,2,3,4,5',
    watcherWorkWindows: '09:00-12:00\n13:30-18:00',
    watcherMonthlyTarget: 2000,
    watcherMinDailyTarget: 5,
    watcherMaxDailyTarget: 40,
    watcherMaxPerSession: 1,
    watcherAllowZeroSession: false
  };

  const WATCHER_DAILY_LIMIT_MAX = 500;

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
    if (raw === 'fixed' || raw === 'quant' || raw === 'advanced') return raw;
    if (opts?.watcherAdvancedSchedulerEnabled === true) return 'advanced';
    if (opts?.watcherQuantSchedulerEnabled === false) return 'fixed';
    return 'quant';
  }

  function normalizeWatcherIntervals(opts) {
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 1440);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    return {
      watcherIntervalMinutes: clampNumber(opts.watcherIntervalMinutes, 30, min, max),
      watcherMinIntervalMinutes: min,
      watcherMaxIntervalMinutes: max
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
    const next = urls.length ? urls : DEFAULT_OPTIONS.watcherListUrls.slice();
    const hasRsc = next.some(url => {
      try {
        const u = new URL(url);
        return /rsc/i.test(u.searchParams.get('publisher') || '');
      } catch (_) {
        return false;
      }
    });
    const hasLegacyElsevier = next.some(url => {
      try {
        const u = new URL(url);
        return /elsevier/i.test(u.searchParams.get('publisher') || '') && u.searchParams.get('status') === 'waiting';
      } catch (_) {
        return false;
      }
    });
    if (!hasRsc && hasLegacyElsevier) {
      next.push('https://www.ablesci.com/assist/index?status=waiting&publisher=rsc');
    }
    return next;
  }

  globalThis.AblesciWatcherConfig = {
    DEFAULT_OPTIONS,
    WATCHER_DAILY_LIMIT_MAX,
    sanitizePathPart,
    normalizeSizeUnit,
    clampNumber,
    normalizeSchedulerMode,
    normalizeWatcherIntervals,
    normalizeWatcherListUrls
  };
})();
