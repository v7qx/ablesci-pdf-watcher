'use strict';

(function () {
  function createOptionsHelpersApi(deps = {}) {
    const {
      defaultOptions,
      normalizeWorkdaysSet,
      normalizeWorkWindowsDetailed
    } = deps;

    function normalizeButtonLabel(value) {
      const s = String(value || '').trim();
      return s.slice(0, 20) || defaultOptions.buttonLabel;
    }

    function normalizeHexColor(value, fallback) {
      const s = String(value || '').trim();
      return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
    }

    function normalizeButtonPosition(value) {
      return value === 'start' ? 'start' : 'end';
    }

    function formatBeijingDateTime(value) {
      const date = value ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return '-';
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
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
      return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    }

    function countdownText(value) {
      const date = value ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return '-';
      const seconds = Math.max(0, Math.round((date.getTime() - Date.now()) / 1000));
      if (seconds <= 0) return '到点';
      const minutes = Math.floor(seconds / 60);
      const sec = seconds % 60;
      if (minutes < 60) return `${minutes}分${String(sec).padStart(2, '0')}秒`;
      const hours = Math.floor(minutes / 60);
      return `${hours}时${String(minutes % 60).padStart(2, '0')}分`;
    }

    function normalizeWorkdays(value) {
      return normalizeWorkdaysSet(value, defaultOptions.watcherWorkdays);
    }

    function normalizeWorkWindows(value) {
      return normalizeWorkWindowsDetailed(value, defaultOptions.watcherWorkWindows);
    }

    function nextDisplaySchedule(state = {}) {
      const assistAt = state.nextAssistRunAt || state.chromeAlarmScheduledAt || state.nextScheduledAt || '';
      return {
        nextRunAt: assistAt,
        nextAssistAt: assistAt,
        assistCountdownAt: assistAt
      };
    }

    function todayKeyBeijing() {
      const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date()).reduce((acc, item) => {
        acc[item.type] = item.value;
        return acc;
      }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    }

    function journalAccessSummary(raw) {
      const rules = deps.parseJournalAccessRules ? deps.parseJournalAccessRules(raw) : { blocked: [], partial: [], allowed: [], unknown: [] };
      return `blocked ${rules.blocked.length} / partial ${rules.partial.length} / allowed ${rules.allowed.length} / unknown ${rules.unknown.length}`;
    }

    function sanitizeUrlForExport(value) {
      try {
        const url = new URL(value);
        for (const key of Array.from(url.searchParams.keys())) {
          if (/token|cookie|csrf|signature|credential|key|secret|auth/i.test(key)) {
            url.searchParams.set(key, '<redacted>');
          }
        }
        return url.href;
      } catch (_) {
        return String(value || '').replace(/(token|cookie|csrf|signature|credential|key|secret|auth)=([^&\s]+)/ig, '$1=<redacted>');
      }
    }

    function watcherOptionSnapshot(opts) {
      const snapshot = {};
      const hiddenKeys = new Set([
        'watcherDemandObserveUrl',
        'watcherObserveTimes',
        'watcherObserveIntervalMinutes',
        'watcherObserveFallbackMinutes',
        'watcherObserveOnly',
        'watcherObserveMode',
        'watcherAdvancedSchedulerEnabled'
      ]);
      for (const key of Object.keys(defaultOptions)) {
        if (!key.startsWith('watcher')) continue;
        if (hiddenKeys.has(key)) continue;
        snapshot[key] = key === 'watcherListUrls'
          ? deps.normalizeWatcherListUrls(opts[key]).map(sanitizeUrlForExport)
          : opts[key];
      }
      return snapshot;
    }

    return {
      normalizeButtonLabel,
      normalizeHexColor,
      normalizeButtonPosition,
      formatBeijingDateTime,
      countdownText,
      normalizeWorkdays,
      normalizeWorkWindows,
      nextDisplaySchedule,
      todayKeyBeijing,
      journalAccessSummary,
      sanitizeUrlForExport,
      watcherOptionSnapshot
    };
  }

  globalThis.AblesciOptionsHelpers = {
    createOptionsHelpersApi
  };
})();
