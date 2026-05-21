'use strict';

(function () {
  function createBackgroundJournalRulesApi(deps = {}) {
    const {
      chromeApi,
      parseJournalAccessRules,
      journalAccessStatsKey,
      journalAccessLookupKey,
      sendNativeMessage,
      getOptions,
      normalizeText = value => String(value || ''),
      readConfigTimeoutMs = 30 * 1000
    } = deps;

    let journalAccessUpdateChain = Promise.resolve();

    function normalizeJournalKey(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function journalRuleNames(entry) {
      if (typeof entry === 'string') return [entry];
      if (!entry || typeof entry !== 'object') return [];
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      return [
        entry.short,
        entry.full,
        entry.journal,
        entry.name,
        ...aliases
      ].filter(Boolean);
    }

    async function readJournalAccessRulesFromConfig(opts) {
      try {
        const res = await sendNativeMessage(opts.nativeHostName, {
          action: 'read_config_file',
          dir: '',
          config_path: '',
          filename: 'journal-access.json'
        }, readConfigTimeoutMs);
        return {
          ok: true,
          path: res.path || '',
          raw: String(res.body || '')
        };
      } catch (_) {
        return { ok: false, path: '', raw: '' };
      }
    }

    async function writeJournalAccessRulesToConfig(opts, rules, existingPath = '') {
      const content = JSON.stringify(rules, null, 2) + '\n';
      try {
        await sendNativeMessage(opts.nativeHostName, {
          action: 'write_config_file',
          dir: '',
          config_path: existingPath || '',
          filename: 'journal-access.json',
          content
        }, readConfigTimeoutMs);
        return true;
      } catch (err) {
        console.warn('[Ablesci PDF Watcher] journal access config write failed', err);
        return false;
      }
    }

    function removeRuleMatchingJournal(list, journalName) {
      const target = normalizeJournalKey(journalName);
      if (!target) return { list, removed: false };
      let removed = false;
      const next = list.filter(entry => {
        const matched = journalRuleNames(entry).some(name => normalizeJournalKey(name) === target);
        if (matched) removed = true;
        return !matched;
      });
      return { list: next, removed };
    }

    async function promoteJournalAccessRuleAfterSuccess(journalName, opts) {
      const journal = String(journalName || '').trim();
      if (!journal) return;
      const fileRules = await readJournalAccessRulesFromConfig(opts);
      const raw = fileRules.ok ? fileRules.raw : String(opts?.watcherJournalAccessRules || '').trim();
      const rules = parseJournalAccessRules(raw);
      const blocked = removeRuleMatchingJournal(rules.blocked, journal);
      const hasKnown = [...rules.allowed, ...rules.partial].some(entry =>
        journalRuleNames(entry).some(name => normalizeJournalKey(name) === normalizeJournalKey(journal))
      );
      if (!blocked.removed && hasKnown) return;
      rules.blocked = blocked.list;
      if (!hasKnown) {
        rules.partial = [
          ...rules.partial,
          { full: journal, source: 'upload_success', updatedAt: new Date().toISOString() }
        ];
      }
      const text = JSON.stringify(rules, null, 2);
      await chromeApi.storage.local.set({ watcherJournalAccessRules: text });
      await writeJournalAccessRulesToConfig(opts, rules, fileRules.path);
    }

    async function recordJournalAccessResult(payload, result) {
      journalAccessUpdateChain = journalAccessUpdateChain
        .catch(err => console.warn('[Ablesci PDF Uploader] previous journal access update failed', err))
        .then(() => recordJournalAccessResultNow(payload, result));
      return journalAccessUpdateChain;
    }

    async function recordJournalAccessResultNow(payload, result) {
      const journal = String(payload?.journalName || '').trim();
      if (!journal) return;
      const shortName = String(payload?.journalShortName || '').trim();

      const stored = await chromeApi.storage.local.get(journalAccessStatsKey);
      const stats = stored[journalAccessStatsKey] || {};
      const item = stats[journal] || {
        failCount: 0,
        successCount: 0,
        consecutiveFailCount: 0,
        lastFailAt: '',
        lastSuccessAt: '',
        lastReason: '',
        lastDoi: '',
        lastTitle: '',
        accessState: 'unknown'
      };
      item.failCount = Number(item.failCount || 0);
      item.successCount = Number(item.successCount || 0);
      item.consecutiveFailCount = Number(item.consecutiveFailCount || 0);
      item.doiFailureCount = Number(item.doiFailureCount || 0);
      item.consecutiveDoiFailureCount = Number(item.consecutiveDoiFailureCount || 0);
      item.aliases = Array.from(new Set([
        ...(Array.isArray(item.aliases) ? item.aliases : []),
        shortName,
        journal
      ].filter(Boolean).map(normalizeText)));

      if (result?.ok) {
        item.successCount += 1;
        item.consecutiveFailCount = 0;
        item.consecutiveDoiFailureCount = 0;
        item.lastSuccessAt = new Date().toISOString();
        item.accessState = item.failCount > 0 ? 'partial_access' : 'has_access';
      } else {
        const reason = result?.reason || 'unknown';
        item.failCount += 1;
        item.consecutiveFailCount += 1;
        item.lastFailAt = new Date().toISOString();
        item.lastReason = reason;
        item.lastDoi = payload?.doi || '';
        item.lastTitle = payload?.title || payload?.suggestedFilename || '';
        if (/^doi_/i.test(reason)) {
          item.doiFailureCount += 1;
          item.consecutiveDoiFailureCount += 1;
          item.lastDoiFailureAt = item.lastFailAt;
        }
        if (item.successCount > 0) {
          item.accessState = 'partial_access';
        } else if (item.consecutiveFailCount >= 10) {
          item.accessState = 'no_access';
        } else {
          item.accessState = 'unknown';
        }
      }

      stats[journal] = item;
      const lookup = {};
      for (const [name, statItem] of Object.entries(stats || {})) {
        if (!statItem) continue;
        const aliases = Array.isArray(statItem.aliases) ? statItem.aliases : [];
        const keys = [name, ...aliases].map(normalizeJournalKey).filter(Boolean);
        for (const key of keys) {
          lookup[key] = {
            journalName: name,
            accessState: statItem.accessState || 'unknown',
            successCount: Number(statItem.successCount || 0),
            consecutiveFailCount: Number(statItem.consecutiveFailCount || 0),
            consecutiveDoiFailureCount: Number(statItem.consecutiveDoiFailureCount || 0),
            lastReason: statItem.lastReason || ''
          };
        }
      }
      await chromeApi.storage.local.set({
        [journalAccessStatsKey]: stats,
        [journalAccessLookupKey]: {
          updatedAt: new Date().toISOString(),
          count: Object.keys(stats).length,
          index: lookup
        }
      });
      if (result?.ok) {
        const opts = await getOptions();
        await promoteJournalAccessRuleAfterSuccess(journal, opts);
      }
    }

    return {
      normalizeJournalKey,
      journalRuleNames,
      readJournalAccessRulesFromConfig,
      writeJournalAccessRulesToConfig,
      removeRuleMatchingJournal,
      promoteJournalAccessRuleAfterSuccess,
      recordJournalAccessResult,
      recordJournalAccessResultNow
    };
  }

  globalThis.AblesciBackgroundJournalRules = {
    createBackgroundJournalRulesApi
  };
})();
