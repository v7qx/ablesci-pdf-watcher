'use strict';

(function () {
  const config = globalThis.AblesciWatcherConfig || {};
  const clampNumber = typeof config.clampNumber === 'function'
    ? config.clampNumber
    : ((value, fallback, min, max) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
      });

  function formatBeijingDateTime(value, dateOnly = false) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return String(value || '');
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
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
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    if (dateOnly) return day;
    return `${day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function formatBeijingTimeOnly(value) {
    const full = formatBeijingDateTime(value);
    const match = String(full).match(/\s(\d{2}:\d{2}:\d{2})$/);
    return match ? match[1] : full;
  }

  function formatBeijingDateOnly(value) {
    return formatBeijingDateTime(value, true);
  }

  function looksLikeIsoDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
  }

  function looksLikeTimestampMs(value) {
    return Number.isFinite(Number(value)) && Number(value) > 1600000000000 && Number(value) < 4100000000000;
  }

  function reportValueForJson(value, key = '') {
    if (looksLikeIsoDate(value)) return formatBeijingDateTime(value);
    if (/at$|time|until|scheduled/i.test(String(key || '')) && looksLikeTimestampMs(value)) {
      return formatBeijingDateTime(Number(value));
    }
    if (Array.isArray(value)) return value.map(item => reportValueForJson(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reportValueForJson(v, k)]));
    }
    return value;
  }

  function reportJson(value) {
    return JSON.stringify(reportValueForJson(value || {}));
  }

  function countdownText(value, now = Date.now()) {
    const t = value ? new Date(value).getTime() : 0;
    if (!Number.isFinite(t) || t <= 0) return '';
    const seconds = Math.max(0, Math.round((t - now) / 1000));
    if (seconds <= 0) return 'due';
    const minutes = Math.floor(seconds / 60);
    const sec = seconds % 60;
    if (minutes < 60) return `${minutes}m${String(sec).padStart(2, '0')}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
  }

  function todayKey() {
    return formatBeijingDateTime(new Date(), true);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeListUrls(value, fallback) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
    const urls = raw
      .map(s => String(s || '').trim())
      .filter(Boolean)
      .filter(url => {
        try {
          const u = new URL(url);
          return u.protocol === 'https:' && /(^|\.)ablesci\.com$/i.test(u.hostname);
        } catch (_) {
          return false;
        }
      });
    return urls.length ? urls : fallback.slice();
  }

  function randomIntInclusive(min, max) {
    const low = Math.ceil(min);
    const high = Math.floor(max);
    return Math.floor(Math.random() * (high - low + 1)) + low;
  }

  function clampInt(value, min, max) {
    return Math.min(max, Math.max(min, Math.round(Number(value) || min)));
  }

  function getListUrlKey(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('page');
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  function pageRangeMetaFromUrl(url) {
    try {
      const u = new URL(url);
      const isAblesci = /(^|\.)ablesci\.com$/i.test(u.hostname);
      const isAssistList = /\/assist\/index$/i.test(u.pathname);
      if (!isAblesci || !isAssistList || u.searchParams.get('status') !== 'waiting') {
        return null;
      }
      const publisher = String(u.searchParams.get('publisher') || '').toLowerCase();

      const customMinRaw = u.searchParams.get('page_min');
      const customMaxRaw = u.searchParams.get('page_max');
      // page_min：只要参数存在就视为已设置，空值默认 page 1
      const hasExplicitPageMin = customMinRaw !== null;
      // page_max：参数存在且有非空值才算已设置，空值触发自动检测最大页码
      const hasExplicitPageMax = customMaxRaw !== null && customMaxRaw !== '';

      // Neither page_min nor page_max → use URL as-is (no random page).
      if (!hasExplicitPageMin && !hasExplicitPageMax) return null;

      let pageMin = 1;
      let pageMax = Number.MAX_SAFE_INTEGER; // sentinel: real max from pagination
      const needsMaxDetection = !hasExplicitPageMax;

      if (hasExplicitPageMin) {
        const parsedMin = parseInt(customMinRaw, 10);
        pageMin = clampInt(Number.isInteger(parsedMin) ? parsedMin : 1, 1, 9999);
      }
      if (hasExplicitPageMax) {
        const parsedMax = parseInt(customMaxRaw, 10);
        pageMax = clampInt(Number.isInteger(parsedMax) ? parsedMax : pageMin, pageMin, 9999);
      }

      return {
        publisher: publisher || 'custom',
        pageMin,
        pageMax,
        needsMaxDetection,
        hasExplicitPageMin,
        hasExplicitPageMax
      };
    } catch (_) {
      return null;
    }
  }

  function randomizeAssistListUrlWithMeta(url, knownMaxPage = null) {
    const meta = {
      configuredUrl: url,
      pickedListUrl: url,
      publisher: '',
      pickedPage: '',
      pageCurve: '',
      pageMin: '',
      pageMax: '',
      frontHit: false,
      alpha: '',
      pageOrder: 'random',
      urlKey: '',
      hasExplicitPageMin: false,
      hasExplicitPageMax: false
    };
    try {
      const u = new URL(url);
      const pageMeta = pageRangeMetaFromUrl(url);
      if (!pageMeta) return meta;

      const urlKey = getListUrlKey(url);
      meta.urlKey = urlKey;
      meta.pageOrder = 'random';
      meta.hasExplicitPageMin = pageMeta.hasExplicitPageMin === true;
      meta.hasExplicitPageMax = pageMeta.hasExplicitPageMax === true;

      // Resolve max page: explicit page_max wins. When page_max must be detected
      // from pagination but detection failed (knownMaxPage == null), fall back to
      // pageMin instead of the MAX_SAFE_INTEGER sentinel — otherwise the random
      // page would be an astronomical number and the whole run scans empty pages.
      const effectiveMax = pageMeta.needsMaxDetection
        ? (knownMaxPage !== null
            ? clampInt(knownMaxPage, pageMeta.pageMin, pageMeta.pageMax)
            : pageMeta.pageMin)
        : pageMeta.pageMax;
      const effectiveMin = pageMeta.pageMin;
      const pickedPage = effectiveMax > effectiveMin
        ? randomIntInclusive(effectiveMin, effectiveMax)
        : effectiveMin;

      u.searchParams.set('page', String(pickedPage));
      u.searchParams.delete('order');
      u.searchParams.delete('page_order');
      u.searchParams.delete('page_min');
      u.searchParams.delete('page_max');

      return {
        ...meta,
        pickedPage,
        pageCurve: 'uniform',
        pageMin: effectiveMin,
        pageMax: effectiveMax,
        publisher: pageMeta.publisher,
        pickedListUrl: u.toString()
      };
    } catch (_) {
      return meta;
    }
  }

  function randomizeAssistListUrl(url) {
    return randomizeAssistListUrlWithMeta(url).pickedListUrl;
  }

  function listUrlsForRun(opts) {
    const urls = Array.isArray(opts.watcherListUrls) ? opts.watcherListUrls.slice() : [];
    function shuffle(items) {
      const copy = items.slice();
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    }
    if (urls.length <= 1) return urls;

    return shuffle(urls);
  }

  globalThis.AblesciAutoWatcherUtils = {
    formatBeijingDateTime,
    formatBeijingTimeOnly,
    formatBeijingDateOnly,
    looksLikeIsoDate,
    looksLikeTimestampMs,
    reportValueForJson,
    reportJson,
    countdownText,
    todayKey,
    normalizeText,
    normalizeListUrls,
    randomIntInclusive,
    clampInt,
    getListUrlKey,
    pageRangeMetaFromUrl,
    randomizeAssistListUrlWithMeta,
    randomizeAssistListUrl,
    listUrlsForRun
  };
})();
