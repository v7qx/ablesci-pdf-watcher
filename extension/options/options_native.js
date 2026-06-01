'use strict';

(function () {
  function createOptionsNativeApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      el,
      showPill
    } = deps;

    function nativeFailureHelp(message) {
      const text = String(message || '');
      if (/native messaging host|communicating with the native messaging host|specified native messaging host not found/i.test(text)) {
        return '失败：未连上 Native Helper。先确认已运行 install_host.ps1；如这台电脑拦截本地 EXE，上传会受影响，但浏览器提醒仍可单独使用。';
      }
      return '失败：' + text;
    }

    function nativeConfigMessage(action, extra = {}) {
      const hostName = el('nativeHostName')?.value.trim() || defaultOptions.nativeHostName;
      return new Promise(resolve => {
        chromeApi.runtime.sendNativeMessage(hostName, { action, ...extra }, response => {
          const lastErr = chromeApi.runtime.lastError;
          if (lastErr) return resolve({ ok: false, error: lastErr.message });
          resolve(response || { ok: false, error: 'Native Helper 没有返回内容' });
        });
      });
    }

    // PRIVATE_WATCHER_ONLY
    async function openLocalStorageDir() {
      const hostNode = el('nativeHostName');
      const previousHost = hostNode?.value;
      if (hostNode) hostNode.value = hostNode.value.trim() || defaultOptions.nativeHostName;
      const extensionId = chromeApi.runtime.id;
      const res = await nativeConfigMessage('open_local_storage', { extra: { extension_id: extensionId } });
      if (hostNode && previousHost !== undefined) hostNode.value = previousHost;
      showPill('nativeStatus', res.ok ? '已打开本地目录' : '打开失败：' + (res.error || '未知错误'), !res.ok);
    }

    return {
      nativeFailureHelp,
      nativeConfigMessage,
      // PRIVATE_WATCHER_ONLY
      openLocalStorageDir
    };
  }

  globalThis.AblesciOptionsNative = {
    createOptionsNativeApi
  };
})();
