(function () {
  'use strict';

  const host = location.hostname.toLowerCase();
  let canControlPromise = null;

  function isScienceDirect() {
    // PRIVATE_WATCHER_ONLY
    return /(^|\.)sciencedirect\.com$/i.test(host) || /(^|\.)elsevier\.com$/i.test(host);
  }

  function isNature() {
    return /(^|\.)nature\.com$/i.test(host);
  }

  function isSpringer() {
    return host === 'link.springer.com';
  }

  function isRsc() {
    return /(^|\.)(?:pubs|books)\.rsc\.org$/i.test(host);
  }

  function isWiley() {
    return host === 'onlinelibrary.wiley.com' || host.endsWith('.onlinelibrary.wiley.com');
  }

  function isAip() {
    return /(^|\.)aip\.org$/i.test(host) || /(^|\.)scitation\.org$/i.test(host);
  }

  function isAcs() {
    return host === 'pubs.acs.org';
  }

  function isIeee() {
    return host === 'ieeexplore.ieee.org';
  }

  function isOxford() {
    return host === 'academic.oup.com';
  }

  function isIop() {
    return /(^|\.)iop\.org$/i.test(host);
  }

  function isCnpe() {
    return /(^|\.)cnpereading\.com$/i.test(host);
  }

  function currentPublisher() {
    if (isScienceDirect()) return 'sciencedirect';
    if (isNature()) return 'nature';
    if (isSpringer()) return 'springer';
    if (isRsc()) return 'rsc';
    if (isWiley()) return 'wiley';
    if (isAip()) return 'aip';
    if (isAcs()) return 'acs';
    if (isIeee()) return 'ieee';
    if (isOxford()) return 'oxford';
    if (isIop()) return 'iop';
    if (isCnpe()) return 'cnpe';
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

  function decodeHtmlUrl(value) {
    return String(value || '').replace(/&amp;/g, '&');
  }

  function normalizeUrl(href, base) {
    try { return new URL(href, base || location.href).href; } catch (_) { return null; }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function pageText() {
    return ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
  }

  function hasPublisherChallengePage() {
    const text = pageText();
    const shortText = text.slice(0, 4000);
    const title = String(document.title || '').trim();
    const hasChallengeDom = !!document.querySelector(
      '#challenge-running, #challenge-stage, #cf-challenge-running, #cf-wrapper, #cf-error-details, ' +
      'form#challenge-form, form[action*=\"/cdn-cgi/challenge-platform/\"], ' +
      'iframe[title*=\"captcha\" i], iframe[src*=\"captcha\" i], ' +
      'input[name=\"cf-turnstile-response\"], textarea[name=\"g-recaptcha-response\"], ' +
      '[data-sitekey], .cf-turnstile, .g-recaptcha, .h-captcha'
    );
    const titleLooksLikeChallenge = /^(Just a moment|Attention Required|Security Check|Cloudflare|Client Challenge)/i.test(title) ||
      /验证你是真人|请完成验证|安全检查/i.test(title);
    const bodyLooksLikeChallenge =
      /verify you are human|are you a robot|confirm you are a human|captcha challenge|complete the security check|checking your browser before accessing|enable javascript and cookies to continue|ray id|cf[- ]?challenge|cf[- ]?turnstile|oops, something went wrong/i.test(shortText) ||
      /验证你是真人|请完成验证|安全检查|正在检查您的浏览器/i.test(shortText);
    return hasChallengeDom || titleLooksLikeChallenge || bodyLooksLikeChallenge;
  }

  function metaContent(selector) {
    return document.querySelector(selector)?.getAttribute('content') || '';
  }

  function pathHasSupplementSegment(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl || ''), location.href);
    } catch (_) {
      return false;
    }
    return url.pathname
      .split('/')
      .map(part => {
        try {
          return decodeURIComponent(part).toLowerCase();
        } catch (_) {
          return String(part || '').toLowerCase();
        }
      })
      .filter(Boolean)
      .some(part => /^(?:supplement|supplements|supp|suppl)(?:[-_]\w+)?$/i.test(part));
  }

  function metaUrlHasSupplementSegment(selector) {
    const value = document.querySelector(selector)?.getAttribute('href') ||
      document.querySelector(selector)?.getAttribute('content') || '';
    return value && pathHasSupplementSegment(value);
  }

  function sciencedirectPageDataHasSupplement() {
    try {
      const contents = Array.isArray(window.pageData?.content) ? window.pageData.content : [];
      return contents.some(item => {
        const suppl = String(item?.suppl || '').trim();
        return /^S$/i.test(suppl) || /^(?:supp|suppl|supplement|supplements)$/i.test(suppl);
      });
    } catch (_) {
      return false;
    }
  }

  function publicationMetadataHasSupplement() {
    const containers = Array.from(document.querySelectorAll([
      '.Publication .publication-volume',
      '.publication-volume',
      '[class*="publication-volume"]',
      '[data-testid*="publication"]',
      '[data-test-id*="publication"]'
    ].join(',')));
    return containers.some(container => {
      const text = String(container.innerText || container.textContent || '').replace(/\s+/g, ' ').trim();
      const links = Array.from(container.querySelectorAll('a[href], a[title]'));
      const linkSignal = links.some(link => {
        const href = link.getAttribute('href') || link.href || '';
        const title = link.getAttribute('title') || '';
        const hrefSupplementIssue = /\/issue\/[^/]+\/(?:suppl|supp|supplement|supplements)\/S(?:\/|$)/i.test(href) ||
          /\/(?:suppl|supp|supplement|supplements)\/S(?:\/|$)/i.test(href) && /\bSupplement\b/i.test(text);
        return hrefSupplementIssue ||
          /table of contents for this volume\/issue/i.test(title) && /\bSupplement\b/i.test(text);
      });
      const textSignal = /(?:Volume|Vol\.?)\s+\d+[^,;]{0,60}(?:Issue|No\.?)\s+\d+[^,;]{0,60}\bSupplement\b/i.test(text) &&
        /Pages?\s+S\d+/i.test(text);
      return linkSignal || textSignal;
    });
  }

  function hasPrimarySupplementArticlePage() {
    if (hasPublisherChallengePage()) return false;
    if (pathHasSupplementSegment(location.href)) return true;

    const citationIssue = metaContent('meta[name="citation_issue"], meta[property="citation_issue"]');
    if (/\b(?:supplement|supplements|suppl|supp)(?:[-_\s]?\w+)?\b/i.test(citationIssue)) return true;

    const citationFirstPage = metaContent('meta[name="citation_firstpage"], meta[property="citation_firstpage"]');
    const citationLastPage = metaContent('meta[name="citation_lastpage"], meta[property="citation_lastpage"]');
    if (isScienceDirect() && /^S\d+[A-Z]?$/i.test(citationFirstPage) && /^S\d+[A-Z]?$/i.test(citationLastPage || citationFirstPage)) return true;

    if (metaUrlHasSupplementSegment('link[rel="canonical"][href]')) return true;
    if (metaUrlHasSupplementSegment('meta[name="citation_pdf_url"], meta[property="citation_pdf_url"]')) return true;
    if (metaUrlHasSupplementSegment('meta[property="og:url"], meta[name="dc.identifier"][content]')) return true;

    if (isScienceDirect() && sciencedirectPageDataHasSupplement()) return true;
    if (publicationMetadataHasSupplement()) return true;

    return false;
  }

  function sendPublisherMessage(publisher, payload, onResponse) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher,
      pageUrl: location.href,
      ...payload
    }, response => {
      const runtimeError = chrome.runtime.lastError || null;
      if (typeof onResponse === 'function') onResponse(response, runtimeError);
    });
  }

  // 接收后台转发的调试日志，输出到页面 F12 控制台
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ablesciBackgroundLog') {
      console.log('[Background]', String(msg.text || ''));
    }
  });

  window.AblesciPublisherCommon = {
    isScienceDirect,
    isNature,
    isSpringer,
    isRsc,
    isWiley,
    isAip,
    isAcs,
    isIeee,
    isOxford,
    isIop,
    isCnpe,
    currentPublisher,
    canControlCurrentPublisherPage,
    decodeHtmlUrl,
    normalizeUrl,
    isVisible,
    hasPublisherChallengePage,
    hasPrimarySupplementArticlePage,
    sendPublisherMessage
  };
})();
