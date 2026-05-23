(function () {
  'use strict';

  const host = location.hostname.toLowerCase();
  let viewPdfTriggered = false;
  let naturePdfTriggered = false;
  let rscPdfTriggered = false;
  let sagePdfTriggered = false;
  let scienceDirectObserver = null;
  let natureObserver = null;
  let rscObserver = null;
  let sageObserver = null;
  let scienceDirectStopTimer = null;
  let natureStopTimer = null;
  let rscStopTimer = null;
  let sageStopTimer = null;
  let canControlPromise = null;
  let scienceDirectLoginPrompted = false;
  let scienceDirectChallengePrompted = false;
  let natureChallengePrompted = false;
  let rscChallengePrompted = false;
  let sageChallengePrompted = false;
  const LAST_SAGE_TRACE_KEY = 'lastSageTrace';

  function isScienceDirect() {
    return /(^|\.)sciencedirect\.com$/i.test(host);
  }

  function isNature() {
    return /(^|\.)nature\.com$/i.test(host);
  }

  function isRsc() {
    return /(^|\.)pubs\.rsc\.org$/i.test(host);
  }

  function isSage() {
    return /(^|\.)journals\.sagepub\.com$/i.test(host) || /(^|\.)sage\.cnpereading\.com$/i.test(host);
  }

  function currentPublisher() {
    if (isScienceDirect()) return 'sciencedirect';
    if (isNature()) return 'nature';
    if (isRsc()) return 'rsc';
    if (isSage()) return 'sage';
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
        const lastErr = chrome.runtime.lastError;
        if (lastErr && isSage()) {
          appendLocalSageTrace('content_script_ready', {
            url: traceUrlValue(location.href),
            action: 'ablesciPublisherCanControl',
            runtimeLastError: lastErr.message || String(lastErr)
          });
        }
        resolve(!!resp?.ok);
      });
    });
    return canControlPromise;
  }

  function getScienceDirectPii() {
    const m = location.pathname.match(/\/science\/article\/(?:abs\/)?pii\/([^/?#]+)/i);
    return m ? m[1] : null;
  }

  function decodeHtmlUrl(value) {
    return String(value || '').replace(/&amp;/g, '&');
  }

  function normalizeUrl(href, base) {
    try { return new URL(href, base || location.href).href; } catch (_) { return null; }
  }

  function makeScienceDirectArticleUrl() {
    const pii = getScienceDirectPii();
    if (!pii) return null;
    return location.origin + '/science/article/pii/' + pii;
  }

  function makeScienceDirectPdfUrl() {
    const pii = getScienceDirectPii();
    if (!pii) return null;
    return location.origin + '/science/article/pii/' + pii + '/pdf';
  }

  function isScienceDirectPdfLandingPage() {
    return /\/science\/article\/pii\/[^/?#]+\/(?:pdf|pdfft)(?:[/?#]|$)/i.test(location.pathname + location.search);
  }

  function hasScienceDirectContentError() {
    const text = (document.body && document.body.innerText) || '';
    return /There was a problem providing the content you requested/i.test(text);
  }

  function hasScienceDirectNoSubscriptionAccess() {
    const preload = window.__PRELOADED_STATE__ || {};
    const article = preload.article || {};
    const entitlementReason = String(article.entitlementReason || article?.articleEntitlement?.entitlementOrigin || '').trim();
    const entitled = article?.articleEntitlement?.entitled;
    const displayViewFullText = article?.displayViewFullText;
    const isAbstract = article?.isAbstract;
    const isContentVisible = article?.isContentVisible;
    const remoteAccessLink = document.querySelector('a[href*="/user/institution/login"]');
    if (/unsubscribed/i.test(entitlementReason)) return true;
    if (entitled === false && displayViewFullText === false && isAbstract === true && isContentVisible === false) return true;
    if (entitled === false && remoteAccessLink && !findNativePdfHref() && !findViewPdfButton()) return true;

    const bodyText = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
    if (/does not subscribe to this content on ScienceDirect/i.test(bodyText)) return true;
    if (/your institution.*does not subscribe/i.test(bodyText)) return true;

    const disabledFullText = document.querySelector('a.full-text-link[aria-disabled="true"], a.full-text-link[tabindex="-1"]');
    const nativePdfHref = findNativePdfHref();
    const viewPdfButton = findViewPdfButton();
    return !!(disabledFullText && remoteAccessLink && !nativePdfHref && !viewPdfButton);
  }

  function isScienceDirectAbstractPage() {
    return /\/science\/article\/abs\/pii\/[^/?#]+(?:[/?#]|$)/i.test(location.pathname + location.search);
  }

  function hasScienceDirectLoginRequiredAccess() {
    if (!isScienceDirectAbstractPage()) return false;
    const hasNativePdf = !!findNativePdfHref();
    const hasPdfButton = !!findViewPdfButton();
    if (hasNativePdf || hasPdfButton) return false;
    const loginLink = document.querySelector('a[href*="/user/institution/login"], a[href*="login?targetURL="], a[href*="via%3Dihub"]');
    const text = ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
    return !!loginLink || /\b(Remote access|Sign in|Access through your institution|institution login)\b/i.test(text);
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findNativePdfHref() {
    const currentPii = getScienceDirectPii();
    const links = Array.from(document.querySelectorAll('a[href*="/pdfft"], a[href*="/pdf"]'))
      .map(a => {
        const href = decodeHtmlUrl(a.getAttribute('href') || a.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const classes = a.className || '';
        const piiMatch = href.match(/\/science\/article\/pii\/([^/?#]+)\/(?:pdf|pdfft)/i);
        const sameArticle = !!currentPii && !!piiMatch && piiMatch[1] === currentPii;
        const looksLikeNativeViewPdf = /View PDF|Download PDF/i.test(text) ||
          /accessbar|utility|link-button|ViewPDF/i.test(`${classes} ${a.id || ''}`) ||
          /View PDF/i.test(a.getAttribute('aria-label') || '');
        return { a, href, sameArticle, looksLikeNativeViewPdf };
      })
      .filter(item => item.href && (!currentPii || item.sameArticle));

    links.sort((left, right) => {
      if (left.looksLikeNativeViewPdf !== right.looksLikeNativeViewPdf) return left.looksLikeNativeViewPdf ? -1 : 1;
      return 0;
    });

    for (const item of links) {
      const href = item.href;
      if (!href) continue;
      try {
        return new URL(href, location.href).href;
      } catch (_) {}
    }
    return null;
  }

  function findViewPdfButton() {
    const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'));
    return candidates.find(el => {
      if (!isVisible(el)) return false;
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      return /\b(View PDF|Download PDF|PDF)\b/i.test(text);
    }) || null;
  }

  function sendScienceDirectMessage(payload) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher: 'sciencedirect',
      pageUrl: location.href,
      ...payload
    }, () => {
      // 没有 pending 任务时 background 会忽略；这里不需要处理返回。
      void chrome.runtime.lastError;
    });
  }

  function pageText() {
    return ((document.body && document.body.innerText) || '').replace(/\s+/g, ' ').trim();
  }

  function traceUrlValue(value) {
    try {
      const parsed = new URL(value || location.href, location.href);
      return { host: parsed.host, path: parsed.pathname || '/' };
    } catch (_) {
      return { host: '', path: '' };
    }
  }

  function appendLocalSageTrace(step, details = {}) {
    const entry = {
      time: new Date().toISOString(),
      step,
      details
    };
    try {
      chrome.storage.local.get(LAST_SAGE_TRACE_KEY, stored => {
        const list = Array.isArray(stored?.[LAST_SAGE_TRACE_KEY]) ? stored[LAST_SAGE_TRACE_KEY] : [];
        list.unshift(entry);
        chrome.storage.local.set({ [LAST_SAGE_TRACE_KEY]: list.slice(0, 120) }, () => {
          void chrome.runtime.lastError;
        });
      });
    } catch (_) {}
  }

  function sendSageTrace(step, details = {}) {
    appendLocalSageTrace(step, details);
    chrome.runtime.sendMessage({
      type: 'ablesciSageTrace',
      step,
      url: location.href,
      ...details
    }, () => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        appendLocalSageTrace(step, {
          ...details,
          runtimeLastError: lastErr.message || String(lastErr)
        });
      }
    });
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function waitForDocumentComplete(timeoutMs = 5000) {
    if (document.readyState === 'complete') return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const timer = setTimeout(() => done(false), Math.max(500, Number(timeoutMs) || 5000));

      function done(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener('readystatechange', onReadyStateChange);
        window.removeEventListener('load', onLoad);
        resolve(ok);
      }

      function onReadyStateChange() {
        if (document.readyState === 'complete') done(true);
      }

      function onLoad() {
        done(true);
      }

      document.addEventListener('readystatechange', onReadyStateChange);
      window.addEventListener('load', onLoad, { once: true });
    });
  }

  function requestSageWebRequestCapture() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'ablesciPrepareSageWebRequestCapture',
        pageUrl: location.href
      }, resp => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          sendSageTrace('timeout_if_no_webrequest_captured', {
            currentUrl: traceUrlValue(location.href),
            runtimeLastError: lastErr.message || String(lastErr)
          });
          return resolve(false);
        }
        if (!resp?.ok) {
          sendSageTrace('timeout_if_no_webrequest_captured', {
            currentUrl: traceUrlValue(location.href),
            runtimeLastError: resp?.error || 'webRequest capture setup failed'
          });
        }
        resolve(!!resp?.ok);
      });
    });
  }

  function requestSageCaptureStatus() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        type: 'ablesciSageCaptureStatus',
        pageUrl: location.href
      }, resp => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) return resolve({ ok: false, error: lastErr.message || String(lastErr) });
        resolve(resp || { ok: false });
      });
    });
  }

  function notifySageAutoCaptureFailed(selector) {
    chrome.runtime.sendMessage({
      type: 'ablesciSageAutoCaptureFailed',
      pageUrl: location.href,
      selector
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function clickSagePdfButton(button) {
    try {
      button.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (_) {}
    try {
      button.focus();
    } catch (_) {}
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      try {
        button.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window
        }));
      } catch (_) {}
    }
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

  function stopScienceDirectObserver() {
    if (scienceDirectObserver) {
      scienceDirectObserver.disconnect();
      scienceDirectObserver = null;
    }
    if (scienceDirectStopTimer) {
      clearTimeout(scienceDirectStopTimer);
      scienceDirectStopTimer = null;
    }
  }

  async function notifyScienceDirectReady() {
    if (!isScienceDirect()) return;
    if (!(await canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending ScienceDirect task');
      stopScienceDirectObserver();
      return;
    }

    if (isScienceDirectPdfLandingPage()) {
      if (hasScienceDirectContentError()) {
        sendScienceDirectMessage({
          error: 'ScienceDirect 返回错误页：There was a problem providing the content you requested。'
        });
        stopScienceDirectObserver();
      }
      return;
    }

    const articleUrl = makeScienceDirectArticleUrl() || location.href;
    const nativePdfHref = findNativePdfHref();
    if (nativePdfHref) {
      viewPdfTriggered = true;
      sendScienceDirectMessage({
        articleUrl,
        pdfUrl: nativePdfHref,
        source: 'native_view_pdf_href'
      });
      stopScienceDirectObserver();
      return;
    }
    if (hasPublisherChallengePage()) {
      if (!scienceDirectChallengePrompted) {
        scienceDirectChallengePrompted = true;
        sendScienceDirectMessage({
          articleUrl,
          publisherChallenge: true,
          source: 'sciencedirect_challenge_page'
        });
      }
      return;
    }
    if (hasScienceDirectNoSubscriptionAccess()) {
      sendScienceDirectMessage({
        articleUrl,
        noSubscription: true,
        error: 'ScienceDirect 当前页面没有正文订阅权限。'
      });
      stopScienceDirectObserver();
      return;
    }
    if (hasScienceDirectLoginRequiredAccess()) {
      if (!scienceDirectLoginPrompted) {
        scienceDirectLoginPrompted = true;
        sendScienceDirectMessage({
          articleUrl,
          loginRequired: true,
          source: 'sciencedirect_login_required'
        });
      }
      return;
    }

    const constructedPdfUrl = makeScienceDirectPdfUrl();
    if (constructedPdfUrl) {
      viewPdfTriggered = true;
      sendScienceDirectMessage({
        articleUrl,
        pdfUrl: constructedPdfUrl,
        source: 'constructed_current_pii_pdf'
      });
      stopScienceDirectObserver();
      return;
    }

    if (viewPdfTriggered) return;
    const button = findViewPdfButton();
    if (button) {
      viewPdfTriggered = true;
      sendScienceDirectMessage({
        articleUrl,
        clicked: true,
        source: 'native_view_pdf_button'
      });
      setTimeout(() => button.click(), 0);
      stopScienceDirectObserver();
    }
  }

  function waitForScienceDirectViewPdf(timeoutMs = 30000) {
    if (!isScienceDirect()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyScienceDirectReady();
      if (Date.now() - startedAt < timeoutMs && !viewPdfTriggered && !isScienceDirectPdfLandingPage()) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function findNatureArticlePdfLink() {
    const links = Array.from(document.querySelectorAll('a[href*=".pdf"]'))
      .map(a => {
        const href = decodeHtmlUrl(a.getAttribute('href') || a.href);
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
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher: 'nature',
      pageUrl: location.href,
      ...payload
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function sendRscMessage(payload) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher: 'rsc',
      pageUrl: location.href,
      ...payload
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function sendSageMessage(payload) {
    chrome.runtime.sendMessage({
      type: 'ablesciPublisherArticleReady',
      publisher: 'sage',
      pageUrl: location.href,
      ...payload
    }, () => {
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        sendSageTrace('content_script_ready', {
          action: payload?.source || '',
          runtimeLastError: lastErr.message || String(lastErr)
        });
      }
    });
  }

  function stopRscObserver() {
    if (rscObserver) {
      rscObserver.disconnect();
      rscObserver = null;
    }
    if (rscStopTimer) {
      clearTimeout(rscStopTimer);
      rscStopTimer = null;
    }
  }

  function stopSageObserver() {
    if (sageObserver) {
      sageObserver.disconnect();
      sageObserver = null;
    }
    if (sageStopTimer) {
      clearTimeout(sageStopTimer);
      sageStopTimer = null;
    }
  }

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
        const href = normalizeUrl(value, location.href);
        if (href) return { href, source: 'citation_pdf_url' };
      }
    }

    const links = Array.from(document.querySelectorAll('a[href*="/content/articlepdf/"], a[type="application/pdf"], a[href*="articlepdf"]'))
      .map(a => {
        const href = normalizeUrl(decodeHtmlUrl(a.getAttribute('href') || a.href), location.href);
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

  function findSageArticlePdfLink() {
    const metaSelectors = [
      'meta[name="citation_pdf_url"]',
      'meta[property="citation_pdf_url"]'
    ];
    for (const sel of metaSelectors) {
      const value = document.querySelector(sel)?.getAttribute('content') || '';
      const href = normalizeUrl(value, location.href);
      if (href && !/supplement|suppl|appendix|supporting/i.test(href)) {
        return { href, source: 'citation_pdf_url' };
      }
    }

    const links = Array.from(document.querySelectorAll('a[href], button[data-href]'))
      .map(el => {
        const rawHref = el.getAttribute('href') || el.getAttribute('data-href') || '';
        const href = normalizeUrl(decodeHtmlUrl(rawHref), location.href);
        const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const marker = [
          el.className || '',
          el.id || '',
          el.getAttribute('data-id') || '',
          el.getAttribute('data-category') || '',
          el.getAttribute('data-action') || ''
        ].join(' ');
        const articlePdf = /\/doi\/(?:pdf|epdf)\//i.test(href || '') ||
          /Download PDF|View PDF|Full Text PDF|PDF下载|下载PDF|PDF/i.test(`${text} ${marker}`);
        const supplementary = /supplement|suppl|supporting|appendix|peer review|table|figure/i.test(`${href || ''} ${text} ${marker}`);
        return { el, href, text, articlePdf, supplementary };
      })
      .filter(item => item.href && item.articlePdf && !item.supplementary);

    links.sort((left, right) => {
      const leftStrong = /Download PDF|Full Text PDF|下载PDF/i.test(left.text) ? 1 : 0;
      const rightStrong = /Download PDF|Full Text PDF|下载PDF/i.test(right.text) ? 1 : 0;
      return rightStrong - leftStrong;
    });

    const found = links[0];
    return found ? { link: found.el, href: found.href, source: 'article_pdf_link' } : null;
  }

  function findSageDownloadEndpoint() {
    if (!/(^|\.)sage\.cnpereading\.com$/i.test(host)) return null;
    const html = document.documentElement?.innerHTML || '';
    const absoluteMatch = html.match(/https:\/\/sage\.cnpereading\.com\/website\/journal\/download\?articleId=([A-F0-9]{16,})/i);
    if (absoluteMatch) {
      return `https://sage.cnpereading.com/website/journal/download?articleId=${absoluteMatch[1]}`;
    }
    const relativeMatch = html.match(/\/website\/journal\/download\?articleId=([A-F0-9]{16,})/i);
    if (relativeMatch) {
      return `https://sage.cnpereading.com/website/journal/download?articleId=${relativeMatch[1]}`;
    }
    const idMatch = html.match(/["']articleId["']\s*:\s*["']([A-F0-9]{16,})["']/i);
    if (idMatch) {
      return `https://sage.cnpereading.com/website/journal/download?articleId=${idMatch[1]}`;
    }
    return null;
  }

  function findSagePdfButton() {
    const candidates = Array.from(document.querySelectorAll(
      'button[data-id="article-toolbar-pdf"], button[aria-label="PDF"], button[aria-label*="PDF"], [role="button"][data-id="article-toolbar-pdf"]'
    ));
    const matching = candidates.filter(el => {
      const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      const marker = [
        el.className || '',
        el.id || '',
        el.getAttribute('data-id') || '',
        el.getAttribute('data-category') || '',
        el.getAttribute('data-action') || ''
      ].join(' ');
      return /(^| )PDF( |$)|Download PDF|Full Text PDF|下载PDF/i.test(`${text} ${marker}`);
    });
    return matching.find(isVisible) || matching[0] || null;
  }

  async function notifyRscReady() {
    if (!isRsc() || rscPdfTriggered) return;
    if (!(await canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending RSC task');
      stopRscObserver();
      return;
    }
    if (hasPublisherChallengePage()) {
      if (!rscChallengePrompted) {
        rscChallengePrompted = true;
        sendRscMessage({
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'rsc_challenge_page'
        });
      }
      return;
    }
    const found = findRscArticlePdfLink();
    if (!found) return;
    rscPdfTriggered = true;
    sendRscMessage({
      articleUrl: rscArticleLandingUrlFromPdfUrl(found.href),
      pdfUrl: found.href,
      source: found.source
    });
    stopRscObserver();
  }

  function waitForRscPdf(timeoutMs = 30000) {
    if (!isRsc()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyRscReady();
      if (Date.now() - startedAt < timeoutMs && !rscPdfTriggered) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  async function notifySageReady() {
    if (!isSage() || sagePdfTriggered) return;
    if (!(await canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending SAGE task');
      stopSageObserver();
      return;
    }
    if (hasPublisherChallengePage()) {
      if (!sageChallengePrompted) {
        sageChallengePrompted = true;
        sendSageMessage({
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'sage_challenge_page'
        });
      }
      return;
    }
    const button = findSagePdfButton();
    const allCandidates = Array.from(document.querySelectorAll(
      'button[data-id="article-toolbar-pdf"], button[aria-label="PDF"], button[aria-label*="PDF"], [role="button"][data-id="article-toolbar-pdf"]'
    ));
    const selector = button?.matches?.('button[data-id="article-toolbar-pdf"], [role="button"][data-id="article-toolbar-pdf"]')
      ? 'button[data-id="article-toolbar-pdf"]'
      : (button?.matches?.('button[aria-label="PDF"], button[aria-label*="PDF"]') ? 'button[aria-label="PDF"]' : '');
    sendSageTrace('sage_pdf_button_scan', {
      url: traceUrlValue(location.href),
      selector,
      candidateCount: allCandidates.length,
      foundDataIdButton: !!document.querySelector('button[data-id="article-toolbar-pdf"], [role="button"][data-id="article-toolbar-pdf"]'),
      foundAriaPdfButton: !!document.querySelector('button[aria-label="PDF"], button[aria-label*="PDF"]')
    });
    if (button) {
      sagePdfTriggered = true;
      const buttonText = (button.innerText || button.textContent || button.getAttribute('aria-label') || button.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
      sendSageTrace('sage_auto_start', {
        url: traceUrlValue(location.href),
        selector
      });
      await waitForDocumentComplete(5000);
      await delay(1800);
      sendSageTrace('wait_after_complete_or_hydration', {
        url: traceUrlValue(location.href),
        selector
      });
      const captureOk = await requestSageWebRequestCapture();
      if (!captureOk) {
        sendSageTrace('timeout_if_no_webrequest_captured', {
          selector,
          currentUrl: traceUrlValue(location.href),
          runtimeLastError: 'webRequest capture setup failed before click'
        });
        return;
      }
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const statusBefore = await requestSageCaptureStatus();
        if (statusBefore?.captured || statusBefore?.handled) break;
        const currentButton = findSagePdfButton();
        const currentUrl = location.href;
        const urlOk = /^https:\/\/sage\.cnpereading\.com\/doi\//i.test(currentUrl);
        if (!urlOk || !currentButton) {
          sendSageTrace('timeout_if_no_webrequest_captured_after_retries', {
            selector,
            currentUrl: traceUrlValue(currentUrl),
            attempt,
            runtimeLastError: !urlOk ? 'sage doi url changed before retry' : 'sage pdf button missing before retry'
          });
          notifySageAutoCaptureFailed(selector);
          break;
        }
        sendSageTrace('sage_auto_click_attempt', {
          attempt,
          selector,
          currentUrl: traceUrlValue(currentUrl)
        });
        clickSagePdfButton(currentButton);
        sendSageMessage({
          articleUrl: location.href,
          clicked: true,
          source: 'sage_toolbar_pdf_button',
          selector,
          buttonText,
          attempt
        });
        await delay(5000);
        const statusAfter = await requestSageCaptureStatus();
        if (statusAfter?.captured || statusAfter?.handled) break;
        if (attempt === 3) {
          sendSageTrace('timeout_if_no_webrequest_captured_after_retries', {
            selector,
            currentUrl: traceUrlValue(location.href),
            attempt
          });
          notifySageAutoCaptureFailed(selector);
        }
      }
      stopSageObserver();
      return;
    }

    const endpoint = findSageDownloadEndpoint();
    if (endpoint) {
      sagePdfTriggered = true;
      sendSageTrace('sage_pdf_button_scan', {
        url: traceUrlValue(location.href),
        selector: 'download_endpoint',
        candidateCount: 0,
        foundDataIdButton: false,
        foundAriaPdfButton: false
      });
      sendSageMessage({
        articleUrl: location.href,
        pdfUrl: endpoint,
        source: 'sage_download_endpoint'
      });
      stopSageObserver();
      return;
    }

    const found = findSageArticlePdfLink();
    if (!found) return;
    sagePdfTriggered = true;
    sendSageTrace('sage_pdf_button_scan', {
      url: traceUrlValue(location.href),
      selector: 'direct_pdf_link',
      candidateCount: 0,
      foundDataIdButton: false,
      foundAriaPdfButton: false
    });
    sendSageMessage({
      articleUrl: location.href,
      pdfUrl: found.href,
      source: found.source
    });
    stopSageObserver();
  }

  function waitForSagePdf(timeoutMs = 30000) {
    if (!isSage()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifySageReady();
      if (Date.now() - startedAt < timeoutMs && !sagePdfTriggered) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  function stopNatureObserver() {
    if (natureObserver) {
      natureObserver.disconnect();
      natureObserver = null;
    }
    if (natureStopTimer) {
      clearTimeout(natureStopTimer);
      natureStopTimer = null;
    }
  }

  async function notifyNatureReady() {
    if (!isNature() || naturePdfTriggered) return;
    if (!(await canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending Nature task');
      stopNatureObserver();
      return;
    }
    if (hasPublisherChallengePage()) {
      if (!natureChallengePrompted) {
        natureChallengePrompted = true;
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
    naturePdfTriggered = true;
    sendNatureMessage({
      pdfUrl: found.href,
      clicked: true,
      source: 'native_article_pdf_link'
    });
    setTimeout(() => found.link.click(), 0);
    stopNatureObserver();
  }

  function waitForNaturePdf(timeoutMs = 30000) {
    if (!isNature()) return;
    const startedAt = Date.now();
    const tick = () => {
      notifyNatureReady();
      if (Date.now() - startedAt < timeoutMs && !naturePdfTriggered) {
        setTimeout(tick, 1000);
      }
    };
    tick();
  }

  // ScienceDirect 有时先经过验证/跳转，持续等待原生 View PDF 入口；成功或超时后断开观察器，避免影响普通浏览。
  canControlCurrentPublisherPage().then(ok => {
    if (!ok) {
      console.debug('[Ablesci PDF Uploader] publisher page ignored: no pending task for this tab');
      return;
    }
    if (isScienceDirect()) {
      waitForScienceDirectViewPdf();
      scienceDirectObserver = new MutationObserver(() => notifyScienceDirectReady());
      scienceDirectObserver.observe(document.documentElement, { childList: true, subtree: true });
      scienceDirectStopTimer = setTimeout(stopScienceDirectObserver, 30000);
    }
    if (isNature()) {
      waitForNaturePdf();
      natureObserver = new MutationObserver(() => notifyNatureReady());
      natureObserver.observe(document.documentElement, { childList: true, subtree: true });
      natureStopTimer = setTimeout(stopNatureObserver, 30000);
    }
    if (isRsc()) {
      waitForRscPdf();
      rscObserver = new MutationObserver(() => notifyRscReady());
      rscObserver.observe(document.documentElement, { childList: true, subtree: true });
      rscStopTimer = setTimeout(stopRscObserver, 30000);
    }
    if (isSage()) {
      sendSageTrace('content_script_injected', {
        url: traceUrlValue(location.href),
        status: document.readyState
      });
      waitForSagePdf();
      sageObserver = new MutationObserver(() => notifySageReady());
      sageObserver.observe(document.documentElement, { childList: true, subtree: true });
      sageStopTimer = setTimeout(stopSageObserver, 30000);
    }
  });
})();
