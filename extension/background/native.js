'use strict';

(function () {
  function createBackgroundNativeApi(deps = {}) {
    const {
      chromeApi,
      defaultTimeoutMs
    } = deps;

    function perfDateKey(date = new Date()) {
      return date.toISOString().slice(0, 10);
    }

    function compactPerfError(err) {
      return String(err?.message || err || '').replace(/\s+/g, ' ').slice(0, 240);
    }

    function basenameOf(value) {
      const text = String(value || '').trim();
      if (!text) return '';
      const parts = text.split(/[\\/]+/);
      return parts[parts.length - 1] || '';
    }

    function extensionOf(value) {
      const base = basenameOf(value);
      const idx = base.lastIndexOf('.');
      return idx >= 0 ? base.slice(idx).toLowerCase() : '';
    }

    function nativePerfMeta(message = {}) {
      const extra = message.extra || {};
      const action = message.action || 'native_message';
      const targetName = basenameOf(message.filename || message.path || '');
      const explicitCategory = String(extra.perf_category || '').trim();
      let category = explicitCategory;
      if (!category) {
        if (action === 'clean_pdf') category = 'pdf_cleaner';
        else if (action === 'stat_pdf') category = 'pdf_stat';
        else if (action === 'upload_oss') category = 'oss_upload';
        else if (action === 'delete_file') category = 'delete_file';
        else if (action === 'read_text_file') category = targetName ? `read:${targetName}` : 'read_text_file';
        else if (action === 'write_text_file') {
          if (String(message.filename || '').startsWith('performance/')) category = 'perf_jsonl';
          else if (extensionOf(message.filename) === '.csv') category = 'daily_report_csv';
          else if (extensionOf(message.filename) === '.md') category = 'daily_report_md';
          else category = targetName ? `write:${targetName}` : 'write_text_file';
        } else {
          category = action;
        }
      }
      const meta = {
        action,
        category,
        targetName,
        fileExt: extensionOf(message.filename || message.path || '')
      };
      if (typeof message.content === 'string') meta.contentBytes = message.content.length;
      if (action === 'clean_pdf') {
        meta.cleaner = basenameOf(extra.cleaner_path || '') || 'default';
        meta.engine = extra.engine || 'default';
        meta.timeoutSeconds = extra.timeout_seconds || '';
        meta.preserveOriginal = extra.preserve_original || '';
        meta.patternsName = basenameOf(extra.patterns_path || '');
      }
      return meta;
    }

    function nativeResponsePerfMeta(response = {}) {
      const meta = {
        status: response.status || '',
        responseAction: response.action || '',
        size: response.size || ''
      };
      if (typeof response.body === 'string') meta.bodyBytes = response.body.length;
      if (response.clean_status) {
        meta.cleanStatus = response.clean_status || '';
        meta.cleanEngine = response.clean_engine || '';
        meta.cleanElapsedMs = response.clean_elapsed_ms || '';
        meta.cleanMatched = response.clean_matched ?? '';
        meta.cleanErrorCode = response.clean_error_code || '';
      }
      return meta;
    }

    async function recordNativePerformance(hostName, message, entry) {
      // Kept for local debugging only. The option UI is hidden and normalized to
      // false; avoid honoring stale storage values from earlier debug sessions.
      return;
      try {
        const action = message?.action || 'native_message';
        if (action === 'append_text_file') return;
        const stored = await chromeApi.storage.local.get({
          watcherPerfTraceEnabled: false,
          watcherPerfFileEnabled: false,
          watcherReportDir: '',
          autoWatcherTraceLogs: []
        });
        const traceEntry = {
          time: new Date().toISOString(),
          step: 'perf_native_message',
          reason: entry.ok ? 'native_message_ok' : 'native_message_failed',
          trigger: '',
          sessionId: '',
          tabId: '',
          url: '',
          urlHostPath: null,
          details: entry
        };
        if (stored.watcherPerfTraceEnabled === true) {
          const traceLogs = Array.isArray(stored.autoWatcherTraceLogs) ? stored.autoWatcherTraceLogs : [];
          await chromeApi.storage.local.set({
            autoWatcherTraceLogs: [traceEntry].concat(traceLogs).slice(0, 300)
          }).catch(() => {});
        }
        if (stored.watcherPerfFileEnabled !== true) return;
        const line = `${JSON.stringify({
          time: traceEntry.time,
          hostName,
          ...entry
        })}\n`;
        chromeApi.runtime.sendNativeMessage(hostName, {
          action: 'append_text_file',
          dir: String(stored.watcherReportDir || ''),
          filename: `performance/native-${perfDateKey()}.jsonl`,
          content: line
        }, () => {
          void chromeApi.runtime.lastError;
        });
      } catch (_) {}
    }

    function sendNativeMessage(hostName, message, timeoutMs = defaultTimeoutMs) {
      return new Promise((resolve, reject) => {
        const action = message?.action || 'native_message';
        const timeout = Math.max(1000, Number(timeoutMs || defaultTimeoutMs));
        const startedAt = Date.now();
        const perfMeta = nativePerfMeta(message);
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const err = new Error(`Native Helper ${action} 超时（${Math.round(timeout / 1000)} 秒）`);
          recordNativePerformance(hostName, message, {
            ...perfMeta,
            ok: false,
            durationMs: Date.now() - startedAt,
            timeoutMs: timeout,
            error: compactPerfError(err)
          });
          reject(err);
        }, timeout);

        chromeApi.runtime.sendNativeMessage(hostName, message, response => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastErr = chromeApi.runtime.lastError;
          if (lastErr) {
            const err = new Error(lastErr.message);
            recordNativePerformance(hostName, message, {
              ...perfMeta,
              ok: false,
              durationMs: Date.now() - startedAt,
              timeoutMs: timeout,
              error: compactPerfError(err)
            });
            return reject(err);
          }
          if (!response) {
            const err = new Error('Native Helper 没有返回内容');
            recordNativePerformance(hostName, message, {
              ...perfMeta,
              ok: false,
              durationMs: Date.now() - startedAt,
              timeoutMs: timeout,
              error: compactPerfError(err)
            });
            return reject(err);
          }
          if (!response.ok) {
            const err = new Error(response.error || 'Native Helper 返回失败');
            recordNativePerformance(hostName, message, {
              ...perfMeta,
              ok: false,
              durationMs: Date.now() - startedAt,
              timeoutMs: timeout,
              ...nativeResponsePerfMeta(response),
              error: compactPerfError(err)
            });
            return reject(err);
          }
          recordNativePerformance(hostName, message, {
            ...perfMeta,
            ok: true,
            durationMs: Date.now() - startedAt,
            timeoutMs: timeout,
            ...nativeResponsePerfMeta(response)
          });
          resolve(response);
        });
      });
    }

    return { sendNativeMessage };
  }

  globalThis.AblesciBackgroundNative = {
    createBackgroundNativeApi
  };
})();
