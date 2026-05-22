'use strict';

(function () {
  function createOptionsNativeApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      parseJournalAccessRules,
      el,
      setText,
      showPill
    } = deps;

    function nativeFailureHelp(message) {
      const text = String(message || '');
      if (/native messaging host|communicating with the native messaging host|specified native messaging host not found/i.test(text)) {
        return '失败：未连上 Native Helper。先确认已运行 install_host.ps1；如这台电脑拦截本地 EXE，上传会受影响，但浏览器提醒仍可单独使用。';
      }
      return '失败：' + text;
    }

    function journalAccessSummary(raw) {
      const rules = parseJournalAccessRules(raw);
      return `blocked ${rules.blocked.length} / partial ${rules.partial.length} / allowed ${rules.allowed.length}`;
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

    async function readJournalAccessConfig() {
      return nativeConfigMessage('read_config_file', {
        dir: '',
        config_path: '',
        filename: 'journal-access.json'
      });
    }

    async function renderJournalAccessConfigStatus(opts = null, loadOptions = null) {
      const current = opts || (typeof loadOptions === 'function' ? await loadOptions() : null) || {};
      const cached = String(current.watcherJournalAccessRules || '').trim();
      setText('journalAccessCacheSummary', cached ? journalAccessSummary(cached) : '缓存为空');
      setText('journalAccessConfigSource', 'Native Helper 目录 / journal-access.json');
      const res = await readJournalAccessConfig();
      if (res.ok) {
        const rules = parseJournalAccessRules(res.body || '');
        const text = JSON.stringify(rules, null, 2);
        const hidden = el('watcherJournalAccessRules');
        if (hidden) hidden.value = text;
        setText('journalAccessFileSummary', `${journalAccessSummary(text)}，已读取`);
        setText('journalAccessConfigSource', res.path || 'Native Helper 目录 / journal-access.json');
        showPill('journalAccessConfigStatus', '已加载文件');
        return;
      }
      setText('journalAccessFileSummary', `未读取文件，使用缓存：${cached ? journalAccessSummary(cached) : '空名单'}`);
      showPill('journalAccessConfigStatus', '使用缓存', false);
    }

    async function reloadJournalAccessConfig(save, loadOptions) {
      await save();
      const opts = await loadOptions();
      const res = await readJournalAccessConfig();
      if (!res.ok) {
        showPill('journalAccessConfigStatus', '读取失败：' + (res.error || '未找到文件'), true);
        return;
      }
      try {
        const parsed = parseJournalAccessRules(res.body || '');
        const text = JSON.stringify(parsed, null, 2);
        await chromeApi.storage.local.set({ watcherJournalAccessRules: text });
        const hidden = el('watcherJournalAccessRules');
        if (hidden) hidden.value = text;
        setText('journalAccessCacheSummary', journalAccessSummary(text));
        setText('journalAccessFileSummary', `${journalAccessSummary(text)}，已同步到缓存`);
        setText('journalAccessConfigSource', res.path || '');
        showPill('journalAccessConfigStatus', '已重载');
      } catch (err) {
        showPill('journalAccessConfigStatus', 'JSON 无效：' + (err?.message || String(err)), true);
      }
    }

    async function openConfigDir() {
      const hostNode = el('nativeHostName');
      const previousHost = hostNode?.value;
      if (hostNode) hostNode.value = hostNode.value.trim() || defaultOptions.nativeHostName;
      const res = await nativeConfigMessage('open_config_dir', { dir: '' });
      if (hostNode && previousHost !== undefined) hostNode.value = previousHost;
      showPill('journalAccessConfigStatus', res.ok ? '已打开目录' : '打开失败：' + (res.error || '未知错误'), !res.ok);
      if (res.ok && res.path) setText('journalAccessConfigSource', res.path);
    }

    return {
      nativeFailureHelp,
      journalAccessSummary,
      nativeConfigMessage,
      readJournalAccessConfig,
      renderJournalAccessConfigStatus,
      reloadJournalAccessConfig,
      openConfigDir
    };
  }

  globalThis.AblesciOptionsNative = {
    createOptionsNativeApi
  };
})();
