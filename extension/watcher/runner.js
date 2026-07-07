// Responsibility: tab lifecycle, detail extraction, queue bridge, and allowed
// payload handling for the auto watcher.
// Keep a successful assist page visible briefly so the upload recommendation
// and PDF/cleaner summary can be read. Change this value in milliseconds.
const AUTO_UPLOAD_SUCCESS_CLOSE_DELAY_MS = 2000;

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
      fetchListUrl,
      waitForAssistListDom,
      saveWatcherState,
      describeWatcherReason,
      recordJournalAccessBlocked,
      clearJournalAccessBlocked,
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
      let tab = null;
      try {
        tab = await chromeApi.tabs.create({ url, active: false });
        await appendWatcherTrace('tab_opened', { reason: purpose, url: tab.url || url, tabId: tab.id, active: tab.active === true });
        const completedTab = await waitForTabComplete(tab.id);
        await appendWatcherTrace('tab_complete', { reason: purpose, url: completedTab?.url || tab.url || url, tabId: tab.id });
        return tab;
      } catch (err) {
        await appendWatcherTrace('tab_open_failed', { reason: purpose, url, tabId: tab?.id || '', error: err?.message || String(err) });
        if (tab?.id) await closeTabQuietly(tab.id, `${purpose}_load_failed`);
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

    async function parseListUrl(url, traceContext = {}) {
      if (typeof fetchListUrl === 'function') {
        const fetched = await fetchListUrl(url, traceContext);
        const fetchedCount = Array.isArray(fetched?.candidates) ? fetched.candidates.length : 0;
        const shouldFallbackToTab =
          fetched?.fetchFailed === true ||
          fetched?.debug?.loginLike === true ||
          (!fetched?.cfChallenge && !fetched?.isErrorPage && fetchedCount <= 0);
        if (!shouldFallbackToTab) {
          await appendWatcherTrace('list_parse_result', {
            reason: 'background_fetch_accepted',
            trigger: traceContext.trigger || '',
            publisher: traceContext.publisher || '',
            pickedPage: traceContext.pickedPage || '',
            url,
            cfChallenge: fetched.cfChallenge === true,
            candidateCount: fetchedCount,
            totalSeeking: fetched.listStats?.totalSeeking ?? '',
            publisherCount: Object.keys(fetched.listStats?.publisherCounts || {}).length,
            rowCount: fetched.debug?.rowCount ?? '',
            detailLinkCount: fetched.debug?.detailLinkCount ?? '',
            assistIdCount: fetched.debug?.assistIdCount ?? '',
            publisherItemCount: fetched.debug?.publisherItemCount ?? '',
            flyFilterCount: fetched.debug?.flyFilterCount ?? '',
            loginLike: fetched.debug?.loginLike === true,
            bodyLength: fetched.debug?.bodyLength ?? '',
            pageTitle: fetched.debug?.title || ''
          });
          return fetched;
        }
        await appendWatcherTrace('list_fetch_fallback_to_tab', {
          reason: fetched?.fetchFailed ? 'fetch_failed' : (fetched?.debug?.loginLike ? 'login_like' : 'zero_candidates'),
          trigger: traceContext.trigger || '',
          publisher: traceContext.publisher || '',
          pickedPage: traceContext.pickedPage || '',
          url,
          candidateCount: fetchedCount,
          cfChallenge: fetched?.cfChallenge === true,
          isErrorPage: fetched?.isErrorPage === true,
          loginLike: fetched?.debug?.loginLike === true,
          error: fetched?.error || ''
        });
      }
      const tab = await openHiddenTab(url, 'parse_list');
      try {
        async function waitForListDom(timeoutMs) {
          const readyResult = await chromeApi.scripting.executeScript({
            target: { tabId: tab.id },
            func: waitForAssistListDom,
            args: [timeoutMs]
          });
          return readyResult?.[0]?.result || {};
        }
        async function parseCurrentList() {
          const result = await chromeApi.scripting.executeScript({
            target: { tabId: tab.id },
            func: parseAssistListPage
          });
          return result?.[0]?.result || { cfChallenge: false, candidates: [] };
        }
        function appendListParseTrace(parsed, reason) {
          return appendWatcherTrace('list_parse_result', {
            reason,
            trigger: traceContext.trigger || '',
            publisher: traceContext.publisher || '',
            pickedPage: traceContext.pickedPage || '',
            url,
            tabId: tab.id,
            cfChallenge: parsed.cfChallenge === true,
            candidateCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            totalSeeking: parsed.listStats?.totalSeeking ?? '',
            publisherCount: Object.keys(parsed.listStats?.publisherCounts || {}).length,
            rowCount: parsed.debug?.rowCount ?? '',
            detailLinkCount: parsed.debug?.detailLinkCount ?? '',
            assistIdCount: parsed.debug?.assistIdCount ?? '',
            publisherItemCount: parsed.debug?.publisherItemCount ?? '',
            flyFilterCount: parsed.debug?.flyFilterCount ?? '',
            loginLike: parsed.debug?.loginLike === true,
            bodyLength: parsed.debug?.bodyLength ?? '',
            pageTitle: parsed.debug?.title || ''
          });
        }
        const readyResult = await chromeApi.scripting.executeScript({
          target: { tabId: tab.id },
          func: waitForAssistListDom,
          args: [9000]
        });
        const readiness = readyResult?.[0]?.result || {};
        await appendWatcherTrace('list_dom_ready', {
          reason: readiness.ready ? 'assist_list_dom_ready' : 'assist_list_dom_timeout',
          trigger: traceContext.trigger || '',
          publisher: traceContext.publisher || '',
          pickedPage: traceContext.pickedPage || '',
          url,
          tabId: tab.id,
          ready: readiness.ready === true,
          elapsedMs: readiness.elapsedMs ?? '',
          readyState: readiness.readyState || '',
          title: readiness.title || '',
          rowCount: readiness.rowCount ?? '',
          detailLinkCount: readiness.detailLinkCount ?? '',
          assistIdCount: readiness.assistIdCount ?? '',
          publisherItemCount: readiness.publisherItemCount ?? '',
          flyFilterCount: readiness.flyFilterCount ?? '',
          cfChallenge: readiness.cfChallenge === true,
          emptyListLike: readiness.emptyListLike === true,
          loginLike: readiness.loginLike === true,
          bodyLength: readiness.bodyLength ?? ''
        });
        let parsed = await parseCurrentList();
        await appendListParseTrace(parsed, 'parse_list');
        if (
          !parsed.cfChallenge &&
          !parsed.isErrorPage &&
          Array.isArray(parsed.candidates) &&
          parsed.candidates.length <= 0 &&
          readiness.emptyListLike !== true
        ) {
          const retryReadiness = await waitForListDom(3500);
          await appendWatcherTrace('list_parse_empty_retry', {
            reason: 'zero_candidates_retry',
            trigger: traceContext.trigger || '',
            publisher: traceContext.publisher || '',
            pickedPage: traceContext.pickedPage || '',
            url,
            tabId: tab.id,
            ready: retryReadiness.ready === true,
            elapsedMs: retryReadiness.elapsedMs ?? '',
            rowCount: retryReadiness.rowCount ?? '',
            detailLinkCount: retryReadiness.detailLinkCount ?? '',
            assistIdCount: retryReadiness.assistIdCount ?? '',
            bodyLength: retryReadiness.bodyLength ?? '',
            emptyListLike: retryReadiness.emptyListLike === true
          });
          parsed = await parseCurrentList();
          await appendListParseTrace(parsed, 'parse_list_retry');
        }
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
        files: ['content/adapters.js', 'content/content_ablesci_ui.js', 'content/content_ablesci_i18n.js', 'content/content_ablesci.js']
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

    // Shared shape for the three queue-message log entries (error / blocked /
    // done). Only status and reason differ between branches.
    function buildWatcherLogEntry(context, msg, status, reason) {
      return {
        ...context.payload,
        detailUrl: context.detailUrl,
        sessionId: context.sessionId || '',
        trigger: context.trigger || '',
        status,
        reason,
        downloadedFilename: msg.filename || '',
        downloadedMd5: msg.md5 || '',
        downloadSequence: msg.downloadSequence || context.payload?.downloadSequence || '',
        downloadId: msg.downloadId || '',
        downloadCaptureId: msg.downloadCaptureId || '',
        pdfCleanerResult: msg.pdfCleanerResult || null,
        titleValidation: msg.titleValidation || context.payload?.titleValidation || null
      };
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
          if (Number.isInteger(context.detailTabId)) {
            chromeApi.tabs.sendMessage(context.detailTabId, { type: 'ablesciAutoWatcherProgress', msg }).catch(() => {});
          }
          if (context.settled) return;
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
              paused,
              pdfCleanerResult: msg.pdfCleanerResult || null,
              titleValidation: msg.titleValidation || context.payload?.titleValidation || null
              }),
              updateProcessed(context.key, 'failed', msg.message || 'upload_failed', processedMeta(context.candidate, context.payload)),
              incrementDaily('failed', context.trigger),
              recordRiskEvent(context.opts || {}, msg.message || 'upload_failed', 'failed'),
              appendWatcherLog(buildWatcherLogEntry(context, msg, 'failed', msg.message || 'upload_failed')).then(writeDailyReports)
            ]);
            settle({ ok: false, reason: msg.message || 'upload_failed', durationMs, stopRun: true, paused });
          }
          if (msg.type === 'done' && msg.blocked) {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            const isDoiFailure = msg.skipReason === 'doi_not_found' || msg.skipReason === 'doi_resolution_failed';
            const blockReason = msg.skipReason || msg.message || 'blocked';
            const blockText = [blockReason, msg.message || ''].join(' ');
            const shouldTryRecordJournalAccess = blockReason === 'explicit_no_subscription' ||
              blockReason === 'no_access' ||
              /does not subscribe to this content on ScienceDirect|当前出版商无正文订阅权限|无正文订阅权限|无正文访问权限|no[-_\s]?access|access\s+denied|subscribe/i.test(blockText);
            let journalAccessRecorded = null;
            if (shouldTryRecordJournalAccess) {
              try {
                journalAccessRecorded = await recordJournalAccessBlocked?.(context.candidate, context.payload, blockReason);
              } catch (err) {
                journalAccessRecorded = false;
                await appendWatcherTrace('journal_access_record_error', {
                  reason: err?.message || String(err),
                  sourceReason: blockReason,
                  detailUrl: context.detailUrl,
                  assistId: context.key,
                  journalShortName: context.candidate?.journalShortName || context.payload?.journalShortName || '',
                  journalName: context.payload?.journalName || ''
                });
              }
            }
            await Promise.allSettled([
              appendWatcherTrace('queue_message_blocked', {
                reason: blockReason,
                message: msg.message || '',
                journalAccessRecordAttempted: shouldTryRecordJournalAccess,
                journalAccessRecorded,
                detailUrl: context.detailUrl,
                sessionId: context.sessionId || '',
                assistId: context.key,
                durationMs,
                pdfCleanerResult: msg.pdfCleanerResult || null,
                titleValidation: msg.titleValidation || context.payload?.titleValidation || null
              }),
              updateProcessed(context.key, 'failed', msg.message || 'blocked', processedMeta(context.candidate, context.payload)),
              incrementDaily('failed', context.trigger),
              recordRiskEvent(context.opts || {}, msg.message || 'blocked', 'blocked'),
              appendWatcherLog(buildWatcherLogEntry(context, msg, 'failed', msg.message || 'blocked')).then(writeDailyReports)
            ]);
            settle({ ok: false, reason: msg.message || 'blocked', durationMs, stopRun: !isDoiFailure, paused: false });
          } else if (msg.type === 'done') {
            const durationMs = Date.now() - Number(context.startedAt || Date.now());
            let cleanReason = msg.message || 'done';
            if (cleanReason.includes('上传成功') || cleanReason.includes('已成功') || cleanReason.includes('应助成功') || cleanReason.includes('OSS 上传')) {
              cleanReason = '上传成功';
            }
            await Promise.allSettled([
              clearJournalAccessBlocked?.(context.candidate, context.payload),
              context.payload?.downloadOnly !== true ? incrementDaily('uploaded', context.trigger) : Promise.resolve(),
              appendWatcherTrace('queue_message_done', {
                reason: cleanReason,
                detailUrl: context.detailUrl,
                sessionId: context.sessionId || '',
                assistId: context.key,
                durationMs,
                pdfCleanerResult: msg.pdfCleanerResult || null,
                titleValidation: msg.titleValidation || context.payload?.titleValidation || null
              }),
              updateProcessed(context.key, 'success', cleanReason, processedMeta(context.candidate, context.payload)),
              recordRiskEvent(context.opts || {}, cleanReason, 'success'),
              appendWatcherLog(buildWatcherLogEntry(context, msg, 'success', cleanReason)).then(writeDailyReports)
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

    function processedMeta(candidate = {}, payload = {}) {
      return {
        assistAgeSeconds: candidate.assistAgeSeconds ?? payload.assistAgeSeconds ?? '',
        assistTimeText: candidate.assistTimeText || payload.assistTimeText || '',
        listUrl: candidate.listUrl || '',
        page: candidate.page || payload.page || '',
        publisherName: candidate.publisherName || payload.publisherName || '',
        journalShortName: payload.journalShortName || candidate.journalShortName || ''
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
        timer = setTimeout(() => {
          if (context.settled) return;
          context.settled = true;
          if (port && typeof port.disconnect === 'function') {
            port.disconnect('auto_watcher_task_timeout');
          }
          context.resolve({ ok: false, reason: 'auto_watcher_task_timeout', durationMs: timeoutMs, stopRun: true });
        }, timeoutMs);
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
      let watcherPublisher = String(opts.watcherDispatchPublisher || candidate?.publisherName || payload?.publisherName || '').trim().toLowerCase();
      try {
        watcherPublisher = String(new URL(candidate?.listUrl || payload?.listUrl || '').searchParams.get('publisher') || watcherPublisher).trim().toLowerCase();
      } catch (_) {}
      payload.watcherPublisher = watcherPublisher;
      payload.watcherLane = opts.watcherDispatchLane || '';
      payload.watcherMultiPublisherEnabled = opts.watcherMultiPublisherEnabled === true;
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

      if (!opts.watcherMultiPublisherEnabled && deps.hasActiveTask()) {
        await appendWatcherTrace('candidate_skip_active_task', { reason: 'active_task', detailUrl: candidate.detailUrl, tabId: detailTabId, sessionId: session?.id || '', trigger: trigger || session?.trigger || '', source });
        await updateProcessed(key, 'skipped', 'active_task', processedMeta(candidate, payload));
        await incrementDaily('skipped', trigger || session?.trigger || '');
        await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger: trigger || session?.trigger || '', status: 'skipped', reason: 'active_task' });
        return false;
      }

      const portContext = {
        key,
        candidate,
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
      const enqueueResult = deps.enqueueUpload(sessionPort?.port || makeWatcherPort(portContext), payload);
      if (enqueueResult && enqueueResult.accepted === false) {
        sessionPort?.port?.disconnect?.('enqueue_rejected');
        return { handled: false, stopRun: false, removeQueue: true, reason: enqueueResult.reason || 'queue_rejected' };
      }
      await incrementDaily('downloaded', trigger || session?.trigger || '');
      await updateProcessed(key, 'success', payload.downloadOnly ? 'queued_download_only' : 'queued_upload', processedMeta(candidate, payload));
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
        if (opts.watcherMultiPublisherEnabled) {
          sessionPort.result.then(async result => {
            if (result.ok) {
              await new Promise(resolve => setTimeout(resolve, AUTO_UPLOAD_SUCCESS_CLOSE_DELAY_MS));
            }
            await closeTabQuietly(detailTabId, result.ok ? 'auto_upload_done' : 'auto_upload_failed');
          }).catch(() => {});
          return { handled: true, stopRun: false, reason: 'queued_parallel' };
        }
        const result = await sessionPort.result;
        if (result.ok) {
          await new Promise(resolve => setTimeout(resolve, AUTO_UPLOAD_SUCCESS_CLOSE_DELAY_MS));
        }
        await closeTabQuietly(detailTabId, result.ok ? 'auto_upload_done' : 'auto_upload_failed');
        if (!result.ok) {
          const isSkipReason = /跳过|无.*权限|没有.*权限|订阅权限|访问权限|不支持|unsupported|accessDenied|paywall|no_access|no-access|subscribe/i.test(result.reason || '');
          if (isSkipReason) {
            return { handled: false, stopRun: false, removeQueue: true, reason: result.reason || 'skipped' };
          }
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
