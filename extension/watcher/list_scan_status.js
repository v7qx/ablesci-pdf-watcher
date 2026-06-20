'use strict';

// Responsibility: transient list-scan status shown in options/report diagnostics.
(function () {
  function createWatcherListScanStatusApi(config = {}) {
    const {
      chromeApi = typeof chrome !== 'undefined' ? chrome : null,
      getWatcherState,
      saveWatcherStateSafe
    } = config;

    const CURRENT_PAGE_DATA_KEY = 'autoWatcherCurrentPageData';

    function listUrlWithPage(listUrl, page) {
      if (!Number.isFinite(Number(page))) return listUrl;
      try {
        const u = new URL(listUrl);
        u.searchParams.set('page', String(Number(page)));
        return u.toString();
      } catch (_) {
        return listUrl;
      }
    }

    function normalizeParsedListCandidateContext(parsed, pagePick, pickedListUrl) {
      const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const auditPage = Number.isFinite(Number(parsed?.listStats?.currentPage))
        ? Number(parsed.listStats.currentPage)
        : pagePick.pickedPage;
      const auditListUrl = listUrlWithPage(pickedListUrl, auditPage);
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        candidate.listUrl = auditListUrl;
        candidate.page = auditPage;
        candidate.pageOrder = pagePick.pageOrder || candidate.pageOrder || '';
        candidate.pageMax = parsed?.listStats?.maxPage || pagePick.pageMax || candidate.pageMax || '';
        candidate.urlKey = pagePick.urlKey || candidate.urlKey || '';
      }
    }

    function buildCurrentListScan(details = {}) {
      const {
        pagePick = {},
        trigger = '',
        listUrl = '',
        pickedListUrl = '',
        scanIndex = '',
        scanLimit = '',
        mode = 'background_fetch',
        phase = '',
        status = 'running',
        reason = '',
        candidateCount = '',
        queueableCount = '',
        assistId = ''
      } = details;
      return {
        mode,
        phase,
        status,
        reason,
        trigger,
        configuredUrl: listUrl,
        pickedListUrl,
        urlKey: pagePick.urlKey || '',
        publisher: pagePick.publisher || '',
        page: pagePick.pickedPage || '',
        pageOrder: pagePick.pageOrder || '',
        pageMin: pagePick.pageMin || '',
        pageMax: pagePick.pageMax || '',
        range: '',
        scanIndex,
        scanLimit,
        candidateCount,
        queueableCount,
        assistId,
        updatedAt: new Date().toISOString()
      };
    }

    function describeCurrentListScan(scan = {}) {
      if (!scan || typeof scan !== 'object') return '';
      const publisher = scan.publisher ? String(scan.publisher).toUpperCase() : '';
      const page = scan.page ? `第 ${scan.page} 页` : '';
      const mode = '随机页';
      const phaseMap = {
        start: '启动',
        source_selected: '选源',
        page_selected: '选页',
        parsing_list: '解析列表',
        filtering_candidates: '筛候选',
        trying_candidate: '打开详情',
        downloading: '下载/上传',
        finalizing: '写报告',
        done: '已完成'
      };
      const phase = phaseMap[scan.phase] || '';
      const counts = scan.queueableCount !== '' && scan.queueableCount != null
        ? `可处理 ${scan.queueableCount}/${scan.candidateCount || '?'}`
        : '';
      const assist = scan.assistId ? `ID ${scan.assistId}` : '';
      const result = scan.status && scan.status !== 'running' && scan.reason ? String(scan.reason) : '';
      return [phase || mode, publisher, page, counts, assist, result].filter(Boolean).join(' ');
    }

    async function clearCurrentListScan() {
      try {
        const state = await getWatcherState();
        if (!state.currentListScan) return;
        state.currentListScan = null;
        await saveWatcherStateSafe(state);
      } catch (_) {}
    }

    async function setCurrentListScan(scan = {}) {
      try {
        const state = await getWatcherState();
        state.currentListScan = {
          ...(scan && typeof scan === 'object' ? scan : {}),
          updatedAt: new Date().toISOString()
        };
        await saveWatcherStateSafe(state);
      } catch (_) {}
    }

    async function initCurrentPageData(pickedListUrl, pagePick, parsed) {
      try {
        const storedPageData = (await chromeApi.storage.local.get(CURRENT_PAGE_DATA_KEY))[CURRENT_PAGE_DATA_KEY];
        if (!storedPageData || storedPageData.url !== pickedListUrl) {
          const initialCandidates = (parsed.candidates || []).slice().reverse().map(c => ({
            assistId: String(c.assistId || ''),
            doi: c.doi || '',
            detailUrl: c.detailUrl || '',
            status: 'pending',
            reason: '',
            time: 0
          }));
          await chromeApi.storage.local.set({
            [CURRENT_PAGE_DATA_KEY]: {
              page: pagePick.pickedPage,
              url: pickedListUrl,
              order: pagePick.pageOrder,
              candidates: initialCandidates
            }
          });
          return;
        }

        let updated = false;
        const pageData = storedPageData;
        if (!Array.isArray(pageData.candidates)) return;

        const oldMap = new Map();
        for (const cand of pageData.candidates) {
          delete cand.title;
          oldMap.set(String(cand.assistId), cand);
        }

        const latestCandidatesOrdered = (parsed.candidates || []).slice().reverse();
        const orderedCandidates = [];

        for (const c of latestCandidatesOrdered) {
          const cid = String(c.assistId || '');
          if (!cid) continue;
          if (oldMap.has(cid)) {
            orderedCandidates.push(oldMap.get(cid));
            oldMap.delete(cid);
          } else {
            orderedCandidates.push({
              assistId: cid,
              doi: c.doi || '',
              detailUrl: c.detailUrl || '',
              status: 'pending',
              reason: '',
              time: 0
            });
            updated = true;
          }
        }

        for (const cand of oldMap.values()) {
          if (cand.status === 'pending' || cand.status === 'processing') {
            cand.status = 'closed';
            cand.reason = 'assist_closed_or_resolved';
            cand.time = Date.now();
          }
          orderedCandidates.push(cand);
          updated = true;
        }

        if (updated || orderedCandidates.length !== pageData.candidates.length) {
          pageData.candidates = orderedCandidates;
          await chromeApi.storage.local.set({ [CURRENT_PAGE_DATA_KEY]: pageData });
        }
      } catch (err) {
        console.warn('[initCurrentPageData] failed', err);
      }
    }

    async function updateCurrentPageCandidateStatus(assistId, status, reason) {
      try {
        const stored = await chromeApi.storage.local.get(CURRENT_PAGE_DATA_KEY);
        const pageData = stored[CURRENT_PAGE_DATA_KEY];
        if (!pageData || !Array.isArray(pageData.candidates)) return;
        let updated = false;
        const assistIdStr = String(assistId || '');
        for (const cand of pageData.candidates) {
          if (String(cand.assistId) === assistIdStr) {
            cand.status = status;
            cand.reason = reason;
            cand.time = Date.now();
            updated = true;
          }
        }
        if (updated) {
          await chromeApi.storage.local.set({ [CURRENT_PAGE_DATA_KEY]: pageData });
        }
      } catch (err) {
        console.warn('[updateCurrentPageCandidateStatus] failed', err);
      }
    }

    return {
      normalizeParsedListCandidateContext,
      buildCurrentListScan,
      describeCurrentListScan,
      clearCurrentListScan,
      setCurrentListScan,
      initCurrentPageData,
      updateCurrentPageCandidateStatus
    };
  }

  globalThis.AblesciWatcherListScanStatusModule = {
    createWatcherListScanStatusApi
  };
})();
