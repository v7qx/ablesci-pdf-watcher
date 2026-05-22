'use strict';

(function () {
  function createWatcherReportApi(config) {
    const {
      chromeApi,
      deps,
      normalizeOptions,
      hydrateJournalAccessRulesFromConfig,
      todayKey,
      flushWatcherLogs,
      flushWatcherTrace,
      formatBeijingDateTime,
      formatBeijingTimeOnly,
      formatBeijingDateOnly,
      reportJson,
      reportValueForJson,
      getWatcherState,
      journalAccessStatsIndexFromStats,
      parseJournalAccessRules,
      reportDir,
      nativeReportTimeoutMs,
      autoWatcherStateKey,
      autoWatcherLogKey,
      autoWatcherTraceKey,
      demandSnapshotsKey,
      journalAccessStatsKey,
      alarmName,
      doiFailureSkipThreshold
    } = config;

    function csvEscape(value) {
      return '"' + String(value ?? '').replace(/"/g, '""') + '"';
    }

    function dataUrl(content, mime) {
      return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
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

    async function writeReportFile(filename, content, mime, opts) {
      if (opts.watcherDailyReportEnabled && deps.sendNativeMessage) {
        try {
          await deps.sendNativeMessage(opts.nativeHostName, {
            action: 'write_text_file',
            dir: opts.watcherReportDir || '',
            filename,
            content
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
      let opts = normalizeOptions(await deps.getOptions());
      opts = await hydrateJournalAccessRulesFromConfig(opts);
      if (!opts.watcherDailyReportEnabled) return;

      const date = todayKey();
      await flushWatcherLogs().catch(() => {});
      await flushWatcherTrace().catch(() => {});
      const stored = await chromeApi.storage.local.get([
        autoWatcherStateKey,
        autoWatcherLogKey,
        autoWatcherTraceKey,
        demandSnapshotsKey,
        journalAccessStatsKey
      ]);
      const state = stored[autoWatcherStateKey] || {};
      const daily = state.daily?.[date] || {};
      const chromeAlarm = await chromeApi.alarms.get(alarmName).catch(() => null);
      const chromeAlarmScheduledAt = chromeAlarm?.scheduledTime ? new Date(chromeAlarm.scheduledTime).toISOString() : (state.chromeAlarmScheduledAt || '');
      const lastAttempt = state.lastAttempt || {};
      const demandSnapshots = (Array.isArray(stored[demandSnapshotsKey]) ? stored[demandSnapshotsKey] : [])
        .filter(item => item.dayKey === date);
      const logs = (Array.isArray(stored[autoWatcherLogKey]) ? stored[autoWatcherLogKey] : [])
        .filter(log => formatBeijingDateTime(log.time, true) === date);
      const traces = (Array.isArray(stored[autoWatcherTraceKey]) ? stored[autoWatcherTraceKey] : [])
        .filter(log => formatBeijingDateTime(log.time, true) === date);
      const journalAccessStats = stored[journalAccessStatsKey] || {};

      const csvHeader = [
        'record_type', 'time', 'sessionId', 'assistId', 'doi', 'journalName', 'detailUrl', 'status', 'reason',
        'marketRegime', 'totalSeeking', 'supplementCount', 'publisher', 'open', 'high', 'low', 'close', 'delta',
        'range', 'absMove', 'sampleCount', 'validSampleCount', 'workTimeProgressRatio', 'expectedDone', 'actualDone',
        'targetError', 'activeTimeProgressRatio', 'availabilityFactor', 'availabilityActualWakeCount', 'availabilityExpectedWakeCount',
        'rateMultiplier', 'riskUsed', 'riskLimit', 'sessionSize', 'sessionHandledCount',
        'sessionDurationMs', 'score', 'estimatedSuccessRate', 'demandPressure', 'sourceTrend',
        'currentStrategy', 'nextAssistRunAt', 'nextAssistStrategy', 'nextAssistReason', 'nextAssistDelayMinutes',
        'nextAssistModelDelayMinutes', 'nextAssistGuardMinutes', 'nextAssistGuardMode', 'nextAssistGuardLiftMinutes',
        'nextAssistGuardWeight', 'nextAssistPlannedAt', 'nextAssistMarketDataAt', 'nextWakeAt', 'chromeAlarmScheduledAt',
        'lastAttemptStartedAt', 'lastAttemptFinishedAt', 'lastAttemptResult', 'lastAttemptObserveSnapshot',
        'lastAttemptTargetSessionSize', 'lastAttemptCheckedDelta', 'lastAttemptDownloadedDelta',
        'lastAttemptListScanStarted', 'lastAttemptPickedListUrl', 'pickedPage', 'pageCurve', 'pageMin', 'pageMax',
        'pageFrontHit', 'pageAlpha', 'randomSessionPicked', 'randomSessionFinalSize',
        'randomValue', 'step', 'trigger', 'tabId', 'url', 'details'
      ];
      const baseReportFields = {
        marketRegime: state.marketRegime || state.marketData?.marketRegime || state.demandRegime || '',
        workTimeProgressRatio: state.workTimeProgressRatio || '',
        expectedDone: state.expectedDone || '',
        actualDone: state.actualDone || state.monthDone || '',
        targetError: state.targetError || state.lag || '',
        activeTimeProgressRatio: state.activeTimeProgressRatio || '',
        availabilityFactor: state.availabilityFactor || '',
        availabilityActualWakeCount: state.availabilityActualWakeCount || '',
        availabilityExpectedWakeCount: state.availabilityExpectedWakeCount || '',
        rateMultiplier: state.rateMultiplier || '',
        riskUsed: daily.riskUsed || state.riskUsed || '',
        riskLimit: state.riskLimit || '',
        sessionSize: state.lastSession?.targetSessionSize || '',
        sessionHandledCount: state.lastSession?.handledCount || '',
        sessionDurationMs: state.lastSession?.sessionDurationMs || '',
        currentStrategy: state.lastAssistStrategy || state.currentExecutionModel || '',
        nextAssistRunAt: state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : '',
        nextAssistStrategy: state.nextAssistStrategy || '',
        nextAssistReason: state.nextAssistReason || '',
        nextAssistDelayMinutes: state.nextAssistDelayMinutes || '',
        nextAssistModelDelayMinutes: state.nextAssistModelDelayMinutes || '',
        nextAssistGuardMinutes: state.nextAssistGuardMinutes || '',
        nextAssistGuardMode: state.nextAssistGuardMode || '',
        nextAssistGuardLiftMinutes: state.nextAssistGuardLiftMinutes || '',
        nextAssistGuardWeight: state.nextAssistGuardWeight || '',
        nextAssistPlannedAt: state.nextAssistPlannedAt ? formatBeijingDateTime(state.nextAssistPlannedAt) : '',
        nextAssistMarketDataAt: state.nextAssistPlanningData?.marketDataAt ? formatBeijingDateTime(state.nextAssistPlanningData.marketDataAt) : '',
        nextWakeAt: chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : ''),
        chromeAlarmScheduledAt: chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : '',
        lastAttemptStartedAt: lastAttempt.startedAt ? formatBeijingDateTime(lastAttempt.startedAt) : '',
        lastAttemptFinishedAt: lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : '',
        lastAttemptResult: lastAttempt.resultReason || '',
        lastAttemptObserveSnapshot: lastAttempt.observeSnapshot === true ? 'true' : '',
        lastAttemptTargetSessionSize: lastAttempt.targetSessionSize ?? '',
        lastAttemptCheckedDelta: lastAttempt.checkedDelta ?? '',
        lastAttemptDownloadedDelta: lastAttempt.downloadedDelta ?? '',
        lastAttemptListScanStarted: lastAttempt.listScanStarted === true ? 'true' : '',
        lastAttemptPickedListUrl: lastAttempt.pickedListUrl || '',
        pickedPage: lastAttempt.pickedPage ?? '',
        pageCurve: lastAttempt.pageCurve || '',
        pageMin: lastAttempt.pageMin ?? '',
        pageMax: lastAttempt.pageMax ?? '',
        pageFrontHit: lastAttempt.frontHit === true ? 'true' : '',
        pageAlpha: lastAttempt.alpha ?? '',
        randomSessionPicked: lastAttempt.randomSessionPicked ?? '',
        randomSessionFinalSize: lastAttempt.randomSessionFinalSize ?? '',
        randomValue: lastAttempt.randomValue ?? ''
      };
      function reportRow(type, values = {}) {
        const row = { record_type: type, ...baseReportFields, ...values };
        return csvHeader.map(key => row[key] ?? '');
      }
      function jsonLine(type, value = {}) {
        return JSON.stringify(reportValueForJson({
          record_type: type,
          exportedAt: new Date().toISOString(),
          dayKey: date,
          ...value
        }));
      }
      const observeEvents = traces
        .filter(trace => /observe_|market_sample|demand_snapshot/i.test(`${trace.step || ''} ${trace.reason || ''}`))
        .map(trace => reportRow('observe_event', {
          time: formatBeijingDateTime(trace.time),
          status: trace.step || '',
          reason: trace.reason || '',
          trigger: trace.trigger || '',
          url: trace.url || `${trace.urlHostPath?.host || ''}${trace.urlHostPath?.path || ''}`
        }));
      const dataRows = [
        ...demandSnapshots.map(item => jsonLine('market_sample', item)),
        ...['m15', 'h1', 'd1'].flatMap(frame => (state.marketData?.candles?.[frame] || []).map(candle => jsonLine(`candle_${frame}`, candle))),
        ...logs.map(log => jsonLine('assist_event', log)),
        ...traces.map(trace => jsonLine('trace', trace)),
        ...Object.entries(journalAccessStats).map(([journalName, item]) => jsonLine('journal_access_stat', { journalName, ...item }))
      ];
      const detailJsonl = dataRows.join('\n') + (dataRows.length ? '\n' : '');
      const journalAccessItems = Object.entries(journalAccessStats || {}).map(([journalName, item]) => ({
        journalName,
        accessState: item?.accessState || 'unknown',
        successCount: Number(item?.successCount || 0),
        failCount: Number(item?.failCount || 0),
        consecutiveFailCount: Number(item?.consecutiveFailCount || 0),
        doiFailureCount: Number(item?.doiFailureCount || 0),
        consecutiveDoiFailureCount: Number(item?.consecutiveDoiFailureCount || 0),
        lastReason: item?.lastReason || '',
        lastDoi: item?.lastDoi || '',
        lastTitle: item?.lastTitle || '',
        lastSuccessAt: item?.lastSuccessAt || '',
        lastFailAt: item?.lastFailAt || '',
        aliases: Array.isArray(item?.aliases) ? item.aliases : []
      })).sort((a, b) => (
        Number(b.consecutiveFailCount || 0) - Number(a.consecutiveFailCount || 0)
        || Number(b.failCount || 0) - Number(a.failCount || 0)
        || String(a.journalName || '').localeCompare(String(b.journalName || ''))
      ));
      const journalAccessSummary = {
        total: journalAccessItems.length,
        noAccess: journalAccessItems.filter(item => item.accessState === 'no_access').length,
        partialAccess: journalAccessItems.filter(item => item.accessState === 'partial_access').length,
        hasAccess: journalAccessItems.filter(item => item.accessState === 'has_access').length,
        unknown: journalAccessItems.filter(item => !item.accessState || item.accessState === 'unknown').length,
        doiRisk: journalAccessItems.filter(item => item.successCount <= 0 && item.consecutiveDoiFailureCount >= doiFailureSkipThreshold).length
      };
      const journalAccessJson = JSON.stringify(reportValueForJson({
        updatedAt: new Date().toISOString(),
        note: '本文件用于本地排查和手动维护参考。真正生效的手动名单优先来自 Native Helper 目录中的 journal-access.json；config.local 仅保留旧版本兼容回退。',
        source: opts.watcherJournalAccessRulesSource || 'chrome.storage.local cache',
        summary: journalAccessSummary,
        manualRules: parseJournalAccessRules(opts.watcherJournalAccessRules || ''),
        items: journalAccessItems,
        stats: journalAccessStats
      }), null, 2) + '\n';
      const journalAccessLookupJson = JSON.stringify(reportValueForJson({
        updatedAt: new Date().toISOString(),
        note: '轻量查询索引。插件运行时只需要类似结构即可判断列表页候选，不需要读取完整 stats。',
        count: journalAccessItems.length,
        index: journalAccessStatsIndexFromStats(journalAccessStats)
      }), null, 2) + '\n';
      const journalAccessCsvHeader = [
        'journalName',
        'accessState',
        'successCount',
        'failCount',
        'consecutiveFailCount',
        'doiFailureCount',
        'consecutiveDoiFailureCount',
        'lastReason',
        'lastDoi',
        'lastSuccessAt',
        'lastFailAt',
        'aliases'
      ];
      const journalAccessCsv = [
        journalAccessCsvHeader,
        ...journalAccessItems.map(item => [
          item.journalName,
          item.accessState,
          item.successCount,
          item.failCount,
          item.consecutiveFailCount,
          item.doiFailureCount,
          item.consecutiveDoiFailureCount,
          item.lastReason,
          item.lastDoi,
          item.lastSuccessAt ? formatBeijingDateTime(item.lastSuccessAt) : '',
          item.lastFailAt ? formatBeijingDateTime(item.lastFailAt) : '',
          item.aliases.join(' | ')
        ])
      ].map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
      const journalAccessMd = [
        '# Journal Access Stats',
        '',
        `Updated: ${formatBeijingDateTime(new Date())}`,
        '',
        '## Summary',
        '',
        `- Total: ${journalAccessSummary.total}`,
        `- No access: ${journalAccessSummary.noAccess}`,
        `- Partial access: ${journalAccessSummary.partialAccess}`,
        `- Has access: ${journalAccessSummary.hasAccess}`,
        `- Unknown: ${journalAccessSummary.unknown}`,
        `- DOI risk: ${journalAccessSummary.doiRisk}`,
        '',
        '## Highest Risk',
        '',
        '| Journal | State | Success | Fail | Consecutive Fail | DOI Fail | Reason | Aliases |',
        '| --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
        ...journalAccessItems.slice(0, 80).map(item => [
          item.journalName,
          item.accessState,
          item.successCount,
          item.failCount,
          item.consecutiveFailCount,
          item.consecutiveDoiFailureCount,
          item.lastReason,
          item.aliases.slice(0, 6).join(', ')
        ].map(value => String(value || '').replace(/\|/g, '\\|')).join(' | ')).map(row => `| ${row} |`),
        '',
        '## Files',
        '',
        '- `journal-access/stats.json`: full machine-readable stats.',
        '- `journal-access/stats.csv`: sortable table for manual review.',
        '- `journal-access/summary.md`: compact human-readable view.',
        '- `journal-access.json`: compatibility copy at report root.',
        ''
      ].join('\n');
      const csvRows = [
        csvHeader,
        reportRow('summary', {
          time: formatBeijingDateTime(new Date()),
          status: state.currentExecutionModel || state.schedulerModelMode || 'simple',
          reason: `runs=${Number(daily.totalRuns || 0)} auto=${Number(daily.autoRuns || 0)} manual=${Number(daily.manualRuns || 0)} observe=${Number(daily.manualObserveRuns || 0)} checked=${Number(daily.checked || 0)} downloaded=${Number(daily.downloaded || 0)} failed=${Number(daily.failed || 0)}`,
          totalSeeking: state.lastDemandSnapshot?.totalSeeking || '',
          supplementCount: state.lastDemandSnapshot?.supplementCount || '',
          delta: state.recentH1DemandDelta || state.marketData?.h1Delta || ''
        }),
        reportRow('session', {
          time: formatBeijingDateTime(state.lastSession?.finishedAt || state.lastSession?.startedAt || new Date()),
          sessionId: state.lastSession?.id || '',
          status: state.lastSession?.status || '',
          reason: state.lastSession?.cooldownMinutes ? `cooldown=${state.lastSession.cooldownMinutes}m` : ''
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
          status: lastAttempt.resultReason || '',
          reason: reportJson(lastAttempt || {}),
          trigger: lastAttempt.trigger || '',
          url: lastAttempt.pickedListUrl || ''
        }),
        ...observeEvents,
        ...(state.banditTopPublishers || []).slice(0, 20).map(item => reportRow('bandit', {
          time: formatBeijingDateTime(new Date()),
          publisher: item.source || '',
          score: item.score || '',
          estimatedSuccessRate: item.estimatedSuccessRate || '',
          demandPressure: item.demandPressure || '',
          sourceTrend: item.sourceTrend || ''
        })),
        ...logs.map(log => reportRow('log', {
          time: formatBeijingDateTime(log.time),
          sessionId: log.sessionId || '',
          trigger: log.trigger || '',
          assistId: log.assistId || '',
          doi: log.doi || '',
          journalName: log.journalName || '',
          detailUrl: reportDetailValue(log),
          status: log.status || '',
          reason: log.reason || ''
        }))
      ];
      const csv = csvRows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
      const skipDecisionRows = [
        ...logs
          .filter(log => /skipped|failed/i.test(String(log.status || '')) || /skip|filter|not_due|limit|risk|zero|no_candidate/i.test(String(log.reason || '')))
          .map(log => ({
            time: log.time,
            trigger: log.trigger || '',
            step: log.status || '',
            reason: log.reason || '',
            detail: reportDetailValue(log) || log.journalName || log.doi || ''
          })),
        ...traces
          .filter(trace => /skip|not_due|session_size|zero|outside|limit|risk|no_candidate|filter/i.test(`${trace.step || ''} ${trace.reason || ''}`))
          .map(trace => ({
            time: trace.time,
            trigger: trace.trigger || '',
            step: trace.step || '',
            reason: trace.reason || '',
            detail: reportJson(trace.details || {}).slice(0, 220)
          }))
      ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 30);

      const monthDir = date.slice(0, 7);
      const reportStem = `${monthDir}/${date}`;
      const md = [
        `# Ablesci Watcher Daily Report ${date}`,
        '',
        '## Summary',
        '',
        `- Checked: ${Number(daily.checked || 0)}`,
        `- Downloaded or queued: ${Number(daily.downloaded || 0)}`,
        `- Uploaded: ${Number(daily.uploaded || 0)}`,
        `- Skipped: ${Number(daily.skipped || 0)}`,
        `- Failed: ${Number(daily.failed || 0)}`,
        `- Notified: ${Number(daily.notified || 0)}`,
        `- Speed mode: ${state.speedMode || 'normal'}`,
        `- Demand regime: ${state.demandRegime || 'normal'}`,
        `- Scheduler model: ${state.schedulerModelMode || 'simple'}`,
        `- Runtime logic: ${state.currentSchedulerMode || ''} / ${state.currentExecutionModel || ''}`,
        `- Current assist strategy: ${state.lastAssistStrategy || ''}`,
        `- Next wake: ${chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : '')}`,
        `- Next assist attempt: ${state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : ''}`,
        `- Next assist strategy: ${state.nextAssistStrategy || ''} / ${state.nextAssistReason || ''}`,
        `- Next assist plan data: planned=${state.nextAssistPlannedAt ? formatBeijingDateTime(state.nextAssistPlannedAt) : ''}, market=${state.nextAssistPlanningData?.marketDataAt ? formatBeijingDateTime(state.nextAssistPlanningData.marketDataAt) : ''}`,
        `- Latest sample affects: ${state.marketDataAffects || ''}`,
        `- Next assist delay model / guard / final: ${Number(state.nextAssistModelDelayMinutes || 0)} / ${Number(state.nextAssistGuardMinutes || 0)} / ${Number(state.nextAssistDelayMinutes || 0)} minutes`,
        `- Next assist guard: ${state.nextAssistGuardMode || 'none'}, lift=${Number(state.nextAssistGuardLiftMinutes || 0)}m, weight=${Number(state.nextAssistGuardWeight || 0)}`,
        `- Runs auto / manual / observe: ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)} / ${Number(daily.manualObserveRuns || 0)}`,
        `- Last run: ${state.lastRunTrigger || ''} ${state.lastRunResult?.reason || ''}`,
        `- Last attempt time: ${lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : ''}`,
        `- Last attempt trigger: ${lastAttempt.trigger || ''}`,
        `- Last attempt result: ${lastAttempt.resultReason || ''}`,
        `- Last attempt observe: ${lastAttempt.observeSnapshot === true ? 'yes' : 'no'} ${lastAttempt.observeReason || ''}`,
        `- Last attempt target session size: ${lastAttempt.targetSessionSize ?? ''}`,
        `- Last attempt checked delta: ${lastAttempt.checkedDelta ?? ''}`,
        `- Last attempt downloaded delta: ${lastAttempt.downloadedDelta ?? ''}`,
        `- Last attempt list scan started: ${lastAttempt.listScanStarted === true ? 'yes' : 'no'}`,
        `- Last attempt picked list URL: ${lastAttempt.pickedListUrl || ''}`,
        `- Last attempt random session: picked=${lastAttempt.randomSessionPicked ?? ''}, final=${lastAttempt.randomSessionFinalSize ?? ''}, random=${lastAttempt.randomValue ?? ''}`,
        `- Demand factor: ${Number(state.demandFactor || 1).toFixed(2)}`,
        `- Trend factor: ${Number(state.trendFactor || 1).toFixed(2)}`,
        `- Work time progress: ${Number(state.workTimeProgressRatio || 0).toFixed(4)}`,
        `- Active progress / availability: ${Number(state.activeTimeProgressRatio || 0).toFixed(4)} / ${Number(state.availabilityFactor || 1).toFixed(3)}`,
        `- Active wake count expected / actual: ${Number(state.availabilityExpectedWakeCount || 0)} / ${Number(state.availabilityActualWakeCount || 0)}`,
        `- Expected / actual / error: ${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.targetError || state.lag || 0)}`,
        `- Rate multiplier: ${Number(state.rateMultiplier || 1).toFixed(3)}`,
        `- Hour target: ${Number(state.hourTarget || 0)}`,
        `- Risk used / limit: ${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`,
        `- Recent 1h demand delta: ${Number(state.recentH1DemandDelta || state.marketData?.h1Delta || 0)}`,
        `- Today target: ${Number(state.todayTarget || 0)}`,
        `- Latest demand: ${Number(state.lastDemandSnapshot?.totalSeeking || 0)}`,
        `- Detailed data file: ${monthDir}/watcher-data-${date}.jsonl`,
        `- Journal access files: journal-access/summary.md, journal-access/stats.csv, journal-access/stats.json`,
        `- Latest demand anomaly: ${state.lastDemandAnomaly?.dayKey === date ? `${state.lastDemandAnomaly.anomalyType || 'yes'} (${Number(state.lastDemandAnomaly.totalSeeking || 0)})` : 'none'}`,
        `- Session ID: ${state.lastSession?.id || ''}`,
        `- Session size: ${Number(state.lastSession?.targetSessionSize || 0)}`,
        `- Session handled: ${Number(state.lastSession?.handledCount || 0)}`,
        `- Session duration seconds: ${Math.round(Number(state.lastSession?.sessionDurationMs || 0) / 1000)}`,
        `- Trace events: ${traces.length}`,
        '',
        '## Bandit',
        '',
        '| Publisher | Score | Estimated Success | Demand Pressure |',
        '| --- | --- | --- | --- |',
        ...(state.banditTopPublishers || []).slice(0, 8).map(item =>
          `| ${String(item.source || '').replace(/\|/g, '\\|')} | ${Number(item.score || 0).toFixed(4)} | ${Number(item.estimatedSuccessRate || 0).toFixed(4)} | ${Number(item.demandPressure || 0).toFixed(4)} |`
        ),
        '',
        '## Skips And Decisions',
        '',
        '| Time | Trigger | Step | Reason | Detail | Date |',
        '| --- | --- | --- | --- | --- | --- |',
        ...skipDecisionRows.map(row => [
          formatBeijingTimeOnly(row.time),
          row.trigger,
          row.step,
          row.reason,
          row.detail,
          formatBeijingDateOnly(row.time)
        ].map(v => String(v).replace(/\|/g, '\\|')).join(' | ')),
        '',
        '## Observe Events',
        '',
        '| Time | Trigger | Step | Reason | URL |',
        '| --- | --- | --- | --- | --- |',
        ...observeEvents.slice(0, 20).map(row => {
          const record = {};
          csvHeader.forEach((key, index) => { record[key] = row[index]; });
          return [
            record.time,
            record.trigger,
            record.status,
            record.reason,
            record.url
          ].map(v => String(v || '').replace(/\|/g, '\\|')).join(' | ');
        }).map(row => `| ${row} |`),
        '',
        '## Recent Events',
        '',
        '| Time | Trigger | Status | Reason | Journal | DOI | Detail |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...logs.slice(0, 12).map(log => [
          formatBeijingDateTime(log.time),
          log.trigger || '',
          log.status || '',
          log.reason || '',
          log.journalName || '',
          log.doi || '',
          reportDetailValue(log)
        ].map(v => String(v).replace(/\|/g, '\\|')).join(' | '))
          .map(row => `| ${row} |`),
        ''
      ].join('\n');

      await writeReportFile(`${reportStem}.csv`, csv, 'text/csv', opts);
      await writeReportFile(`${reportStem}.md`, md, 'text/markdown', opts);
      await writeReportFile(`${monthDir}/watcher-data-${date}.jsonl`, detailJsonl, 'application/x-ndjson', opts);
      await writeReportFile('journal-access/summary.md', journalAccessMd, 'text/markdown', opts);
      await writeReportFile('journal-access/stats.csv', journalAccessCsv, 'text/csv', opts);
      await writeReportFile('journal-access/stats.json', journalAccessJson, 'application/json', opts);
      await writeReportFile('journal-access/index.json', journalAccessLookupJson, 'application/json', opts);
      await writeReportFile('journal-access.json', journalAccessJson, 'application/json', opts);
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
