'use strict';

(function () {
  function createOptionsActionsApi(deps = {}) {
    const {
      chromeApi,
      el,
      defaultOptions,
      lastDiagnosticKey,
      autoWatcherStateKey,
      autoWatcherLogKey,
      autoWatcherTraceKey,
      loadOptions,
      watcherOptionSnapshot,
      todayKeyBeijing,
      nativeFailureHelp,
      showPill,
      setText,
      save,
      // PRIVATE_WATCHER_ONLY
      openLocalStorageDirFromNative
    } = deps;

    function showText(id, msg, isErr) {
      const node = el(id);
      const val = typeof globalThis.t === 'function' ? globalThis.t(msg) : msg;
      node.textContent = val;
      node.style.color = isErr ? 'var(--danger)' : 'var(--ok)';
      setTimeout(() => { node.textContent = ''; }, 7000);
    }

    function sendRuntimeMessage(message) {
      return new Promise(resolve => {
        chromeApi.runtime.sendMessage(message, response => {
          const lastErr = chromeApi.runtime.lastError;
          if (lastErr) return resolve({ ok: false, reason: lastErr.message });
          resolve(response || { ok: true });
        });
      });
    }

    function formatActionFailure(reason) {
      const text = String(reason || '未知错误');
      if (/native messaging host|communicating with the native messaging host|specified native messaging host not found/i.test(text)) {
        return nativeFailureHelp(text);
      }
      return '失败：' + text;
    }

    async function copyTextToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        const active = document.activeElement;
        const selection = window.getSelection();
        const savedRanges = [];
        if (selection) {
          for (let i = 0; i < selection.rangeCount; i += 1) savedRanges.push(selection.getRangeAt(i).cloneRange());
        }
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (selection) {
          selection.removeAllRanges();
          savedRanges.forEach(range => selection.addRange(range));
        }
        if (active && typeof active.focus === 'function') active.focus();
        return ok;
      }
    }

    function testNative() {
      const hostName = el('nativeHostName').value.trim() || defaultOptions.nativeHostName;
      const status = el('nativeStatus');
      status.classList.remove('ok', 'error');
      status.textContent = '测试中';
      chromeApi.runtime.sendNativeMessage(hostName, { action: 'ping' }, response => {
        const lastErr = chromeApi.runtime.lastError;
        if (lastErr) return showPill('nativeStatus', nativeFailureHelp(lastErr.message), true);
        if (!response || !response.ok) return showPill('nativeStatus', '返回异常', true);
        showPill('nativeStatus', '正常：' + response.action);
      });
    }

    async function copyDiagnostic() {
      const opts = await loadOptions();
      if (opts.diagnosticsEnabled !== true) {
        showPill('diagnosticStatus', '诊断未开启', true);
        return;
      }
      const stored = await chromeApi.storage.local.get(lastDiagnosticKey);
      const diagnostic = stored[lastDiagnosticKey];
      if (!diagnostic) {
        showPill('diagnosticStatus', '暂无信息', true);
        return;
      }

      const clean = JSON.parse(JSON.stringify(diagnostic, (key, value) => key === '_signature' ? undefined : value));
      const text = JSON.stringify(clean, null, 2);
      try {
        const ok = await copyTextToClipboard(text);
        if (!ok) throw new Error('copy_failed');
        showPill('diagnosticStatus', '已复制');
      } catch (_) {
        showPill('diagnosticStatus', '复制失败', true);
      }
    }

    // PRIVATE_WATCHER_ONLY
    async function openLocalStorageDir() {
      return openLocalStorageDirFromNative();
    }

    async function copyAutoWatcherConfig() {
      const opts = await loadOptions();
      const stored = await chromeApi.storage.local.get([
        autoWatcherStateKey,
        autoWatcherLogKey,
        autoWatcherTraceKey,
        lastDiagnosticKey
      ]);
      const logs = Array.isArray(stored[autoWatcherLogKey]) ? stored[autoWatcherLogKey] : [];
      const traceLogs = Array.isArray(stored[autoWatcherTraceKey]) ? stored[autoWatcherTraceKey] : [];
      const state = stored[autoWatcherStateKey] || {};
      const processed = state.processed || {};
      const diagnostic = stored[lastDiagnosticKey] || null;
      const manifest = chromeApi.runtime.getManifest();

      const payload = {
        exportedAt: new Date().toISOString(),
        extension: {
          name: manifest.name,
          version: manifest.version
        },
        watcherOptions: watcherOptionSnapshot(opts),
        watcherStateSummary: {
          processedCount: Object.keys(processed).length,
          today: state.daily?.[todayKeyBeijing()] || null,
          currentSchedulerMode: state.currentSchedulerMode || '',
          currentExecutionModel: state.currentExecutionModel || '',
          nextScheduledAt: state.nextScheduledAt ? new Date(state.nextScheduledAt).toISOString() : '',
          nextAssistRunAt: state.nextAssistRunAt || '',
          nextAssistStrategy: state.nextAssistStrategy || '',
          nextAssistReason: state.nextAssistReason || '',
          nextAssistDelayMinutes: state.nextAssistDelayMinutes || '',
          nextAssistModelDelayMinutes: state.nextAssistModelDelayMinutes || '',
          nextAssistGuardMinutes: state.nextAssistGuardMinutes || '',
          nextAssistGuardMode: state.nextAssistGuardMode || '',
          nextAssistGuardApplied: state.nextAssistGuardApplied === true,
          nextAssistPlan: state.nextAssistPlan || null,
          nextAssistPlannedAt: state.nextAssistPlannedAt || '',
          targetPreview: state.targetPreview || null,
          targetPreviewAt: state.targetPreviewAt || '',
          chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
          lastAttempt: state.lastAttempt || null,
          lastAssistStrategy: state.lastAssistStrategy || '',
          lastAssistDecisionAt: state.lastAssistDecisionAt || '',
          lastAssistDecision: state.lastAssistDecision || null,
          lastRunTrigger: state.lastRunTrigger || '',
          lastRunStartedAt: state.lastRunStartedAt || '',
          lastRunFinishedAt: state.lastRunFinishedAt || '',
          lastRunResult: state.lastRunResult || null,
          runStats: state.runStats || {},
          schedulerModelMode: state.schedulerModelMode || '',
          workTimeProgressRatio: state.workTimeProgressRatio || 0,
          activeTimeProgressRatio: state.activeTimeProgressRatio || 0,
          availabilityFactor: state.availabilityFactor || 1,
          availabilityActualWakeCount: state.availabilityActualWakeCount || 0,
          availabilityExpectedWakeCount: state.availabilityExpectedWakeCount || 0,
          expectedDone: state.expectedDone || 0,
          actualDone: state.actualDone || state.monthDone || 0,
          targetError: state.targetError || state.lag || 0,
          rateMultiplier: state.rateMultiplier || 1,
          riskUsed: state.riskUsed || 0,
          riskLimit: state.riskLimit || 0,
          currentSession: state.currentSession || null,
          journalShortNameMapCount: Object.keys(state.journalShortNameMap || {}).length,
          journalShortNameMapPreview: Object.entries(state.journalShortNameMap || {}).slice(0, 10).map(([key, value]) => ({
            key,
            short: typeof value === 'object' ? value.short || '' : '',
            full: typeof value === 'object' ? value.full || '' : String(value || '')
          }))
        },
        latestWatcherLog: logs[0] || null,
        latestTraceLogs: traceLogs.slice(0, 30),
        latestDiagnostic: diagnostic ? {
          time: diagnostic.time || '',
          stage: diagnostic.stage || '',
          assistId: diagnostic.assistId || '',
          doi: diagnostic.doi || '',
          journalName: diagnostic.journalName || '',
          assistDetailUrl: diagnostic.assistDetailUrl || diagnostic.pageUrl || '',
          publisherHost: diagnostic.publisherHost || '',
          pickedUrl: diagnostic.pickedUrl || null,
          source: diagnostic.source || '',
          error: diagnostic.error || ''
        } : null
      };

      const text = JSON.stringify(payload, null, 2);
      try {
        await copyTextToClipboard(text);
      } catch (_) {
      }
    }

    async function runAutoWatcherNow() {
      const button = el('runAutoWatcherNow');
      if (button?.disabled) return;
      if (button) button.disabled = true;
      showPill('watcherRunStatus', '检查中');
      try {
        const res = await sendRuntimeMessage({ type: 'ablesciRunAutoWatcherNow' });
        showPill('watcherRunStatus', res.ok ? (res.reason || '已完成') : formatActionFailure(res.reason), !res.ok);
      } finally {
        if (button) button.disabled = false;
      }
    }

    async function testWatcherNotification() {
      const saved = await save();
      if (!saved) {
        showPill('watcherNotifyStatus', '保存失败，未发送测试提醒', true);
        return;
      }
      showPill('watcherNotifyStatus', '发送中');
      const res = await sendRuntimeMessage({ type: 'ablesciTestWatcherNotification' });
      const mode = res.mode === 'browser' ? '浏览器' : 'Native';
      const label = res.fallbackFrom === 'native'
        ? `Native 失败，已回退到${mode}`
        : mode;
      showPill(
        'watcherNotifyStatus',
        res.ok ? `${label} 已发送` : `${mode} 失败：${res.reason || '未知错误'}`,
        !res.ok
      );
    }

    async function clearAutoWatcherState() {
      const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherState' });
      showText('status', res.ok ? '已清除 watcher 已处理记录。' : '清除失败：' + (res.reason || '未知错误'), !res.ok);
    }

    async function clearAutoWatcherLogs() {
      const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherLogs' });
      showText('status', res.ok ? '已清除 watcher 日志和 trace。' : '清除失败：' + (res.reason || '未知错误'), !res.ok);
    }

    async function simulateAssist() {
      const input = el('debugDoiInput');
      const btn = el('btnDebugSimulate');
      const logContainer = el('debugLogContainer');
      if (!input || !btn || !logContainer) return;

      const rawVal = input.value.trim();
      if (!rawVal) {
        alert('请输入 DOI 或文献 URL');
        return;
      }

      let pdfUrl = rawVal;
      if (!/^https?:\/\//i.test(rawVal)) {
        if (/^10\.\d{4,9}\//i.test(rawVal)) {
          pdfUrl = 'https://doi.org/' + rawVal;
        } else {
          alert('输入的格式不正确，请输入以 10. 开头的 DOI，或者完整的 URL 链接');
          return;
        }
      }

      btn.disabled = true;
      btn.textContent = '模拟中...';
      logContainer.style.display = 'block';
      logContainer.textContent = `[模拟应助] 开始测试: ${pdfUrl}\n[模拟应助] 正在连接插件后台任务队列...\n`;

      try {
        const port = chromeApi.runtime.connect({ name: 'ablesci-pdf-upload' });

        port.onMessage.addListener(msg => {
          if (!msg) return;
          if (msg.type === 'progress') {
            logContainer.textContent += `[进度] ${msg.payload}\n`;
            logContainer.scrollTop = logContainer.scrollHeight;
          } else if (msg.type === 'done') {
            logContainer.textContent += `\n[完成] 测试结束！返回结果：\n${msg.payload || ''}\n`;
            if (msg.extra?.html) {
              logContainer.textContent += `\n[详细反馈] ${msg.extra.html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')}\n`;
            }
            logContainer.scrollTop = logContainer.scrollHeight;
            btn.disabled = false;
            btn.textContent = '开始模拟';
            port.disconnect();
          } else if (msg.type === 'error') {
            logContainer.textContent += `\n[错误] 应助出错：${msg.payload || '未知错误'}\n`;
            logContainer.scrollTop = logContainer.scrollHeight;
            btn.disabled = false;
            btn.textContent = '开始模拟';
            port.disconnect();
          }
        });

        port.postMessage({
          type: 'startUpload',
          payload: {
            pdfUrl: pdfUrl,
            suggestedFilename: `debug_simulate_${Date.now()}.pdf`,
            assistId: `simulate_debug_${Math.random().toString(36).substring(2, 8)}`,
            csrfToken: 'dummy_csrf_token',
            downloadOnly: true,
            requesterId: 'simulate_debugger',
            title: 'Simulated Debug Test Paper'
          }
        });

      } catch (err) {
        logContainer.textContent += `\n[异常] 启动模拟失败: ${err.message || String(err)}\n`;
        btn.disabled = false;
        btn.textContent = '开始模拟';
      }
    }

    function handleDocumentCopy(event) {
      const active = document.activeElement;
      const tag = String(active?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || active?.isContentEditable) return;
      const selection = window.getSelection?.();
      const text = selection ? String(selection.toString() || '') : '';
      if (!text) return;
      const cleaned = text.replace(/\r\n/g, '\n').replace(/[\r\n]+$/, '');
      if (cleaned === text) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', cleaned);
    }

    function handleWindowBlur() {
      try {
        window.getSelection()?.removeAllRanges();
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      } catch (_) {}
    }

    return {
      showText,
      sendRuntimeMessage,
      testNative,
      copyDiagnostic,
      // PRIVATE_WATCHER_ONLY
      openLocalStorageDir,
      copyAutoWatcherConfig,
      copyTextToClipboard,
      runAutoWatcherNow,
      testWatcherNotification,
      clearAutoWatcherState,
      clearAutoWatcherLogs,
      simulateAssist,
      handleDocumentCopy,
      handleWindowBlur
    };
  }

  globalThis.AblesciOptionsActions = {
    createOptionsActionsApi
  };
})();
