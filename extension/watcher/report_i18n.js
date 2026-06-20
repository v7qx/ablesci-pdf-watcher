'use strict';

(function () {
  const STEP_TRANSLATIONS = {
    'failed': '失败',
    'skipped': '已跳过',
    'candidate_detail_start': '详情页评估开始',
    'candidate_skip_list_filter': '列表页过滤跳过',
    'candidate_skip_list_filter_summary': '列表页过滤汇总',
    'candidate_skip_processed': '已处理过滤跳过',
    'candidate_queue_seen_skipped': '队列已见过跳过',
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
    'sync_web_assist_count': '同步网页应助数',
    'perf_watcher_checkpoint': '性能检查点',
    'perf_watcher_run': '值守总耗时',
    'perf_list_parse': '列表解析耗时',
    'perf_list_fetch_detail': '列表抓取拆分耗时',
    'perf_list_pipeline': '列表处理流水线耗时',
    'perf_list_filter': '列表候选过滤耗时',
    'perf_list_to_detail_start': '列表到详情总耗时',
    'perf_list_scan_page': '列表页扫描耗时',
    'perf_detail_inspect': '详情页检查耗时',
    'perf_candidate_handle': '候选处理耗时',
    'perf_native_message': 'Native Helper 耗时'
  };

  const STEP_TRANSLATIONS_EN = {
    'failed': 'Failed',
    'skipped': 'Skipped',
    'candidate_detail_start': 'Detail Evaluation Start',
    'candidate_skip_list_filter': 'List Page Filter Skipped',
    'candidate_skip_list_filter_summary': 'List Page Filter Summary',
    'candidate_skip_processed': 'Processed Filter Skipped',
    'candidate_queue_seen_skipped': 'Queue Seen Skipped',
    'run_session_size': 'Session Size Calculation',
    'session_size_calculated': 'Session Size Calculated',
    'session_start': 'Session Start',
    'session_done': 'Session Done',
    'session_plan_result': 'Session Plan Result',
    'session_plan_done': 'Session Plan Done',
    'candidate_skip_detail_filter': 'Detail Page Filter Skipped',
    'candidate_payload_allowed': 'Candidate Allowed',
    'candidate_enqueue': 'Enqueue Upload Task',
    'queue_message_done': 'Upload Queue Done',
    'queue_message_error': 'Upload Queue Error',
    'queue_message_blocked': 'Upload Queue Blocked',
    'run_skip_already_running': 'Skipped (Already Running)',
    'detail_extract_failed': 'Detail Extraction Failed',
    'detail_extract_result': 'Detail Extraction Result',
    'detail_extract_error': 'Detail Extraction Error',
    'watcher_paused_after_download_failure': 'Watcher Paused After Download Failure',
    'session_stopped_after_candidate_failure': 'Session Stopped After Candidate Failure',
    'detail_tab_closed_cancel_task': 'Tab Closed Cancel Task',
    'tab_open_request': 'Tab Open Request',
    'tab_opened': 'Tab Opened',
    'tab_complete': 'Tab Loaded',
    'tab_close_request': 'Tab Close Request',
    'tab_closed': 'Tab Closed',
    'alarm_refresh_start': 'Alarm Refresh Start',
    'alarm_cleared': 'Alarm Cleared',
    'alarm_disabled': 'Alarm Disabled',
    'alarm_scheduled': 'Alarm Scheduled',
    'assist_next_scheduled': 'Next Run Scheduled',
    'sync_web_assist_count': 'Sync Web Assist Count',
    'perf_watcher_checkpoint': 'Performance Checkpoint',
    'perf_watcher_run': 'Watcher Run Duration',
    'perf_list_parse': 'List Parse Duration',
    'perf_list_fetch_detail': 'List Fetch Breakdown',
    'perf_list_pipeline': 'List Pipeline Duration',
    'perf_list_filter': 'List Candidate Filter Duration',
    'perf_list_to_detail_start': 'List To Detail Duration',
    'perf_list_scan_page': 'List Page Scan Duration',
    'perf_detail_inspect': 'Detail Inspect Duration',
    'perf_candidate_handle': 'Candidate Handle Duration',
    'perf_native_message': 'Native Helper Duration'
  };

  const REASON_TRANSLATIONS = {
    'candidate_passed_list_filter': '候选通过列表筛选',
    'list_filter_summary': '列表页过滤汇总',
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
    'supplement_pdf': '跳过补充材料(Supplement)',
    'remark_pdf': '跳过备注或勘误',
    'book_chapter': '跳过图书章节',
    'patent_report': '跳过专利报告',
    'risk_text': '跳过风险文本匹配',
    'doi_missing': '缺少 DOI 信息',
    'reported': '已被举报/处理过',
    'rejected': '已被拒绝',
    'no_access': '无订阅访问权限',
    'recognized_but_unsupported_landing_host': '已知但暂不支持的 DOI 落地域名',
    'unsupported_landing_host': '暂不支持的 DOI 落地域名',
    'invalid_landing_url': '无效 DOI 落地 URL',
    'journal_blocked_rule': '命中本地期刊规则',
    'journal_blocked_rule_summary': '本轮命中本地期刊规则，已聚合显示',
    'between_candidates': '候选任务间延迟等待',
    'session_completed': '本轮会话已圆满完成',
    'quota_reset': '限额重置',
    'rate_limited_': '触发滑动窗口频控限制(将快速重试)',
    'rate_limited_retry': '触发滑动窗口频控限制(将快速重试)'
  };

  const REASON_TRANSLATIONS_EN = {
    'candidate_passed_list_filter': 'Candidate passed list filter',
    'list_filter_summary': 'List page filter summary',
    'session_size_calculated': 'Session size calculated',
    'already running': 'Task already running',
    'already_running': 'Task already running',
    'no_candidate': 'No valid candidate found',
    'risk_budget_limit': 'Daily risk budget exceeded',
    'daily_limit_reached': 'Daily assist limit reached',
    'outside_work_window': 'Outside work time window',
    'not_due': 'Not due yet',
    'no_cookie': 'No valid credentials detected',
    'no_credential': 'No valid credentials detected',
    'cf_challenge': 'Cloudflare verification challenge triggered',
    'cloudflare_challenge': 'Cloudflare verification challenge triggered',
    'download_timeout': 'Download PDF timeout',
    'no_download_timeout': 'No download triggered timeout',
    'upload_failed': 'Upload PDF failed',
    'supplement_pdf': 'Skip supplementary materials',
    'remark_pdf': 'Skip remarks or corrigenda',
    'book_chapter': 'Skip book chapters',
    'patent_report': 'Skip patent reports',
    'risk_text': 'Skip risk text match',
    'doi_missing': 'DOI missing',
    'reported': 'Already reported/handled',
    'rejected': 'Already rejected',
    'no_access': 'No subscription access',
    'recognized_but_unsupported_landing_host': 'Recognized but unsupported DOI landing host',
    'unsupported_landing_host': 'Unsupported DOI landing host',
    'invalid_landing_url': 'Invalid DOI landing URL',
    'journal_blocked_rule': 'Local journal rule matched',
    'journal_blocked_rule_summary': 'Local journal rule matches grouped for this run',
    'between_candidates': 'Cooldown delay between candidates',
    'session_completed': 'Session completed successfully',
    'quota_reset': 'Quota reset',
    'rate_limited_': 'Rate limit triggered (will retry soon)',
    'rate_limited_retry': 'Rate limit triggered (will retry soon)',
    '上传成功': 'Upload Successful',
    '上传失败': 'Upload Failed'
  };

  function translateStep(step, isEn) {
    const s = String(step || '').trim();
    if (isEn) {
      return STEP_TRANSLATIONS_EN[s] || s;
    }
    return STEP_TRANSLATIONS[s] || s;
  }

  function translateReason(reason, isEn) {
    const r = String(reason || '').trim();
    if (isEn) {
      if (REASON_TRANSLATIONS_EN[r]) {
        return REASON_TRANSLATIONS_EN[r];
      }
      if (r.startsWith('rate_limited_')) {
        return REASON_TRANSLATIONS_EN['rate_limited_'];
      }
      if (r.startsWith('storage_changed:')) {
        const keysStr = r.substring('storage_changed:'.length);
        const keys = keysStr.split(',').filter(Boolean);
        if (keys.length > 2) {
          return `Settings changed (${keys.slice(0, 2).join(', ')} etc. ${keys.length} items)`;
        }
        return `Settings changed (${keysStr})`;
      }
      if (r.startsWith('失败: ')) {
        return 'Failed: ' + translateReason(r.substring(4), isEn);
      }
      if (r.startsWith('失败：')) {
        return 'Failed: ' + translateReason(r.substring(3), isEn);
      }
      const mAnomaly = r.match(/^短时间内连续出现\s*(\d+)\s*次无正文权限，且涉及\s*(\d+)\s*个期刊。已暂停值守，请检查代理、登录态或机构访问环境。$/);
      if (mAnomaly) {
        return `Consecutive no-access occurred ${mAnomaly[1]} times in a short period, involving ${mAnomaly[2]} journals. Watcher paused. Please check proxy, login status, or institutional access environment.`;
      }
      if (r.includes('当前出版商页面显示无正文订阅权限') || r.includes('当前出版商无正文订阅权限')) {
        return 'No full-text subscription access. Task skipped.';
      }
      if (r.includes('需要登录或机构访问')) {
        return 'Login or institutional access required. Task marked as login blocked.';
      }
      if (r.includes('检测到出版商验证页')) {
        return 'Publisher verification page detected. Task aborted.';
      }
      if (r.includes('已取消当前任务')) {
        return 'Current task cancelled.';
      }
      if (r.includes('已仅下载并校验 PDF') && r.includes('小于')) {
        const sizeMatch = r.match(/小于\s*([^（，]+)[（,](当前\s*[^）)]+)[）)]/);
        const limitSize = sizeMatch ? sizeMatch[1].trim() : '1 MB';
        const currentSize = sizeMatch ? sizeMatch[2].trim() : '';
        return `Downloaded and verified PDF, not uploaded. PDF file is smaller than ${limitSize} (${currentSize}).`;
      }
      if (r.includes('已仅下载并校验 PDF') && r.includes('大于')) {
        const sizeMatch = r.match(/大于\s*([^（，]+)[（,](当前\s*[^）)]+)[）)]/);
        const limitSize = sizeMatch ? sizeMatch[1].trim() : '20 MB';
        const currentSize = sizeMatch ? sizeMatch[2].trim() : '';
        return `Downloaded and verified PDF, not uploaded. PDF file is larger than ${limitSize} (${currentSize}) and exceeds limit.`;
      }
      if (r.includes('已仅下载并校验 PDF')) {
        return 'Downloaded and verified PDF, not uploaded.';
      }
      if (r.includes('调试模式已开启')) {
        const fileMatch = r.match(/准备上传文件：(.*)$/);
        const file = fileMatch ? fileMatch[1].trim() : 'file';
        return `Debug mode enabled, auto-upload skipped. Prepared file: ${file}`;
      }
      if (r.includes('当前求助缺少可识别的 PDF 链接')) {
        return 'No recognizable PDF link found, skipped.';
      }
      if (r.includes('OSS 上传完成')) {
        return 'OSS upload completed. Please check Ablesci page status.';
      }
      return r;
    }
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

  globalThis.AblesciWatcherReportI18n = {
    translateStep,
    translateReason
  };
})();
