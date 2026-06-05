(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;

  function currentDoiFromUrl() {
    try {
      const match = location.pathname.match(/\/doi\/(10\.[^?#]+)/i);
      return match ? decodeURIComponent(match[1]).replace(/\/+$/g, '') : '';
    } catch (_) {
      return '';
    }
  }

  function findCnpeArticleId() {
    const html = document.documentElement?.innerHTML || '';
    const ids = [];
    const re = /\\?"articleId\\?"\s*:\s*\\?"([A-F0-9]{20,})\\?"/gi;
    let match;
    while ((match = re.exec(html))) {
      ids.push({ id: match[1], index: match.index });
    }
    if (!ids.length) return '';

    const doi = currentDoiFromUrl();
    if (!doi) return ids[0].id;

    const markers = [
      doi,
      doi.replace(/\//g, '_'),
      encodeURIComponent(doi),
      doi.replace(/\//g, '\\/')
    ].map(value => String(value || '').toLowerCase());
    const htmlLower = html.toLowerCase();
    const markerIndexes = markers
      .map(marker => marker ? htmlLower.indexOf(marker.toLowerCase()) : -1)
      .filter(index => index >= 0);
    if (!markerIndexes.length) return ids[0].id;

    const targetIndex = markerIndexes[0];
    let best = ids[0];
    let bestDistance = Math.abs(ids[0].index - targetIndex);
    for (const item of ids) {
      const distance = Math.abs(item.index - targetIndex);
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    return best.id;
  }

  function cnpeDownloadUrlFromArticleId(articleId) {
    if (!articleId) return '';
    return new URL(`/website/journal/download?articleId=${encodeURIComponent(articleId)}`, location.origin).href;
  }

  function findCnpePdfLink() {
    // 1. 寻找 a 标签
    const links = Array.from(document.querySelectorAll('a'));
    for (const el of links) {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || !common.isVisible(el)) {
        continue;
      }
      const href = el.getAttribute('href') || '';
      const text = (el.innerText || el.textContent || '').trim();
      if (
        /\/pdf\//i.test(href) || 
        /\/download\//i.test(href) || 
        /Download PDF|下载PDF|阅读PDF/i.test(text)
      ) {
        try {
          return { link: el, href: new URL(href, location.href).href, isButton: false };
        } catch (_) {}
      }
    }

    // 2. 寻找 button 标签 (如 data-id="article-toolbar-pdf" 或 aria-label="PDF")
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const el of buttons) {
      if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') {
        continue;
      }
      const text = (el.innerText || el.textContent || '').trim();
      const ariaLabel = el.getAttribute('aria-label') || '';
      const dataId = el.getAttribute('data-id') || '';
      const className = String(el.className || '');
      if (
        /^PDF$/i.test(text) ||
        /Download/i.test(text) ||
        /PDF/i.test(ariaLabel) ||
        /pdf/i.test(dataId) ||
        /article-toolbar-pdf|download-1-icon/i.test(className)
      ) {
        return { link: el, href: '', isButton: true };
      }
    }

    return null;
  }

  function hasCnpeNoSubscriptionAccess() {
    // 如果没有找到可用的下载链接，检测是否出现未授权/购买/登录限制
    // 拷贝 body，但移除 header 和 nav 节点，避免公共导航头部的 Sign In 等词干扰
    const clone = document.body.cloneNode(true);
    const elementsToRemove = clone.querySelectorAll('header, nav, .header, .nav, #header, #nav');
    elementsToRemove.forEach(el => el.remove());
    
    const pageText = clone.innerText || clone.textContent || '';
    const hasPaywallText = [
      'Access through your institution',
      'Institution Login',
      'Sign In',
      '购买此文献',
      '未授权',
      '在线试读',
      '订阅本期刊',
      '订阅',
      'Purchase',
      'Subscribe'
    ].some(text => pageText.includes(text));

    return hasPaywallText;
  }

  function sendCnpeMessage(payload) {
    common.sendPublisherMessage('cnpe', payload);
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
    if (pdfTriggered) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending SAGE task');
      stopObserver();
      return;
    }

    // 1. 优先从 Next.js 页面数据提取当前文章 articleId，构造真实 PDF 下载入口。
    const articleId = findCnpeArticleId();
    const downloadUrl = cnpeDownloadUrlFromArticleId(articleId);
    if (downloadUrl) {
      pdfTriggered = true;
      sendCnpeMessage({
        pdfUrl: downloadUrl,
        articleUrl: location.href,
        source: 'cnpe_article_id_download',
        diagnostics: {
          articleId,
          doi: currentDoiFromUrl()
        }
      });
      stopObserver();
      return;
    }

    // 2. 找不到 articleId 时，再回退到点击 PDF 按钮或链接。
    const found = findCnpePdfLink();
    if (found) {
      pdfTriggered = true;
      sendCnpeMessage({
        pdfUrl: found.href || (location.href + '#pdf_clicked'),
        clicked: true,
        source: found.isButton ? 'cnpe_pdf_button_click' : 'cnpe_pdf_download_link'
      });
      setTimeout(() => found.link.click(), 0);
      stopObserver();
      return;
    }

    // 3. 只有在找不到 PDF 按钮的情况下，才去判断是否确实没有权限
    if (hasCnpeNoSubscriptionAccess()) {
      sendCnpeMessage({
        articleUrl: location.href,
        noSubscription: true,
        error: '易阅通 SAGE 平台返回无订阅权限。'
      });
      stopObserver();
      return;
    }
  }

  function start(timeoutMs = 30000) {
    notifyReady();
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciCnpePublisher = { start };
})();
