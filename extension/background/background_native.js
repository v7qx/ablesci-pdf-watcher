'use strict';

(function () {
  function createBackgroundNativeApi(deps = {}) {
    const {
      chromeApi,
      defaultTimeoutMs
    } = deps;

    function sendNativeMessage(hostName, message, timeoutMs = defaultTimeoutMs) {
      return new Promise((resolve, reject) => {
        const action = message?.action || 'native_message';
        const timeout = Math.max(1000, Number(timeoutMs || defaultTimeoutMs));
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Native Helper ${action} 超时（${Math.round(timeout / 1000)} 秒）`));
        }, timeout);

        chromeApi.runtime.sendNativeMessage(hostName, message, response => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const lastErr = chromeApi.runtime.lastError;
          if (lastErr) return reject(new Error(lastErr.message));
          if (!response) return reject(new Error('Native Helper 没有返回内容'));
          if (!response.ok) return reject(new Error(response.error || 'Native Helper 返回失败'));
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
