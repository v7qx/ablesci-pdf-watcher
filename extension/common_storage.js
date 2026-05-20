'use strict';

(function () {
  const config = globalThis.AblesciWatcherConfig || {};
  const DEFAULT_OPTIONS = config.DEFAULT_OPTIONS || {};
  const normalizeOptions = typeof config.normalizeOptions === 'function'
    ? config.normalizeOptions
    : (raw => ({ ...(raw || {}) }));

  const OPTION_IDS = Object.keys(DEFAULT_OPTIONS);
  const STORAGE_KEYS = {
    LAST_DIAGNOSTIC_KEY: 'latestDiagnostic',
    JOURNAL_ACCESS_STATS_KEY: 'journalAccessStats',
    JOURNAL_ACCESS_LOOKUP_KEY: 'journalAccessLookupIndex',
    AUTO_WATCHER_STATE_KEY: 'autoWatcherState',
    AUTO_WATCHER_LOG_KEY: 'autoWatcherLogs',
    AUTO_WATCHER_TRACE_KEY: 'autoWatcherTraceLogs',
    DEMAND_SNAPSHOTS_KEY: 'demandSnapshots'
  };

  async function loadOptionsFromStorage(uiNormalizers = null) {
    const local = await chrome.storage.local.get(OPTION_IDS);
    const missingLocal = OPTION_IDS.some(id => local[id] === undefined);
    if (!missingLocal) {
      return normalizeOptions({ ...DEFAULT_OPTIONS, ...local }, uiNormalizers || undefined);
    }

    const legacy = await chrome.storage.sync.get(DEFAULT_OPTIONS);
    const migrated = normalizeOptions({ ...DEFAULT_OPTIONS, ...legacy, ...local }, uiNormalizers || undefined);
    await chrome.storage.local.set(migrated);
    return migrated;
  }

  globalThis.AblesciWatcherStorage = {
    OPTION_IDS,
    ...STORAGE_KEYS,
    loadOptionsFromStorage
  };
})();
