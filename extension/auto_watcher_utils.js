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

  const ASSIST_RANDOM_PAGE_RANGES = {
    elsevier: {
      min: 3,
      max: 200,
      curve: 'mixed_backlog_power',
      frontProbability: 0.20,
      frontMin: 3,
      frontMax: 50,
      alpha: 1.2
    },
    rsc: { min: 1, max: 5 }
  };

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

  function pageRangeMetaFromUrl(url) {
    try {
      const u = new URL(url);
      const isAblesci = /(^|\.)ablesci\.com$/i.test(u.hostname);
      const isAssistList = /\/assist\/index$/i.test(u.pathname);
      if (!isAblesci || !isAssistList || u.searchParams.get('status') !== 'waiting') {
        return null;
      }
      const publisher = String(u.searchParams.get('publisher') || '').toLowerCase();

      // Respect explicit page_min / page_max from the URL, falling back to
      // the built-in publisher curve.
      const customMin = u.searchParams.get('page_min');
      const customMax = u.searchParams.get('page_max');
      if (customMin !== null || customMax !== null) {
        const min = clampInt(parseInt(customMin, 10) || 1, 1, 9999);
        const max = clampInt(parseInt(customMax, 10) || min, min, 9999);
        return { publisher: publisher || 'custom', range: { min, max, curve: 'uniform' } };
      }

      const range = ASSIST_RANDOM_PAGE_RANGES[publisher];
      if (!range) return null;
      return { publisher, range };
    } catch (_) {
      return null;
    }
  }

  function pickAssistPage(range) {
    const min = clampInt(range?.min ?? 1, 1, 9999);
    const max = clampInt(range?.max ?? min, min, 9999);
    const curve = String(range?.curve || 'uniform').trim().toLowerCase();
    if (max <= min) {
      return {
        pickedPage: min,
        pageCurve: curve || 'uniform',
        pageMin: min,
        pageMax: max,
        frontHit: false,
        alpha: ''
      };
    }
    if (curve !== 'mixed_backlog_power') {
      return {
        pickedPage: randomIntInclusive(min, max),
        pageCurve: 'uniform',
        pageMin: min,
        pageMax: max,
        frontHit: false,
        alpha: ''
      };
    }
    const frontProbability = clampNumber(range?.frontProbability, 0.20, 0, 1);
    const frontMin = clampInt(range?.frontMin ?? min, min, max);
    const frontMax = clampInt(range?.frontMax ?? frontMin, frontMin, max);
    const alpha = clampNumber(range?.alpha, 1.2, 0, 4);
    const frontHit = Math.random() < frontProbability;
    const pickedPage = frontHit
      ? randomIntInclusive(frontMin, frontMax)
      : clampInt(min + Math.round(Math.pow(Math.random(), 1 / (alpha + 1)) * (max - min)), min, max);
    return {
      pickedPage,
      pageCurve: 'mixed_backlog_power',
      pageMin: min,
      pageMax: max,
      frontHit,
      alpha
    };
  }

  function randomizeAssistListUrlWithMeta(url) {
    const meta = {
      configuredUrl: url,
      pickedListUrl: url,
      publisher: '',
      pickedPage: '',
      pageCurve: '',
      pageMin: '',
      pageMax: '',
      frontHit: false,
      alpha: ''
    };
    try {
      const u = new URL(url);
      const pageMeta = pageRangeMetaFromUrl(url);
      if (!pageMeta) return meta;
      const picked = pickAssistPage(pageMeta.range);
      u.searchParams.set('page', String(picked.pickedPage));
      return {
        ...meta,
        ...picked,
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
    for (let i = urls.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [urls[i], urls[j]] = [urls[j], urls[i]];
    }
    return urls;
  }

  globalThis.AblesciAutoWatcherUtils = {
    ASSIST_RANDOM_PAGE_RANGES,
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
    pageRangeMetaFromUrl,
    pickAssistPage,
    randomizeAssistListUrlWithMeta,
    randomizeAssistListUrl,
    listUrlsForRun
  };
})();
