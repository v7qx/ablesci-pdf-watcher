(function initScienceDirectDownloadGuard(globalThis) {
  'use strict';

  const SITE_STORAGE_KEY = 'ARTICLE_DDM';
  const EXTENSION_STORAGE_KEY = 'scienceDirectDownloadGuardState';
  const SITE_SNAPSHOT_STORAGE_KEY = 'scienceDirectSiteCountSnapshot';
  const DAILY_LIMIT = 100;
  const LIMIT_DIALOG_SELECTOR = [
    '.download-cap-modal',
    '[aria-label="Download limit reached dialog"]'
  ].join(', ');
  const LIMIT_TEXT = /You have reached the daily bulk download limit/i;

  function dateKey(date = new Date()) {
    return `${date.getFullYear()}_${date.getMonth() + 1}_${date.getDate()}`;
  }

  function nextLocalDayAt(date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }

  function readSiteCount(storage, key) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      const parsed = JSON.parse(storage.getItem(SITE_STORAGE_KEY) || '{}');
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) return 0;
      const count = Number.parseInt(parsed[key], 10);
      return Number.isFinite(count) && count >= 0 ? count : null;
    } catch (_) {
      return null;
    }
  }

  function hasLimitDialog(documentRef) {
    if (!documentRef) return false;
    try {
      if (documentRef.querySelector?.(LIMIT_DIALOG_SELECTOR)) return true;
    } catch (_) {}
    return LIMIT_TEXT.test(String(documentRef.body?.innerText || documentRef.body?.textContent || ''));
  }

  async function readDirectState(storage, key) {
    if (!storage || typeof storage.get !== 'function') return { dateKey: key, directAttempts: 0, available: false };
    try {
      const stored = await storage.get(EXTENSION_STORAGE_KEY);
      const state = stored?.[EXTENSION_STORAGE_KEY];
      if (!state || state.dateKey !== key) return { dateKey: key, directAttempts: 0, available: true };
      const directAttempts = Number.parseInt(state.directAttempts, 10);
      return {
        dateKey: key,
        directAttempts: Number.isFinite(directAttempts) && directAttempts >= 0 ? directAttempts : 0,
        available: Number.isFinite(directAttempts) && directAttempts >= 0
      };
    } catch (_) {
      return { dateKey: key, directAttempts: 0, available: false };
    }
  }

  async function readSiteSnapshot(storage, key) {
    if (!storage || typeof storage.get !== 'function') return { dateKey: key, siteCount: 0, available: false };
    try {
      const stored = await storage.get(SITE_SNAPSHOT_STORAGE_KEY);
      const state = stored?.[SITE_SNAPSHOT_STORAGE_KEY];
      if (!state || state.dateKey !== key) return { dateKey: key, siteCount: 0, available: true };
      const siteCount = Number.parseInt(state.siteCount, 10);
      return {
        dateKey: key,
        siteCount: Number.isFinite(siteCount) && siteCount >= 0 ? siteCount : 0,
        available: Number.isFinite(siteCount) && siteCount >= 0
      };
    } catch (_) {
      return { dateKey: key, siteCount: 0, available: false };
    }
  }

  async function inspectDownloadSafety(options = {}) {
    const date = options.date || new Date();
    const key = dateKey(date);
    const observedSiteCount = readSiteCount(options.siteStorage || globalThis.localStorage, key);
    const directState = await readDirectState(options.extensionStorage, key);
    const siteSnapshot = await readSiteSnapshot(options.extensionStorage, key);
    const siteCount = observedSiteCount === null
      ? null
      : Math.max(observedSiteCount, siteSnapshot.siteCount);
    const directAttempts = directState.directAttempts;
    const effectiveCount = Math.max(0, siteCount ?? 0) + directAttempts;
    const modalDetected = hasLimitDialog(options.document || globalThis.document);
    const siteCounterUnavailable = siteCount === null;
    const directCounterUnavailable = directState.available === false || siteSnapshot.available === false;
    const blocked = modalDetected || siteCounterUnavailable || directCounterUnavailable || effectiveCount >= DAILY_LIMIT;
    return {
      blocked,
      modalDetected,
      siteCount,
      directAttempts,
      effectiveCount,
      limit: DAILY_LIMIT,
      dateKey: key,
      expiresAt: nextLocalDayAt(date),
      reason: modalDetected
        ? 'daily_bulk_download_limit_dialog'
        : (siteCounterUnavailable
            ? 'site_counter_unavailable'
            : (directCounterUnavailable
                ? 'direct_counter_unavailable'
                : (blocked ? 'daily_count_reached' : '')))
    };
  }

  async function reserveDirectAttempt(options = {}) {
    const result = await inspectDownloadSafety(options);
    if (result.blocked) return result;
    if (typeof options.reserveExtensionAttempt !== 'function') {
      return { ...result, blocked: true, reason: 'direct_counter_unavailable' };
    }
    try {
      const reserved = await options.reserveExtensionAttempt({
        attemptKind: 'direct',
        observedSiteCount: result.siteCount,
        dateKey: result.dateKey
      });
      return reserved?.blocked === false || reserved?.blocked === true
        ? reserved
        : { ...result, blocked: true, reason: 'direct_counter_unavailable' };
    } catch (_) {
      return { ...result, blocked: true, reason: 'direct_counter_unavailable' };
    }
  }

  async function reserveSiteClickAttempt(options = {}) {
    const result = await inspectDownloadSafety(options);
    if (result.blocked) return result;
    if (typeof options.reserveExtensionAttempt !== 'function') {
      return { ...result, blocked: true, reason: 'direct_counter_unavailable' };
    }
    try {
      const reserved = await options.reserveExtensionAttempt({
        attemptKind: 'site',
        observedSiteCount: result.siteCount,
        dateKey: result.dateKey
      });
      return reserved?.blocked === false || reserved?.blocked === true
        ? reserved
        : { ...result, blocked: true, reason: 'direct_counter_unavailable' };
    } catch (_) {
      return { ...result, blocked: true, reason: 'direct_counter_unavailable' };
    }
  }

  globalThis.AblesciScienceDirectDownloadGuard = {
    SITE_STORAGE_KEY,
    EXTENSION_STORAGE_KEY,
    SITE_SNAPSHOT_STORAGE_KEY,
    DAILY_LIMIT,
    dateKey,
    nextLocalDayAt,
    readSiteCount,
    hasLimitDialog,
    inspectDownloadSafety,
    reserveDirectAttempt,
    reserveSiteClickAttempt
  };
})(globalThis);
