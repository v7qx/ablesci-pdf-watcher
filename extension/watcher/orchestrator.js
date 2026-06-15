'use strict';

// Responsibility: top-level auto watcher run orchestration without changing scheduling behavior.
(function () {
  function createWatcherOrchestratorApi(config) {
    const {
      depsRef,
      stateRef,
      normalizeOptions,
      recordRunStart,
      getWatcherState,
      saveWatcherState,
      dailyCounterSnapshot,
      todayKey,
      monthDone,
      appendWatcherTrace,
      recordCfChallenge,
      isInWorkSchedule,
      formatBeijingDateTime,
      resetCfChallengeStreak,
      isAssistDue,
      checkShortTermRateLimit,
      calculateAdvancedTargetState,
      calculateTargetState,
      mergeFrozenTargetState,
      getDailyCount,
      sessionExecutionCap,
      riskSnapshot,
      sessionSize,
      maxSessionCandidates,
      dailyDownloadedFromState,
      saveWatcherStateSafe,
      listUrlsForRun,
      randomizeAssistListUrlWithMeta,
      incrementDaily,
      parseListUrl,
      minSeekingGateForList,
      orderCandidatesForRun,
      enrichCandidateJournalFromMap,
      isListCandidateAllowed,
      describeWatcherReason,
      wasRecentlyProcessed,
      inspectDetail,
      closeTabQuietly,
      updateProcessed,
      appendWatcherLog,
      getProcessedKey,
      isDetailAllowedForWatcher,
      handleAllowedPayload,
      recordRunFinish,
      scheduleNextAssistAfterRun,
      refreshAlarmAfterRun,
      recordAttemptFinish,
      writeDailyReports,
      flushWatcherLogs,
      flushWatcherTrace,
      enqueueParsedCandidates,
      queuedCandidatesSnapshot,
      removeQueuedCandidate,
      shouldSkipBackedOffPage,
      stateWithQueueRefillCursor
    } = config;

    function sourceKeyFromUrl(url = '') {
      try {
        const u = new URL(url);
        const publisher = String(u.searchParams.get('publisher') || '').trim().toLowerCase();
        if (publisher) return publisher;
      } catch (_) {}
      const text = String(url || '').toLowerCase();
      if (/sciencedirect|elsevier/.test(text)) return 'elsevier';
      if (/ieee/.test(text)) return 'ieee';
      if (/\brsc\b|royal\s+society\s+of\s+chemistry/.test(text)) return 'rsc';
      if (/wiley/.test(text)) return 'wiley';
      if (/springer/.test(text)) return 'springer';
      if (/sage/.test(text)) return 'sage';
      if (/\bacs\b/.test(text)) return 'acs';
      return text.slice(0, 80) || 'unknown';
    }

    function isHighFreqSourceKey(key = '') {
      return /sciencedirect|elsevier/i.test(String(key || ''));
    }

    function sourceKeyFromCandidate(candidate = {}, pagePick = {}) {
      return sourceKeyFromUrl(candidate.listUrl || pagePick.configuredUrl || pagePick.pickedListUrl || '');
    }

    const CANDIDATE_AUDIT_KEY = 'autoWatcherCandidateAudit';
    const CANDIDATE_AUDIT_INDEX_KEY = 'autoWatcherCandidateAuditIndex';
    const CANDIDATE_AUDIT_LIMIT = 20000;
    const CANDIDATE_AUDIT_INDEX_LIMIT = 50000;
    const CANDIDATE_AUDIT_RECENT_EVENTS_LIMIT = 8;
    const MIDPOINT_RESCAN_WINDOW = 10;
    const RUNNING_LOCK_STALE_MS = 20 * 60 * 1000;

    function safeAuditText(value, limit = 500) {
      return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
    }

    function auditNumberOrEmpty(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : '';
    }

    function buildCandidateAuditEntry(phase, candidate = {}, extra = {}) {
      const assistId = safeAuditText(candidate.assistId || extra.assistId || '', 80);
      const detailUrl = safeAuditText(
        candidate.detailUrl || extra.detailUrl || (assistId ? `https://www.ablesci.com/assist/detail?id=${assistId}` : ''),
        500
      );
      return {
        time: extra.time || new Date().toISOString(),
        phase: safeAuditText(phase, 80),
        status: safeAuditText(extra.status || '', 80),
        reason: safeAuditText(extra.reason || '', 240),
        trigger: safeAuditText(extra.trigger || '', 80),
        assistId,
        title: safeAuditText(candidate.title || extra.title || '', 240),
        doi: safeAuditText(candidate.doi || extra.doi || '', 160),
        journalShortName: safeAuditText(candidate.journalShortName || extra.journalShortName || '', 160),
        journalName: safeAuditText(candidate.journalName || extra.journalName || '', 240),
        publisherName: safeAuditText(candidate.publisherName || extra.publisherName || extra.publisher || '', 160),
        detailUrl,
        listUrl: safeAuditText(candidate.listUrl || extra.listUrl || extra.pickedListUrl || '', 500),
        page: auditNumberOrEmpty(extra.page ?? extra.pickedPage ?? candidate.page),
        pageOrder: safeAuditText(extra.pageOrder || candidate.pageOrder || '', 20),
        pageMax: auditNumberOrEmpty(extra.pageMax ?? candidate.pageMax),
        urlKey: safeAuditText(extra.urlKey || candidate.urlKey || '', 240),
        listIndex: auditNumberOrEmpty(extra.listIndex ?? candidate.index),
        assistTimeText: safeAuditText(candidate.assistTimeText || extra.assistTimeText || '', 80),
        assistAgeSeconds: auditNumberOrEmpty(candidate.assistAgeSeconds ?? extra.assistAgeSeconds),
        source: safeAuditText(extra.source || '', 80),
        tabId: safeAuditText(extra.tabId || '', 40),
        details: extra.details && typeof extra.details === 'object' ? extra.details : {}
      };
    }

    async function appendCandidateAuditEntries(entries = []) {
      const batch = (Array.isArray(entries) ? entries : []).filter(entry => entry && entry.assistId);
      if (batch.length <= 0) return;
      try {
        const storage = (typeof chrome !== 'undefined' ? chrome : browser).storage.local;
        const stored = await storage.get([CANDIDATE_AUDIT_KEY, CANDIDATE_AUDIT_INDEX_KEY]);
        const current = Array.isArray(stored[CANDIDATE_AUDIT_KEY]) ? stored[CANDIDATE_AUDIT_KEY] : [];
        const currentIndex = stored[CANDIDATE_AUDIT_INDEX_KEY] && typeof stored[CANDIDATE_AUDIT_INDEX_KEY] === 'object' && !Array.isArray(stored[CANDIDATE_AUDIT_INDEX_KEY])
          ? stored[CANDIDATE_AUDIT_INDEX_KEY]
          : {};
        await storage.set({
          [CANDIDATE_AUDIT_KEY]: batch.concat(current).slice(0, CANDIDATE_AUDIT_LIMIT),
          [CANDIDATE_AUDIT_INDEX_KEY]: updateCandidateAuditIndex(currentIndex, batch)
        });
      } catch (err) {
        console.warn('[candidateAudit] failed', err);
      }
    }

    function auditEventSignature(entry = {}) {
      return [
        entry.phase || '',
        entry.status || '',
        entry.reason || '',
        entry.page ?? '',
        entry.listIndex ?? ''
      ].join('|');
    }

    function compactAuditEvent(entry = {}) {
      return {
        time: entry.time || new Date().toISOString(),
        phase: entry.phase || '',
        status: entry.status || '',
        reason: entry.reason || '',
        page: entry.page ?? '',
        listIndex: entry.listIndex ?? ''
      };
    }

    function updateCandidateAuditIndex(index, batch) {
      const next = { ...(index || {}) };
      for (const entry of batch) {
        const assistId = safeAuditText(entry.assistId || '', 80);
        if (!assistId) continue;
        const prev = next[assistId] && typeof next[assistId] === 'object' ? next[assistId] : {};
        const recentEvents = Array.isArray(prev.recentEvents) ? prev.recentEvents.slice() : [];
        const event = compactAuditEvent(entry);
        const lastEvent = recentEvents[recentEvents.length - 1] || null;
        if (!lastEvent || auditEventSignature(lastEvent) !== auditEventSignature(event)) {
          recentEvents.push(event);
        } else {
          recentEvents[recentEvents.length - 1] = event;
        }
        const pages = Array.isArray(prev.pages) ? prev.pages.slice() : [];
        const pageValue = Number(entry.page);
        if (Number.isFinite(pageValue) && !pages.includes(pageValue)) pages.push(pageValue);
        next[assistId] = {
          assistId,
          firstSeenAt: prev.firstSeenAt || entry.time || new Date().toISOString(),
          lastAt: entry.time || prev.lastAt || new Date().toISOString(),
          eventCount: Number(prev.eventCount || 0) + 1,
          latestPhase: entry.phase || prev.latestPhase || '',
          latestStatus: entry.status || prev.latestStatus || '',
          latestReason: entry.reason || prev.latestReason || '',
          title: safeAuditText(entry.title || prev.title || '', 240),
          journalShortName: safeAuditText(entry.journalShortName || prev.journalShortName || '', 160),
          publisherName: safeAuditText(entry.publisherName || prev.publisherName || '', 160),
          doi: safeAuditText(entry.doi || prev.doi || '', 160),
          assistTimeText: safeAuditText(entry.assistTimeText || prev.assistTimeText || '', 80),
          detailUrl: safeAuditText(entry.detailUrl || prev.detailUrl || '', 500),
          firstListUrl: safeAuditText(prev.firstListUrl || entry.listUrl || '', 500),
          lastListUrl: safeAuditText(entry.listUrl || prev.lastListUrl || '', 500),
          firstPage: prev.firstPage || entry.page || '',
          lastPage: entry.page || prev.lastPage || '',
          lastListIndex: entry.listIndex ?? prev.lastListIndex ?? '',
          pages: pages.slice(-20),
          recentEvents: recentEvents.slice(-CANDIDATE_AUDIT_RECENT_EVENTS_LIMIT)
        };
      }
      const entries = Object.entries(next);
      if (entries.length <= CANDIDATE_AUDIT_INDEX_LIMIT) return next;
      entries.sort((a, b) => new Date(b[1]?.lastAt || 0).getTime() - new Date(a[1]?.lastAt || 0).getTime());
      return Object.fromEntries(entries.slice(0, CANDIDATE_AUDIT_INDEX_LIMIT));
    }

    function listUrlWithAuditPage(listUrl, page) {
      if (!Number.isFinite(Number(page))) return listUrl;
      try {
        const u = new URL(listUrl);
        u.searchParams.set('page', String(Number(page)));
        return u.toString();
      } catch (_) {
        return listUrl;
      }
    }

    async function auditParsedListCandidates(parsed, pagePick, pickedListUrl, trigger, reason = 'parsed_from_list') {
      const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const auditPage = Number.isFinite(Number(parsed?.listStats?.currentPage))
        ? Number(parsed.listStats.currentPage)
        : pagePick.pickedPage;
      const auditListUrl = listUrlWithAuditPage(pickedListUrl, auditPage);
      await appendCandidateAuditEntries(candidates.map((candidate, index) => buildCandidateAuditEntry('list_seen', candidate, {
        status: 'seen',
        reason,
        trigger,
        listUrl: auditListUrl,
        page: auditPage,
        pageOrder: pagePick.pageOrder,
        pageMax: parsed?.listStats?.maxPage || pagePick.pageMax,
        urlKey: pagePick.urlKey,
        publisher: pagePick.publisher,
        listIndex: candidate.index ?? index,
        source: 'list_page',
        details: Number(pagePick.pickedPage) !== Number(auditPage)
          ? { requestedPage: pagePick.pickedPage }
          : {}
      })));
    }

    async function auditEnqueueResult(enqueueResult, pagePick, pickedListUrl, trigger, source = 'candidate_queue') {
      const enqueueAuditRows = [];
      for (const item of enqueueResult.addedExamples || []) {
        enqueueAuditRows.push(buildCandidateAuditEntry('queue_added', item, {
          status: 'queued',
          reason: 'queue_added',
          trigger,
          listUrl: item.listUrl || pickedListUrl,
          page: item.page || pagePick.pickedPage,
          pageOrder: item.pageOrder || pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source
        }));
      }
      for (const item of enqueueResult.refreshedExamples || []) {
        enqueueAuditRows.push(buildCandidateAuditEntry('queue_refreshed', item, {
          status: 'queued',
          reason: 'queue_refreshed',
          trigger,
          listUrl: item.listUrl || pickedListUrl,
          page: item.page || pagePick.pickedPage,
          pageOrder: item.pageOrder || pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source
        }));
      }
      for (const item of enqueueResult.seenSkippedExamples || []) {
        enqueueAuditRows.push(buildCandidateAuditEntry('queue_seen_skip', item, {
          status: 'skipped',
          reason: 'seen_before',
          trigger,
          listUrl: item.listUrl || pickedListUrl,
          page: item.page || pagePick.pickedPage,
          pageOrder: item.pageOrder || pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source
        }));
      }
      await appendCandidateAuditEntries(enqueueAuditRows);
    }

    function normalizeParsedListCandidateContext(parsed, pagePick, pickedListUrl) {
      const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
      const auditPage = Number.isFinite(Number(parsed?.listStats?.currentPage))
        ? Number(parsed.listStats.currentPage)
        : pagePick.pickedPage;
      const auditListUrl = listUrlWithAuditPage(pickedListUrl, auditPage);
      for (const candidate of candidates) {
        if (!candidate || typeof candidate !== 'object') continue;
        candidate.listUrl = auditListUrl;
        candidate.page = auditPage;
        candidate.pageOrder = pagePick.pageOrder || candidate.pageOrder || '';
        candidate.pageMax = parsed?.listStats?.maxPage || pagePick.pageMax || candidate.pageMax || '';
        candidate.urlKey = pagePick.urlKey || candidate.urlKey || '';
      }
    }

    function sourceDetailAttemptBudget(listUrl, sourceCount) {
      if (sourceCount <= 1) return 5;
      return isHighFreqSourceKey(sourceKeyFromUrl(listUrl)) ? 4 : 2;
    }

    function describeCurrentListScan(scan = {}) {
      if (!scan || typeof scan !== 'object') return '';
      const publisher = scan.publisher ? String(scan.publisher).toUpperCase() : '';
      const page = scan.page ? `第 ${scan.page} 页` : '';
      const range = scan.range ? `范围 ${scan.range}` : '';
      const mode = scan.mode === 'midpoint_rescan' ? '半程重扫' : '后台拉取';
      return [mode, publisher, page, range].filter(Boolean).join(' ');
    }

    async function saveCurrentListScan(stateForTargets, details = {}) {
      const scan = {
        ...details,
        updatedAt: new Date().toISOString()
      };
      stateForTargets.currentListScan = scan;
      await saveWatcherStateSafe(stateForTargets);
    }

    async function clearCurrentListScan() {
      try {
        const state = await getWatcherState();
        if (!state.currentListScan) return;
        state.currentListScan = null;
        await saveWatcherStateSafe(state);
      } catch (_) {}
    }

    function rotateRecentSource(urls = [], state = {}) {
      const lastKey = String(state.lastHandledPublisherKey || '').toLowerCase();
      if (!lastKey || urls.length <= 1) return urls;
      const firstKey = sourceKeyFromUrl(urls[0]);
      if (firstKey !== lastKey) return urls;
      const replacementIndex = urls.findIndex((url, index) => {
        if (index === 0) return false;
        const key = sourceKeyFromUrl(url);
        return key !== lastKey;
      });
      if (replacementIndex < 0) return urls;
      const copy = urls.slice();
      const [replacement] = copy.splice(replacementIndex, 1);
      copy.unshift(replacement);
      return copy;
    }

    async function syncActualAssistCount(state, opts) {
      const now = Date.now();
      const lastSynced = state.lastAssistCountSyncedAt ? new Date(state.lastAssistCountSyncedAt).getTime() : 0;
      if (Number.isFinite(lastSynced) && now - lastSynced < 15 * 60 * 1000) {
        return;
      }
      try {
        const res = await fetch('https://www.ablesci.com/my/home');
        if (!res.ok) return;
        const html = await res.text();
        const match = html.match(/最近应助[^\d]*(\d+)/);
        if (match) {
          const totalCount = parseInt(match[1], 10);
          const currentMonth = todayKey().slice(0, 7);
          state.firstSyncTotalAssists = state.firstSyncTotalAssists || {};
          state.firstSyncProgressRatio = state.firstSyncProgressRatio || {};
          if (state.firstSyncTotalAssists[currentMonth] === undefined) {
            state.firstSyncTotalAssists[currentMonth] = totalCount;
            // Calculate progress ratio at first sync (no calendar-progress truncation in the first week)
            let ratio = 0;
            const dayOfMonth = parseInt(todayKey().slice(8, 10), 10);
            if (dayOfMonth > 7) {
              const year = new Date(now).getFullYear();
              const month = new Date(now).getMonth();
              const startOfMonth = new Date(year, month, 1).getTime();
              const startOfNextMonth = new Date(year, month + 1, 1).getTime();
              const totalMonthMs = startOfNextMonth - startOfMonth;
              const currentMs = now - startOfMonth;
              ratio = totalMonthMs > 0 ? Math.max(0, Math.min(1, currentMs / totalMonthMs)) : 0;
            }
            state.firstSyncProgressRatio[currentMonth] = ratio;
          }

          state.monthlyInitialAssists = state.monthlyInitialAssists || {};
          if (state.monthlyInitialAssists[currentMonth] === undefined) {
            state.monthlyInitialAssists[currentMonth] = totalCount;
          }
          state.actualTotalAssists = totalCount;
          state.lastAssistCountSyncedAt = new Date().toISOString();
          await saveWatcherStateSafe(state);
          await appendWatcherTrace('sync_web_assist_count', {
            totalCount,
            currentMonth,
            firstSyncTotal: state.firstSyncTotalAssists[currentMonth],
            firstSyncRatio: state.firstSyncProgressRatio[currentMonth],
            initialCount: state.monthlyInitialAssists[currentMonth]
          });
        }
      } catch (err) {
        console.warn('[Ablesci Watcher] Failed to sync actual assist count:', err);
      }
    }

    async function initCurrentPageData(pickedListUrl, pagePick, parsed) {
      try {
        const chromeApi = typeof chrome !== 'undefined' ? chrome : browser;
        const currentPageKey = 'autoWatcherCurrentPageData';
        const storedPageData = (await chromeApi.storage.local.get(currentPageKey))[currentPageKey];
        const latestIds = new Set((parsed.candidates || []).map(c => String(c.assistId || '')));

        if (!storedPageData || storedPageData.url !== pickedListUrl) {
          const initialCandidates = (parsed.candidates || []).slice().reverse().map(c => ({
            assistId: String(c.assistId || ''),
            title: c.title || '',
            doi: c.doi || '',
            detailUrl: c.detailUrl || '',
            status: 'pending',
            reason: '',
            time: 0
          }));
          await chromeApi.storage.local.set({
            [currentPageKey]: {
              page: pagePick.pickedPage,
              url: pickedListUrl,
              order: pagePick.pageOrder,
              candidates: initialCandidates
            }
          });
        } else {
          let updated = false;
          const pageData = storedPageData;
          if (Array.isArray(pageData.candidates)) {
            const oldMap = new Map();
            for (const cand of pageData.candidates) {
              oldMap.set(String(cand.assistId), cand);
            }

            const latestCandidatesOrdered = (parsed.candidates || []).slice().reverse();
            const orderedCandidates = [];

            // 1. 遍历最新在线列表候选（保证其从上到下的物理顺序与网页100%一致）
            for (const c of latestCandidatesOrdered) {
              const cid = String(c.assistId || '');
              if (!cid) continue;

              if (oldMap.has(cid)) {
                orderedCandidates.push(oldMap.get(cid));
                oldMap.delete(cid);
              } else {
                orderedCandidates.push({
                  assistId: cid,
                  title: c.title || '',
                  doi: c.doi || '',
                  detailUrl: c.detailUrl || '',
                  status: 'pending',
                  reason: '',
                  time: 0
                });
                updated = true;
              }
            }

            // 2. Map 中剩下的是消失的候选（已被他人完成、机器人关闭，或之前成功/失败而消失的）
            if (oldMap.size > 0) {
              for (const [cid, cand] of oldMap.entries()) {
                if (cand.status === 'pending' || cand.status === 'processing') {
                  cand.status = 'closed';
                  cand.reason = 'assist_closed_or_resolved';
                  cand.time = Date.now();
                }
                orderedCandidates.push(cand);
                updated = true;
              }
            }

            if (updated || orderedCandidates.length !== pageData.candidates.length) {
              pageData.candidates = orderedCandidates;
              await chromeApi.storage.local.set({ [currentPageKey]: pageData });
            }
          }
        }
      } catch (err) {
        console.warn('[initCurrentPageData] failed', err);
      }
    }

    async function updateCurrentPageCandidateStatus(assistId, status, reason) {
      try {
        const chromeApi = typeof chrome !== 'undefined' ? chrome : browser;
        const key = 'autoWatcherCurrentPageData';
        const stored = await chromeApi.storage.local.get(key);
        const pageData = stored[key];
        if (pageData && Array.isArray(pageData.candidates)) {
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
            await chromeApi.storage.local.set({ [key]: pageData });
          }
        }
      } catch (err) {
        console.warn('[updateCurrentPageCandidateStatus] failed', err);
      }
    }

    async function readBlacklistedIds(opts, trigger) {
      const blacklistedIds = [];
      if (!opts.watcherEnableBlacklist) return blacklistedIds;
      try {
        const res = await depsRef.sendNativeMessage(opts.nativeHostName, {
          action: 'read_text_file',
          path: opts.watcherBlacklistPath || '',
          extra: {
            perf_category: opts.watcherBlacklistPath ? 'blacklist_custom' : 'blacklist_default'
          }
        });
        if (res && res.ok && res.body) {
          const lines = res.body.split(/\r?\n/);
          for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#') || line.startsWith('//')) continue;
            const commentIdx = line.indexOf('#') >= 0 ? line.indexOf('#') : (line.indexOf('//') >= 0 ? line.indexOf('//') : -1);
            if (commentIdx >= 0) line = line.substring(0, commentIdx).trim();
            const parts = line.split(/[\s,，]+/).map(p => p.trim()).filter(Boolean);
            blacklistedIds.push(...parts);
          }
        }
      } catch (err) {
        console.error('[Blacklist] failed to read blacklist file in auto watcher:', err);
        await appendWatcherTrace('blacklist_read_error_ignored', {
          reason: 'blacklist_read_error_ignored',
          trigger,
          error: err.message || String(err)
        });
      }
      return blacklistedIds;
    }

    async function appendJournalBlockedSummary(summary, trigger) {
      if (!summary || summary.count <= 0) return;
      const examples = Array.from(summary.examples || []).slice(0, 5);
      const journals = Array.from(summary.journals || []).slice(0, 5);
      await appendWatcherLog({
        trigger,
        status: 'skipped',
        reason: 'journal_blocked_rule_summary',
        journalName: `命中本地期刊规则 ${summary.count} 条；示例 ID: ${examples.join(', ') || '-'}；期刊: ${journals.join(', ') || '-'}`,
        page: summary.page || ''
      });
    }

    async function queueableCandidatesFromList(candidates, opts, trigger, pagePick, blacklistedIds = []) {
      const stateForListFilter = await getWatcherState();
      const queueable = [];
      const auditEntries = [];
      const journalBlockedSummary = { count: 0, examples: new Set(), journals: new Set(), page: pagePick.pickedPage || '' };
      for (const rawCandidate of Array.isArray(candidates) ? candidates : []) {
        const candidate = enrichCandidateJournalFromMap(rawCandidate, stateForListFilter);
        const listAllowed = isListCandidateAllowed(candidate, opts, stateForListFilter, blacklistedIds);
        if (listAllowed.ok) {
          queueable.push(candidate);
          auditEntries.push(buildCandidateAuditEntry('list_queueable', candidate, {
            status: 'queueable',
            reason: 'passed_list_filter',
            trigger,
            page: pagePick.pickedPage,
            pageOrder: pagePick.pageOrder,
            pageMax: pagePick.pageMax,
            urlKey: pagePick.urlKey,
            publisher: pagePick.publisher,
            source: 'list_page_refill'
          }));
          continue;
        }
        await appendWatcherTrace('candidate_skip_list_filter', {
          reason: listAllowed.reason,
          reasonText: describeWatcherReason(listAllowed.reason),
          trigger,
          detailUrl: candidate.detailUrl,
          assistId: candidate.assistId || '',
          title: candidate.title || '',
          journalShortName: candidate.journalShortName || '',
          assistTimeText: candidate.assistTimeText || '',
          assistAgeSeconds: candidate.assistAgeSeconds ?? '',
          journalAccess: listAllowed.journalAccess || null,
          source: 'list_page_refill'
        });
        if (listAllowed.reason === 'journal_blocked_rule') {
          journalBlockedSummary.count += 1;
          if (candidate.assistId) journalBlockedSummary.examples.add(candidate.assistId);
          const shortName = listAllowed.journalAccess?.shortName || candidate.journalShortName || '';
          if (shortName) journalBlockedSummary.journals.add(shortName);
        }
        auditEntries.push(buildCandidateAuditEntry('list_skip', candidate, {
          status: 'skipped',
          reason: listAllowed.reason,
          trigger,
          page: pagePick.pickedPage,
          pageOrder: pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source: 'list_page_refill',
          details: {
            reasonText: describeWatcherReason(listAllowed.reason),
            journalAccess: listAllowed.journalAccess || null
          }
        }));
        await updateCurrentPageCandidateStatus(candidate.assistId, 'skipped', listAllowed.reason);
      }
      await appendCandidateAuditEntries(auditEntries);
      await appendJournalBlockedSummary(journalBlockedSummary, trigger);
      return queueable;
    }

    function shouldRunMidpointRescan(pagePick, stateForTargets, detectedMaxPage) {
      const maxPage = Number(detectedMaxPage || pagePick.pageMax || 0);
      const pickedPage = Number(pagePick.pickedPage);
      if (pagePick.pageOrder !== 'desc') return false;
      if (!pagePick.urlKey) return false;
      if (!Number.isFinite(maxPage) || maxPage <= 1) return false;
      if (!Number.isFinite(pickedPage) || pickedPage <= 0) return false;
      if (pickedPage > Math.floor(maxPage / 2)) return false;
      const done = stateForTargets.midpointRescans?.[pagePick.urlKey];
      return Number(done?.maxPage || 0) !== maxPage;
    }

    async function runMidpointRescanIfDue({
      listUrl,
      pagePick,
      detectedMaxPage,
      stateForTargets,
      opts,
      trigger,
      blacklistedIds
    }) {
      const maxPage = Number(detectedMaxPage || pagePick.pageMax || 0);
      if (!shouldRunMidpointRescan(pagePick, stateForTargets, maxPage)) {
        return { ran: false };
      }

      const originalLastVisited = stateForTargets.lastVisitedPages?.[pagePick.urlKey];
      const endPage = Math.max(1, maxPage - MIDPOINT_RESCAN_WINDOW + 1);
      let scannedPages = 0;
      let added = 0;
      let refreshed = 0;
      let seenSkipped = 0;
      let parsedCount = 0;
      let abortedReason = '';

      await appendWatcherTrace('midpoint_rescan_start', {
        reason: 'desc_cursor_reached_half',
        trigger,
        configuredUrl: listUrl,
        urlKey: pagePick.urlKey,
        currentPage: pagePick.pickedPage,
        maxPage,
        window: MIDPOINT_RESCAN_WINDOW,
        startPage: maxPage,
        endPage
      });
      await saveCurrentListScan(stateForTargets, {
        mode: 'midpoint_rescan',
        trigger,
        configuredUrl: listUrl,
        urlKey: pagePick.urlKey,
        publisher: pagePick.publisher || '',
        page: maxPage,
        pageOrder: 'desc',
        pageMin: endPage,
        pageMax: maxPage,
        range: `${maxPage}-${endPage}`,
        window: MIDPOINT_RESCAN_WINDOW
      });

      for (let page = maxPage; page >= endPage; page -= 1) {
        const rescanListUrl = listUrlWithAuditPage(listUrl, page);
        const rescanPick = {
          ...pagePick,
          pickedListUrl: rescanListUrl,
          pickedPage: page,
          pageMax: maxPage,
          pageOrder: 'desc',
          skipCursorUpdate: true
        };
        await saveCurrentListScan(stateForTargets, {
          mode: 'midpoint_rescan',
          trigger,
          configuredUrl: listUrl,
          pickedListUrl: rescanListUrl,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher || '',
          page,
          pageOrder: 'desc',
          pageMin: endPage,
          pageMax: maxPage,
          range: `${maxPage}-${endPage}`,
          window: MIDPOINT_RESCAN_WINDOW
        });
        if (await shouldSkipBackedOffPage(rescanPick)) {
          await appendWatcherTrace('midpoint_rescan_page_backoff', {
            reason: 'page_backoff_active',
            trigger,
            listUrl: rescanListUrl,
            urlKey: pagePick.urlKey,
            pickedPage: page,
            maxPage
          });
          continue;
        }

        await incrementDaily('checked', trigger);
        const parseStartedAt = Date.now();
        const parsed = await parseListUrl(rescanListUrl);
        await appendWatcherTrace('perf_midpoint_rescan_parse', {
          reason: 'midpoint_rescan_parse_done',
          trigger,
          durationMs: Date.now() - parseStartedAt,
          pickedPage: page,
          urlKey: pagePick.urlKey,
          parsedCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
          maxPage: parsed?.listStats?.maxPage || maxPage
        });

        if (parsed?.isErrorPage) {
          abortedReason = 'site_error';
          await appendWatcherTrace('midpoint_rescan_aborted', {
            reason: abortedReason,
            trigger,
            listUrl: rescanListUrl,
            pickedPage: page,
            errorTitle: parsed.errorTitle || ''
          });
          break;
        }
        if (parsed?.cfChallenge) {
          abortedReason = 'cf_challenge';
          await appendWatcherTrace('midpoint_rescan_aborted', {
            reason: abortedReason,
            trigger,
            listUrl: rescanListUrl,
            pickedPage: page
          });
          break;
        }

        normalizeParsedListCandidateContext(parsed, rescanPick, rescanListUrl);
        await auditParsedListCandidates(parsed, rescanPick, rescanListUrl, trigger, 'midpoint_rescan_seen');
        const sourceGate = minSeekingGateForList(parsed, rescanListUrl, rescanPick.publisher, opts);
        if (!sourceGate.ok) {
          await appendWatcherTrace('midpoint_rescan_source_gate_skip', {
            reason: sourceGate.reason,
            trigger,
            listUrl: rescanListUrl,
            publisher: sourceGate.publisher,
            count: sourceGate.count,
            threshold: sourceGate.threshold
          });
          scannedPages += 1;
          parsedCount += Array.isArray(parsed.candidates) ? parsed.candidates.length : 0;
          continue;
        }

        const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets, opts, sessionSize(opts));
        const queueableCandidates = await queueableCandidatesFromList(candidates, opts, trigger, rescanPick, blacklistedIds);
        const enqueueResult = await enqueueParsedCandidates(parsed, rescanPick, rescanListUrl, trigger, queueableCandidates);
        await auditEnqueueResult(enqueueResult, rescanPick, rescanListUrl, trigger, 'midpoint_rescan_queue');
        scannedPages += 1;
        parsedCount += Array.isArray(parsed.candidates) ? parsed.candidates.length : 0;
        added += enqueueResult.added || 0;
        refreshed += enqueueResult.refreshed || 0;
        seenSkipped += enqueueResult.seenSkipped || 0;
      }

      stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
      if (originalLastVisited === undefined) {
        delete stateForTargets.lastVisitedPages[pagePick.urlKey];
      } else {
        stateForTargets.lastVisitedPages[pagePick.urlKey] = originalLastVisited;
      }
      stateForTargets.midpointRescans = stateForTargets.midpointRescans || {};
      stateForTargets.midpointRescans[pagePick.urlKey] = {
        maxPage,
        window: MIDPOINT_RESCAN_WINDOW,
        startPage: maxPage,
        endPage,
        scannedPages,
        parsedCount,
        added,
        refreshed,
        seenSkipped,
        abortedReason,
        completedAt: new Date().toISOString()
      };
      await saveWatcherStateSafe(stateForTargets);

      await appendWatcherTrace(added > 0 ? 'midpoint_rescan_done' : 'midpoint_rescan_no_new_ids', {
        reason: added > 0 ? 'midpoint_rescan_added_candidates' : 'midpoint_rescan_no_new_ids',
        trigger,
        configuredUrl: listUrl,
        urlKey: pagePick.urlKey,
        maxPage,
        startPage: maxPage,
        endPage,
        scannedPages,
        parsedCount,
        added,
        refreshed,
        seenSkipped,
        abortedReason
      });

      const latestState = await getWatcherState();
      stateForTargets.assistCandidateQueue = latestState.assistCandidateQueue;
      stateForTargets.detectedMaxPages = latestState.detectedMaxPages || stateForTargets.detectedMaxPages;
      stateForTargets.midpointRescans = latestState.midpointRescans || stateForTargets.midpointRescans;
      return { ran: true, added, scannedPages };
    }

    async function processCandidateBatch(candidates, context) {
      const {
        opts,
        trigger,
        blacklistedIds,
        targetSessionSize,
        getHandledCount,
        setHandledCount,
        pagePick = {},
        fromQueue = false,
        maxDetailAttempts = 0,
        getLastHandledReason,
        setLastHandledReason
      } = context;
      const journalBlockedSummary = { count: 0, examples: new Set(), journals: new Set(), page: pagePick.pickedPage || '' };
      let handledAny = false;
      let detailAttempts = 0;

      for (const rawCandidate of candidates) {
        const stateForCandidate = await getWatcherState();
        const candidate = enrichCandidateJournalFromMap(rawCandidate, stateForCandidate);
        const candidatePage = candidate.page || pagePick.pickedPage || '';
        if (getHandledCount() >= targetSessionSize) break;
        const listAllowed = isListCandidateAllowed(candidate, opts, stateForCandidate, blacklistedIds);
        if (!listAllowed.ok) {
          const candidateKey = getProcessedKey(candidate);
          await appendWatcherTrace('candidate_skip_list_filter', {
            reason: listAllowed.reason,
            reasonText: describeWatcherReason(listAllowed.reason),
            trigger,
            detailUrl: candidate.detailUrl,
            assistId: candidate.assistId || '',
            title: candidate.title || '',
            journalShortName: candidate.journalShortName || '',
            assistTimeText: candidate.assistTimeText || '',
            assistAgeSeconds: candidate.assistAgeSeconds ?? '',
            journalAccess: listAllowed.journalAccess || null,
            source: fromQueue ? 'candidate_queue' : 'list_page'
          });
          if (candidateKey && listAllowed.reason === 'not_waiting') {
            await updateProcessed(candidateKey, 'skipped', listAllowed.reason);
          }
          if (listAllowed.reason === 'journal_blocked_rule') {
            journalBlockedSummary.count += 1;
            if (candidate.assistId) journalBlockedSummary.examples.add(candidate.assistId);
            const shortName = listAllowed.journalAccess?.shortName || candidate.journalShortName || '';
            if (shortName) journalBlockedSummary.journals.add(shortName);
          }
          await appendCandidateAuditEntries([buildCandidateAuditEntry('consume_list_skip', candidate, {
            status: 'skipped',
            reason: listAllowed.reason,
            trigger,
            page: candidatePage,
            pageOrder: pagePick.pageOrder,
            pageMax: pagePick.pageMax,
            urlKey: pagePick.urlKey,
            publisher: pagePick.publisher,
            source: fromQueue ? 'candidate_queue' : 'list_page',
            details: {
              reasonText: describeWatcherReason(listAllowed.reason),
              journalAccess: listAllowed.journalAccess || null
            }
          })]);
          await updateCurrentPageCandidateStatus(candidate.assistId, 'skipped', listAllowed.reason);
          await removeQueuedCandidate(candidate, listAllowed.reason);
          continue;
        }
        if (await wasRecentlyProcessed(candidate)) {
          await appendWatcherTrace('candidate_skip_processed', {
            reason: 'processed_before',
            trigger,
            detailUrl: candidate.detailUrl,
            assistId: candidate.assistId || '',
            source: fromQueue ? 'candidate_queue' : 'list_page'
          });
          await appendCandidateAuditEntries([buildCandidateAuditEntry('processed_skip', candidate, {
            status: 'skipped',
            reason: 'processed_before',
            trigger,
            page: candidatePage,
            pageOrder: pagePick.pageOrder,
            pageMax: pagePick.pageMax,
            urlKey: pagePick.urlKey,
            publisher: pagePick.publisher,
            source: fromQueue ? 'candidate_queue' : 'list_page'
          })]);
          await updateCurrentPageCandidateStatus(candidate.assistId, 'skipped', 'processed_before');
          await removeQueuedCandidate(candidate, 'processed_before');
          continue;
        }

        if (maxDetailAttempts > 0 && detailAttempts >= maxDetailAttempts) {
          await appendWatcherTrace('candidate_source_attempt_budget_exhausted', {
            reason: 'source_detail_attempt_budget',
            trigger,
            maxDetailAttempts,
            sourceKey: sourceKeyFromCandidate(candidate, pagePick),
            source: fromQueue ? 'candidate_queue' : 'list_page'
          });
          await appendCandidateAuditEntries([buildCandidateAuditEntry('detail_budget_exhausted', candidate, {
            status: 'pending',
            reason: 'source_detail_attempt_budget',
            trigger,
            page: candidatePage,
            pageOrder: pagePick.pageOrder,
            pageMax: pagePick.pageMax,
            urlKey: pagePick.urlKey,
            publisher: pagePick.publisher,
            source: fromQueue ? 'candidate_queue' : 'list_page',
            details: { maxDetailAttempts }
          })]);
          break;
        }
        detailAttempts += 1;
        await appendWatcherTrace('candidate_detail_start', {
          reason: 'candidate_passed_list_filter',
          trigger,
          detailUrl: candidate.detailUrl,
          assistId: candidate.assistId || '',
          title: candidate.title || '',
          source: fromQueue ? 'candidate_queue' : 'list_page'
        });
        await appendCandidateAuditEntries([buildCandidateAuditEntry('detail_start', candidate, {
          status: 'processing',
          reason: 'candidate_passed_list_filter',
          trigger,
          page: candidatePage,
          pageOrder: pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          source: fromQueue ? 'candidate_queue' : 'list_page'
        })]);
        await updateCurrentPageCandidateStatus(candidate.assistId, 'processing', '检查详情页...');
        const detailStartedAt = Date.now();
        const detail = await inspectDetail(candidate);
        await appendWatcherTrace('perf_detail_inspect', {
          reason: detail.ok ? 'detail_inspect_ok' : 'detail_inspect_failed',
          trigger,
          durationMs: Date.now() - detailStartedAt,
          assistId: candidate.assistId || '',
          source: fromQueue ? 'candidate_queue' : 'list_page',
          detailReason: detail.reason || ''
        });
        if (!detail.ok) {
          await closeTabQuietly(detail.tabId, 'detail_extract_failed');
          if (/502 Bad Gateway|科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|没有找到 csrf-token|504 Gateway Time|500 Internal Server/i.test(detail.reason)) {
            await appendWatcherLog({
              type: 'warning',
              message: `🔄 ⚠️ 无法提取详情：科研通网站返回服务错误 (${detail.reason})，值守已暂停并等待下一次轮询。`
            });
            await appendJournalBlockedSummary(journalBlockedSummary, trigger);
            return { stop: true, result: { ok: false, reason: 'site_error' }, handledAny };
          }
          await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
          await incrementDaily('failed', trigger);
          await appendWatcherLog({ ...candidate, trigger, status: 'failed', reason: detail.reason, page: candidatePage });
          await appendCandidateAuditEntries([buildCandidateAuditEntry('detail_failed', candidate, {
            status: 'failed',
            reason: detail.reason,
            trigger,
            page: candidatePage,
            pageOrder: pagePick.pageOrder,
            pageMax: pagePick.pageMax,
            urlKey: pagePick.urlKey,
            publisher: pagePick.publisher,
            source: fromQueue ? 'candidate_queue' : 'list_page'
          })]);
          await removeQueuedCandidate(candidate, detail.reason);
          continue;
        }

        const payload = detail.payload;
        payload.journalShortName = payload.journalShortName || candidate.journalShortName || '';
        payload.page = candidatePage;
        const detailAllowed = isDetailAllowedForWatcher(payload, opts, blacklistedIds);
        const key = getProcessedKey(candidate, payload);
        if (!detailAllowed.ok) {
          await appendWatcherTrace('candidate_skip_detail_filter', {
            reason: detailAllowed.reason,
            reasonText: describeWatcherReason(detailAllowed.reason),
            trigger,
            detailUrl: candidate.detailUrl,
            tabId: detail.tabId,
            assistId: key,
            source: fromQueue ? 'candidate_queue' : 'list_page'
          });
          await closeTabQuietly(detail.tabId, 'detail_filter_skipped');
          await updateProcessed(key, 'skipped', detailAllowed.reason);
          await incrementDaily('skipped', trigger);
          await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger, status: 'skipped', reason: detailAllowed.reason, page: candidatePage });
          await appendCandidateAuditEntries([buildCandidateAuditEntry('detail_skip', { ...candidate, ...payload }, {
            status: 'skipped',
            reason: detailAllowed.reason,
            trigger,
            page: candidatePage,
            pageOrder: pagePick.pageOrder,
            pageMax: pagePick.pageMax,
            urlKey: pagePick.urlKey,
            publisher: pagePick.publisher,
            tabId: detail.tabId,
            source: fromQueue ? 'candidate_queue' : 'list_page',
            details: { reasonText: describeWatcherReason(detailAllowed.reason) }
          })]);
          await removeQueuedCandidate(candidate, detailAllowed.reason);
          continue;
        }

        const handleStartedAt = Date.now();
        const handledResult = await handleAllowedPayload(candidate, payload, opts, detail.tabId, null, trigger);
        await appendWatcherTrace('perf_candidate_handle', {
          reason: 'candidate_handle_done',
          trigger,
          durationMs: Date.now() - handleStartedAt,
          assistId: key,
          handled: typeof handledResult === 'object' ? handledResult.handled === true : handledResult === true,
          stopRun: handledResult?.stopRun === true,
          source: fromQueue ? 'candidate_queue' : 'list_page'
        });
        const handled = typeof handledResult === 'object' ? handledResult.handled === true : handledResult === true;
        if (!handled) await closeTabQuietly(detail.tabId, 'candidate_not_handled');
        await appendCandidateAuditEntries([buildCandidateAuditEntry(handled ? 'handled' : 'handle_not_done', { ...candidate, ...payload }, {
          status: handled ? 'handled' : 'not_handled',
          reason: handledResult?.reason || (handled ? 'handled' : 'candidate_not_handled'),
          trigger,
          page: candidatePage,
          pageOrder: pagePick.pageOrder,
          pageMax: pagePick.pageMax,
          urlKey: pagePick.urlKey,
          publisher: pagePick.publisher,
          tabId: detail.tabId,
          source: fromQueue ? 'candidate_queue' : 'list_page',
          details: {
            stopRun: handledResult?.stopRun === true,
            removeQueue: handledResult?.removeQueue === true
          }
        })]);
        if (handled || handledResult?.stopRun === true || handledResult?.removeQueue === true) {
          await removeQueuedCandidate(candidate, handledResult?.reason || 'handled');
        }
        if (handled) {
          const nextHandledCount = getHandledCount() + 1;
          setHandledCount(nextHandledCount);
          if (typeof setLastHandledReason === 'function') {
            setLastHandledReason(handledResult?.reason || 'handled');
          }
          const handledSourceKey = sourceKeyFromCandidate(candidate, pagePick);
          await saveWatcherStateSafe({
            ...(await getWatcherState()),
            lastHandledPublisherKey: handledSourceKey,
            lastHandledPublisherAt: new Date().toISOString()
          }).catch(() => {});
          handledAny = true;
          await appendWatcherTrace('candidate_handled', {
            reason: handledResult?.reason || 'handled',
            trigger,
            detailUrl: candidate.detailUrl,
            tabId: detail.tabId,
            assistId: key,
            handledCount: nextHandledCount,
            targetSessionSize,
            stopRun: handledResult?.stopRun === true,
            paused: handledResult?.paused === true,
            source: fromQueue ? 'candidate_queue' : 'list_page'
          });
          if (handledResult?.stopRun === true) {
            await appendJournalBlockedSummary(journalBlockedSummary, trigger);
            return { stop: true, result: { ok: false, reason: handledResult.reason || 'upload_failed_stop_run' }, handledAny };
          }
          if (nextHandledCount >= targetSessionSize || depsRef.hasActiveTask()) {
            await appendJournalBlockedSummary(journalBlockedSummary, trigger);
            return { stop: true, result: { ok: true, reason: nextHandledCount > 1 ? 'session_candidates_handled' : (handledResult?.reason || 'candidate_handled') }, handledAny };
          }
        }
      }
      await appendJournalBlockedSummary(journalBlockedSummary, trigger);
      return { stop: false, handledAny };
    }

    async function consumeQueuedCandidates(trigger, opts, blacklistedIds, targetSessionSize, handledCountRef, lastHandledReasonRef, runListUrls = null, maxDetailAttempts = 0) {
      const queued = await queuedCandidatesSnapshot(undefined, runListUrls);
      if (queued.length <= 0) return { stop: false };
      await appendWatcherTrace('candidate_queue_consume_start', {
        reason: 'consume_existing_queue',
        trigger,
        queueSize: queued.length,
        targetSessionSize,
        configuredUrlCount: Array.isArray(runListUrls) ? runListUrls.length : '',
        activeListUrls: Array.isArray(runListUrls) ? runListUrls : []
      });
      return await processCandidateBatch(queued, {
        opts,
        trigger,
        blacklistedIds,
        targetSessionSize,
        getHandledCount: () => handledCountRef.value,
        setHandledCount: value => { handledCountRef.value = value; },
        getLastHandledReason: () => lastHandledReasonRef?.value || '',
        setLastHandledReason: value => { if (lastHandledReasonRef) lastHandledReasonRef.value = value; },
        maxDetailAttempts,
        fromQueue: true
      });
    }

    async function runAutoWatcherOnce(trigger = 'alarm') {
      if (stateRef.autoWatcherRunning) {
        const runningSince = Number(stateRef.autoWatcherStartedAt || 0);
        const elapsedMs = Number.isFinite(runningSince) && runningSince > 0 ? Date.now() - runningSince : 0;
        const currentState = await getWatcherState().catch(() => ({}));
        const scanText = describeCurrentListScan(currentState.currentListScan || {});
        if (elapsedMs > RUNNING_LOCK_STALE_MS) {
          await appendWatcherTrace('run_stale_lock_recovered', {
            reason: 'stale_auto_watcher_running_lock',
            trigger,
            elapsedMs,
            currentListScan: currentState.currentListScan || null
          });
          stateRef.autoWatcherRunning = false;
          stateRef.autoWatcherStartedAt = 0;
          await clearCurrentListScan();
        } else {
          await appendWatcherTrace('run_skip_already_running', {
            reason: 'already_running',
            trigger,
            elapsedMs,
            currentListScan: currentState.currentListScan || null
          });
          return {
            ok: false,
            reason: scanText ? `already_running：${scanText}` : 'already_running'
          };
        }
      }
      stateRef.autoWatcherRunning = true;
      stateRef.autoWatcherStartedAt = Date.now();
      let runResult = null;
      let currentRunOpts = null;
      let scannedUrl = '';
      let scannedPublisher = '';
      let scannedPage = '';
      const parsedListPages = [];
      const backoffSkippedPages = [];
      const attempt = {
        startedAt: new Date().toISOString(),
        trigger,
        resultReason: '',
        nextAssistBefore: '',
        nextAssistAfter: '',
        nextAlarmAfter: '',
        checkedBefore: 0,
        checkedAfter: 0,
        downloadedBefore: 0,
        downloadedAfter: 0,
        failedBefore: 0,
        failedAfter: 0,
        skippedBefore: 0,
        skippedAfter: 0,
        targetSessionSize: '',
        sessionCap: '',
        speedMode: '',
        randomSessionPicked: '',
        randomSessionFinalSize: '',
        randomSessionWeights: '',
        randomValue: '',
        listScanStarted: false,
        pickedListUrl: '',
        pickedPage: '',
        pageCurve: '',
        pageMin: '',
        pageMax: '',
        parsedListPages: '',
        backoffSkippedPages: '',
        listScanBackoffSkipped: 0,
        frontHit: false,
        alpha: ''
      };
      let manualScheduleSnapshot = null;
      const runPerfStartedAt = Date.now();
      let lastPerfAt = runPerfStartedAt;
      function finish(result) {
        runResult = result;
        return result;
      }
      async function appendPerfCheckpoint(name, extra = {}) {
        const now = Date.now();
        await appendWatcherTrace('perf_watcher_checkpoint', {
          reason: name,
          trigger,
          elapsedMs: now - runPerfStartedAt,
          deltaMs: now - lastPerfAt,
          ...extra
        });
        lastPerfAt = now;
      }
      function snapshotScheduleFields(state = {}) {
        const keys = [
          'nextAssistRunAt',
          'nextAssistReason',
          'nextAssistStrategy',
          'nextAssistDelayMinutes',
          'nextAssistModelDelayMinutes',
          'nextAssistGuardMinutes',
          'nextAssistGuardApplied',
          'nextAssistGuardLiftMinutes',
          'nextAssistGuardWeight',
          'nextAssistGuardMode',
          'nextAssistPlannedAt',
          'nextAssistPlanningData',
          'nextAssistPlan',
          'nextScheduledAt',
          'chromeAlarmScheduledAt'
        ];
        return Object.fromEntries(keys.map(key => {
          if (state[key] !== undefined) return [key, state[key]];
          return [key, key === 'nextAssistPlanningData' || key === 'nextAssistPlan' ? null : ''];
        }));
      }
      async function restoreManualScheduleSnapshot() {
        if (!manualScheduleSnapshot) return;
        const state = await getWatcherState();
        Object.assign(state, manualScheduleSnapshot);
        await saveWatcherState(state);
        await appendWatcherTrace('manual_run_schedule_preserved', {
          reason: 'manual_run_does_not_replan_auto_schedule',
          nextAssistRunAt: state.nextAssistRunAt || '',
          chromeAlarmScheduledAt: state.chromeAlarmScheduledAt || '',
          nextScheduledAt: state.nextScheduledAt || ''
        });
      }
      try {
        await appendWatcherTrace('run_start', { reason: 'watcher_triggered', trigger });
        await appendPerfCheckpoint('run_start');
        const opts = normalizeOptions(await depsRef.getOptions());
        currentRunOpts = opts;
        await recordRunStart(trigger, opts);
        await appendPerfCheckpoint('options_loaded', {
          perfTraceEnabled: opts.watcherPerfTraceEnabled === true,
          perfFileEnabled: opts.watcherPerfFileEnabled === true
        });
        const initialState = await getWatcherState();
        await appendPerfCheckpoint('initial_state_loaded');
        if (trigger === 'manual') {
          manualScheduleSnapshot = snapshotScheduleFields(initialState);
        }
        attempt.nextAssistBefore = initialState.nextAssistRunAt || '';
        Object.assign(attempt, Object.fromEntries(Object.entries(dailyCounterSnapshot(initialState)).map(([key, value]) => [`${key}Before`, value])));
        if (!opts.watcherEnabled && trigger !== 'manual') {
          await appendWatcherTrace('run_skip_disabled', { reason: 'disabled', trigger });
          return finish({ ok: false, reason: 'disabled' });
        }
        if (depsRef.hasActiveTask()) {
          await appendWatcherTrace('run_skip_active_task', { reason: 'active_task', trigger });
          return finish({ ok: false, reason: 'active_task' });
        }

        if (opts.watcherQuantSchedulerEnabled && trigger === 'alarm' && !isInWorkSchedule(opts)) {
          await appendWatcherTrace('run_skip_outside_work_schedule', {
            reason: 'outside_work_schedule',
            trigger
          });
          return finish({ ok: true, reason: 'outside_work_schedule' });
        }
        const stateForTargets = await getWatcherState();
        stateForTargets.optionsSnapshot = opts;
        await syncActualAssistCount(stateForTargets, opts);
        if (trigger === 'alarm' && opts.watcherQuantSchedulerEnabled && !isAssistDue(stateForTargets)) {
          await appendWatcherTrace('run_skip_assist_not_due', {
            reason: 'assist_not_due',
            trigger,
            nextAssistRunAt: stateForTargets.nextAssistRunAt || '',
            nextAssistRunAtBeijing: stateForTargets.nextAssistRunAt ? formatBeijingDateTime(stateForTargets.nextAssistRunAt) : '',
            secondsUntilAssist: stateForTargets.nextAssistRunAt ? Math.round((new Date(stateForTargets.nextAssistRunAt).getTime() - Date.now()) / 1000) : ''
          });
          return finish({ ok: true, reason: 'assist_not_due' });
        }
        if (trigger !== 'manual') {
          const rateLimit = checkShortTermRateLimit(stateForTargets);
          if (rateLimit.limited) {
            const reason = `rate_limited_${rateLimit.window}`;
            await appendWatcherTrace('run_skip_rate_limit', {
              reason,
              window: rateLimit.window,
              count: rateLimit.count,
              limit: rateLimit.limit,
              trigger
            });
            return finish({ ok: false, reason });
          }
        }
        const liveTargetState = !opts.watcherQuantSchedulerEnabled
          ? {
              schedulerModelMode: 'fixed',
              speedMode: 'fixed',
              todayTarget: 0,
              actualDone: 0,
              expectedDone: 0,
              targetError: 0,
              rateMultiplier: 1,
              sessionIntensity: 0,
              riskLimit: Number(opts.watcherRiskBudgetLimit || 10)
            }
          : calculateTargetState(stateForTargets, opts);
        const frozenTargetState = trigger === 'alarm' && stateForTargets.nextAssistPlanningData?.targetState
          ? stateForTargets.nextAssistPlanningData.targetState
          : null;
        const targetState = mergeFrozenTargetState(liveTargetState, frozenTargetState);
        Object.assign(stateForTargets, targetState);
        stateForTargets.lastAssistDecisionModelData = frozenTargetState ? 'frozen_pending_assist_plan' : 'live_schedule_state';
        stateForTargets.lastAssistStrategy = opts.watcherQuantSchedulerEnabled ? 'calendar_target_lognormal' : 'fixed_interval';
        stateForTargets.lastAssistDecisionAt = new Date().toISOString();
        stateForTargets.lastAssistDecision = {
          trigger,
          strategy: stateForTargets.lastAssistStrategy,
          modelData: stateForTargets.lastAssistDecisionModelData,
          frozenPlanAt: stateForTargets.nextAssistPlanningData?.plannedAt || '',
          speedMode: targetState.speedMode,
          todayTarget: 0,
          hourTarget: 0,
          rateMultiplier: 1,
          targetError: targetState.targetError ?? targetState.lag ?? 0,
          workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
          activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
          availabilityFactor: targetState.availabilityFactor || 1,
          availabilityActualWakeCount: targetState.availabilityActualWakeCount || 0,
          availabilityExpectedWakeCount: targetState.availabilityExpectedWakeCount || 0,
          riskUsed: targetState.riskUsed || 0,
          riskLimit: targetState.riskLimit || 0,
          dailyLimit: opts.watcherDailyLimit || 0
        };
        await saveWatcherStateSafe(stateForTargets);
        await appendWatcherTrace('run_target_state', {
          reason: opts.watcherQuantSchedulerEnabled ? 'calendar_target' : 'fixed_interval',
          trigger,
          modelData: stateForTargets.lastAssistDecisionModelData,
          speedMode: targetState.speedMode,
          todayTarget: '',
          hourTarget: '',
          rateMultiplier: '',
          targetError: targetState.targetError || targetState.lag || '',
          workTimeProgressRatio: targetState.workTimeProgressRatio || 0,
          activeTimeProgressRatio: targetState.activeTimeProgressRatio || 0,
          availabilityFactor: targetState.availabilityFactor || 1
        });
        if (opts.watcherDailyLimit > 0 && await getDailyCount('downloaded') >= opts.watcherDailyLimit) {
          await appendWatcherTrace('run_skip_daily_limit', { reason: 'daily_limit', trigger, dailyLimit: opts.watcherDailyLimit });
          return finish({ ok: false, reason: 'daily_limit' });
        }

        let handledCount = 0;
        const handledCountRef = { value: 0 };
        const lastHandledReasonRef = { value: '' };
        const sessionCap = sessionExecutionCap(opts, stateForTargets, false);
        const riskForSizing = riskSnapshot(stateForTargets, opts);
        let targetSessionSize = opts.watcherQuantSchedulerEnabled ? sessionSize(opts, stateForTargets) : Math.min(1, sessionCap);
        const zeroForcedToOne = !opts.watcherAllowZeroSession
          && trigger === 'alarm'
          && targetSessionSize <= 0
          && sessionCap > 0
          && (Number(opts.watcherDailyLimit || 0) <= 0 || dailyDownloadedFromState(stateForTargets) < Number(opts.watcherDailyLimit || 0));
        if (zeroForcedToOne) {
          targetSessionSize = 1;
          stateForTargets.lastSessionSizeDecision = {
            ...(stateForTargets.lastSessionSizeDecision || {}),
            finalSize: 1,
            forcedMinOne: true,
            forceReason: 'alarm_due_no_zero_session'
          };
          await saveWatcherStateSafe(stateForTargets);
        }
        const sizeDecision = stateForTargets.lastSessionSizeDecision || {};
        attempt.targetSessionSize = targetSessionSize;
        attempt.sessionCap = sessionCap;
        attempt.speedMode = targetState.speedMode || '';
        attempt.randomSessionPicked = sizeDecision.picked ?? '';
        attempt.randomSessionFinalSize = sizeDecision.finalSize ?? targetSessionSize;
        attempt.randomSessionWeights = Array.isArray(sizeDecision.weights) ? sizeDecision.weights.join('|') : '';
        attempt.randomValue = sizeDecision.random ?? '';
        await appendWatcherTrace('run_session_size', {
          reason: 'session_size_calculated',
          trigger,
          targetSessionSize,
          zeroForcedToOne,
          decision: stateForTargets.lastSessionSizeDecision || {},
          maxPerSession: maxSessionCandidates(opts),
          sessionCap,
          dailyDownloaded: dailyDownloadedFromState(stateForTargets),
          todayTarget: '',
          dailyLimit: opts.watcherDailyLimit || 0,
          riskRemaining: riskForSizing.remaining,
          sessionMode: 'single'
        });
        if (targetSessionSize <= 0) return finish({ ok: true, reason: 'session_size_zero' });

        const runListUrls = rotateRecentSource(listUrlsForRun(opts), stateForTargets);
        const hasHighFreqSource = runListUrls.some(url => /sciencedirect|elsevier/i.test(url));
        const hasLowFreqSource = runListUrls.some(url => !/sciencedirect|elsevier/i.test(url));
        const firstSourceIsHighFreq = /sciencedirect|elsevier/i.test(runListUrls[0] || '');
        let queuedResult = null;
        await appendWatcherTrace('run_source_order', {
          reason: runListUrls.length > 1
            ? (hasHighFreqSource && hasLowFreqSource
                ? (firstSourceIsHighFreq ? 'weighted_high_first' : 'weighted_low_first')
                : 'random_source_order')
            : 'single_list_url',
          trigger,
          listUrls: runListUrls
        });
        const blacklistedIds = await readBlacklistedIds(opts, trigger);
        await appendPerfCheckpoint('blacklist_loaded', { blacklistCount: blacklistedIds.length });

        for (const listUrl of runListUrls) {
          const isHighFreq = /sciencedirect|elsevier/i.test(listUrl);
          if (isHighFreq && handledCount >= targetSessionSize) continue;
          const handledBeforeSource = handledCount;
          queuedResult = await consumeQueuedCandidates(
            trigger,
            opts,
            blacklistedIds,
            targetSessionSize,
            handledCountRef,
            lastHandledReasonRef,
            [listUrl],
            sourceDetailAttemptBudget(listUrl, runListUrls.length)
          );
          handledCount = handledCountRef.value;
          if (queuedResult.stop) return finish(queuedResult.result);
          if (runListUrls.length > 1 && handledCount > handledBeforeSource) {
            return finish({ ok: true, reason: lastHandledReasonRef.value || 'candidate_handled' });
          }
        }
        await appendPerfCheckpoint('queue_consumed_before_refill', { handledCount });
        if (handledCount >= targetSessionSize) return finish({ ok: true, reason: handledCount > 1 ? 'session_candidates_handled' : (lastHandledReasonRef.value || 'candidate_handled') });

        for (const listUrl of runListUrls) {
          const isHighFreq = /sciencedirect|elsevier/i.test(listUrl);
          if (isHighFreq && handledCount >= targetSessionSize) {
            continue;
          }
          const handledBeforeSource = handledCount;
          let sequentialPageScanCount = 0;
          let sequentialBackoffSkipCount = 0;
          const maxSequentialPageScans = runListUrls.length > 1 ? 1 : 5;
          const maxSequentialBackoffSkips = runListUrls.length > 1 ? 5 : 25;
          while (
            sequentialPageScanCount < maxSequentialPageScans &&
            sequentialBackoffSkipCount < maxSequentialBackoffSkips
          ) {
          const pagePick = randomizeAssistListUrlWithMeta(listUrl, stateWithQueueRefillCursor(listUrl, stateForTargets));
          let pickedListUrl = pagePick.pickedListUrl;
          const isSequentialPageScan = pagePick.pageOrder === 'desc' || pagePick.pageOrder === 'asc';
          if (await shouldSkipBackedOffPage(pagePick)) {
            await appendWatcherTrace('list_scan_skip_backoff', {
              reason: 'candidate_queue_page_backoff',
              trigger,
              configuredUrl: listUrl,
              publisher: pagePick.publisher,
              pageOrder: pagePick.pageOrder,
              urlKey: pagePick.urlKey,
              pickedPage: pagePick.pickedPage
            });
            if (isSequentialPageScan && pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
              const skippedPage = Number(pagePick.pickedPage);
              backoffSkippedPages.push(skippedPage);
              attempt.backoffSkippedPages = backoffSkippedPages.join(',');
              attempt.listScanBackoffSkipped = backoffSkippedPages.length;
              attempt.pickedListUrl = pickedListUrl;
              attempt.pickedPage = pagePick.pickedPage;
              attempt.pageCurve = pagePick.pageCurve;
              attempt.pageMin = pagePick.pageMin;
              attempt.pageMax = pagePick.pageMax;
              attempt.pageOrder = pagePick.pageOrder;
              attempt.listUrlKey = pagePick.urlKey;
              stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
              stateForTargets.lastVisitedPages[pagePick.urlKey] = skippedPage;
              stateForTargets.lastPickedListUrl = pickedListUrl;
              stateForTargets.lastPickedPage = pagePick.pickedPage || '';
              stateForTargets.lastPickedPageMax = pagePick.pageMax || '';
              stateForTargets.lastPickedPublisher = pagePick.publisher || '';
              stateForTargets.lastPickedPageOrder = pagePick.pageOrder || '';
              stateForTargets.lastPickedUrlKey = pagePick.urlKey || '';
              stateForTargets.currentListScan = {
                mode: 'background_fetch_rebase',
                trigger,
                configuredUrl: listUrl,
                pickedListUrl,
                urlKey: pagePick.urlKey || '',
                publisher: pagePick.publisher || '',
                page: pagePick.pickedPage || '',
                pageOrder: pagePick.pageOrder || '',
                pageMin: pagePick.pageMin || '',
                pageMax: pagePick.pageMax || '',
                range: pagePick.pageOrder === 'desc' && Number.isFinite(Number(pagePick.pickedPage))
                  ? `${pagePick.pickedPage}${pagePick.pageMin ? `-${pagePick.pageMin}` : ''}`
                  : '',
                scanIndex: sequentialPageScanCount + 1,
                scanLimit: maxSequentialPageScans,
                updatedAt: new Date().toISOString()
              };
              await saveWatcherStateSafe(stateForTargets);
              await appendWatcherTrace('list_scan_page_progress_saved', {
                reason: 'sequential_page_backoff_skipped',
                trigger,
                listUrl: pickedListUrl,
                configuredUrl: listUrl,
                publisher: pagePick.publisher,
                pageOrder: pagePick.pageOrder,
                urlKey: pagePick.urlKey,
                pickedPage: skippedPage,
                backoffSkippedPages: backoffSkippedPages.slice(-10),
                maxSequentialBackoffSkips
              });
              sequentialBackoffSkipCount += 1;
              continue;
            }
            break;
          }
          attempt.listScanStarted = true;
          const listScanStartedAt = Date.now();
          attempt.pickedListUrl = pickedListUrl;
          attempt.pickedPage = pagePick.pickedPage;
          attempt.pageCurve = pagePick.pageCurve;
          attempt.pageMin = pagePick.pageMin;
          attempt.pageMax = pagePick.pageMax;
          attempt.frontHit = pagePick.frontHit;
          attempt.alpha = pagePick.alpha;
          attempt.pageOrder = pagePick.pageOrder;
          attempt.listUrlKey = pagePick.urlKey;
          await appendWatcherTrace('list_scan_start', {
            reason: pickedListUrl === listUrl ? 'configured_url' : 'picked_page',
            trigger,
            listUrl: pickedListUrl,
            configuredUrl: listUrl,
            publisher: pagePick.publisher,
            pageCurve: pagePick.pageCurve,
            pageOrder: pagePick.pageOrder,
            urlKey: pagePick.urlKey,
            pickedPage: pagePick.pickedPage,
            pageMin: pagePick.pageMin,
            pageMax: pagePick.pageMax,
            frontHit: pagePick.frontHit,
            alpha: pagePick.alpha,
            handledCount,
            targetSessionSize
          });
          stateForTargets.lastPickedListUrl = pickedListUrl;
          stateForTargets.lastPickedPage = pagePick.pickedPage || '';
          stateForTargets.lastPickedPageMax = pagePick.pageMax || '';
          stateForTargets.lastPickedPublisher = pagePick.publisher || '';
          stateForTargets.lastPickedPageOrder = pagePick.pageOrder || '';
          stateForTargets.lastPickedUrlKey = pagePick.urlKey || '';
          stateForTargets.currentListScan = {
            mode: 'background_fetch',
            trigger,
            configuredUrl: listUrl,
            pickedListUrl,
            urlKey: pagePick.urlKey || '',
            publisher: pagePick.publisher || '',
            page: pagePick.pickedPage || '',
            pageOrder: pagePick.pageOrder || '',
            pageMin: pagePick.pageMin || '',
            pageMax: pagePick.pageMax || '',
            range: pagePick.pageOrder === 'desc' && Number.isFinite(Number(pagePick.pickedPage))
              ? `${pagePick.pickedPage}${pagePick.pageMin ? `-${pagePick.pageMin}` : ''}`
              : '',
            scanIndex: sequentialPageScanCount + 1,
            scanLimit: maxSequentialPageScans,
            updatedAt: new Date().toISOString()
          };
          await saveWatcherStateSafe(stateForTargets);
          await incrementDaily('checked', trigger);
          const parseStartedAt = Date.now();
          let parsed = await parseListUrl(pickedListUrl);
          scannedUrl = pickedListUrl;
          scannedPublisher = pagePick.publisher || '';
          scannedPage = pagePick.pickedPage || '';
          if (Number.isFinite(Number(pagePick.pickedPage))) {
            parsedListPages.push(Number(pagePick.pickedPage));
            attempt.parsedListPages = parsedListPages.join(',');
          }
          await appendWatcherTrace('perf_list_parse', {
            reason: 'list_parse_done',
            trigger,
            durationMs: Date.now() - parseStartedAt,
            pickedPage: pagePick.pickedPage,
            urlKey: pagePick.urlKey,
            parsedCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
            maxPage: parsed?.listStats?.maxPage || ''
          });
          if (parsed.isErrorPage) {
            await appendWatcherLog({
              type: 'warning',
              message: `🔄 ⚠️ 无法扫描列表：科研通网站返回服务错误 (${parsed.errorTitle || '502 Bad Gateway'})，值守已暂停并等待下一次轮询。`
            });
            return finish({ ok: false, reason: 'site_error' });
          }
          if (parsed.cfChallenge) {
            await recordCfChallenge(opts, pickedListUrl, trigger);
            return finish({ ok: false, reason: 'cf_challenge' });
          }

          if (isSequentialPageScan && parsed?.listStats?.currentPage && Number.isFinite(parsed.listStats.currentPage)) {
            const realCurrentPage = Number(parsed.listStats.currentPage);
            if (realCurrentPage < Number(pagePick.pickedPage)) {
              await appendWatcherTrace('list_scan_page_corrected', {
                reason: 'requested_page_exceeds_max_page',
                trigger,
                requestedPage: pagePick.pickedPage,
                correctedPage: realCurrentPage,
                maxPage: parsed.listStats.maxPage
              });
              pagePick.pickedPage = realCurrentPage;
              attempt.pickedPage = realCurrentPage;
              stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
              if (pagePick.pageOrder === 'desc') {
                stateForTargets.lastVisitedPages[pagePick.urlKey] = realCurrentPage + 1;
              } else if (pagePick.pageOrder === 'asc') {
                stateForTargets.lastVisitedPages[pagePick.urlKey] = realCurrentPage - 1;
              } else {
                stateForTargets.lastVisitedPages[pagePick.urlKey] = realCurrentPage;
              }

              if (parsed.listStats.maxPage && Number.isFinite(parsed.listStats.maxPage)) {
                pagePick.pageMax = Number(parsed.listStats.maxPage);
                attempt.pageMax = Number(parsed.listStats.maxPage);
                stateForTargets.detectedMaxPages = stateForTargets.detectedMaxPages || {};
                stateForTargets.detectedMaxPages[pagePick.urlKey] = Number(parsed.listStats.maxPage);
              }
              await saveWatcherStateSafe(stateForTargets);
            }
          }
          normalizeParsedListCandidateContext(parsed, pagePick, pickedListUrl);
          const auditPickedListUrl = listUrlWithAuditPage(pickedListUrl, pagePick.pickedPage);
          await initCurrentPageData(auditPickedListUrl, pagePick, parsed);
          await auditParsedListCandidates(parsed, pagePick, auditPickedListUrl, trigger);

          let detectedMaxPage = Number(parsed?.listStats?.maxPage || 0);
          if (Number.isFinite(detectedMaxPage) && detectedMaxPage > 0) {
            stateForTargets.lastPickedPageMax = detectedMaxPage;
            await saveWatcherStateSafe(stateForTargets);
          }
          if (
            isSequentialPageScan &&
            pagePick.urlKey &&
            Number.isFinite(detectedMaxPage) &&
            detectedMaxPage > 0
          ) {
            const adjustedState = stateWithQueueRefillCursor(listUrl, stateForTargets, detectedMaxPage);
            const adjustedPagePick = randomizeAssistListUrlWithMeta(listUrl, adjustedState);
            const adjustedPage = Number(adjustedPagePick.pickedPage);
            const currentPickedPage = Number(pagePick.pickedPage);
            if (
              adjustedPagePick.urlKey === pagePick.urlKey &&
              adjustedPagePick.pageOrder === pagePick.pageOrder &&
              Number.isFinite(adjustedPage) &&
              Number.isFinite(currentPickedPage) &&
              adjustedPage > 0 &&
              adjustedPage !== currentPickedPage
            ) {
              await appendWatcherTrace('list_scan_refill_cursor_rebased', {
                reason: 'detected_max_page_changed',
                trigger,
                configuredUrl: listUrl,
                previousListUrl: pickedListUrl,
                previousPickedPage: pagePick.pickedPage,
                adjustedPickedPage: adjustedPage,
                detectedMaxPage,
                urlKey: pagePick.urlKey
              });
              pickedListUrl = adjustedPagePick.pickedListUrl;
              Object.assign(pagePick, adjustedPagePick);
              attempt.pickedListUrl = pickedListUrl;
              attempt.pickedPage = pagePick.pickedPage;
              attempt.pageMax = pagePick.pageMax;
              stateForTargets.lastPickedListUrl = pickedListUrl;
              stateForTargets.lastPickedPage = pagePick.pickedPage || '';
              stateForTargets.lastPickedPageMax = pagePick.pageMax || '';
              stateForTargets.lastPickedPublisher = pagePick.publisher || '';
              stateForTargets.lastPickedPageOrder = pagePick.pageOrder || '';
              stateForTargets.lastPickedUrlKey = pagePick.urlKey || '';
              await saveWatcherStateSafe(stateForTargets);
              await incrementDaily('checked', trigger);
              const reparseStartedAt = Date.now();
              parsed = await parseListUrl(pickedListUrl);
              scannedUrl = pickedListUrl;
              scannedPublisher = pagePick.publisher || '';
              scannedPage = pagePick.pickedPage || '';
              if (Number.isFinite(Number(pagePick.pickedPage))) {
                parsedListPages.push(Number(pagePick.pickedPage));
                attempt.parsedListPages = parsedListPages.join(',');
              }
              await appendWatcherTrace('perf_list_parse', {
                reason: 'list_reparse_after_rebase_done',
                trigger,
                durationMs: Date.now() - reparseStartedAt,
                pickedPage: pagePick.pickedPage,
                urlKey: pagePick.urlKey,
                parsedCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
                maxPage: parsed?.listStats?.maxPage || ''
              });
              if (parsed.isErrorPage) {
                await appendWatcherLog({
                  type: 'warning',
                  message: `🔄 ⚠️ 无法扫描列表：科研通网站返回服务错误 (${parsed.errorTitle || '502 Bad Gateway'})，值守已暂停并等待下一次轮询。`
                });
                return finish({ ok: false, reason: 'site_error' });
              }
              if (parsed.cfChallenge) {
                await recordCfChallenge(opts, pickedListUrl, trigger);
                return finish({ ok: false, reason: 'cf_challenge' });
              }
              normalizeParsedListCandidateContext(parsed, pagePick, pickedListUrl);
              const auditRebasedListUrl = listUrlWithAuditPage(pickedListUrl, pagePick.pickedPage);
              await initCurrentPageData(auditRebasedListUrl, pagePick, parsed);
              await auditParsedListCandidates(parsed, pagePick, auditRebasedListUrl, trigger, 'parsed_after_rebase');
              detectedMaxPage = Number(parsed?.listStats?.maxPage || 0);
            }
          }

          if (
            trigger === 'manual' &&
            pagePick.pageOrder === 'desc' &&
            pagePick.hasExplicitPageMax !== true &&
            Number.isFinite(detectedMaxPage) &&
            detectedMaxPage > Number(pagePick.pageMax || 0) &&
            pagePick.urlKey
          ) {
            stateForTargets.detectedMaxPages = stateForTargets.detectedMaxPages || {};
            stateForTargets.detectedMaxPages[pagePick.urlKey] = detectedMaxPage;
            await saveWatcherStateSafe(stateForTargets);
            await appendWatcherTrace('list_scan_detected_tail_page_saved', {
              reason: 'manual_order_desc_detected_max_page_saved',
              trigger,
              configuredUrl: listUrl,
              listUrl: pickedListUrl,
              publisher: pagePick.publisher,
              urlKey: pagePick.urlKey,
              detectedMaxPage
            });
          }

          const sourceGate = minSeekingGateForList(parsed, pickedListUrl, pagePick.publisher, opts);
          if (!sourceGate.ok) {
            await appendWatcherTrace('list_scan_skip_source_gate', {
              reason: sourceGate.reason,
              trigger,
              listUrl: pickedListUrl,
              publisher: sourceGate.publisher,
              count: sourceGate.count,
              threshold: sourceGate.threshold
            });
            if (isSequentialPageScan) {
              if (pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
                stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
                stateForTargets.lastVisitedPages[pagePick.urlKey] = Number(pagePick.pickedPage);
                await saveWatcherStateSafe(stateForTargets);
                await appendWatcherTrace('list_scan_page_progress_saved', {
                  reason: 'sequential_page_exhausted_source_gate',
                  trigger,
                  listUrl: pickedListUrl,
                  configuredUrl: listUrl,
                  publisher: pagePick.publisher,
                  pageOrder: pagePick.pageOrder,
                  urlKey: pagePick.urlKey,
                  pickedPage: Number(pagePick.pickedPage),
                  currentPage: parsed?.listStats?.currentPage || '',
                  maxPage: parsed?.listStats?.maxPage || ''
                });
              }
              sequentialPageScanCount += 1;
              continue;
            }
            break;
          }
          await resetCfChallengeStreak();

          const candidates = orderCandidatesForRun(parsed.candidates, stateForTargets, opts, targetSessionSize);
          const refillStartedAt = Date.now();
          const queueableCandidates = await queueableCandidatesFromList(candidates, opts, trigger, pagePick, blacklistedIds);
          const enqueueResult = await enqueueParsedCandidates(parsed, pagePick, pickedListUrl, trigger, queueableCandidates);
          await auditEnqueueResult(enqueueResult, pagePick, pickedListUrl, trigger);
          await appendWatcherTrace('perf_queue_refill', {
            reason: 'queue_refill_done',
            trigger,
            durationMs: Date.now() - refillStartedAt,
            pickedPage: pagePick.pickedPage,
            parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            orderedCount: candidates.length,
            queueableCount: queueableCandidates.length,
            queueAdded: enqueueResult.added,
            queueRefreshed: enqueueResult.refreshed,
            queueSeenSkipped: enqueueResult.seenSkipped
          });
          const latestStateAfterQueue = await getWatcherState();
          stateForTargets.assistCandidateQueue = latestStateAfterQueue.assistCandidateQueue;
          stateForTargets.detectedMaxPages = latestStateAfterQueue.detectedMaxPages || stateForTargets.detectedMaxPages;
          if (isSequentialPageScan && pagePick.urlKey && Number.isFinite(Number(pagePick.pickedPage))) {
            stateForTargets.lastVisitedPages = stateForTargets.lastVisitedPages || {};
            stateForTargets.lastVisitedPages[pagePick.urlKey] = Number(pagePick.pickedPage);
            await appendWatcherTrace('list_scan_page_cursor_advanced', {
              reason: 'sequential_page_snapshot_enqueued_in_memory',
              trigger,
              listUrl: pickedListUrl,
              configuredUrl: listUrl,
              publisher: pagePick.publisher,
              pageOrder: pagePick.pageOrder,
              urlKey: pagePick.urlKey,
              pickedPage: Number(pagePick.pickedPage),
              currentPage: parsed?.listStats?.currentPage || '',
              maxPage: parsed?.listStats?.maxPage || ''
            });
            await runMidpointRescanIfDue({
              listUrl,
              pagePick,
              detectedMaxPage,
              stateForTargets,
              opts,
              trigger,
              blacklistedIds
            });
          }
          await appendWatcherTrace('list_scan_candidates', {
            reason: 'ordered_candidates',
            trigger,
            listUrl: pickedListUrl,
            parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            orderedCount: candidates.length,
            queueableCount: queueableCandidates.length
          });

          if (isSequentialPageScan) {
            sequentialPageScanCount += 1;
            if (sequentialPageScanCount < maxSequentialPageScans) {
              await appendWatcherTrace('list_scan_continue_next_page', {
                reason: 'sequential_page_snapshot_enqueued',
                trigger,
                listUrl: pickedListUrl,
                configuredUrl: listUrl,
                publisher: pagePick.publisher,
                pageOrder: pagePick.pageOrder,
                urlKey: pagePick.urlKey,
                pickedPage: pagePick.pickedPage,
                nextScanIndex: sequentialPageScanCount + 1,
                maxSequentialPageScans,
                parsedListPages: parsedListPages.slice(-10),
                backoffSkippedPages: backoffSkippedPages.slice(-10)
              });
              continue;
            }
          }
          await appendWatcherTrace('perf_list_scan_page', {
            reason: 'list_scan_page_done',
            trigger,
            durationMs: Date.now() - listScanStartedAt,
            pickedPage: pagePick.pickedPage,
            parsedCount: Array.isArray(parsed.candidates) ? parsed.candidates.length : 0,
            queueableCount: queueableCandidates.length
          });
          break;
          }

          queuedResult = await consumeQueuedCandidates(
            trigger,
            opts,
            blacklistedIds,
            targetSessionSize,
            handledCountRef,
            lastHandledReasonRef,
            [listUrl],
            sourceDetailAttemptBudget(listUrl, runListUrls.length)
          );
          handledCount = handledCountRef.value;
          await appendPerfCheckpoint('queue_consumed_after_refill_source', { listUrl, handledCount, stop: queuedResult.stop === true });
          if (queuedResult.stop) return finish(queuedResult.result);
          if (runListUrls.length > 1 && handledCount > handledBeforeSource) {
            return finish({ ok: true, reason: lastHandledReasonRef.value || 'candidate_handled' });
          }
        }

        const reason = handledCount
          ? (handledCount > 1 ? 'session_candidates_handled' : (lastHandledReasonRef.value || 'candidate_handled'))
          : (parsedListPages.length <= 0 && backoffSkippedPages.length > 0 ? 'list_pages_backoff_only' : 'no_candidate');
        const finalResult = { ok: true, reason };
        if (reason === 'no_candidate' || reason === 'list_pages_backoff_only') {
          finalResult.scannedUrl = scannedUrl;
          finalResult.scannedPublisher = scannedPublisher;
          finalResult.scannedPage = scannedPage;
          finalResult.parsedListPages = parsedListPages.slice(-20);
          finalResult.backoffSkippedPages = backoffSkippedPages.slice(-30);
        }
        return finish(finalResult);
      } catch (err) {
        await appendWatcherTrace('run_error', { reason: err?.message || String(err), trigger });
        await incrementDaily('failed', trigger);
        await appendWatcherLog({ trigger, status: 'failed', reason: err?.message || String(err), page: typeof pagePick !== 'undefined' ? pagePick?.pickedPage : '' });
        return finish({ ok: false, reason: err?.message || String(err) });
      } finally {
        await appendWatcherTrace('perf_watcher_run', {
          reason: 'run_finish',
          trigger,
          durationMs: Date.now() - runPerfStartedAt,
          ok: runResult?.ok === true,
          resultReason: runResult?.reason || 'unknown'
        });
        await appendWatcherTrace('run_finish', { reason: 'finally', trigger });
        await recordRunFinish(trigger, runResult || { ok: false, reason: 'unknown' }).catch(() => {});
        if (trigger !== 'manual' && currentRunOpts) {
          await scheduleNextAssistAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, trigger).catch(() => {});
          await refreshAlarmAfterRun(currentRunOpts, runResult || { ok: false, reason: 'unknown' }, attempt, trigger).catch(() => {});
        }
        await restoreManualScheduleSnapshot().catch(() => {});
        await recordAttemptFinish(attempt, runResult || { ok: false, reason: 'unknown' }).catch(() => {});
        try { await writeDailyReports(); } catch (_) {}
        await flushWatcherLogs().catch(() => {});
        await flushWatcherTrace().catch(() => {});
        await clearCurrentListScan();
        stateRef.autoWatcherRunning = false;
        stateRef.autoWatcherStartedAt = 0;
      }
    }

    return { runAutoWatcherOnce };
  }

  globalThis.AblesciWatcherOrchestratorModule = {
    createWatcherOrchestratorApi
  };
})();
