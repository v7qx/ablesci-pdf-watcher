'use strict';

// Publisher tab update and runtime message routing.
(function initBackgroundPublisherMessages(globalThis) {
  function createBackgroundPublisherMessagesApi(deps = {}) {
    const {
      chromeApi,
      pendingPublisherTabs,
      post,
      hostnameOf,
      isScienceDirectUrl,
      extractScienceDirectPii,
      isDoiHost,
      isNatureUrl,
      isSpringerUrl,
      isRscUrl,
      isAipUrl,
      isWileyUrl,
      isAcsUrl,
      isIeeeUrl,
      isOxfordUrl,
      isIopUrl,
      isScienceDirectAssetPdfUrl,
      isExpectedPublisherPage,
      recordPublisherCfChallenge
    } = deps;

    function handlePublisherTabUpdated(tabId, changeInfo, tab) {
      const pending = pendingPublisherTabs.get(tabId);
      if (!pending) return;
      const url = changeInfo.url || tab?.url || '';
      if (!url) return;

      if (changeInfo.status === 'complete') {
        const currentHost = hostnameOf(url);
        if (isDoiHost(currentHost)) {
          pending.finishError?.(new Error('DOI未找到或解析失败（DOI Not Found）'));
          return;
        }
      }

      const expectedHost = hostnameOf(pending.articleUrl || pending.pdfUrl || '');
      if (isDoiHost(expectedHost) && (isScienceDirectUrl(url) || isNatureUrl(url) || isSpringerUrl(url) || isRscUrl(url) || isWileyUrl(url) || isAipUrl(url) || isAcsUrl(url) || isIeeeUrl(url) || isOxfordUrl(url) || isIopUrl(url))) {
        pending.articleUrl = url;
        pending.publisher = isScienceDirectUrl(url)
          ? 'sciencedirect'
          : (isNatureUrl(url) ? 'nature' : (isSpringerUrl(url) ? 'springer' : (isRscUrl(url) ? 'rsc' : (isWileyUrl(url) ? 'wiley' : (isAipUrl(url) ? 'aip' : (isAcsUrl(url) ? 'acs' : (isIeeeUrl(url) ? 'ieee' : (isOxfordUrl(url) ? 'oxford' : 'iop'))))))));
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
      if (['springer', 'wiley', 'acs', 'ieee', 'oxford'].includes(msg.publisher) && msg.pdfUrl) {
        if (pending.lastNativePdfUrl === msg.pdfUrl) {
          sendResponse({ ok: true, ignored: true, reason: `same ${msg.publisher} pdf url already handled` });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (msg.articleUrl) pending.articleUrl = msg.articleUrl;
        pending.publisher = msg.publisher;
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        post(pending.port, 'progress', `已从 ${msg.publisher} 文章页取得正文 PDF 链接，正在打开下载链接。`);
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: `navigate_to_${msg.publisher}_pdf`, pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'aip' && msg.pdfUrl) {
        if (pending.lastNativePdfUrl === msg.pdfUrl) {
          sendResponse({ ok: true, ignored: true, reason: 'same aip pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (msg.articleUrl) pending.articleUrl = msg.articleUrl;
        pending.publisher = 'aip';
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        if (msg.clicked) {
          pending.armDownloadCapture?.(msg.pdfUrl);
          post(pending.port, 'progress', '已在 AIP 文章页触发原生正文 PDF 下载按钮，继续监听浏览器下载。');
          sendResponse({ ok: true, action: 'clicked_aip_pdf', pdfUrl: msg.pdfUrl });
          return false;
        }
        post(pending.port, 'progress', '已从 AIP 文章页取得正文 PDF 下载链接，正在打开该链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_aip_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'iop' && msg.pdfUrl) {
        if (pending.lastNativePdfUrl === msg.pdfUrl) {
          sendResponse({ ok: true, ignored: true, reason: 'same iop pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (msg.articleUrl) pending.articleUrl = msg.articleUrl;
        pending.publisher = 'iop';
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        if (msg.clicked) {
          pending.armDownloadCapture?.(msg.pdfUrl);
          post(pending.port, 'progress', '已在 IOP 文章页触发原生正文 PDF 下载按钮，继续监听浏览器下载。');
          sendResponse({ ok: true, action: 'clicked_iop_pdf', pdfUrl: msg.pdfUrl });
          return false;
        }
        post(pending.port, 'progress', '已从 IOP 文章页取得正文 PDF 下载链接，正在打开该链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_iop_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      sendResponse({ ok: false, ignored: true, reason: 'unsupported publisher' });
      return false;
    }

    return {
      handlePublisherTabUpdated,
      handlePublisherRuntimeMessage
    };
  }

  globalThis.AblesciBackgroundPublisherMessages = {
    createBackgroundPublisherMessagesApi
  };
})(globalThis);
