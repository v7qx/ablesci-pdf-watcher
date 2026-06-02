(function () {
  'use strict';

  function safeDecode(s) {
    try { return decodeURIComponent(String(s)); } catch (_) { return String(s || ''); }
  }

  function extractDoi(text) {
    if (!text) return null;
    let s = safeDecode(text);
    const m = s.match(/10\.\d{4,9}\/[\S"'<>]+/i);
    if (!m) return null;
    let doi = m[0];
    doi = doi.split('#')[0].split('?')[0];
    doi = doi.replace(/\.pdf$/i, '');
    doi = doi.replace(/\/(?:pdf|full|abstract|epdf)$/i, '');
    doi = doi.replace(/getrightsandcontent$/i, '');
    doi = doi.replace(/[)\].,;，。]+$/, '');
    if (doi.includes('...') || doi.includes('…')) return null;
    return doi;
  }

  function normalizeUrl(href, base) {
    try { return new URL(href, base || location.href).href; } catch (_) { return null; }
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  function trustedDirectPdfHref(url) {
    if (!/^https?:\/\//i.test(url || '')) return null;
    const h = hostOf(url);
    if (!h || h.includes('ablesci.com') || h === 'doi.org' || h === 'dx.doi.org') return null;
    return url;
  }

  function convertKnownUrlToPdf(url) {
    if (!url) return null;
    const lower = url.toLowerCase();

    const doi = extractDoi(url);
    if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(url) && doi) {
      return `https://doi.org/${doi}`;
    }

    const sd = url.match(/^(https?:\/\/(?:www\.)?sciencedirect\.com\/science\/article\/pii\/([^/?#]+))(?:\/(?:pdfft|pdf)(?:[?#].*)?|[?#].*)?$/i);
    if (sd) {
      return sd[1];
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

    if (lower.includes('/doi/pdf/') || lower.includes('/doi/epdf/') || lower.includes('/content/pdf/') || lower.includes('/pdfft') || lower.includes('.pdf')) {
      return url;
    }

    return null;
  }

  function urlFromDoiAndHost(doi, hintUrl) {
    if (!doi) return null;
    const h = hostOf(hintUrl || '');
    const enc = doi;

    if (h.includes('pubs.acs.org')) return `https://pubs.acs.org/doi/pdf/${enc}`;
    if (h.includes('link.springer.com')) return `https://link.springer.com/content/pdf/${enc}.pdf`;
    if (h.includes('onlinelibrary.wiley.com')) return `https://onlinelibrary.wiley.com/doi/pdf/${enc}`;
    if (h.includes('academic.oup.com')) return hintUrl;
    if (h.includes('ieeexplore.ieee.org')) return hintUrl;
    if (h.includes('frontiersin.org') && /^10\.3389\//i.test(doi)) return `https://www.frontiersin.org/articles/${enc}/pdf`;
    if (h.includes('iopscience.iop.org')) return `https://iopscience.iop.org/article/${enc}/pdf`;
    if (h.includes('nature.com')) return hintUrl;
    if (h.includes('pubs.rsc.org')) return hintUrl;
    if (h.includes('sciencedirect.com')) return null;
    if (/^10\.1016\//i.test(doi)) return `https://doi.org/${enc}`;

    return null;
  }

  function pickPdfUrlFromDocument(doc) {
    doc = doc || document;

    for (const a of Array.from(doc.querySelectorAll('a.direct-pdf[href]'))) {
      const href = normalizeUrl(a.getAttribute('href') || a.href, location.href);
      const pdf = convertKnownUrlToPdf(href) || trustedDirectPdfHref(href);
      if (pdf) return { url: pdf, source: 'direct-pdf' };
    }

    const strongSelectors = [
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

    const doi = getFullDoiFromDocument(doc);
    for (const a of assistLinks) {
      const href = normalizeUrl(a.getAttribute('href') || a.href, location.href);
      const pdf = urlFromDoiAndHost(doi, href);
      if (pdf) return { url: pdf, source: 'doi-plus-publisher-host' };
    }

    if (/^10\.1016\//i.test(doi || '')) {
      return { url: `https://doi.org/${doi}`, source: 'elsevier-doi-fallback' };
    }

    return { url: null, source: 'not-found' };
  }

  function getFullDoiFromDocument(doc) {
    doc = doc || document;
    const sources = [
      '.assist-ai-doi .copy-doi-btn[data-clipboard-text]',
      '.assist-ai-doi a[href*="doi.org/10."]',
      '.assist-ai-doi',
      '.assist-doi .copy-doi-btn[data-clipboard-text]',
      '.assist-doi a[href*="doi.org/10."]',
      '.assist-doi',
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

    return extractDoi(doc.body ? doc.body.innerText : '');
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
    convertKnownUrlToPdf
  };
})();
