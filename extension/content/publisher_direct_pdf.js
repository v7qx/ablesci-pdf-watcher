(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  const supported = new Set(['springer', 'oxford', 'wiley', 'acs', 'ieee']);
  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;

  function normalize(href) {
    return common.normalizeUrl(common.decodeHtmlUrl(href || ''), location.href);
  }

  function markerOf(el, href) {
    return [
      href || '',
      el.innerText || '',
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.className || '',
      el.id || ''
    ].join(' ').replace(/\s+/g, ' ');
  }

  function isSupplementary(marker) {
    return /supplement|supporting information|appendix|permissions|copyright|reprint|correction|erratum|figure|slide|image|video|dataset/i.test(marker);
  }

  function isPdfHref(href) {
    return /\.pdf(?:[?#]|$)|\/content\/pdf\/|\/doi\/pdf\/|\/doi\/epdf\/|\/article-pdf\/|\/articlepdf\/|\/stamp\/stamp\.jsp/i.test(href || '');
  }

  function directPdfSelectors() {
    return [
      'meta[name="citation_pdf_url"]',
      'meta[property="citation_pdf_url"]',
      'a.article-pdfLink[href]',
      'a[href*="/content/pdf/"]',
      'a[href*="/doi/pdf/"]',
      'a[href*="/doi/epdf/"]',
      'a[href*="/article-pdf/"]',
      'a[href*="/articlepdf/"]',
      'a[href*="/stamp/stamp.jsp"]',
      'a[href$=".pdf"]',
      'a[href*=".pdf?"]'
    ];
  }

  function findPdfLink() {
    const candidates = Array.from(document.querySelectorAll(directPdfSelectors().join(',')))
      .map(el => {
        const raw = el.getAttribute('content') || el.getAttribute('href') || el.href || '';
        const href = normalize(raw);
        const marker = markerOf(el, href);
        const visible = el.tagName === 'META' || common.isVisible(el);
        const textScore = /\b(pdf|download pdf|full text pdf)\b/i.test(marker) ? 2 : 0;
        const hrefScore = isPdfHref(href) ? 3 : 0;
        return { el, href, marker, visible, score: hrefScore + textScore };
      })
      .filter(item => item.href && item.visible && item.score > 0 && !isSupplementary(item.marker));
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
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
    const publisher = common.currentPublisher();
    if (!supported.has(publisher) || pdfTriggered) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending task for this tab');
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        common.sendPublisherMessage(publisher, {
          articleUrl: location.href,
          publisherChallenge: true,
          source: `${publisher}_challenge_page`
        });
      }
      return;
    }
    const found = findPdfLink();
    if (!found) return;
    pdfTriggered = true;
    common.sendPublisherMessage(publisher, {
      articleUrl: location.href,
      pdfUrl: found.href,
      source: `${publisher}_article_pdf_link`
    });
    stopObserver();
  }

  function start(timeoutMs = 30000) {
    if (!supported.has(common.currentPublisher())) return;
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

  window.AblesciDirectPdfPublisher = { start };
})();
