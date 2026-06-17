'use strict';

(function () {
  function isScienceDirectUrl(url) {
    // PRIVATE_WATCHER_ONLY
    const s = String(url || '');
    return /:\/\/(?:www\.)?sciencedirect\.com\//i.test(s) || /:\/\/(?:linkinghub\.)?elsevier\.com\//i.test(s);
  }

  function extractScienceDirectPii(url) {
    const s = String(url || '');
    let match = s.match(/\/pii\/([A-Z0-9]+)/i);
    if (match) return match[1].toUpperCase();
    match = s.match(/1-s2\.0-([A-Z0-9]+)/i);
    if (match) return match[1].toUpperCase();
    match = s.match(/\b([SB][A-Z0-9]{16,23})\b/i);
    if (match) return match[1].toUpperCase();
    return '';
  }

  function extractAllScienceDirectPiis(url) {
    const s = String(url || '');
    const piis = [];
    const piiMatches = s.matchAll(/\/pii\/([A-Z0-9]+)/gi);
    for (const match of piiMatches) {
      piis.push(match[1].toUpperCase());
    }
    const s2Matches = s.matchAll(/1-s2\.0-([A-Z0-9]+)/gi);
    for (const match of s2Matches) {
      piis.push(match[1].toUpperCase());
    }
    const rawMatches = s.matchAll(/\b([SB][A-Z0-9]{16,23})\b/gi);
    for (const match of rawMatches) {
      piis.push(match[1].toUpperCase());
    }
    return Array.from(new Set(piis.filter(Boolean)));
  }

  function isDoiHost(host) {
    return /(^|\.)doi\.org$/i.test(String(host || '')) || /(^|\.)dx\.doi\.org$/i.test(String(host || ''));
  }

  function isNatureUrl(url) {
    return /:\/\/(?:www\.)?nature\.com\//i.test(String(url || ''));
  }

  function isCnpeUrl(url) {
    return /\bcnpereading\.com\b/i.test(String(url || ''));
  }

  function isSpringerUrl(url) {
    return /:\/\/link\.springer\.com\//i.test(String(url || ''));
  }

  function isRscDirectPdfUrl(url) {
    return /:\/\/pubs\.rsc\.org\/.*\/articlepdf\//i.test(String(url || ''));
  }

  function isRscUrl(url) {
    return /:\/\/(?:pubs|books)\.rsc\.org\//i.test(String(url || ''));
  }

  function isAipUrl(url) {
    const s = String(url || '');
    return /:\/\/(?:[^/]+\.)?(?:aip\.org|scitation\.org)\//i.test(s);
  }

  function isWileyUrl(url) {
    return /:\/\/(?:[^/]+\.)?onlinelibrary\.wiley\.com\//i.test(String(url || ''));
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

  function isSageUrl(url) {
    return /:\/\/(?:journals\.)?sagepub\.com\//i.test(String(url || ''));
  }

  function isSageKnowledgeUrl(rawUrl) {
    try {
      const u = new URL(String(rawUrl || ''));
      return u.hostname === 'sk.sagepub.com';
    } catch (_) {
      return false;
    }
  }

  function classifySageKnowledgeUrl(rawUrl) {
    let u;
    try {
      u = new URL(String(rawUrl || ''));
    } catch (_) {
      return null;
    }
    if (u.hostname !== 'sk.sagepub.com') return null;
    const p = u.pathname;

    if (/^\/hnbk\/edvol\//.test(p) && /\/chpt\//.test(p)) {
      return {
        skip: true,
        type: 'sage_knowledge_handbook_chapter',
        reason: 'SAGE Knowledge handbook chapter, not a journal article'
      };
    }
    if (/^\/ency\/edvol\//.test(p) && /\/chpt\//.test(p)) {
      return {
        skip: true,
        type: 'sage_knowledge_encyclopedia_entry',
        reason: 'SAGE Knowledge encyclopedia entry, not a journal article'
      };
    }
    if (/^\/(reference|book|books)\/.+\/chpt\//.test(p)) {
      return {
        skip: true,
        type: 'sage_knowledge_book_chapter',
        reason: 'SAGE Knowledge book/reference chapter, not a journal article'
      };
    }

    // SAGE Knowledge 域名下的其他内容也先保守跳过
    return {
      skip: true,
      type: 'sage_knowledge_unsupported',
      reason: 'SAGE Knowledge content is outside current journal article resolver scope'
    };
  }

  function sageArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^https?:\/\/journals\.sagepub\.com\/doi\/(?:pdf|epub)\/(10\.[^?#]+)(?:[?#].*)?$/i);
    return match ? `https://journals.sagepub.com/doi/full/${match[1]}` : '';
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
    if (isCnpeUrl(url)) return 'cnpe';
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
    // PRIVATE_WATCHER_ONLY
    const s = String(h || '');
    return /(^|\.)sciencedirect\.com$/i.test(s) || /(^|\.)sciencedirectassets\.com$/i.test(s) || /(^|\.)elsevier\.com$/i.test(s);
  }

  function isOxfordRelatedDownloadHost(h) {
    const s = String(h || '');
    return /^academic\.oup\.com$/i.test(s) || /(^|\.)silverchair-cdn\.com$/i.test(s) || /(^|\.)silverchair\.com$/i.test(s);
  }

  function isAipRelatedDownloadHost(h) {
    const s = String(h || '');
    return /(^|\.)pubs\.aip\.org$/i.test(s) ||
      /(^|\.)aip\.scitation\.org$/i.test(s) ||
      /(^|\.)scitation\.org$/i.test(s) ||
      /(^|\.)silverchair\.com$/i.test(s) ||
      /(^|\.)silverchair-cdn\.com$/i.test(s);
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
    const match = s.match(/(https?:\/\/(?:www\.)?nature\.com\/articles\/[^/?#]+?)(?:_reference)?(?:\.pdf)?(?:[?#]|$)/i);
    return match ? match[1] : '';
  }

  function rscArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/(https?:\/\/pubs\.rsc\.org\/en\/content\/article(html)?\/[^?#]+)/i);
    return match ? match[1] : '';
  }

  function springerArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^https?:\/\/link\.springer\.com\/content\/pdf\/(10\.[^?#]+?)(?:_reference)?(?:\.pdf)?(?:[?#].*)?$/i);
    if (!match) return '';
    let doi = match[1];
    if (doi.endsWith('_reference')) {
      doi = doi.substring(0, doi.length - 10);
    }
    return `https://link.springer.com/article/${doi}`;
  }

  function wileyArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^https?:\/\/([^/]+\.)?onlinelibrary\.wiley\.com\/doi\/(?:pdf|epdf|pdfdirect)\/(10\.[^?#]+)(?:[?#].*)?$/i);
    if (!match) return '';
    const subdomain = match[1] || '';
    return `https://${subdomain}onlinelibrary.wiley.com/doi/full/${match[2]}`;
  }

  function acsArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^https?:\/\/pubs\.acs\.org\/doi\/(?:pdf|epdf)\/(10\.[^?#]+)(?:[?#].*)?$/i);
    return match ? `https://pubs.acs.org/doi/full/${match[1]}` : '';
  }

  function ieeeArticleUrlFromPdfUrl(url) {
    try {
      const u = new URL(String(url || ''));
      if (!isIeeeUrl(u.href) || !/\/(?:stamp\/stamp|stampPDF\/getPDF)\.jsp$/i.test(u.pathname || '')) return '';
      const arnumber = u.searchParams.get('arnumber');
      return arnumber && /^\d+$/.test(arnumber) ? `https://ieeexplore.ieee.org/document/${arnumber}/` : '';
    } catch (_) {
      return '';
    }
  }

  function scienceDirectArticleUrlFromPdfUrl(url) {
    const pii = extractScienceDirectPii(url);
    if (!pii) return '';
    return `https://www.sciencedirect.com/science/article/pii/${pii}`;
  }

  function cnpeArticleUrlFromPdfUrl(url) {
    const s = String(url || '');
    const match = s.match(/^(https?:\/\/([^/]+\.)?cnpereading\.com)\/pdf\/(10\.[^?#]+?)(?:[?#].*)?$/i);
    return match ? `${match[1]}/doi/${match[3]}` : '';
  }

  function publisherArticleUrlFromPdfUrl(url) {
    if (isDoiUrl(url)) return url;
    return scienceDirectArticleUrlFromPdfUrl(url) || natureArticleUrlFromPdfUrl(url) || cnpeArticleUrlFromPdfUrl(url) || springerArticleUrlFromPdfUrl(url) || rscArticleUrlFromPdfUrl(url) || wileyArticleUrlFromPdfUrl(url) || aipArticleUrlFromPdfUrl(url) || acsArticleUrlFromPdfUrl(url) || ieeeArticleUrlFromPdfUrl(url) || iopArticleUrlFromPdfUrl(url) || sageArticleUrlFromPdfUrl(url) || '';
  }

  function looksLikePdfDownloadUrl(url) {
    const value = String(url || '');
    if (isIeeeUrl(value) && /\/stamp\/stamp\.jsp/i.test(value)) return false;
    return /\/(?:pdf|pdfft)(?:[/?#]|$)|\/doi\/pdfdirect\/|\/articlepdf\/|\/article-pdf\/|\/content\/pdf\/|\/website\/journal\/download\?articleId=|\.pdf(?:[?#]|$)|downloadpdf|viewpdf|stampPDF\/getPDF\.jsp|stamp\/stamp\.jsp/i.test(value);
  }

  function isLikelyTargetDownload(item, expectedHost, sourceUrl) {
    const url = String(item?.finalUrl || item?.url || '');
    const filename = String(item?.filename || '');
    const mime = String(item?.mime || '');
    const sourcePiis = extractAllScienceDirectPiis(sourceUrl);
    const actualPiis = extractAllScienceDirectPiis(url);

    const getHostname = (u) => {
      const s = String(u || '').trim();
      if (!s) return '';
      try {
        if (/^https?:\/\//i.test(s)) return new URL(s).hostname;
        return new URL('https://' + s).hostname;
      } catch (_) {
        const match = s.match(/^(?:https?:\/\/)?([^/]+)/i);
        return match ? match[1].split(':')[0] : '';
      }
    };

    const sourceHost = getHostname(sourceUrl);
    const finalHost = getHostname(url);
    const expected = getHostname(expectedHost || '').toLowerCase();
    const actualPdfLike = /\.pdf$/i.test(filename) || /pdf/i.test(mime) || looksLikePdfDownloadUrl(url);
    const sourcePdfLike = looksLikePdfDownloadUrl(sourceUrl);
    const pdfLike = actualPdfLike || sourcePdfLike;

    if (!pdfLike) {
      return { ok: false, reason: `pdfLike_check_failed (filename: "${filename}", mime: "${mime}", looksLikeUrl: ${looksLikePdfDownloadUrl(url)}, looksLikeSource: ${looksLikePdfDownloadUrl(sourceUrl)})` };
    }
    if (sourcePiis.length > 0 && actualPiis.length > 0) {
      let matched = false;
      for (const sp of sourcePiis) {
        for (const ap of actualPiis) {
          if (sp.substring(0, 10) === ap.substring(0, 10)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) {
        return { ok: false, reason: `pii_mismatch (sourcePiis: "${sourcePiis.join(',')}", actualPiis: "${actualPiis.join(',')}")` };
      }
    }

    // IEEE arnumber 校验
    const extractIeeeArnumber = (u) => {
      const s = String(u || '').trim();
      const match = s.match(/(?:arnumber=|document\/)(\d+)/i);
      return match ? match[1] : '';
    };
    const sourceAr = extractIeeeArnumber(sourceUrl);
    const actualAr = extractIeeeArnumber(url);
    if (sourceAr && actualAr && sourceAr !== actualAr) {
      return { ok: false, reason: `ieee_arnumber_mismatch (sourceAr: "${sourceAr}", actualAr: "${actualAr}")` };
    }

    // RSC ID 校验
    const extractRscId = (u) => {
      const s = String(u || '').trim();
      const match = s.match(/\/content\/article(?:pdf|html|landing)\/\d{4}\/[a-z]{2}\/([a-z0-9]+)/i);
      return match ? match[1].toLowerCase() : '';
    };
    const sourceRsc = extractRscId(sourceUrl);
    const actualRsc = extractRscId(url);
    if (sourceRsc && actualRsc && sourceRsc !== actualRsc) {
      return { ok: false, reason: `rsc_id_mismatch (sourceRsc: "${sourceRsc}", actualRsc: "${actualRsc}")` };
    }

    const sourceDoi = (() => {
      const match = decodeURIComponent(String(sourceUrl || '')).match(/(10\.\d{4,9}\/[^?#\s"']+)/i);
      return match ? match[1].toLowerCase().replace(/\.pdf$/i, '').trim() : '';
    })();
    const actualDoi = (() => {
      const match = decodeURIComponent(String(url || '')).match(/(10\.\d{4,9}\/[^?#\s"']+)/i);
      return match ? match[1].toLowerCase().replace(/\.pdf$/i, '').trim() : '';
    })();
    if (sourceDoi && actualDoi && sourceDoi !== actualDoi && !sourceDoi.startsWith(actualDoi) && !actualDoi.startsWith(sourceDoi)) {
      return { ok: false, reason: `doi_mismatch (sourceDoi: "${sourceDoi}", actualDoi: "${actualDoi}")` };
    }

    // Oxford (OUP) DOI 后缀匹配（限制仅在 expected 匹配 Oxford 时生效，避免误杀 SD 等其它出版社）
    if (expected === 'academic.oup.com' && sourceDoi && !actualDoi) {
      const parts = sourceDoi.split('/');
      const suffix = parts[parts.length - 1]; // 例如 gkad123
      if (suffix && suffix.length >= 4) {
        const lowerUrl = url.toLowerCase();
        const lowerSuffix = suffix.toLowerCase();
        if (!lowerUrl.includes(lowerSuffix)) {
          return { ok: false, reason: `oxford_doi_suffix_mismatch (suffix: "${lowerSuffix}", url: "${lowerUrl}")` };
        }
      }
    }

    if (expected && finalHost.toLowerCase() === expected) return { ok: true };
    if (expected && /sciencedirect/i.test(expected) && isScienceDirectRelatedHost(finalHost)) return { ok: true };
    if (expected === 'academic.oup.com' && isOxfordRelatedDownloadHost(finalHost)) return { ok: true };
    if ((expected === 'pubs.aip.org' || expected === 'aip.scitation.org') && isAipRelatedDownloadHost(finalHost)) return { ok: true };
    if (sourceHost && finalHost && sourceHost.toLowerCase() === finalHost.toLowerCase()) return { ok: true };

    // 当初始请求为 DOI (doi.org) 跳转时，允许匹配支持的各大出版社 PDF 下载主机
    if (isDoiHost(expected) || isDoiHost(sourceHost)) {
      if (!actualPdfLike) {
        return { ok: false, reason: `doi_fallback_requires_actual_pdf_like_url (filename: "${filename}", mime: "${mime}", url: "${url}")` };
      }
      if (isScienceDirectRelatedHost(finalHost)) return { ok: true };
      if (isOxfordRelatedDownloadHost(finalHost)) return { ok: true };
      if (isAipRelatedDownloadHost(finalHost)) return { ok: true };
      if (/(^|\.)springer\.com$/i.test(finalHost) || /(^|\.)springeropen\.com$/i.test(finalHost) || /(^|\.)biomedcentral\.com$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)wiley\.com$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)acs\.org$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)rsc\.org$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)ieee\.org$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)nature\.com$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)iopscience\.iop\.org$/i.test(finalHost) || /(^|\.)iop\.org$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)cnpereading\.com$/i.test(finalHost)) return { ok: true };
      if (/(^|\.)sagepub\.com$/i.test(finalHost)) return { ok: true };
    }

    return { ok: false, reason: `host_mismatch (expected: "${expected}", finalHost: "${finalHost}", sourceHost: "${sourceHost}")` };
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
    if (publisher === 'cnpe') return isCnpeUrl(url);
    if (publisher === 'sage') return isSageUrl(url);
    return false;
  }

  globalThis.AblesciBackgroundPublishers = {
    isScienceDirectUrl,
    extractScienceDirectPii,
    extractAllScienceDirectPiis,
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
    isSageUrl,
    isSageKnowledgeUrl,
    classifySageKnowledgeUrl,
    sageArticleUrlFromPdfUrl,
    publisherForUrl,
    isScienceDirectPdfUrl,
    isDoiUrl,
    isScienceDirectRelatedHost,
    isScienceDirectAssetPdfUrl,
    natureArticleUrlFromPdfUrl,
    isCnpeUrl,
    cnpeArticleUrlFromPdfUrl,
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
