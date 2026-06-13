(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;

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
        const href = common.normalizeUrl(value, location.href);
        if (href) return { href, source: 'citation_pdf_url' };
      }
    }

    const links = Array.from(document.querySelectorAll('a[href*="/content/articlepdf/"], a[type="application/pdf"], a[href*="articlepdf"]'))
      .map(a => {
        const href = common.normalizeUrl(common.decodeHtmlUrl(a.getAttribute('href') || a.href), location.href);
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

  function sendRscMessage(payload) {
    common.sendPublisherMessage('rsc', payload);
  }

  function hasRscAccessDeniedPage() {
    return !!document.querySelector('.paywall__body, .paywall__container, .paywall__title, a[href*="/buyarticlepdf/"], .btn-icon--trolley');
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
    if (!common.isRsc() || pdfTriggered) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending RSC task');
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        sendRscMessage({
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'rsc_challenge_page'
        });
      }
      return;
    }
    if (hasRscAccessDeniedPage()) {
      pdfTriggered = true;
      sendRscMessage({
        articleUrl: location.href,
        accessDenied: true,
        error: 'RSC 明确返回无正文订阅权限（Paywall）。',
        source: 'rsc_paywall_page'
      });
      stopObserver();
      return;
    }
    const found = findRscArticlePdfLink();
    if (!found) return;
    pdfTriggered = true;
    sendRscMessage({
      articleUrl: rscArticleLandingUrlFromPdfUrl(found.href),
      pdfUrl: found.href,
      source: found.source
    });
    stopObserver();
  }

  function waitForPdf(timeoutMs = 30000) {
    if (!common.isRsc()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyReady();
      if (Date.now() - startedAt < timeoutMs && !pdfTriggered) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function start(timeoutMs = 30000) {
    if (!common.isRsc()) return;
    waitForPdf(timeoutMs);
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciRscPublisher = { start };
})();
