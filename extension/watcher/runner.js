// Responsibility: tab lifecycle, detail extraction, queue bridge, and allowed
// payload handling for the auto watcher.
(function () {
  function createWatcherRunnerApi(config) {
    const {
      chromeApi,
      deps,
      appendWatcherTrace,
      appendWatcherLog,
      writeDailyReports,
      updateProcessed,
      incrementDaily,
      recordRiskEvent,
      notifyWatcherNeedsAttention,
      getProcessedKey,
      candidateSource,
      rememberJournalShortNameMapping,
      parseAssistListPage,
      waitForAssistListDom,
      saveWatcherState,
      describeWatcherReason,
      isDetailAllowedForWatcher,
      isListCandidateAllowed,
      enrichCandidateJournalFromMap
    } = config;



    async function waitForTabComplete(tabId, timeoutMs = 45000) {
      return await new Promise((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => finish(false, new Error('tab_load_timeout')), timeoutMs);
        function finish(ok, value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          chromeApi.tabs.onUpdated.removeListener(listener);
          ok ? resolve(value) : reject(value);
        }
        function listener(updatedTabId, changeInfo, tab) {
          if (updatedTabId !== tabId) return;
          if (changeInfo.status === 'complete') finish(true, tab);
        }
        chromeApi.tabs.onUpdated.addListener(listener);
        chromeApi.tabs.get(tabId).then(tab => {
          if (tab.status === 'complete') finish(true, tab);
        }).catch(err => finish(false, err));
      });
    }

    async function openHiddenTab(url, purpose = 'hidden') {
      await appendWatcherTrace('tab_open_request', { reason: purpose, url });
      try {
        const tab = await chromeApi.tabs.create({ url, active: false });
        await appendWatcherTrace('tab_opened', { reason: purpose, url: tab.url || url, tabId: tab.id, active: tab.active === true });
        const completedTab = await waitForTabComplete(tab.id);
        await appendWatcherTrace('tab_complete', { reason: purpose, url: completedTab?.url || tab.url || url, tabId: tab.id });
        return tab;
      } catch (err) {
        await appendWatcherTrace('tab_open_failed', { reason: purpose, url, error: err?.message || String(err) });
        throw err;
      }
    }

    async function closeTabQuietly(tabId, reason = 'cleanup') {
      if (!tabId) return;
      await appendWatcherTrace('tab_close_request', { reason, tabId });
      try {
        await chromeApi.tabs.remove(tabId);
        await appendWatcherTrace('tab_closed', { reason, tabId });
      } catch (err) {
        await appendWatcherTrace('tab_close_failed', { reason, tabId, error: err?.message || String(err) });
      }
    }

    async function parseListUrl(url) {
      const tab = await openHiddenTab(url, 'parse_list');
      try {
        const readyResult = await chromeApi.scripting.executeScript({
          target: { tabId: tab.id },
          func: waitForAssistListDom,
          args: [9000]
        });
        const readiness = readyResult?.[0]?.result || {};
        await appendWatcherTrace('list_dom_ready', {
          reason: readiness.ready ? 'assist_list_dom_ready' : 'assist_list_dom_timeout',
          url,
          tabId: tab.id,
          ready: readiness.ready === true,
          elapsedMs: readiness.elapsedMs ?? '',
          readyState: readiness.readyState || '',
          title: readiness.title || '',
          rowCount: readiness.rowCount ?? '',
          detailLinkCount: readiness.detailLinkCount ?? '',
          publisherItemCount: readiness.publisherItemCount ?? '',
          flyFilterCount: readiness.flyFilterCount ?? '',
          cfChallenge: readiness.cfChallenge === true,
          loginLike: readiness.loginLike === true,
          bodyLength: readiness.bodyLength ?? ''
        });
        const result = await chromeApi.scripting.executeScript({
          target: { tabId: tab.id },
          func: parseAssistListPage
        });
        const parsed = result?.[0]?.result || { cfChallenge: false, candidates: [] };
        await appendWatcherTrace('list_parse_result', {
          reason: 'parse_list',
          url,
          tabId: tab.id,
          cfChallenge: parsed.cfChallenge === true,
          candidateCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
          totalSeeking: parsed.listStats?.totalSeeking ?? '',
          publisherCount: Object.keys(parsed.listStats?.publisherCounts || {}).length,
          rowCount: parsed.debug?.rowCount ?? '',
          detailLinkCount: parsed.debug?.detailLinkCount ?? '',
          publisherItemCount: parsed.debug?.publisherItemCount ?? '',
          flyFilterCount: parsed.debug?.flyFilterCount ?? '',
          loginLike: parsed.debug?.loginLike === true,
          pageTitle: parsed.debug?.title || ''
        });
        return parsed;
      } finally {
        await closeTabQuietly(tab.id, 'list_parse_finished');
      }
    }

    async function sendDetailMessage(tabId) {
      return await chromeApi.tabs.sendMessage(tabId, { type: 'ablesciExtractDetailPayload' });
    }

    async function extractDetailPayload(tabId) {
      for (let i = 0; i < 5; i += 1) {
        try {
          const response = await sendDetailMessage(tabId);
          if (response) return response;
        } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      await chromeApi.scripting.executeScript({
        target: { tabId },
        files: ['content/adapters.js', 'content/content_ablesci.js']
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      return await sendDetailMessage(tabId);
    }

    async function inspectDetail(candidate) {
      const tab = await openHiddenTab(candidate.detailUrl, 'inspect_detail');
      try {
        const response = await extractDetailPayload(tab.id);
        if (!response?.ok) {
          await appendWatcherTrace('detail_extract_failed', {
            reason: response?.error || 'extract_detail_failed',
            detailUrl: candidate.detailUrl,
            tabId: tab.id,
            assistId: candidate.assistId || ''
          });
          return { ok: false, reason: response?.error || 'extract_detail_failed', tabId: tab.id };
        }
        await appendWatcherTrace('detail_extract_result', {
          reason: 'detail_payload_ok',
          detailUrl: candidate.detailUrl,
          tabId: tab.id,
          assistId: response.payload?.assistId || candidate.assistId || '',
          doi: response.payload?.doi || candidate.doi || '',
          journalShortName: candidate.journalShortName || '',
          journalName: response.payload?.journalName || ''
        });
        await rememberJournalShortNameMapping(candidate, response.payload);
        return { ok: true, payload: response.payload, tabId: tab.id };
      } catch (err) {
        await appendWatcherTrace('detail_extract_error', {
          reason: err?.message || String(err),
          detailUrl: candidate.detailUrl,
          tabId: tab.id,
          assistId: candidate.assistId || ''
        });
        return { ok: false, reason: err?.message || String(err), tabId: tab.id };
      }
    }

    function makeWatcherPort(context) {
      const disconnectListeners = new Set();
      let disconnected = false;

      function isNativeHostMissingMessage(message) {
        return /specified native messaging host not found|native messaging host|communicating with the native messaging host|未连上 Native Helper|Native Helper/i.test(String(message || ''));
      }

      function isInfrastructureUploadFailure(message) {
        return isNativeHostMissingMessage(message) || /upload-request|OSS|Aliyun|阿里云|Native Helper|upload_oss/i.test(String(message || ''));
      }

      async function pauseWatcherForInfrastructureFailure(message) {
        if (!isInfrastructureUploadFailure(message)) return false;
        const reason = isNativeHostMissingMessage(message) ? 'native_helper_unavailable' : 'upload_infrastructure_error';
        await appendWatcherTrace('watcher_paused_after_download_failure', {
          reason,
          error: String(message || '').slice(0, 240),
          detailUrl: context.detailUrl,
          sessionId: context.sessionId || '',
          assistId: context.key
        }).catch(() => {});
        await chromeApi.storage.local.set({ watcherEnabled: false }).catch(() => {});
        await notifyWatcherNeedsAttention('自动值守已暂停：PDF 已下载但上传链路异常，请检查 Ablesci 登录状态、Native Helper 和 OSS 配置后再开启。').catch(() => {});
        return true;
      }

      function settle(result) {
        if (!context || context.settled) return;
        context.settled = true;
        if (context.resolve) context.resolve(result);
      }

      function disconnect(reason = 'detail_tab_closed') {
        if (disconnected) return;
        disconnected = true;
        for (const listener of Array.from(disconnectListeners)) {
          try { listener(); } catch (err) { console.warn('[Ablesci PDF Watcher] synthetic port disconnect listener failed', err); }
        }
        settle({ ok: false, reason, stopRun: true, paused: false });
      }

      return {
        name: 'ablesci-auto-watcher',
        async postMessage(msg) {
          if (!msg || !context) return;
          if (msg.type === 'error') {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            const paused = await pauseWatcherForInfrastructureFailure(msg.message || 'upload_failed');
            await Promise.allSettled([
              appendWatcherTrace('queue_message_error', {
              reason: msg.message || 'upload_failed',
              detailUrl: context.detailUrl,
              sessionId: context.sessionId || '',
              assistId: context.key,
              durationMs,
              paused
              }),
              updateProcessed(context.key, 'failed', msg.message || 'upload_failed'),
              incrementDaily('failed', context.trigger),
              recordRiskEvent(context.opts || {}, msg.message || 'upload_failed', 'failed'),
              appendWatcherLog({
                ...context.payload,
                detailUrl: context.detailUrl,
                sessionId: context.sessionId || '',
                trigger: context.trigger || '',
                status: 'failed',
                reason: msg.message || 'upload_failed'
              }).then(writeDailyReports)
            ]);
            settle({ ok: false, reason: msg.message || 'upload_failed', durationMs, stopRun: true, paused });
          }
          if (msg.type === 'done' && msg.blocked) {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            const isDoiFailure = msg.skipReason === 'doi_not_found' || msg.skipReason === 'doi_resolution_failed';
            await Promise.allSettled([
              appendWatcherTrace('queue_message_blocked', {
                reason: msg.message || 'blocked',
                detailUrl: context.detailUrl,
                sessionId: context.sessionId || '',
                assistId: context.key,
                durationMs
              }),
              updateProcessed(context.key, 'failed', msg.message || 'blocked'),
              incrementDaily('failed', context.trigger),
              recordRiskEvent(context.opts || {}, msg.message || 'blocked', 'blocked'),
              appendWatcherLog({
                ...context.payload,
                detailUrl: context.detailUrl,
                sessionId: context.sessionId || '',
                trigger: context.trigger || '',
                status: 'failed',
                reason: msg.message || 'blocked'
              }).then(writeDailyReports)
            ]);
            settle({ ok: false, reason: msg.message || 'blocked', durationMs, stopRun: !isDoiFailure, paused: false });
          } else if (msg.type === 'done') {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            let cleanReason = msg.message || 'done';
            if (cleanReason.includes('上传成功') || cleanReason.includes('已成功') || cleanReason.includes('应助成功') || cleanReason.includes('OSS 上传')) {
              cleanReason = '上传成功';
            }
            await Promise.allSettled([
              context.payload?.downloadOnly !== true ? incrementDaily('uploaded', context.trigger) : Promise.resolve(),
              appendWatcherTrace('queue_message_done', {
                reason: cleanReason,
                detailUrl: context.detailUrl,
                sessionId: context.sessionId || '',
                assistId: context.key,
                durationMs
              }),
              recordRiskEvent(context.opts || {}, cleanReason, 'success'),
              appendWatcherLog({
                ...context.payload,
                detailUrl: context.detailUrl,
                sessionId: context.sessionId || '',
                trigger: context.trigger || '',
                status: 'success',
                reason: cleanReason
              }).then(writeDailyReports)
            ]);
            settle({ ok: true, reason: cleanReason, durationMs });
          }
        },
        onDisconnect: {
          addListener(listener) {
            if (typeof listener === 'function') disconnectListeners.add(listener);
          },
          removeListener(listener) {
            disconnectListeners.delete(listener);
          }
        },
        disconnect
      };
    }


    function makeSessionPortContext(context) {
      let timer = null;
      let tabRemovedListener = null;
      let port = null;
      const result = new Promise(resolve => {
        context.resolve = value => {
          if (timer) clearTimeout(timer);
          if (tabRemovedListener) chromeApi.tabs.onRemoved.removeListener(tabRemovedListener);
          resolve(value);
        };
        const timeoutMs = Math.max(60 * 1000, (Number(context.opts?.watcherTaskTimeoutMinutes || 10) + 1) * 60 * 1000);
        timer = setTimeout(() => context.resolve({ ok: false, reason: 'auto_watcher_task_timeout', durationMs: timeoutMs }), timeoutMs);
      });
      port = makeWatcherPort(context);
      if (Number.isInteger(context.detailTabId)) {
        tabRemovedListener = tabId => {
          if (tabId !== context.detailTabId) return;
          appendWatcherTrace('detail_tab_closed_cancel_task', {
            reason: 'detail_tab_closed',
            detailUrl: context.detailUrl,
            tabId,
            sessionId: context.sessionId || '',
            assistId: context.key
          }).catch(() => {});
          port.disconnect('detail_tab_closed');
        };
        chromeApi.tabs.onRemoved.addListener(tabRemovedListener);
      }
      return { port, result };
    }

    async function handleAllowedPayload(candidate, payload, opts, detailTabId, session = null, trigger = '') {
      payload.triggeredBy = 'auto_watcher';
      const key = getProcessedKey(candidate, payload);
      const source = candidateSource(candidate, payload);
      await appendWatcherTrace('candidate_payload_allowed', {
        reason: 'ready_to_handle',
        detailUrl: candidate.detailUrl,
        tabId: detailTabId,
        sessionId: session?.id || '',
        trigger: trigger || session?.trigger || '',
        assistId: key,
        source,
        autoDownload: true,
        autoUpload: true,
        uploadConfirmRequired: false
      });

      if (deps.hasActiveTask()) {
        await appendWatcherTrace('candidate_skip_active_task', { reason: 'active_task', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
        await updateProcessed(key, 'skipped', 'active_task');
        await incrementDaily('skipped', trigger || session?.trigger || '');
        await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: 'active_task' });
        return false;
      }

      const portContext = {
        key,
        payload,
        detailUrl: candidate.detailUrl,
        detailTabId,
        opts,
        source,
        sessionId: session?.id || '',
        trigger: trigger || session?.trigger || '',
        startedAt: Date.now()
      };
      const sessionPort = makeSessionPortContext(portContext);
      await appendWatcherTrace('candidate_enqueue', {
        reason: payload.downloadOnly ? 'download_only' : 'auto_upload',
        detailUrl: candidate.detailUrl,
        tabId: detailTabId,
        sessionId: session?.id || '',
        trigger: trigger || session?.trigger || '',
        assistId: key,
        source,
        downloadOnly: payload.downloadOnly === true
      });
      deps.enqueueUpload(sessionPort?.port || makeWatcherPort(portContext), payload);
      await incrementDaily('downloaded', trigger || session?.trigger || '');
      await updateProcessed(key, 'success', payload.downloadOnly ? 'queued_download_only' : 'queued_upload');
      await appendWatcherLog({
        ...payload,
        detailUrl: candidate.detailUrl,
        sessionId: session?.id || '',
        trigger: trigger || session?.trigger || '',
        status: payload.downloadOnly ? 'download_only' : 'queued_upload',
        reason: payload.downloadOnly ? 'download_only' : 'auto_upload_enabled'
      });
      const notifyResult = await notifyWatcherNeedsAttention(payload.downloadOnly ? '低频值守已排队下载并校验一个候选。' : '低频值守已排队处理一个候选。');
      if (notifyResult && notifyResult.ok) {
        await incrementDaily('notified', trigger || session?.trigger || '');
      }
      if (sessionPort) {
        const result = await sessionPort.result;
        if (!payload.downloadOnly) {
          await closeTabQuietly(detailTabId, result.ok ? 'auto_upload_done' : 'auto_upload_failed');
        }
        if (!result.ok) {
          return { handled: true, stopRun: result.stopRun !== false, reason: result.reason || 'upload_failed', paused: result.paused === true };
        }
        return { handled: true, stopRun: false, reason: result.reason || 'done' };
      }
      return { handled: true, stopRun: false, reason: 'queued' };
    }

    return {

      waitForTabComplete,
      openHiddenTab,
      closeTabQuietly,
      parseListUrl,
      sendDetailMessage,
      extractDetailPayload,
      inspectDetail,
      makeWatcherPort,
      makeSessionPortContext,
      handleAllowedPayload
    };
  }

  globalThis.AblesciWatcherRunnerModule = {
    createWatcherRunnerApi
  };
}());
