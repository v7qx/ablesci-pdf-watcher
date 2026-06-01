(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;

  function findNatureArticlePdfLink() {
    const links = Array.from(document.querySelectorAll('a[href*=".pdf"]'))
      .map(a => {
        const href = common.decodeHtmlUrl(a.getAttribute('href') || a.href);
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
    common.sendPublisherMessage('nature', payload);
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
    if (!common.isNature() || pdfTriggered) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending Nature task');
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        sendNatureMessage({
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'nature_challenge_page'
        });
      }
      return;
    }
    const found = findNatureArticlePdfLink();
    if (!found) return;
    pdfTriggered = true;
    sendNatureMessage({
      pdfUrl: found.href,
      clicked: true,
      source: 'native_article_pdf_link'
    });
    setTimeout(() => found.link.click(), 0);
    stopObserver();
  }

  function waitForPdf(timeoutMs = 30000) {
    if (!common.isNature()) return;
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
    if (!common.isNature()) return;
    waitForPdf(timeoutMs);
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciNaturePublisher = { start };
})();
