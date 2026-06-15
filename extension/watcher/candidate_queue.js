'use strict';

// Responsibility: lightweight persisted queue for assist-list candidates.
(function () {
  function createWatcherCandidateQueueApi(config) {
    const {
      getWatcherState,
      updateWatcherState,
      appendWatcherTrace,
      getListUrlKey
    } = config;

    const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
    const SEEN_TTL_MS = 48 * 60 * 60 * 1000;
    const MAX_ITEMS = 300;
    const PROCESS_LIMIT = 80;
    const PAGE_BACKOFF_MS = 30 * 60 * 1000;
    const LOW_YIELD_BACKOFF_MS = 10 * 60 * 1000;

    function queueCandidateKey(candidate = {}) {
      return String(candidate.assistId || candidate.detailUrl || '').trim();
    }

    function isScienceDirectQueueCandidate(candidate = {}) {
      const haystack = [
        candidate.publisherName,
        candidate.listUrl,
        candidate.detailUrl
      ].map(value => String(value || '')).join(' ');
      return /sciencedirect|elsevier/i.test(haystack);
    }

    function normalizeCandidateQueue(rawQueue = {}) {
      const now = Date.now();
      const queue = rawQueue && typeof rawQueue === 'object' && !Array.isArray(rawQueue) ? rawQueue : {};
      const seen = {};
      for (const [key, value] of Object.entries(queue.seen || {})) {
        const t = Number(value?.lastSeenAt || value?.consumedAt || 0);
        if (key && Number.isFinite(t) && now - t <= SEEN_TTL_MS && isScienceDirectQueueCandidate(value)) {
          seen[key] = { ...value };
          delete seen[key].title;
        }
      }

      const unique = new Map();
      const items = Array.isArray(queue.items) ? queue.items : [];
      for (const item of items) {
        const key = queueCandidateKey(item);
        const t = Number(item?.lastSeenAt || item?.enqueuedAt || 0);
        if (!key || !Number.isFinite(t) || now - t > QUEUE_TTL_MS) continue;
        if (!unique.has(key)) {
          const normalizedItem = { ...item };
          delete normalizedItem.title;
          unique.set(key, normalizedItem);
        }
      }

      const refillBackoff = {};
      for (const [key, value] of Object.entries(queue.refillBackoff || {})) {
        const nextAfter = Number(value?.nextAfter || 0);
        if (key && Number.isFinite(nextAfter) && nextAfter > now) {
          refillBackoff[key] = value;
        }
      }

      return {
        items: Array.from(unique.values()).slice(0, MAX_ITEMS),
        seen,
        refillBackoff,
        pageSignatures: queue.pageSignatures && typeof queue.pageSignatures === 'object' && !Array.isArray(queue.pageSignatures)
          ? queue.pageSignatures
          : {},
        refillCursors: queue.refillCursors && typeof queue.refillCursors === 'object' && !Array.isArray(queue.refillCursors)
          ? queue.refillCursors
          : {},
        updatedAt: queue.updatedAt || ''
      };
    }

    function sanitizeQueueCandidate(candidate = {}, pagePick = {}, listUrl = '') {
      const now = Date.now();
      return {
        assistId: String(candidate.assistId || '').slice(0, 80),
        detailUrl: String(candidate.detailUrl || '').slice(0, 500),
        listUrl: String(candidate.listUrl || listUrl || '').slice(0, 500),
        rowText: String(candidate.rowText || '').slice(0, 1200),
        doi: String(candidate.doi || '').slice(0, 160),
        hasDoi: candidate.hasDoi === true,
        publisherName: String(candidate.publisherName || pagePick.publisher || '').slice(0, 160),
        journalShortName: String(candidate.journalShortName || '').slice(0, 160),
        reported: candidate.reported === true,
        rejected: candidate.rejected === true,
        supplement: candidate.supplement === true,
        documentType: String(candidate.documentType || '').slice(0, 80),
        documentTypeText: String(candidate.documentTypeText || '').slice(0, 160),
        statusText: String(candidate.statusText || '').slice(0, 160),
        assistTimeText: String(candidate.assistTimeText || '').slice(0, 80),
        assistAgeSeconds: Number.isFinite(Number(candidate.assistAgeSeconds)) ? Number(candidate.assistAgeSeconds) : '',
        sticky: candidate.sticky === true,
        index: Number.isFinite(Number(candidate.index)) ? Number(candidate.index) : 0,
        page: Number.isFinite(Number(pagePick.pickedPage)) ? Number(pagePick.pickedPage) : '',
        pageOrder: pagePick.pageOrder || '',
        urlKey: pagePick.urlKey || '',
        enqueuedAt: Number(candidate.enqueuedAt || now),
        lastSeenAt: now
      };
    }

    function pageBackoffKey(pagePick = {}) {
      if (!pagePick.urlKey || !Number.isFinite(Number(pagePick.pickedPage))) return '';
      return `${pagePick.urlKey}#${Number(pagePick.pickedPage)}`;
    }

    function pageSignature(candidates) {
      const ids = (Array.isArray(candidates) ? candidates : [])
        .map(candidate => queueCandidateKey(candidate))
        .filter(Boolean)
        .slice(0, 30);
      return ids.join('|');
    }

    function numericOrEmpty(value) {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : '';
    }

    function adjustedCursorPage(cursor, currentMaxPage = '') {
      const page = Number(cursor?.page);
      if (!Number.isFinite(page) || page <= 0) return '';
      const currentMax = Number(currentMaxPage || cursor?.maxPage || cursor?.pageMax || 0);
      const adjusted = page;
      const min = Number(cursor?.pageMin || 1);
      const max = Number(currentMax || cursor?.pageMax || adjusted);
      const lower = Number.isFinite(min) && min > 0 ? min : 1;
      const upper = Number.isFinite(max) && max >= lower ? max : adjusted;
      return Math.min(upper, Math.max(lower, Math.round(adjusted)));
    }

    function configuredUrlKeys(listUrls = []) {
      if (typeof getListUrlKey !== 'function') return new Set();
      const keys = new Set();
      for (const url of (Array.isArray(listUrls) ? listUrls : [])) {
        const key = getListUrlKey(url);
        if (key) keys.add(key);
        const legacyKey = legacyConfiguredUrlKey(url);
        if (legacyKey) keys.add(legacyKey);
      }
      return keys;
    }

    function legacyConfiguredUrlKey(url) {
      try {
        const u = new URL(url);
        u.searchParams.delete('page');
        u.searchParams.delete('order');
        u.searchParams.delete('page_order');
        u.searchParams.delete('page_min');
        u.searchParams.delete('page_max');
        return u.toString();
      } catch (_) {
        return '';
      }
    }

    function candidateUrlKey(candidate = {}) {
      if (candidate.urlKey) return String(candidate.urlKey);
      if (candidate.listUrl && typeof getListUrlKey === 'function') return getListUrlKey(candidate.listUrl);
      return '';
    }

    async function enqueueParsedCandidates(parsed, pagePick, pickedListUrl, trigger, candidatesOverride = null) {
      const parsedCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const rawCandidates = Array.isArray(candidatesOverride) ? candidatesOverride : parsedCandidates;
      const backoffKey = pageBackoffKey(pagePick);
      const snapshotSignature = pageSignature(parsedCandidates);
      const parsedMaxPage = numericOrEmpty(parsed?.listStats?.maxPage);
      const result = {
        added: 0,
        refreshed: 0,
        seenSkipped: 0,
        addedExamples: [],
        refreshedExamples: [],
        seenSkippedExamples: [],
        parsedCount: parsedCandidates.length,
        queueableCount: rawCandidates.length,
        queueSize: 0
      };
      await updateWatcherState(state => {
        const queue = normalizeCandidateQueue(state.assistCandidateQueue);
        const existing = new Map(queue.items.map(item => [queueCandidateKey(item), item]));
        for (const candidate of rawCandidates) {
          const item = sanitizeQueueCandidate(candidate, pagePick, pickedListUrl);
          const key = queueCandidateKey(item);
          if (!key) continue;
          const shouldRememberSeen = isScienceDirectQueueCandidate(item);
          if (existing.has(key)) {
            const existingItem = existing.get(key);
            Object.assign(existingItem, item, { enqueuedAt: existingItem.enqueuedAt || item.enqueuedAt });
            delete existingItem.title;
            result.refreshed += 1;
            if (result.refreshedExamples.length < 20) {
              result.refreshedExamples.push({
                assistId: item.assistId,
                detailUrl: item.detailUrl,
                listUrl: item.listUrl,
                doi: item.doi,
                journalShortName: item.journalShortName,
                publisherName: item.publisherName,
                page: item.page,
                pageOrder: item.pageOrder,
                index: item.index,
                assistTimeText: item.assistTimeText,
                urlKey: item.urlKey,
                reason: 'queue_refreshed'
              });
            }
          } else if (!shouldRememberSeen || !queue.seen[key]) {
            queue.items.push(item);
            existing.set(key, item);
            result.added += 1;
            if (result.addedExamples.length < 20) {
              result.addedExamples.push({
                assistId: item.assistId,
                detailUrl: item.detailUrl,
                listUrl: item.listUrl,
                doi: item.doi,
                journalShortName: item.journalShortName,
                publisherName: item.publisherName,
                page: item.page,
                pageOrder: item.pageOrder,
                index: item.index,
                assistTimeText: item.assistTimeText,
                urlKey: item.urlKey,
                reason: 'queue_added'
              });
            }
          } else {
            result.seenSkipped += 1;
            if (result.seenSkippedExamples.length < 20) {
              result.seenSkippedExamples.push({
                assistId: item.assistId,
                detailUrl: item.detailUrl,
                listUrl: item.listUrl,
                doi: item.doi,
                journalShortName: item.journalShortName,
                publisherName: item.publisherName,
                page: item.page,
                pageOrder: item.pageOrder,
                index: item.index,
                assistTimeText: item.assistTimeText,
                urlKey: item.urlKey,
                reason: 'seen_before'
              });
            }
          }
          if (shouldRememberSeen) {
            queue.seen[key] = {
              lastSeenAt: Date.now(),
              page: item.page,
              listUrl: item.listUrl,
              publisherName: item.publisherName || '',
              journalShortName: item.journalShortName || ''
            };
          } else {
            delete queue.seen[key];
          }
        }
        if (backoffKey) {
          const previousSignature = queue.pageSignatures[backoffKey]?.signature || '';
          const repeatedSignature = !!snapshotSignature && previousSignature === snapshotSignature;
          if (result.added <= 0 && parsedCandidates.length > 0) {
            queue.refillBackoff[backoffKey] = {
              nextAfter: Date.now() + (repeatedSignature ? PAGE_BACKOFF_MS : LOW_YIELD_BACKOFF_MS),
              reason: repeatedSignature ? 'page_snapshot_repeated' : 'page_snapshot_no_new_candidates',
              parsedCount: parsedCandidates.length,
              queueableCount: rawCandidates.length,
              page: pagePick.pickedPage,
              listUrl: pickedListUrl,
              signature: snapshotSignature
            };
          } else {
            delete queue.refillBackoff[backoffKey];
          }
          queue.pageSignatures[backoffKey] = {
            signature: snapshotSignature,
            parsedCount: parsedCandidates.length,
            queueableCount: rawCandidates.length,
            added: result.added,
            updatedAt: new Date().toISOString()
          };
        }
        if (pagePick.urlKey && pagePick.skipCursorUpdate !== true && Number.isFinite(Number(pagePick.pickedPage))) {
          const cursorMaxPage = parsedMaxPage || numericOrEmpty(pagePick.pageMax);
          queue.refillCursors[pagePick.urlKey] = {
            page: Number(pagePick.pickedPage),
            pageOrder: pagePick.pageOrder || '',
            pageMin: pagePick.pageMin || '',
            pageMax: pagePick.pageMax || '',
            maxPage: cursorMaxPage,
            listUrl: pickedListUrl,
            updatedAt: new Date().toISOString()
          };
          if (parsedMaxPage) {
            state.detectedMaxPages = state.detectedMaxPages || {};
            state.detectedMaxPages[pagePick.urlKey] = parsedMaxPage;
          }
        }
        queue.items = queue.items
          .sort((a, b) => Number(b?.lastSeenAt || b?.enqueuedAt || 0) - Number(a?.lastSeenAt || a?.enqueuedAt || 0))
          .slice(0, MAX_ITEMS);
        queue.updatedAt = new Date().toISOString();
        result.queueSize = queue.items.length;
        state.assistCandidateQueue = queue;
      });
      await appendWatcherTrace('candidate_queue_refilled', {
        reason: 'list_snapshot_enqueued',
        trigger,
        listUrl: pickedListUrl,
        pickedPage: pagePick.pickedPage,
        parsedCount: result.parsedCount,
        queueableCount: result.queueableCount,
        added: result.added,
        refreshed: result.refreshed,
        seenSkipped: result.seenSkipped,
        queueSize: result.queueSize
      });
      if (result.seenSkippedExamples.length > 0) {
        for (const item of result.seenSkippedExamples) {
          await appendWatcherTrace('candidate_queue_seen_skipped', {
            ...item,
            reason: 'seen_before',
            trigger,
            pickedPage: pagePick.pickedPage,
            pageMax: pagePick.pageMax || '',
            listUrl: item.listUrl || pickedListUrl
          });
        }
      }
      return result;
    }

    function stateWithQueueRefillCursor(listUrl, state = {}, currentMaxPage = '') {
      if (typeof getListUrlKey !== 'function') return state;
      const urlKey = getListUrlKey(listUrl);
      const queue = normalizeCandidateQueue(state.assistCandidateQueue);
      const cursor = queue.refillCursors[urlKey];
      const currentMax = numericOrEmpty(currentMaxPage) || numericOrEmpty(state?.detectedMaxPages?.[urlKey]) || numericOrEmpty(cursor?.maxPage);
      const page = adjustedCursorPage(cursor, currentMax);
      if (!urlKey || !Number.isFinite(Number(page)) || Number(page) <= 0) return state;
      return {
        ...state,
        detectedMaxPages: currentMax
          ? { ...(state.detectedMaxPages || {}), [urlKey]: currentMax }
          : state.detectedMaxPages,
        lastVisitedPages: {
          ...(state.lastVisitedPages || {}),
          [urlKey]: Number(page)
        },
        assistCandidateQueue: queue
      };
    }

    function hasExplicitPageRange(listUrl) {
      try {
        const u = new URL(listUrl);
        return u.searchParams.has('page_min') || u.searchParams.has('page_max');
      } catch (_) {
        return false;
      }
    }

    async function queuedCandidatesSnapshot(limit = PROCESS_LIMIT, listUrls = null) {
      const state = await getWatcherState();
      const queue = normalizeCandidateQueue(state.assistCandidateQueue);
      const allowedKeys = configuredUrlKeys(listUrls);
      const items = allowedKeys.size > 0
        ? queue.items.filter(item => allowedKeys.has(candidateUrlKey(item)))
        : queue.items;
      return items.slice(0, Math.max(1, limit));
    }

    async function removeQueuedCandidate(candidate, reason) {
      const key = queueCandidateKey(candidate);
      if (!key) return;
      await updateWatcherState(state => {
        const queue = normalizeCandidateQueue(state.assistCandidateQueue);
        queue.items = queue.items.filter(item => queueCandidateKey(item) !== key);
        if (isScienceDirectQueueCandidate(candidate)) {
          queue.seen[key] = {
            ...(queue.seen[key] || {}),
            consumedAt: Date.now(),
            lastSeenAt: Date.now(),
            status: reason || 'consumed',
            page: candidate.page || queue.seen[key]?.page || '',
            listUrl: candidate.listUrl || queue.seen[key]?.listUrl || '',
            publisherName: candidate.publisherName || queue.seen[key]?.publisherName || '',
            journalShortName: candidate.journalShortName || queue.seen[key]?.journalShortName || ''
          };
        } else {
          delete queue.seen[key];
        }
        queue.updatedAt = new Date().toISOString();
        state.assistCandidateQueue = queue;
      });
    }

    async function shouldSkipBackedOffPage(pagePick) {
      const key = pageBackoffKey(pagePick);
      if (!key) return false;
      const state = await getWatcherState();
      const queue = normalizeCandidateQueue(state.assistCandidateQueue);
      const entry = queue.refillBackoff[key];
      return !!entry && Number(entry.nextAfter || 0) > Date.now();
    }

    return {
      enqueueParsedCandidates,
      queuedCandidatesSnapshot,
      removeQueuedCandidate,
      shouldSkipBackedOffPage,
      stateWithQueueRefillCursor
    };
  }

  globalThis.AblesciWatcherCandidateQueueModule = {
    createWatcherCandidateQueueApi
  };
})();
