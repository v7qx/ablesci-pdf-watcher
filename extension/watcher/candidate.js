// Responsibility: candidate filtering, journal access rules, short-name
// mapping, and list-page parsing helpers for the auto watcher.
(function () {
  function createWatcherCandidateApi(config) {
    const {
      chromeApi,
      saveWatcherState,
      getWatcherState,
      appendWatcherTrace,
      publisherAlias,
      normalizeText,
      journalShortNameMapKey,
      highRiskFailThreshold,
      doiFailureSkipThreshold
    } = config;
    const JOURNAL_ACCESS_TTL_MS = 180 * 24 * 60 * 60 * 1000;
    const JOURNAL_ACCESS_CACHEABLE_PUBLISHERS = new Set(['sciencedirect', 'wiley', 'rsc', 'acs', 'sage']);

    function candidatePublisherName(candidate) {
      return publisherAlias(candidate?.publisherName || candidate?.journalShortName || candidate?.rowText || candidate?.title || '');
    }

    function pagePublisherAlias(listUrl, pagePublisher = '') {
      const direct = publisherAlias(pagePublisher);
      if (direct && direct !== 'Unknown') return direct;
      try {
        const u = new URL(listUrl);
        return publisherAlias(u.searchParams.get('publisher') || '');
      } catch (_) {
        return direct || 'Unknown';
      }
    }

    function normalizeDocumentType(text) {
      const value = normalizeText(text);
      if (!value) return '';
      if (/补充材料|supporting information|supplement/i.test(value)) return 'supplement';
      if (/书籍|图书|book|chapter/i.test(value)) return 'book_chapter';
      if (/专利、报告等|专利|patent|report/i.test(value)) return 'patent_report';
      return '';
    }

    function normalizeJournalKey(value) {
      return String(value || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function cleanJournalAccessName(value) {
      return normalizeText(value)
        .replace(/\s*\|\s*本地记录：(?:ScienceDirect|当前出版社)明确无订阅权限；过期后会自动重试\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function journalAccessPublisherKey(candidate = {}, payload = null) {
      const values = [
        candidate?.publisherName,
        payload?.publisherName,
        candidate?.listUrl,
        candidate?.detailUrl,
        payload?.pdfUrl,
        payload?.articleUrl,
        payload?.pageUrl,
        candidate?.doi,
        payload?.doi,
        candidate?.rowText,
        candidate?.journalShortName
      ].map(value => String(value || '')).join(' ');
      if (/ieee/i.test(values)) return 'ieee';
      if (/elsevier|science\s*direct|sciencedirect\.com|10\.1016\//i.test(values)) return 'sciencedirect';
      if (/wiley|onlinelibrary\.wiley\.com|10\.1002\//i.test(values)) return 'wiley';
      if (/\brsc\b|royal\s+society\s+of\s+chemistry|pubs\.rsc\.org|10\.1039\//i.test(values)) return 'rsc';
      if (/\bacs\b|acs\.org|pubs\.acs\.org|10\.1021\//i.test(values)) return 'acs';
      if (/sage|journals\.sagepub\.com|10\.1177\//i.test(values)) return 'sage';
      const alias = publisherAlias(values).toLowerCase();
      if (/elsevier|sciencedirect/.test(alias)) return 'sciencedirect';
      if (/wiley/.test(alias)) return 'wiley';
      if (/\brsc\b/.test(alias)) return 'rsc';
      if (/\bacs\b/.test(alias)) return 'acs';
      if (/sage/.test(alias)) return 'sage';
      if (/ieee/.test(alias)) return 'ieee';
      return alias && alias !== 'unknown' ? alias : '';
    }

    function isCacheableJournalAccessPublisher(publisherKey) {
      return JOURNAL_ACCESS_CACHEABLE_PUBLISHERS.has(String(publisherKey || '').toLowerCase());
    }

    function journalAccessCacheKey(publisherKey, journalKey) {
      const p = String(publisherKey || '').toLowerCase();
      const j = String(journalKey || '').toLowerCase();
      return p && j ? `${p}:${j}` : '';
    }

    function journalRuleNames(entry) {
      if (typeof entry === 'string') return [entry];
      if (!entry || typeof entry !== 'object') return [];
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      return [entry.short, entry.full, entry.journal, entry.name, ...aliases].filter(Boolean);
    }

    function candidateJournalNames(candidate, payload = null) {
      return [
        payload?.journalShortName,
        payload?.journalName,
        candidate?.journalFullName,
        candidate?.journalShortName,
        ...(Array.isArray(candidate?.journalAliases) ? candidate.journalAliases : []),
        candidate?.title
      ].filter(Boolean);
    }

    function journalShortNameMapFromState(state = {}) {
      const map = state.journalShortNameMap || state[journalShortNameMapKey] || {};
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }

    function journalAccessStatsFromState(state = {}) {
      const map = state.journalAccessStats || {};
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    }

    function isScienceDirectCandidate(candidate = {}, payload = null) {
      return journalAccessPublisherKey(candidate, payload) === 'sciencedirect';
    }

    function journalAccessEntryForCandidate(candidate, state = {}) {
      const shortName = cleanJournalAccessName(candidate?.journalShortName || '');
      const key = normalizeJournalKey(shortName);
      const publisherKey = journalAccessPublisherKey(candidate);
      if (!key || !isCacheableJournalAccessPublisher(publisherKey)) return null;
      const stats = journalAccessStatsFromState(state);
      const entry = stats[journalAccessCacheKey(publisherKey, key)] || (publisherKey === 'sciencedirect' ? stats[key] : null);
      if (!entry || typeof entry !== 'object') return null;
      if ((entry.publisher || publisherKey) !== publisherKey && !(publisherKey === 'sciencedirect' && entry.publisher === 'sciencedirect')) return null;
      if (entry.status && entry.status !== 'blocked') return null;
      if (entry.reason !== 'explicit_no_subscription') return null;
      const expiresAt = Date.parse(entry.expiresAt || '');
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      return { key, entry };
    }

    async function traceJournalAccessRecordSkipped(reason, candidate = {}, payload = null, extra = {}) {
      await appendWatcherTrace('journal_access_record_skipped', {
        reason,
        sourceReason: extra.sourceReason || '',
        assistId: payload?.assistId || candidate?.assistId || '',
        detailUrl: candidate?.detailUrl || payload?.pageUrl || '',
        listUrl: candidate?.listUrl || '',
        publisherName: candidate?.publisherName || payload?.publisherName || '',
        publisher: journalAccessPublisherKey(candidate, payload),
        journalShortName: cleanJournalAccessName(candidate?.journalShortName || payload?.journalShortName || ''),
        journalName: payload?.journalName || '',
        doi: payload?.doi || candidate?.doi || '',
        ...extra
      });
    }

    function journalShortNameMapEntry(map, shortName) {
      const key = normalizeJournalKey(shortName);
      if (!key) return null;
      const item = map[key] || map[shortName] || null;
      if (typeof item === 'string') return { short: shortName, full: item, aliases: [] };
      if (item && typeof item === 'object') return item;
      return null;
    }

    function enrichCandidateJournalFromMap(candidate, state = {}) {
      if (!candidate || !candidate.journalShortName) return candidate;
      const entry = journalShortNameMapEntry(journalShortNameMapFromState(state), candidate.journalShortName);
      if (!entry) return candidate;
      const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
      return {
        ...candidate,
        journalFullName: entry.full || entry.journal || entry.name || candidate.journalFullName || '',
        journalAliases: [entry.short, entry.full, entry.journal, entry.name, ...aliases].filter(Boolean)
      };
    }

    async function rememberJournalShortNameMapping(candidate, payload) {
      const shortName = cleanJournalAccessName(candidate?.journalShortName || payload?.journalShortName || '');
      const fullName = normalizeText(payload?.journalName || '');
      if (!shortName || !fullName) return;
      if (normalizeJournalKey(shortName) === normalizeJournalKey(fullName)) return;
      const state = await getWatcherState();
      const map = journalShortNameMapFromState(state);
      const key = normalizeJournalKey(shortName);
      const existing = journalShortNameMapEntry(map, shortName) || {};
      const aliases = Array.from(new Set([
        ...(Array.isArray(existing.aliases) ? existing.aliases : []),
        shortName,
        fullName
      ].filter(Boolean)));
      map[key] = {
        short: shortName,
        full: fullName,
        aliases,
        source: 'assist_detail',
        updatedAt: new Date().toISOString()
      };
      state.journalShortNameMap = map;
      await saveWatcherState(state);
      await appendWatcherTrace('journal_short_name_mapped', {
        reason: 'detail_journal_mapping',
        assistId: payload?.assistId || candidate?.assistId || '',
        detailUrl: candidate?.detailUrl || payload?.pageUrl || '',
        shortName,
        fullName
      });
    }

    function isLikelyRscCandidate(candidate = {}) {
      const haystack = [
        candidate.publisherName,
        candidate.source,
        candidate.listUrl,
        candidate.detailUrl,
        candidate.rowText
      ].map(value => String(value || '')).join(' ');
      return /rsc|royal society of chemistry/i.test(haystack);
    }

    function describeWatcherReason(reason) {
      const code = normalizeText(reason);
      const labels = {
        missing_detail_url: '列表项没有求助详情链接',
        sticky_assist: '置顶求助默认跳过',
        not_waiting: '当前不是可应助状态',
        reported: '已按设置跳过举报/违规提示求助',
        rejected: '已按设置跳过驳回应助记录求助',
        supplement: '已按设置跳过补充材料求助',
        book_chapter: '已按设置跳过书籍章节求助',
        patent_report: '已按设置跳过专利/报告类求助',
        risk_text: '已按设置跳过含异常文本的求助',
        missing_assist_id: '详情页缺少求助 ID',
        missing_doi: '已按设置跳过没有 DOI 的求助',
        missing_pdf_url: '详情页没有识别到可下载 PDF',
        detail_book_chapter: '详情页识别为书籍章节，已跳过',
        detail_patent_report: '详情页识别为专利/报告类，已跳过',
        detail_supplement: '详情页识别为补充材料，已跳过',
        detail_rejected_history: '详情页存在驳回应助历史，已跳过',
        detail_reported_warning: '详情页存在举报/违规提示，已跳过',
        detail_system_risk: '详情页存在系统风险提示，已跳过',
        detail_system_prompt_si: '详情页系统提示 DOI 可能是补充材料或并非全文，已跳过',
        detail_remark: '详情页存在备注，已按设置跳过',
        detail_risk_text: '详情页命中风险文本，已跳过',
        list_corrigendum: '已按设置跳过 Corrigendum 更正类求助 (列表页)',
        list_supplement: '已按设置跳过补充材料求助 (列表页)',
        list_book_chapter: '已按设置跳过书籍章节求助 (列表页)',
        list_patent_report: '已按设置跳过专利/报告类求助 (列表页)',
        list_too_fresh_assist: '刚发布不足 1 分钟，先跳过以降低抢单失败概率',
        list_blacklist_user: '求助人 ID 处于黑名单中，列表页直接跳过',
        detail_corrigendum: '已按设置跳过 Corrigendum 更正类求助 (详情页)',
        detail_blacklist_user: '求助人 ID 处于黑名单中，已跳过',
        journal_blocked_rule: '命中本地期刊规则，列表页直接跳过'
      };
      return labels[code] ? `${code} - ${labels[code]}` : code;
    }

    // All candidates passing the allow-list filters are equally eligible.
    // Random shuffle ensures each run doesn't always hit the same candidate first.
    function orderCandidatesForRun(candidates, state, opts = {}, count = 1) {
      if (!Array.isArray(candidates)) return [];
      const shuffled = candidates.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      return shuffled;
    }

    function parseAssistListPage() {
      function normalizeTextLocal(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      }
      function cleanJournalAccessNameLocal(value) {
        return normalizeTextLocal(value)
          .replace(/\s*\|\s*本地记录：(?:ScienceDirect|当前出版社)明确无订阅权限；过期后会自动重试\s*/g, '')
          .trim();
      }
      function isJournalBadgeSpan(span) {
        if (!span) return false;
        if (span.closest?.('.paper-publisher')) return false;
        if (span.classList?.contains('title-hint')) return false;
        if (span.querySelector?.('i')) return false;
        const title = cleanJournalAccessNameLocal(span.getAttribute('data-ablesci-original-title') || span.getAttribute('title') || '');
        const label = cleanJournalAccessNameLocal(text(span));
        const value = title || label;
        if (!value) return false;
        if (/求助|违规|举报|高分|置顶|悬赏|文献类型|Book|Chapter|Supplement/i.test(value)) return false;
        return true;
      }
      function extractJournalShortNameFromAnchor(anchor) {
        const spans = Array.from(anchor?.querySelectorAll('span[title]') || []);
        for (const span of spans) {
          if (!isJournalBadgeSpan(span)) continue;
          const value = span.getAttribute('data-ablesci-original-title') || span.getAttribute('title') || text(span);
          const clean = cleanJournalAccessNameLocal(value);
          if (clean) return clean;
        }
        return '';
      }
      function normalizeDocumentTypeLocal(value) {
        const textValue = normalizeTextLocal(value);
        if (!textValue) return '';
        if (/补充材料|supporting information|supplement/i.test(textValue)) return 'supplement';
        if (/书籍|图书|book|chapter/i.test(textValue)) return 'book_chapter';
        if (/专利、报告等|专利|patent|report/i.test(textValue)) return 'patent_report';
        return '';
      }
      function text(el) {
        return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      }
      function numberFromText(value) {
        const m = String(value || '').replace(/,/g, '').match(/\d+/);
        return m ? Number(m[0]) : null;
      }
      function pageFromHref(href) {
        try {
          const u = new URL(href, location.href);
          const page = parseInt(u.searchParams.get('page') || '', 10);
          return Number.isFinite(page) ? page : null;
        } catch (_) {
          const m = String(href || '').match(/[?&]page=(\d+)/);
          return m ? parseInt(m[1], 10) : null;
        }
      }
      function absUrl(href) {
        try { return new URL(href, location.href).href; } catch (_) { return ''; }
      }
      function doiFrom(textValue) {
        const match = String(textValue || '').match(/10\.\d{4,9}\/[^\s"']+/i);
        if (!match) return '';
        return match[0].split('#')[0].split('?')[0].replace(/[)\].,;，。]+$/, '');
      }
      function assistAgeSecondsFrom(textValue) {
        const value = normalizeTextLocal(textValue);
        if (!value) return null;
        if (/刚刚|刚才|片刻前/.test(value)) return 0;
        const match = value.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时|天|周|月|年)\s*前/);
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
      const bodyText = text(document.body);
      const titleText = document.title || '';
      const isErrorPage =
        /502 Bad Gateway|504 Gateway Time|500 Internal Server|503 Service Temporarily|403 Forbidden|404 Not Found/i.test(titleText + ' ' + bodyText) ||
        /科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|您所访问的资源出现网络错误/i.test(titleText + ' ' + bodyText);
      if (isErrorPage) {
        return { isErrorPage: true, errorTitle: titleText || '502 Bad Gateway', candidates: [] };
      }
      if (/Cloudflare|Just a moment|请完成验证|验证你是真人|人机验证|安全检查/i.test(bodyText)) {
        return { cfChallenge: true, candidates: [] };
      }

      const totalSeeking = numberFromText(text(Array.from(document.querySelectorAll('.fly-filter a'))
        .find(a => /求助中/.test(text(a)))));
      const supplementCount = numberFromText(text(Array.from(document.querySelectorAll('.fly-filter a'))
        .find(a => /补充材料/.test(text(a)))));
      const publisherCounts = {};
      Array.from(document.querySelectorAll('.waiting-publisher-item')).forEach(item => {
        const imgTitle = item.querySelector('img[title]')?.getAttribute('title') || '';
        const title = imgTitle || String(item.getAttribute('title') || '').replace(/^查看\s+|\s+的所有求助$/g, '');
        const count = numberFromText(text(item.querySelector('.waiting-publisher-item-num')));
        if (title && Number.isFinite(count)) publisherCounts[title] = count;
      });
      let currentPage = 1;
      let maxPage = 1;
      try {
        const urlPage = pageFromHref(location.href);
        if (Number.isFinite(urlPage)) currentPage = urlPage;
        const activePageEl = document.querySelector([
          '.pagination li.active a',
          '.pages li.active a',
          '.pagination .active a',
          '.layui-laypage-curr',
          '[aria-current="page"]'
        ].join(', '));
        if (activePageEl) {
          const activeHrefPage = pageFromHref(activePageEl.getAttribute('href') || '');
          const activeTextPage = numberFromText(text(activePageEl));
          currentPage = activeHrefPage || activeTextPage || currentPage;
        }

        const pageAnchors = Array.from(document.querySelectorAll('.pagination a, .pages a, a[href*="page="]'));
        const lastPageAnchor = document.querySelector('.pagination li.last a, .pages li.last a, .pagination .last a') ||
          pageAnchors.find(a => /尾页|末页|最后|last/i.test(text(a) || a.getAttribute('title') || ''));
        if (lastPageAnchor) {
          maxPage = pageFromHref(lastPageAnchor.getAttribute('href') || '') || currentPage;
        }
        const pageNums = [currentPage, maxPage];
        pageAnchors.forEach(a => {
          const page = pageFromHref(a.getAttribute('href') || '');
          if (Number.isFinite(page)) pageNums.push(page);
        });
        maxPage = Math.max(...pageNums.filter(Number.isFinite));
      } catch (_) {}

      const listStats = {
        sourceUrl: location.href,
        totalSeeking: Number.isFinite(totalSeeking) ? totalSeeking : null,
        supplementCount: Number.isFinite(supplementCount) ? supplementCount : null,
        publisherCounts,
        currentPage,
        maxPage
      };

      const rows = Array.from(document.querySelectorAll('ul.assist-list > li, .assist-list li'));
      const candidates = rows.map((row, index) => {
        const detailAnchor = row.querySelector('a[href*="/assist/detail"][title*="查看详情"]') ||
          row.querySelector('.assist-list-title a[href*="/assist/detail"]') ||
          row.querySelector('a[href*="/assist/detail"]');
        const handleAnchor = row.querySelector('.assist-status-badge');
        let title = '';
        if (detailAnchor) {
          const clone = detailAnchor.cloneNode(true);
          Array.from(clone.querySelectorAll('span')).forEach(span => span.remove());
          title = text(clone).replace(/^\[高分\]\s*/, '');
        } else {
          title = '未知文献';
        }
        const rowText = text(row);
        const detailUrl = absUrl(detailAnchor?.getAttribute('href') || detailAnchor?.href || '');
        const assistId = row.querySelector('.assist-id-val')?.value || new URLSearchParams(detailUrl.split('?')[1] || '').get('id') || '';
        const classText = [detailAnchor?.className || '', row.className || ''].join(' ');
        const statusText = text(row.querySelector('.assist-badge')) || text(handleAnchor);
        const assistTimeText = text(row.querySelector('span[title="求助时间"]'));
        const assistAgeSeconds = assistAgeSecondsFrom(assistTimeText);
        const requesterHref = row.querySelector('a.assist-list-nickname[href*="/user/home"]')?.getAttribute('href') || '';
        let requesterId = '';
        try {
          requesterId = new URL(requesterHref, location.href).searchParams.get('id') || '';
        } catch (_) {}
        const publisherName = row.querySelector('.paper-publisher img[title]')?.getAttribute('title') || '';
        const journalShortName = extractJournalShortNameFromAnchor(detailAnchor);
        const typeText = text(row.querySelector('.layui-badge[title="文献类型"], .paper-type, .title-hint[title="Book Chapter"]'));
        const documentType = normalizeDocumentTypeLocal(typeText);
        const doi = doiFrom(rowText);
        return {
          assistId,
          detailUrl,
          listUrl: location.href,
          title,
          rowText,
          doi,
          hasDoi: !!doi,
          publisherName,
          journalShortName,
          reported: /举报|被举报|涉嫌违规/.test(rowText),
          rejected: /驳回|已驳回/.test(rowText),
          supplement: documentType === 'supplement' || /补充材料|Supplement|supporting information|学位论文/i.test(rowText),
          documentType,
          documentTypeText: normalizeTextLocal(typeText),
          statusText,
          assistTimeText,
          assistAgeSeconds,
          requesterId,
          sticky: /stick-assist|置顶/.test(classText + ' ' + rowText),
          index
        };
      }).filter(item => item.detailUrl);

      const debug = {
        readyState: document.readyState || '',
        title: document.title || '',
        rowCount: rows.length,
        detailLinkCount: document.querySelectorAll('a[href*="/assist/detail"]').length,
        assistIdCount: document.querySelectorAll('.assist-id-val').length,
        publisherItemCount: document.querySelectorAll('.waiting-publisher-item').length,
        flyFilterCount: document.querySelectorAll('.fly-filter a').length,
        bodyLength: bodyText.length,
        loginLike: /登录|请先登录|login/i.test(bodyText)
      };

      return { cfChallenge: false, candidates, listStats, debug };
    }

    function minSeekingGateForList(parsed, listUrl, pagePublisher, opts = {}) {
      const threshold = Math.max(0, Number(opts.watcherMinNonSdSeekingCount || 0));
      if (threshold <= 0) return { ok: true, count: null, publisher: '' };
      const alias = pagePublisherAlias(listUrl, pagePublisher);
      if (!alias || alias === 'Unknown' || /elsevier|sciencedirect/i.test(alias)) {
        return { ok: true, count: null, publisher: alias };
      }
      const counts = parsed?.listStats?.publisherCounts || {};
      const count = Object.entries(counts).reduce((sum, [name, value]) => {
        return publisherAlias(name) === alias ? sum + Math.max(0, Number(value) || 0) : sum;
      }, 0);
      if (!Number.isFinite(count) || count <= 0) return { ok: true, count: null, publisher: alias };
      if (count < threshold) {
        return {
          ok: false,
          reason: 'list_low_seeking_count',
          publisher: alias,
          count,
          threshold
        };
      }
      return { ok: true, count, publisher: alias, threshold };
    }

    function waitForAssistListDom(timeoutMs = 9000) {
      function text(el) {
        return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      }
      function snapshot(ready) {
        const bodyText = text(document.body);
        const titleText = document.title || '';
        const detailLinkCount = document.querySelectorAll('a[href*="/assist/detail"]').length;
        const rowCount = document.querySelectorAll('ul.assist-list > li, .assist-list li').length;
        const assistIdCount = document.querySelectorAll('.assist-id-val').length;
        const publisherItemCount = document.querySelectorAll('.waiting-publisher-item').length;
        const flyFilterCount = document.querySelectorAll('.fly-filter a').length;
        const cfChallenge = /Cloudflare|Just a moment|请完成验证|验证你是真人|人机验证|安全检查/i.test(bodyText);
        const isErrorPage =
          /502 Bad Gateway|504 Gateway Time|500 Internal Server|503 Service Temporarily|403 Forbidden|404 Not Found/i.test(titleText + ' ' + bodyText) ||
          /科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|您所访问的资源出现网络错误/i.test(titleText + ' ' + bodyText);
        const emptyListLike = /暂无数据|暂无求助|没有相关求助|未找到相关求助|没有数据/i.test(bodyText);
        return {
          ready,
          readyState: document.readyState || '',
          title: titleText,
          detailLinkCount,
          rowCount,
          assistIdCount,
          publisherItemCount,
          flyFilterCount,
          cfChallenge,
          isErrorPage,
          emptyListLike,
          loginLike: /登录|请先登录|login/i.test(bodyText),
          bodyLength: bodyText.length
        };
      }
      function isReady() {
        const snap = snapshot(false);
        return snap.cfChallenge || snap.isErrorPage || snap.emptyListLike ||
          snap.assistIdCount > 0 ||
          (snap.rowCount > 0 && snap.detailLinkCount > 0);
      }
      if (isReady()) return Promise.resolve(snapshot(true));
      return new Promise(resolve => {
        let done = false;
        let observer = null;
        const startedAt = Date.now();
        const finish = ready => {
          if (done) return;
          done = true;
          clearInterval(timer);
          clearTimeout(timeout);
          try { observer?.disconnect(); } catch (_) {}
          const snap = snapshot(ready);
          snap.elapsedMs = Date.now() - startedAt;
          resolve(snap);
        };
        const check = () => {
          if (isReady()) finish(true);
        };
        const timer = setInterval(check, 250);
        const timeout = setTimeout(() => finish(false), timeoutMs);
        try {
          observer = new MutationObserver(check);
          observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
        } catch (_) {}
        check();
      });
    }

    function isListCandidateAllowed(candidate, opts, state = {}, blacklistedIds = []) {
      const textValue = [candidate.rowText, candidate.title, candidate.statusText].join(' ');
      if (!candidate.detailUrl) return { ok: false, reason: 'missing_detail_url' };
      if (opts.watcherSkipReported && candidate.reported) return { ok: false, reason: 'reported' };
      if (opts.watcherSkipRejected && candidate.rejected) return { ok: false, reason: 'rejected' };
      if (opts.watcherEnableBlacklist && candidate.requesterId) {
        if (Array.isArray(blacklistedIds) && blacklistedIds.length > 0 && blacklistedIds.includes(candidate.requesterId)) {
          return { ok: false, reason: 'list_blacklist_user' };
        }
        if ((!Array.isArray(blacklistedIds) || blacklistedIds.length <= 0) && opts.watcherBlacklistUserIds) {
          const blacklist = String(opts.watcherBlacklistUserIds || '').split(/[^a-zA-Z0-9]+/).map(s => s.trim()).filter(Boolean);
          if (blacklist.includes(candidate.requesterId)) return { ok: false, reason: 'list_blacklist_user' };
        }
      }
      if (candidate.sticky) return { ok: false, reason: 'sticky_assist' };
      if (Number.isFinite(Number(candidate.assistAgeSeconds)) && Number(candidate.assistAgeSeconds) < 60) {
        return { ok: false, reason: 'list_too_fresh_assist' };
      }
      if (!/求助中|waiting|我要应助|可应助/i.test(textValue)) return { ok: false, reason: 'not_waiting' };
      if (opts.watcherSkipCorrigendum && candidate.title && /^Corrigendum\s+to/i.test(String(candidate.title).trim())) {
        return { ok: false, reason: 'list_corrigendum' };
      }
      if (opts.watcherSkipSupplement && (candidate.documentType === 'supplement' || candidate.supplement)) {
        return { ok: false, reason: 'list_supplement' };
      }
      if (opts.watcherSkipBookChapter && candidate.documentType === 'book_chapter') {
        return { ok: false, reason: 'list_book_chapter' };
      }
      if (opts.watcherSkipPatentReport && candidate.documentType === 'patent_report') {
        return { ok: false, reason: 'list_patent_report' };
      }
      const accessBlocked = journalAccessEntryForCandidate(candidate, state);
      if (accessBlocked) {
        return {
          ok: false,
          reason: 'journal_blocked_rule',
          journalAccess: {
            key: accessBlocked.key,
            shortName: cleanJournalAccessName(accessBlocked.entry.shortName || candidate.journalShortName || ''),
            lastAt: accessBlocked.entry.lastAt || '',
            expiresAt: accessBlocked.entry.expiresAt || '',
            hitCount: Number(accessBlocked.entry.hitCount || 0) || 0,
            lastAssistId: accessBlocked.entry.lastAssistId || ''
          }
        };
      }
      return { ok: true };
    }

    function isCacheableScienceDirectNoAccess(reason) {
      return reason === 'explicit_no_subscription' ||
        reason === 'no_access' ||
        /does not subscribe to this content on ScienceDirect|ScienceDirect\s+明确返回无正文订阅权限|明确返回无正文订阅权限|当前出版商无正文订阅权限|无正文订阅权限|无正文访问权限|no\s+access|access\s+denied|no[-_\s]?access|subscribe/i.test(String(reason || ''));
    }

    async function recordJournalAccessBlocked(candidate, payload = null, reason = '') {
      if (!isCacheableScienceDirectNoAccess(reason)) {
        await traceJournalAccessRecordSkipped('non_cacheable_reason', candidate, payload, { sourceReason: reason || '' });
        return false;
      }
      const publisherKey = journalAccessPublisherKey(candidate, payload);
      if (!isCacheableJournalAccessPublisher(publisherKey)) {
        await traceJournalAccessRecordSkipped(publisherKey === 'ieee' ? 'ieee_journal_cache_disabled' : 'not_cacheable_publisher', candidate, payload, { sourceReason: reason || '', publisher: publisherKey });
        return false;
      }
      const state = await getWatcherState();
      let shortName = cleanJournalAccessName(candidate?.journalShortName || payload?.journalShortName || '');
      if (!shortName && payload?.journalName) {
        const fullKey = normalizeJournalKey(payload.journalName);
        const map = journalShortNameMapFromState(state);
        const matched = Object.values(map).find(entry => {
          if (!entry || typeof entry !== 'object') return false;
          return journalRuleNames(entry).some(name => normalizeJournalKey(name) === fullKey);
        });
        shortName = cleanJournalAccessName(matched?.short || '');
      }
      const key = normalizeJournalKey(shortName);
      if (!key) {
        await traceJournalAccessRecordSkipped('missing_journal_short_name', candidate, payload, { sourceReason: reason || '' });
        return false;
      }
      const stats = journalAccessStatsFromState(state);
      const cacheKey = journalAccessCacheKey(publisherKey, key);
      const existing = stats[cacheKey] || (publisherKey === 'sciencedirect' ? stats[key] : {}) || {};
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      stats[cacheKey] = {
        shortName,
        publisher: publisherKey,
        status: 'blocked',
        reason: 'explicit_no_subscription',
        lastAt: nowIso,
        expiresAt: new Date(now + JOURNAL_ACCESS_TTL_MS).toISOString(),
        hitCount: Math.max(0, Number(existing.hitCount || 0) || 0) + 1,
        lastAssistId: payload?.assistId || candidate?.assistId || ''
      };
      if (publisherKey === 'sciencedirect' && stats[key] && key !== cacheKey) {
        delete stats[key];
      }
      state.journalAccessStats = stats;
      await saveWatcherState(state);
      await appendWatcherTrace('journal_access_blocked_recorded', {
        reason: 'explicit_no_subscription',
        sourceReason: reason || '',
        assistId: payload?.assistId || candidate?.assistId || '',
        detailUrl: candidate?.detailUrl || payload?.pageUrl || '',
        publisher: publisherKey,
        shortName,
        expiresAt: stats[cacheKey].expiresAt
      });
      return true;
    }

    async function clearJournalAccessBlocked(candidate, payload = null) {
      const publisherKey = journalAccessPublisherKey(candidate, payload);
      if (!isCacheableJournalAccessPublisher(publisherKey)) return false;
      const shortName = cleanJournalAccessName(candidate?.journalShortName || payload?.journalShortName || '');
      const key = normalizeJournalKey(shortName);
      if (!key) return false;
      const state = await getWatcherState();
      const stats = journalAccessStatsFromState(state);
      const cacheKey = journalAccessCacheKey(publisherKey, key);
      const existing = stats[cacheKey] || (publisherKey === 'sciencedirect' ? stats[key] : {}) || {};
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      stats[cacheKey] = {
        shortName,
        publisher: publisherKey,
        status: 'allowed',
        reason: 'access_confirmed',
        lastAt: nowIso,
        expiresAt: new Date(now + JOURNAL_ACCESS_TTL_MS).toISOString(),
        hitCount: Math.max(0, Number(existing.hitCount || 0) || 0) + 1,
        lastAssistId: payload?.assistId || candidate?.assistId || ''
      };
      if (publisherKey === 'sciencedirect' && stats[key] && key !== cacheKey) {
        delete stats[key];
      }
      state.journalAccessStats = stats;
      await saveWatcherState(state);
      await appendWatcherTrace('journal_access_allowed_recorded', {
        reason: 'upload_success_same_journal',
        assistId: payload?.assistId || candidate?.assistId || '',
        detailUrl: candidate?.detailUrl || payload?.pageUrl || '',
        publisher: publisherKey,
        shortName
      });
      return true;
    }

    function isLikelySageKnowledgeChapterDoi(doi) {
      return /^10\.4135\/97[89]\d{10}\.(n|ch)\d+/i.test(String(doi || '').trim());
    }

    function isDetailAllowedForWatcher(payload, opts, blacklistedIds = []) {
      if (!payload?.assistId) return { ok: false, reason: 'missing_assist_id' };
      const flags = payload.riskFlags || {};
      const textValue = [
        payload.statusText || '',
        payload.riskText || '',
        payload.documentTypeLabel || ''
      ].join(' ');

      if (opts.watcherSkipBookChapter && payload.documentType === 'book_chapter') return { ok: false, reason: 'detail_book_chapter' };
      if (opts.watcherSkipPatentReport && payload.documentType === 'patent_report') return { ok: false, reason: 'detail_patent_report' };
      if (opts.watcherSkipSupplement && (payload.documentType === 'supplement' || flags.supplement)) return { ok: false, reason: 'detail_supplement' };
      if (opts.watcherRequireDoi && !payload?.doi) return { ok: false, reason: 'missing_doi' };
      if (!payload?.pdfUrl) return { ok: false, reason: 'missing_pdf_url' };

      // SAGE Knowledge 书章/百科词条 DOI 预检：10.4135/978...nxxx / 10.4135/978...chxxx
      if (isLikelySageKnowledgeChapterDoi(payload.doi || payload.pdfUrl || '')) {
        return { ok: false, reason: 'detail_sage_knowledge_chapter' };
      }
      if (opts.watcherSkipRejected && flags.rejectedHistory) return { ok: false, reason: 'detail_rejected_history' };
      if (opts.watcherSkipReported && flags.reportedWarning) return { ok: false, reason: 'detail_reported_warning' };
      if (opts.watcherSkipRemark && payload.hasRemark) return { ok: false, reason: 'detail_remark' };
      if (opts.watcherSkipCorrigendum && payload.title && /^Corrigendum\s+to/i.test(String(payload.title).trim())) {
        return { ok: false, reason: 'detail_corrigendum' };
      }
      if (opts.watcherEnableBlacklist && payload.requesterId) {
        if (Array.isArray(blacklistedIds) && blacklistedIds.length > 0) {
          if (blacklistedIds.includes(payload.requesterId)) {
            return { ok: false, reason: 'detail_blacklist_user' };
          }
        } else if (opts.watcherBlacklistUserIds) {
          const blacklistRaw = opts.watcherBlacklistUserIds || '';
          const blacklist = blacklistRaw.split(/[^a-zA-Z0-9]+/).map(s => s.trim()).filter(Boolean);
          if (blacklist.includes(payload.requesterId)) {
            return { ok: false, reason: 'detail_blacklist_user' };
          }
        }
      }
      if (opts.watcherSkipRiskText && flags.systemPromptSupplementDoi) {
        return { ok: false, reason: 'detail_system_prompt_si' };
      }
      if (opts.watcherSkipRiskText && (flags.systemRisk || /特殊文件|指定版本|不是全文|网页即可阅读|CAJ|epub/i.test(textValue))) {
        return { ok: false, reason: 'detail_risk_text' };
      }
      return { ok: true };
    }

    function isRscPayload(payload) {
      let host = '';
      try { host = new URL(payload?.pdfUrl || 'https://invalid.local').hostname; } catch (_) {}
      return /(^|\.)pubs\.rsc\.org$/i.test(host) ||
        /\brsc\b|royal\s+society\s+of\s+chemistry/i.test([payload?.journalName, payload?.publisherName, payload?.pdfUrl].join(' '));
    }

    return {
      candidatePublisherName,
      normalizeDocumentType,
      normalizeJournalKey,
      journalRuleNames,
      candidateJournalNames,
      journalShortNameMapFromState,
      journalShortNameMapEntry,
      journalAccessStatsFromState,
      enrichCandidateJournalFromMap,
      rememberJournalShortNameMapping,
      recordJournalAccessBlocked,
      clearJournalAccessBlocked,
      isLikelyRscCandidate,
      describeWatcherReason,
      orderCandidatesForRun,
      parseAssistListPage,
      minSeekingGateForList,
      waitForAssistListDom,
      isListCandidateAllowed,
      isDetailAllowedForWatcher,
      isRscPayload
    };
  }

  globalThis.AblesciWatcherCandidateModule = {
    createWatcherCandidateApi
  };
}());
