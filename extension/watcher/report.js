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

    const STEP_TRANSLATIONS = {
      'failed': '失败',
      'skipped': '已跳过',
      'candidate_detail_start': '详情页评估开始',
      'candidate_skip_list_filter': '列表页过滤跳过',
      'candidate_skip_journal_stats': '期刊状态过滤跳过',
      'candidate_skip_processed': '已处理过滤跳过',
      'run_session_size': '会话大小计算',
      'session_size_calculated': '会话大小已计算',
      'session_start': '会话开始',
      'session_done': '会话完成',
      'session_plan_result': '会话规划结果',
      'session_plan_done': '会话规划完成',
      'candidate_skip_detail_filter': '详情页过滤跳过',
      'candidate_payload_allowed': '候选允许处理',
      'candidate_enqueue': '加入上传队列',
      'queue_message_done': '上传队列完成',
      'queue_message_error': '上传队列错误',
      'queue_message_blocked': '上传队列受阻',
      'run_skip_already_running': '跳过(正在运行)',
      'detail_extract_failed': '提取详情失败',
      'detail_extract_result': '提取详情结果',
      'detail_extract_error': '提取详情错误',
      'watcher_paused_after_download_failure': '下载失败后值守暂停',
      'session_stopped_after_candidate_failure': '候选失败后会话停止',
      'detail_tab_closed_cancel_task': '关闭详情页取消任务',
      'tab_open_request': '请求打开标签页',
      'tab_opened': '标签页已打开',
      'tab_complete': '标签页加载完成',
      'tab_close_request': '请求关闭标签页',
      'tab_closed': '标签页已关闭',
      'alarm_refresh_start': '刷新定时闹钟开始',
      'alarm_cleared': '清除定时闹钟',
      'alarm_disabled': '禁用定时闹钟',
      'alarm_scheduled': '定时闹钟已排程',
      'assist_next_scheduled': '下一次应助已排程',
      'sync_web_assist_count': '同步网页应助数'
    };

    const REASON_TRANSLATIONS = {
      'candidate_passed_list_filter': '候选通过列表筛选',
      'journal_blocked_rule': '期刊黑名单限制',
      'session_size_calculated': '会话大小已计算',
      'already running': '已有任务在运行中',
      'already_running': '已有任务在运行中',
      'no_candidate': '未发现有效候选',
      'risk_budget_limit': '超出今日风险预算',
      'daily_limit_reached': '已达到每日应助上限',
      'outside_work_window': '处于非工作时间窗口',
      'not_due': '时间未到',
      'no_cookie': '未检测到有效凭证',
      'no_credential': '未检测到有效凭证',
      'cf_challenge': '触发 Cloudflare 人机验证',
      'cloudflare_challenge': '触发 Cloudflare 人机验证',
      'download_timeout': '下载 PDF 超时',
      'no_download_timeout': '未触发下载超时',
      'upload_failed': '上传 PDF 失败',
      'high_risk_journal': '高风险期刊过滤',
      'supplement_pdf': '跳过补充材料(Supplement)',
      'remark_pdf': '跳过备注或勘误',
      'book_chapter': '跳过图书章节',
      'patent_report': '跳过专利报告',
      'risk_text': '跳过风险文本匹配',
      'doi_missing': '缺少 DOI 信息',
      'reported': '已被举报/处理过',
      'rejected': '已被拒绝',
      'no_access': '无订阅访问权限',
      'between_candidates': '候选任务间延迟等待',
      'session_completed': '本轮会话已圆满完成',
      'quota_reset': '限额重置',
      'rate_limited_': '触发滑动窗口频控限制(将快速重试)',
      'rate_limited_retry': '触发滑动窗口频控限制(将快速重试)'
    };

    function translateStep(step) {
      const s = String(step || '').trim();
      return STEP_TRANSLATIONS[s] || s;
    }

    function translateReason(reason) {
      const r = String(reason || '').trim();
      if (REASON_TRANSLATIONS[r]) {
        return REASON_TRANSLATIONS[r];
      }
      if (r.startsWith('rate_limited_')) {
        return REASON_TRANSLATIONS['rate_limited_'];
      }
      if (r.startsWith('storage_changed:')) {
        const keysStr = r.substring('storage_changed:'.length);
        const keys = keysStr.split(',').filter(Boolean);
        if (keys.length > 2) {
          return `修改设置 (${keys.slice(0, 2).join(', ')}等 ${keys.length} 项)`;
        }
        return `修改设置 (${keysStr})`;
      }
      return r;
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
        journalAccessStatsKey
      ]);
      const state = stored[autoWatcherStateKey] || {};
      const daily = state.daily?.[date] || {};
      const chromeAlarm = await chromeApi.alarms.get(alarmName).catch(() => null);
      const chromeAlarmScheduledAt = chromeAlarm?.scheduledTime ? new Date(chromeAlarm.scheduledTime).toISOString() : (state.chromeAlarmScheduledAt || '');
      const lastAttempt = state.lastAttempt || {};
      const logs = (Array.isArray(stored[autoWatcherLogKey]) ? stored[autoWatcherLogKey] : [])
        .filter(log => formatBeijingDateTime(log.time, true) === date);
      const traces = (Array.isArray(stored[autoWatcherTraceKey]) ? stored[autoWatcherTraceKey] : [])
        .filter(log => formatBeijingDateTime(log.time, true) === date);
      const journalAccessStats = stored[journalAccessStatsKey] || {};

      const csvHeader = [
        'record_type', 'time', 'sessionId', 'assistId', 'doi', 'journalName', 'detailUrl', 'status', 'reason',
        'publisher',
        'range', 'absMove', 'sampleCount', 'validSampleCount', 'workTimeProgressRatio', 'expectedDone', 'actualDone',
        'targetError', 'activeTimeProgressRatio', 'availabilityFactor', 'availabilityActualWakeCount', 'availabilityExpectedWakeCount',
        'rateMultiplier', 'riskUsed', 'riskLimit', 'sessionSize', 'sessionHandledCount',
        'sessionDurationMs', 'score', 'estimatedSuccessRate',
        'currentStrategy', 'nextAssistRunAt', 'nextAssistStrategy', 'nextAssistReason', 'nextAssistDelayMinutes',
        'nextAssistModelDelayMinutes', 'nextAssistGuardMinutes', 'nextAssistGuardMode', 'nextAssistGuardLiftMinutes',
        'nextAssistGuardWeight', 'nextAssistPlannedAt', 'nextWakeAt', 'chromeAlarmScheduledAt',
        'lastAttemptStartedAt', 'lastAttemptFinishedAt', 'lastAttemptResult', 'lastAttemptObserveSnapshot',
        'lastAttemptTargetSessionSize', 'lastAttemptCheckedDelta', 'lastAttemptDownloadedDelta',
        'lastAttemptListScanStarted', 'lastAttemptPickedListUrl', 'pickedPage', 'pageCurve', 'pageMin', 'pageMax',
        'pageFrontHit', 'pageAlpha', 'randomSessionPicked', 'randomSessionFinalSize',
        'randomValue', 'step', 'trigger', 'tabId', 'url', 'details'
      ];
      const baseReportFields = {
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
      const dataRows = [
        ...logs.map(log => {
          const cleanTitle = log.title ? String(log.title).replace(/\s+相关领域.*$/, '').trim() : '';
          const cleanLog = {
            time: log.time,
            assistId: log.assistId,
            title: cleanTitle ? (cleanTitle.length > 80 ? cleanTitle.slice(0, 80) + '...' : cleanTitle) : undefined,
            doi: log.doi,
            journalName: log.journalName,
            status: log.status,
            reason: log.reason,
            trigger: log.trigger,
            sessionId: log.sessionId
          };
          return jsonLine('assist_event', cleanLog);
        }),
        ...traces.map(trace => {
          const cleanTrace = {
            time: trace.time,
            step: trace.step,
            reason: trace.reason,
            trigger: trace.trigger,
            sessionId: trace.sessionId,
            details: trace.details ? {
              assistId: trace.details.assistId,
              doi: trace.details.doi,
              journal: trace.details.journal || trace.details.journalName || trace.details.journalShortName,
              title: trace.details.title ? String(trace.details.title).replace(/\s+相关领域.*$/, '').trim().slice(0, 80) : undefined,
              targetSessionSize: trace.details.targetSessionSize,
              currentExecutionModel: trace.details.currentExecutionModel,
              checkedDelta: trace.details.checkedDelta,
              downloadedDelta: trace.details.downloadedDelta
            } : undefined
          };
          return jsonLine('trace', cleanTrace);
        }),
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
          reason: `runs=${Number(daily.totalRuns || 0)} auto=${Number(daily.autoRuns || 0)} manual=${Number(daily.manualRuns || 0)} checked=${Number(daily.checked || 0)} downloaded=${Number(daily.downloaded || 0)} failed=${Number(daily.failed || 0)}`
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
          .map(log => {
            const cleanDetail = reportDetailValue(log) || log.journalName || log.doi || '';
            let formattedDetail = cleanDetail;
            if (cleanDetail.startsWith('http://') || cleanDetail.startsWith('https://')) {
              formattedDetail = `[点击查看详情](${cleanDetail})`;
            }
            return {
              time: log.time,
              trigger: log.trigger || '',
              step: translateStep(log.status || ''),
              reason: translateReason(log.reason || ''),
              detail: formattedDetail
            };
          }),
        ...traces
          .filter(trace => /skip|not_due|session_size|zero|outside|limit|risk|no_candidate|filter/i.test(`${trace.step || ''} ${trace.reason || ''}`))
          .map(trace => ({
            time: trace.time,
            trigger: trace.trigger || '',
            step: translateStep(trace.step || ''),
            reason: translateReason(trace.reason || ''),
            detail: formatTraceDetail(trace.details)
          }))
      ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 30);

      const monthDir = date.slice(0, 7);
      const reportStem = `${monthDir}/${date}`;
      const md = [
        `# 科研通值守日报 ${date}`,
        '',
        '## 运行数据摘要 (Summary)',
        '',
        `- 已检查候选数: ${Number(daily.checked || 0)}`,
        `- 下载或排队数: ${Number(daily.downloaded || 0)}`,
        `- 成功上传数: ${Number(daily.uploaded || 0)}`,
        `- 已跳过候选数: ${Number(daily.skipped || 0)}`,
        `- 失败任务数: ${Number(daily.failed || 0)}`,
        `- 发送通知数: ${Number(daily.notified || 0)}`,
        `- 值守速度模式: ${state.speedMode === 'adaptive' ? '自适应' : (state.speedMode === 'slow' ? '低频' : (state.speedMode === 'fast' ? '快速' : '标准'))}`,
        `- 调度器模式: ${state.schedulerModelMode || 'simple'}`,
        `- 运行时策略模式: ${state.currentSchedulerMode || ''} / ${state.currentExecutionModel || ''}`,
        `- 当前应助策略: ${state.lastAssistStrategy || ''}`,
        `- 下一次唤醒时间: ${chromeAlarmScheduledAt ? formatBeijingDateTime(chromeAlarmScheduledAt) : (state.nextScheduledAt ? formatBeijingDateTime(state.nextScheduledAt) : '')}`,
        `- 下一次应助尝试时间: ${state.nextAssistRunAt ? formatBeijingDateTime(state.nextAssistRunAt) : ''}`,
        `- 下一次应助策略及原因: ${state.nextAssistStrategy || ''} / ${translateReason(state.nextAssistReason || '')}`,
        `- 下一次应助规划数据: 规划时间=${state.nextAssistPlannedAt ? formatBeijingDateTime(state.nextAssistPlannedAt) : ''}`,
        `- 下一次应助延迟模型/守卫/最终延迟: ${Number(state.nextAssistModelDelayMinutes || 0)} / ${Number(state.nextAssistGuardMinutes || 0)} / ${Number(state.nextAssistDelayMinutes || 0)} 分钟`,
        `- 下一次应助守卫配置: 守卫模式=${state.nextAssistGuardMode || 'none'}, 抬升时间=${Number(state.nextAssistGuardLiftMinutes || 0)}m, 权重=${Number(state.nextAssistGuardWeight || 0)}`,
        `- 运行次数 (自动 / 手动): ${Number(daily.autoRuns || 0)} / ${Number(daily.manualRuns || 0)}`,
        `- 最近一次运行原因与结果: 触发方式=${state.lastRunTrigger || ''}, 结果=${translateReason(state.lastRunResult?.reason || '')}`,
        `- 最近一次尝试时间: ${lastAttempt.finishedAt ? formatBeijingDateTime(lastAttempt.finishedAt) : ''}`,
        `- 最近一次尝试触发方式: ${lastAttempt.trigger || ''}`,
        `- 最近一次尝试执行结果: ${translateReason(lastAttempt.resultReason || '')}`,
        `- 最近一次会话目标下载数: ${lastAttempt.targetSessionSize ?? ''}`,
        `- 最近一次检查文献增量: ${lastAttempt.checkedDelta ?? ''}`,
        `- 最近一次下载文献增量: ${lastAttempt.downloadedDelta ?? ''}`,
        `- 最近一次是否启动列表扫描: ${lastAttempt.listScanStarted === true ? '是' : '否'}`,
        `- 最近一次选中的列表页链接: ${lastAttempt.pickedListUrl ? `[点击跳转](${lastAttempt.pickedListUrl})` : ''}`,
        `- 最近一次随机评估结果: 选中=${lastAttempt.randomSessionPicked ?? ''}, 最终=${lastAttempt.randomSessionFinalSize ?? ''}, 随机值=${lastAttempt.randomValue ?? ''}`,
        `- 应助趋势系数: ${Number(state.trendFactor || 1).toFixed(2)}`,
        `- 工作时间进度比率: ${Number(state.workTimeProgressRatio || 0).toFixed(4)}`,
        `- 活跃时间进度 / 可用性系数: ${Number(state.activeTimeProgressRatio || 0).toFixed(4)} / ${Number(state.availabilityFactor || 1).toFixed(3)}`,
        `- 活跃唤醒次数 (预计 / 实际): ${Number(state.availabilityExpectedWakeCount || 0)} / ${Number(state.availabilityActualWakeCount || 0)}`,
        `- 当月应助任务 (预计 / 实际 / 差额): ${Number(state.expectedDone || 0)} / ${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.targetError || state.lag || 0)}`,
        `- 速率倍增系数: ${Number(state.rateMultiplier || 1).toFixed(3)}`,
        `- 本小时目标应助数: ${Number(state.hourTarget || 0)}`,
        `- 今日已用风险预算 / 上限: ${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`,
        `- 今日应助目标数: ${Number(state.todayTarget || 0)}`,
        `- 详细事件数据 file: ${monthDir}/watcher-data-${date}.jsonl`,
        `- 期刊权限文件: journal-access/summary.md, journal-access/stats.csv, journal-access/stats.json`,
        `- 最近会话 ID: ${state.lastSession?.id || ''}`,
        `- 最近会话目标大小: ${Number(state.lastSession?.targetSessionSize || 0)}`,
        `- 最近会话已处理数: ${Number(state.lastSession?.handledCount || 0)}`,
        `- 最近会话执行时长 (秒): ${Math.round(Number(state.lastSession?.sessionDurationMs || 0) / 1000)}`,
        `- Trace 事件记录数: ${traces.length}`,
        '',
        '## 决策与过滤记录 (Skips And Decisions)',
        '',
        '| 时间 | 触发方式 | 步骤 (Step) | 原因 (Reason) | 详情 (Detail) | 日期 |',
        '| --- | --- | --- | --- | --- | --- |',
        ...skipDecisionRows.map(row => [
          formatBeijingTimeOnly(row.time),
          row.trigger === 'alarm' ? '自动' : (row.trigger === 'manual' ? '手动' : row.trigger),
          row.step,
          row.reason,
          row.detail,
          formatBeijingDateOnly(row.time)
        ].map(v => String(v).replace(/\|/g, '\\|')).join(' | ')),
        '',
        '## 最近事件记录 (Recent Events)',
        '',
        '| 时间 | 触发方式 | 状态 (Status) | 原因 (Reason) | 期刊 (Journal) | DOI | 详情 (Detail) |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...logs.slice(0, 12).map(log => {
          let detailVal = reportDetailValue(log);
          if (detailVal.startsWith('http://') || detailVal.startsWith('https://')) {
            detailVal = `[点击查看详情](${detailVal})`;
          }
          return [
            formatBeijingDateTime(log.time),
            log.trigger === 'alarm' ? '自动' : (log.trigger === 'manual' ? '手动' : log.trigger),
            translateStep(log.status || ''),
            translateReason(log.reason || ''),
            log.journalName || '',
            log.doi || '',
            detailVal
          ].map(v => String(v).replace(/\|/g, '\\|')).join(' | ');
        })
          .map(row => `| ${row} |`),
        ''
      ].join('\n');

      await writeReportFile(`${reportStem}.csv`, csv, 'text/csv', opts);
      await writeReportFile(`${reportStem}.md`, md, 'text/markdown', opts);
      // PRIVATE_WATCHER_ONLY: skipped writing .jsonl file to optimize disk space
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
