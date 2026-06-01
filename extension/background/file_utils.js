'use strict';

(function () {
  function createBackgroundFileUtilsApi(deps = {}) {
    const {
      normalizeSizeUnit,
      sanitizePathPart,
      redactLocalPaths,
      htmlDownloadMessage,
      defaultOptions
    } = deps;

    function formatBytes(size) {
      const value = Number(size || 0);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 2 : 1)} MB`;
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    function formatConfiguredSize(value, unit) {
      const n = Number(value);
      const normalizedUnit = normalizeSizeUnit(unit);
      if (!Number.isFinite(n) || n < 0) return `0 ${normalizedUnit}`;
      const digits = normalizedUnit === 'KB' ? 0 : (Number.isInteger(n) ? 0 : 1);
      return `${n.toFixed(digits)} ${normalizedUnit}`;
    }

    function sanitizeFilename(s) {
      const value = String(s || 'paper.pdf')
        .replace(/[\\/:*?"<>|]+/g, '_')
        .replace(/\s+/g, ' ')
        .trim();
      return /\.pdf$/i.test(value) ? value : `${value || 'paper'}.pdf`;
    }

    function makeDownloadFilename(subdir, filename) {
      const cleanFile = sanitizeFilename(filename);
      const cleanDir = sanitizePathPart(subdir || '');
      if (!cleanDir) return cleanFile;
      return cleanDir.replace(/\/+$/g, '') + '/' + cleanFile;
    }

    function basenameOf(path) {
      const s = String(path || '').replace(/\\/g, '/');
      return s.split('/').filter(Boolean).pop() || '';
    }

    function extensionOf(path) {
      const base = basenameOf(path).toLowerCase();
      const m = base.match(/\.([a-z0-9]{1,8})$/i);
      return m ? '.' + m[1] : '';
    }

    function sizeToBytes(value, unit, fallback, fallbackUnit = 'MB') {
      const n = Number(value);
      const size = Number.isFinite(n) && n >= 0 ? n : fallback;
      const normalizedUnit = normalizeSizeUnit(unit || fallbackUnit);
      const factor = normalizedUnit === 'KB' ? 1024 : 1024 * 1024;
      return Math.round(size * factor);
    }

    function formatTaskError(err) {
      const raw = redactLocalPaths(err && err.message ? err.message : String(err || '未知错误'));
      if (raw.includes(htmlDownloadMessage)) return htmlDownloadMessage;
      if (/file header is not %PDF-|likely html\/login\/error page/i.test(raw)) {
        return htmlDownloadMessage + '\n\n原始错误：' + raw;
      }
      return raw;
    }

    function stripHtml(s) {
      return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function escapeHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    return {
      formatBytes,
      formatConfiguredSize,
      sanitizeFilename,
      makeDownloadFilename,
      basenameOf,
      extensionOf,
      sizeToBytes,
      formatTaskError,
      stripHtml,
      escapeHtml
    };
  }

  globalThis.AblesciBackgroundFileUtils = {
    createBackgroundFileUtilsApi
  };
})();
