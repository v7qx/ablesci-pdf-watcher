'use strict';

// Responsibility: watcher candidate filtering, detail inspection, and queue consumption.
(function () {
  function createWatcherCandidateProcessorApi(config) {
    const {
      depsRef,
      getWatcherState,
      saveWatcherStateSafe,
      appendWatcherTrace,
      incrementDaily,
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
      removeQueuedCandidate,
      updateCurrentPageCandidateStatus
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

    function sourceKeyFromCandidate(candidate = {}, pagePick = {}) {
      return sourceKeyFromUrl(candidate.listUrl || pagePick.configuredUrl || pagePick.pickedListUrl || '');
    }

    async function recordJournalAccessListHit(journalAccess = {}, candidate = {}) {
      const cacheKey = String(journalAccess.cacheKey || '').trim();
      if (!cacheKey) return false;
      const state = await getWatcherState();
      const stats = state.journalAccessStats && typeof state.journalAccessStats === 'object' && !Array.isArray(state.journalAccessStats)
        ? state.journalAccessStats
        : {};
      const entry = stats[cacheKey];
      if (!entry || typeof entry !== 'object') return false;
      entry.hitCount = Math.max(0, Number(entry.hitCount || 0) || 0) + 1;
      entry.lastAt = new Date().toISOString();
      entry.lastAssistId = candidate.assistId || entry.lastAssistId || '';
      stats[cacheKey] = entry;
      state.journalAccessStats = stats;
      await saveWatcherStateSafe(state);
      return true;
    }

    function processedMeta(candidate = {}, payload = {}, pagePick = {}, page = '') {
      payload = payload && typeof payload === 'object' ? payload : {};
      return {
        assistAgeSeconds: candidate.assistAgeSeconds ?? payload.assistAgeSeconds ?? '',
        assistTimeText: candidate.assistTimeText || payload.assistTimeText || '',
        listUrl: candidate.listUrl || pagePick.pickedListUrl || pagePick.configuredUrl || '',
        page: page || candidate.page || pagePick.pickedPage || '',
        publisherName: candidate.publisherName || payload.publisherName || pagePick.publisher || '',
        publisher: pagePick.publisher || '',
        journalShortName: payload.journalShortName || candidate.journalShortName || ''
      };
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
      const totalStartedAt = Date.now();
      const stateForListFilter = await getWatcherState();
      const queueable = [];
      const journalBlockedSummary = { count: 0, examples: new Set(), journals: new Set(), page: pagePick.pickedPage || '' };
      const skippedReasonCounts = {};
      const list = Array.isArray(candidates) ? candidates : [];
      const loopStartedAt = Date.now();
      for (const rawCandidate of list) {
        const candidate = enrichCandidateJournalFromMap(rawCandidate, stateForListFilter);
        const listAllowed = isListCandidateAllowed(candidate, opts, stateForListFilter, blacklistedIds);
        if (listAllowed.ok) {
          queueable.push(candidate);
          continue;
        }
        skippedReasonCounts[listAllowed.reason] = Number(skippedReasonCounts[listAllowed.reason] || 0) + 1;
        if (listAllowed.reason === 'journal_blocked_rule') {
          await recordJournalAccessListHit(listAllowed.journalAccess, candidate).catch(() => false);
          journalBlockedSummary.count += 1;
          if (candidate.assistId) journalBlockedSummary.examples.add(candidate.assistId);
          const shortName = listAllowed.journalAccess?.shortName || candidate.journalShortName || '';
          if (shortName) journalBlockedSummary.journals.add(shortName);
        }
      }
      const filterLoopMs = Date.now() - loopStartedAt;
      const summaryStartedAt = Date.now();
      await appendJournalBlockedSummary(journalBlockedSummary, trigger);
      const appendSummaryMs = Date.now() - summaryStartedAt;
      if (Object.keys(skippedReasonCounts).length > 0) {
        await appendWatcherTrace('candidate_skip_list_filter_summary', {
          reason: 'list_filter_summary',
          trigger,
          pickedPage: pagePick.pickedPage || '',
          publisher: pagePick.publisher || '',
          skippedCount: Math.max(0, list.length - queueable.length),
          reasonCounts: skippedReasonCounts,
          source: 'list_page_refill'
        });
      }
      await appendWatcherTrace('perf_list_filter', {
        reason: 'list_filter_done',
        trigger,
        candidateCount: list.length,
        queueableCount: queueable.length,
        skippedCount: Math.max(0, list.length - queueable.length),
        journalBlockedCount: journalBlockedSummary.count,
        pickedPage: pagePick.pickedPage || '',
        publisher: pagePick.publisher || '',
        filterLoopMs,
        appendSummaryMs,
        skippedStateWrites: 'deferred',
        totalMs: Date.now() - totalStartedAt
      });
      return queueable;
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
        maxDetailAttempts = 0,
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
            journalShortName: candidate.journalShortName || '',
            assistTimeText: candidate.assistTimeText || '',
            assistAgeSeconds: candidate.assistAgeSeconds ?? '',
            journalAccess: listAllowed.journalAccess || null,
            source: 'list_page'
          });
          if (candidateKey) {
            await updateProcessed(candidateKey, 'skipped', listAllowed.reason, processedMeta(candidate, null, pagePick, candidatePage));
          }
          if (listAllowed.reason === 'journal_blocked_rule') {
            await recordJournalAccessListHit(listAllowed.journalAccess, candidate).catch(() => false);
            journalBlockedSummary.count += 1;
            if (candidate.assistId) journalBlockedSummary.examples.add(candidate.assistId);
            const shortName = listAllowed.journalAccess?.shortName || candidate.journalShortName || '';
            if (shortName) journalBlockedSummary.journals.add(shortName);
          }
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
            source: 'list_page'
          });
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
            source: 'list_page'
          });
          break;
        }
        detailAttempts += 1;
        await appendWatcherTrace('candidate_detail_start', {
          reason: 'candidate_passed_list_filter',
          trigger,
          detailUrl: candidate.detailUrl,
          assistId: candidate.assistId || '',
          source: 'list_page'
        });
        await updateCurrentPageCandidateStatus(candidate.assistId, 'processing', '检查详情页...');
        const detailStartedAt = Date.now();
        const detail = await inspectDetail(candidate);
        await appendWatcherTrace('perf_detail_inspect', {
          reason: detail.ok ? 'detail_inspect_ok' : 'detail_inspect_failed',
          trigger,
          durationMs: Date.now() - detailStartedAt,
          assistId: candidate.assistId || '',
          source: 'list_page',
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
          await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason, processedMeta(candidate, null, pagePick, candidatePage));
          await incrementDaily('failed', trigger);
          await appendWatcherLog({ ...candidate, trigger, status: 'failed', reason: detail.reason, page: candidatePage });
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
            source: 'list_page'
          });
          await closeTabQuietly(detail.tabId, 'detail_filter_skipped');
          await updateProcessed(key, 'skipped', detailAllowed.reason, processedMeta(candidate, payload, pagePick, candidatePage));
          await incrementDaily('skipped', trigger);
          await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, trigger, status: 'skipped', reason: detailAllowed.reason, page: candidatePage });
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
          source: 'list_page'
        });
        const handled = typeof handledResult === 'object' ? handledResult.handled === true : handledResult === true;
        if (!handled) await closeTabQuietly(detail.tabId, 'candidate_not_handled');
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
            source: 'list_page'
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

    return {
      queueableCandidatesFromList,
      processCandidateBatch
    };
  }

  globalThis.AblesciWatcherCandidateProcessorModule = {
    createWatcherCandidateProcessorApi
  };
})();
