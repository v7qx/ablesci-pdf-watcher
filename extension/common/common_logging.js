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
    return {
      assistId: normalizeText(value.assistId || '').slice(0, 80),
      title: normalizeText(value.title || '').slice(0, 160),
      doi: normalizeText(value.doi || '').slice(0, 120),
      journal: normalizeText(value.journalName || value.journalShortName || '').slice(0, 160),
      reason: normalizeText(value.reason || '').slice(0, 120),
      pickedPage: value.pickedPage ?? value.page ?? '',
      pageOrder: normalizeText(value.pageOrder || '').slice(0, 40),
      pageMax: value.pageMax ?? value.maxPage ?? '',
      candidateCount: value.candidateCount ?? '',
      parsedCount: value.parsedCount ?? '',
      queueableCount: value.queueableCount ?? '',
      rowCount: value.rowCount ?? '',
      detailLinkCount: value.detailLinkCount ?? '',
      assistIdCount: value.assistIdCount ?? '',
      bodyLength: value.bodyLength ?? '',
      emptyListLike: value.emptyListLike ?? '',
      cfChallenge: value.cfChallenge ?? '',
      loginLike: value.loginLike ?? '',
      elapsedMs: value.elapsedMs ?? ''
    };
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
