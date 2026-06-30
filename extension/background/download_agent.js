'use strict';

const DEFAULT_NO_DOWNLOAD_TIMEOUT_MS = 120 * 1000;

// Download strategy helpers used by the upload pipeline.
(function initBackgroundDownloadAgent(globalThis) {
  function createBackgroundDownloadAgentApi(deps = {}) {
    const {
      chromeApi,
      pendingPublisherTabs,
      defaultOptions,
      post,
      makeAbortError,
      abortReason,
      throwIfAborted,
      hostnameOf,
      isScienceDirectUrl,
      isDoiUrl,
      isNatureUrl,
      isCnpeUrl,
      isSageUrl,
      isSageKnowledgeUrl,
      classifyUnsupportedPublisherContentUrl,
      isSpringerUrl,
      isRscDirectPdfUrl,
      isRscUrl,
      isAipUrl,
      isWileyUrl,
      isAcsUrl,
      isIeeeUrl,
      isOxfordUrl,
      isIopUrl,
      publisherForUrl,
      publisherForDoi,
      validatePublisherLanding,
      publisherArticleUrlFromPdfUrl,
      looksLikePdfDownloadUrl,
      isLikelyTargetDownload,
      registerPublisherTab,
      unregisterPublisherTab,
      makeDownloadFilename,
      isHtmlDownloadItem,
      appendDiagnosticTrace,
      postDebugLog
    } = deps;

    // 本地 debugLog，转发到 publisher tab 的 F12 + 本地 console
    function debugLog(msg) {
      if (postDebugLog) postDebugLog(msg);
      console.log('[Ablesci PDF Watcher]', msg);
    }

    function ensureHttpUrl(rawUrl, label = 'URL') {
      try {
        const url = new URL(String(rawUrl || '').trim());
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
      } catch (_) {}
      throw new Error(`${label} 协议不受支持，已拒绝处理。`);
    }

    function extractDoi(value) {
      let text = String(value || '').trim();
      try { text = decodeURIComponent(text); } catch (_) {}
      const match = text.match(/(10\.\d{4,9}\/[^?#\s"']+)/i);
      return match ? match[1].replace(/\/+$/g, '') : '';
    }

    function sageDomesticArticleUrl(pdfUrl, payload = {}) {
      if (isCnpeUrl(pdfUrl)) return '';
      const doi = extractDoi(payload.doi) || extractDoi(pdfUrl);
      if (!doi) return '';
      const publisherHint = [payload.publisher, payload.publisherName, payload.publisherSlug]
        .map(value => String(value || ''))
        .join(' ');
      const doiPublisher = publisherForDoi?.(doi) || '';
      const isSageRequest = doiPublisher === 'sage' ||
        doiPublisher === 'liebert' ||
        isSageUrl(pdfUrl) ||
        /\b(?:sage|liebert|mary\s*ann\s*liebert)\b/i.test(publisherHint);
      return isSageRequest ? `https://sage.cnpereading.com/doi/${encodeURI(doi)}` : '';
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
      pdfUrl = ensureHttpUrl(pdfUrl, 'PDF URL');
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
      pdfUrl = ensureHttpUrl(pdfUrl, 'PDF URL');
      const noDownloadTimeoutMs = Number(options.noDownloadTimeoutMs || DEFAULT_NO_DOWNLOAD_TIMEOUT_MS);
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
          if (tabId !== null) {
            pendingPublisherTabs.delete(tabId);
            chromeApi.tabs.remove(tabId).catch(() => {});
          }
        }

        function onCreated(item) {
          if (downloadId !== null) return;
          if (tabId !== null && Number.isInteger(item.tabId) && item.tabId >= 0 && item.tabId !== tabId) {
            return;
          }
          if (!isLikelyTargetDownload(item, hostnameOf(pdfUrl), pdfUrl).ok) return;
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
          pendingPublisherTabs.set(tabId, {
            pdfUrl,
            createdAt: Date.now()
          });
          timer = setTimeout(() => {
            cleanup();
            reject(new Error('未触发 PDF 下载超时（请确认已设置直接下载 PDF，或账号有权限）'));
          }, noDownloadTimeoutMs);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });
    }

    async function downloadByInteractivePublisherTab(pdfUrl, port, options = {}) {
      pdfUrl = ensureHttpUrl(pdfUrl, 'PDF URL');
      const noDownloadTimeoutMs = Number(options.noDownloadTimeoutMs || DEFAULT_NO_DOWNLOAD_TIMEOUT_MS);
      const downloadTimeoutMs = Number(options.downloadTimeoutMs || 5 * 60 * 1000);
      const active = options.active !== false;
      const restorePreviousTabAfterDownloadStart = options.restorePreviousTabAfterDownloadStart === true;
      const revealAfterMs = Number(options.revealAfterMs || 0);
      const signal = options.signal || null;
      const directDownloadFilenameRel = options.filenameRel || makeDownloadFilename('', options.payload?.suggestedFilename || 'paper.pdf');

      return await new Promise(async (resolve, reject) => {
        let tabId = null;
        let downloadId = null;
        let noDownloadTimer = null;
        let poller = null;
        let settled = false;
        let revealed = active;
        let abortListener = null;
        let tabRemovedListener = null;
        let sourceUrlForMatching = pdfUrl;
        let expectedHost = hostnameOf(sourceUrlForMatching);
        let downloadArmed = looksLikePdfDownloadUrl(pdfUrl);
        let directDownloadInProgress = false;
        let previousActiveTabId = null;
        let previousTabRestored = false;
        let noDownloadTimeoutMessage = '未触发 PDF 下载超时（可能无访问权限、未通过验证，或未设置直接下载）';
        const captureId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const pollTimeouts = new Set();
        const articleUrl = ensureHttpUrl(publisherArticleUrlFromPdfUrl(pdfUrl) || pdfUrl, '出版商页面 URL');
        const payloadSummary = {
          assistId: options.payload?.assistId || '',
          doi: options.payload?.doi || '',
          journalName: options.payload?.journalName || '',
          title: options.payload?.title || options.payload?.suggestedFilename || '',
          pageUrl: options.payload?.pageUrl || '',
          pdfUrl: options.payload?.pdfUrl || pdfUrl,
          pdfUrlSource: options.payload?.pdfUrlSource || ''
        };
        const expectedPublisher = publisherForUrl(articleUrl) || publisherForUrl(pdfUrl) || publisherForDoi?.(payloadSummary.doi || pdfUrl) || '';
        const startedAfter = new Date(Date.now() - 2000).toISOString();
        const seenIds = new Set();
        const seenIgnoredIds = new Set();

        function traceUrl(url) {
          const raw = String(url || '');
          if (!raw) return '';
          try {
            const parsed = new URL(raw);
            const value = `${parsed.hostname}${parsed.pathname}`;
            return value.length > 220 ? `${value.slice(0, 220)}...` : value;
          } catch (_) {
            const value = raw.replace(/^https?:\/\//i, '').split(/[?#]/)[0];
            return value.length > 220 ? `${value.slice(0, 220)}...` : value;
          }
        }

        function tracePublisherStep(step, details = {}) {
          appendDiagnosticTrace?.(payloadSummary, {
            ...details,
            step,
            publisher: expectedPublisher || publisherForUrl(articleUrl) || publisherForUrl(pdfUrl) || '',
            articleUrl: traceUrl(articleUrl),
            pdfUrl: traceUrl(pdfUrl)
          });
        }

        function makeLandingError(landingCheck) {
          const platform = landingCheck.platform ? ` (${landingCheck.platform})` : '';
          const err = new Error(`DOI 跳转落地域名暂不支持${platform}：${landingCheck.host || 'unknown'}，已跳过。`);
          err.failureReason = landingCheck.reason || 'unsupported_landing_host';
          err.landingCheck = landingCheck;
          return err;
        }

        function looksLikeChallengeUrl(url) {
          return /(?:[?&]__cf_chl_|\/cdn-cgi\/challenge-platform\/|cf_chl_rt_tk|turnstile|captcha)/i.test(String(url || ''));
        }

        function traceCurrentTabBeforeTimeout(message) {
          if (tabId === null) {
            tracePublisherStep('publisher-no-download-timeout', { message });
            return;
          }
          chromeApi.tabs.get(tabId).then(tab => {
            tracePublisherStep('publisher-no-download-timeout', {
              message,
              currentUrl: traceUrl(tab?.url || ''),
              tabTitle: String(tab?.title || '').slice(0, 160),
              challengeUrl: looksLikeChallengeUrl(tab?.url || ''),
              downloadArmed,
              expectedHost,
              sourceUrl: traceUrl(sourceUrlForMatching)
            });
          }).catch(() => {
            tracePublisherStep('publisher-no-download-timeout', {
              message,
              downloadArmed,
              expectedHost,
              sourceUrl: traceUrl(sourceUrlForMatching)
            });
          });
        }

        function cleanup(closeTab = true) {
          if (noDownloadTimer) clearTimeout(noDownloadTimer);
          if (poller) clearInterval(poller);
          for (const timeoutId of pollTimeouts) clearTimeout(timeoutId);
          pollTimeouts.clear();
          if (abortListener && signal) signal.removeEventListener('abort', abortListener);
          chromeApi.downloads.onCreated.removeListener(onCreated);
          if (tabRemovedListener && chromeApi.tabs.onRemoved) chromeApi.tabs.onRemoved.removeListener(tabRemovedListener);
          tracePublisherStep('poller_cleanup', { captureId, closeTab });
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
          restorePreviousTab();
          cleanup(true);
          reject(err instanceof Error ? err : new Error(String(err)));
        }

        function restorePreviousTab() {
          if (!restorePreviousTabAfterDownloadStart || previousTabRestored || !Number.isInteger(previousActiveTabId)) return;
          previousTabRestored = true;
          if (previousActiveTabId === tabId) return;
          chromeApi.tabs.update(previousActiveTabId, { active: true }).catch(() => {});
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
            traceCurrentTabBeforeTimeout(noDownloadTimeoutMessage);
            finishError(new Error(noDownloadTimeoutMessage));
          }, timeoutMs);
        }

        function acceptCandidate(item, source) {
          if (settled || !item || seenIds.has(item.id)) return;
          if (!downloadArmed) {
            tracePublisherStep('download-candidate-ignored', { source, reason: 'download_not_armed', downloadId: item.id });
            if (!seenIgnoredIds.has(item.id)) {
              seenIgnoredIds.add(item.id);
              post(port, 'progress', `⚠️ 忽略下载 #${item.id}：未装载拦截器 (download_not_armed)`);
            }
            return;
          }
          if (isHtmlDownloadItem(item)) {
            tracePublisherStep('download-candidate-ignored', { source, reason: 'html_download_item', downloadId: item.id });
            if (!seenIgnoredIds.has(item.id)) {
              seenIgnoredIds.add(item.id);
              post(port, 'progress', `⚠️ 忽略下载 #${item.id}：检测为 HTML 页面而不是 PDF`);
            }
            return;
          }
          if (tabId !== null && Number.isInteger(item.tabId) && item.tabId >= 0 && item.tabId !== tabId) {
            tracePublisherStep('download_candidate_owner_mismatch', { source, reason: 'tab_mismatch', downloadId: item.id, itemTabId: item.tabId, publisherTabId: tabId, captureId });
            if (!seenIgnoredIds.has(item.id)) {
              seenIgnoredIds.add(item.id);
              post(port, 'progress', `⚠️ 忽略下载 #${item.id}：标签页不匹配 (下载来自 tab ${item.tabId}，期望 ${tabId})`);
            }
            return;
          }
          const matchResult = isLikelyTargetDownload(item, expectedHost, sourceUrlForMatching);
          if (!matchResult.ok) {
            tracePublisherStep('download_candidate_owner_mismatch', {
              source,
              reason: 'url_mismatch',
              detail: matchResult.reason,
              downloadId: item.id,
              expectedHost,
              sourceUrl: traceUrl(sourceUrlForMatching),
              itemUrl: traceUrl(item.url),
              finalUrl: traceUrl(item.finalUrl),
              captureId
            });
            if (!seenIgnoredIds.has(item.id)) {
              seenIgnoredIds.add(item.id);
              post(port, 'progress', `⚠️ 忽略下载 #${item.id}：特征码不匹配 (${matchResult.reason}，URL: ${traceUrl(item.url)})`);
            }
            if (tabId !== null && item.tabId === tabId && (looksLikePdfDownloadUrl(item.url) || looksLikePdfDownloadUrl(item.finalUrl))) {
              finishError(new Error(`下载特征码不匹配：${matchResult.reason}。URL: ${item.url}`));
            }
            return;
          }
          seenIds.add(item.id);
          downloadId = item.id;
          tracePublisherStep('download-candidate-accepted', {
            source,
            matchReason: matchResult.reason || 'standard_match',
            downloadId: item.id,
            captureId
          });
          restorePreviousTab();
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
              item._ablesciCaptureId = captureId;
              finishOk(item);
            })
            .catch(err => {
              finishError(err);
            });
        }

        function onCreated(item) {
          acceptCandidate(item, 'onCreated');
        }

        async function downloadDirectFromPublisherUrl(url, source = 'publisher_direct_download') {
          if (settled) return null;
          const nextUrl = ensureHttpUrl(url, '出版商 PDF URL');
          if (!nextUrl) throw new Error('出版商返回的 PDF 地址为空');
          const currentPublisher = publisherForUrl(sourceUrlForMatching) || publisherForUrl(articleUrl) || publisherForUrl(pdfUrl) || '';
          const nextPublisher = publisherForUrl(nextUrl) || '';
          if (currentPublisher && nextPublisher && currentPublisher !== nextPublisher) {
            tracePublisherStep('download_candidate_owner_mismatch', {
              source,
              reason: 'publisher_mismatch',
              currentPublisher,
              nextPublisher,
              sourceUrl: traceUrl(sourceUrlForMatching),
              itemUrl: traceUrl(nextUrl),
              captureId
            });
            throw new Error(`出版商 PDF 地址来源不匹配：期望 ${currentPublisher}，实际 ${nextPublisher}`);
          }
          sourceUrlForMatching = nextUrl;
          expectedHost = hostnameOf(sourceUrlForMatching);
          downloadArmed = true;
          tracePublisherStep('publisher-direct-download-start', {
            expectedHost,
            sourceUrl: traceUrl(sourceUrlForMatching),
            source
          });
          if (noDownloadTimer) {
            clearTimeout(noDownloadTimer);
            noDownloadTimer = null;
          }
          post(port, 'progress', '已取得出版社真实 PDF 地址，改用 chrome.downloads 直接下载，避免进入浏览器 PDF 预览页。');
          directDownloadInProgress = true;
          try {
            const item = await downloadByDownloadsAPI(nextUrl, directDownloadFilenameRel, signal, { downloadTimeoutMs });
            item._ablesciPublisherTabId = tabId;
            item._ablesciMatchSource = source;
            item._ablesciCaptureId = captureId;
            finishOk(item);
            return item;
          } catch (err) {
            finishError(err);
            throw err;
          } finally {
            directDownloadInProgress = false;
          }
        }

        async function pollDownloads() {
          if (settled) return;
          const items = await chromeApi.downloads.search({ startedAfter, orderBy: ['-startTime'], limit: 20 });
          for (const item of items) {
            acceptCandidate(item, 'poll');
            if (downloadId !== null) break;
          }
        }

        function schedulePoll(delayMs) {
          const timeoutId = setTimeout(() => {
            pollTimeouts.delete(timeoutId);
            pollDownloads().catch(() => {});
          }, delayMs);
          pollTimeouts.add(timeoutId);
        }

        function waitForDownloadAfterTabClosed() {
          if (settled) return;
          if (downloadId !== null || directDownloadInProgress) {
            tracePublisherStep('publisher_tab_closed_after_download_started', {
              tabId,
              downloadId,
              directDownloadInProgress,
              captureId
            });
            return;
          }
          if (!downloadArmed) {
            finishError(new Error('出版商标签页已关闭，已停止等待下载。'));
            return;
          }
          post(port, 'progress', '出版商标签页已关闭；已触发下载监听，短暂检查浏览器下载记录后再判断。');
          schedulePoll(0);
          schedulePoll(500);
          schedulePoll(1500);
          const timeoutId = setTimeout(() => {
            pollTimeouts.delete(timeoutId);
            pollDownloads()
              .catch(() => {})
              .finally(() => {
                if (settled || downloadId !== null || directDownloadInProgress) return;
                tracePublisherStep('publisher_tab_closed_no_download_detected', { tabId, captureId });
                finishError(new Error('出版商标签页已关闭，且未检测到浏览器下载。'));
              });
          }, 3000);
          pollTimeouts.add(timeoutId);
        }

        try {
          throwIfAborted(signal);
          if (signal) {
            abortListener = () => finishError(makeAbortError(abortReason(signal)));
            signal.addEventListener('abort', abortListener, { once: true });
          }
          chromeApi.downloads.onCreated.addListener(onCreated);
          tracePublisherStep('publisher-tab-open', { active, revealAfterMs, downloadArmed, expectedHost, captureId });

          // 非期刊论文页面跳过（book/chapter/reference 等），只按 URL 域名和路径段判断。
          const unsupportedContent = classifyUnsupportedPublisherContentUrl?.(articleUrl);
          if (unsupportedContent?.skip) {
            tracePublisherStep('unsupported_publisher_content_pre_open_detected', {
              articleUrl: traceUrl(articleUrl),
              captureId,
              sourceType: unsupportedContent.type || ''
            });
            const err = new Error(`当前出版商页面类型不支持：${unsupportedContent.reason || unsupportedContent.type || 'book/chapter content'} — ${articleUrl}`);
            err.failureReason = 'publisher_unsupported';
            err.sourceType = unsupportedContent.type || '';
            throw err;
          }

          if (expectedPublisher && !isDoiUrl(articleUrl)) {
            const landingCheck = validatePublisherLanding?.({
              publisher: expectedPublisher,
              doi: payloadSummary.doi || '',
              finalUrl: articleUrl
            });
            if (landingCheck && !landingCheck.ok) {
              tracePublisherStep('publisher_landing_rejected_pre_open', landingCheck);
              console.warn('[doi-landing] skipped', landingCheck);
              throw makeLandingError(landingCheck);
            }
          }

          if (active && restorePreviousTabAfterDownloadStart) {
            const activeTabs = await chromeApi.tabs.query({ active: true, currentWindow: true }).catch(() => []);
            previousActiveTabId = Number.isInteger(activeTabs?.[0]?.id) ? activeTabs[0].id : null;
          }
          const tab = await chromeApi.tabs.create({ url: articleUrl, active });
          tabId = tab.id;
          if (chromeApi.tabs.onRemoved) {
            tabRemovedListener = removedTabId => {
              if (removedTabId !== tabId || settled) return;
              tracePublisherStep('publisher_tab_closed', { tabId, captureId });
              waitForDownloadAfterTabClosed();
            };
            chromeApi.tabs.onRemoved.addListener(tabRemovedListener);
          }
          const pubResolved = publisherForUrl(articleUrl) || expectedPublisher;
          debugLog(`publisherTab created: tabId=${tab.id} publisher=${pubResolved} articleUrl=${articleUrl} pdfUrl=${pdfUrl}`);
          pendingPublisherTabs.set(tabId, {
            pdfUrl,
            articleUrl,
            createdAt: Date.now(),
            captureId,
            port,
            finishError,
            revealPublisherTab,

            payloadSummary,
            publisher: pubResolved,
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
              tracePublisherStep('download-capture-armed', {
                expectedHost,
                sourceUrl: traceUrl(sourceUrlForMatching)
              });
            },
            setExpectedDownloadUrl(url) {
              sourceUrlForMatching = url || sourceUrlForMatching;
              expectedHost = hostnameOf(sourceUrlForMatching);
              if (looksLikePdfDownloadUrl(sourceUrlForMatching)) downloadArmed = true;
              tracePublisherStep('expected-download-url-set', {
                downloadArmed,
                expectedHost,
                sourceUrl: traceUrl(sourceUrlForMatching)
              });
            },
            downloadDirectFromPublisherUrl
          });
          registerPublisherTab(tabId, { pdfUrl, articleUrl, reason: 'interactive_publisher_tab' }).catch(() => {});

          if (active) {
            post(port, 'progress', '已打开可见出版商页面。若出现验证页，请在新标签页完成验证；进入文章页后插件会查找原生 View PDF 入口。');
          } else {
            post(port, 'progress', '已用后台静默标签页打开出版商页面；普通等待不会主动切到前台，检测到验证页时才会提示处理。');
          }
          post(port, 'progress', '正在等待浏览器下载事件；如果 PDF 已经下载但无后续进度，会通过轮询下载记录继续接管。');

          poller = setInterval(pollDownloads, 1000);
          schedulePoll(500);
          schedulePoll(2000);

          armNoDownloadTimer(noDownloadTimeoutMs, noDownloadTimeoutMessage);
        } catch (err) {
          finishError(err);
        }
      });
    }

    async function downloadPdf(pdfUrl, suggestedFilename, opts, port, signal = null) {
      pdfUrl = ensureHttpUrl(pdfUrl, 'PDF URL');
      const sageDomesticUrl = sageDomesticArticleUrl(pdfUrl, opts.payloadContext || {});
      if (sageDomesticUrl) {
        pdfUrl = sageDomesticUrl;
        post(port, 'progress', 'SAGE 求助已改用国内站 sage.cnpereading.com 查找正文 PDF。');
      }
      if (isSageUrl(pdfUrl)) {
        const err = new Error('SAGE 求助缺少可用于国内站查询的 DOI，已按信息不全跳过。');
        err.failureReason = 'publisher_unsupported';
        throw err;
      }
      const filenameRel = makeDownloadFilename('', suggestedFilename);
      const mode = opts.downloadMode || 'auto';
      const revealAfterMs = 0;
      let noDownloadTimeoutMs = Math.max(1000, Number(opts.watcherNoDownloadTimeoutMinutes || defaultOptions.watcherNoDownloadTimeoutMinutes) * 60 * 1000);
      const downloadTimeoutMs = Math.max(1000, Number(opts.watcherDownloadTimeoutMinutes || defaultOptions.watcherDownloadTimeoutMinutes) * 60 * 1000);
      const timeoutOptions = {
        noDownloadTimeoutMs,
        downloadTimeoutMs,
        signal
      };
      const canUsePublisherPageFallback = isSpringerUrl(pdfUrl) || isWileyUrl(pdfUrl) || isAcsUrl(pdfUrl) || isIeeeUrl(pdfUrl) || isOxfordUrl(pdfUrl) || isCnpeUrl(pdfUrl);

      debugLog(`downloadPdf url=${pdfUrl} isSage=${isSageUrl(pdfUrl)} isPdfUrl=${looksLikePdfDownloadUrl(pdfUrl)} mode=${mode} canFallback=${canUsePublisherPageFallback}`);

      function isUnsupportedSpringerBookPdfUrl(url) {
        const s = String(url || '');
        return /:\/\/link\.springer\.com\/content\/pdf\/10\.[^/]+\/978-[^?#]+(?:\.pdf)?(?:[?#].*)?$/i.test(s) ||
          /:\/\/link\.springer\.com\/content\/pdf\/10\.[^?#]+_(?!reference\b)[^/?#]+(?:\.pdf)?(?:[?#].*)?$/i.test(s);
      }

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
        post(port, 'progress', `${label} 使用后台静默出版商页面模式；仅检测到验证页时才会切到前台。`);
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs, payload: opts.payloadContext || null });
      }

      if (isNatureUrl(pdfUrl)) {
        if (mode === 'publisher_tab') {
          post(port, 'progress', 'Nature 使用可见文章页原生 PDF 下载模式。');
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
        }
        post(port, 'progress', 'Nature 使用后台文章页原生 PDF 下载模式；仅检测到验证页时才会切到前台。');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs, payload: opts.payloadContext || null });
      }

      if (isCnpeUrl(pdfUrl) && !looksLikePdfDownloadUrl(pdfUrl)) {
        // 易阅通通过页面 JavaScript 请求 Blob 后再点击临时 download 链接。
        // Chrome 会显著节流后台不可见页，实测必须激活标签页后才稳定触发下载。
        return await downloadByInteractivePublisherTab(pdfUrl, port, {
          ...timeoutOptions,
          active: true,
          restorePreviousTabAfterDownloadStart: true,
          payload: opts.payloadContext || null
        });
      }

      if (isSpringerUrl(pdfUrl)) {
        if (isUnsupportedSpringerBookPdfUrl(pdfUrl)) {
          throw new Error('Springer 书籍或章节 PDF 暂不支持；当前规则只处理 /article/ 期刊文献。');
        }
        if (mode === 'publisher_tab') {
          post(port, 'progress', 'Springer 使用可见文章页校验模式；仅支持 /article/ 期刊文献。');
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
        }
        post(port, 'progress', 'Springer 使用后台文章页校验模式；仅支持 /article/ 期刊文献，不直接下载书籍或章节链接。');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs, payload: opts.payloadContext || null });
      }

      if (isAipUrl(pdfUrl)) {
        if (mode === 'publisher_tab') {
          post(port, 'progress', 'AIP 使用可见文章页原生 PDF 下载模式。');
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
        }
        post(port, 'progress', 'AIP 使用后台文章页原生 PDF 下载模式；仅检测到验证页时才会切到前台。');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs, payload: opts.payloadContext || null });
      }

      if (isIopUrl(pdfUrl)) {
        if (mode === 'publisher_tab') {
          post(port, 'progress', 'IOP 使用可见文章页原生 PDF 下载模式。');
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: true, payload: opts.payloadContext || null });
        }
        post(port, 'progress', 'IOP 使用后台文章页原生 PDF 下载模式；仅检测到验证页时才会切到前台。');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs, payload: opts.payloadContext || null });
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
        post(port, 'progress', 'RSC 使用后台文章页原生 PDF 下载模式；仅检测到验证页时才会切到前台。');
        return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs, payload: opts.payloadContext || null });
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
        if (canUsePublisherPageFallback) {
          post(port, 'progress', '直接下载失败，尝试打开出版商文章页查找 PDF 按钮：' + (err.message || err));
          return await downloadByInteractivePublisherTab(pdfUrl, port, { ...timeoutOptions, active: false, revealAfterMs, payload: opts.payloadContext || null });
        }
        post(port, 'progress', '直接下载失败，尝试后台标签页：' + (err.message || err));
        return await downloadByBackgroundTab(pdfUrl, timeoutOptions);
      }
    }

    return {
      downloadPdf,
      sageDomesticArticleUrl
    };
  }

  globalThis.AblesciBackgroundDownloadAgent = {
    createBackgroundDownloadAgentApi
  };
})(globalThis);
