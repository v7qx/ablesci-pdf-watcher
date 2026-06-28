'use strict';

// Publisher count snapshots refresh every 2 hours. Change this value (minutes)
// for local debugging or tuning; it is intentionally not exposed in options UI.
const PUBLISHER_COUNT_REFRESH_MINUTES = 120;

// Maintains a small, time-bounded snapshot of publisher request counts. The
// configured list URLs remain the source of truth; this module only filters the
// temporary random-selection pool for the current run.
(function () {
  function createWatcherPublisherCountsApi() {
    function publisherSlugFromUrl(url) {
      try {
        const parsed = new URL(String(url || ''));
        if (!/(^|\.)ablesci\.com$/i.test(parsed.hostname)) return '';
        return String(parsed.searchParams.get('publisher') || '').trim().toLowerCase();
      } catch (_) {
        return '';
      }
    }

    function isScienceDirectSlug(slug) {
      return /^(?:elsevier|sciencedirect)$/.test(String(slug || '').toLowerCase());
    }

    function selectedPublisherSlugs(urls) {
      return Array.from(new Set((Array.isArray(urls) ? urls : [])
        .map(publisherSlugFromUrl)
        .filter(Boolean)))
        .sort();
    }

    function selectedSignature(urls) {
      return selectedPublisherSlugs(urls).join(',');
    }

    function refreshIntervalMs() {
      return PUBLISHER_COUNT_REFRESH_MINUTES * 60 * 1000;
    }

    function cacheIsFresh(state, urls, opts = {}, now = Date.now()) {
      if (Math.max(0, Number(opts.watcherMinNonSdSeekingCount || 0)) <= 0) return false;
      const cache = state?.publisherSeekingCountCache;
      const updatedAt = Date.parse(cache?.updatedAt || '');
      return Number.isFinite(updatedAt) &&
        now - updatedAt < refreshIntervalMs() &&
        String(cache?.selectedSignature || '') === selectedSignature(urls);
    }

    function normalizedParsedCounts(parsed) {
      const result = {};
      const counts = parsed?.listStats?.publisherCounts || {};
      for (const [rawName, rawCount] of Object.entries(counts)) {
        const slug = String(rawName || '').trim().toLowerCase();
        const count = Number(rawCount);
        if (!slug || !Number.isFinite(count) || count < 0) continue;
        result[slug] = count;
      }
      return result;
    }

    function updateCacheFromParsed(state, parsed, urls, opts = {}, now = Date.now()) {
      const threshold = Math.max(0, Number(opts.watcherMinNonSdSeekingCount || 0));
      if (threshold <= 0 || !state || typeof state !== 'object') return { updated: false, counts: {} };
      const parsedCounts = normalizedParsedCounts(parsed);
      const selected = selectedPublisherSlugs(urls);
      const counts = {};
      for (const slug of selected) {
        if (Object.prototype.hasOwnProperty.call(parsedCounts, slug)) counts[slug] = parsedCounts[slug];
      }
      if (!Object.keys(counts).length) return { updated: false, counts: {} };
      state.publisherSeekingCountCache = {
        updatedAt: new Date(now).toISOString(),
        selectedSignature: selected.join(','),
        counts
      };
      return { updated: true, counts };
    }

    function filterConfiguredUrls(urls, state, opts = {}, now = Date.now()) {
      const configured = Array.isArray(urls) ? urls.slice() : [];
      const threshold = Math.max(0, Number(opts.watcherMinNonSdSeekingCount || 0));
      if (threshold <= 0) {
        return { eligible: configured, excluded: [], enabled: false, cacheFresh: false };
      }
      const cacheFresh = cacheIsFresh(state, configured, opts, now);
      const counts = state?.publisherSeekingCountCache?.counts || {};
      const eligible = [];
      const excluded = [];
      for (const url of configured) {
        const slug = publisherSlugFromUrl(url);
        if (!slug || isScienceDirectSlug(slug)) {
          eligible.push(url);
          continue;
        }
        const count = Number(counts[slug]);
        if (cacheFresh && Number.isFinite(count) && count < threshold) {
          excluded.push({ url, publisher: slug, count, threshold });
        } else {
          eligible.push(url);
        }
      }
      return { eligible, excluded, enabled: true, cacheFresh };
    }

    function publisherCountProbeUrl(url) {
      try {
        const parsed = new URL(String(url || ''));
        parsed.searchParams.delete('page_min');
        parsed.searchParams.delete('page_max');
        parsed.searchParams.delete('order');
        parsed.searchParams.delete('page_order');
        parsed.searchParams.set('page', '1');
        return parsed.href;
      } catch (_) {
        return String(url || '');
      }
    }

    async function preparePublisherPool({
      urls,
      state,
      opts,
      parseListUrl,
      saveState,
      appendTrace,
      trigger,
      runId,
      publisherFromUrl
    } = {}) {
      const configured = Array.isArray(urls) ? urls.slice() : [];
      const threshold = Math.max(0, Number(opts?.watcherMinNonSdSeekingCount || 0));
      if (threshold <= 0 || !configured.length) {
        return filterConfiguredUrls(configured, state, opts);
      }
      if (!cacheIsFresh(state, configured, opts)) {
        const probeSource = configured[Math.floor(Math.random() * configured.length)];
        const probeUrl = publisherCountProbeUrl(probeSource);
        try {
          const parsed = await parseListUrl(probeUrl, {
            trigger,
            publisher: typeof publisherFromUrl === 'function' ? publisherFromUrl(probeSource) : publisherSlugFromUrl(probeSource),
            pickedPage: 1
          });
          const update = !parsed?.isErrorPage && !parsed?.cfChallenge
            ? updateCacheFromParsed(state, parsed, configured, opts)
            : { updated: false, counts: {} };
          if (update.updated && typeof saveState === 'function') await saveState(state);
          await appendTrace?.('publisher_count_cache_refresh', {
            reason: update.updated ? 'publisher_counts_refreshed' : 'publisher_counts_unavailable',
            phase: 'single_random_run',
            trigger,
            runId,
            probeUrl,
            selectedUrlCount: configured.length,
            trackedPublisherCount: Object.keys(update.counts || {}).length,
            threshold
          });
        } catch (err) {
          await appendTrace?.('publisher_count_cache_refresh', {
            reason: 'publisher_count_refresh_failed',
            phase: 'single_random_run',
            trigger,
            runId,
            probeUrl,
            selectedUrlCount: configured.length,
            threshold,
            error: err?.message || String(err)
          });
        }
      }
      return filterConfiguredUrls(configured, state, opts);
    }

    async function refreshCacheFromParsedIfDue({ state, parsed, urls, opts, saveState } = {}) {
      if (cacheIsFresh(state, urls, opts)) return false;
      const update = updateCacheFromParsed(state, parsed, urls, opts);
      if (!update.updated) return false;
      if (typeof saveState === 'function') await saveState(state);
      return true;
    }

    return {
      publisherSlugFromUrl,
      cacheIsFresh,
      updateCacheFromParsed,
      filterConfiguredUrls,
      publisherCountProbeUrl,
      preparePublisherPool,
      refreshCacheFromParsedIfDue
    };
  }

  globalThis.AblesciWatcherPublisherCountsModule = {
    createWatcherPublisherCountsApi
  };
})();
