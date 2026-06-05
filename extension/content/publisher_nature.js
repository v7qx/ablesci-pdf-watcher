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

  function hasNatureNoSubscriptionAccess() {
    if (findNatureArticlePdfLink()) return false;
    const hasAccessProvider = !!document.querySelector('.c-article-access-provider');
    const hasPaywallContainer = !!document.querySelector(
      '.c-article-paywall, .c-paywall, #paywall, .paywall, .paywall-container, [data-test="paywall"]'
    );
    const hasAccessOptionsHeader = Array.from(document.querySelectorAll('h2, h3')).some(h =>
      /Access options/i.test(h.innerText || h.textContent || '')
    );
    const bodyText = (document.body && document.body.innerText) || '';
    const hasPaywallText = [
      'This is a preview of subscription content',
      'Subscribe to this journal',
      'Buy this article',
      'Rent or buy this article',
      'access via your institution'
    ].some(text => bodyText.includes(text));

    return hasAccessProvider || hasPaywallContainer || hasAccessOptionsHeader || hasPaywallText;
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
    if (hasNatureNoSubscriptionAccess()) {
      sendNatureMessage({
        articleUrl: location.href,
        noSubscription: true,
        error: 'Nature 明确返回没有正文订阅权限。'
      });
      stopObserver();
      return;
    }
    const found = findNatureArticlePdfLink();
    if (!found) return;
    pdfTriggered = true;
    sendNatureMessage({
      pdfUrl: found.href,
      clicked: false,
      source: 'native_article_pdf_link'
    });
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
