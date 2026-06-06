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
      if (/书籍（章节）|书籍章节|book chapter|chapter/i.test(value)) return 'book_chapter';
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
      const shortName = normalizeText(candidate?.journalShortName || payload?.journalShortName || '');
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
        detail_corrigendum: '已按设置跳过 Corrigendum 更正类求助 (详情页)',
        detail_blacklist_user: '求助人 ID 处于黑名单中，已跳过',
        journal_blocked_rule: '命中本地期刊规则，列表页直接跳过'
      };
      return labels[code] ? `${code} - ${labels[code]}` : code;
    }

    function orderCandidatesForRun(candidates, state, opts = {}, count = 1) {
      return Array.isArray(candidates) ? candidates.slice() : [];
    }

    function parseAssistListPage() {
      function normalizeTextLocal(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
      }
      function normalizeDocumentTypeLocal(value) {
        const textValue = normalizeTextLocal(value);
        if (!textValue) return '';
        if (/补充材料|supporting information|supplement/i.test(textValue)) return 'supplement';
        if (/书籍（章节）|书籍章节|book chapter|chapter/i.test(textValue)) return 'book_chapter';
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
      const bodyText = text(document.body);
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
        const title = text(detailAnchor).replace(/^\[高分\]\s*/, '');
        const rowText = text(row);
        const detailUrl = absUrl(detailAnchor?.getAttribute('href') || detailAnchor?.href || '');
        const assistId = row.querySelector('.assist-id-val')?.value || new URLSearchParams(detailUrl.split('?')[1] || '').get('id') || '';
        const classText = [detailAnchor?.className || '', row.className || ''].join(' ');
        const statusText = text(row.querySelector('.assist-badge')) || text(handleAnchor);
        const publisherName = row.querySelector('.paper-publisher img[title]')?.getAttribute('title') || '';
        const journalShortName = Array.from(detailAnchor?.querySelectorAll('span[title]') || [])
          .filter(span => !span.classList?.contains('title-hint') && !span.closest?.('.paper-publisher'))
          .map(span => span.getAttribute('title') || text(span))
          .find(Boolean) || '';
        const typeText = text(row.querySelector('.layui-badge[title="文献类型"], .paper-type, .title-hint[title="Book Chapter"]'));
        const documentType = normalizeDocumentTypeLocal(typeText);
        const doi = doiFrom(rowText);
        return {
          assistId,
          detailUrl,
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
          sticky: /stick-assist|置顶/.test(classText + ' ' + rowText),
          index
        };
      }).filter(item => item.detailUrl);

      const debug = {
        readyState: document.readyState || '',
        title: document.title || '',
        rowCount: rows.length,
        detailLinkCount: document.querySelectorAll('a[href*="/assist/detail"]').length,
        publisherItemCount: document.querySelectorAll('.waiting-publisher-item').length,
        flyFilterCount: document.querySelectorAll('.fly-filter a').length,
        bodyLength: bodyText.length,
        loginLike: /登录|请先登录|login/i.test(bodyText)
      };

      return { cfChallenge: false, candidates: candidates.reverse(), listStats, debug };
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
        const detailLinkCount = document.querySelectorAll('a[href*="/assist/detail"]').length;
        const rowCount = document.querySelectorAll('ul.assist-list > li, .assist-list li').length;
        const publisherItemCount = document.querySelectorAll('.waiting-publisher-item').length;
        const flyFilterCount = document.querySelectorAll('.fly-filter a').length;
        const cfChallenge = /Cloudflare|Just a moment|请完成验证|验证你是真人|人机验证|安全检查/i.test(bodyText);
        return {
          ready,
          readyState: document.readyState || '',
          title: document.title || '',
          detailLinkCount,
          rowCount,
          publisherItemCount,
          flyFilterCount,
          cfChallenge,
          loginLike: /登录|请先登录|login/i.test(bodyText),
          bodyLength: bodyText.length
        };
      }
      function isReady() {
        const snap = snapshot(false);
        return snap.cfChallenge || snap.detailLinkCount > 0 || snap.rowCount > 0;
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

    function isListCandidateAllowed(candidate, opts) {
      const textValue = [candidate.rowText, candidate.title, candidate.statusText].join(' ');
      if (!candidate.detailUrl) return { ok: false, reason: 'missing_detail_url' };
      if (candidate.sticky) return { ok: false, reason: 'sticky_assist' };
      if (!/求助中|waiting|我要应助|可应助/i.test(textValue)) return { ok: false, reason: 'not_waiting' };
      if (opts.watcherSkipCorrigendum && candidate.title && /^Corrigendum\s+to/i.test(String(candidate.title).trim())) {
        return { ok: false, reason: 'list_corrigendum' };
      }
      return { ok: true };
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
      enrichCandidateJournalFromMap,
      rememberJournalShortNameMapping,
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
