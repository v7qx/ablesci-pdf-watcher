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

  function hasAipAccessDeniedPage() {
    const accessMarker = document.querySelector('#UserHasAccess[data-userhasaccess="False"]');
    if (accessMarker) return true;
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
    if (/You do not currently have access to this content/i.test(text)) return true;
    if (/Pay-Per-View Access/i.test(text)) return true;
    if (document.querySelector('.article-top-info-user-restricted-options, .paywall')) return true;
    return false;
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
    if (hasAipAccessDeniedPage()) {
      pdfTriggered = true;
      sendAipMessage({
        articleUrl: location.href,
        accessDenied: true,
        error: 'AIP 页面明确显示无正文访问权限，已停止本次下载。',
        source: 'aip_access_denied_page'
      });
      stopObserver();
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
