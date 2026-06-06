(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  const supported = new Set(['springer', 'oxford', 'wiley', 'acs', 'ieee']);
  let pdfTriggered = false;
  let observer = null;
  let stopTimer = null;
  let challengePrompted = false;
  let lastNoCandidateDiagnosticAt = 0;
  let wileyButtonClicked = false;
  let wileyFetchTested = false;

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
    return /supplementary|supplemental|supporting information|appendix|permissions|copyright|reprint|correction|erratum|figure|slide|image|video|dataset/i.test(marker);
  }

  function springerContentType() {
    const path = location.pathname || '';
    const pathMatch = path.match(/^\/([^/?#]+)\//);
    if (pathMatch) return pathMatch[1].toLowerCase();
    const canonical = document.querySelector('link[rel="canonical"][href]')?.href || '';
    const canonicalPath = (() => {
      try { return new URL(canonical).pathname || ''; } catch (_) { return canonical; }
    })();
    const canonicalMatch = canonicalPath.match(/^\/([^/?#]+)\//);
    if (canonicalMatch) return canonicalMatch[1].toLowerCase();
    return '';
  }

  function rejectUnsupportedSpringerPage() {
    if (common.currentPublisher() !== 'springer') return false;
    const type = springerContentType();
    if (!type || type === 'article') return false;
    pdfTriggered = true;
    common.sendPublisherMessage('springer', {
      articleUrl: location.href,
      unsupported: true,
      error: `Springer ${type} 页面暂不支持；当前规则只处理 /article/ 期刊文献。`,
      source: `springer_${type}_page`
    });
    stopObserver();
    return true;
  }

  function extractWileyPdfDirectUrl(value) {
    const match = String(value || '').match(/(\/doi\/pdfdirect\/10\.\d{4,9}\/[^"'\s]+)/i);
    return match ? normalize(match[1]) : null;
  }

  function findWileyPdfViewerDirectUrl() {
    if (common.currentPublisher() !== 'wiley') return null;
    if (!/\/doi\/(?:pdf|epdf)\//i.test(location.pathname || '')) return null;
    const iframeSrc = document.querySelector('iframe#pdf-iframe[src], iframe[src*="/doi/pdfdirect/"]')?.getAttribute('src') || '';
    const iframePdfDirectUrl = extractWileyPdfDirectUrl(iframeSrc);
    if (iframePdfDirectUrl) return iframePdfDirectUrl;

    const scripts = Array.from(document.scripts).map(script => script.textContent || '').join('\n');
    return extractWileyPdfDirectUrl(scripts);
  }

  function hasWileyAccessDeniedPage() {
    if (common.currentPublisher() !== 'wiley') return false;
    const hashHit = location.hash.toLowerCase() === '#accessdeniallayout';
    const semanticHit = !!document.querySelector(
      '[data-pgc="wolAccessDenied"], [data-pg-name="access-denied"], #access-denied, .paywall-login, .access-panel, #ad--purchase-options'
    );
    if (hashHit || semanticHit) return true;

    const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const textHit = /Get access to the full version of this (article|chapter)/i.test(text) &&
                    /View access options below/i.test(text);
    const optionsHit = /Institutional Login/i.test(text) ||
                       /Log in to Wiley Online Library/i.test(text) ||
                       /Purchase Instant Access/i.test(text) ||
                       /48-Hour online access/i.test(text);
    if (textHit && optionsHit) return true;

    const hasFullAccess = /Full Access|Open Access|Free Access/i.test(text);
    const hasAccessOptions = /Institutional Login|Log in to Wiley Online Library|Purchase Instant Access/i.test(text);
    if (hasAccessOptions && !hasFullAccess) {
      const hasIframe = !!document.querySelector('iframe#pdf-iframe[src], iframe[src*="/doi/pdfdirect/"]');
      if (!hasIframe) return true;
    }

    return false;
  }

  function ieeeArticleNumberFromUrl(url) {
    try {
      const u = new URL(String(url || ''), location.href);
      const documentMatch = (u.pathname || '').match(/^\/document\/(\d+)\/?$/i);
      if (documentMatch) return documentMatch[1];
      if (/^\/stamp\/stamp\.jsp$/i.test(u.pathname || '')) {
        const arnumber = u.searchParams.get('arnumber');
        return arnumber && /^\d+$/.test(arnumber) ? arnumber : '';
      }
    } catch (_) {}
    return '';
  }

  function encodeIeeeRef(articleUrl) {
    try {
      return btoa(String(articleUrl || ''));
    } catch (_) {
      return '';
    }
  }

  function ieeeGetPdfUrlFromArticleNumber(arnumber, articleUrl) {
    if (!arnumber || !/^\d+$/.test(arnumber)) return null;
    const ref = encodeIeeeRef(articleUrl || `https://ieeexplore.ieee.org/document/${arnumber}`);
    const suffix = ref ? `&ref=${encodeURIComponent(ref)}` : '';
    return `https://ieeexplore.ieee.org/stampPDF/getPDF.jsp?tp=&arnumber=${encodeURIComponent(arnumber)}${suffix}`;
  }

  function findIeeePdfDownloadUrl() {
    if (common.currentPublisher() !== 'ieee') return null;
    if (/^\/stamp\/stamp\.jsp$/i.test(location.pathname || '')) {
      const iframeSrc = document.querySelector('iframe[src*="/stampPDF/getPDF.jsp"]')?.getAttribute('src') || '';
      if (iframeSrc) return normalize(iframeSrc);
      return ieeeGetPdfUrlFromArticleNumber(ieeeArticleNumberFromUrl(location.href), document.referrer || '');
    }
    if (!/^\/document\/\d+\/?$/i.test(location.pathname || '')) return null;
    const articleUrl = `https://ieeexplore.ieee.org/document/${ieeeArticleNumberFromUrl(location.href)}`;
    const getPdfUrl = ieeeGetPdfUrlFromArticleNumber(ieeeArticleNumberFromUrl(location.href), articleUrl);
    if (getPdfUrl) return getPdfUrl;
    const scripts = Array.from(document.scripts)
      .map(script => script.textContent || '')
      .filter(Boolean)
      .join('\n');
    const pathMatch = scripts.match(/"pdfPath"\s*:\s*"([^"]+?\.pdf)"/i) ||
      scripts.match(/'pdfPath'\s*:\s*'([^']+?\.pdf)'/i);
    if (!pathMatch) return null;
    const pdfUrl = normalize(pathMatch[1]);
    if (!pdfUrl || !/\/iel\d*\/.+\.pdf(?:[?#].*)?$/i.test(pdfUrl)) return null;
    const arnumber = ieeeArticleNumberFromUrl(location.href);
    return ieeeGetPdfUrlFromArticleNumber(arnumber, articleUrl) || pdfUrl;
  }

  function isPdfHref(href) {
    return /\.pdf(?:[?#]|$)|\/content\/pdf\/|\/doi\/pdfdirect\/|\/doi\/pdf\/|\/doi\/epdf\/|\/article-pdf\/|\/articlepdf\/|\/stampPDF\/getPDF\.jsp|\/stamp\/stamp\.jsp/i.test(href || '');
  }

  function directPdfSelectors() {
    return [
      'meta[name="citation_pdf_url"]',
      'meta[property="citation_pdf_url"]',
      'a.article-pdfLink[href]',
      'a[href*="/content/pdf/"]',
      'a[href*="/doi/pdfdirect/"]',
      'a[href*="/doi/pdf/"]',
      'a[href*="/doi/epdf/"]',
      'a[href*="/article-pdf/"]',
      'a[href*="/articlepdf/"]',
      'a[href*="/stampPDF/getPDF.jsp"]',
      'a[href*="/stamp/stamp.jsp"]',
      'a[href$=".pdf"]',
      'a[href*=".pdf?"]'
    ];
  }

  function findPdfLink() {
    const publisher = common.currentPublisher();
    const allCandidates = Array.from(document.querySelectorAll(directPdfSelectors().join(',')))
      .map(el => {
        const raw = el.getAttribute('content') || el.getAttribute('href') || el.href || '';
        const href = normalize(raw);
        const marker = markerOf(el, href);
        const visible = el.tagName === 'META' || common.isVisible(el);
        const textScore = /\b(pdf|download pdf|full text pdf)\b/i.test(marker) ? 2 : 0;
        const hrefScore = isPdfHref(href) ? 3 : 0;
        const publisherScore = publisher === 'wiley'
          ? (/\/doi\/pdfdirect\//i.test(href || '') ? 6 : (/\/doi\/pdf\//i.test(href || '') ? 4 : 0))
          : 0;
        const supplementary = isSupplementary(marker);
        return { el, href, marker, visible, score: hrefScore + textScore + publisherScore, supplementary };
      });
    const candidates = allCandidates
      .filter(item => item.href && item.visible && item.score > 0 && !item.supplementary);
    candidates.sort((left, right) => right.score - left.score);
    const selected = candidates[0] || null;
    const sample = allCandidates.slice(0, 6).map(item => ({
      href: item.href,
      tag: item.el.tagName,
      visible: item.visible,
      score: item.score,
      supplementary: item.supplementary,
      text: (item.el.innerText || item.el.textContent || item.el.getAttribute('aria-label') || item.el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    }));
    return {
      selected,
      diagnostics: {
        selectorCount: allCandidates.length,
        eligibleCount: candidates.length,
        rejectedSupplementaryCount: allCandidates.filter(item => item.supplementary).length,
        sample
      }
    };
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
    if (rejectUnsupportedSpringerPage()) return;
    if (publisher === 'wiley' && hasWileyAccessDeniedPage()) {
      pdfTriggered = true;
      common.sendPublisherMessage('wiley', {
        articleUrl: location.href,
        accessDenied: true,
        error: 'Wiley 页面明确显示无正文访问权限，已停止本次下载。',
        source: 'wiley_access_denied_page'
      });
      stopObserver();
      return;
    }
    // 针对 wiley 的 fetch 探测逻辑：
    // 不管是摘要页还是阅读器页，直接通过 fetch 请求 pdfdirect 链接，在 0.5s 内精准测出有无权限，彻底规避前台阅读器黑盒和延时挂起
    if (publisher === 'wiley' && !wileyFetchTested) {
      const match = String(location.href).match(/\/doi\/(?:pdf|epdf|full|abs|pdfdirect)\/(10\.[^?#]+)/i);
      const doi = match ? decodeURIComponent(match[1]) : null;
      if (doi) {
        wileyFetchTested = true;
        const pdfdirectUrl = encodeURI(`/doi/pdfdirect/${doi}`);
        console.debug('[Ablesci PDF Watcher] Wiley page: testing pdfdirect access via fetch...', pdfdirectUrl);
        fetch(pdfdirectUrl, { redirect: 'manual' })
          .then(async response => {
            const contentType = response.headers.get('content-type') || '';
            const status = response.status;
            const isOpaque = response.type === 'opaqueredirect' || status === 0;
            const isRedirect = status >= 300 && status < 400;
            const isErrorStatus = status === 403 || status === 401;
            const isHtml = contentType.includes('text/html');

            if (isOpaque || isRedirect || isErrorStatus || isHtml) {
              console.debug('[Ablesci PDF Watcher] Wiley fetch test failed (paywall/redirect detected):', status, response.type, contentType);
              pdfTriggered = true;
              common.sendPublisherMessage('wiley', {
                articleUrl: location.href,
                accessDenied: true,
                error: `Wiley 页面探测无正文 PDF 访问权限（fetch 测试返回 ${status || 'redirect'}），已停止本次下载。`,
                source: 'wiley_pdfdirect_fetch_test'
              });
              stopObserver();
            } else if (response.ok && !isHtml) {
              console.debug('[Ablesci PDF Watcher] Wiley fetch test succeeded (accessible PDF found):', pdfdirectUrl);
              pdfTriggered = true;
              common.sendPublisherMessage('wiley', {
                articleUrl: location.href,
                pdfUrl: normalize(pdfdirectUrl),
                source: 'wiley_pdfdirect_fetch_succeeded'
              });
              stopObserver();
            }
          })
          .catch(err => {
            console.error('[Ablesci PDF Watcher] Wiley fetch test error, treating as access denied to prevent hang:', err);
            pdfTriggered = true;
            common.sendPublisherMessage('wiley', {
              articleUrl: location.href,
              accessDenied: true,
              error: 'Wiley 页面探测异常（fetch 错误），已作为无权限安全处理。',
              source: 'wiley_pdfdirect_fetch_error'
            });
            stopObserver();
          });
      }
    }
    // 针对 wiley 的模拟点击逻辑：
    // 在普通的 Wiley 文献主页上，如果没有检测到无权限页面，我们寻找 PDF 按钮并模拟点击一次
    // 这能触发无权限提示/跳转，或在有权限时跳转到阅读器页，消除无权限检测挂起
    if (publisher === 'wiley' && !wileyButtonClicked) {
      const isWileyPdfReaderPage = /\/doi\/(?:pdf|epdf)\//i.test(location.pathname || '');
      if (!isWileyPdfReaderPage) {
        const result = findPdfLink();
        const found = result.selected;
        if (found && found.el && found.el.tagName !== 'META') {
          wileyButtonClicked = true;
          console.debug('[Ablesci PDF Watcher] Wiley normal page: auto-clicking PDF button to trigger check');
          common.sendPublisherMessage('wiley', {
            articleUrl: location.href,
            pdfUrl: found.href,
            source: 'wiley_article_pdf_link_click_trigger',
            diagnostics: result.diagnostics
          });
          found.el.click();
          return;
        }
      }
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
    const isWileyPdfReaderPage = publisher === 'wiley' && /\/doi\/(?:pdf|epdf)\//i.test(location.pathname || '');
    const wileyPdfDirectUrl = findWileyPdfViewerDirectUrl();
    if (wileyPdfDirectUrl) {
      pdfTriggered = true;
      common.sendPublisherMessage(publisher, {
        articleUrl: location.href,
        pdfUrl: wileyPdfDirectUrl,
        source: 'wiley_pdf_viewer_pdfdirect',
        diagnostics: {
          pagePath: location.pathname,
          source: document.querySelector('iframe#pdf-iframe[src], iframe[src*="/doi/pdfdirect/"]') ? 'iframe' : 'script'
        }
      });
      stopObserver();
      return;
    } else if (isWileyPdfReaderPage) {
      return;
    }
    const ieeePdfDownloadUrl = findIeeePdfDownloadUrl();
    if (ieeePdfDownloadUrl) {
      pdfTriggered = true;
      common.sendPublisherMessage(publisher, {
        articleUrl: location.href,
        pdfUrl: ieeePdfDownloadUrl,
        source: 'ieee_stamp_pdf_getpdf',
        diagnostics: {
          pagePath: location.pathname,
          endpoint: 'stampPDF/getPDF.jsp'
        }
      });
      stopObserver();
      return;
    }
    const result = findPdfLink();
    const found = result.selected;
    if (!found) {
      const now = Date.now();
      if (now - lastNoCandidateDiagnosticAt > 5000) {
        lastNoCandidateDiagnosticAt = now;
        common.sendPublisherMessage(publisher, {
          articleUrl: location.href,
          publisherDiagnostic: true,
          source: `${publisher}_pdf_candidate_scan`,
          diagnostics: result.diagnostics
        });
      }
      return;
    }
    pdfTriggered = true;
    common.sendPublisherMessage(publisher, {
      articleUrl: location.href,
      pdfUrl: found.href,
      source: `${publisher}_article_pdf_link`,
      diagnostics: result.diagnostics
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
