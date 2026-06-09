(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let viewPdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let loginPrompted = false;
  let challengePrompted = false;
  let skipBookChapter = true;

  chrome.storage.local.get({ watcherSkipBookChapter: true }, function (res) {
    if (res && res.watcherSkipBookChapter !== undefined) {
      skipBookChapter = !!res.watcherSkipBookChapter;
    }
  });

  function getScienceDirectPii() {
    const m = location.pathname.match(/\/(?:science\/article|science\/chapter)\/(?:abs\/)?pii\/([^/?#]+)/i);
    return m ? m[1] : null;
  }

  function makeScienceDirectArticleUrl() {
    const pii = getScienceDirectPii();
    if (!pii) return null;
    return location.origin + '/science/article/pii/' + pii;
  }

  function makeScienceDirectPdfUrl() {
    const pii = getScienceDirectPii();
    if (!pii) return null;
    return location.origin + '/science/article/pii/' + pii + '/pdf';
  }

  function isScienceDirectPdfLandingPage() {
    return /\/science\/article\/pii\/[^/?#]+\/(?:pdf|pdfft)(?:[/?#]|$)/i.test(location.pathname + location.search);
  }

  function hasScienceDirectContentError() {
    const text = (document.body && document.body.innerText) || '';
    return /There was a problem providing the content you requested/i.test(text);
  }

  function findNativePdfHref() {
    const currentPii = getScienceDirectPii();
    const links = Array.from(document.querySelectorAll('a[href*="/pdfft"], a[href*="/pdf"]'))
      .map(a => {
        const href = common.decodeHtmlUrl(a.getAttribute('href') || a.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const classes = a.className || '';
        const piiMatch = href.match(/\/science\/article\/pii\/([^/?#]+)\/(?:pdf|pdfft)/i);
        const sameArticle = !!currentPii && !!piiMatch && (
          piiMatch[1] === currentPii ||
          (piiMatch[1].substring(0, 10) === currentPii.substring(0, 10))
        );
        const looksLikeNativeViewPdf = /View PDF|Download PDF/i.test(text) ||
          /accessbar|utility|link-button|ViewPDF/i.test(`${classes} ${a.id || ''}`) ||
          /View PDF/i.test(a.getAttribute('aria-label') || '');
        return { a, href, sameArticle, looksLikeNativeViewPdf };
      })
      .filter(item => item.href && (!currentPii || item.sameArticle));

    links.sort((left, right) => {
      if (left.looksLikeNativeViewPdf !== right.looksLikeNativeViewPdf) return left.looksLikeNativeViewPdf ? -1 : 1;
      return 0;
    });

    for (const item of links) {
      const href = item.href;
      if (!href) continue;
      try {
        return new URL(href, location.href).href;
      } catch (_) {}
    }
    return null;
  }

  function findViewPdfButton() {
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    return candidates.find(el => {
      if (!common.isVisible(el)) return false;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      return /\b(View PDF|Download PDF|PDF)\b/i.test(text);
    }) || null;
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

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
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

    if (isScienceDirectPdfLandingPage()) {
      if (hasScienceDirectContentError()) {
        sendScienceDirectMessage({
          error: 'ScienceDirect 返回错误页：There was a problem providing the content you requested。(可能已触发高频风控封锁，请排查并暂停值守/暂停应助。)'
        });
        stopObserver();
      }
      return;
    }

    const articleUrl = makeScienceDirectArticleUrl() || location.href;
    const nativePdfHref = findNativePdfHref();
    if (nativePdfHref) {
      viewPdfTriggered = true;
      sendScienceDirectMessage({
        articleUrl,
        pdfUrl: nativePdfHref,
        source: 'native_view_pdf_href'
      });
      stopObserver();
      return;
    }
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
      sendScienceDirectMessage({
        articleUrl,
        pdfUrl: constructedPdfUrl,
        source: 'constructed_current_pii_pdf'
      });
      stopObserver();
      return;
    }

    if (viewPdfTriggered) return;
    const button = findViewPdfButton();
    if (button) {
      viewPdfTriggered = true;
      sendScienceDirectMessage({
        articleUrl,
        clicked: true,
        source: 'native_view_pdf_button'
      });
      setTimeout(() => button.click(), 0);
      stopObserver();
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
