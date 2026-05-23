'use strict';

(function () {
  function isScienceDirectUrl(url) {
    return /:\/\/(?:www\.)?sciencedirect\.com\//i.test(String(url || ''));
  }

  function extractScienceDirectPii(url) {
    const match = String(url || '').match(/\/pii\/([A-Z0-9]+)/i);
    return match ? match[1] : '';
  }

  function isDoiHost(host) {
    return /(^|\.)doi\.org$/i.test(String(host || '')) || /(^|\.)dx\.doi\.org$/i.test(String(host || ''));
  }

  function isNatureUrl(url) {
    return /:\/\/(?:www\.)?nature\.com\//i.test(String(url || ''));
  }

  function isRscDirectPdfUrl(url) {
    return /:\/\/pubs\.rsc\.org\/.*\/articlepdf\//i.test(String(url || ''));
  }

  function isRscUrl(url) {
    return /:\/\/pubs\.rsc\.org\//i.test(String(url || ''));
  }

  function isSageUrl(url) {
    return /:\/\/(?:journals\.sagepub\.com|sage\.cnpereading\.com)\//i.test(String(url || ''));
  }

  function publisherForUrl(url) {
    if (isScienceDirectUrl(url)) return 'sciencedirect';
    if (isNatureUrl(url)) return 'nature';
    if (isRscUrl(url)) return 'rsc';
    if (isSageUrl(url)) return 'sage';
    return '';
  }

  function isScienceDirectPdfUrl(url) {
    return /:\/\/pdf\.sciencedirectassets\.com\//i.test(String(url || ''));
  }

  function isDoiUrl(url) {
    try {
      return isDoiHost(new URL(String(url || '')).hostname);
    } catch (_) {
      return false;
    }
  }

  function isScienceDirectRelatedHost(h) {
    return /(^|\.)sciencedirect\.com$/i.test(String(h || '')) || /(^|\.)sciencedirectassets\.com$/i.test(String(h || ''));
  }

  function isScienceDirectAssetPdfUrl(url) {
    try {
      return /(^|\.)sciencedirectassets\.com$/i.test(new URL(String(url || '')).hostname);
    } catch (_) {
      return false;
    }
  }

  function natureArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/(https?:\/\/(?:www\.)?nature\.com\/articles\/[^/?#]+)/i);
    return match ? match[1] : '';
  }

  function rscArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/(https?:\/\/pubs\.rsc\.org\/en\/content\/article(html)?\/[^?#]+)/i);
    return match ? match[1] : '';
  }

  function scienceDirectArticleUrlFromPdfUrl(url) {
    const pii = extractScienceDirectPii(url);
    if (!pii) return '';
    return `https://www.sciencedirect.com/science/article/pii/${pii}`;
  }

  function sageArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const doiMatch = s.match(/10\.\d{4,9}\/[\S"'<>]+/i);
    if (!doiMatch) return '';
    let doi = doiMatch[0].split('#')[0].split('?')[0];
    doi = doi.replace(/\/(?:pdf|epdf|full)$/i, '');
    doi = doi.replace(/\.pdf$/i, '');
    return `https://doi.org/${doi}`;
  }

  function publisherArticleUrlFromPdfUrl(url) {
    return scienceDirectArticleUrlFromPdfUrl(url) || natureArticleUrlFromPdfUrl(url) || rscArticleUrlFromPdfUrl(url) || sageArticleUrlFromPdfUrl(url) || '';
  }

  function looksLikePdfDownloadUrl(url) {
    const value = String(url || '');
    return /\/(?:pdf|pdfft)(?:[/?#]|$)|\/articlepdf\/|\.pdf(?:[?#]|$)|downloadpdf|viewpdf/i.test(value);
  }

  function isLikelyTargetDownload(item, expectedHost, sourceUrl) {
    const url = String(item?.finalUrl || item?.url || '');
    const filename = String(item?.filename || '');
    const mime = String(item?.mime || '');
    const sourcePii = extractScienceDirectPii(sourceUrl);
    const actualPii = extractScienceDirectPii(url);
    const sourceHost = (() => {
      try { return new URL(String(sourceUrl || '')).hostname; } catch (_) { return ''; }
    })();
    const finalHost = (() => {
      try { return new URL(url).hostname; } catch (_) { return ''; }
    })();
    const expected = String(expectedHost || '').toLowerCase();
    const pdfLike = /\.pdf$/i.test(filename) || /pdf/i.test(mime) || looksLikePdfDownloadUrl(url) || looksLikePdfDownloadUrl(sourceUrl);
    if (!pdfLike) return false;
    if (sourcePii && actualPii && sourcePii !== actualPii) return false;
    if (expected && finalHost.toLowerCase() === expected) return true;
    if (expected && /sciencedirect/i.test(expected) && isScienceDirectRelatedHost(finalHost)) return true;
    if (sourceHost && finalHost && sourceHost.toLowerCase() === finalHost.toLowerCase()) return true;
    return false;
  }

  function isExpectedPublisherPage(pending, pageUrl) {
    const publisher = String(pending?.publisher || '').toLowerCase();
    const url = String(pageUrl || '');
    if (!publisher || !url) return false;
    if (publisher === 'sciencedirect') return isScienceDirectUrl(url) || isScienceDirectAssetPdfUrl(url);
    if (publisher === 'nature') return isNatureUrl(url);
    if (publisher === 'rsc') return isRscUrl(url);
    if (publisher === 'sage') return isSageUrl(url);
    return false;
  }

  globalThis.AblesciBackgroundPublishers = {
    isScienceDirectUrl,
    extractScienceDirectPii,
    isDoiHost,
    isNatureUrl,
    isRscDirectPdfUrl,
    isRscUrl,
    isSageUrl,
    publisherForUrl,
    isScienceDirectPdfUrl,
    isDoiUrl,
    isScienceDirectRelatedHost,
    isScienceDirectAssetPdfUrl,
    natureArticleUrlFromPdfUrl,
    rscArticleUrlFromPdfUrl,
    scienceDirectArticleUrlFromPdfUrl,
    sageArticleUrlFromPdfUrl,
    publisherArticleUrlFromPdfUrl,
    looksLikePdfDownloadUrl,
    isLikelyTargetDownload,
    isExpectedPublisherPage
  };
}());
