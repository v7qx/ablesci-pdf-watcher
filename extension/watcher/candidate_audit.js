'use strict';

// Responsibility: compact candidate audit rows and indexes for watcher diagnostics.
(function () {
  function createWatcherCandidateAuditApi(config = {}) {
    const {
      chromeApi = typeof chrome !== 'undefined' ? chrome : null
    } = config;

    const CANDIDATE_AUDIT_KEY = 'autoWatcherCandidateAudit';
    const CANDIDATE_AUDIT_INDEX_KEY = 'autoWatcherCandidateAuditIndex';
    const CANDIDATE_AUDIT_LIMIT = 20000;
    const CANDIDATE_AUDIT_INDEX_LIMIT = 10000;
    const CANDIDATE_AUDIT_RECENT_EVENTS_LIMIT = 8;

    function safeAuditText(value, limit = 500) {
      return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function listUrlKeyFromUrl(url = '') {
      try {
        const u = new URL(url);
        u.searchParams.delete('page');
        return u.toString();
      } catch (_) {
        return '';
      }
    }

    function auditNumberOrEmpty(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : '';
    }

    function compactCandidateAuditDetails(details = {}) {
      if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
      const compact = {};
      if (details.requestedPage !== undefined) compact.requestedPage = auditNumberOrEmpty(details.requestedPage);
      if (details.maxDetailAttempts !== undefined) compact.maxDetailAttempts = auditNumberOrEmpty(details.maxDetailAttempts);
      if (details.stopRun === true) compact.stopRun = true;
      if (details.removeQueue === true) compact.removeQueue = true;
      if (details.journalAccess && typeof details.journalAccess === 'object') {
        compact.journalAccess = {
          shortName: safeAuditText(details.journalAccess.shortName || details.journalAccess.journalShortName || '', 120),
          reason: safeAuditText(details.journalAccess.reason || '', 80)
        };
      }
      return compact;
    }

    function buildCandidateAuditEntry(phase, candidate = {}, extra = {}) {
      const assistId = safeAuditText(candidate.assistId || extra.assistId || '', 80);
      const listUrl = safeAuditText(candidate.listUrl || extra.listUrl || extra.pickedListUrl || '', 500);
      return {
        time: extra.time || new Date().toISOString(),
        phase: safeAuditText(phase, 80),
        status: safeAuditText(extra.status || '', 80),
        reason: safeAuditText(extra.reason || '', 240),
        trigger: safeAuditText(extra.trigger || '', 80),
        assistId,
        doi: safeAuditText(candidate.doi || extra.doi || '', 160),
        journalShortName: safeAuditText(candidate.journalShortName || extra.journalShortName || '', 160),
        journalName: safeAuditText(candidate.journalName || extra.journalName || '', 240),
        publisherName: safeAuditText(candidate.publisherName || extra.publisherName || extra.publisher || '', 160),
        page: auditNumberOrEmpty(extra.page ?? extra.pickedPage ?? candidate.page),
        pageOrder: safeAuditText(extra.pageOrder || candidate.pageOrder || '', 20),
        pageMax: auditNumberOrEmpty(extra.pageMax ?? candidate.pageMax),
        urlKey: safeAuditText(extra.urlKey || candidate.urlKey || listUrlKeyFromUrl(listUrl), 240),
        listIndex: auditNumberOrEmpty(extra.listIndex ?? candidate.index),
        assistTimeText: safeAuditText(candidate.assistTimeText || extra.assistTimeText || '', 80),
        assistAgeSeconds: auditNumberOrEmpty(candidate.assistAgeSeconds ?? extra.assistAgeSeconds),
        source: safeAuditText(extra.source || '', 80),
        tabId: safeAuditText(extra.tabId || '', 40),
        details: compactCandidateAuditDetails(extra.details)
      };
    }

    async function appendCandidateAuditEntries(entries = []) {
      const batch = (Array.isArray(entries) ? entries : []).filter(entry => entry && entry.assistId);
      if (batch.length <= 0) return;
      try {
        const storage = chromeApi.storage.local;
        const stored = await storage.get([CANDIDATE_AUDIT_KEY, CANDIDATE_AUDIT_INDEX_KEY]);
        const normalizedBatch = batch.map(normalizeCandidateAuditEntryForStorage);
        const current = Array.isArray(stored[CANDIDATE_AUDIT_KEY])
          ? stored[CANDIDATE_AUDIT_KEY].map(normalizeCandidateAuditEntryForStorage)
          : [];
        const currentIndex = stored[CANDIDATE_AUDIT_INDEX_KEY] && typeof stored[CANDIDATE_AUDIT_INDEX_KEY] === 'object' && !Array.isArray(stored[CANDIDATE_AUDIT_INDEX_KEY])
          ? normalizeCandidateAuditIndexForStorage(stored[CANDIDATE_AUDIT_INDEX_KEY])
          : {};
        await storage.set({
          [CANDIDATE_AUDIT_KEY]: normalizedBatch.concat(current).slice(0, CANDIDATE_AUDIT_LIMIT),
          [CANDIDATE_AUDIT_INDEX_KEY]: updateCandidateAuditIndex(currentIndex, normalizedBatch)
        });
      } catch (err) {
        console.warn('[candidateAudit] failed', err);
      }
    }

    function auditEventSignature(entry = {}) {
      return [
        entry.phase || '',
        entry.status || '',
        entry.reason || '',
        entry.page ?? '',
        entry.listIndex ?? ''
      ].join('|');
    }

    function compactAuditEvent(entry = {}) {
      return {
        time: entry.time || new Date().toISOString(),
        phase: entry.phase || '',
        status: entry.status || '',
        reason: entry.reason || '',
        page: entry.page ?? '',
        listIndex: entry.listIndex ?? ''
      };
    }

    function updateCandidateAuditIndex(index, batch) {
      const next = { ...(index || {}) };
      for (const entry of batch) {
        const assistId = safeAuditText(entry.assistId || '', 80);
        if (!assistId) continue;
        const prev = next[assistId] && typeof next[assistId] === 'object' ? next[assistId] : {};
        const recentEvents = Array.isArray(prev.recentEvents) ? prev.recentEvents.slice() : [];
        const event = compactAuditEvent(entry);
        const lastEvent = recentEvents[recentEvents.length - 1] || null;
        if (!lastEvent || auditEventSignature(lastEvent) !== auditEventSignature(event)) {
          recentEvents.push(event);
        } else {
          recentEvents[recentEvents.length - 1] = event;
        }
        const pages = Array.isArray(prev.pages) ? prev.pages.slice() : [];
        const pageValue = Number(entry.page);
        if (Number.isFinite(pageValue) && !pages.includes(pageValue)) pages.push(pageValue);
        next[assistId] = {
          assistId,
          firstSeenAt: prev.firstSeenAt || entry.time || new Date().toISOString(),
          lastAt: entry.time || prev.lastAt || new Date().toISOString(),
          eventCount: Number(prev.eventCount || 0) + 1,
          latestPhase: entry.phase || prev.latestPhase || '',
          latestStatus: entry.status || prev.latestStatus || '',
          latestReason: entry.reason || prev.latestReason || '',
          journalShortName: safeAuditText(entry.journalShortName || prev.journalShortName || '', 160),
          publisherName: safeAuditText(entry.publisherName || prev.publisherName || '', 160),
          doi: safeAuditText(entry.doi || prev.doi || '', 160),
          assistTimeText: safeAuditText(entry.assistTimeText || prev.assistTimeText || '', 80),
          urlKey: safeAuditText(entry.urlKey || prev.urlKey || listUrlKeyFromUrl(entry.listUrl || prev.lastListUrl || prev.firstListUrl || ''), 240),
          firstPage: prev.firstPage || entry.page || '',
          lastPage: entry.page || prev.lastPage || '',
          lastListIndex: entry.listIndex ?? prev.lastListIndex ?? '',
          pages: pages.slice(-20),
          recentEvents: recentEvents.slice(-CANDIDATE_AUDIT_RECENT_EVENTS_LIMIT)
        };
      }
      const entries = Object.entries(next);
      if (entries.length <= CANDIDATE_AUDIT_INDEX_LIMIT) return next;
      entries.sort((a, b) => new Date(b[1]?.lastAt || 0).getTime() - new Date(a[1]?.lastAt || 0).getTime());
      return Object.fromEntries(entries.slice(0, CANDIDATE_AUDIT_INDEX_LIMIT));
    }

    function normalizeCandidateAuditEntryForStorage(record) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
      const next = { ...record };
      delete next.title;
      const urlKey = next.urlKey || listUrlKeyFromUrl(next.listUrl || next.lastListUrl || next.firstListUrl || '');
      if (urlKey) next.urlKey = safeAuditText(urlKey, 240);
      delete next.detailUrl;
      delete next.listUrl;
      delete next.firstListUrl;
      delete next.lastListUrl;
      next.details = compactCandidateAuditDetails(next.details);
      return next;
    }

    function normalizeCandidateAuditIndexForStorage(index) {
      if (!index || typeof index !== 'object' || Array.isArray(index)) return {};
      let changed = false;
      const next = {};
      for (const [key, value] of Object.entries(index)) {
        const normalized = normalizeCandidateAuditEntryForStorage(value);
        if (normalized !== value) changed = true;
        next[key] = normalized;
      }
      return changed ? next : index;
    }

    function listUrlWithAuditPage(listUrl, page) {
      if (!Number.isFinite(Number(page))) return listUrl;
      try {
        const u = new URL(listUrl);
        u.searchParams.set('page', String(Number(page)));
        return u.toString();
      } catch (_) {
        return listUrl;
      }
    }

    async function auditParsedListCandidates(parsed, pagePick, pickedListUrl, trigger, reason = 'parsed_from_list') {
      const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const auditPage = Number.isFinite(Number(parsed?.listStats?.currentPage))
        ? Number(parsed.listStats.currentPage)
        : pagePick.pickedPage;
      const auditListUrl = listUrlWithAuditPage(pickedListUrl, auditPage);
      await appendCandidateAuditEntries(candidates.map((candidate, index) => buildCandidateAuditEntry('list_seen', candidate, {
        status: 'seen',
        reason,
        trigger,
        listUrl: auditListUrl,
        page: auditPage,
        pageOrder: pagePick.pageOrder,
        pageMax: parsed?.listStats?.maxPage || pagePick.pageMax,
        urlKey: pagePick.urlKey,
        publisher: pagePick.publisher,
        listIndex: candidate.index ?? index,
        source: 'list_page',
        details: Number(pagePick.pickedPage) !== Number(auditPage)
          ? { requestedPage: pagePick.pickedPage }
          : {}
      })));
    }

    async function auditEnqueueResult(enqueueResult, pagePick, pickedListUrl, trigger, source = 'candidate_queue') {
      const enqueueAuditRows = [];
      for (const item of enqueueResult.addedExamples || []) {
        enqueueAuditRows.push(buildCandidateAuditEntry('queue_added', item, {
          status: 'queued',
          reason: 'queue_added',
          trigger,
          listUrl: item.listUrl || pickedListUrl,
          page: item.page || pagePick.pickedPage,
          pageOrder: item.pageOrder || pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source
        }));
      }
      for (const item of enqueueResult.refreshedExamples || []) {
        enqueueAuditRows.push(buildCandidateAuditEntry('queue_refreshed', item, {
          status: 'queued',
          reason: 'queue_refreshed',
          trigger,
          listUrl: item.listUrl || pickedListUrl,
          page: item.page || pagePick.pickedPage,
          pageOrder: item.pageOrder || pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source
        }));
      }
      for (const item of enqueueResult.seenSkippedExamples || []) {
        enqueueAuditRows.push(buildCandidateAuditEntry('queue_seen_skip', item, {
          status: 'skipped',
          reason: 'seen_before',
          trigger,
          listUrl: item.listUrl || pickedListUrl,
          page: item.page || pagePick.pickedPage,
          pageOrder: item.pageOrder || pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source
        }));
      }
      await appendCandidateAuditEntries(enqueueAuditRows);
    }

    return {
      buildCandidateAuditEntry,
      appendCandidateAuditEntries,
      auditParsedListCandidates,
      auditEnqueueResult,
      listUrlWithAuditPage
    };
  }

  globalThis.AblesciWatcherCandidateAuditModule = {
    createWatcherCandidateAuditApi
  };
})();
