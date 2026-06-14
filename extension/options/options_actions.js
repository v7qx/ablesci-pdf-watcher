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

    let currentSimulatePort = null;

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
        showText('status', '诊断未开启', true);
        return;
      }
      const stored = await chromeApi.storage.local.get(lastDiagnosticKey);
      const diagnostic = stored[lastDiagnosticKey];
      if (!diagnostic) {
        showText('status', '暂无诊断信息。', true);
        return;
      }

      const clean = JSON.parse(JSON.stringify(diagnostic, (key, value) => key === '_signature' ? undefined : value));
      const text = JSON.stringify(clean, null, 2);
      try {
        const ok = await copyTextToClipboard(text);
        if (!ok) throw new Error('copy_failed');
        showText('status', '已复制诊断信息。');
      } catch (_) {
        showText('status', '复制失败', true);
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
      const journalAccessEntries = validJournalAccessEntries(state);
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
          candidateQueueSize: Array.isArray(state.assistCandidateQueue?.items) ? state.assistCandidateQueue.items.length : 0,
          lastPickedListUrl: state.lastPickedListUrl || '',
          lastPickedPage: state.lastPickedPage || '',
          lastPickedPageMax: state.lastPickedPageMax || '',
          lastPickedPublisher: state.lastPickedPublisher || '',
          lastHandledPublisherKey: state.lastHandledPublisherKey || '',
          lastHandledPublisherAt: state.lastHandledPublisherAt || '',
          journalAccessStatsCount: journalAccessEntries.length,
          journalAccessStatsPreview: journalAccessEntries.slice(0, 5).map(entry => ({
            shortName: entry.shortName || '',
            reason: entry.reason || '',
            lastAt: entry.lastAt || '',
            expiresAt: entry.expiresAt || '',
            hitCount: Number(entry.hitCount || 0) || 0,
            lastAssistId: entry.lastAssistId || ''
          })),
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
      const scannedContainer = el('watcherScannedLinkContainer');
      if (scannedContainer) scannedContainer.style.display = 'none';
      showPill('watcherRunStatus', '检查中');
      try {
        const res = await sendRuntimeMessage({ type: 'ablesciRunAutoWatcherNow' });
        showPill('watcherRunStatus', res.ok ? (res.reason || '已完成') : formatActionFailure(res.reason), !res.ok);
        if (res.ok && res.reason === 'no_candidate' && res.scannedUrl) {
          const scannedLink = el('watcherScannedLink');
          if (scannedLink && scannedContainer) {
            scannedLink.href = res.scannedUrl;
            let pubText = String(res.scannedPublisher || '未知').toUpperCase();
            let pageText = res.scannedPage ? `第 ${res.scannedPage} 页` : '';
            scannedLink.textContent = `${pubText} ${pageText}`.trim() || '排查链接';
            scannedContainer.style.display = 'inline';
          }
        }
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
      const msg = res.ok
        ? '已清除 watcher 已处理记录。'
        : (typeof globalThis.t === 'function' ? globalThis.t('清除失败：') : '清除失败：') + (res.reason || (typeof globalThis.t === 'function' ? globalThis.t('未知错误') : '未知错误'));
      showText('status', msg, !res.ok);
    }

    async function clearAutoWatcherLogs() {
      const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherLogs' });
      const msg = res.ok
        ? '已清除 watcher 日志和 trace。'
        : (typeof globalThis.t === 'function' ? globalThis.t('清除失败：') : '清除失败：') + (res.reason || (typeof globalThis.t === 'function' ? globalThis.t('未知错误') : '未知错误'));
      showText('status', msg, !res.ok);
    }

    async function clearAutoWatcherQueue() {
      const res = await sendRuntimeMessage({ type: 'ablesciClearAutoWatcherQueue' });
      const msg = res.ok
        ? '已清空 watcher 候选队列和列表页游标。'
        : (typeof globalThis.t === 'function' ? globalThis.t('清除失败：') : '清除失败：') + (res.reason || (typeof globalThis.t === 'function' ? globalThis.t('未知错误') : '未知错误'));
      showText('status', msg, !res.ok);
    }

    function validJournalAccessEntries(state = {}) {
      const stats = state.journalAccessStats || {};
      const now = Date.now();
      return Object.values(stats)
        .filter(entry => entry && typeof entry === 'object')
        .filter(entry => entry.publisher === 'sciencedirect')
        .filter(entry => entry.reason === 'explicit_no_subscription')
        .filter(entry => {
          const expiresAt = Date.parse(entry.expiresAt || '');
          return Number.isFinite(expiresAt) && expiresAt > now;
        })
        .sort((a, b) => Date.parse(b.lastAt || '') - Date.parse(a.lastAt || ''));
    }

    function journalAccessCountText(count) {
      const isEn = globalThis.watcherActiveLanguage === 'en';
      return isEn ? `${count} entries` : `${count} 条`;
    }

    async function refreshJournalAccessCacheSummary() {
      const summary = el('journalAccessCacheSummary');
      const status = el('journalAccessCacheStatus');
      if (!summary || !status) return;
      const data = await chromeApi.storage.local.get({ [autoWatcherStateKey]: {} });
      const entries = validJournalAccessEntries(data[autoWatcherStateKey] || {});
      if (!entries.length) {
        summary.textContent = typeof globalThis.t === 'function' ? globalThis.t('暂无缓存。') : '暂无缓存。';
        showPill('journalAccessCacheStatus', journalAccessCountText(0));
        return;
      }
      const recent = entries.slice(0, 5).map(entry => entry.shortName).filter(Boolean);
      const prefix = typeof globalThis.t === 'function' ? globalThis.t('最近') : '最近';
      const separator = globalThis.watcherActiveLanguage === 'en' ? ', ' : '、';
      summary.textContent = `${prefix}: ${recent.join(separator)}`;
      summary.title = summary.textContent;
      showPill('journalAccessCacheStatus', journalAccessCountText(entries.length));
    }

    async function clearJournalAccessCache() {
      const data = await chromeApi.storage.local.get({ [autoWatcherStateKey]: {} });
      const state = data[autoWatcherStateKey] || {};
      delete state.journalAccessStats;
      await chromeApi.storage.local.set({ [autoWatcherStateKey]: state });
      await chromeApi.storage.local.remove(['journalAccessStats', 'journalAccessLookupIndex']);
      await refreshJournalAccessCacheSummary();
      showText('status', '已清空 ScienceDirect 无权限期刊缓存。');
    }

    async function simulateAssist() {
      const input = el('debugDoiInput');
      const btn = el('btnDebugSimulate');
      const logContainer = el('debugLogContainer');
      if (!input || !btn || !logContainer) return;

      if (btn.textContent === '暂停模拟') {
        if (currentSimulatePort) {
          try { currentSimulatePort.disconnect(); } catch (_) {}
          currentSimulatePort = null;
        }
        btn.textContent = '开始模拟';
        btn.disabled = false;
        appendSimulateLog('exception', '手动暂停了模拟；保留当前日志方便复制。');
        return;
      }

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

      function escapeHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function appendSimulateLog(type, text, isHtml = false) {
        let emoji = 'ℹ️';
        let color = 'var(--text-muted)';
        let bold = false;

        if (type === 'progress') {
          if (text.includes('通过') || text.includes('成功') || text.includes('完成') || text.includes('MD5')) {
            emoji = '🟢';
            color = '#166534';
          } else if (text.includes('失败') || text.includes('错误') || text.includes('超时')) {
            emoji = '🔴';
            color = '#991b1b';
          } else if (text.includes('等待') || text.includes('验证')) {
            emoji = '🟡';
            color = '#b45309';
          } else {
            emoji = '🔄';
            color = '#0284c7';
          }
        } else if (type === 'done') {
          emoji = '✅';
          color = '#15803d';
          bold = true;
        } else if (type === 'error') {
          emoji = '❌';
          color = '#b91c1c';
          bold = true;
        } else if (type === 'exception') {
          emoji = '⚠️';
          color = '#d97706';
          bold = true;
        }

        const safeText = isHtml ? text : escapeHtml(text);
        const styledLine = `<div style="color: ${color}; font-weight: ${bold ? 'bold' : 'normal'}; margin-bottom: 6px; font-size: 11px; line-height: 1.4;">${emoji} ${safeText}</div>`;

        logContainer.innerHTML += styledLine;
        logContainer.scrollTop = logContainer.scrollHeight;
      }

      btn.disabled = false;
      btn.textContent = '暂停模拟';
      logContainer.innerHTML = '';
      logContainer.style.display = 'block';

      appendSimulateLog('progress', `开始文献探测: ${pdfUrl}`);
      appendSimulateLog('progress', '正在连接插件后台任务队列...');

      try {
        const port = chromeApi.runtime.connect({ name: 'ablesci-pdf-upload' });
        currentSimulatePort = port;

        port.onDisconnect.addListener(() => {
          if (currentSimulatePort === port) {
            currentSimulatePort = null;
            btn.disabled = false;
            btn.textContent = '开始模拟';
          }
        });

        port.onMessage.addListener(msg => {
          if (!msg) return;
          if (msg.type === 'progress') {
            appendSimulateLog('progress', msg.message || '');
          } else if (msg.type === 'done') {
            let resText = msg.message || '';
            if (resText === 'done' || resText === 'success' || resText === 'upload_success') {
              resText = '文献静默下载且 PDF 格式校验成功。';
            }
            appendSimulateLog('done', `测试完成！返回结果：${resText}`);

            // 格式化展示真实可用的校验结果
            if (msg.filename || msg.md5) {
              const displaySize = msg.size ? ` (${~~(msg.size / 1024)} KB)` : '';
              appendSimulateLog('done', `📄 文件名称: ${msg.filename || '-'}${displaySize}`);
              const pageCountText = msg.pageCount !== undefined && msg.pageCount > 0 ? `${msg.pageCount} 页` : '无法识别或 0 页';
              appendSimulateLog('done', `📄 文件页数: ${pageCountText}`);
              appendSimulateLog('done', `🔑 文件 MD5: ${msg.md5 || '-'}`);
            }

            if (msg.pii) {
              appendSimulateLog('done', `🧬 文献 PII: ${msg.pii}`);
            }

            if (msg.normalAction) {
              appendSimulateLog('done', `📢 正常应助决策: ${msg.normalAction}`);
            }

            if (msg.pdfCleanerResult) {
              const res = msg.pdfCleanerResult;
              const status = res.status || res.clean_status;
              const clText = status === 'cleaned' ? '去水印成功' : (status === 'no_watermark' ? '无水印' : '去水印失败');
              const matched = res.matched !== undefined ? res.matched : (res.removed_objects || 0);
              appendSimulateLog('done', `✨ 水印清洗: ${clText} (清除特征 ${matched} 处)`);
            }

            if (msg.extra?.html) {
              const cleanText = msg.extra.html.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '').trim();
              if (cleanText) {
                appendSimulateLog('done', `系统反馈：${cleanText}`);
              }
            }
            btn.disabled = false;
            btn.textContent = '开始模拟';
            currentSimulatePort = null;
            port.disconnect();
          } else if (msg.type === 'error') {
            appendSimulateLog('error', `应助出错：${msg.message || '未知错误'}`);
            btn.disabled = false;
            btn.textContent = '开始模拟';
            currentSimulatePort = null;
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
        appendSimulateLog('exception', `启动模拟失败: ${err.message || String(err)}`);
        btn.disabled = false;
        btn.textContent = '开始模拟';
        currentSimulatePort = null;
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
      clearAutoWatcherQueue,
      refreshJournalAccessCacheSummary,
      clearJournalAccessCache,
      simulateAssist,
      handleDocumentCopy,
      handleWindowBlur
    };
  }

  globalThis.AblesciOptionsActions = {
    createOptionsActionsApi
  };
})();
