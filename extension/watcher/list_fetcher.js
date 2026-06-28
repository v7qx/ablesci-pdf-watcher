'use strict';

// Responsibility: parse AbleSci assist-list pages from fetched HTML without opening tabs.
(function () {
  function createWatcherListFetcherApi(config = {}) {
    const {
      appendWatcherTrace = async () => {}
    } = config;

    function normalizeText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function htmlDecode(value) {
      return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
          try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return _; }
        })
        .replace(/&#(\d+);/g, (_, dec) => {
          try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return _; }
        });
    }

    function stripTags(value) {
      return normalizeText(htmlDecode(String(value || '').replace(/<[^>]*>/g, ' ')));
    }

    function attrValue(tag, name) {
      const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
      const m = String(tag || '').match(re);
      return htmlDecode(m ? (m[2] ?? m[3] ?? m[4] ?? '') : '');
    }

    function cleanJournalAccessName(value) {
      return normalizeText(htmlDecode(value))
        .replace(/\s*\|\s*本地记录：(?:ScienceDirect|当前出版社)明确无订阅权限；过期后会自动重试\s*/g, '')
        .trim();
    }

    function normalizeDocumentType(value) {
      const text = normalizeText(value);
      if (!text) return '';
      if (/补充材料|supporting information|supplement/i.test(text)) return 'supplement';
      if (/书籍|图书|book|chapter/i.test(text)) return 'book_chapter';
      if (/专利、报告等|专利|patent|report/i.test(text)) return 'patent_report';
      return '';
    }

    function documentTypeTextFromLi(liHtml) {
      const values = [];
      const blockRe = /<(?:span|i)\b[^>]*(?:title\s*=\s*["']文献类型["']|class\s*=\s*["'][^"']*\b(?:paper-type|title-hint)\b[^"']*["'])[^>]*>[\s\S]*?<\/(?:span|i)>/gi;
      let blockMatch;
      while ((blockMatch = blockRe.exec(liHtml))) {
        values.push(stripTags(blockMatch[0]));
      }
      const tagRe = /<(?:span|i)\b[^>]*>/gi;
      let tagMatch;
      while ((tagMatch = tagRe.exec(liHtml))) {
        const tag = tagMatch[0];
        const cls = attrValue(tag, 'class');
        const title = attrValue(tag, 'title');
        if (
          /文献类型|Book|Chapter|Supplement|Patent|Report/i.test(title) ||
          /\b(?:paper-type|title-hint)\b/i.test(cls)
        ) {
          values.push(
            title,
            attrValue(tag, 'aria-label'),
            attrValue(tag, 'data-ablesci-original-title')
          );
        }
      }
      return normalizeText(values.filter(Boolean).join(' '));
    }

    function markerTextFromLi(liHtml) {
      const values = [];
      const tagRe = /<(?:span|i|a|img)\b[^>]*>/gi;
      let tagMatch;
      while ((tagMatch = tagRe.exec(liHtml))) {
        const tag = tagMatch[0];
        const cls = attrValue(tag, 'class');
        const title = attrValue(tag, 'title');
        const aria = attrValue(tag, 'aria-label');
        if (
          /举报|违规|驳回|拒绝|涉嫌|补充材料|文献类型/i.test(`${title} ${aria}`) ||
          /\b(?:paper-type|title-hint|assist-badge|icon-ex-jubao)\b/i.test(cls)
        ) {
          values.push(title, aria, attrValue(tag, 'data-ablesci-original-title'));
        }
      }
      return normalizeText(values.filter(Boolean).join(' '));
    }

    function doiFrom(value) {
      const match = String(value || '').match(/10\.\d{4,9}\/[^\s"']+/i);
      if (!match) return '';
      return match[0].split('#')[0].split('?')[0].replace(/[)\].,;，。]+$/, '');
    }

    function numberFromText(value) {
      const m = String(value || '').replace(/,/g, '').match(/\d+/);
      return m ? Number(m[0]) : null;
    }

    function pageFromHref(href, baseUrl) {
      try {
        const u = new URL(htmlDecode(href), baseUrl);
        const page = parseInt(u.searchParams.get('page') || '', 10);
        return Number.isFinite(page) ? page : null;
      } catch (_) {
        const m = String(href || '').match(/[?&]page=(\d+)/);
        return m ? parseInt(m[1], 10) : null;
      }
    }

    function absUrl(href, baseUrl) {
      try { return new URL(htmlDecode(href), baseUrl).href; } catch (_) { return ''; }
    }

    function assistAgeSecondsFrom(value) {
      const text = normalizeText(value);
      if (!text) return null;
      if (/刚刚|刚才|片刻前/.test(text)) return 0;
      const match = text.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天|周|月|年)\s*前/);
      if (!match) return null;
      const amount = Number(match[1]);
      if (!Number.isFinite(amount)) return null;
      const unit = match[2];
      if (unit === '秒') return Math.round(amount);
      if (unit === '分钟') return Math.round(amount * 60);
      if (unit === '小时') return Math.round(amount * 60 * 60);
      if (unit === '天') return Math.round(amount * 24 * 60 * 60);
      if (unit === '周') return Math.round(amount * 7 * 24 * 60 * 60);
      if (unit === '月') return Math.round(amount * 30 * 24 * 60 * 60);
      if (unit === '年') return Math.round(amount * 365 * 24 * 60 * 60);
      return null;
    }

    function requesterIdFromLi(liHtml, baseUrl) {
      const nicknameTag =
        liHtml.match(/<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bassist-list-nickname\b)(?=[^>]*\bhref\s*=\s*["'][^"']*\/user\/home\?id=)[^>]*>/i)?.[0] ||
        liHtml.match(/<a\b[^>]*href\s*=\s*["'][^"']*\/user\/home\?id=[^"']*["'][^>]*>/i)?.[0] ||
        '';
      const dataId = attrValue(nicknameTag, 'data-id');
      if (dataId) return dataId;
      const href = attrValue(nicknameTag, 'href');
      if (!href) return '';
      try {
        return new URL(href, baseUrl).searchParams.get('id') || '';
      } catch (_) {
        return '';
      }
    }

    function extractTitle(liHtml) {
      const copied = attrValue(liHtml.match(/<a\b[^>]*\bdata-clipboard-text\s*=[^>]*>/i)?.[0] || '', 'data-clipboard-text');
      if (copied) return normalizeText(copied);
      const linkInner = liHtml.match(/<a\b[^>]*title\s*=\s*"查看详情"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '';
      return normalizeText(stripTags(linkInner.replace(/<span\b[\s\S]*?<\/span>/gi, ''))).replace(/^\[高分\]\s*/, '');
    }

    function looksLikeJournalSpan(openTag, innerHtml, title) {
      const cls = attrValue(openTag, 'class');
      const cleanTitle = cleanJournalAccessName(attrValue(openTag, 'data-ablesci-original-title') || title);
      const label = cleanJournalAccessName(stripTags(innerHtml));
      const value = cleanTitle || label;
      if (!value) return false;
      if (/\btitle-hint\b|\bpaper-publisher\b/i.test(cls)) return false;
      if (/<(?:i|img)\b/i.test(innerHtml)) return false;
      if (/求助|违规|举报|高分|置顶|悬赏|文献类型|Book|Chapter|Supplement/i.test(value)) return false;
      return true;
    }

    function extractJournalShortName(liHtml) {
      const original = liHtml.match(/data-ablesci-original-title\s*=\s*"([^"]+)"/i);
      if (original) return cleanJournalAccessName(original[1]);
      const titleLink = liHtml.match(/<a\b[^>]*title\s*=\s*"查看详情"[^>]*>[\s\S]*?<\/a>/i)?.[0] || liHtml;
      const spanRe = /(<span\b[^>]*\btitle\s*=\s*"([^"]+)"[^>]*>)([\s\S]*?)<\/span>/gi;
      let m;
      while ((m = spanRe.exec(titleLink))) {
        if (!looksLikeJournalSpan(m[1], m[3], m[2])) continue;
        const value = cleanJournalAccessName(attrValue(m[1], 'data-ablesci-original-title') || m[2] || stripTags(m[3]));
        if (value) return value;
      }
      return '';
    }

    function extractListItems(html) {
      const items = [];
      const listHtml = html.match(/<ul\b[^>]*class\s*=\s*"[^"]*\bassist-list\b[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)?.[1] || html;
      const chunks = listHtml.split(/<li\b/i).slice(1).map(chunk => `<li${chunk.split(/<\/li>/i)[0]}</li>`);
      for (const chunk of chunks) {
        const assistId = htmlDecode(chunk.match(/<input[^>]+\bclass\s*=\s*"[^"]*\bassist-id-val\b[^"]*"[^>]+\bvalue\s*=\s*"([^"]+)"/i)?.[1] || '').trim();
        if (assistId) items.push({ assistId, html: chunk });
      }
      return items;
    }

    function extractStats(html, url) {
      let currentPage = 1;
      let maxPage = 1;
      try {
        const u = new URL(url);
        const urlPage = parseInt(u.searchParams.get('page') || '', 10);
        if (Number.isFinite(urlPage) && urlPage > 0) currentPage = urlPage;
      } catch (_) {}

      const active =
        html.match(/<li[^>]*class\s*=\s*"[^"]*\bactive\b[^"]*"[^>]*>\s*<a[^>]*>(\d+)<\/a>/i)?.[1] ||
        html.match(/<span[^>]*class\s*=\s*"[^"]*\blayui-laypage-curr\b[^"]*"[^>]*>[\s\S]*?<em[^>]*>(\d+)<\/em>/i)?.[1];
      if (active) currentPage = Number(active) || currentPage;

      const pageNums = [currentPage];
      const hrefRe = /<a\b[^>]*href\s*=\s*"([^"]*page=\d+[^"]*)"[^>]*>/gi;
      let hrefMatch;
      while ((hrefMatch = hrefRe.exec(html))) {
        const page = pageFromHref(hrefMatch[1], url);
        if (Number.isFinite(page)) pageNums.push(page);
      }
      maxPage = Math.max(...pageNums.filter(Number.isFinite));

      const publisherCounts = {};
      const publisherRe = /<(a|div)\b[^>]*class\s*=\s*"[^"]*\bwaiting-publisher-item\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;
      let p;
      while ((p = publisherRe.exec(html))) {
        const block = p[0];
        const title = attrValue(block.match(/<img\b[^>]*\btitle\s*=[^>]*>/i)?.[0] || block, 'title')
          || attrValue(block, 'title').replace(/^查看\s+|\s+的所有求助$/g, '');
        const href = htmlDecode(attrValue(block, 'href'));
        let publisherSlug = '';
        try {
          publisherSlug = String(new URL(href, url).searchParams.get('publisher') || '').toLowerCase();
        } catch (_) {}
        const count = numberFromText(stripTags(block.match(/<span\b[^>]*class\s*=\s*"[^"]*\bwaiting-publisher-item-num\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ''));
        const key = publisherSlug || title;
        if (key && Number.isFinite(count)) publisherCounts[key] = count;
      }

      return {
        sourceUrl: url,
        totalSeeking: null,
        supplementCount: null,
        publisherCounts,
        currentPage,
        maxPage
      };
    }

    // Background string/regex parse of the list HTML. Must produce the SAME
    // candidate field shape as the injected DOM parser in
    // watcher/candidate.js -> parseAssistListPage (which cannot reuse this code
    // because it runs inside the page via executeScript). Keep their candidate
    // fields in sync whenever either side changes.
    function parseAssistListHtml(html, url) {
      const parseStartedAt = Date.now();
      const stripStartedAt = Date.now();
      const visibleHtml = String(html || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
      const bodyText = stripTags(visibleHtml);
      const stripBodyMs = Date.now() - stripStartedAt;
      const titleStartedAt = Date.now();
      const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
      const titleMs = Date.now() - titleStartedAt;
      const basePerf = () => ({
        totalParseMs: Date.now() - parseStartedAt,
        stripBodyMs,
        titleMs
      });
      const isErrorPage =
        /502 Bad Gateway|504 Gateway Time|500 Internal Server|503 Service Temporarily|403 Forbidden|404 Not Found/i.test(`${title} ${bodyText}`) ||
        /科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|您所访问的资源出现网络错误/i.test(`${title} ${bodyText}`);
      if (isErrorPage) {
        return { isErrorPage: true, errorTitle: title || 'error_page', candidates: [], perf: basePerf(), debug: { title, bodyLength: bodyText.length } };
      }
      if (/Cloudflare|Just a moment|请完成验证|验证你是真人|人机验证|安全检查/i.test(bodyText)) {
        return { cfChallenge: true, candidates: [], perf: basePerf(), debug: { title, bodyLength: bodyText.length } };
      }

      const extractItemsStartedAt = Date.now();
      const items = extractListItems(html);
      const extractItemsMs = Date.now() - extractItemsStartedAt;
      const mapCandidatesStartedAt = Date.now();
      const candidates = items.map((item, index) => {
        const li = item.html;
        const detailHref =
          attrValue(li.match(new RegExp(`<a\\\\b[^>]*href\\\\s*=\\\\s*"[^"]*/assist/detail\\\\?id=${item.assistId}[^"]*"[^>]*>`, 'i'))?.[0] || '', 'href') ||
          attrValue(li.match(/<a\b[^>]*href\s*=\s*"[^"]*\/assist\/detail\?id=[^"]*"[^>]*>/i)?.[0] || '', 'href');
        const detailUrl = absUrl(detailHref, url);
        const rowText = stripTags(li);
        const markerText = markerTextFromLi(li);
        const typeText = documentTypeTextFromLi(li);
        const documentType = normalizeDocumentType(typeText);
        const classText = `${attrValue(li, 'class')} ${attrValue(li.match(/<a\b[^>]*title\s*=\s*"查看详情"[^>]*>/i)?.[0] || '', 'class')}`;
        const statusText = stripTags(li.match(/<span\b[^>]*class\s*=\s*"[^"]*\bassist-badge\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
        const assistTimeText = stripTags(li.match(/<span\b[^>]*title\s*=\s*"求助时间"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
        const publisherName = attrValue(li.match(/<span\b[^>]*class\s*=\s*"[^"]*\bpaper-publisher\b[^"]*"[^>]*>[\s\S]*?<img\b[^>]*\btitle\s*=[^>]*>/i)?.[0] || '', 'title');
        const doi = doiFrom(rowText);
        return {
          assistId: item.assistId,
          detailUrl,
          listUrl: url,
          title: extractTitle(li),
          rowText,
          doi,
          hasDoi: !!doi,
          publisherName,
          journalShortName: extractJournalShortName(li),
          reported: /被举报|涉嫌违规|正在被举报|举报中|举报违规\s*\(\s*[1-9]\d*\s*\)/.test(`${rowText} ${markerText}`),
          rejected: /驳回|已驳回|拒绝/.test(`${rowText} ${markerText}`),
          supplement: documentType === 'supplement' || /补充材料|Supplement|supporting information|学位论文/i.test(rowText),
          documentType,
          documentTypeText: normalizeText(typeText),
          statusText,
          assistTimeText,
          assistAgeSeconds: assistAgeSecondsFrom(assistTimeText),
          requesterId: requesterIdFromLi(li, url),
          sticky: /stick-assist|置顶/.test(`${classText} ${rowText}`),
          index
        };
      }).filter(candidate => candidate.detailUrl);
      const mapCandidatesMs = Date.now() - mapCandidatesStartedAt;
      const extractStatsStartedAt = Date.now();
      const listStats = extractStats(html, url);
      const extractStatsMs = Date.now() - extractStatsStartedAt;

      return {
        cfChallenge: false,
        candidates,
        listStats,
        perf: {
          totalParseMs: Date.now() - parseStartedAt,
          stripBodyMs,
          titleMs,
          extractItemsMs,
          mapCandidatesMs,
          extractStatsMs
        },
        debug: {
          title,
          rowCount: items.length,
          detailLinkCount: (html.match(/\/assist\/detail\?id=/g) || []).length,
          assistIdCount: items.length,
          publisherItemCount: (html.match(/waiting-publisher-item/g) || []).length,
          bodyLength: bodyText.length,
          loginLike: /登录|请先登录|login/i.test(bodyText),
          parseSource: 'background_fetch'
        }
      };
    }

    async function fetchListUrl(url, traceContext = {}) {
      const started = Date.now();
      try {
        const response = await fetch(url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow'
        });
        const headersAt = Date.now();
        const finalUrl = response.url || url;
        const contentType = response.headers?.get?.('content-type') || '';
        const html = await response.text();
        const textAt = Date.now();
        const parsed = parseAssistListHtml(html, finalUrl);
        const parseDoneAt = Date.now();
        const perf = {
          totalMs: parseDoneAt - started,
          fetchHeadersMs: headersAt - started,
          readTextMs: textAt - headersAt,
          parseMs: parseDoneAt - textAt,
          ...(parsed.perf || {})
        };
        await appendWatcherTrace('perf_list_fetch_detail', {
          reason: 'background_fetch_detail',
          trigger: traceContext.trigger || '',
          publisher: traceContext.publisher || '',
          pickedPage: traceContext.pickedPage || '',
          url,
          finalUrl,
          ok: response.ok,
          status: response.status,
          contentType,
          candidateCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
          currentPage: parsed.listStats?.currentPage || '',
          maxPage: parsed.listStats?.maxPage || '',
          ...perf
        });
        await appendWatcherTrace('list_fetch_result', {
          reason: 'background_fetch',
          trigger: traceContext.trigger || '',
          publisher: traceContext.publisher || '',
          pickedPage: traceContext.pickedPage || '',
          url,
          finalUrl,
          ok: response.ok,
          status: response.status,
          contentType,
          elapsedMs: perf.totalMs,
          fetchHeadersMs: perf.fetchHeadersMs,
          readTextMs: perf.readTextMs,
          parseMs: perf.parseMs,
          totalParseMs: perf.totalParseMs,
          candidateCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
          currentPage: parsed.listStats?.currentPage || '',
          maxPage: parsed.listStats?.maxPage || '',
          cfChallenge: parsed.cfChallenge === true,
          isErrorPage: parsed.isErrorPage === true,
          loginLike: parsed.debug?.loginLike === true,
          bodyLength: parsed.debug?.bodyLength || ''
        });
        if (!response.ok && !parsed.cfChallenge && !parsed.isErrorPage) {
          parsed.isErrorPage = true;
          parsed.errorTitle = `HTTP ${response.status}`;
        }
        return parsed;
      } catch (err) {
        await appendWatcherTrace('list_fetch_failed', {
          reason: 'background_fetch_failed',
          trigger: traceContext.trigger || '',
          publisher: traceContext.publisher || '',
          pickedPage: traceContext.pickedPage || '',
          url,
          elapsedMs: Date.now() - started,
          error: err?.message || String(err)
        });
        return { fetchFailed: true, error: err?.message || String(err), candidates: [] };
      }
    }

    return {
      fetchListUrl,
      parseAssistListHtml
    };
  }

  globalThis.AblesciWatcherListFetcherModule = {
    createWatcherListFetcherApi
  };
})();
