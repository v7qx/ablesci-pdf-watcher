'use strict';

(function () {
  function isScienceDirectUrl(url) {
    // PRIVATE_WATCHER_ONLY
    const s = String(url || '');
    return /:\/\/(?:www\.)?sciencedirect\.com\//i.test(s) || /:\/\/(?:linkinghub\.)?elsevier\.com\//i.test(s);
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

  function isSpringerUrl(url) {
    return /:\/\/link\.springer\.com\//i.test(String(url || ''));
  }

  function isRscDirectPdfUrl(url) {
    return /:\/\/pubs\.rsc\.org\/.*\/articlepdf\//i.test(String(url || ''));
  }

  function isRscUrl(url) {
    return /:\/\/pubs\.rsc\.org\//i.test(String(url || ''));
  }

  function isAipUrl(url) {
    const s = String(url || '');
    return /:\/\/(?:[^/]+\.)?(?:aip\.org|scitation\.org)\//i.test(s);
  }

  function isWileyUrl(url) {
    return /:\/\/onlinelibrary\.wiley\.com\//i.test(String(url || ''));
  }

  function aipArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    if (/\/article-pdf\//i.test(s)) {
      return s.replace(/\/article-pdf\//i, '/article/');
    }
    if (/\/doi\/(?:pdf|epdf)\//i.test(s)) {
      return s.replace(/\/doi\/(?:pdf|epdf)\//i, '/doi/');
    }
    return '';
  }

  function isIopUrl(url) {
    const s = String(url || '');
    return /:\/\/(?:[^/]+\.)?iop\.org\//i.test(s);
  }

  function iopArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    if (/\/article\/10\.\d{4,9}\/.+\/pdf(?:[?#].*)?$/i.test(s)) {
      return s.replace(/\/pdf(?:[?#].*)?$/i, '');
    }
    return '';
  }

  function isAcsUrl(url) {
    return /:\/\/pubs\.acs\.org\//i.test(String(url || ''));
  }

  function isIeeeUrl(url) {
    return /:\/\/ieeexplore\.ieee\.org\//i.test(String(url || ''));
  }

  function isOxfordUrl(url) {
    return /:\/\/academic\.oup\.com\//i.test(String(url || ''));
  }

  function publisherForUrl(url) {
    if (isScienceDirectUrl(url)) return 'sciencedirect';
    if (isNatureUrl(url)) return 'nature';
    if (isSpringerUrl(url)) return 'springer';
    if (isRscUrl(url)) return 'rsc';
    if (isWileyUrl(url)) return 'wiley';
    if (isAipUrl(url)) return 'aip';
    if (isAcsUrl(url)) return 'acs';
    if (isIeeeUrl(url)) return 'ieee';
    if (isOxfordUrl(url)) return 'oxford';
    if (isIopUrl(url)) return 'iop';
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
    // PRIVATE_WATCHER_ONLY
    const s = String(h || '');
    return /(^|\.)sciencedirect\.com$/i.test(s) || /(^|\.)sciencedirectassets\.com$/i.test(s) || /(^|\.)elsevier\.com$/i.test(s);
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

  function springerArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^https?:\/\/link\.springer\.com\/content\/pdf\/(10\.[^?#]+?)(?:\.pdf)?(?:[?#].*)?$/i);
    return match ? `https://link.springer.com/article/${match[1]}` : '';
  }

  function wileyArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^https?:\/\/onlinelibrary\.wiley\.com\/doi\/(?:pdf|epdf|pdfdirect)\/(10\.[^?#]+)(?:[?#].*)?$/i);
    return match ? `https://onlinelibrary.wiley.com/doi/full/${match[1]}` : '';
  }

  function acsArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^https?:\/\/pubs\.acs\.org\/doi\/(?:pdf|epdf)\/(10\.[^?#]+)(?:[?#].*)?$/i);
    return match ? `https://pubs.acs.org/doi/full/${match[1]}` : '';
  }

  function scienceDirectArticleUrlFromPdfUrl(url) {
    const pii = extractScienceDirectPii(url);
    if (!pii) return '';
    return `https://www.sciencedirect.com/science/article/pii/${pii}`;
  }

  function publisherArticleUrlFromPdfUrl(url) {
    if (isDoiUrl(url)) return url;
    return scienceDirectArticleUrlFromPdfUrl(url) || natureArticleUrlFromPdfUrl(url) || springerArticleUrlFromPdfUrl(url) || rscArticleUrlFromPdfUrl(url) || wileyArticleUrlFromPdfUrl(url) || aipArticleUrlFromPdfUrl(url) || acsArticleUrlFromPdfUrl(url) || iopArticleUrlFromPdfUrl(url) || '';
  }

  function looksLikePdfDownloadUrl(url) {
    const value = String(url || '');
    return /\/(?:pdf|pdfft)(?:[/?#]|$)|\/articlepdf\/|\/article-pdf\/|\/content\/pdf\/|\.pdf(?:[?#]|$)|downloadpdf|viewpdf|stamp\/stamp\.jsp/i.test(value);
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
    if (publisher === 'springer') return isSpringerUrl(url);
    if (publisher === 'rsc') return isRscUrl(url);
    if (publisher === 'wiley') return isWileyUrl(url);
    if (publisher === 'aip') return isAipUrl(url);
    if (publisher === 'acs') return isAcsUrl(url);
    if (publisher === 'ieee') return isIeeeUrl(url);
    if (publisher === 'oxford') return isOxfordUrl(url);
    if (publisher === 'iop') return isIopUrl(url);
    return false;
  }

  globalThis.AblesciBackgroundPublishers = {
    isScienceDirectUrl,
    extractScienceDirectPii,
    isDoiHost,
    isNatureUrl,
    isSpringerUrl,
    isRscDirectPdfUrl,
    isRscUrl,
    isAipUrl,
    isWileyUrl,
    aipArticleUrlFromPdfUrl,
    isIopUrl,
    iopArticleUrlFromPdfUrl,
    isAcsUrl,
    isIeeeUrl,
    isOxfordUrl,
    publisherForUrl,
    isScienceDirectPdfUrl,
    isDoiUrl,
    isScienceDirectRelatedHost,
    isScienceDirectAssetPdfUrl,
    natureArticleUrlFromPdfUrl,
    springerArticleUrlFromPdfUrl,
    rscArticleUrlFromPdfUrl,
    wileyArticleUrlFromPdfUrl,
    acsArticleUrlFromPdfUrl,
    scienceDirectArticleUrlFromPdfUrl,
    publisherArticleUrlFromPdfUrl,
    looksLikePdfDownloadUrl,
    isLikelyTargetDownload,
    isExpectedPublisherPage
  };
}());
