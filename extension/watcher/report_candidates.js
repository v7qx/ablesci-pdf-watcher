'use strict';

// Candidate audit / state CSV builders, extracted from report.js to keep that
// file focused. Pure builders driven by injected formatting/i18n deps; used only
// by report.js's writeDailyReports. Output is byte-identical to the previous
// inline implementation.
(function () {
  function createWatcherCandidateReportApi(config) {
    const {
      makeCsv,
      formatBeijingDateTime,
      formatBeijingTimeOnly,
      reportJson,
      translateCandidateAuditPhase,
      translateReason
    } = config;

    function candidateDetailUrl(entry = {}) {
      if (entry.detailUrl) return entry.detailUrl;
      const assistId = String(entry.assistId || '').trim();
      return assistId ? `https://www.ablesci.com/assist/detail?id=${encodeURIComponent(assistId)}` : '';
    }
    function candidateListUrl(entry = {}) {
      const existing = entry.listUrl || entry.lastListUrl || '';
      if (existing) return existing;
      const urlKey = String(entry.urlKey || '').trim();
      const page = Number(entry.page || entry.lastPage || 0);
      if (!urlKey || !Number.isFinite(page) || page <= 0) return '';
      try {
        const u = new URL(urlKey);
        u.searchParams.set('page', String(Math.round(page)));
        return u.toString();
      } catch (_) {
        return '';
      }
    }
    function candidateRecentEventsText(entry = {}, isEn) {
      const events = Array.isArray(entry.recentEvents) ? entry.recentEvents : [];
      return events.map(event => {
        const time = event.time ? formatBeijingTimeOnly(event.time) : '';
        const phase = translateCandidateAuditPhase(event.phase || '', isEn);
        const reason = translateReason(event.reason || '', isEn);
        const page = event.page ? `p${event.page}` : '';
        return [time, page, phase, reason].filter(Boolean).join(' ');
      }).join(' | ');
    }

    function buildCandidateAuditCsv(candidateAudit, isEn) {
      const header = isEn
        ? ['Time', 'Trigger', 'Page', 'Order', 'Index', 'Publisher', 'Phase', 'Status', 'Reason', 'Assist ID', 'Journal', 'DOI', 'Assist Time', 'List URL', 'Detail URL', 'Details']
        : ['时间', '触发方式', '页码', '页序', '列表位置', '出版社', '阶段', '结果', '原因', '求助ID', '期刊', 'DOI', '求助时间', '列表页链接', '详情页链接', '细节'];
      const rows = [
        header,
        ...candidateAudit
          .slice()
          .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
          .map(entry => [
            formatBeijingDateTime(entry.time),
            entry.trigger || '',
            entry.page ?? '',
            entry.pageOrder || '',
            entry.listIndex ?? '',
            entry.publisherName || '',
            translateCandidateAuditPhase(entry.phase || '', isEn),
            entry.status || '',
            translateReason(entry.reason || '', isEn),
            entry.assistId || '',
            entry.journalShortName || entry.journalName || '',
            entry.doi || '',
            entry.assistTimeText || '',
            candidateListUrl(entry),
            candidateDetailUrl(entry),
            reportJson({
              assistAgeSeconds: entry.assistAgeSeconds ?? '',
              source: entry.source || '',
              urlKey: entry.urlKey || '',
              ...(entry.details && typeof entry.details === 'object' ? entry.details : {})
            })
          ])
      ];
      return makeCsv(rows);
    }

    function buildCandidateStateCsv(candidateAuditIndex, date, isEn) {
      const header = isEn
        ? ['First Seen', 'Last Update', 'Event Count', 'Assist ID', 'Journal', 'Publisher', 'Latest Phase', 'Latest Status', 'Latest Reason', 'First Page', 'Last Page', 'Pages', 'DOI', 'Assist Time', 'Last List URL', 'Detail URL', 'Recent Events']
        : ['首次看到', '最后更新', '事件数', '求助ID', '期刊', '出版社', '最新阶段', '最新结果', '最新原因', '首次页', '最后页', '出现页', 'DOI', '求助时间', '最后列表页链接', '详情页链接', '最近状态变化'];
      const rows = [
        header,
        ...candidateAuditIndex
          .filter(entry => entry?.assistId && formatBeijingDateTime(entry.lastAt, true) === date)
          .sort((a, b) => new Date(a.lastAt).getTime() - new Date(b.lastAt).getTime())
          .map(entry => [
            entry.firstSeenAt ? formatBeijingDateTime(entry.firstSeenAt) : '',
            entry.lastAt ? formatBeijingDateTime(entry.lastAt) : '',
            entry.eventCount ?? '',
            entry.assistId || '',
            entry.journalShortName || '',
            entry.publisherName || '',
            translateCandidateAuditPhase(entry.latestPhase || '', isEn),
            entry.latestStatus || '',
            translateReason(entry.latestReason || '', isEn),
            entry.firstPage || '',
            entry.lastPage || '',
            Array.isArray(entry.pages) ? entry.pages.join('|') : '',
            entry.doi || '',
            entry.assistTimeText || '',
            candidateListUrl(entry),
            candidateDetailUrl(entry),
            candidateRecentEventsText(entry, isEn)
          ])
      ];
      return { csv: makeCsv(rows), idCount: rows.length - 1 };
    }

    return { buildCandidateAuditCsv, buildCandidateStateCsv };
  }

  globalThis.AblesciWatcherCandidateReportModule = { createWatcherCandidateReportApi };
})();
