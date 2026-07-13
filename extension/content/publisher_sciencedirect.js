(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  const capability = globalThis.AblesciPublisherCapabilities?.forPublisher?.('sciencedirect') || null;
  const downloadGuard = globalThis.AblesciScienceDirectDownloadGuard;
  if (!common || !capability || !downloadGuard) return;

  let viewPdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let loginPrompted = false;
  let challengePrompted = false;
  let dailyLimitReported = false;
  let postClickFallbackTimer = null;
  let skipBookChapter = true;
  const pdfClickGuardMs = 30000;

  chrome.storage.local.get({ watcherSkipBookChapter: true }, function (res) {
    if (res && res.watcherSkipBookChapter !== undefined) {
      skipBookChapter = !!res.watcherSkipBookChapter;
    }
  });

  function inspectCurrentArticle() {
    const inspected = capability.inspectUrl(location.href);
    return ['article_page', 'chapter_page', 'pdf_landing'].includes(inspected.kind)
      ? inspected
      : null;
  }

  function getScienceDirectPii() {
    return inspectCurrentArticle()?.identity?.pii || null;
  }

  function makeScienceDirectArticleUrl() {
    const identity = inspectCurrentArticle()?.identity;
    if (!identity) return null;
    return identity.articleUrl.replace('https://www.sciencedirect.com', location.origin);
  }

  function makeScienceDirectPdfUrl() {
    const identity = inspectCurrentArticle()?.identity;
    if (!identity) return null;
    const articleUrl = identity.articleUrl.replace('https://www.sciencedirect.com', location.origin);
    const result = capability.createPdfCandidate({
      identity,
      url: articleUrl + '/pdf',
      source: 'constructed_current_pii_pdf'
    });
    return result.ok ? result.candidate.url : null;
  }

  function isScienceDirectPdfLandingPage() {
    return capability.inspectUrl(location.href).kind === 'pdf_landing';
  }

  function hasScienceDirectContentError() {
    const text = (document.body && document.body.innerText) || '';
    return /There was a problem providing the content you requested/i.test(text);
  }

  function collectNativePdfLinks() {
    const identity = capability.inspectUrl(location.href).identity;
    return Array.from(document.querySelectorAll('a[href*="/pdfft"], a[href*="/pdf"]'))
      .map(a => {
        const href = common.decodeHtmlUrl(a.getAttribute('href') || a.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const classes = a.className || '';
        const candidate = capability.createPdfCandidate({
          identity,
          url: href,
          source: 'native_view_pdf_link'
        });
        const looksLikeNativeViewPdf = /View PDF|Download PDF/i.test(text) ||
          /accessbar|utility|link-button|ViewPDF/i.test(`${classes} ${a.id || ''}`) ||
          /View PDF/i.test(a.getAttribute('aria-label') || '');
        return { a, href, sameArticle: candidate.ok, looksLikeNativeViewPdf };
      })
      .filter(item => item.href && item.sameArticle);
  }

  function findNativePdfLink() {
    const links = collectNativePdfLinks();
    links.sort((left, right) => {
      if (left.looksLikeNativeViewPdf !== right.looksLikeNativeViewPdf) return left.looksLikeNativeViewPdf ? -1 : 1;
      return 0;
    });
    return links[0] || null;
  }

  function findNativePdfHref() {
    const item = findNativePdfLink();
    if (!item?.href) return null;
    try {
      return new URL(item.href, location.href).href;
    } catch (_) {
      return null;
    }
  }

  function findViewPdfButton() {
    const nativeLink = findNativePdfLink();
    if (nativeLink?.a && common.isVisible(nativeLink.a)) return nativeLink.a;
    return null;
  }

  function hasScienceDirectNoSubscriptionAccess() {
    const preload = window.__PRELOADED_STATE__ || {};
    const article = preload.article || {};
    const entitlementReason = String(article.entitlementReason || article?.articleEntitlement?.entitlementOrigin || '').trim();
    const entitled = article?.articleEntitlement?.entitled;
    const displayViewFullText = article?.displayViewFullText;
    const isAbstract = article?.isAbstract;
    const isContentVisible = article?.isContentVisible;
    const remoteAccessLink = document.querySelector('a[href*="/user/institution/login"]');
    if (/unsubscribed/i.test(entitlementReason)) return true;
    if (entitled === false && displayViewFullText === false && isAbstract === true && isContentVisible === false) return true;
    if (entitled === false && remoteAccessLink && !findNativePdfHref() && !findViewPdfButton()) return true;

    const bodyText = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
    if (/does not subscribe to this content on ScienceDirect/i.test(bodyText)) return true;
    if (/your institution.*does not subscribe/i.test(bodyText)) return true;

    const disabledFullText = document.querySelector('a.full-text-link[aria-disabled="true"], a.full-text-link[tabindex="-1"]');
    const nativePdfHref = findNativePdfHref();
    const viewPdfButton = findViewPdfButton();
    return !!(disabledFullText && remoteAccessLink && !nativePdfHref && !viewPdfButton);
  }

  function isScienceDirectAbstractPage() {
    return /\/science\/article\/abs\/pii\/[^/?#]+(?:[/?#]|$)/i.test(location.pathname + location.search);
  }

  function hasScienceDirectLoginRequiredAccess() {
    if (!isScienceDirectAbstractPage()) return false;
    const hasNativePdf = !!findNativePdfHref();
    const hasPdfButton = !!findViewPdfButton();
    if (hasNativePdf || hasPdfButton) return false;
    const loginLink = document.querySelector('a[href*="/user/institution/login"], a[href*="login?targetURL="], a[href*="via%3Dihub"]');
    const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
    return !!loginLink || /\b(Remote access|Sign in|Access through your institution|institution login)\b/i.test(text);
  }

  function sendScienceDirectMessage(payload) {
    common.sendPublisherMessage('sciencedirect', payload);
  }

  function pdfClickGuardKey(pii) {
    return 'ablesci_sd_pdf_click_guard:' + String(pii || 'unknown');
  }

  function readPdfClickGuard(pii) {
    try {
      return JSON.parse(sessionStorage.getItem(pdfClickGuardKey(pii)) || 'null') || null;
    } catch (_) {
      return null;
    }
  }

  function writePdfClickGuard(pii, data) {
    try {
      sessionStorage.setItem(pdfClickGuardKey(pii), JSON.stringify({
        ...data,
        at: Date.now()
      }));
    } catch (_) {}
  }

  function recentlyTriedPdfClick(pii, pdfUrl) {
    const guard = readPdfClickGuard(pii);
    if (!guard) return false;
    if (Date.now() - Number(guard.at || 0) > pdfClickGuardMs) return false;
    return !pdfUrl || !guard.pdfUrl || guard.pdfUrl === pdfUrl;
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    if (postClickFallbackTimer) {
      clearTimeout(postClickFallbackTimer);
      postClickFallbackTimer = null;
    }
  }

  function inspectDownloadSafety() {
    return downloadGuard.inspectDownloadSafety({
      siteStorage: localStorage,
      extensionStorage: chrome.storage.local,
      document
    });
  }

  function reserveDirectAttempt() {
    return downloadGuard.reserveDirectAttempt({
      siteStorage: localStorage,
      extensionStorage: chrome.storage.local,
      document,
      reserveExtensionAttempt
    });
  }

  function reserveSiteClickAttempt() {
    return downloadGuard.reserveSiteClickAttempt({
      siteStorage: localStorage,
      extensionStorage: chrome.storage.local,
      document,
      reserveExtensionAttempt
    });
  }

  function reserveExtensionAttempt(details) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'ablesciScienceDirectReserveDownload',
        publisher: 'sciencedirect',
        pageUrl: location.href,
        ...details
      }, response => {
        const runtimeError = chrome.runtime.lastError;
        resolve(runtimeError || !response
          ? { blocked: true, reason: 'direct_counter_unavailable' }
          : response);
      });
    });
  }

  function reportDailyLimit(result, articleUrl, source) {
    if (dailyLimitReported) return;
    dailyLimitReported = true;
    viewPdfTriggered = true;
    sendScienceDirectMessage({
      articleUrl: articleUrl || makeScienceDirectArticleUrl() || location.href,
      publisherDailyLimit: true,
      dailyLimitReason: result.reason,
      siteCount: result.siteCount,
      directAttempts: result.directAttempts,
      effectiveCount: result.effectiveCount,
      dailyLimit: result.limit,
      dateKey: result.dateKey,
      expiresAt: result.expiresAt,
      source
    });
    stopObserver();
  }

  async function notifyReady() {
    if (!common.isScienceDirect()) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending ScienceDirect task');
      stopObserver();
      return;
    }

    const isBookOverview = /\/(?:science\/)?book\//i.test(location.pathname);
    if (isBookOverview) {
      sendScienceDirectMessage({
        articleUrl: location.href,
        unsupported: true,
        error: 'ScienceDirect 书籍或章节暂不支持自动应助（跳转到了书籍总览页）。',
        source: 'sciencedirect_book_overview'
      });
      stopObserver();
      return;
    }

    const pii = getScienceDirectPii();
    const isBookChapter = pii && pii.toUpperCase().startsWith('B');
    if (isBookChapter && skipBookChapter) {
      sendScienceDirectMessage({
        articleUrl: makeScienceDirectArticleUrl() || location.href,
        unsupported: true,
        error: 'ScienceDirect 识别为书籍章节，已按设置自动跳过。',
        source: 'sciencedirect_book_chapter'
      });
      stopObserver();
      return;
    }

    if (common.hasPrimarySupplementArticlePage?.()) {
      sendScienceDirectMessage({
        articleUrl: makeScienceDirectArticleUrl() || location.href,
        unsupported: true,
        error: 'ScienceDirect 页面识别为 Supplement / supplement issue 文献，已按异常附录求助跳过。',
        source: 'sciencedirect_supplement_article_page'
      });
      stopObserver();
      return;
    }

    if (isScienceDirectPdfLandingPage()) {
      if (common.hasPublisherChallengePage()) {
        if (!challengePrompted) {
          challengePrompted = true;
          sendScienceDirectMessage({
            articleUrl: makeScienceDirectArticleUrl() || location.href,
            publisherChallenge: true,
            source: 'sciencedirect_pdf_challenge_page'
          });
        }
        return;
      }
      if (hasScienceDirectContentError()) {
        sendScienceDirectMessage({
          error: 'ScienceDirect 返回错误页：There was a problem providing the content you requested。(可能已触发高频风控封锁，请排查并暂停值守/暂停应助。)'
        });
        stopObserver();
      }
      return;
    }

    const articleUrl = makeScienceDirectArticleUrl() || location.href;
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        sendScienceDirectMessage({
          articleUrl,
          publisherChallenge: true,
          source: 'sciencedirect_challenge_page'
        });
      }
      return;
    }
    const safety = await inspectDownloadSafety();
    if (safety.modalDetected || (!viewPdfTriggered && safety.blocked)) {
      reportDailyLimit(
        safety,
        articleUrl,
        safety.modalDetected ? 'sciencedirect_daily_limit_dialog' : 'sciencedirect_daily_count_preflight'
      );
      return;
    }
    if (viewPdfTriggered) return;
    const button = findViewPdfButton();
    if (button) {
      const buttonHref = button.getAttribute?.('href') || button.href || '';
      const pdfUrl = common.normalizeUrl(buttonHref, location.href) || '';
      if (recentlyTriedPdfClick(pii, pdfUrl)) {
        sendScienceDirectMessage({
          articleUrl,
          pdfUrl,
          publisherDiagnostic: true,
          source: 'native_view_pdf_button_loop_guard',
          diagnostics: { reason: 'recent_pdf_button_click_already_attempted' }
        });
        stopObserver();
        return;
      }
      const reservation = await reserveSiteClickAttempt();
      if (reservation.blocked) {
        reportDailyLimit(reservation, articleUrl, 'native_view_pdf_button_daily_limit');
        return;
      }
      viewPdfTriggered = true;
      writePdfClickGuard(pii, { pdfUrl, source: 'native_view_pdf_button' });
      sendScienceDirectMessage({
        articleUrl,
        clicked: true,
        pdfUrl,
        source: 'native_view_pdf_button'
      });
      setTimeout(() => {
        const beforeUrl = location.href;
        try {
          if (button.tagName && String(button.tagName).toLowerCase() === 'a') {
            button.setAttribute('target', '_self');
          }
        } catch (_) {}
        try {
          button.click();
        } catch (_) {}
        if (pdfUrl) {
          postClickFallbackTimer = setTimeout(async () => {
            postClickFallbackTimer = null;
            const postClickSafety = await inspectDownloadSafety();
            if (postClickSafety.modalDetected) {
              reportDailyLimit(
                postClickSafety,
                articleUrl,
                'sciencedirect_daily_limit_dialog_after_click'
              );
              return;
            }
            if (location.href === beforeUrl) {
              sendScienceDirectMessage({
                articleUrl,
                pdfUrl,
                publisherDiagnostic: true,
                source: 'native_view_pdf_button_no_navigation',
                diagnostics: { reason: 'button_click_no_navigation_direct_fallback_disabled' }
              });
            }
          }, 1200);
        }
      }, 0);
      return;
    }
    const nativePdfHref = findNativePdfHref();
    if (nativePdfHref) {
      viewPdfTriggered = true;
      const reservation = await reserveDirectAttempt();
      if (reservation.blocked) {
        reportDailyLimit(reservation, articleUrl, 'native_view_pdf_href_daily_limit');
        return;
      }
      sendScienceDirectMessage({
        articleUrl,
        pdfUrl: nativePdfHref,
        source: 'native_view_pdf_href'
      });
      stopObserver();
      return;
    }
    if (hasScienceDirectNoSubscriptionAccess()) {
      sendScienceDirectMessage({
        articleUrl,
        noSubscription: true,
        error: 'ScienceDirect 当前页面没有正文订阅权限。'
      });
      stopObserver();
      return;
    }
    if (hasScienceDirectLoginRequiredAccess()) {
      if (!loginPrompted) {
        loginPrompted = true;
        sendScienceDirectMessage({
          articleUrl,
          loginRequired: true,
          source: 'sciencedirect_login_required'
        });
      }
      return;
    }

    const constructedPdfUrl = makeScienceDirectPdfUrl();
    if (constructedPdfUrl) {
      viewPdfTriggered = true;
      const reservation = await reserveDirectAttempt();
      if (reservation.blocked) {
        reportDailyLimit(reservation, articleUrl, 'constructed_pdf_daily_limit');
        return;
      }
      sendScienceDirectMessage({
        articleUrl,
        pdfUrl: constructedPdfUrl,
        source: 'constructed_current_pii_pdf'
      });
      stopObserver();
      return;
    }

  }

  function waitForViewPdf(timeoutMs = 30000) {
    if (!common.isScienceDirect()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyReady();
      if (Date.now() - startedAt < timeoutMs && !viewPdfTriggered && !isScienceDirectPdfLandingPage()) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function start(timeoutMs = 30000) {
    if (!common.isScienceDirect()) return;
    waitForViewPdf(timeoutMs);
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciScienceDirectPublisher = { start };
})();
