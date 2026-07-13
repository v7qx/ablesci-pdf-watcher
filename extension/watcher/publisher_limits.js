'use strict';

(function initWatcherPublisherLimits(globalThis) {
  function publisherFromListUrl(url) {
    try {
      return String(new URL(url).searchParams.get('publisher') || '').trim().toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function activePublisherStops(state = {}, now = Date.now()) {
    const stops = state.publisherDailyLimitStops;
    if (!stops || typeof stops !== 'object' || Array.isArray(stops)) return {};
    return Object.fromEntries(Object.entries(stops).filter(([, stop]) => {
      const expiresAt = Number(stop?.expiresAt || 0);
      return Number.isFinite(expiresAt) && expiresAt > now;
    }));
  }

  function pruneExpiredPublisherStops(state = {}, now = Date.now()) {
    const stops = state.publisherDailyLimitStops;
    if (!stops || typeof stops !== 'object' || Array.isArray(stops)) return false;
    let changed = false;
    for (const [publisher, stop] of Object.entries(stops)) {
      const expiresAt = Number(stop?.expiresAt || 0);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        delete stops[publisher];
        changed = true;
      }
    }
    return changed;
  }

  function isPublisherStopped(state, publisher, now = Date.now()) {
    const key = String(publisher || '').trim().toLowerCase();
    if (!key) return false;
    return Object.prototype.hasOwnProperty.call(activePublisherStops(state, now), key);
  }

  function filterStoppedPublisherUrls(urls = [], state = {}, now = Date.now()) {
    const stopped = activePublisherStops(state, now);
    return urls.filter(url => {
      const publisher = publisherFromListUrl(url);
      return !publisher || !stopped[publisher];
    });
  }

  function resumeAtForPublisher(state, publisher, now = Date.now()) {
    const key = String(publisher || '').trim().toLowerCase();
    const stop = activePublisherStops(state, now)[key];
    return stop ? Number(stop.expiresAt || 0) : 0;
  }

  globalThis.AblesciWatcherPublisherLimits = {
    publisherFromListUrl,
    activePublisherStops,
    pruneExpiredPublisherStops,
    isPublisherStopped,
    filterStoppedPublisherUrls,
    resumeAtForPublisher
  };
})(globalThis);
