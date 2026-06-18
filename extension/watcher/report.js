'use strict';

(function () {
  function createWatcherReportApi(config) {
    const {
      chromeApi,
      deps,
      normalizeOptions,
      todayKey,
      flushWatcherLogs,
      flushWatcherTrace,
      formatBeijingDateTime,
      formatBeijingTimeOnly,
      formatBeijingDateOnly,
      reportJson,
      getWatcherState,
      reportDir,
      nativeReportTimeoutMs,
      autoWatcherStateKey,
      autoWatcherLogKey,
      autoWatcherTraceKey,
      alarmName
    } = config;

    const CANDIDATE_AUDIT_KEY = 'autoWatcherCandidateAudit';
    const CANDIDATE_AUDIT_INDEX_KEY = 'autoWatcherCandidateAuditIndex';

    const { translateStep, translateReason, translateCandidateAuditPhase } = globalThis.AblesciWatcherReportI18n;

    function csvEscape(value) {
      let str = String(value ?? '');
      // Neutralize spreadsheet formula injection: a leading =, +, -, @, Tab or CR
      // makes Excel/WPS/Sheets evaluate the cell as a formula (e.g. =HYPERLINK / DDE).
      // Quote-wrapping does NOT prevent this (the app strips quotes first), so prefix
      // a single quote to force the value to be shown literally.
      if (/^[=+\-@\t\r]/.test(str)) {
        str = "'" + str;
      }
      return '"' + str.replace(/"/g, '""') + '"';
    }

    function makeCsv(rows) {
      return '\uFEFF' + rows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
    }

    // Candidate audit / state CSV builders live in watcher/report_candidates.js
    // (loaded before this module in background.js importScripts).
    const { buildCandidateAuditCsv, buildCandidateStateCsv } = globalThis.AblesciWatcherCandidateReportModule.createWatcherCandidateReportApi({
      makeCsv,
      formatBeijingDateTime,
      formatBeijingTimeOnly,
      reportJson,
      translateCandidateAuditPhase,
      translateReason
    });

    function dataUrl(content, mime) {
      return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
    }

    function formatMarkdownTableRow(cells) {
      const formatted = cells.map(value => {
        const raw = value || '';
        const str = String(raw).trim();
        return str !== '' ? ` ${str.replace(/\|/g, '\\|')} ` : ' ';
      });
      return `|${formatted.join('|')}|`;
    }

    function formatTraceDetail(details) {
      if (!details) return '';
      
      const assistId = details.assistId || '';
      const url = details.url || details.detailUrl || details.listUrl || '';
      
      let linkMarkdown = '';
      if (assistId) {
        const detailUrl = url || `https://www.ablesci.com/assist/detail?id=${assistId}`;
        linkMarkdown = `[${assistId}](${sanitizeReportUrl(detailUrl)})`;
      } else if (url) {
        const cleanUrl = sanitizeReportUrl(url);
        linkMarkdown = `[链接](${cleanUrl})`;
      }
      
      const parts = [];
      if (linkMarkdown) {
        parts.push(linkMarkdown);
      }
      
      const journalName = details.journalShortName || details.journal || details.journalName;
      if (journalName) {
        parts.push(journalName);
      }
      if (details.doi) {
        parts.push(details.doi);
      }
      if (details.title) {
        const cleanTitle = String(details.title).replace(/\s+相关领域.*$/, '').trim();
        parts.push(cleanTitle.length > 40 ? cleanTitle.slice(0, 40) + '...' : cleanTitle);
      }
      
      if (details.targetSessionSize !== undefined) parts.push(`目标大小: ${details.targetSessionSize}`);
      if (details.currentExecutionModel) parts.push(`执行模式: ${details.currentExecutionModel}`);
      if (details.checkedDelta !== undefined) parts.push(`检查变化: ${details.checkedDelta}`);
      if (details.downloadedDelta !== undefined) parts.push(`下载变化: ${details.downloadedDelta}`);
      
      if (parts.length > 0) {
        return parts.join(' | ');
      }
      
      if (details.reasonText) return details.reasonText;
      
      // Check if there is actual content
      const cleanKeys = Object.keys(details).filter(k => !['reason', 'sessionId', 'trigger', 'time', 'step'].includes(k));
      const hasRealContent = cleanKeys.some(k => {
        const val = details[k];
        return val !== undefined && val !== null && val !== '';
      });
      if (!hasRealContent) {
        return '无额外细节';
      }
      
      return reportJson(details).slice(0, 220);
    }

    function sanitizeReportUrl(value) {
      try {
        const url = new URL(value);
        for (const key of Array.from(url.searchParams.keys())) {
          if (/token|cookie|csrf|signature|credential|key|secret|auth/i.test(key)) {
            url.searchParams.set(key, '<redacted>');
          }
        }
        return url.href;
      } catch (_) {
        return String(value || '');
      }
    }

    function reportDetailValue(log) {
      if (log.detailUrl) return log.detailUrl;
      return `${log.detailUrlHostPath?.host || ''}${log.detailUrlHostPath?.path || ''}`;
    }

    function detailLink(value, isEn) {
      const raw = String(value || '');
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        return isEn ? `[View details](${raw})` : `[查看详情](${raw})`;
      }
      return raw;
    }

    function shortEventReason(reason, isEn) {
      const r = String(reason || '');
      if (r.includes('PDF 文件小于') || r.includes('smaller than')) {
        return isEn ? 'PDF too small, upload skipped.' : 'PDF 过小，未上传。';
      }
      if (r.includes('PDF 文件大于') || r.includes('larger than')) {
        return isEn ? 'PDF too large, upload skipped.' : 'PDF 过大，未上传。';
      }
      if (r.includes('已仅下载并校验 PDF') || r.includes('download_only')) {
        return isEn ? 'Downloaded only.' : '仅下载。';
      }
      return translateReason(r, isEn);
    }

    async function writeReportFile(filename, content, mime, opts) {
      if (opts.watcherDailyReportEnabled && deps.sendNativeMessage) {
        try {
          await deps.sendNativeMessage(opts.nativeHostName, {
            action: 'write_text_file',
            dir: opts.watcherReportDir || '',
            filename,
            content,
            extra: {
              perf_category: filename.endsWith('.csv') ? 'daily_report_csv' : 'daily_report_md'
            }
          }, nativeReportTimeoutMs);
          return;
        } catch (err) {
          console.warn('[Ablesci Auto Watcher] native report write failed', err);
          return;
        }
      }
      try {
        await chromeApi.downloads.download({
          url: dataUrl(content, mime),
          filename: `${reportDir}/${filename}`,
          conflictAction: 'overwrite',
          saveAs: false
        });
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] report download failed', err);
      }
    }

    async function writeDailyReports() {
      const opts = normalizeOptions(await deps.getOptions());
      if (!opts.watcherDailyReportEnabled) return;

      const date = todayKey();
      const lang = opts.watcherLanguage || 'auto';
      const isEn = (lang === 'en') || (lang === 'auto' && !(navigator.language || '').toLowerCase().startsWith('zh'));
      await flushWatcherLogs().catch(() => {});
      await flushWatcherTrace().catch(() => {});
      const stored = await chromeApi.storage.local.get([
        autoWatcherStateKey,
        autoWatcherLogKey,
        autoWatcherTraceKey,
        CANDIDATE_AUDIT_KEY,
        CANDIDATE_AUDIT_INDEX_KEY
      ]);
      const state = stored[autoWatcherStateKey] || {};
      const daily = state.daily?.[date] || {};
      const chromeAlarm = await chromeApi.alarms.get(alarmName).catch(() => null);
      const chromeAlarmScheduledAt = chromeAlarm?.scheduledTime ? new Date(chromeAlarm.scheduledTime).toISOString() : (state.chromeAlarmScheduledAt || '');
      const lastAttempt = state.lastAttempt || {};
      const latestPickedListUrl = lastAttempt.pickedListUrl || state.lastPickedListUrl || '';
      const latestPickedPage = lastAttempt.pickedPage ?? state.lastPickedPage ?? '';
      const latestPageMax = lastAttempt.pageMax ?? state.lastPickedPageMax ?? '';
      const logs = (Array.isArray(stored[autoWatcherLogKey]) ? stored[autoWatcherLogKey] : [])
        .filter(log => formatBeijingDateTime(log.time, true) === date);
      const traces = (Array.isArray(stored[autoWatcherTraceKey]) ? stored[autoWatcherTraceKey] : [])
        .filter(log => formatBeijingDateTime(log.time, true) === date);
      const candidateAudit = (Array.isArray(stored[CANDIDATE_AUDIT_KEY]) ? stored[CANDIDATE_AUDIT_KEY] : [])
        .filter(entry => formatBeijingDateTime(entry.time, true) === date);
      const candidateAuditIndex = stored[CANDIDATE_AUDIT_INDEX_KEY] && typeof stored[CANDIDATE_AUDIT_INDEX_KEY] === 'object' && !Array.isArray(stored[CANDIDATE_AUDIT_INDEX_KEY])
        ? Object.values(stored[CANDIDATE_AUDIT_INDEX_KEY])
        : [];
      const journalAccessStats = state.journalAccessStats && typeof state.journalAccessStats === 'object' && !Array.isArray(state.journalAccessStats)
        ? Object.values(state.journalAccessStats)
        : [];
      const cleanerResults = logs
        .map(log => log.pdfCleanerResult)
        .filter(result => result && result.enabled);
      const cleanerStats = cleanerResults.reduce((acc, result) => {
        const status = String(result.status || 'unknown');
        if (status === 'cleaned') {
          acc.cleaned += 1;
          acc.removed += Number(result.matched || 0);
        } else if (status === 'no_watermark') {
          acc.noWatermark += 1;
        } else {
          acc.failed += 1;
        }
        if (result.error) acc.errors.push(`${status}: ${result.error}`);
        return acc;
      }, { cleaned: 0, removed: 0, noWatermark: 0, failed: 0, errors: [] });
      function cleanerStatusText(result) {
        if (!result || !result.enabled) return '';
        const status = String(result.status || 'unknown');
        if (status === 'cleaned') return isEn ? `cleaned ${Number(result.matched || 0)}` : `已去除 ${Number(result.matched || 0)} 处`;
        if (status === 'no_watermark') return isEn ? 'no watermark' : '未检测到';
        return `${isEn ? 'failed' : '失败'}: ${result.error || result.errorCode || status}`;
      }

      const csvHeader = [
        'record_type', 'time', 'sessionId', 'assistId', 'doi', 'journalShortName', 'journalName', 'detailUrl', 'status', 'reason',
        'pdfCleanerStatus', 'pdfCleanerMatched', 'pdfCleanerEngine', 'pdfCleanerElapsedMs', 'pdfCleanerError', 'pdfCleanerOriginalPath', 'pdfCleanerCleanedPath',
        'publisher',
        'range', 'absMove', 'sampleCount', 'validSampleCount', 'workTimeProgressRatio', 'expectedDone', 'actualDone',
        'targetError', 'activeTimeProgressRatio', 'availabilityFactor',
        'riskUsed', 'riskLimit',
        'score', 'estimatedSuccessRate',
        'currentStrategy', 'nextAssistRunAt', 'nextAssistStrategy', 'nextAssistReason', 'nextAssistDelayMinutes',
        'nextAssistModelDelayMinutes', 'nextAssistGuardMinutes', 'nextAssistGuardMode', 'nextAssistGuardLiftMinutes',
        'nextAssistGuardWeight', 'nextAssistPlannedAt', 'nextWakeAt', 'chromeAlarmScheduledAt',
        'lastAttemptStartedAt', 'lastAttemptFinishedAt', 'lastAttemptResult', 'lastAttemptObserveSnapshot',
        'lastAttemptTargetSessionSize', 'lastAttemptCheckedDelta', 'lastAttemptDownloadedDelta',
        'lastAttemptListScanStarted', 'lastAttemptPickedListUrl', 'pickedPage', 'pageCurve', 'pageMin', 'pageMax',
        'parsedListPages', 'backoffSkippedPages',
        'pageFrontHit', 'pageAlpha', 'step', 'trigger', 'tabId', 'url', 'details'
      ];
      const baseReportFields = {
        workTimeProgressRatio: state.workTimeProgressRatio || '',
        expectedDone: state.expectedDone || '',
        actualDone: state.actualDone || state.monthDone || '',
        targetError: state.targetError || state.lag || '',
        activeTimeProgressRatio: state.activeTimeProgressRatio || '',
        availabilityFactor: state.availabilityFactor || '',
        riskUsed: daily.riskUsed || state.riskUsed || '',
        riskLimit: state.riskLimit || '',
        currentStrategy: state.lastAssistStrategy || state.currentExecutionModel || '',
        nextAssistRunAt: state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : '',
        nextAssistStrategy: state.nextAssistStrategy || '',
        nextAssistReason: translateReason(state.nextAssistReason || '', isEn),
        nextAssistDelayMinutes: state.nextAssistDelayMinutes || '',
        nextAssistModelDelayMinutes: state.nextAssistModelDelayMinutes || '',
        nextAssistGuardMinutes: state.nextAssistGuardMinutes || '',
        nextAssistGuardMode: state.nextAssistGuardMode || '',
        nextAssistGuardLiftMinutes: state.nextAssistGuardLiftMinutes || '',
        nextAssistGuardWeight: state.nextAssistGuardWeight || '',
        nextAssistPlannedAt: state.nextAssistPlannedAt ? formatBeijingDateTime(state.nextAssistPlannedAt) : '',
        nextWakeAt: chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : ''),
        chromeAlarmScheduledAt: chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : '',
        lastAttemptStartedAt: lastAttempt.startedAt ? formatBeijingDateTime(lastAttempt.startedAt) : '',
        lastAttemptFinishedAt: lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : '',
        lastAttemptResult: translateReason(lastAttempt.resultReason || '', isEn),
        lastAttemptTargetSessionSize: lastAttempt.targetSessionSize ?? '',
        lastAttemptCheckedDelta: lastAttempt.checkedDelta ?? '',
        lastAttemptDownloadedDelta: lastAttempt.downloadedDelta ?? '',
        lastAttemptListScanStarted: lastAttempt.listScanStarted === true ? 'true' : '',
        lastAttemptPickedListUrl: latestPickedListUrl,
        pickedPage: latestPickedPage,
        pageCurve: lastAttempt.pageCurve || '',
        pageMin: lastAttempt.pageMin ?? '',
        pageMax: latestPageMax,
        parsedListPages: lastAttempt.parsedListPages || '',
        backoffSkippedPages: lastAttempt.backoffSkippedPages || '',
        pageFrontHit: lastAttempt.frontHit === true ? 'true' : '',
        pageAlpha: lastAttempt.alpha ?? ''
      };
      function reportRow(type, values = {}) {
        const row = { record_type: type, ...baseReportFields, ...values };
        return csvHeader.map(key => row[key] ?? '');
      }
      const traceSkipSteps = new Set([
        'candidate_skip_list_filter',
        'candidate_skip_processed',
        'candidate_skip_detail_filter',
        'candidate_queue_seen_skipped'
      ]);
      function traceDetailUrlValue(details = {}, trace = {}) {
        const value = details.detailUrl || details.url || details.listUrl || trace.url || '';
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
          const host = value.host || '';
          const path = value.path || '';
          if (host || path) return `${host}${path}`;
        }
        return '';
      }
      function traceAssistIdValue(details = {}) {
        return String(details.assistId || '');
      }
      function simplifyDecisionDetail(row) {
        const reason = String(row?.reason || '');
        const detail = String(row?.detail || '');
        if (/本轮命中本地期刊规则|Local journal rule matches grouped/i.test(reason)) {
          const match = detail.match(/命中本地期刊规则\s*(\d+)\s*条/i) || detail.match(/(\d+)/);
          if (match) return isEn ? `Matched local journal rules: ${match[1]} items` : `命中本地期刊规则 ${match[1]} 条`;
          return isEn ? 'Matched local journal rules' : '命中本地期刊规则';
        }
        return detail;
      }
      const csvRows = [
        csvHeader,
        reportRow('summary', {
          time: formatBeijingDateTime(new Date()),
          status: state.currentExecutionModel || state.schedulerModelMode || 'simple',
          reason: `runs=${Number(daily.totalRuns || 0)} auto=${Number(daily.autoRuns || 0)} manual=${Number(daily.manualRuns || 0)} checked=${Number(daily.checked || 0)} downloaded=${Number(daily.downloaded || 0)} failed=${Number(daily.failed || 0)}`
        }),
        reportRow('assist_strategy', {
          time: state.lastAssistDecisionAt ? formatBeijingDateTime(state.lastAssistDecisionAt) : formatBeijingDateTime(new Date()),
          status: state.lastAssistStrategy || '',
          reason: reportJson(state.lastAssistDecision || {})
        }),
        reportRow('next_assist', {
          time: state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : '',
          status: state.nextAssistStrategy || '',
          reason: reportJson(state.nextAssistPlan || {})
        }),
        reportRow('last_attempt', {
          time: lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : '',
          status: translateReason(lastAttempt.resultReason || '', isEn),
          reason: reportJson(lastAttempt || {}),
          trigger: lastAttempt.trigger || '',
          url: latestPickedListUrl
        }),
        ...logs.map(log => reportRow('log', {
          time: formatBeijingDateTime(log.time),
          sessionId: log.sessionId || '',
          trigger: log.trigger || '',
          assistId: log.assistId || '',
          doi: log.doi || '',
          journalShortName: log.journalShortName || '',
          journalName: log.journalName || '',
          detailUrl: reportDetailValue(log),
          status: translateStep(log.status || '', isEn),
          reason: translateReason(log.reason || '', isEn),
          pdfCleanerStatus: log.pdfCleanerResult?.status || '',
          pdfCleanerMatched: log.pdfCleanerResult?.matched ?? '',
          pdfCleanerEngine: log.pdfCleanerResult?.engine || '',
          pdfCleanerElapsedMs: log.pdfCleanerResult?.elapsedMs ?? '',
          pdfCleanerError: log.pdfCleanerResult?.error || log.pdfCleanerResult?.errorCode || '',
          pdfCleanerOriginalPath: log.pdfCleanerResult?.preservedOriginalPath || '',
          pdfCleanerCleanedPath: log.pdfCleanerResult?.preservedCleanedPath || ''
        })),
        ...traces
          .filter(trace => traceSkipSteps.has(String(trace.step || '')) && trace.details)
          .map(trace => {
            const details = trace.details || {};
            return reportRow('trace_skip', {
              time: formatBeijingDateTime(trace.time),
              sessionId: trace.sessionId || details.sessionId || '',
              trigger: trace.trigger || details.trigger || '',
              assistId: traceAssistIdValue(details),
              doi: details.doi || '',
              journalShortName: details.journalShortName || details.journal || '',
              journalName: details.journalName || '',
              detailUrl: traceDetailUrlValue(details, trace),
              status: translateStep(trace.step || '', isEn),
              reason: translateReason(trace.reason || details.reason || '', isEn),
              step: trace.step || '',
              tabId: trace.tabId || details.tabId || '',
              url: traceDetailUrlValue(details, trace),
              details: reportJson(details)
            });
          }),
        ...journalAccessStats.map(entry => reportRow('journal_access_cache', {
          time: entry.lastAt ? formatBeijingDateTime(entry.lastAt) : '',
          assistId: entry.lastAssistId || '',
          journalShortName: entry.shortName || '',
          status: 'cached',
          reason: entry.reason || '',
          publisher: entry.publisher || '',
          details: reportJson({
            hitCount: Number(entry.hitCount || 0) || 0,
            expiresAt: entry.expiresAt || ''
          })
        }))
      ];
      const csv = makeCsv(csvRows);
      const candidateAuditCsv = buildCandidateAuditCsv(candidateAudit, isEn);
      const { csv: candidateStateCsv, idCount: candidateStateIdCount } = buildCandidateStateCsv(candidateAuditIndex, date, isEn);
      const skipDecisionRows = [
        ...logs
          .filter(log => String(log.status) === 'skipped' || String(log.status) === 'failed')
          .map(log => {
            const cleanDetail = reportDetailValue(log) || log.journalName || log.doi || '';
            let formattedDetail = cleanDetail;
            if (cleanDetail.startsWith('http://') || cleanDetail.startsWith('https://')) {
              formattedDetail = isEn ? `[Click for details](${cleanDetail})` : `[点击查看详情](${cleanDetail})`;
            }
            return {
              time: log.time,
              trigger: log.trigger || '',
              step: translateStep(log.status || '', isEn),
              reason: translateReason(log.reason || '', isEn),
              detail: formattedDetail
            };
          }),
        ...traces
          .filter(trace => {
            const textToTest = `${trace.step || ''} ${trace.reason || ''}`;
            return /skip|not_due|zero|outside|limit|risk|no_candidate/i.test(textToTest)
              && !/passed|start|allowed|success|done|running/i.test(textToTest);
          })
          .map(trace => ({
            time: trace.time,
            trigger: trace.trigger || '',
            step: translateStep(trace.step || '', isEn),
            reason: translateReason(trace.reason || '', isEn),
            detail: formatTraceDetail(trace.details)
          }))
      ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 30);

      const monthDir = date.slice(0, 7);
      const reportStem = `${monthDir}/${date}`;
      const isTraceCompact = opts.watcherTraceLevel === 'compact' || opts.watcherTraceLevel === 'off';
      const summaryLines = isTraceCompact ? (isEn ? [
        `- Run Count (Auto / Manual): ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)}`,
        `- Latest Selected List Link: ${latestPickedListUrl ? `[Click here](${latestPickedListUrl})` : 'None'}`,
        `- Monthly Assists (Expected / Actual / Deficit): ${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.targetError || state.lag || 0)}`,
        `- Risk Budget Used today / Limit: ${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`,
        `- Target Assists Today: ${Number(state.todayTarget || 0)}`
      ] : [
        `- 运行次数 (自动 / 手动): ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)}`,
        `- 最近一次选中的列表页链接: ${latestPickedListUrl ? `[点击跳转](${latestPickedListUrl})` : '无'}`,
        `- 当月应助任务 (预计 / 实际 / 差额): ${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.targetError || state.lag || 0)}`,
        `- 今日已用风险预算 / 上限: ${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`,
        `- 今日应助目标数: ${Number(state.todayTarget || 0)}`
      ]) : (isEn ? [
        `- Checked Candidate Count: ${Number(daily.checked || 0)}`,
        `- Downloaded or Queued Count: ${Number(daily.downloaded || 0)}`,
        `- Successfully Uploaded Count: ${Number(daily.uploaded || 0)}`,
        `- Skipped Candidate Count: ${Number(daily.skipped || 0)}`,
        `- Failed Task Count: ${Number(daily.failed || 0)}`,
        `- Notifications Sent: ${Number(daily.notified || 0)}`,
        `- Scheduler: ${state.lastAssistStrategy || state.currentExecutionModel || state.schedulerModelMode || 'simple'}`,
        `- Next Wake Time: ${chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : '')}`,
        `- Next Assist Attempt Time: ${state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : ''}`,
        `- Next Assist Strategy & Reason: ${state.nextAssistStrategy || ''} / ${translateReason(state.nextAssistReason || '', isEn)}`,
        `- Run Count (Auto / Manual): ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)}`,
        `- Latest Run Trigger & Result: trigger=${state.lastRunTrigger || ''}, result=${translateReason(state.lastRunResult?.reason || '', isEn)}`,
        `- Latest Attempt Time: ${lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : ''}`,
        `- Latest Attempt Trigger: ${lastAttempt.trigger || ''}`,
        `- Latest Attempt Execution Result: ${translateReason(lastAttempt.resultReason || '', isEn)}`,
        `- Latest Session Target Downloads: ${lastAttempt.targetSessionSize ?? ''}`,
        `- Latest Checked Paper Delta: ${lastAttempt.checkedDelta ?? ''}`,
        `- Latest Downloaded Paper Delta: ${lastAttempt.downloadedDelta ?? ''}`,
        `- Latest List Scan Triggered: ${lastAttempt.listScanStarted === true ? 'Yes' : 'No'}`,
        `- Latest Selected List Link: ${latestPickedListUrl ? `[Link](${latestPickedListUrl})` : ''}`,
        `- Latest Parsed List Pages: ${lastAttempt.parsedListPages || ''}`,
        `- Latest Backoff-Skipped Pages: ${lastAttempt.backoffSkippedPages || ''}`,
        `- Monthly Assists (Expected / Actual / Deficit): ${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.targetError || state.lag || 0)}`,
        `- Risk Events today / Threshold: ${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`,
        `- Target Assists Today: ${Number(state.todayTarget || 0)}`,
        `- Details File: ${monthDir}/watcher-data-${date}.jsonl`,
        `- Trace Event Count: ${traces.length}`
      ] : [
        `- 已检查候选数: ${Number(daily.checked || 0)}`,
        `- 下载或排队数: ${Number(daily.downloaded || 0)}`,
        `- 成功上传数: ${Number(daily.uploaded || 0)}`,
        `- 已跳过候选数: ${Number(daily.skipped || 0)}`,
        `- 失败任务数: ${Number(daily.failed || 0)}`,
        `- 发送通知数: ${Number(daily.notified || 0)}`,
        `- 调度策略: ${state.lastAssistStrategy || state.currentExecutionModel || state.schedulerModelMode || 'simple'}`,
        `- 下一次唤醒时间: ${chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : '')}`,
        `- 下一次应助尝试时间: ${state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : ''}`,
        `- 下一次应助策略及原因: ${state.nextAssistStrategy || ''} / ${translateReason(state.nextAssistReason || '', isEn)}`,
        `- 运行次数 (自动 / 手动): ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)}`,
        `- 最近一次运行原因与结果: 触发方式=${state.lastRunTrigger || ''}, 结果=${translateReason(state.lastRunResult?.reason || '', isEn)}`,
        `- 最近一次尝试时间: ${lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : ''}`,
        `- 最近一次尝试触发方式: ${lastAttempt.trigger || ''}`,
        `- 最近一次尝试执行结果: ${translateReason(lastAttempt.resultReason || '', isEn)}`,
        `- 最近一次会话目标下载数: ${lastAttempt.targetSessionSize ?? ''}`,
        `- 最近一次检查文献增量: ${lastAttempt.checkedDelta ?? ''}`,
        `- 最近一次下载文献增量: ${lastAttempt.downloadedDelta ?? ''}`,
        `- 最近一次是否启动列表扫描: ${lastAttempt.listScanStarted === true ? '是' : '否'}`,
        `- 最近一次选中的列表页链接: ${latestPickedListUrl ? `[点击跳转](${latestPickedListUrl})` : ''}`,
        `- 最近一次实际解析页: ${lastAttempt.parsedListPages || ''}`,
        `- 最近一次冷却跳过页: ${lastAttempt.backoffSkippedPages || ''}`,
        `- 当月应助任务 (预计 / 实际 / 差额): ${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.targetError || state.lag || 0)}`,
        `- 今日风险事件累计 / 阈值: ${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`,
        `- 今日应助目标数: ${Number(state.todayTarget || 0)}`,
        `- 详细事件数据 file: ${monthDir}/watcher-data-${date}.jsonl`,
        `- Trace 事件记录数: ${traces.length}`
      ]);
      summaryLines.push(
        ...(isEn ? [
          `- Candidate Audit CSV: ${monthDir}/${date}-candidate-audit.csv (${candidateAudit.length} rows)`,
          `- Candidate State CSV: ${monthDir}/${date}-candidate-state.csv (${candidateStateIdCount} IDs)`,
          ...(cleanerStats.failed > 0 ? [`- PDF Cleaner Errors: ${cleanerStats.errors.slice(0, 5).join(' | ') || cleanerStats.failed}`] : [])
        ] : [
          `- 候选审计 CSV: ${monthDir}/${date}-candidate-audit.csv（${candidateAudit.length} 行）`,
          `- 候选状态 CSV: ${monthDir}/${date}-candidate-state.csv（${candidateStateIdCount} 个 ID）`,
          ...(cleanerStats.failed > 0 ? [`- PDF 去水印错误: ${cleanerStats.errors.slice(0, 5).join(' | ') || cleanerStats.failed}`] : [])
        ])
      );

      const sizeInterceptedLogs = logs.filter(log => {
        const r = String(log.reason || '');
        return r.includes('PDF 文件小于') || r.includes('PDF 文件大于') || r.includes('smaller than') || r.includes('larger than');
      });
      const sizeInterceptedLines = [];
      if (sizeInterceptedLogs.length > 0) {
        sizeInterceptedLines.push(
          isEn ? '## File Size Intercepted' : '## 文件大小拦截记录',
          '',
          isEn
            ? '| Time | DOI | Journal | Reason | Detail |'
            : '| 时间 | DOI | 期刊 (Journal) | 拦截原因 (Reason) | 详情 (Detail) |',
          '| --- | --- | --- | --- | --- |',
          ...sizeInterceptedLogs.map(log => {
            const detailVal = detailLink(reportDetailValue(log), isEn);
            return formatMarkdownTableRow([
              formatBeijingTimeOnly(log.time),
              log.doi || '',
              log.journalName || '',
              translateReason(log.reason || '', isEn),
              detailVal
            ]);
          }),
          ''
        );
      }

      const doiNotFoundLogs = logs.filter(log => {
        const r = String(log.reason || '');
        const lower = r.toLowerCase();
        return lower.includes('doi_not_found') ||
          lower.includes('doi_resolution_failed') ||
          lower.includes('doi not found') ||
          lower.includes('doi resolution failed') ||
          lower.includes('invalid doi') ||
          r.includes('DOI 解析失败') ||
          r.includes('DOI 不存在') ||
          r.includes('DOI未找到') ||
          r.includes('DOI 未找到');
      });
      const doiNotFoundLines = [];
      if (doiNotFoundLogs.length > 0) {
        doiNotFoundLines.push(
          isEn ? '## DOI Not Found Record' : '## DOI Not Found / 解析失败记录',
          '',
          isEn
            ? '| Time | DOI | Journal | Reason | Detail |'
            : '| 时间 | DOI | 期刊 (Journal) | 拦截原因 (Reason) | 详情 (Detail) |',
          '| --- | --- | --- | --- | --- |',
          ...doiNotFoundLogs.map(log => {
            const detailVal = detailLink(reportDetailValue(log), isEn);
            return formatMarkdownTableRow([
              formatBeijingTimeOnly(log.time),
              log.doi || '',
              log.journalName || '',
              translateReason(log.reason || '', isEn),
              detailVal
            ]);
          }),
          ''
        );
      }

      const cleanerErrorLogs = logs.filter(log => {
        const result = log.pdfCleanerResult;
        if (!result || !result.enabled) return false;
        const status = String(result.status || '');
        return status === 'error' || status === 'failed' || !!result.error || !!result.errorCode;
      });
      const cleanerErrorLines = [];
      if (cleanerErrorLogs.length > 0) {
        cleanerErrorLines.push(
          isEn ? '## PDF Cleaner Errors' : '## PDF 去水印错误记录',
          '',
          isEn
            ? '| Time | DOI | Journal | Error | Detail | Date |'
            : '| 时间 | DOI | 期刊 (Journal) | 错误 (Error) | 详情 (Detail) | 日期 |',
          '| --- | --- | --- | --- | --- | --- |',
          ...cleanerErrorLogs.map(log => {
            const result = log.pdfCleanerResult || {};
            const errorText = result.error || result.errorCode || result.status || '';
            return formatMarkdownTableRow([
              formatBeijingTimeOnly(log.time),
              log.doi || '',
              log.journalName || '',
              errorText,
              detailLink(reportDetailValue(log), isEn),
              formatBeijingDateOnly(log.time)
            ]);
          }),
          ''
        );
      }

      const md = [
        isEn ? `# Ablesci Watcher Daily Report ${date}` : `# 科研通值守日报 ${date}`,
        '',
        '## Summary',
        '',
        ...summaryLines,
        '',
        ...sizeInterceptedLines,
        ...doiNotFoundLines,
        ...cleanerErrorLines,
        '## Skips And Decisions',
        '',
        isEn ? '| Time | Trigger | Step | Reason | Detail | Date |' : '| 时间 | 触发方式 | 步骤 (Step) | 原因 (Reason) | 详情 (Detail) | 日期 |',
        '| --- | --- | --- | --- | --- | --- |',
        ...skipDecisionRows.map(row => formatMarkdownTableRow([
          formatBeijingTimeOnly(row.time),
          row.trigger === 'alarm' ? (isEn ? 'Auto' : '自动') : (row.trigger === 'manual' ? (isEn ? 'Manual' : '手动') : row.trigger),
          row.step,
          row.reason,
          simplifyDecisionDetail(row),
          formatBeijingDateOnly(row.time)
        ])),
        '',
        '## Recent Events',
        '',
        isEn ? '| Time | Trigger | Status | Reason | Journal | DOI | Detail | Date |' : '| 时间 | 触发方式 | 状态 (Status) | 原因 (Reason) | 期刊 (Journal) | DOI | 详情 (Detail) | 日期 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...logs.filter(log => log.status === 'success')
          .slice()
          .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
          .slice(0, 30)
          .map(log => {
          const detailVal = detailLink(reportDetailValue(log), isEn);
          return formatMarkdownTableRow([
            formatBeijingTimeOnly(log.time),
            log.trigger === 'alarm' ? (isEn ? 'Auto' : '自动') : (log.trigger === 'manual' ? (isEn ? 'Manual' : '手动') : log.trigger),
            translateStep(log.status || '', isEn),
            shortEventReason(log.reason || '', isEn),
            log.journalName || '',
            log.doi || '',
            detailVal,
            formatBeijingDateOnly(log.time)
          ]);
        }),
        ''
      ].map(line => line.trimEnd()).join('\n');

      await writeReportFile(`${reportStem}.csv`, csv, 'text/csv', opts);
      await writeReportFile(`${reportStem}-candidate-audit.csv`, candidateAuditCsv, 'text/csv', opts);
      await writeReportFile(`${reportStem}-candidate-state.csv`, candidateStateCsv, 'text/csv', opts);
      await writeReportFile(`${reportStem}.md`, md, 'text/markdown', opts);
      // PRIVATE_WATCHER_ONLY: skipped writing .jsonl file to optimize disk space
    }

    return {
      sanitizeReportUrl,
      reportDetailValue,
      writeReportFile,
      writeDailyReports
    };
  }

  globalThis.AblesciWatcherReportModule = {
    createWatcherReportApi
  };
})();
