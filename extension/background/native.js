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

    async function recordNativePerformance(hostName, message, entry) {
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
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const err = new Error(`Native Helper ${action} 超时（${Math.round(timeout / 1000)} 秒）`);
          recordNativePerformance(hostName, message, {
            action,
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
              action,
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
              action,
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
              action,
              ok: false,
              durationMs: Date.now() - startedAt,
              timeoutMs: timeout,
              status: response.status || '',
              responseAction: response.action || '',
              error: compactPerfError(err)
            });
            return reject(err);
          }
          recordNativePerformance(hostName, message, {
            action,
            ok: true,
            durationMs: Date.now() - startedAt,
            timeoutMs: timeout,
            status: response.status || '',
            responseAction: response.action || '',
            size: response.size || ''
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
