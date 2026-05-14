(function () {
  'use strict';

  const host = location.hostname.toLowerCase();
  let viewPdfTriggered = false;
  let naturePdfTriggered = false;
  let scienceDirectObserver = null;
  let natureObserver = null;
  let scienceDirectStopTimer = null;
  let natureStopTimer = null;
  let canControlPromise = null;

  function isScienceDirect() {
    return /(^|\.)sciencedirect\.com$/i.test(host);
  }

  function isNature() {
    return /(^|\.)nature\.com$/i.test(host);
  }

  function currentPublisher() {
    if (isScienceDirect()) return 'sciencedirect';
    if (isNature()) return 'nature';
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
  });
})();
