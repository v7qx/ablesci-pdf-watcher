'use strict';

(function () {
  function hostnameOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  function urlHostPath(url) {
    try {
      const u = new URL(url || '');
      return { host: u.hostname.toLowerCase(), path: u.pathname || '/' };
    } catch (_) {
      return { host: '', path: '' };
    }
  }

  function maskId(value) {
    const s = String(value || '');
    if (!s) return '';
    if (s.length <= 4) return '***';
    return '***' + s.slice(-4);
  }

  function redactLocalPaths(text) {
    return String(text || '')
      .replace(/[a-zA-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*([^\\/:*?"<>|\r\n]+)/g, '<local>\\$1')
      .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^/\s"']+)*\/([^/\s"']+)/g, '<local>/$1');
  }

  function compactTraceCandidate(value, normalizeText) {
    if (!value || typeof value !== 'object') return null;
    const hasCandidateShape = value.assistId || value.title || value.doi || value.journalName || value.journalShortName || value.reason;
    if (!hasCandidateShape) return null;
    const compact = {};
    const setText = (key, raw, limit) => {
      const text = normalizeText(raw || '').slice(0, limit);
      if (text) compact[key] = text;
    };
    const setValue = (key, raw) => {
      if (raw !== undefined && raw !== null && raw !== '') compact[key] = raw;
    };

    setText('assistId', value.assistId, 80);
    setText('title', value.title, 160);
    setText('doi', value.doi, 120);
    setText('journal', value.journalName || value.journalShortName, 160);
    setText('reason', value.reason, 120);
    setValue('pickedPage', value.pickedPage ?? value.page);
    setText('pageOrder', value.pageOrder, 40);
    setValue('pageMax', value.pageMax ?? value.maxPage);
    for (const key of [
      'candidateCount',
      'parsedCount',
      'queueableCount',
      'rowCount',
      'detailLinkCount',
      'assistIdCount',
      'bodyLength',
      'emptyListLike',
      'cfChallenge',
      'loginLike',
      'elapsedMs',
      'durationMs',
      'totalMs',
      'fetchHeadersMs',
      'readTextMs',
      'parseMs',
      'totalParseMs',
      'stripBodyMs',
      'titleMs',
      'extractItemsMs',
      'mapCandidatesMs',
      'extractStatsMs',
      'normalizeMs',
      'initPageDataMs',
      'sourceGateMs',
      'orderMs',
      'listFilterMs',
      'filterLoopMs',
      'appendSummaryMs',
      'sinceRunStartMs',
      'sinceListParseStartMs',
      'sinceListParseDoneMs',
      'orderedCount',
      'skippedCount',
      'journalBlockedCount',
      'skippedStateWrites'
    ]) {
      setValue(key, value[key]);
    }
    if (value.reasonCounts && typeof value.reasonCounts === 'object' && !Array.isArray(value.reasonCounts)) {
      const reasonCounts = Object.fromEntries(Object.entries(value.reasonCounts)
        .filter(([, count]) => count !== undefined && count !== null && count !== '' && Number(count) !== 0)
        .slice(0, 12));
      if (Object.keys(reasonCounts).length > 0) compact.reasonCounts = reasonCounts;
    }
    return compact;
  }

  function sanitizeTraceUrl(value, traceLevel, helpers = {}) {
    if (traceLevel === 'verbose' && typeof helpers.sanitizeFullUrl === 'function') {
      return helpers.sanitizeFullUrl(value);
    }
    try {
      const parsed = typeof helpers.urlHostPath === 'function'
        ? helpers.urlHostPath(value || '')
        : urlHostPath(value || '');
      if (parsed && (parsed.host || parsed.path)) return parsed;
    } catch (_) {}
    return String(value || '').slice(0, 120);
  }

  function sanitizeTraceValue(value, depth = 0, traceLevel = 'normal', helpers = {}) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      const text = value.length > 500 ? value.slice(0, 500) + '...' : value;
      if (/^https?:\/\//i.test(text)) return sanitizeTraceUrl(text, traceLevel, helpers);
      return text;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      if (traceLevel !== 'verbose' && value.length > 5) return `[array:${value.length}]`;
      if (depth >= 2) return `[array:${value.length}]`;
      return value.slice(0, traceLevel === 'verbose' ? 20 : 5)
        .map(item => sanitizeTraceValue(item, depth + 1, traceLevel, helpers));
    }
    if (typeof value === 'object') {
      if (traceLevel !== 'verbose' && typeof helpers.normalizeText === 'function') {
        const compact = compactTraceCandidate(value, helpers.normalizeText);
        if (compact) return compact;
      }
      if (depth >= 2) return '[object]';
      const output = {};
      const maxEntries = traceLevel === 'verbose' ? 30 : 18;
      for (const [key, item] of Object.entries(value).slice(0, maxEntries)) {
        if (/token|cookie|csrf|signature|credential|secret|auth|password/i.test(key)) {
          output[key] = '<redacted>';
        } else if (/url$/i.test(key) || key === 'url' || key === 'detailUrl' || key === 'listUrl') {
          output[key] = sanitizeTraceUrl(item, traceLevel, helpers);
        } else {
          output[key] = sanitizeTraceValue(item, depth + 1, traceLevel, helpers);
        }
      }
      return output;
    }
    return String(value);
  }

  class Logger {
    constructor(prefix = '[Ablesci PDF Watcher]') {
      this.prefix = prefix;
    }

    format(args) {
      const helpers = {
        normalizeText: (s) => String(s || '').replace(/\s+/g, ' ').trim()
      };
      return args.map(arg => {
        if (typeof arg === 'string') {
          return redactLocalPaths(arg);
        }
        if (arg instanceof Error) {
          return redactLocalPaths(arg.stack || arg.message || String(arg));
        }
        if (typeof arg === 'object' && arg !== null) {
          try {
            return sanitizeTraceValue(arg, 0, 'normal', helpers);
          } catch (_) {
            return arg;
          }
        }
        return arg;
      });
    }

    log(...args) {
      console.log(this.prefix, ...this.format(args));
    }

    warn(...args) {
      console.warn(this.prefix, ...this.format(args));
    }

    error(...args) {
      console.error(this.prefix, ...this.format(args));
    }

    debug(...args) {
      console.debug(this.prefix, ...this.format(args));
    }
  }

  const logger = new Logger();

  globalThis.AblesciWatcherLogging = {
    hostnameOf,
    urlHostPath,
    maskId,
    redactLocalPaths,
    compactTraceCandidate,
    sanitizeTraceUrl,
    sanitizeTraceValue,
    Logger,
    logger
  };
})();
