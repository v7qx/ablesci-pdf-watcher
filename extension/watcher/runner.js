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
      recordBanditOutcome,
      notifyWatcherNeedsAttention,
      getProcessedKey,
      candidateSource,
      rememberJournalShortNameMapping,
      parseAssistListPage,
      waitForAssistListDom,
      saveWatcherState,
      describeWatcherReason,
      highRiskFailThreshold,
      journalAccessStatsKey,
      isDetailAllowedForWatcher,
      isListCandidateAllowed,
      isListCandidateHighRiskByStats,
      isListCandidateDoiHighRiskByStats,
      enrichCandidateJournalFromMap
    } = config;

    async function isHighRiskJournal(journalName) {
      const journal = String(journalName || '').replace(/\s+/g, ' ').trim();
      if (!journal) return false;
      const stored = await chromeApi.storage.local.get(journalAccessStatsKey);
      const stats = stored[journalAccessStatsKey] || {};
      const item = stats[journal];
      if (!item) return false;
      const consecutiveFailCount = Number(item.consecutiveFailCount || 0);
      const successCount = Number(item.successCount || 0);
      const accessState = String(item.accessState || '');
      if (accessState === 'has_access' || accessState === 'partial_access') return false;
      if (successCount > 0) return false;
      return consecutiveFailCount >= highRiskFailThreshold;
    }

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
          totalSeeking: parsed.demandSnapshot?.totalSeeking ?? '',
          publisherCount: Object.keys(parsed.demandSnapshot?.publisherCounts || {}).length,
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
        files: ['adapters.js', 'content_ablesci.js']
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
      function settle(result) {
        if (!context || context.settled) return;
        context.settled = true;
        if (context.resolve) context.resolve(result);
      }
      return {
        name: 'ablesci-auto-watcher',
        postMessage(msg) {
          if (!msg || !context) return;
          if (msg.type === 'error') {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            appendWatcherTrace('queue_message_error', {
              reason: msg.message || 'upload_failed',
              detailUrl: context.detailUrl,
              sessionId: context.sessionId || '',
              assistId: context.key,
              durationMs
            }).catch(() => {});
            updateProcessed(context.key, 'failed', msg.message || 'upload_failed').catch(() => {});
            incrementDaily('failed').catch(() => {});
            recordRiskEvent(context.opts || {}, msg.message || 'upload_failed', 'failed').catch(() => {});
            recordBanditOutcome(context.source, 'failure', durationMs, msg.message || 'upload_failed').catch(() => {});
            appendWatcherLog({
              ...context.payload,
              detailUrl: context.detailUrl,
              sessionId: context.sessionId || '',
              trigger: context.trigger || '',
              status: 'failed',
              reason: msg.message || 'upload_failed'
            }).then(writeDailyReports).catch(() => {});
            settle({ ok: false, reason: msg.message || 'upload_failed', durationMs });
          }
          if (msg.type === 'done' && msg.blocked) {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            appendWatcherTrace('queue_message_blocked', {
              reason: msg.message || 'blocked',
              detailUrl: context.detailUrl,
              sessionId: context.sessionId || '',
              assistId: context.key,
              durationMs
            }).catch(() => {});
            updateProcessed(context.key, 'failed', msg.message || 'blocked').catch(() => {});
            incrementDaily('failed').catch(() => {});
            recordRiskEvent(context.opts || {}, msg.message || 'blocked', 'blocked').catch(() => {});
            recordBanditOutcome(context.source, 'failure', durationMs, msg.message || 'blocked').catch(() => {});
            appendWatcherLog({
              ...context.payload,
              detailUrl: context.detailUrl,
              sessionId: context.sessionId || '',
              trigger: context.trigger || '',
              status: 'failed',
              reason: msg.message || 'blocked'
            }).then(writeDailyReports).catch(() => {});
            settle({ ok: false, reason: msg.message || 'blocked', durationMs });
          } else if (msg.type === 'done') {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            appendWatcherTrace('queue_message_done', {
              reason: msg.message || 'done',
              detailUrl: context.detailUrl,
              sessionId: context.sessionId || '',
              assistId: context.key,
              durationMs
            }).catch(() => {});
            recordRiskEvent(context.opts || {}, msg.message || 'success', 'success').catch(() => {});
            recordBanditOutcome(context.source, 'success', durationMs, msg.message || 'success').catch(() => {});
            settle({ ok: true, reason: msg.message || 'done', durationMs });
          }
        },
        onDisconnect: {
          addListener() {}
        }
      };
    }

    function makeSessionPortContext(context) {
      let timer = null;
      const result = new Promise(resolve => {
        context.resolve = value => {
          if (timer) clearTimeout(timer);
          resolve(value);
        };
        const timeoutMs = Math.max(60 * 1000, (Number(context.opts?.watcherTaskTimeoutMinutes || 10) + 1) * 60 * 1000);
        timer = setTimeout(() => resolve({ ok: false, reason: 'auto_watcher_task_timeout', durationMs: timeoutMs }), timeoutMs);
      });
      return { port: makeWatcherPort(context), result };
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
        autoDownload: opts.watcherAutoDownload,
        autoUpload: opts.watcherAutoUpload,
        uploadConfirmRequired: opts.watcherUploadConfirmRequired
      });

      if (opts.watcherSkipHighRiskJournal && await isHighRiskJournal(payload.journalName, payload)) {
        await appendWatcherTrace('candidate_skip_high_risk_journal', { reason: 'high_risk_journal', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
        await closeTabQuietly(detailTabId, 'high_risk_journal');
        await updateProcessed(key, 'skipped', 'high_risk_journal');
        await incrementDaily('skipped');
        await recordBanditOutcome(source, 'failure', 0, 'high_risk_journal');
        await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: `本地记录连续失败达到 ${highRiskFailThreshold} 次，暂按无权限跳过` });
        return false;
      }

      if (!opts.watcherAutoDownload) {
        await appendWatcherTrace('candidate_manual_detail_kept', { reason: 'auto_download_disabled', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
        await notifyWatcherNeedsAttention('低频值守发现候选，已保留求助详情页等待人工处理。', candidate.detailUrl);
        await incrementDaily('notified');
        await updateProcessed(key, 'skipped', 'manual_detail_opened');
        await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: 'manual_detail_opened' });
        return true;
      }

      if (!opts.watcherAutoUpload || opts.watcherUploadConfirmRequired) {
        payload.downloadOnly = true;
        payload.riskReasons = [
          ...(Array.isArray(payload.riskReasons) ? payload.riskReasons : []),
          '低频值守默认仅下载并校验 PDF，上传需要人工确认。'
        ];
      }

      if (deps.hasActiveTask()) {
        await appendWatcherTrace('candidate_skip_active_task', { reason: 'active_task', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
        await updateProcessed(key, 'skipped', 'active_task');
        await incrementDaily('skipped');
        await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: 'active_task' });
        return false;
      }

      const portContext = {
        key,
        payload,
        detailUrl: candidate.detailUrl,
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
      await incrementDaily('downloaded');
      if (opts.watcherAutoUpload && !opts.watcherUploadConfirmRequired) await incrementDaily('uploaded');
      await updateProcessed(key, 'success', payload.downloadOnly ? 'queued_download_only' : 'queued_upload');
      await appendWatcherLog({
        ...payload,
        detailUrl: candidate.detailUrl,
        sessionId: session?.id || '',
        trigger: trigger || session?.trigger || '',
        status: payload.downloadOnly ? 'download_only' : 'queued_upload',
        reason: payload.downloadOnly ? 'upload_confirmation_required' : 'auto_upload_enabled'
      });
      await notifyWatcherNeedsAttention(payload.downloadOnly ? '低频值守已排队下载校验一个候选，并保留求助详情页等待人工上传确认。' : '低频值守已排队处理一个候选。');
      await incrementDaily('notified');
      if (sessionPort) {
        const result = await sessionPort.result;
        if (!payload.downloadOnly) {
          await closeTabQuietly(detailTabId, result.ok ? 'auto_upload_done' : 'auto_upload_failed');
        }
        return result.ok;
      }
      return true;
    }

    return {
      isHighRiskJournal,
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
