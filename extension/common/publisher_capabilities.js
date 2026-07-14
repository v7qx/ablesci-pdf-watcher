(function (scope) {
  'use strict';

  const SCIENCEDIRECT = 'sciencedirect';
  const URL_KIND = Object.freeze({
    UNKNOWN: 'unknown',
    RELATED_HOST: 'related_host',
    PUBLISHER_PAGE: 'publisher_page',
    ARTICLE_PAGE: 'article_page',
    CHAPTER_PAGE: 'chapter_page',
    PDF_LANDING: 'pdf_landing',
    ASSET_PDF: 'asset_pdf',
    DIRECT_ASSET_PDF: 'direct_asset_pdf'
  });

  function extractScienceDirectPii(value) {
    return extractAllScienceDirectPiis(value)[0] || '';
  }

  function extractAllScienceDirectPiis(value) {
    const text = String(value || '');
    const piis = [];
    for (const match of text.matchAll(/\/pii\/([A-Z0-9]+)/gi)) piis.push(match[1].toUpperCase());
    for (const match of text.matchAll(/1-s2\.0-([A-Z0-9]+)/gi)) piis.push(match[1].toUpperCase());
    let identityText = text;
    try {
      const parsed = new URL(text);
      identityText = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch (_) {}
    for (const match of identityText.matchAll(/\b([SB][A-Z0-9]{16,23})\b/gi)) piis.push(match[1].toUpperCase());
    return Array.from(new Set(piis.filter(Boolean)));
  }

  function extractScienceDirectDoi(value) {
    let text = String(value || '').trim();
    try { text = decodeURIComponent(text); } catch (_) {}
    const match = text.match(/(10\.1016\/[^?#\s"']+)/i);
    return match ? match[1].replace(/[)\].,;，。]+$/, '').toLowerCase() : '';
  }

  function identifyScienceDirectArticle(input = {}) {
    const pii = extractScienceDirectPii(input.url);
    const doi = extractScienceDirectDoi(input.doi || input.url);
    if (pii && !inspectScienceDirectUrl(input.url).related) {
      return { ok: false, reasonCode: 'article_identity_not_found' };
    }
    if (!pii && !doi) return { ok: false, reasonCode: 'article_identity_not_found' };
    return {
      ok: true,
      identity: {
        publisher: SCIENCEDIRECT,
        articleUrl: pii
          ? `https://www.sciencedirect.com/science/article/pii/${pii}`
          : `https://doi.org/${doi}`,
        pii,
        doi
      }
    };
  }

  function sameScienceDirectArticle(expectedPii, actualPii) {
    const expected = String(expectedPii || '').toUpperCase();
    const actual = String(actualPii || '').toUpperCase();
    return !!expected && !!actual && (
      expected === actual || expected.substring(0, 10) === actual.substring(0, 10)
    );
  }

  function createScienceDirectPdfCandidate(input = {}) {
    const identity = input.identity || {};
    const url = String(input.url || '');
    const pii = extractScienceDirectPii(url);
    if (identity.publisher !== SCIENCEDIRECT || !sameScienceDirectArticle(identity.pii, pii)) {
      return { ok: false, reasonCode: 'sciencedirect_pii_mismatch' };
    }
    if (!/\/science\/article\/pii\/[^/?#]+\/(?:pdf|pdfft)(?:[/?#]|$)/i.test(url)) {
      return { ok: false, reasonCode: 'not_main_pdf_candidate' };
    }
    if (/^https?:\/\//i.test(url)) {
      const kind = inspectScienceDirectUrl(url).kind;
      if (!['article_page', 'pdf_landing'].includes(kind)) {
        return { ok: false, reasonCode: 'publisher_url_not_allowed' };
      }
    }
    return {
      ok: true,
      candidate: {
        publisher: SCIENCEDIRECT,
        url,
        source: String(input.source || ''),
        pii
      }
    };
  }

  function getHostname(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    try {
      if (/^blob:/i.test(text)) return new URL(text.slice(5)).hostname.toLowerCase();
      if (/^https?:\/\//i.test(text)) return new URL(text).hostname.toLowerCase();
      return new URL(`https://${text}`).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function isScienceDirectRelatedHost(value) {
    const host = getHostname(value);
    return /(^|\.)sciencedirect\.com$/i.test(host) ||
      /(^|\.)sciencedirectassets\.com$/i.test(host) ||
      /(^|\.)elsevier\.com$/i.test(host);
  }

  function inspectScienceDirectUrl(value) {
    const url = String(value || '');
    const host = getHostname(url);
    const relatedHost = isScienceDirectRelatedHost(host);
    const publisherPage = /(^|\.)sciencedirect\.com$/i.test(host) ||
      /^(?:linkinghub\.)?elsevier\.com$/i.test(host);
    let pathAndSearch = '';
    try {
      const parsed = new URL(url);
      pathAndSearch = `${parsed.pathname}${parsed.search}`;
    } catch (_) {}
    const articleRouteMatch = publisherPage
      ? pathAndSearch.match(/\/science\/(article|chapter)\/(?:abs\/)?pii\/[^/?#]+(?:[/?#]|$)/i)
      : null;
    const articlePage = !!articleRouteMatch;
    const articleKind = articleRouteMatch ? articleRouteMatch[1].toLowerCase() : '';
    const pdfLanding = publisherPage &&
      /\/science\/article\/pii\/[^/?#]+\/(?:pdf|pdfft)(?:[/?#]|$)/i.test(pathAndSearch);
    const assetPdf = /(^|\.)sciencedirectassets\.com$/i.test(host);
    const directAssetPdf = /^pdf\.sciencedirectassets\.com$/i.test(host);
    const piis = extractAllScienceDirectPiis(url);
    const pii = piis[0] || '';
    let kind = URL_KIND.UNKNOWN;
    if (relatedHost) kind = URL_KIND.RELATED_HOST;
    if (publisherPage) kind = URL_KIND.PUBLISHER_PAGE;
    if (articlePage) kind = articleKind === 'chapter' ? URL_KIND.CHAPTER_PAGE : URL_KIND.ARTICLE_PAGE;
    if (pdfLanding) kind = URL_KIND.PDF_LANDING;
    if (assetPdf) kind = URL_KIND.ASSET_PDF;
    if (directAssetPdf) kind = URL_KIND.DIRECT_ASSET_PDF;
    return {
      publisher: SCIENCEDIRECT,
      kind,
      related: relatedHost,
      piis,
      identity: pii ? {
        publisher: SCIENCEDIRECT,
        articleUrl: `https://www.sciencedirect.com/science/article/pii/${pii}`,
        pii,
        doi: ''
      } : null
    };
  }

  function sameScienceDirectDownload(expectedPii, actualPii) {
    const expected = String(expectedPii || '').toUpperCase().replace(/^[SB]/, '');
    const actual = String(actualPii || '').toUpperCase().replace(/^[SB]/, '');
    return !!expected && !!actual && expected.substring(0, 10) === actual.substring(0, 10);
  }

  function decideScienceDirectDownloadOwnership(input = {}) {
    const identity = input.identity || {};
    const item = input.item || {};
    const finalUrl = String(item.finalUrl || item.url || '');
    const sourceUrl = String(input.sourceUrl || '');
    const filename = String(item.filename || '');
    const mime = String(item.mime || '');
    const pdfLike = /\.pdf$/i.test(filename) || /pdf/i.test(mime) ||
      /\/(?:pdf|pdfft)(?:[/?#]|$)|\.pdf(?:[?#]|$)/i.test(finalUrl) ||
      /\/(?:pdf|pdfft)(?:[/?#]|$)|\.pdf(?:[?#]|$)/i.test(sourceUrl);
    const actualPiis = extractAllScienceDirectPiis(finalUrl);
    const finalInspection = inspectScienceDirectUrl(finalUrl);

    if (identity.publisher !== SCIENCEDIRECT || !pdfLike) {
      return { ok: false, reasonCode: 'download_ownership_not_established' };
    }
    const finalIsAsset = finalInspection.kind === URL_KIND.ASSET_PDF ||
      finalInspection.kind === URL_KIND.DIRECT_ASSET_PDF;
    if (identity.pii && finalIsAsset && actualPiis.length === 0) {
      return { ok: false, reasonCode: 'sciencedirect_pii_missing' };
    }
    if (identity.pii && actualPiis.length > 0 &&
        !actualPiis.some(actualPii => sameScienceDirectDownload(identity.pii, actualPii))) {
      return { ok: false, reasonCode: 'sciencedirect_pii_mismatch' };
    }
    if (!identity.pii && identity.doi) {
      return { ok: false, reasonCode: 'article_identity_evidence_missing' };
    }
    if (finalInspection.related) {
      return { ok: true, reasonCode: 'sciencedirect_related_pdf' };
    }
    return { ok: false, reasonCode: 'download_ownership_not_established' };
  }

  const capabilities = new Map([
    [SCIENCEDIRECT, Object.freeze({
      inspectUrl: inspectScienceDirectUrl,
      identifyArticle: identifyScienceDirectArticle,
      createPdfCandidate: createScienceDirectPdfCandidate,
      decideDownloadOwnership: decideScienceDirectDownloadOwnership
    })]
  ]);

  function forPublisher(publisher) {
    return capabilities.get(String(publisher || '').trim().toLowerCase()) || null;
  }

  scope.AblesciPublisherCapabilities = Object.freeze({ forPublisher });
}(globalThis));
