(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;
  let skipBookChapter = true;

  chrome.storage.local.get({ watcherSkipBookChapter: true }, function (res) {
    if (res && res.watcherSkipBookChapter !== undefined) {
      skipBookChapter = !!res.watcherSkipBookChapter;
    }
  });

  function rscArticleLandingUrlFromPdfUrl(url) {
    try {
      const u = new URL(url, location.href);
      u.pathname = u.pathname.replace(/\/content\/articlepdf\//i, '/content/articlelanding/');
      return /\/content\/articlelanding\//i.test(u.pathname) ? u.href : location.href;
    } catch (_) {
      return location.href;
    }
  }

  function findRscArticlePdfLink() {
    const links = Array.from(document.querySelectorAll([
      'a[data-doctype="contentPdf"][href]',
      'a.article-pdfLink[href]',
      'a[href*="/article-pdf/"]',
      'a[href*="/content/articlepdf/"]',
      'a[type="application/pdf"]'
    ].join(', ')))
      .map(a => {
        const href = common.normalizeUrl(common.decodeHtmlUrl(a.getAttribute('href') || a.href), location.href);
        const text = (a.innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
        const dataDocType = a.getAttribute('data-doctype') || '';
        const marker = [
          dataDocType,
          a.className || '',
          a.id || '',
          a.getAttribute('type') || '',
          a.getAttribute('target') || ''
        ].join(' ');
        const isPurchaseLink = /\/content\/buyarticlepdf\//i.test(href || '');
        const articlePdf = !isPurchaseLink && (
          /^contentPdf$/i.test(dataDocType) ||
          /\barticle-pdfLink\b/i.test(a.className || '') ||
          /\bstats-item-pdf-download\b/i.test(a.className || '') ||
          /\/article-pdf\//i.test(href || '') ||
          /\/content\/articlepdf\//i.test(href || '') ||
          /Download this article|PDF format|PDF/i.test(`${text} ${marker}`)
        );
        const supplementary = /dataSupplementDoc/i.test(dataDocType) ||
          !!a.closest('.dataSuppLink, [id="supplementary-data"], .supplementary-data-section') ||
          /\/article-supplement\/|_suppl(?:[/.?#]|$)|supplementary information|supporting information|permissions|copyright|reprint/i.test(`${href || ''} ${text} ${marker}`);
        return { a, href, text, articlePdf, supplementary };
      })
      .filter(item => item.href && item.articlePdf && !item.supplementary);

    links.sort((left, right) => {
      const leftStrong = /Download this article|PDF format/i.test(left.text) ? 1 : 0;
      const rightStrong = /Download this article|PDF format/i.test(right.text) ? 1 : 0;
      return rightStrong - leftStrong;
    });

    const found = links[0];
    if (found) return { link: found.a, href: found.href, source: 'article_pdf_link' };

    const metaSelectors = [
      'meta[name="citation_pdf_url"]',
      'meta[property="citation_pdf_url"]'
    ];
    for (const sel of metaSelectors) {
      const value = document.querySelector(sel)?.getAttribute('content') || '';
      if (/\/(?:content\/articlepdf|article-pdf)\//i.test(value) &&
          !/\/article-supplement\/|_suppl(?:[/.?#]|$)/i.test(value)) {
        const href = common.normalizeUrl(value, location.href);
        if (href) return { href, source: 'citation_pdf_url' };
      }
    }
    return null;
  }

  function sendRscMessage(payload) {
    common.sendPublisherMessage('rsc', payload);
  }

  function hasRscAccessDeniedPage() {
    return !!document.querySelector('.paywall__body, .paywall__container, .paywall__title, a[href*="/buyarticlepdf/"], .btn-icon--trolley');
  }

  function hasRscNotFoundErrorPage() {
    const title = String(document.title || '').replace(/\s+/g, ' ').trim();
    const bodyClass = String(document.body?.className || '');
    if (/^Not Found\s*\|\s*The Royal Society of Chemistry$/i.test(title)) return true;
    if (/\bpg_?error404\b/i.test(bodyClass)) return true;
    const errorWrap = document.querySelector('.custom-error-wrap');
    if (!errorWrap) return false;
    const text = String(errorWrap.innerText || errorWrap.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
    return /page you.?re looking for cannot be found|please check the address|return home/i.test(text);
  }

  function isRscBookChapter() {
    const host = location.hostname || '';
    const path = location.pathname || '';
    return /(^|\.)books\.rsc\.org$/i.test(host) || /\/books\//i.test(path) || /\/chapter\//i.test(path) || /\/chapter-abstract\//i.test(path);
  }

  function isRscBookOverview() {
    const path = location.pathname || '';
    return /\/books\//i.test(path) && !/\/chapter\//i.test(path) && !/\/chapter-abstract\//i.test(path);
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
    if (!common.isRsc() || pdfTriggered) return;
    if (!(await common.canControlCurrentPublisherPage())) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending RSC task');
      stopObserver();
      return;
    }
    if (isRscBookOverview()) {
      pdfTriggered = true;
      sendRscMessage({
        articleUrl: location.href,
        unsupported: true,
        error: 'RSC 书籍或章节暂不支持自动应助（跳转到了书籍总览页）。',
        source: 'rsc_book_overview'
      });
      stopObserver();
      return;
    }
    if (isRscBookChapter() && skipBookChapter) {
      pdfTriggered = true;
      sendRscMessage({
        articleUrl: location.href,
        unsupported: true,
        error: 'RSC 识别为书籍章节，已按设置自动跳过。',
        source: 'rsc_book_chapter'
      });
      stopObserver();
      return;
    }
    if (common.hasPublisherChallengePage()) {
      if (!challengePrompted) {
        challengePrompted = true;
        sendRscMessage({
          articleUrl: location.href,
          publisherChallenge: true,
          source: 'rsc_challenge_page'
        });
      }
      return;
    }
    if (hasRscNotFoundErrorPage()) {
      pdfTriggered = true;
      sendRscMessage({
        articleUrl: location.href,
        unsupported: true,
        error: 'RSC 返回 Not Found 错误页，当前 DOI/文章页无法解析，已按正常情况跳过。',
        source: 'rsc_not_found_error_page'
      });
      stopObserver();
      return;
    }
    const accessDenied = hasRscAccessDeniedPage();
    const found = findRscArticlePdfLink();
    if (found && !(accessDenied && found.source === 'citation_pdf_url')) {
      pdfTriggered = true;
      sendRscMessage({
        articleUrl: rscArticleLandingUrlFromPdfUrl(found.href),
        pdfUrl: found.href,
        source: found.source
      });
      stopObserver();
      return;
    }
    if (accessDenied) {
      pdfTriggered = true;
      sendRscMessage({
        articleUrl: location.href,
        accessDenied: true,
        error: 'RSC 明确返回无正文订阅权限（Paywall）。',
        source: 'rsc_paywall_page'
      });
      stopObserver();
      return;
    }
  }

  function waitForPdf(timeoutMs = 30000) {
    if (!common.isRsc()) return;
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
    if (!common.isRsc()) return;
    waitForPdf(timeoutMs);
    observer = new MutationObserver(() => notifyReady());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    stopTimer = setTimeout(stopObserver, timeoutMs);
  }

  window.AblesciRscPublisher = { start };
})();
