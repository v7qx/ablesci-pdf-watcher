'use strict';

(function () {
  function createBackgroundJournalRulesApi() {
    function normalizeJournalKey(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function emptySummary() {
      return { blocked: 0, partial: 0, allowed: 0, unknown: 0 };
    }

    function withJournalAccessDisabled(opts = {}) {
      return {
        ...opts,
        watcherJournalAccessRules: '',
        watcherJournalAccessRulesSource: '',
        journalAccessConfigPath: '',
        journalAccessRuleSummary: emptySummary()
      };
    }

    async function readJournalAccessRulesFromConfig() {
      return { ok: false, path: '', raw: '' };
    }

    async function writeJournalAccessRulesToConfig() {
      return false;
    }

    function journalAccessRuleSummary() {
      return emptySummary();
    }

    async function resolveJournalAccessRulesForOptions(opts) {
      return withJournalAccessDisabled(opts);
    }

    async function reloadJournalAccessRulesFromConfig(opts) {
      return withJournalAccessDisabled(opts);
    }

    async function syncJournalAccessRulesFromStats() {}

    async function recordJournalAccessResult() {}

    async function recordJournalAccessResultNow() {}

    return {
      normalizeJournalKey,
      journalRuleNames: () => [],
      readJournalAccessRulesFromConfig,
      writeJournalAccessRulesToConfig,
      removeRuleMatchingJournal: list => ({ list: Array.isArray(list) ? list : [], removed: false }),
      compactRuleEntry: () => ({}),
      upsertRuleEntry: list => Array.isArray(list) ? list : [],
      journalAccessRuleSummary,
      resolveJournalAccessRulesForOptions,
      reloadJournalAccessRulesFromConfig,
      syncJournalAccessRulesFromStats,
      recordJournalAccessResult,
      recordJournalAccessResultNow
    };
  }

  globalThis.AblesciBackgroundJournalRules = {
    createBackgroundJournalRulesApi
  };
})();
