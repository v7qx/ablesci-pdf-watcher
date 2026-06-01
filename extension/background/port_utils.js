'use strict';

(function () {
  function createBackgroundPortUtilsApi() {
    function post(port, type, message, extra = {}) {
      try {
        port.postMessage({ type, message, ...extra });
      } catch (e) {
        const text = String(e?.message || e || '');
        if (/disconnected port object/i.test(text)) return;
        console.error(e);
      }
    }

    function makeAbortError(reason) {
      return new Error(reason || '任务已取消');
    }

    function abortReason(signal, fallback = '任务已取消') {
      if (!signal) return fallback;
      const r = signal.reason;
      if (!r) return fallback;
      if (r instanceof Error) return r.message || fallback;
      return String(r);
    }

    function throwIfAborted(signal) {
      if (signal && signal.aborted) throw makeAbortError(abortReason(signal));
    }

    return {
      post,
      makeAbortError,
      abortReason,
      throwIfAborted
    };
  }

  globalThis.AblesciBackgroundPortUtils = {
    createBackgroundPortUtilsApi
  };
})();
