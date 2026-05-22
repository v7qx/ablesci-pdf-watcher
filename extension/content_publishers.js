(function () {
  'use strict';

  const host = location.hostname.toLowerCase();
  let viewPdfTriggered = false;
  let naturePdfTriggered = false;
  let rscPdfTriggered = false;
  let scienceDirectObserver = null;
  let natureObserver = null;
  let rscObserver = null;
  let scienceDirectStopTimer = null;
  let natureStopTimer = null;
  let rscStopTimer = null;
  let canControlPromise = null;
  let scienceDirectLoginPrompted = false;

  function isScienceDirect() {
    return /(^|\.)sciencedirect\.com$/i.test(host);
  }

  function isNature() {
    return /(^|\.)nature\.com$/i.test(host);
  }

  function isRsc() {
    return /(^|\.)pubs\.rsc\.org$/i.test(host);
  }

  function currentPublisher() {
    if (isScienceDirect()) return 'sciencedirect';
    if (isNature()) return 'nature';
    if (isRsc()) return 'rsc';
    return '';
  }

  function canControlCurrentPublisherPage() {
    if (canControlPromise) return canControlPromise;
    canControlPromise = new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'ablesciPublisherCanControl',
        publisher: currentPublisher(),
        pageUrl: location.href
      }, resp => {
        void chrome.runtime.lastError;
        resolve(!!resp?.ok);
      });
    });
    return canControlPromise;
  }

  function getScienceDirectPii() {
    const m = location.pathname.match(/\/science\/article\/pii\/([^/?#]+)/i);
    return m ? m[1] : null;
  }

  function decodeHtmlUrl(value) {
    return String(value || '').replace(/&amp;/g, '&');
  }

  function normalizeUrl(href, base) {
    try { return new URL(href, base || location.href).href; } catch (_) { return null; }
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

  function hasScienceDirectNoSubscriptionAccess() {
    const bodyText = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
    if (/does not subscribe to this content on ScienceDirect/i.test(bodyText)) return true;
    if (/your institution.*does not subscribe/i.test(bodyText)) return true;

    const disabledFullText = document.querySelector('a.full-text-link[aria-disabled="true"], a.full-text-link[tabindex="-1"]');
    const remoteAccessLink = document.querySelector('a[href*="/user/institution/login"]');
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

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findNativePdfHref() {
    const currentPii = getScienceDirectPii();
    const links = Array.from(document.querySelectorAll('a[href*="/pdfft"], a[href*="/pdf"]'))
      .map(a => {
        const href = decodeHtmlUrl(a.getAttribute('href') || a.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const classes = a.className || '';
        const piiMatch = href.match(/\/science\/article\/pii\/([^/?#]+)\/(?:pdf|pdfft)/i);
        const sameArticle = !!currentPii && !!piiMatch && piiMatch[1] === currentPii;
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
      if (!isVisible(el)) return false;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      return /\b(View PDF|Download PDF|PDF)\b/i.test(text);
    }) || null;
  }

  function sendScienceDirectMessage(payload) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher: 'sciencedirect',
      pageUrl: location.href,
      ...payload
    }, () => {
      // 没有 pending 任务时 background 会忽略；这里不需要处理返回。
      void chrome.runtime.lastError;
    });
  }

  function stopScienceDirectObserver() {
    if (scienceDirectObserver) {
      scienceDirectObserver.disconnect();
      scienceDirectObserver = null;
    }
    if (scienceDirectStopTimer) {
      clearTimeout(scienceDirectStopTimer);
      scienceDirectStopTimer = null;
    }
  }

  async function notifyScienceDirectReady() {
    if (!isScienceDirect()) return;
    if (!(await canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending ScienceDirect task');
      stopScienceDirectObserver();
      return;
    }

    if (isScienceDirectPdfLandingPage()) {
      if (hasScienceDirectContentError()) {
        sendScienceDirectMessage({
          error: 'ScienceDirect 返回错误页：There was a problem providing the content you requested。'
        });
        stopScienceDirectObserver();
      }
      return;
    }

    const articleUrl = makeScienceDirectArticleUrl();
    if (!articleUrl) return;
    if (hasScienceDirectLoginRequiredAccess()) {
      if (!scienceDirectLoginPrompted) {
        scienceDirectLoginPrompted = true;
        sendScienceDirectMessage({
          articleUrl,
          loginRequired: true,
          source: 'sciencedirect_login_required'
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
      stopScienceDirectObserver();
      return;
    }
    const nativePdfHref = findNativePdfHref();
    if (nativePdfHref) {
      viewPdfTriggered = true;
      sendScienceDirectMessage({
        articleUrl,
        pdfUrl: nativePdfHref,
        source: 'native_view_pdf_href'
      });
      stopScienceDirectObserver();
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
      stopScienceDirectObserver();
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
      stopScienceDirectObserver();
    }
  }

  function waitForScienceDirectViewPdf(timeoutMs = 30000) {
    if (!isScienceDirect()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyScienceDirectReady();
      if (Date.now() - startedAt < timeoutMs && !viewPdfTriggered && !isScienceDirectPdfLandingPage()) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function findNatureArticlePdfLink() {
    const links = Array.from(document.querySelectorAll('a[href*=".pdf"]'))
      .map(a => {
        const href = decodeHtmlUrl(a.getAttribute('href') || a.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const marker = [
          a.getAttribute('data-article-pdf') || '',
          a.getAttribute('data-test') || '',
          a.getAttribute('data-track-action') || '',
          a.className || '',
          a.id || ''
        ].join(' ');
        const articlePdf = /true/i.test(a.getAttribute('data-article-pdf') || '') ||
          /download-pdf/i.test(a.getAttribute('data-test') || '') ||
          /article pdf download/i.test(a.getAttribute('data-track-type') || '') ||
          /c-pdf-download__link/.test(a.className || '') ||
          /_reference\.pdf(?:[?#]|$)/i.test(href);
        const supplementary = /supplement|supp-info|peer review|reporting summary|MOESM|static-content\.springer\.com/i.test(`${href} ${text} ${marker}`);
        return { a, href, text, articlePdf, supplementary };
      })
      .filter(item => item.href && item.articlePdf && !item.supplementary);

    for (const item of links) {
      try {
        return { link: item.a, href: new URL(item.href, location.href).href };
      } catch (_) {}
    }
    return null;
  }

  function sendNatureMessage(payload) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher: 'nature',
      pageUrl: location.href,
      ...payload
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function sendRscMessage(payload) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher: 'rsc',
      pageUrl: location.href,
      ...payload
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function stopRscObserver() {
    if (rscObserver) {
      rscObserver.disconnect();
      rscObserver = null;
    }
    if (rscStopTimer) {
      clearTimeout(rscStopTimer);
      rscStopTimer = null;
    }
  }

  function rscArticleLandingUrlFromPdfUrl(url) {
    try {
      const u = new URL(url, location.href);
      u.pathname = u.pathname.replace(/\/content\/articlepdf\//i, '/content/articlelanding/');
      return u.href;
    } catch (_) {
      return location.href;
    }
  }

  function findRscArticlePdfLink() {
    const metaSelectors = [
      'meta[name="citation_pdf_url"]',
      'meta[property="citation_pdf_url"]'
    ];
    for (const sel of metaSelectors) {
      const value = document.querySelector(sel)?.getAttribute('content') || '';
      if (/\/content\/articlepdf\//i.test(value)) {
        const href = normalizeUrl(value, location.href);
        if (href) return { href, source: 'citation_pdf_url' };
      }
    }

    const links = Array.from(document.querySelectorAll('a[href*="/content/articlepdf/"], a[type="application/pdf"], a[href*="articlepdf"]'))
      .map(a => {
        const href = normalizeUrl(decodeHtmlUrl(a.getAttribute('href') || a.href), location.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const marker = [
          a.className || '',
          a.id || '',
          a.getAttribute('type') || '',
          a.getAttribute('target') || ''
        ].join(' ');
        const articlePdf = /\/content\/articlepdf\//i.test(href || '') ||
          /Download this article|PDF format|PDF/i.test(`${text} ${marker}`);
        const supplementary = /supplement|supporting information|esm|si\b|permissions|copyright|reprint/i.test(`${href || ''} ${text} ${marker}`);
        return { a, href, text, articlePdf, supplementary };
      })
      .filter(item => item.href && item.articlePdf && !item.supplementary);

    links.sort((left, right) => {
      const leftStrong = /Download this article|PDF format/i.test(left.text) ? 1 : 0;
      const rightStrong = /Download this article|PDF format/i.test(right.text) ? 1 : 0;
      return rightStrong - leftStrong;
    });

    const found = links[0];
    return found ? { link: found.a, href: found.href, source: 'article_pdf_link' } : null;
  }

  async function notifyRscReady() {
    if (!isRsc() || rscPdfTriggered) return;
    if (!(await canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending RSC task');
      stopRscObserver();
      return;
    }
    const found = findRscArticlePdfLink();
    if (!found) return;
    rscPdfTriggered = true;
    sendRscMessage({
      articleUrl: rscArticleLandingUrlFromPdfUrl(found.href),
      pdfUrl: found.href,
      source: found.source
    });
    stopRscObserver();
  }

  function waitForRscPdf(timeoutMs = 30000) {
    if (!isRsc()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyRscReady();
      if (Date.now() - startedAt < timeoutMs && !rscPdfTriggered) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function stopNatureObserver() {
    if (natureObserver) {
      natureObserver.disconnect();
      natureObserver = null;
    }
    if (natureStopTimer) {
      clearTimeout(natureStopTimer);
      natureStopTimer = null;
    }
  }

  async function notifyNatureReady() {
    if (!isNature() || naturePdfTriggered) return;
    if (!(await canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending Nature task');
      stopNatureObserver();
      return;
    }
    const found = findNatureArticlePdfLink();
    if (!found) return;
    naturePdfTriggered = true;
    sendNatureMessage({
      pdfUrl: found.href,
      clicked: true,
      source: 'native_article_pdf_link'
    });
    setTimeout(() => found.link.click(), 0);
    stopNatureObserver();
  }

  function waitForNaturePdf(timeoutMs = 30000) {
    if (!isNature()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyNatureReady();
      if (Date.now() - startedAt < timeoutMs && !naturePdfTriggered) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  // ScienceDirect 有时先经过验证/跳转，持续等待原生 View PDF 入口；成功或超时后断开观察器，避免影响普通浏览。
  canControlCurrentPublisherPage().then(ok => {
    if (!ok) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending task for this tab');
      return;
    }
    if (isScienceDirect()) {
      waitForScienceDirectViewPdf();
      scienceDirectObserver = new MutationObserver(() => notifyScienceDirectReady());
      scienceDirectObserver.observe(document.documentElement, { childList: true, subtree: true });
      scienceDirectStopTimer = setTimeout(stopScienceDirectObserver, 30000);
    }
    if (isNature()) {
      waitForNaturePdf();
      natureObserver = new MutationObserver(() => notifyNatureReady());
      natureObserver.observe(document.documentElement, { childList: true, subtree: true });
      natureStopTimer = setTimeout(stopNatureObserver, 30000);
    }
    if (isRsc()) {
      waitForRscPdf();
      rscObserver = new MutationObserver(() => notifyRscReady());
      rscObserver.observe(document.documentElement, { childList: true, subtree: true });
      rscStopTimer = setTimeout(stopRscObserver, 30000);
    }
  });
})();
