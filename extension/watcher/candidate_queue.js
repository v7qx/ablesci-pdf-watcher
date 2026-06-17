'use strict';

// Responsibility: clear legacy persisted candidate queue entries after a candidate is handled.
(function () {
  function createWatcherCandidateQueueApi(config) {
    const {
      updateWatcherState
    } = config;

    const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
    const SEEN_TTL_MS = 48 * 60 * 60 * 1000;
    const MAX_ITEMS = 300;

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

      return {
        items: Array.from(unique.values()).slice(0, MAX_ITEMS),
        seen,
        updatedAt: queue.updatedAt || ''
      };
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

    return {
      removeQueuedCandidate
    };
  }

  globalThis.AblesciWatcherCandidateQueueModule = {
    createWatcherCandidateQueueApi
  };
})();
