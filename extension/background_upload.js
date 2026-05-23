'use strict';

// Upload/download pipeline and publisher-page runtime listeners.
(function initBackgroundUpload(globalThis) {
  const ACCESS_ENV_ANOMALY_KEY = 'watcherAccessEnvironmentAnomaly';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const LAST_SAGE_TRACE_KEY = 'lastSageTrace';
  const ACCESS_ENV_WINDOW_MS = 15 * 60 * 1000;
  const ACCESS_ENV_THRESHOLD = 3;
  const ACCESS_ENV_DISTINCT_JOURNALS_THRESHOLD = 3;
  const ACCESS_ENV_NOTIFICATION_ICON_URL = 'icons/icon128.png';

  function createBackgroundUploadApi(deps) {
    const {
      chromeApi,
      pendingPublisherTabs,
      defaultOptions,
      htmlDownloadMessage,
      nativeMessageLongTimeoutMs,
      getOptions,
      post,
      makeAbortError,
      abortReason,
      throwIfAborted,
      hostnameOf,
      urlHostPath,
      isScienceDirectUrl,
      extractScienceDirectPii,
      isDoiHost,
      isNatureUrl,
      isRscDirectPdfUrl,
      isRscUrl,
      isSageUrl,
      publisherForUrl,
      isDoiUrl,
      isScienceDirectAssetPdfUrl,
      publisherArticleUrlFromPdfUrl,
      looksLikePdfDownloadUrl,
      isLikelyTargetDownload,
      isExpectedPublisherPage,
      registerPublisherTab,
      unregisterPublisherTab,
      cleanupOrphanPublisherTabs,
      recordJournalAccessResult,
      sendNativeMessage,
      formatBytes,
      formatConfiguredSize,
      makeDownloadFilename,
      basenameOf,
      extensionOf,
      sizeToBytes,
      formatTaskError,
      stripHtml,
      escapeHtml,
      makeDiagnosticBase,
      classifyJournalAccessFailureReason,
      isLikelyRscPayload,
      isExpectedTimeoutFailure,
      formatTimeoutDoneMessage,
      sanitizeDownloadItem,
      saveDiagnostic,
      saveErrorDiagnostic,
      isNonPdfAccessPageError,
      isHtmlDownloadItem,
      stopForNonPdfDownload,
      saveUploadTaskSnapshot,
      clearUploadTaskSnapshot
    } = deps;

    let taskQueue = [];
    let activeTask = null;
    let nextTaskId = 1;

    function shouldTraceSagePending(pending) {
      if (!pending) return false;
      return pending.publisher === 'sage' ||
        isSageUrl(pending.articleUrl || '') ||
        isSageUrl(pending.pdfUrl || '');
    }

    function sanitizeTraceUrl(value) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return {
          host: String(value.host || ''),
          path: String(value.path || '')
        };
      }
      return urlHostPath(value || '');
    }

    async function appendSageTrace(step, details = {}) {
      try {
        const stored = await chromeApi.storage.local.get(LAST_SAGE_TRACE_KEY);
        const current = Array.isArray(stored[LAST_SAGE_TRACE_KEY]) ? stored[LAST_SAGE_TRACE_KEY] : [];
        current.unshift({
          time: new Date().toISOString(),
          step,
          details
        });
        await chromeApi.storage.local.set({
          [LAST_SAGE_TRACE_KEY]: current.slice(0, 120)
        });
      } catch (err) {
        console.warn('[Ablesci PDF Watcher] appendSageTrace failed', err);
      }
    }

    function payloadJournalKey(payload = {}) {
      return String(payload?.journalName || '').trim().toLowerCase();
    }

    function payloadPublisherKey(payload = {}) {
      return String(publisherForUrl(payload?.pdfUrl || payload?.pickedUrl || '') || '').trim().toLowerCase();
    }

    async function notifyAccessEnvironmentAnomaly(message) {
      try {
        await chromeApi.notifications.create({
          type: 'basic',
          iconUrl: ACCESS_ENV_NOTIFICATION_ICON_URL,
          title: 'Ablesci PDF Watcher',
          message,
          priority: 2,
          requireInteraction: true
        });
      } catch (err) {
        console.warn('[Ablesci PDF Watcher] anomaly notification failed', err);
      }
    }

    async function pauseWatcherForAccessEnvironment(payload) {
      const now = Date.now();
      const journalKey = payloadJournalKey(payload);
      const publisherKey = payloadPublisherKey(payload);
      const stored = await chromeApi.storage.local.get([ACCESS_ENV_ANOMALY_KEY, AUTO_WATCHER_STATE_KEY, 'watcherEnabled']);
      const current = stored[ACCESS_ENV_ANOMALY_KEY] || {};
      const recent = Array.isArray(current.events)
        ? current.events.filter(item => item && Number(item.at || 0) > now - ACCESS_ENV_WINDOW_MS)
        : [];
      recent.push({
        at: now,
        journal: journalKey,
        publisher: publisherKey,
        assistId: String(payload?.assistId || '').trim()
      });
      const distinctJournals = new Set(recent.map(item => item.journal).filter(Boolean));
      const distinctPublishers = new Set(recent.map(item => item.publisher).filter(Boolean));
      const shouldPause = recent.length >= ACCESS_ENV_THRESHOLD && distinctJournals.size >= ACCESS_ENV_DISTINCT_JOURNALS_THRESHOLD;
      const nextState = {
        updatedAt: new Date(now).toISOString(),
        events: recent.slice(-10),
        lastPublisher: publisherKey,
        paused: shouldPause
      };
      await chromeApi.storage.local.set({ [ACCESS_ENV_ANOMALY_KEY]: nextState });
      if (!shouldPause) {
        return {
          paused: false,
          count: recent.length,
          distinctJournals: distinctJournals.size,
          distinctPublishers: distinctPublishers.size
        };
      }

      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      state.accessEnvironmentPausedAt = new Date(now).toISOString();
      state.accessEnvironmentPauseReason = 'consecutive_no_access_anomaly';
      state.accessEnvironmentAnomaly = {
        count: recent.length,
        distinctJournals: distinctJournals.size,
        distinctPublishers: distinctPublishers.size,
        publisher: publisherKey
      };
      await chromeApi.storage.local.set({
        watcherEnabled: false,
        [AUTO_WATCHER_STATE_KEY]: state,
        [ACCESS_ENV_ANOMALY_KEY]: nextState
      });
      await chromeApi.alarms.clear('ablesciAutoWatcher');
      const message = `短时间内连续出现 ${recent.length} 次无正文权限，且涉及 ${distinctJournals.size} 个期刊。已暂停值守，请检查代理、登录态或机构访问环境。`;
      await notifyAccessEnvironmentAnomaly(message);
      return {
        paused: true,
        count: recent.length,
        distinctJournals: distinctJournals.size,
        distinctPublishers: distinctPublishers.size,
        message
      };
    }

    async function recordAccessEnvironmentSuccess(payload) {
      const stored = await chromeApi.storage.local.get(ACCESS_ENV_ANOMALY_KEY);
      const current = stored[ACCESS_ENV_ANOMALY_KEY] || {};
      const journalKey = payloadJournalKey(payload);
      const publisherKey = payloadPublisherKey(payload);
      const recent = Array.isArray(current.events)
        ? current.events.filter(item => item && item.journal !== journalKey && item.publisher !== publisherKey)
        : [];
      await chromeApi.storage.local.set({
        [ACCESS_ENV_ANOMALY_KEY]: {
          updatedAt: new Date().toISOString(),
          events: recent.slice(-10),
          lastPublisher: publisherKey,
          paused: false
        }
      });
    }

    async function recordPublisherCfChallenge(pageUrl = '') {
      const opts = await getOptions();
      if (opts.watcherStopOnCfChallenge === false) {
        return { paused: false, streak: 0, threshold: 0, notified: false };
      }
      const stored = await chromeApi.storage.local.get([AUTO_WATCHER_STATE_KEY, 'watcherEnabled']);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      const threshold = Math.max(1, Number(opts.watcherCfPauseThreshold || defaultOptions.watcherCfPauseThreshold || 3));
      state.cfChallengeStreak = Number(state.cfChallengeStreak || 0) + 1;
      const reached = opts.watcherAdvancedSchedulerEnabled === true || state.cfChallengeStreak >= threshold;
      if (reached) {
        state.pausedByCfChallenge = true;
        await chromeApi.storage.local.set({
          watcherEnabled: false,
          [AUTO_WATCHER_STATE_KEY]: state
        });
        await chromeApi.alarms.clear('ablesciAutoWatcher');
      } else {
        await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
      }

      let notified = false;
      if (opts.watcherCfNotificationEnabled !== false) {
        const message = reached
          ? `连续 ${state.cfChallengeStreak} 次遇到出版商验证页，已暂停低频值守。请完成验证后手动重新开启。`
          : `检测到出版商验证页（第 ${state.cfChallengeStreak} 次）。请恢复浏览器窗口并完成验证；达到 ${threshold} 次后会自动暂停值守。`;
        await notifyAccessEnvironmentAnomaly(message);
        notified = true;
      }
      return {
        paused: reached,
        streak: state.cfChallengeStreak,
        threshold,
        notified,
        pageUrl: urlHostPath(pageUrl || '')
      };
    }

    async function clearPublisherCfChallengeState() {
      const stored = await chromeApi.storage.local.get(AUTO_WATCHER_STATE_KEY);
      const state = stored[AUTO_WATCHER_STATE_KEY] || {};
      if (!state.cfChallengeStreak && !state.pausedByCfChallenge) return;
      state.cfChallengeStreak = 0;
      state.pausedByCfChallenge = false;
      await chromeApi.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
    }

    function onceDownloadComplete(downloadId, timeoutMs = 180000, signal = null) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        let statePoller = null;
        let abortListener = null;
        let timedOut = false;

        function cleanup() {
          if (timer) clearTimeout(timer);
          if (statePoller) clearInterval(statePoller);
          if (abortListener && signal) signal.removeEventListener('abort', abortListener);
          chromeApi.downloads.onChanged.removeListener(listener);
        }

        function finishOk(item) {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(item);
        }

        function finishError(msg) {
          if (settled) return;
          settled = true;
          if (timedOut) {
            try { chromeApi.downloads.cancel(downloadId); } catch (_) {}
          }
          cleanup();
          reject(new Error(msg));
        }

        function checkCurrentState() {
          chromeApi.downloads.search({ id: downloadId }, items => {
            if (settled) return;
            const item = items && items[0];
            if (!item) return;
            if (item.state === 'complete') return finishOk(item);
            if (item.state === 'interrupted') return finishError('下载中断：' + (item.error || 'unknown'));
          });
        }

        function listener(delta) {
          if (delta.id !== downloadId) return;
          if (delta.state && delta.state.current === 'complete') {
            chromeApi.downloads.search({ id: downloadId }, items => {
              const item = items && items[0];
              if (!item) return finishError('下载完成但找不到 DownloadItem');
              finishOk(item);
            });
            return;
          }
          if (delta.state && delta.state.current === 'interrupted') {
            chromeApi.downloads.search({ id: downloadId }, items => {
              const item = items && items[0];
              finishError('下载中断：' + (item?.error || 'unknown'));
            });
            return;
          }
          if (delta.error && delta.error.current) finishError('下载失败：' + delta.error.current);
        }

        if (signal) {
          abortListener = () => {
            try { chromeApi.downloads.cancel(downloadId); } catch (_) {}
            finishError(abortReason(signal, '任务已取消，已停止等待下载'));
          };
          if (signal.aborted) {
            abortListener();
            return;
          }
          signal.addEventListener('abort', abortListener, { once: true });
        }

        timer = setTimeout(() => {
          timedOut = true;
          finishError('下载中超时');
        }, timeoutMs);

        chromeApi.downloads.onChanged.addListener(listener);
        checkCurrentState();
        statePoller = setInterval(checkCurrentState, 1000);
      });
    }

    async function downloadByDownloadsAPI(pdfUrl, filenameRel, signal = null, options = {}) {
      throwIfAborted(signal);
      const downloadTimeoutMs = Number(options.downloadTimeoutMs || 5 * 60 * 1000);
      const downloadId = await chromeApi.downloads.download({
        url: pdfUrl,
        filename: filenameRel,
        conflictAction: 'uniquify',
        saveAs: false
      });
      const item = await onceDownloadComplete(downloadId, downloadTimeoutMs, signal);
      item._ablesciCreatedByPlugin = true;
      item._ablesciMatchSource = 'chrome.downloads.download';
      return item;
    }

    async function downloadByBackgroundTab(pdfUrl, options = {}) {
      const noDownloadTimeoutMs = Number(options.noDownloadTimeoutMs || 60 * 1000);
      const downloadTimeoutMs = Number(options.downloadTimeoutMs || 5 * 60 * 1000);
      const signal = options.signal || null;
      return await new Promise(async (resolve, reject) => {
        let tabId = null;
        let downloadId = null;
        let timer = null;
        let abortListener = null;

        function cleanup() {
          if (timer) clearTimeout(timer);
          if (abortListener && signal) signal.removeEventListener('abort', abortListener);
          chromeApi.downloads.onCreated.removeListener(onCreated);
          if (tabId !== null) chromeApi.tabs.remove(tabId).catch(() => {});
        }

        function onCreated(item) {
          if (downloadId !== null) return;
          if (!isLikelyTargetDownload(item, hostnameOf(pdfUrl), pdfUrl)) return;
          downloadId = item.id;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          onceDownloadComplete(downloadId, downloadTimeoutMs, signal)
            .then(item => {
              item._ablesciCreatedByPlugin = true;
              item._ablesciPublisherTabId = tabId;
              item._ablesciMatchSource = 'background_tab';
              cleanup();
              resolve(item);
            })
            .catch(err => { cleanup(); reject(err); });
        }

        try {
          throwIfAborted(signal);
          if (signal) {
            abortListener = () => { cleanup(); reject(makeAbortError(abortReason(signal))); };
            signal.addEventListener('abort', abortListener, { once: true });
          }
          chromeApi.downloads.onCreated.addListener(onCreated);
          const tab = await chromeApi.tabs.create({ url: pdfUrl, active: false });
          tabId = tab.id;
          timer = setTimeout(() => {
            cleanup();
            reject(new Error('未触发 PDF 下载超时；请确认 Chrome 已设置“下载 PDF，而不是在 Chrome 中打开”，或当前账号有权限。'));
          }, noDownloadTimeoutMs);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });
    }

    async function downloadByInteractivePublisherTab(pdfUrl, port, options = {}) {
      const noDownloadTimeoutMs = Number(options.noDownloadTimeoutMs || 60 * 1000);
      const downloadTimeoutMs = Number(options.downloadTimeoutMs || 5 * 60 * 1000);
      const active = options.active !== false;
      const revealAfterMs = Number(options.revealAfterMs || 0);
      const signal = options.signal || null;

      return await new Promise(async (resolve, reject) => {
        let tabId = null;
        let downloadId = null;
        let noDownloadTimer = null;
        let poller = null;
        let settled = false;
        let revealed = active;
        let revealTimer = null;
        let abortListener = null;
        let sourceUrlForMatching = pdfUrl;
        let expectedHost = hostnameOf(sourceUrlForMatching);
        let downloadArmed = looksLikePdfDownloadUrl(pdfUrl);
        let noDownloadTimeoutMessage = '未触发 PDF 下载超时；可能没有通过验证、没有权限，Chrome 没有设置为直接下载 PDF，或下载记录被清理。';
        const articleUrl = publisherArticleUrlFromPdfUrl(pdfUrl);
        const startedAfter = new Date(Date.now() - 2000).toISOString();
        const seenIds = new Set();

        function cleanup(closeTab = true) {
          if (noDownloadTimer) clearTimeout(noDownloadTimer);
          if (poller) clearInterval(poller);
          if (revealTimer) clearTimeout(revealTimer);
          if (abortListener && signal) signal.removeEventListener('abort', abortListener);
          chromeApi.downloads.onCreated.removeListener(onCreated);
          if (tabId !== null) {
            pendingPublisherTabs.delete(tabId);
            unregisterPublisherTab(tabId).catch(() => {});
            if (closeTab) chromeApi.tabs.remove(tabId).catch(() => {});
          }
        }

        function finishOk(item) {
          if (settled) return;
          settled = true;
          cleanup(true);
          resolve(item);
        }

        function finishError(err) {
          if (settled) return;
          settled = true;
          cleanup(true);
          reject(err instanceof Error ? err : new Error(String(err)));
        }

        function revealPublisherTab(reason) {
          if (settled || tabId === null || revealed) return;
          revealed = true;
          chromeApi.tabs.get(tabId).then(tab => {
            const windowId = tab?.windowId;
            if (Number.isInteger(windowId) && chromeApi.windows?.update) {
              return chromeApi.windows.update(windowId, { focused: true, state: 'normal' })
                .catch(() => null)
                .then(() => chromeApi.tabs.update(tabId, { active: true }).catch(() => {}));
            }
            return chromeApi.tabs.update(tabId, { active: true }).catch(() => {});
          }).catch(() => {
            chromeApi.tabs.update(tabId, { active: true }).catch(() => {});
          });
          post(port, 'progress', reason || '后台静默等待较久，已切到出版商标签页；如有验证，请完成后插件会继续。');
        }

        function armNoDownloadTimer(timeoutMs, message) {
          if (noDownloadTimer) clearTimeout(noDownloadTimer);
          noDownloadTimeoutMessage = message || noDownloadTimeoutMessage;
          noDownloadTimer = setTimeout(() => {
            finishError(new Error(noDownloadTimeoutMessage));
          }, timeoutMs);
        }

        function acceptCandidate(item, source) {
          if (settled || !item || seenIds.has(item.id)) return;
          if (!downloadArmed) return;
          if (isHtmlDownloadItem(item)) return;
          if (tabId !== null && Number.isInteger(item.tabId) && item.tabId >= 0 && item.tabId !== tabId) return;
          if (!isLikelyTargetDownload(item, expectedHost, sourceUrlForMatching)) return;
          seenIds.add(item.id);
          if (shouldTraceSagePending(pendingPublisherTabs.get(tabId))) {
            void appendSageTrace('download_created', {
              downloadId: item.id,
              url: sanitizeTraceUrl(item.url || ''),
              finalUrl: sanitizeTraceUrl(item.finalUrl || ''),
              filename: item.filename || '',
              mime: item.mime || '',
              state: item.state || '',
              error: item.error || '',
              matchSource: source
            });
          }
          downloadId = item.id;
          if (noDownloadTimer) {
            clearTimeout(noDownloadTimer);
            noDownloadTimer = null;
          }
          post(port, 'progress', `检测到浏览器下载 #${item.id}（${source}），等待完成...`);
          onceDownloadComplete(downloadId, downloadTimeoutMs, signal)
            .then(item => {
              item._ablesciCreatedByPlugin = true;
              item._ablesciPublisherTabId = tabId;
              item._ablesciMatchSource = source;
              if (shouldTraceSagePending(pendingPublisherTabs.get(tabId))) {
                void appendSageTrace('download_changed', {
                  downloadId: item.id,
                  url: sanitizeTraceUrl(item.url || ''),
                  finalUrl: sanitizeTraceUrl(item.finalUrl || ''),
                  filename: item.filename || '',
                  mime: item.mime || '',
                  state: item.state || '',
                  error: item.error || '',
                  matchSource: source
                });
              }
              finishOk(item);
            })
            .catch(err => {
              if (shouldTraceSagePending(pendingPublisherTabs.get(tabId))) {
                void appendSageTrace('download_changed', {
                  downloadId: item.id,
                  url: sanitizeTraceUrl(item.url || ''),
                  finalUrl: sanitizeTraceUrl(item.finalUrl || ''),
                  filename: item.filename || '',
                  mime: item.mime || '',
                  state: item.state || '',
                  error: err?.message || String(err),
                  matchSource: source
                });
              }
              finishError(err);
            });
        }

        function onCreated(item) {
          acceptCandidate(item, 'onCreated');
        }

        async function pollDownloads() {
          if (settled) return;
          const items = await chromeApi.downloads.search({ startedAfter, orderBy: ['-startTime'], limit: 20 });
          for (const item of items) {
            acceptCandidate(item, 'poll');
            if (downloadId !== null) break;
          }
        }

        try {
          throwIfAborted(signal);
          if (signal) {
            abortListener = () => finishError(makeAbortError(abortReason(signal)));
            signal.addEventListener('abort', abortListener, { once: true });
          }
          chromeApi.downloads.onCreated.addListener(onCreated);
          const tab = await chromeApi.tabs.create({ url: articleUrl, active });
          tabId = tab.id;
          pendingPublisherTabs.set(tabId, {
            pdfUrl,
            articleUrl,
            createdAt: Date.now(),
            port,
            finishError,
            revealPublisherTab,
            payloadSummary: {
              assistId: options.payload?.assistId || '',
              doi: options.payload?.doi || '',
              journalName: options.payload?.journalName || '',
              title: options.payload?.title || options.payload?.suggestedFilename || ''
            },
            publisher: publisherForUrl(articleUrl),
            lastNativePdfUrl: '',
            extendNoDownloadTimeout(timeoutMs, message) {
              armNoDownloadTimer(timeoutMs, message);
            },
            armDownloadCapture(url) {
              if (url) {
                sourceUrlForMatching = url;
                expectedHost = hostnameOf(sourceUrlForMatching);
              }
              downloadArmed = true;
            },
            setExpectedDownloadUrl(url) {
              sourceUrlForMatching = url || sourceUrlForMatching;
              expectedHost = hostnameOf(sourceUrlForMatching);
              if (looksLikePdfDownloadUrl(sourceUrlForMatching)) downloadArmed = true;
            }
          });
          if (publisherForUrl(articleUrl) === 'sage' || /sage/i.test(String(options.payload?.journalName || ''))) {
            void appendSageTrace('opened_sage_tab', {
              tabId,
              initialUrl: sanitizeTraceUrl(articleUrl)
            });
          }
          registerPublisherTab(tabId, { pdfUrl, articleUrl, reason: 'interactive_publisher_tab' }).catch(() => {});

          if (active) {
            post(port, 'progress', '已打开可见出版商页面。若出现验证页，请在新标签页完成验证；进入文章页后插件会查找原生 View PDF 入口。');
          } else if (revealAfterMs > 0) {
            post(port, 'progress', `已用后台静默标签页打开出版商页面；${Math.round(revealAfterMs / 1000)} 秒内若未触发下载，会自动切到前台供你验证。`);
            revealTimer = setTimeout(() => revealPublisherTab('出版商页面后台静默等待较久，已切到前台；如有验证，请完成后插件会继续监听下载。'), revealAfterMs);
          } else {
            post(port, 'progress', '已用后台静默标签页打开出版商页面；不会主动切到前台。');
          }
          post(port, 'progress', '正在等待浏览器下载事件；如果 PDF 已经下载但无后续进度，会通过轮询下载记录继续接管。');

          poller = setInterval(pollDownloads, 1000);
          setTimeout(pollDownloads, 500);
          setTimeout(pollDownloads, 2000);

          armNoDownloadTimer(noDownloadTimeoutMs, noDownloadTimeoutMessage);
        } catch (err) {
          finishError(err);
        }
      });
    }

    async function downloadPdf(pdfUrl, suggestedFilename, opts, port, signal = null) {
      const filenameRel = makeDownloadFilename(opts.downloadSubdir, suggestedFilename);
      const mode = opts.downloadMode || 'auto';
      const noDownloadTimeoutMs = Math.max(1000, Number(opts.watcherNoDownloadTimeoutMinutes || defaultOptions.watcherNoDownloadTimeoutMinutes) * 60 * 1000);
      const downloadTimeoutMs = Math.max(1000, Number(opts.watcherDownloadTimeoutMinutes || defaultOptions.watcherDownloadTimeoutMinutes) * 60 * 1000);
      const timeoutOptions = { noDownloadTimeoutMs, downloadTimeoutMs, signal };

      if (isScienceDirectUrl(pdfUrl) || isDoiUrl(pdfUrl)) {
        const sdMode = opts.scienceDirectTabMode || 'silent_then_visible';
        const label = isDoiUrl(pdfUrl) ? 'DOI 跳转' : 'ScienceDirect';
        if (mode === 'publisher_tab' || sdMode === 'visible') {
          post(port, 'progress', `${label} 使用可见出版商页面模式。`);
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
        }
        if (mode === 'background_tab' || sdMode === 'silent') {
          post(port, 'progress', `${label} 使用后台静默出版商页面模式。`);
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs: 0, payload: opts.payloadContext || null });
        }
        post(port, 'progress', `${label} 使用后台静默出版商页面模式；如 30 秒内未触发下载，会自动切到前台。`);
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs: 30000, payload: opts.payloadContext || null });
      }

      if (isNatureUrl(pdfUrl)) {
        if (mode === 'publisher_tab') {
          post(port, 'progress', 'Nature 使用可见文章页原生 PDF 下载模式。');
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
        }
        post(port, 'progress', 'Nature 使用后台文章页原生 PDF 下载模式；如 30 秒内未触发下载，会自动切到前台。');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs: 30000, payload: opts.payloadContext || null });
      }

      if (isRscDirectPdfUrl(pdfUrl)) {
        post(port, 'progress', 'RSC articlepdf 使用 chrome.downloads 直接下载。');
        return await downloadByDownloadsAPI(pdfUrl, filenameRel, signal, { downloadTimeoutMs });
      }

      if (isRscUrl(pdfUrl)) {
        if (mode === 'publisher_tab') {
          post(port, 'progress', 'RSC 使用可见文章页原生 PDF 下载模式。');
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
        }
        post(port, 'progress', 'RSC 使用后台文章页原生 PDF 下载模式；如 30 秒内未触发下载，会自动切到前台。');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs: 30000, payload: opts.payloadContext || null });
      }

      if (mode === 'publisher_tab') {
        post(port, 'progress', '通过可见出版商标签页触发下载...');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
      }
      if (mode === 'background_tab') {
        post(port, 'progress', '通过后台标签页触发下载...');
        return await downloadByBackgroundTab(pdfUrl, timeoutOptions);
      }
      if (mode === 'chrome_downloads') {
        post(port, 'progress', '通过 chrome.downloads 下载...');
        return await downloadByDownloadsAPI(pdfUrl, filenameRel, signal, { downloadTimeoutMs });
      }

      try {
        post(port, 'progress', '通过 chrome.downloads 下载...');
        return await downloadByDownloadsAPI(pdfUrl, filenameRel, signal, { downloadTimeoutMs });
      } catch (err) {
        post(port, 'progress', '直接下载失败，尝试后台标签页：' + (err.message || err));
        return await downloadByBackgroundTab(pdfUrl, timeoutOptions);
      }
    }

    async function uploadRequest(payload, stat) {
      const body = new URLSearchParams();
      body.set(payload.csrfParam || '_csrf', payload.csrfToken);
      body.set('assist_id', payload.assistId);
      body.set('filename', stat.filename);
      body.set('file_md5', stat.md5);
      body.set('filesize', String(stat.size));

      const resp = await fetch('https://www.ablesci.com/assist/upload-request?t=' + Date.now(), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body
      });
      const raw = await resp.text();
      let data;
      try { data = JSON.parse(raw); } catch (_) { throw new Error('upload-request 返回不是 JSON：' + raw.slice(0, 200)); }
      if (!resp.ok) throw new Error('upload-request HTTP ' + resp.status + '：' + (data.msg || raw.slice(0, 200)));
      return data;
    }

    function isRecommendResponse(res) {
      return res && (res.recomend === 1 || res.recomend === '1' || res.recommend === 1 || res.recommend === '1');
    }

    function postDoneFromSiteResponse(port, res, fallbackMsg) {
      const rawHtml = res && res.msg ? String(res.msg) : (fallbackMsg || '上传成功');
      post(port, 'done', stripHtml(rawHtml), {
        html: rawHtml,
        recomend: isRecommendResponse(res),
        reload: true,
        responseCode: res && res.code
      });
    }

    function isAssistStateChangedMessage(text) {
      const plain = stripHtml(text || '');
      return /该求助状态已经发生改变|请刷新页面查看或下载|已经有人上传了文献|请等待求助人确认|待确认|已完成|已关闭|不在求助中|已被修改状态|状态.*发生改变/.test(plain);
    }

    function postAssistStateChangedDone(port, text) {
      const plain = stripHtml(text || '该求助状态已经发生改变，请刷新页面查看或下载。');
      post(port, 'done', plain, {
        html: escapeHtml(plain),
        recomend: false,
        reload: true,
        blocked: true,
        stateChanged: true
      });
    }

    function downloadOnlyDone(port, reasons, stat) {
      const reasonText = Array.isArray(reasons) && reasons.length ? reasons.join('；') : '当前任务需要人工核对';
      post(port, 'done', `已仅下载并校验 PDF，未自动上传。${reasonText}`, {
        html: `已仅下载并校验 PDF，未自动上传。<br>原因：${escapeHtml(reasonText)}<br>文件：${escapeHtml(stat?.filename || 'paper.pdf')}`,
        recomend: false,
        reload: false,
        downloadOnly: true
      });
    }

    function debugDownloadOnlyDone(port, stat) {
      const name = stat?.filename || basenameOf(stat?.path || '') || 'paper.pdf';
      const message = `调试模式已开启，未自动上传。准备上传文件：${name}`;
      post(port, 'done', message, {
        html: escapeHtml(message),
        recomend: false,
        reload: false,
        downloadOnly: true,
        debugOnly: true
      });
    }

    function normalizeOSSData(data) {
      const d = data || {};
      return {
        host: d.host,
        key: d.key || ((d.dir || '') + (d.randFilename || '')),
        policy: d.policy,
        accessid: d.accessid || d.OSSAccessKeyId,
        signature: d.signature,
        callback: d.callback,
        assist_id: d.assist_id,
        user_id: d.user_id,
        filename: d.filename,
        dir: d.dir,
        randFilename: d.randFilename
      };
    }

    async function handleUpload(port, payload, signal = null, optsOverride = null) {
      throwIfAborted(signal);
      const opts = optsOverride || await getOptions();
      const diag = makeDiagnosticBase(payload, opts);
      const traceSage = isSageUrl(payload?.pickedUrl || '') ||
        isSageUrl(payload?.pdfUrl || '') ||
        /sage/i.test(String(payload?.journalName || ''));

      if (!payload?.pdfUrl) {
        await saveDiagnostic({ ...diag, stage: 'skipped-missing-pdf-url', error: '缺少 pdfUrl，已按信息不全跳过' });
        post(port, 'done', '当前求助缺少可识别的 PDF 链接，已按信息不全跳过；不会下载或上传。', {
          html: '当前求助缺少可识别的 PDF 链接，已按信息不全跳过；不会下载或上传。',
          recomend: false,
          reload: false,
          downloadOnly: true,
          skipped: true,
          skipReason: 'missing_pdf_url'
        });
        return;
      }
      if (!payload?.assistId) throw new Error('缺少 assistId');
      if (!payload?.csrfToken) throw new Error('缺少 csrfToken');

      if (payload.downloadOnly) {
        const reasons = Array.isArray(payload.riskReasons) && payload.riskReasons.length ? payload.riskReasons.join('；') : '当前求助需要人工核对';
        post(port, 'progress', `当前任务命中仅下载保护：${reasons}；下载完成后不会自动提交。`);
      }

      await saveDiagnostic({ ...diag, stage: 'picked' });
      post(port, 'progress', 'PDF URL：' + payload.pdfUrl);
      if (traceSage) {
        await appendSageTrace('upload_started', {
          filename: payload.suggestedFilename || '',
          error: '',
          pdfUrl: sanitizeTraceUrl(payload.pdfUrl || ''),
          pickedUrl: sanitizeTraceUrl(payload.pickedUrl || '')
        });
      }
      const item = await downloadPdf(payload.pdfUrl, payload.suggestedFilename || 'paper.pdf', { ...opts, payloadContext: payload }, port, signal);
      throwIfAborted(signal);
      if (!item.filename) throw new Error('下载完成但没有得到本地文件路径');

      const downloadMeta = sanitizeDownloadItem(item);
      await saveDiagnostic({ ...diag, stage: 'download-complete', downloadItem: downloadMeta });
      if (isHtmlDownloadItem(item)) {
        await stopForNonPdfDownload(port, diag, item, downloadMeta, 'blocked-html-download', htmlDownloadMessage, opts);
        return;
      }

      post(port, 'progress', '下载完成，调用本地 Helper 校验 PDF 和计算 MD5...');
      throwIfAborted(signal);
      let stat;
      try {
        stat = await sendNativeMessage(opts.nativeHostName, {
          action: 'stat_pdf',
          path: item.filename,
          move_to_dir: opts.moveToDir || ''
        }, nativeMessageLongTimeoutMs);
      } catch (err) {
        if (isNonPdfAccessPageError(err)) {
          await stopForNonPdfDownload(port, diag, item, downloadMeta, 'blocked-non-pdf-download', formatTaskError(err), opts);
          return;
        }
        throw err;
      }

      throwIfAborted(signal);
      if (!opts.keepDownloadHistory) {
        try { await chromeApi.downloads.erase({ id: item.id }); } catch (_) {}
      }
      await saveDiagnostic({
        ...diag,
        stage: 'pdf-validated',
        downloadItem: downloadMeta,
        file: {
          filename: stat.filename || basenameOf(stat.path || ''),
          extension: extensionOf(stat.filename || stat.path || ''),
          size: Number(stat.size || 0)
        }
      });
      post(port, 'progress', `PDF 校验通过：${stat.filename}，${formatBytes(stat.size)}，MD5=${stat.md5}`);
      const downloadOnlyReasons = Array.isArray(payload.riskReasons) && payload.riskReasons.length ? payload.riskReasons.slice() : [];
      const size = Number(stat.size || 0);
      if (opts.debugDownloadOnly) {
        await saveDiagnostic({
          ...diag,
          stage: 'debug-download-only',
          downloadItem: downloadMeta,
          file: {
            filename: stat.filename || basenameOf(stat.path || ''),
            extension: extensionOf(stat.filename || stat.path || ''),
            size,
            md5: stat.md5 || ''
          },
          message: 'debug mode: download and validate only; upload-request and OSS upload skipped'
        });
        post(port, 'progress', `调试模式：准备上传文件 ${stat.filename}，${formatBytes(size)}，MD5=${stat.md5}；已跳过自动上传。`);
        debugDownloadOnlyDone(port, stat);
        return;
      }

      const minAutoUploadBytes = sizeToBytes(opts.minAutoUploadMB, opts.minAutoUploadUnit, defaultOptions.minAutoUploadMB, defaultOptions.minAutoUploadUnit);
      const maxAutoUploadBytes = sizeToBytes(opts.maxAutoUploadMB, opts.maxAutoUploadUnit, defaultOptions.maxAutoUploadMB, defaultOptions.maxAutoUploadUnit);
      if (size > 0 && minAutoUploadBytes > 0 && size < minAutoUploadBytes) {
        downloadOnlyReasons.push(`PDF 文件小于 ${formatConfiguredSize(opts.minAutoUploadMB || defaultOptions.minAutoUploadMB, opts.minAutoUploadUnit || defaultOptions.minAutoUploadUnit)}（当前 ${formatBytes(size)}），已改为仅下载。`);
        await saveDiagnostic({ ...diag, stage: 'download-only-small-file', downloadItem: downloadMeta, fileSize: size });
        downloadOnlyDone(port, downloadOnlyReasons, stat);
        return;
      }
      if (size > 0 && maxAutoUploadBytes > 0 && size > maxAutoUploadBytes) {
        downloadOnlyReasons.push(`PDF 文件大于 ${formatConfiguredSize(opts.maxAutoUploadMB || defaultOptions.maxAutoUploadMB, opts.maxAutoUploadUnit || defaultOptions.maxAutoUploadUnit)}（当前 ${formatBytes(size)}），超过自动上传范围，已改为仅下载。`);
        await saveDiagnostic({ ...diag, stage: 'download-only-large-file', downloadItem: downloadMeta, fileSize: size });
        downloadOnlyDone(port, downloadOnlyReasons, stat);
        return;
      }

      if (payload.downloadOnly) {
        await saveDiagnostic({ ...diag, stage: 'download-only-risk', downloadItem: downloadMeta, fileSize: size, reasons: downloadOnlyReasons });
        downloadOnlyDone(port, downloadOnlyReasons.length ? downloadOnlyReasons : ['当前求助需要人工核对'], stat);
        return;
      }

      const permit = await uploadRequest(payload, stat);
      console.log('[Ablesci PDF Uploader] upload-request code', permit && permit.code);

      if (permit.code === 10) {
        if (opts.deleteAfterUpload) {
          try { await sendNativeMessage(opts.nativeHostName, { action: 'delete_file', path: stat.path }); } catch (e) { console.warn(e); }
        }
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        await recordJournalAccessResult(payload, { ok: true });
        if (traceSage) {
          await appendSageTrace('upload_success', {
            filename: stat.filename || '',
            error: ''
          });
        }
        postDoneFromSiteResponse(port, permit, '上传成功');
        return;
      }

      if (permit.code !== 0) {
        if (isAssistStateChangedMessage(permit.msg || '')) {
          await saveDiagnostic({ ...diag, stage: 'assist-state-changed-before-upload', downloadItem: downloadMeta, fileSize: size });
          postAssistStateChangedDone(port, permit.msg || '该求助状态已经发生改变，请刷新页面查看或下载。');
          return;
        }
        throw new Error(stripHtml(permit.msg || 'upload-request 未允许上传'));
      }

      throwIfAborted(signal);
      post(port, 'progress', '开始上传到 OSS...');
      const oss = normalizeOSSData(permit.data);
      const ossRes = await sendNativeMessage(opts.nativeHostName, {
        action: 'upload_oss',
        path: stat.path,
        move_to_dir: opts.moveToDir || '',
        csrf_param: payload.csrfParam || '_csrf',
        csrf_token: payload.csrfToken,
        assist_id: payload.assistId,
        oss
      }, nativeMessageLongTimeoutMs);

      let parsed = null;
      try { parsed = JSON.parse(ossRes.body || '{}'); } catch (_) {}
      if (parsed && parsed.code === 1) {
        if (isAssistStateChangedMessage(parsed.msg || '')) {
          await saveDiagnostic({ ...diag, stage: 'assist-state-changed-after-upload', downloadItem: downloadMeta, fileSize: size });
          postAssistStateChangedDone(port, parsed.msg || '该求助状态已经发生改变，请刷新页面查看或下载。');
          return;
        }
        throw new Error(stripHtml(parsed.msg || 'OSS 回调返回上传失败'));
      }
      if (opts.deleteAfterUpload) {
        try { await sendNativeMessage(opts.nativeHostName, { action: 'delete_file', path: stat.path }); } catch (e) { console.warn(e); }
      }
      if (parsed && parsed.msg) {
        await saveDiagnostic({ ...diag, stage: 'uploaded', downloadItem: downloadMeta, fileSize: size });
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        await recordJournalAccessResult(payload, { ok: true });
        if (traceSage) {
          await appendSageTrace('upload_success', {
            filename: stat.filename || '',
            error: ''
          });
        }
        postDoneFromSiteResponse(port, parsed, '上传成功');
      } else {
        await saveDiagnostic({ ...diag, stage: 'uploaded', downloadItem: downloadMeta, fileSize: size });
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        await recordJournalAccessResult(payload, { ok: true });
        if (traceSage) {
          await appendSageTrace('upload_success', {
            filename: stat.filename || '',
            error: ''
          });
        }
        post(port, 'done', 'OSS 上传完成，请检查 Ablesci 页面状态。', {
          html: 'OSS 上传完成，请检查 Ablesci 页面状态。',
          recomend: false,
          reload: true
        });
      }
    }

    function uploadLabel(payload) {
      const id = payload?.assistId || '';
      const doi = payload?.doi || '';
      const title = payload?.suggestedFilename || '';
      return [id, doi || title].filter(Boolean).join(' / ') || '当前任务';
    }

    function removeQueuedTask(task) {
      const idx = taskQueue.indexOf(task);
      if (idx >= 0) taskQueue.splice(idx, 1);
    }

    function cancelTask(task, reason, options = {}) {
      if (!task || task.cancelled) return;
      task.cancelled = true;
      task.cancelReason = reason || '任务已取消';
      task.silentCancel = options.silent === true;
      removeQueuedTask(task);
      clearUploadTaskSnapshot(task).catch(() => {});
      if (activeTask === task && task.abortController) {
        try { task.abortController.abort(task.cancelReason); } catch (_) {}
      }
      cleanupOrphanPublisherTabs('task_cancelled').catch(() => {});
    }

    function processQueue() {
      if (activeTask) return;
      while (taskQueue.length && taskQueue[0].cancelled) taskQueue.shift();
      const task = taskQueue.shift();
      if (!task) return;

      activeTask = task;
      const { port, payload, label, abortController } = task;

      (async () => {
        post(port, 'progress', `开始处理任务：${label}`);
        task.startedAt = task.startedAt || new Date().toISOString();
        await saveUploadTaskSnapshot(task, 'running').catch(() => {});
        let opts = null;
        let taskTimer = null;
        try {
          opts = await getOptions();
          const taskTimeoutMs = Math.max(1000, Number(opts.watcherTaskTimeoutMinutes || defaultOptions.watcherTaskTimeoutMinutes) * 60 * 1000);
          taskTimer = setTimeout(() => {
            cancelTask(task, `任务总超时：${label} 已超过 ${opts.watcherTaskTimeoutMinutes} 分钟`, { silent: false });
          }, taskTimeoutMs);
          await handleUpload(port, payload, abortController.signal, opts);
        } catch (err) {
          const traceSage = isSageUrl(payload?.pickedUrl || '') ||
            isSageUrl(payload?.pdfUrl || '') ||
            /sage/i.test(String(payload?.journalName || ''));
          if (traceSage) {
            await appendSageTrace('upload_failed', {
              filename: payload?.suggestedFilename || '',
              error: err?.message || String(err)
            });
          }
          let failureReason = classifyJournalAccessFailureReason(err);
          if (failureReason === 'download_not_triggered_timeout' && isDoiUrl(payload?.pdfUrl) && isLikelyRscPayload(payload)) {
            failureReason = 'doi_resolution_failed';
          }
          let accessEnvironmentPause = null;
          if (failureReason === 'no_access' || failureReason === 'explicit_no_subscription') {
            accessEnvironmentPause = await pauseWatcherForAccessEnvironment(payload);
          }
          if (failureReason && failureReason !== 'login_required' && failureReason !== 'cf_challenge') {
            await recordJournalAccessResult(payload, { ok: false, reason: failureReason });
          }

          if (!task.cancelled || !task.silentCancel) {
            await saveErrorDiagnostic(payload, err);
            if (isNonPdfAccessPageError(err)) {
              post(port, 'done', htmlDownloadMessage, {
                html: escapeHtml(htmlDownloadMessage),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true
              });
            } else if (failureReason === 'login_required') {
              const message = 'ScienceDirect 需要登录或机构访问后才能继续。插件已保留这次为登录阻塞，不计入无权限期刊；完成登录后可重新触发。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'login_required'
              });
            } else if (failureReason === 'cf_challenge') {
              const message = /暂停低频值守/.test(formatTaskError(err))
                ? formatTaskError(err)
                : '检测到出版商验证页，已中断本次任务并计入验证次数；达到阈值后会自动暂停低频值守。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'cf_challenge'
              });
            } else if (failureReason === 'no_access' || failureReason === 'explicit_no_subscription') {
              const message = accessEnvironmentPause?.paused
                ? accessEnvironmentPause.message
                : '当前出版商页面显示无正文订阅权限，已跳过本次任务并记录期刊权限状态。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'no_access'
              });
            } else if (isExpectedTimeoutFailure(failureReason)) {
              const message = formatTimeoutDoneMessage(err, failureReason);
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                timeout: true,
                timeoutReason: failureReason
              });
            } else {
              console.error('[Ablesci PDF Uploader Error]', err);
              post(port, 'error', formatTaskError(err));
            }
          }
        } finally {
          if (taskTimer) clearTimeout(taskTimer);
          await clearUploadTaskSnapshot(task);
          if (activeTask === task) activeTask = null;
          cleanupOrphanPublisherTabs('task_finished').catch(() => {});
          processQueue();
        }
      })();
    }

    function enqueueUpload(port, payload) {
      const label = uploadLabel(payload);
      const task = {
        id: nextTaskId++,
        port,
        payload,
        label,
        startedAt: new Date().toISOString(),
        cancelled: false,
        cancelReason: '',
        abortController: new AbortController()
      };

      const hadActiveOrQueued = !!activeTask || taskQueue.length > 0;
      if (hadActiveOrQueued) {
        post(port, 'progress', `已有 PDF 上传任务正在处理（${activeTask?.label || '队列中'}），当前任务已进入队列。为避免多个页面下载错配，插件会按点击顺序逐个处理。关闭本 Ablesci 页面会自动取消该任务。`);
      }

      port.onDisconnect.addListener(() => {
        cancelTask(task, `Ablesci 页面已关闭或刷新，取消任务：${label}`, { silent: true });
        processQueue();
      });

      taskQueue.push(task);
      processQueue();
    }

    function handlePublisherTabUpdated(tabId, changeInfo, tab) {
      const pending = pendingPublisherTabs.get(tabId);
      if (!pending) return;
      const url = changeInfo.url || tab?.url || '';
      if (!url) return;
      if (shouldTraceSagePending(pending) || isSageUrl(url)) {
        void appendSageTrace('sage_tab_updated', {
          tabId,
          url: sanitizeTraceUrl(url),
          status: changeInfo.status || tab?.status || ''
        });
      }

      const expectedHost = hostnameOf(pending.articleUrl || pending.pdfUrl || '');
      if (isDoiHost(expectedHost) && (isScienceDirectUrl(url) || isNatureUrl(url) || isRscUrl(url) || isSageUrl(url))) {
        pending.articleUrl = url;
        pending.publisher = isScienceDirectUrl(url)
          ? 'sciencedirect'
          : (isNatureUrl(url) ? 'nature' : (isRscUrl(url) ? 'rsc' : 'sage'));
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(url);
        return;
      }

      if (isScienceDirectAssetPdfUrl(url)) {
        const expectedPii = extractScienceDirectPii(pending.articleUrl || pending.pdfUrl || '');
        const actualPii = extractScienceDirectPii(url);
        if (expectedPii && actualPii && expectedPii !== actualPii) {
          pending.finishError?.(new Error(`ScienceDirect PDF PII 不匹配：期望 ${expectedPii}，实际 ${actualPii}`));
          return;
        }
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(url);
        pending.lastNativePdfUrl = url;
      }
    }

    function handlePublisherRuntimeMessage(msg, sender, sendResponse) {
      const tabId = sender.tab && sender.tab.id;
      const pending = tabId != null ? pendingPublisherTabs.get(tabId) : null;

      if (msg?.type === 'ablesciSageTrace') {
        void appendSageTrace(msg.step || 'sage_trace', {
          tabId: Number.isInteger(tabId) ? tabId : null,
          url: sanitizeTraceUrl(msg.url || sender.tab?.url || ''),
          status: msg.status || '',
          selector: msg.selector || '',
          buttonText: msg.buttonText || '',
          candidateCount: Number(msg.candidateCount || 0),
          foundDataIdButton: msg.foundDataIdButton === true,
          foundAriaPdfButton: msg.foundAriaPdfButton === true,
          runtimeLastError: msg.runtimeLastError || '',
          action: msg.action || ''
        });
        sendResponse({ ok: true });
        return false;
      }

      if (msg?.type === 'ablesciPublisherCanControl') {
        if (!pending) return sendResponse({ ok: false, reason: 'no pending publisher task for this tab' });
        if (msg.publisher && pending.publisher && msg.publisher !== pending.publisher) return sendResponse({ ok: false, reason: 'publisher mismatch' });
        if (!isExpectedPublisherPage(pending, msg.pageUrl || '')) return sendResponse({ ok: false, reason: 'publisher page mismatch' });
        return sendResponse({ ok: true });
      }

      if (!msg || msg.type !== 'ablesciPublisherArticleReady') return false;
      if (!pending) {
        sendResponse({ ok: false, ignored: true, reason: 'no pending publisher task' });
        return false;
      }
      if (msg.publisher === 'sage') {
        void appendSageTrace('content_script_ready', {
          tabId: Number.isInteger(tabId) ? tabId : null,
          url: sanitizeTraceUrl(msg.pageUrl || sender.tab?.url || ''),
          action: msg.source || ''
        });
      }
      if (!isExpectedPublisherPage(pending, msg.pageUrl || '')) {
        sendResponse({ ok: false, ignored: true, reason: 'publisher page mismatch' });
        return false;
      }

      if (msg.publisher === 'sciencedirect' && msg.noSubscription) {
        pending.finishError(new Error('ScienceDirect 明确返回无正文订阅权限（does not subscribe to this content on ScienceDirect）。'));
        sendResponse({ ok: true, action: 'science_direct_no_subscription' });
        return false;
      }
      if (msg.publisherChallenge) {
        if (pending.publisherChallengeSeen) {
          sendResponse({ ok: true, ignored: true, reason: 'same publisher challenge already handled' });
          return false;
        }
        pending.publisherChallengeSeen = true;
        recordPublisherCfChallenge(msg.pageUrl || pending.articleUrl || pending.pdfUrl || '')
          .then(result => {
            pending.revealPublisherTab?.('检测到出版商验证页，已尝试恢复浏览器窗口并切到前台；请完成验证。');
            if (result.paused) {
              pending.finishError(new Error(`检测到出版商验证页，连续达到阈值 ${result.threshold}，已暂停低频值守。`));
              return;
            }
            pending.extendNoDownloadTimeout?.(
              5 * 60 * 1000,
              '等待出版商验证超时；请完成验证后重新触发，或检查浏览器是否被最小化。'
            );
            post(pending.port, 'progress', `检测到出版商验证页，已计入第 ${result.streak} 次验证并延长等待。`);
          })
          .catch(err => {
            console.warn('[Ablesci PDF Watcher] record publisher challenge failed', err);
            pending.revealPublisherTab?.('检测到出版商验证页，已切到前台；请完成验证。');
            pending.extendNoDownloadTimeout?.(
              5 * 60 * 1000,
              '等待出版商验证超时；请完成验证后重新触发，或检查浏览器是否被最小化。'
            );
          });
        sendResponse({ ok: true, action: 'publisher_challenge_detected' });
        return false;
      }
      if (msg.publisher === 'sciencedirect' && msg.error) {
        pending.finishError(new Error(msg.error));
        sendResponse({ ok: true, action: 'science_direct_error' });
        return false;
      }
      if (msg.publisher === 'sciencedirect' && msg.loginRequired) {
        pending.revealPublisherTab?.('ScienceDirect 需要登录或机构访问，已切到前台；完成登录后插件会继续查找 PDF。');
        pending.extendNoDownloadTimeout?.(
          5 * 60 * 1000,
          '等待 ScienceDirect 登录/机构访问超时；请完成登录后重新触发，或检查当前浏览器是否已具备正文访问权限。'
        );
        post(pending.port, 'progress', '检测到 ScienceDirect 需要登录或机构访问，已延长等待时间。');
        sendResponse({ ok: true, action: 'science_direct_login_required' });
        return false;
      }
      if (msg.publisher === 'sciencedirect' && msg.clicked) {
        pending.armDownloadCapture?.(pending.lastNativePdfUrl || pending.pdfUrl || pending.articleUrl || '');
        post(pending.port, 'progress', '已在 ScienceDirect 页面触发原生 View PDF 按钮，继续监听浏览器下载。');
        sendResponse({ ok: true, action: 'clicked_native_view_pdf' });
        return false;
      }
      if (msg.publisher === 'sciencedirect' && msg.pdfUrl) {
        if (pending.lastNativePdfUrl === msg.pdfUrl) {
          sendResponse({ ok: true, ignored: true, reason: 'same native pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        post(pending.port, 'progress', '已从 ScienceDirect 原生 View PDF 入口取得下载链接，正在打开该链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'nature' && msg.pdfUrl) {
        if (pending.lastNativePdfUrl === msg.pdfUrl) {
          sendResponse({ ok: true, ignored: true, reason: 'same native pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        if (msg.clicked) {
          pending.armDownloadCapture?.(msg.pdfUrl);
          post(pending.port, 'progress', '已在 Nature 文章页触发原生正文 PDF 下载按钮，继续监听浏览器下载。');
          sendResponse({ ok: true, action: 'clicked_nature_pdf', pdfUrl: msg.pdfUrl });
          return false;
        }
        post(pending.port, 'progress', '已从 Nature 文章页取得正文 PDF 下载链接，正在打开该链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_nature_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'rsc' && msg.pdfUrl) {
        if (pending.lastNativePdfUrl === msg.pdfUrl) {
          sendResponse({ ok: true, ignored: true, reason: 'same rsc pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (msg.articleUrl) pending.articleUrl = msg.articleUrl;
        pending.publisher = 'rsc';
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        post(pending.port, 'progress', '已从 RSC 文章页取得 Download this article PDF 链接，正在打开下载链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_rsc_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'sage' && msg.clicked && !msg.pdfUrl) {
        pending.publisher = 'sage';
        pending.armDownloadCapture?.(pending.articleUrl || pending.pdfUrl || '');
        void appendSageTrace('clicked_sage_pdf_button', {
          tabId: Number.isInteger(tabId) ? tabId : null,
          selector: msg.selector || '',
          buttonText: msg.buttonText || '',
          currentUrl: sanitizeTraceUrl(msg.pageUrl || sender.tab?.url || '')
        });
        post(pending.port, 'progress', '已在 SAGE 文章页触发正文 PDF 按钮，继续监听浏览器下载。');
        sendResponse({ ok: true, action: 'clicked_sage_pdf_button' });
        return false;
      }
      if (msg.publisher === 'sage' && msg.pdfUrl) {
        if (pending.lastNativePdfUrl === msg.pdfUrl) {
          sendResponse({ ok: true, ignored: true, reason: 'same sage pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (msg.articleUrl) pending.articleUrl = msg.articleUrl;
        pending.publisher = 'sage';
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        if (msg.source === 'sage_download_endpoint' || /\/website\/journal\/download\?articleId=/i.test(String(msg.pdfUrl || ''))) {
          pending.armDownloadCapture?.(msg.pdfUrl);
        }
        if (msg.clicked) {
          pending.armDownloadCapture?.(msg.pdfUrl);
          post(pending.port, 'progress', '已在 SAGE 文章页触发正文 PDF 下载入口，继续监听浏览器下载。');
          sendResponse({ ok: true, action: 'clicked_sage_pdf', pdfUrl: msg.pdfUrl });
          return false;
        }
        post(pending.port, 'progress', msg.source === 'sage_download_endpoint'
          ? '已从 SAGE 页面解析到站内下载接口，正在打开下载接口。'
          : '已从 SAGE 文章页取得正文 PDF 下载链接，正在打开下载链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_sage_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }

      sendResponse({ ok: false, ignored: true, reason: 'unsupported publisher' });
      return false;
    }

    function attachRuntimeListeners() {
      chromeApi.runtime.onConnect.addListener(port => {
        if (port.name !== 'ablesci-pdf-upload') return;
        port.onMessage.addListener(msg => {
          if (!msg || msg.type !== 'startUpload') return;
          enqueueUpload(port, msg.payload);
        });
      });
      chromeApi.tabs.onUpdated.addListener(handlePublisherTabUpdated);
      chromeApi.runtime.onMessage.addListener(handlePublisherRuntimeMessage);
    }

    return {
      enqueueUpload,
      processQueue,
      cancelTask,
      attachRuntimeListeners,
      hasActiveTask() {
        return !!activeTask || taskQueue.length > 0;
      }
    };
  }

  globalThis.AblesciBackgroundUpload = { createBackgroundUploadApi };
})(globalThis);
