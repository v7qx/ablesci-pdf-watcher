(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;
  let unsupportedReported = false;

  function findIopArticlePdfLink() {
    const links = Array.from(document.querySelectorAll('a[href*="/pdf"]'))
      .map(a => {
        const href = common.decodeHtmlUrl(a.getAttribute('href') || a.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const marker = [
          a.className || '',
          a.id || ''
        ].join(' ');
        const articlePdf = /wd-jnl-art-pdf-button/i.test(a.className || '') ||
          /content-download/i.test(a.className || '') ||
          /\/article\/.*\/pdf/i.test(href);
        const supplementary = /supplement|supp-info|peer review|reporting summary/i.test(`${href} ${text} ${marker}`);
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

  function sendIopMessage(payload) {
    common.sendPublisherMessage('iop', payload);
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
    if (!common.isIop() || pdfTriggered || unsupportedReported) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending IOP task');
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        sendIopMessage({
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'iop_challenge_page'
        });
      }
      return;
    }
    const found = findIopArticlePdfLink();
    if (!found) return;
    pdfTriggered = true;
    sendIopMessage({
      pdfUrl: found.href,
      clicked: true,
      source: 'iop_article_pdf_link'
    });
    setTimeout(() => found.link.click(), 0);
    stopObserver();
  }

  async function reportUnsupportedNoPdf() {
    if (!common.isIop() || pdfTriggered || unsupportedReported) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) return;
    unsupportedReported = true;
    sendIopMessage({
      articleUrl: location.href,
      unsupported: true,
      error: 'IOP 文章页没有正文 PDF 按钮，已跳过。',
      source: 'iop_no_pdf_button'
    });
    stopObserver();
  }

  function waitForPdf(timeoutMs = 30000) {
    if (!common.isIop()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyReady().catch(() => {});
      if (Date.now() - startedAt < timeoutMs && !pdfTriggered && !unsupportedReported) {
        setTimeout(tick, 1000);
      } else if (!pdfTriggered && !unsupportedReported) {
        reportUnsupportedNoPdf().catch(() => stopObserver());
      }
    };
    tick();
  }

  function start(timeoutMs = 30000) {
    if (!common.isIop()) return;
    waitForPdf(timeoutMs);
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(() => {
      reportUnsupportedNoPdf().catch(() => stopObserver());
    }, timeoutMs + 1000);
  }

  window.AblesciIopPublisher = { start };
})();
