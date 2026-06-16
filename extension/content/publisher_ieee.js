(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;
  let skipBookChapter = true;

  chrome.storage.local.get({ watcherSkipBookChapter: true }, function (res) {
    if (res && res.watcherSkipBookChapter !== undefined) {
      skipBookChapter = !!res.watcherSkipBookChapter;
    }
  });

  function normalize(href) {
    return common.normalizeUrl(common.decodeHtmlUrl(href || ''), location.href);
  }

  function ieeeArticleNumberFromUrl(url) {
    try {
      const u = new URL(String(url || ''), location.href);
      const documentMatch = (u.pathname || '').match(/^\/document\/(\d+)\/?$/i);
      if (documentMatch) return documentMatch[1];
      if (/^\/stamp\/stamp\.jsp$/i.test(u.pathname || '')) {
        const arnumber = u.searchParams.get('arnumber');
        return arnumber && /^\d+$/.test(arnumber) ? arnumber : '';
      }
    } catch (_) {}
    return '';
  }

  function encodeIeeeRef(articleUrl) {
    try {
      return btoa(String(articleUrl || ''));
    } catch (_) {
      return '';
    }
  }

  function ieeeGetPdfUrlFromArticleNumber(arnumber, articleUrl) {
    if (!arnumber || !/^\d+$/.test(arnumber)) return null;
    const ref = encodeIeeeRef(articleUrl || `https://ieeexplore.ieee.org/document/${arnumber}`);
    const suffix = ref ? `&ref=${encodeURIComponent(ref)}` : '';
    return `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${encodeURIComponent(arnumber)}${suffix}`;
  }

  function isIeeeBookPage() {
    const path = location.pathname || '';
    if (/^\/book\/\d+\/?$/i.test(path) || /^\/ebooks\/book\//i.test(path)) return true;
    if (document.querySelector('xpl-book-toc, xpl-book-toc-chapters')) return true;
    const canonical = document.querySelector('link[rel="canonical"][href]')?.href || '';
    if (/\/book\/\d+\/?$/i.test(canonical)) return true;
    const text = [
      document.querySelector('.document-title, h1')?.textContent || '',
      document.querySelector('[class*="book-toc"]')?.textContent || '',
      document.body?.innerText || ''
    ].join(' ').replace(/\s+/g, ' ').slice(0, 5000);
    return /Table of Contents/i.test(text) && /IEEE Books|Book Details|Book Chapters|Books for Purchase/i.test(text);
  }

  function findIeeePdfDownloadUrl() {
    if (common.currentPublisher() !== 'ieee') return null;
    if (/^\/stamp\/stamp\.jsp$/i.test(location.pathname || '')) {
      const iframeSrc = document.querySelector('iframe[src*="/stampPDF/getPDF.jsp"]')?.getAttribute('src') || '';
      if (iframeSrc) return normalize(iframeSrc);
      return ieeeGetPdfUrlFromArticleNumber(ieeeArticleNumberFromUrl(location.href), document.referrer || '');
    }
    if (!/^\/document\/\d+\/?$/i.test(location.pathname || '')) return null;
    const arnumber = ieeeArticleNumberFromUrl(location.href);
    const articleUrl = `https://ieeexplore.ieee.org/document/${arnumber}`;
    const getPdfUrl = ieeeGetPdfUrlFromArticleNumber(arnumber, articleUrl);
    if (getPdfUrl) return getPdfUrl;
    const scripts = Array.from(document.scripts)
      .map(script => script.textContent || '')
      .filter(Boolean)
      .join('\n');
    const pathMatch = scripts.match(/"pdfPath"\s*:\s*"([^"]+?\.pdf)"/i) ||
      scripts.match(/'pdfPath'\s*:\s*'([^']+?\.pdf)'/i);
    if (!pathMatch) return null;
    const pdfUrl = normalize(pathMatch[1]);
    if (!pdfUrl || !/\/iel\d*\/.+\.pdf(?:[?#].*)?$/i.test(pdfUrl)) return null;
    return ieeeGetPdfUrlFromArticleNumber(arnumber, articleUrl) || pdfUrl;
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
    if (common.currentPublisher() !== 'ieee' || pdfTriggered) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending IEEE task');
      stopObserver();
      return;
    }
    if (isIeeeBookPage()) {
      pdfTriggered = true;
      common.sendPublisherMessage('ieee', {
        articleUrl: location.href,
        unsupported: true,
        error: skipBookChapter
          ? 'IEEE 识别为书籍页面，已按设置自动跳过。'
          : 'IEEE 书籍页面暂不支持自动应助。',
        source: 'ieee_book_page'
      });
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        common.sendPublisherMessage('ieee', {
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'ieee_challenge_page'
        });
      }
      return;
    }
    const pdfUrl = findIeeePdfDownloadUrl();
    if (!pdfUrl) return;
    pdfTriggered = true;
    common.sendPublisherMessage('ieee', {
      articleUrl: location.href,
      pdfUrl,
      source: 'ieee_stamp_pdf_getpdf',
      diagnostics: {
        pagePath: location.pathname,
        endpoint: 'stampPDF/getPDF.jsp'
      }
    });
    stopObserver();
  }

  function start(timeoutMs = 30000) {
    if (common.currentPublisher() !== 'ieee') return;
    const startedAt = Date.now();
    const tick = () => {
      notifyReady();
      if (Date.now() - startedAt < timeoutMs && !pdfTriggered) {
        setTimeout(tick, 1000);
      }
    };
    tick();
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciIeeePublisher = { start };
})();
