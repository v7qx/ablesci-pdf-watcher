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

  function isRsc() {
    return /(^|\.)pubs\.rsc\.org$/i.test(host);
  }

  function isAip() {
    return /(^|\.)aip\.org$/i.test(host) || /(^|\.)scitation\.org$/i.test(host);
  }

  function currentPublisher() {
    if (isScienceDirect()) return 'sciencedirect';
    if (isNature()) return 'nature';
    if (isRsc()) return 'rsc';
    if (isAip()) return 'aip';
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
    const titleLooksLikeChallenge = /^(Just a moment|Attention Required|Security Check|Cloudflare)/i.test(title) ||
      /验证你是真人|请完成验证|安全检查/i.test(title);
    const bodyLooksLikeChallenge =
      /verify you are human|complete the security check|checking your browser before accessing|enable javascript and cookies to continue|ray id|cf[- ]?challenge|cf[- ]?turnstile/i.test(shortText) ||
      /验证你是真人|请完成验证|安全检查|正在检查您的浏览器/i.test(shortText);
    return hasChallengeDom || titleLooksLikeChallenge || bodyLooksLikeChallenge;
  }

  function sendPublisherMessage(publisher, payload) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher,
      pageUrl: location.href,
      ...payload
    }, () => {
      // 没有 pending 任务时 background 会忽略；这里不需要处理返回。
      void chrome.runtime.lastError;
    });
  }

  window.AblesciPublisherCommon = {
    isScienceDirect,
    isNature,
    isRsc,
    isAip,
    currentPublisher,
    canControlCurrentPublisherPage,
    decodeHtmlUrl,
    normalizeUrl,
    isVisible,
    hasPublisherChallengePage,
    sendPublisherMessage
  };
})();
