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
      extractAllScienceDirectPiis,
      isDoiHost,
      isNatureUrl,
      isCnpeUrl,
      isSageUrl,
      isSageKnowledgeUrl,
      classifySageKnowledgeUrl,
      classifyUnsupportedPublisherContentUrl,
      isSpringerUrl,
      isRscUrl,
      isAipUrl,
      isWileyUrl,
      isAcsUrl,
      isAcsBookUrl,
      isIeeeUrl,
      isOxfordUrl,
      isIopUrl,
      isScienceDirectAssetPdfUrl,
      publisherForUrl,
      publisherForDoi,
      validatePublisherLanding,
      isExpectedPublisherPage,
      recordPublisherCfChallenge,
      appendDiagnosticTrace
    } = deps;

    // 调试日志：转发到 publisher tab 的 content script，使其出现在页面 F12 中
    function postDebugLog(text) {
      if (typeof text !== 'string' || !text) return;
      const message = { type: 'ablesciBackgroundLog', text };
      for (const [tabId] of pendingPublisherTabs) {
        chromeApi.tabs.sendMessage(tabId, message).catch(() => { /* tab may not be ready */ });
      }
    }

    function shortUrl(url) {
      return String(url || '').replace(/^https?:\/\//i, '');
    }

    function normalizeHttpUrl(rawUrl) {
      try {
        const url = new URL(String(rawUrl || '').trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
        return url.href;
      } catch (_) {
        return '';
      }
    }

    function isSamePdfUrl(urlA, urlB) {
      if (!urlA || !urlB) return urlA === urlB;
      try {
        const uA = new URL(String(urlA).trim());
        const uB = new URL(String(urlB).trim());
        return (uA.origin + uA.pathname).toLowerCase() === (uB.origin + uB.pathname).toLowerCase();
      } catch (_) {
        return String(urlA).trim().toLowerCase() === String(urlB).trim().toLowerCase();
      }
    }

    function looksLikeChallengeUrl(url) {
      return /(?:[?&]__cf_chl_|\/cdn-cgi\/challenge-platform\/|cf_chl_rt_tk|turnstile|captcha)/i.test(String(url || ''));
    }

    function tracePublisherStep(pending, step, details = {}) {
      appendDiagnosticTrace?.(pending.payloadSummary || {}, {
        ...details,
        step,
        publisher: pending.publisher || details.publisher || '',
        articleUrl: shortUrl(details.articleUrl || pending.articleUrl || ''),
        pdfUrl: shortUrl(details.pdfUrl || pending.lastNativePdfUrl || pending.pdfUrl || '')
      });
    }

    function markPublisherChallengePassed(pending) {
      if (!pending?.publisherChallengeSeen) return;
      pending.publisherChallengePassed = true;
    }

    function trustedSenderPageUrl(sender) {
      return normalizeHttpUrl(sender?.tab?.url || '');
    }

    function validateTrustedPublisherSender(pending, sender, msg = {}) {
      const pageUrl = trustedSenderPageUrl(sender);
      if (!pageUrl || !isExpectedPublisherPage(pending, pageUrl)) {
        tracePublisherStep(pending, 'publisher_message_sender_mismatch', {
          publisher: msg.publisher || pending.publisher || '',
          articleUrl: pending.articleUrl || '',
          pdfUrl: msg.pdfUrl || pending.lastNativePdfUrl || pending.pdfUrl || '',
          trustedPageUrl: shortUrl(pageUrl),
          messagePageUrl: shortUrl(msg.pageUrl || ''),
          messageArticleUrl: shortUrl(msg.articleUrl || '')
        });
        return { ok: false, pageUrl, reason: 'publisher sender page mismatch' };
      }
      return { ok: true, pageUrl };
    }

    function isCompatiblePublisherUrl(pending, url) {
      if (!url) return false;
      if (isExpectedPublisherPage(pending, url)) return true;
      const actualPublisher = publisherForUrl?.(url) || '';
      return !actualPublisher || !pending.publisher || actualPublisher === pending.publisher;
    }

    function schedulePublisherChallengeReveal(pending, token, delayMs = 10000) {
      setTimeout(() => {
        if (!pending || pending.publisherChallengeToken !== token) return;
        if (pending.publisherChallengePassed || pending.lastNativePdfUrl) return;
        pending.revealPublisherTab?.('检测到出版商验证页，后台等待 10 秒后仍未自动通过，已切到前台；请完成验证。');
      }, delayMs);
    }

    function handlePublisherTabUpdated(tabId, changeInfo, tab) {
      const pending = pendingPublisherTabs.get(tabId);
      if (!pending) return;
      const url = changeInfo.url || tab?.url || '';
      if (!url) return;

      // 非期刊论文页面跳过：handbook / encyclopedia / reference / book chapter。
      // 只按 URL 域名和独立路径段判断，避免标题里的 book/chapter 文本误伤。
      const unsupportedContent = classifyUnsupportedPublisherContentUrl?.(url);
      if (unsupportedContent?.skip) {
        const err = new Error(`当前出版商页面类型不支持：${unsupportedContent.reason || unsupportedContent.type}`);
        err.failureReason = 'publisher_unsupported';
        err.sourceType = unsupportedContent.type || '';
        tracePublisherStep(pending, 'unsupported_publisher_content_detected', {
          publisher: publisherForUrl(url) || pending.publisher || '',
          articleUrl: pending.articleUrl || '',
          currentUrl: shortUrl(url),
          sourceType: unsupportedContent.type || ''
        });
        pending.finishError?.(err);
        return;
      }

      if (changeInfo.url) {
        tracePublisherStep(pending, 'publisher-tab-url-changed', {
          publisher: pending.publisher || '',
          articleUrl: pending.articleUrl || '',
          pdfUrl: pending.lastNativePdfUrl || pending.pdfUrl || '',
          currentUrl: shortUrl(url),
          challengeUrl: looksLikeChallengeUrl(url)
        });
      }

      if (looksLikeChallengeUrl(url)) {
        tracePublisherStep(pending, 'publisher-tab-challenge-url-detected', {
          publisher: pending.publisher || '',
          articleUrl: pending.articleUrl || '',
          pdfUrl: pending.lastNativePdfUrl || pending.pdfUrl || '',
          currentUrl: shortUrl(url)
        });
      }

      const currentHost = hostnameOf(url);
      if (currentHost === 'chooser.crossref.org') {
        const err = new Error('DOI 对应多个解析结果（Crossref 多链接），当前出版商页面类型不支持自动处理');
        err.failureReason = 'publisher_unsupported';
        pending.finishError?.(err);
        return;
      }

      if (changeInfo.status === 'complete') {
        if (isDoiHost(currentHost)) {
          pending.finishError?.(new Error('DOI未找到或解析失败（DOI Not Found）'));
          return;
        }
      }

      const expectedHost = hostnameOf(pending.articleUrl || pending.pdfUrl || '');
      if (isDoiHost(expectedHost) && (isScienceDirectUrl(url) || isNatureUrl(url) || isCnpeUrl(url) || isSageUrl(url) || isSpringerUrl(url) || isRscUrl(url) || isWileyUrl(url) || isAipUrl(url) || isAcsUrl(url) || isIeeeUrl(url) || isOxfordUrl(url) || isIopUrl(url))) {
        pending.articleUrl = url;
        pending.publisher = publisherForUrl?.(url) || pending.publisher || '';
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(url);
        return;
      }
      if (isDoiHost(expectedHost) && currentHost && !isDoiHost(currentHost) && changeInfo.status === 'complete') {
        const publisher = pending.publisher || publisherForDoi?.(pending.payloadSummary?.doi || pending.pdfUrl || '') || publisherForUrl?.(url) || '';
        const landingCheck = validatePublisherLanding?.({
          publisher,
          doi: pending.payloadSummary?.doi || '',
          finalUrl: url
        });
        if (landingCheck && !landingCheck.ok) {
          const err = new Error(`DOI 跳转落地域名暂不支持${landingCheck.platform ? ` (${landingCheck.platform})` : ''}：${landingCheck.host || 'unknown'}，已跳过。`);
          err.failureReason = landingCheck.reason || 'unsupported_landing_host';
          err.landingCheck = landingCheck;
          tracePublisherStep(pending, 'publisher_landing_rejected_after_redirect_complete', {
            ...landingCheck,
            currentUrl: shortUrl(url)
          });
          console.warn('[doi-landing] skipped', landingCheck);
          pending.finishError?.(err);
          return;
        }
      }

      if (isScienceDirectAssetPdfUrl(url)) {
        const expectedPiis = extractAllScienceDirectPiis(pending.articleUrl || pending.pdfUrl || '');
        const actualPiis = extractAllScienceDirectPiis(url);
        if (expectedPiis.length > 0 && actualPiis.length > 0) {
          let matched = false;
          for (const sp of expectedPiis) {
            for (const ap of actualPiis) {
              if (sp.substring(0, 10) === ap.substring(0, 10)) {
                matched = true;
                break;
              }
            }
            if (matched) break;
          }
          if (!matched) {
            pending.finishError?.(new Error(`ScienceDirect PDF PII 不匹配：期望 ${expectedPiis.join(',')}，实际 ${actualPiis.join(',')}`));
            return;
          }
        }
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(url);
        pending.lastNativePdfUrl = url;
      }
    }

    function handlePublisherRuntimeMessage(msg, sender, sendResponse) {
      const tabId = sender.tab && sender.tab.id;
      const pending = tabId != null ? pendingPublisherTabs.get(tabId) : null;

      if (msg?.type === 'ablesciPublisherCanControl') {
        postDebugLog(`ablesciPublisherCanControl: tabId=${tabId} msg.publisher=${msg.publisher} pending=${!!pending} pending.publisher=${pending?.publisher || '(none)'} pageUrl=${shortUrl(msg.pageUrl)}`);
        if (!pending) return sendResponse({ ok: false, reason: 'no pending publisher task for this tab' });
        if (msg.publisher && pending.publisher && msg.publisher !== pending.publisher) {
          postDebugLog(`ablesciPublisherCanControl REJECTED: publisher mismatch (msg=${msg.publisher} pending=${pending.publisher})`);
          return sendResponse({ ok: false, reason: 'publisher mismatch' });
        }
        const trusted = validateTrustedPublisherSender(pending, sender, msg);
        if (!trusted.ok) {
          postDebugLog(`ablesciPublisherCanControl REJECTED: ${trusted.reason} (pageUrl=${shortUrl(trusted.pageUrl)})`);
          return sendResponse({ ok: false, reason: trusted.reason });
        }
        postDebugLog(`ablesciPublisherCanControl OK: tabId=${tabId} publisher=${pending.publisher}`);
        return sendResponse({ ok: true });
      }

      if (!msg || msg.type !== 'ablesciPublisherArticleReady') return false;
      if (!pending) {
        sendResponse({ ok: false, ignored: true, reason: 'no pending publisher task' });
        return false;
      }
      const trusted = validateTrustedPublisherSender(pending, sender, msg);
      if (!trusted.ok) {
        sendResponse({ ok: false, ignored: true, reason: trusted.reason });
        return false;
      }

      if (msg.pdfUrl) {
        const safePdfUrl = normalizeHttpUrl(msg.pdfUrl);
        if (!safePdfUrl) {
          tracePublisherStep(pending, 'publisher-pdf-url-rejected', {
            publisher: msg.publisher || pending.publisher || '',
            articleUrl: msg.articleUrl || msg.pageUrl || pending.articleUrl || '',
            source: msg.source || '',
            reason: 'unsafe_pdf_url_scheme'
          });
          sendResponse({ ok: false, ignored: true, reason: 'unsafe_pdf_url_scheme' });
          return false;
        }
        if (!isCompatiblePublisherUrl(pending, safePdfUrl)) {
          tracePublisherStep(pending, 'publisher-pdf-url-rejected', {
            publisher: msg.publisher || pending.publisher || '',
            articleUrl: msg.articleUrl || msg.pageUrl || pending.articleUrl || '',
            pdfUrl: safePdfUrl,
            source: msg.source || '',
            reason: 'publisher_pdf_url_mismatch',
            trustedPageUrl: shortUrl(trusted.pageUrl)
          });
          sendResponse({ ok: false, ignored: true, reason: 'publisher_pdf_url_mismatch' });
          return false;
        }
        if (safePdfUrl !== msg.pdfUrl) msg = { ...msg, pdfUrl: safePdfUrl };
      }

      if (!msg.publisherChallenge) markPublisherChallengePassed(pending);

      if (msg.publisherDiagnostic) {
        tracePublisherStep(pending, 'publisher-page-diagnostic', {
          publisher: msg.publisher || pending.publisher || '',
          articleUrl: msg.articleUrl || msg.pageUrl || pending.articleUrl || '',
          source: msg.source || '',
          diagnostics: msg.diagnostics || null
        });
        sendResponse({ ok: true, action: 'publisher_diagnostic_recorded' });
        return false;
      }

      if (msg.publisher === 'sciencedirect' && msg.noSubscription) {
        pending.finishError(new Error('ScienceDirect 明确返回无正文订阅权限（does not subscribe to this content on ScienceDirect）。'));
        sendResponse({ ok: true, action: 'science_direct_no_subscription' });
        return false;
      }
      if (msg.publisher === 'nature' && msg.noSubscription) {
        pending.finishError(new Error('Nature 明确返回无正文订阅权限。'));
        sendResponse({ ok: true, action: 'nature_no_subscription' });
        return false;
      }
      if (msg.publisher === 'cnpe' && msg.noSubscription) {
        pending.finishError(new Error('易阅通 SAGE 平台明确返回无正文订阅权限。'));
        sendResponse({ ok: true, action: 'cnpe_no_subscription' });
        return false;
      }
      if (msg.publisherChallenge) {
        if (pending.publisherChallengeSeen) {
          sendResponse({ ok: true, ignored: true, reason: 'same publisher challenge already handled' });
          return false;
        }
        pending.publisherChallengeSeen = true;
        pending.publisherChallengePassed = false;
        pending.publisherChallengeToken = Date.now();
        const challengeToken = pending.publisherChallengeToken;
        recordPublisherCfChallenge(msg.pageUrl || pending.articleUrl || pending.pdfUrl || '')
          .then(result => {
            if (result.paused) {
              pending.finishError(new Error(`检测到出版商验证页，连续达到阈值 ${result.threshold}，已暂停低频值守。`));
              return;
            }
            pending.extendNoDownloadTimeout?.(
              5 * 60 * 1000,
              '等待出版商验证超时；请完成验证后重新触发，或检查浏览器是否被最小化。'
            );
            post(pending.port, 'progress', `检测到出版商验证页，已计入第 ${result.streak} 次验证；先在后台等待 10 秒，若未自动通过再切到前台。`);
            schedulePublisherChallengeReveal(pending, challengeToken, 10000);
          })
          .catch(err => {
            console.warn('[Ablesci PDF Watcher] record publisher challenge failed', err);
            pending.extendNoDownloadTimeout?.(
              5 * 60 * 1000,
              '等待出版商验证超时；请完成验证后重新触发，或检查浏览器是否被最小化。'
            );
            post(pending.port, 'progress', '检测到出版商验证页；先在后台等待 10 秒，若未自动通过再切到前台。');
            schedulePublisherChallengeReveal(pending, challengeToken, 10000);
          });
        sendResponse({ ok: true, action: 'publisher_challenge_detected' });
        return false;
      }
      if (msg.accessDenied || msg.unsupported) {
        const reason = msg.error || (msg.accessDenied ? '出版商页面明确显示无正文访问权限。' : '当前出版商页面类型不支持。');
        tracePublisherStep(pending, msg.accessDenied ? 'publisher-access-denied' : 'publisher-unsupported', {
          publisher: msg.publisher || pending.publisher || '',
          articleUrl: msg.articleUrl || msg.pageUrl || pending.articleUrl || '',
          source: msg.source || '',
          error: reason
        });
        const err = new Error(reason);
        err.failureReason = msg.accessDenied ? 'no_access' : 'publisher_unsupported';
        pending.finishError(err);
        sendResponse({ ok: true, action: msg.accessDenied ? 'publisher_access_denied' : 'publisher_unsupported' });
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
        if (msg.pdfUrl) {
          pending.lastNativePdfUrl = msg.pdfUrl;
          if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        }
        pending.armDownloadCapture?.(msg.pdfUrl || pending.lastNativePdfUrl || pending.pdfUrl || pending.articleUrl || '');
        post(pending.port, 'progress', '已尝试在 ScienceDirect 页面触发原生 View PDF 按钮，继续监听浏览器下载。');
        sendResponse({ ok: true, action: 'clicked_native_view_pdf', pdfUrl: msg.pdfUrl || '' });
        return false;
      }
      if (msg.publisher === 'sciencedirect' && msg.pdfUrl) {
        markPublisherChallengePassed(pending);
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
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
        markPublisherChallengePassed(pending);
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
          sendResponse({ ok: true, ignored: true, reason: 'same native pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        if (typeof pending.downloadDirectFromPublisherUrl === 'function') {
          pending.downloadDirectFromPublisherUrl(msg.pdfUrl, msg.source || 'nature_pdf_direct')
            .then(() => sendResponse({ ok: true, action: 'download_nature_pdf_direct', pdfUrl: msg.pdfUrl }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
          return true;
        }
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
      if (msg.publisher === 'cnpe' && msg.pdfUrl) {
        markPublisherChallengePassed(pending);
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
          sendResponse({ ok: true, ignored: true, reason: 'same cnpe pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        if (msg.clicked) {
          pending.armDownloadCapture?.(msg.pdfUrl);
          post(pending.port, 'progress', '已在易阅通页面触发原生 PDF 下载，继续监听浏览器下载。');
          sendResponse({ ok: true, action: 'clicked_cnpe_pdf', pdfUrl: msg.pdfUrl });
          return false;
        }
        if (typeof pending.downloadDirectFromPublisherUrl === 'function') {
          pending.downloadDirectFromPublisherUrl(msg.pdfUrl, msg.source || 'cnpe_pdf_direct')
            .then(() => sendResponse({ ok: true, action: 'download_cnpe_pdf_direct', pdfUrl: msg.pdfUrl }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
          return true;
        }
        post(pending.port, 'progress', '已从易阅通文章页取得正文 PDF 下载链接，正在打开该链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_cnpe_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'rsc' && msg.pdfUrl) {
        markPublisherChallengePassed(pending);
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
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
      if (msg.publisher === 'ieee' && msg.pdfUrl) {
        markPublisherChallengePassed(pending);
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
          sendResponse({ ok: true, ignored: true, reason: 'same ieee pdf url already handled' });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (msg.articleUrl) pending.articleUrl = msg.articleUrl;
        pending.publisher = 'ieee';
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        tracePublisherStep(pending, 'publisher-pdf-url-received', {
          publisher: 'ieee',
          articleUrl: msg.articleUrl || msg.pageUrl || pending.articleUrl || '',
          pdfUrl: msg.pdfUrl,
          source: msg.source || '',
          diagnostics: msg.diagnostics || null
        });
        if (typeof pending.downloadDirectFromPublisherUrl === 'function') {
          pending.downloadDirectFromPublisherUrl(msg.pdfUrl, msg.source || 'ieee_metadata_pdf_path')
            .then(() => sendResponse({ ok: true, action: 'download_ieee_pdf_direct', pdfUrl: msg.pdfUrl }))
            .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
          return true;
        }
        pending.armDownloadCapture?.(msg.pdfUrl);
        post(pending.port, 'progress', '已从 IEEE 文章页取得正文 PDF 链接，正在打开下载链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_ieee_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (['springer', 'wiley', 'acs', 'oxford', 'sage'].includes(msg.publisher) && msg.pdfUrl) {
        markPublisherChallengePassed(pending);
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
          sendResponse({ ok: true, ignored: true, reason: `same ${msg.publisher} pdf url already handled` });
          return false;
        }
        pending.lastNativePdfUrl = msg.pdfUrl;
        if (msg.articleUrl) pending.articleUrl = msg.articleUrl;
        pending.publisher = msg.publisher;
        if (typeof pending.setExpectedDownloadUrl === 'function') pending.setExpectedDownloadUrl(msg.pdfUrl);
        pending.armDownloadCapture?.(msg.pdfUrl);
        tracePublisherStep(pending, 'publisher-pdf-url-received', {
          publisher: msg.publisher,
          articleUrl: msg.articleUrl || msg.pageUrl || pending.articleUrl || '',
          pdfUrl: msg.pdfUrl,
          source: msg.source || '',
          diagnostics: msg.diagnostics || null
        });
        post(pending.port, 'progress', `已从 ${msg.publisher} 文章页取得正文 PDF 链接，正在打开下载链接。`);
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: `navigate_to_${msg.publisher}_pdf`, pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'aip' && msg.pdfUrl) {
        markPublisherChallengePassed(pending);
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
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
        pending.armDownloadCapture?.(msg.pdfUrl);
        post(pending.port, 'progress', '已从 AIP 文章页取得正文 PDF 下载链接，正在打开该链接。');
        chromeApi.tabs.update(tabId, { url: msg.pdfUrl })
          .then(() => sendResponse({ ok: true, action: 'navigate_to_aip_pdf', pdfUrl: msg.pdfUrl }))
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }
      if (msg.publisher === 'iop' && msg.pdfUrl) {
        if (isSamePdfUrl(pending.lastNativePdfUrl, msg.pdfUrl)) {
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
      handlePublisherRuntimeMessage,
      postDebugLog
    };
  }

  globalThis.AblesciBackgroundPublisherMessages = {
    createBackgroundPublisherMessagesApi
  };
})(globalThis);
