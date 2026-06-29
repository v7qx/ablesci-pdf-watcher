(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let settled = false;
  let observer = null;
  let stopTimer = null;

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
  }

  function sendMessage(payload, onResponse) {
    common.sendPublisherMessage('cnpe', payload, onResponse);
  }

  function pageText() {
    return String(document.body?.innerText || document.body?.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function publicationNotFoundReason() {
    const alert = document.querySelector('[role="alert"]');
    const text = String(alert?.innerText || alert?.textContent || pageText()).replace(/\s+/g, ' ').trim();
    return /Publication not found\s*:|未找到该出版物\s*[：:]?/i.test(text) ? text.slice(0, 240) : '';
  }

  function hasRestrictedAccess() {
    if (document.querySelector(
      'button[aria-label="Get access" i], button[aria-label*="Get Access to this article" i], ' +
      '[data-id^="restricted-access_get-access"], [data-category="restricted-access"][data-action="get-access"]'
    )) return true;
    return /\bRestricted access\b|Get full access to this article|View all access options for this article/i.test(pageText());
  }

  function isInsideSupplementarySection(element) {
    try {
      return !!element?.closest?.('.article-annex, .article-annex-content, #supplementary-materials');
    } catch (_) {
      return false;
    }
  }

  function findArticlePdfButton() {
    const selector = 'button[data-id="article-toolbar-pdf"], button[aria-label="PDF" i]';
    for (const element of document.querySelectorAll(selector)) {
      if (element.disabled || element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') continue;
      if (isInsideSupplementarySection(element) || !common.isVisible(element)) continue;
      const text = String(element.innerText || element.textContent || '').trim();
      const dataId = String(element.getAttribute('data-id') || '');
      const ariaLabel = String(element.getAttribute('aria-label') || '');
      if (dataId === 'article-toolbar-pdf' || /^PDF$/i.test(ariaLabel) || /^PDF$/i.test(text)) return element;
    }
    return null;
  }

  function clickAfterBackgroundArmed(button) {
    settled = true;
    sendMessage({
      articleUrl: location.href,
      pdfUrl: location.href,
      clicked: true,
      source: 'sage_cnpe_pdf_button_click',
      diagnostics: {
        dataId: button.getAttribute('data-id') || '',
        ariaLabel: button.getAttribute('aria-label') || '',
        supplementaryAncestor: false
      }
    }, (response, runtimeError) => {
      if (runtimeError || !response?.ok || response.action !== 'clicked_cnpe_pdf') {
        settled = false;
        console.warn('[Ablesci PDF Watcher] SAGE domestic PDF listener was not armed', runtimeError || response);
        return;
      }
      setTimeout(() => button.click(), 0);
      stopObserver();
    });
  }

  async function inspectPage() {
    if (settled) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      stopObserver();
      return;
    }
    if (settled) return;

    const notFound = publicationNotFoundReason();
    if (notFound) {
      settled = true;
      sendMessage({
        articleUrl: location.href,
        unsupported: true,
        error: `SAGE 国内站暂未收录该出版物，已按正常情况跳过：${notFound}`,
        source: 'sage_cnpe_publication_not_found'
      });
      stopObserver();
      return;
    }

    const pdfButton = findArticlePdfButton();
    if (pdfButton) {
      clickAfterBackgroundArmed(pdfButton);
      return;
    }

    if (hasRestrictedAccess()) {
      settled = true;
      sendMessage({
        articleUrl: location.href,
        accessDenied: true,
        error: 'SAGE 国内站明确显示 Restricted access / Get access，已按无正文权限跳过。',
        source: 'sage_cnpe_restricted_access'
      });
      stopObserver();
    }
  }

  function start(timeoutMs = 120000) {
    if (location.hostname.toLowerCase() !== 'sage.cnpereading.com') return;
    inspectPage();
    observer = new MutationObserver(() => inspectPage());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciSageCnpePublisher = { start };
})();
