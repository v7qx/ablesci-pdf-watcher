(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;

  function findAipArticlePdfLink() {
    const links = Array.from(document.querySelectorAll('a[href*="/article-pdf/"]'))
      .map(a => {
        const href = common.decodeHtmlUrl(a.getAttribute('href') || a.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const marker = [
          a.getAttribute('data-doctype') || '',
          a.className || '',
          a.id || ''
        ].join(' ');
        const articlePdf = /article-pdfLink/i.test(a.className || '') ||
          /stats-item-pdf-download/i.test(a.className || '') ||
          /contentPdf/i.test(a.getAttribute('data-doctype') || '') ||
          /\/article-pdf\//i.test(href);
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

  function sendAipMessage(payload) {
    common.sendPublisherMessage('aip', payload);
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
    if (!common.isAip() || pdfTriggered) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending AIP task');
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        sendAipMessage({
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'aip_challenge_page'
        });
      }
      return;
    }
    const found = findAipArticlePdfLink();
    if (!found) return;
    pdfTriggered = true;
    sendAipMessage({
      pdfUrl: found.href,
      clicked: true,
      source: 'aip_article_pdf_link'
    });
    setTimeout(() => found.link.click(), 0);
    stopObserver();
  }

  function waitForPdf(timeoutMs = 30000) {
    if (!common.isAip()) return;
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
    if (!common.isAip()) return;
    waitForPdf(timeoutMs);
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciAipPublisher = { start };
})();
