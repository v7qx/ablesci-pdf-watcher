(function () {
  'use strict';

  const scienceDirectCapability = globalThis.AblesciPublisherCapabilities?.forPublisher?.('sciencedirect') || null;

  function safeDecode(s) {
    try { return decodeURIComponent(String(s)); } catch (_) { return String(s || ''); }
  }

  function extractDoi(text) {
    if (!text) return null;
    let s = safeDecode(text);
    const m = s.match(/10\.\d{4,9}\/[^\s"']+/i);
    if (!m) return null;
    let doi = m[0];
    doi = doi.split('#')[0].split('?')[0];
    doi = doi.replace(/\.pdf$/i, '');
    doi = doi.replace(/\/(?:pdf|full|abstract|epdf)$/i, '');
    doi = doi.replace(/getrightsandcontent$/i, '');
    doi = doi.replace(/[)\].,;，。]+$/, '');
    if (doi.includes('...') || doi.includes('…')) return null;
    // Known publisher route segments are not DOI suffixes by themselves. For
    // example, Cochrane article URLs contain /doi/10.1002/central/CN-...;
    // a truncated visible URL must not turn 10.1002/central into a DOI.
    if (/^10\.1002\/central\/?$/i.test(doi)) return null;
    return doi;
  }

  function normalizeUrl(href, base) {
    try { return new URL(href, base || location.href).href; } catch (_) { return null; }
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  function isSupportedPublisherUrl(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch (_) {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    const exactHosts = new Set([
      'www.sciencedirect.com',
      'sciencedirect.com',
      'linkinghub.elsevier.com',
      'pdf.sciencedirectassets.com',
      'pubs.rsc.org',
      'books.rsc.org',
      'xlink.rsc.org',
      'link.springer.com',
      'pubs.acs.org',
      'onlinelibrary.wiley.com',
      'academic.oup.com',
      'pubs.aip.org',
      'aip.scitation.org',
      'scitation.org',
      'ieeexplore.ieee.org',
      'www.nature.com',
      'nature.com',
      'sage.cnpereading.com',
      'iopscience.iop.org'
    ]);
    return exactHosts.has(host) || host.endsWith('.onlinelibrary.wiley.com');
  }

  function trustedDirectPdfHref(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    const h = hostOf(url);
    if (!h || h.includes('ablesci.com') || h === 'doi.org' || h === 'dx.doi.org' || !isSupportedPublisherUrl(url)) return null;
    return url;
  }

  function convertKnownUrlToPdf(url) {
    if (!url) return null;
    const lower = url.toLowerCase();

    const doi = extractDoi(url);
    if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(url) && doi) {
      return `https://doi.org/${doi}`;
    }

    // Do not promote arbitrary assist links to download targets. Publisher
    // navigation is limited to the same domains that the extension currently
    // injects and maintains.
    if (!isSupportedPublisherUrl(url)) return null;

    const scienceDirectUrl = scienceDirectCapability?.inspectUrl?.(url);
    if (['article_page', 'pdf_landing'].includes(scienceDirectUrl?.kind) && scienceDirectUrl.identity) {
      try {
        return scienceDirectUrl.identity.articleUrl.replace('https://www.sciencedirect.com', new URL(url).origin);
      } catch (_) {
        return scienceDirectUrl.identity.articleUrl;
      }
    }

    if (/^https?:\/\/(?:www\.)?frontiersin\.org\/articles\/10\.\d{4,9}\/[^?#]+\/pdf(?:[?#].*)?$/i.test(url)) {
      return url;
    }

    if (/^https?:\/\/iopscience\.iop\.org\/article\/10\.\d{4,9}\/[^?#]+\/pdf(?:[?#].*)?$/i.test(url)) {
      return url;
    }

    if (/^https?:\/\/pubs\.rsc\.org\/[a-z]{2}\/content\/articlepdf\/[^?#]+(?:[?#].*)?$/i.test(url)) {
      return url;
    }

    if (/^https?:\/\/pubs\.rsc\.org\/[a-z]{2}\/content\/articlelanding\/[^?#]+(?:[?#].*)?$/i.test(url)) {
      return url;
    }

    if (/^https?:\/\/(?:www\.)?nature\.com\/articles\/[^/?#]+(?:_reference)?(?:\.pdf)?(?:[?#].*)?$/i.test(url)) {
      return url;
    }

    if (lower.includes('/doi/pdfdirect/') || lower.includes('/doi/pdf/') || lower.includes('/doi/epdf/') || lower.includes('/content/pdf/') || lower.includes('/pdfft') || lower.includes('.pdf')) {
      return url;
    }

    return null;
  }

  function pickPdfUrlFromDocument(doc) {
    doc = doc || document;
    const doi = getFullDoiFromDocument(doc);
    if (doi) {
      return { url: `https://doi.org/${doi}`, source: 'doi-first' };
    }

    for (const a of Array.from(doc.querySelectorAll('a.direct-pdf[href]'))) {
      const href = normalizeUrl(a.getAttribute('href') || a.href, location.href);
      const pdf = convertKnownUrlToPdf(href) || trustedDirectPdfHref(href);
      if (pdf) return { url: pdf, source: 'direct-pdf' };
    }

    const strongSelectors = [
      'a[href*="/doi/pdfdirect/"]',
      'a[href*="/doi/pdf/"]',
      'a[href*="/doi/epdf/"]',
      'a[href*="/content/pdf/"]',
      'a[href*="/pdfft"]',
      'a[href$=".pdf"]',
      'a[href*=".pdf?"]',
      'a[href*=".pdf#"]'
    ];

    for (const sel of strongSelectors) {
      for (const a of Array.from(doc.querySelectorAll(sel))) {
        const href = normalizeUrl(a.getAttribute('href') || a.href, location.href);
        const pdf = convertKnownUrlToPdf(href);
        if (pdf) return { url: pdf, source: sel };
      }
    }

    const assistLinks = Array.from(doc.querySelectorAll('.assist-url a[href], .assist-doi a[href]'));
    for (const a of assistLinks) {
      const href = normalizeUrl(a.getAttribute('href') || a.href, location.href);
      const pdf = convertKnownUrlToPdf(href);
      if (pdf) return { url: pdf, source: 'assist-link-converted' };
    }

    return { url: null, source: 'not-found' };
  }

  function getFullDoiFromDocument(doc) {
    doc = doc || document;
    const sources = [
      '.assist-doi .copy-doi-btn[data-clipboard-text]',
      '.assist-doi a[href*="doi.org/10."]',
      '.assist-doi',
      '.assist-ai-doi .copy-doi-btn[data-clipboard-text]',
      '.assist-ai-doi a[href*="doi.org/10."]',
      '.assist-ai-doi',
      '.assist-url a[href*="doi.org/10."]'
    ];

    for (const sel of sources) {
      const nodes = Array.from(doc.querySelectorAll(sel));
      for (const node of nodes) {
        const raw = node.getAttribute?.('data-clipboard-text') || node.href || node.textContent || '';
        const doi = extractDoi(raw);
        if (doi) return doi;
      }
    }

    // Do not scan the whole page. The article URL can contain DOI-shaped path
    // fragments even when Ablesci explicitly says that no DOI was supplied.
    return null;
  }

  function makePdfFilename(doc) {
    doc = doc || document;
    const doi = getFullDoiFromDocument(doc);
    if (doi) return doi.replace(/[\\/:*?"<>|]+/g, '_') + '.pdf';
    const title = (doc.querySelector('title')?.textContent || 'paper').replace(/^\[ABLESCI\]\s*/i, '');
    return title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) + '.pdf';
  }

  window.AblesciPdfAdapters = {
    extractDoi,
    pickPdfUrlFromDocument,
    getFullDoiFromDocument,
    makePdfFilename,
    convertKnownUrlToPdf,
    isSupportedPublisherUrl
  };
})();
