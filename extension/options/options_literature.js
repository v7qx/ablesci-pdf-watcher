'use strict';

(function initScholarFlowLiteratureDownloader(globalThis) {
  const STATE_KEY = 'scholarFlowLiteratureBatchV1';
  const OUTPUT_ROOT = 'DOIPDF';
  const LANE_KEYS = ['elsevier', 'wiley', 'other'];
  const LANE_LABELS = { elsevier: 'ScienceDirect', wiley: 'Wiley', other: '其他出版社' };
  let running = false;
  let loopActive = false;
  const laneWakeDelays = new Map();
  let stateMutation = Promise.resolve();

  function byId(id) {
    return document.getElementById(id);
  }

  function normalizeDoi(value) {
    return String(value || '')
      .trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '')
      .trim();
  }

  function safePart(value, fallback = 'unknown', maxLength = 80) {
    const text = String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim();
    const clipped = (text || fallback).slice(0, maxLength).replace(/[\s._\-([{]+$/g, '').trim();
    return clipped || fallback;
  }

  function yearFrom(value) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    return match ? match[0] : String(new Date().getFullYear());
  }

  function taskFilename(task) {
    return safePart(`${task.recordId}_${task.title}`, `${task.recordId}_paper`, 120) + '.pdf';
  }

  function taskSubdir(task) {
    return `${OUTPUT_ROOT}/files/${safePart(task.journalName, 'unknown-journal', 60)}`;
  }

  function emptyState() {
    return {
      schemaVersion: 2,
      sourceName: '',
      importedAt: '',
      updatedAt: '',
      nextRunAt: '',
      laneNextRunAt: {},
      tasks: []
    };
  }

  async function loadState() {
    const stored = await chrome.storage.local.get(STATE_KEY);
    const state = stored[STATE_KEY] && typeof stored[STATE_KEY] === 'object'
      ? stored[STATE_KEY]
      : emptyState();
    state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
    state.laneNextRunAt = state.laneNextRunAt && typeof state.laneNextRunAt === 'object'
      ? state.laneNextRunAt
      : {};
    return state;
  }

  async function saveState(state) {
    state.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ [STATE_KEY]: state });
  }

  function mutateState(mutator) {
    const operation = stateMutation.then(async () => {
      const state = await loadState();
      const result = await mutator(state);
      await saveState(state);
      return { state, result };
    });
    stateMutation = operation.catch(() => {});
    return operation;
  }

  async function recoverInterruptedTasks() {
    await mutateState(state => {
      for (const task of state.tasks) {
        if (task.status === 'running') task.status = 'pending';
        const classification = classifyPublisher(task, task.doi);
        task.publisher = task.publisher || classification.publisher;
        task.lane = task.lane || classification.lane;
      }
      state.nextRunAt = '';
      state.laneNextRunAt = {};
      state.schemaVersion = 2;
    });
  }

  function appendLog(text) {
    const node = byId('scholarFlowLog');
    if (!node) return;
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    node.textContent += `[${time}] ${text}\n`;
    node.scrollTop = node.scrollHeight;
  }

  function counts(state) {
    const result = { total: state.tasks.length };
    for (const task of state.tasks) {
      result[task.status] = Number(result[task.status] || 0) + 1;
    }
    return result;
  }

  async function render() {
    const state = await loadState();
    const c = counts(state);
    const lanePending = lane => state.tasks.filter(task => task.lane === lane && task.status === 'pending').length;
    const nextRunTimes = Object.values(state.laneNextRunAt || {}).filter(Boolean).sort();
    const status = byId('scholarFlowStatus');
    if (status) {
      status.textContent = !c.total
        ? '尚未导入任务。'
        : `共 ${c.total}；待处理 ${c.pending || 0}（SD ${lanePending('elsevier')} / Wiley ${lanePending('wiley')} / 其他 ${lanePending('other')}）；运行中 ${c.running || 0}；已下载 ${c.downloaded || 0}；问题 ${state.tasks.filter(task => isIssueStatus(task.status)).length}；缺 DOI ${c.missing_doi || 0}；重复 ${c.duplicate_doi || 0}${nextRunTimes[0] ? `；最早继续 ${new Date(nextRunTimes[0]).toLocaleString('zh-CN')}` : ''}`;
    }
    const start = byId('scholarFlowStart');
    const pause = byId('scholarFlowPause');
    const skip = byId('scholarFlowSkipWait');
    if (start) start.disabled = loopActive || !state.tasks.some(task => task.status === 'pending');
    if (pause) pause.disabled = !running;
    if (skip) skip.disabled = laneWakeDelays.size === 0;
  }

  function hostFromUrl(value) {
    try {
      return new URL(String(value || '')).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function publisherFromUrl(value) {
    const host = hostFromUrl(value);
    if (!host) return '';
    if (/(^|\.)(sciencedirect\.com|elsevier\.com|sciencedirectassets\.com)$/.test(host)) return 'elsevier';
    if (/(^|\.)wiley\.com$/.test(host)) return 'wiley';
    if (/(^|\.)acs\.org$/.test(host)) return 'acs';
    if (/(^|\.)rsc\.org$/.test(host)) return 'rsc';
    if (/(^|\.)(springer\.com|springeropen\.com)$/.test(host)) return 'springer';
    if (/(^|\.)nature\.com$/.test(host)) return 'nature';
    if (host === 'academic.oup.com') return 'oxford';
    if (/(^|\.)(aip\.org|scitation\.org)$/.test(host)) return 'aip';
    if (/(^|\.)ieee\.org$/.test(host)) return 'ieee';
    if (/(^|\.)iopscience\.iop\.org$/.test(host)) return 'iop';
    if (/(^|\.)(sagepub\.com|cnpereading\.com)$/.test(host)) return 'sage';
    return '';
  }

  function publisherFromDoi(value) {
    const doi = normalizeDoi(value).toLowerCase();
    if (/^10\.1016\//.test(doi)) return 'elsevier';
    if (/^10\.1002\//.test(doi)) return 'wiley';
    if (/^10\.1021\//.test(doi)) return 'acs';
    if (/^10\.1039\//.test(doi)) return 'rsc';
    if (/^10\.1007\//.test(doi)) return 'springer';
    if (/^10\.1038\//.test(doi)) return 'nature';
    if (/^10\.1093\//.test(doi)) return 'oxford';
    if (/^10\.1063\//.test(doi)) return 'aip';
    if (/^10\.1109\//.test(doi)) return 'ieee';
    if (/^10\.1088\//.test(doi)) return 'iop';
    if (/^10\.1177\//.test(doi)) return 'sage';
    if (/^10\.1089\//.test(doi)) return 'liebert';
    return '';
  }

  function classifyPublisher(row, doi) {
    const publisher = publisherFromDoi(doi) ||
      publisherFromUrl(row?.pdf_url || row?.pdfUrl || row?.sourcePdfUrl) ||
      publisherFromUrl(row?.landing_url || row?.landingUrl) ||
      'other';
    const lane = publisher === 'elsevier' ? 'elsevier' : (publisher === 'wiley' ? 'wiley' : 'other');
    return { publisher, lane };
  }

  function extractDoiFromText(value) {
    const match = String(value || '').match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
    if (!match) return '';
    let doi = normalizeDoi(match[0].replace(/[\s,.;:]+$/g, ''));
    while (doi.endsWith(')') && (doi.match(/\)/g) || []).length > (doi.match(/\(/g) || []).length) {
      doi = doi.slice(0, -1);
    }
    if (doi.includes('...') || doi.includes('…') || /^10\.1002\/central\/?$/i.test(doi)) return '';
    return doi;
  }

  function scalarText(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const text = scalarText(item);
        if (text) return text;
      }
      return '';
    }
    if (value === null || value === undefined || typeof value === 'object') return '';
    return String(value).trim();
  }

  function normalizedKey(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function rowValue(row, aliases) {
    if (!row || typeof row !== 'object') return '';
    const wanted = new Set(aliases.map(normalizedKey));
    for (const [key, value] of Object.entries(row)) {
      if (!wanted.has(normalizedKey(key))) continue;
      const text = scalarText(value);
      if (text) return text;
    }
    return '';
  }

  function explicitDoiFromRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return '';
    const doiKeys = new Set([
      'doi', 'articledoi', 'documentdoi', 'paperdoi', 'digitalobjectidentifier',
      'doiurl', 'doilink'
    ]);
    for (const [key, value] of Object.entries(row)) {
      if (!doiKeys.has(normalizedKey(key))) continue;
      const doi = extractDoiFromText(scalarText(value));
      if (doi) return doi;
    }
    for (const [key, value] of Object.entries(row)) {
      if (!['identifier', 'identifiers', 'ids'].includes(normalizedKey(key))) continue;
      const doi = doiFromIdentifierValue(value);
      if (doi) return doi;
    }
    return '';
  }

  function doiFromIdentifierValue(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const doi = doiFromIdentifierValue(item);
        if (doi) return doi;
      }
      return '';
    }
    if (typeof value === 'string' || typeof value === 'number') return extractDoiFromText(value);
    if (!value || typeof value !== 'object') return '';
    const type = rowValue(value, ['type', 'scheme', 'kind']).toLowerCase();
    if (type === 'doi' || type === 'digital object identifier') {
      return extractDoiFromText(rowValue(value, ['value', 'id', 'identifier', 'url', 'link']));
    }
    return explicitDoiFromRow(value);
  }

  function normalizeInputRow(value, index) {
    if (typeof value === 'string') {
      return { record_id: index + 1, doi: extractDoiFromText(value), title: '' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = { ...value };
    if (!row.doi) {
      row.doi = explicitDoiFromRow(row);
    }
    return row;
  }

  function parseJsonl(text) {
    const rows = [];
    const errors = [];
    String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      try {
        let row;
        let parsedAsJson = false;
        try {
          row = normalizeInputRow(JSON.parse(line), index);
          parsedAsJson = true;
        } catch (_) {
          row = normalizeInputRow(line, index);
        }
        if (!row) throw new Error('不是可识别的记录');
        if (!parsedAsJson && !extractDoiFromText(row.doi || JSON.stringify(row))) throw new Error('未识别到 DOI');
        rows.push({ row, lineNumber: index + 1 });
      } catch (err) {
        errors.push(`第 ${index + 1} 行：${err.message || err}`);
      }
    });
    if (errors.length) throw new Error(`JSONL 解析失败：${errors.slice(0, 5).join('；')}`);
    return rows;
  }

  function parseCsvLine(line, delimiter = ',') {
    const cells = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (ch === delimiter && !quoted) {
        cells.push(value.trim());
        value = '';
      } else {
        value += ch;
      }
    }
    cells.push(value.trim());
    return cells;
  }

  function parseDoiLines(text) {
    return String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)
      .map((line, index) => ({
        row: { record_id: index + 1, doi: extractDoiFromText(line), title: '' },
        lineNumber: index + 1
      }))
      .filter(item => item.row.doi);
  }

  function parseCsv(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
    if (!lines.length) return [];
    const candidates = [',', '\t', ';'];
    const delimiter = candidates
      .map(value => ({ value, count: parseCsvLine(lines[0], value).length }))
      .sort((a, b) => b.count - a.count)[0];
    if (!delimiter || delimiter.count < 2) return parseDoiLines(text);
    const headers = parseCsvLine(lines[0], delimiter.value).map(value => value.trim());
    return lines.slice(1).map((line, index) => {
      const cells = parseCsvLine(line, delimiter.value);
      const row = {};
      headers.forEach((header, column) => { row[header] = cells[column] || ''; });
      return { row, lineNumber: index + 2 };
    });
  }

  function parseInput(text, filename = '') {
    const clean = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!clean) return [];
    const ext = String(filename || '').toLowerCase().split('.').pop();
    if (ext === 'csv' || ext === 'tsv') return parseCsv(clean);
    if (ext === 'txt') return parseDoiLines(clean);
    if (ext === 'json') {
      const parsed = JSON.parse(clean);
      const containers = Array.isArray(parsed) ? parsed : [
        parsed.records, parsed.items, parsed.articles, parsed.publications, parsed.works,
        parsed.data, parsed.results, parsed.dois, parsed.message?.items,
        parsed.data?.items, parsed.data?.records, parsed.results?.items
      ];
      const values = Array.isArray(parsed)
        ? parsed
        : (containers.find(Array.isArray) ||
          (parsed.message && typeof parsed.message === 'object' ? [parsed.message] : [parsed]));
      if (!Array.isArray(values)) throw new Error('JSON 中没有可识别的文献数组');
      return values.map((value, index) => ({ row: normalizeInputRow(value, index), lineNumber: index + 1 }))
        .filter(item => item.row);
    }
    return parseJsonl(clean);
  }

  function buildTasks(rows) {
    const seen = new Map();
    return rows.map(({ row, lineNumber }, index) => {
      const recordId = rowValue(row, ['record_id', 'literature_record_id', 'id', 'order_id', 'sort_id', 'rank']) || String(lineNumber);
      const doi = explicitDoiFromRow(row);
      const classification = classifyPublisher(row, doi);
      const task = {
        taskId: `scholarflow:${recordId}:${lineNumber}`,
        recordId,
        sourceOrder: index + 1,
        title: rowValue(row, ['title', 'article_title', 'paper_title', 'document_title', 'name']) || `DOI ${doi}`,
        titleZh: rowValue(row, ['title_zh', 'chinese_title', 'translated_title']),
        doi,
        landingUrl: String(row.landing_url || row.landingUrl || '').trim(),
        sourcePdfUrl: String(row.pdf_url || row.pdfUrl || '').trim(),
        publisher: classification.publisher,
        lane: classification.lane,
        journalName: rowValue(row, ['journal_name', 'journal', 'journal_title', 'container_title', 'container-title', 'publication_name']),
        sourceName: rowValue(row, ['source_name', 'source']),
        receivedAt: rowValue(row, ['received_at', 'received', 'created_at']),
        decision: rowValue(row, ['decision', 'screening_decision']),
        status: 'pending',
        attempts: 0,
        result: null
      };
      if (!doi) {
        task.status = 'missing_doi';
        task.result = { error_code: 'missing_doi', message: '源记录没有 DOI' };
      } else {
        const key = doi.toLowerCase();
        if (seen.has(key)) {
          task.status = 'duplicate_doi';
          task.result = { error_code: 'duplicate_doi', duplicate_of: seen.get(key) };
        } else {
          seen.set(key, task.taskId);
        }
      }
      return task;
    });
  }

  async function importFile() {
    if (loopActive) return;
    const input = byId('scholarFlowFile');
    const file = input?.files?.[0];
    if (!file) {
      appendLog('请先选择包含 DOI 的 JSONL、JSON、CSV 或 TXT 文件。');
      return;
    }
    try {
      const rows = parseInput(await file.text(), file.name);
      if (!rows.length) throw new Error('文件中没有识别到 DOI');
      const state = emptyState();
      state.sourceName = file.name;
      state.importedAt = new Date().toISOString();
      state.tasks = buildTasks(rows);
      await saveState(state);
      const c = counts(state);
      appendLog(`已导入 ${c.total} 条：可下载 ${c.pending || 0}，缺 DOI ${c.missing_doi || 0}，重复 DOI ${c.duplicate_doi || 0}。`);
      await render();
    } catch (err) {
      appendLog(`导入失败：${err.message || err}`);
    }
  }

  function mapBlockedStatus(msg) {
    const reason = String(msg?.skipReason || msg?.timeoutReason || msg?.failureReason || '').toLowerCase();
    const text = String(msg?.message || '').toLowerCase();
    if (reason === 'no_access' || reason === 'explicit_no_subscription') return 'no_access';
    if (reason === 'login_required') return 'login_required';
    if (reason === 'cf_challenge') return 'publisher_challenge';
    if (reason.includes('unsupported') || reason === 'publisher_unsupported' || reason === 'invalid_landing_url') return 'unsupported_publisher';
    if (reason.includes('doi_')) return 'doi_not_found';
    if (reason.includes('timeout')) return 'failed';
    if (/html|不是 pdf|login/.test(text)) return 'not_pdf';
    return reason || 'failed';
  }

  function runOne(task) {
    return new Promise(resolve => {
      const port = chrome.runtime.connect({ name: 'ablesci-pdf-upload' });
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (_) {}
        resolve(result);
      };
      port.onMessage.addListener(msg => {
        if (!msg) return;
        if (msg.type === 'progress') {
          appendLog(`${task.recordId}: ${msg.message || ''}`);
        } else if (msg.type === 'done') {
          const titleStatus = String(msg.titleValidation?.status || '');
          const cleanerStatus = String(msg.pdfCleanerResult?.status || '');
          const needsReview = (titleStatus && titleStatus !== 'matched') ||
            (cleanerStatus && !['cleaned', 'no_watermark'].includes(cleanerStatus));
          const status = msg.blocked || msg.skipped
            ? mapBlockedStatus(msg)
            : (needsReview ? 'manual_review' : 'downloaded');
          finish({
            status,
            result: {
              attempted_at: new Date().toISOString(),
              source_used: 'doi',
              filename: msg.filename || '',
              relative_path: msg.filename ? `${taskSubdir(task)}/${msg.filename}` : '',
              size: Number(msg.size || 0),
              page_count: Number(msg.pageCount || 0),
              md5: msg.md5 || '',
              title_validation: msg.titleValidation || null,
              watermark_status: msg.pdfCleanerResult?.status || '',
              error_code: status === 'downloaded' ? '' : (msg.skipReason || msg.timeoutReason || status),
              message: msg.message || ''
            }
          });
        } else if (msg.type === 'error') {
          finish({
            status: mapBlockedStatus(msg),
            result: {
              attempted_at: new Date().toISOString(),
              source_used: 'doi',
              error_code: msg.failureReason || 'failed',
              message: msg.message || '下载失败'
            }
          });
        }
      });
      port.onDisconnect.addListener(() => {
        finish({
          status: 'failed',
          result: {
            attempted_at: new Date().toISOString(),
            source_used: 'doi',
            error_code: 'port_disconnected',
            message: '插件后台连接已断开'
          }
        });
      });
      port.postMessage({
        type: 'startUpload',
        payload: {
          taskMode: 'literature_download',
          taskId: task.taskId,
          recordId: task.recordId,
          doi: task.doi,
          title: task.title,
          journalName: task.journalName,
          pdfUrl: `https://doi.org/${task.doi}`,
          pageUrl: `https://doi.org/${task.doi}`,
          pdfUrlSource: 'scholarflow_doi',
          suggestedFilename: taskFilename(task),
          downloadSubdir: taskSubdir(task),
          downloadOnly: true,
          watcherPublisher: task.publisher,
          watcherMultiPublisherEnabled: true
        }
      });
    });
  }

  async function pacingDelayMs() {
    return 2 * 60 * 1000;
  }

  async function waitForLane(lane, delayMs) {
    await mutateState(state => {
      state.laneNextRunAt[lane] = new Date(Date.now() + delayMs).toISOString();
      state.nextRunAt = Object.values(state.laneNextRunAt).filter(Boolean).sort()[0] || '';
    });
    appendLog(`${LANE_LABELS[lane]} 槽等待 ${Math.round(delayMs / 60000)} 分钟；可点击“跳过等待”。`);
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        laneWakeDelays.delete(lane);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      laneWakeDelays.set(lane, finish);
      render().catch(() => {});
    });
    await mutateState(state => {
      delete state.laneNextRunAt[lane];
      state.nextRunAt = Object.values(state.laneNextRunAt).filter(Boolean).sort()[0] || '';
    });
  }

  async function runLane(lane) {
    while (running) {
      const claimed = await mutateState(state => {
        const task = state.tasks.find(item => item.status === 'pending' && item.lane === lane);
        if (!task) return null;
        task.status = 'running';
        task.attempts = Number(task.attempts || 0) + 1;
        return { task: { ...task }, total: state.tasks.length };
      });
      const claim = claimed.result;
      if (!claim) return;
      const task = claim.task;
      await render();
      appendLog(`${LANE_LABELS[lane]} 开始 ${task.sourceOrder}/${claim.total}：${task.recordId} / ${task.doi}`);
      const outcome = await runOne(task);
      const completed = await mutateState(state => {
        const current = state.tasks.find(item => item.taskId === task.taskId);
        if (current) {
          current.status = outcome.status;
          current.result = outcome.result;
        }
        return state.tasks.some(item => item.status === 'pending' && item.lane === lane);
      });
      appendLog(`${task.recordId}: ${outcome.status}`);
      await render();
      if (running && completed.result) await waitForLane(lane, await pacingDelayMs());
    }
  }

  async function start() {
    if (loopActive) return;
    loopActive = true;
    running = true;
    appendLog('开始批量下载：ScienceDirect、Wiley、其他出版社各一个槽；各槽内部每 2 分钟启动一项。');
    await render();
    try {
      await Promise.all(LANE_KEYS.map(runLane));
      const state = await loadState();
      if (!state.tasks.some(item => item.status === 'pending')) {
        appendLog('批量任务已完成。');
        await exportResults(true);
      }
    } finally {
      running = false;
      loopActive = false;
      for (const wake of Array.from(laneWakeDelays.values())) wake();
      laneWakeDelays.clear();
      await render();
    }
  }

  function pause() {
    running = false;
    for (const wake of Array.from(laneWakeDelays.values())) wake();
    appendLog('已请求暂停；不会启动下一项，当前正在处理的任务会继续完成。');
    render().catch(() => {});
  }

  async function skipWait() {
    if (!laneWakeDelays.size) return;
    const count = laneWakeDelays.size;
    for (const wake of Array.from(laneWakeDelays.values())) wake();
    await mutateState(state => {
      state.nextRunAt = '';
      state.laneNextRunAt = {};
    });
    appendLog(`已手动跳过 ${count} 个槽位的等待，继续下一项。`);
    await render();
  }

  function isIssueStatus(status) {
    return !['pending', 'running', 'downloaded', 'duplicate_doi'].includes(String(status || ''));
  }

  function resultRow(task) {
    return {
      schema_version: 1,
      task_id: task.taskId,
      record_id: task.recordId,
      source_order: task.sourceOrder,
      title: task.title,
      title_zh: task.titleZh,
      doi: task.doi,
      publisher: task.publisher,
      lane: task.lane,
      landing_url: task.landingUrl,
      source_pdf_url: task.sourcePdfUrl,
      journal_name: task.journalName,
      received_at: task.receivedAt,
      status: task.status,
      attempts: task.attempts,
      ...(task.result || {})
    };
  }

  async function downloadJsonl(rows, filename) {
    const content = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
    const url = URL.createObjectURL(new Blob([content], { type: 'application/x-ndjson;charset=utf-8' }));
    try {
      await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  }

  async function exportResults(automatic = false) {
    const state = await loadState();
    if (!state.tasks.length) {
      if (!automatic) appendLog('没有可导出的任务。');
      return;
    }
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const rows = state.tasks.map(resultRow);
    const issues = rows.filter(row => isIssueStatus(row.status));
    await downloadJsonl(rows, `${OUTPUT_ROOT}/index/pdf-download-results-${date}.jsonl`);
    await downloadJsonl(issues, `${OUTPUT_ROOT}/issues/${date}/download-issues.jsonl`);
    appendLog(`已导出完整结果 ${rows.length} 条、问题记录 ${issues.length} 条。`);
  }

  async function reset() {
    if (loopActive) {
      appendLog('请先暂停，等待当前任务完成后再清空。');
      return;
    }
    if (!confirm('确定清空 ScholarFlow 下载任务和本地状态吗？已下载的 PDF 不会删除。')) return;
    await chrome.storage.local.remove(STATE_KEY);
    const log = byId('scholarFlowLog');
    if (log) log.textContent = '';
    await render();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    byId('scholarFlowImport')?.addEventListener('click', importFile);
    byId('scholarFlowStart')?.addEventListener('click', start);
    byId('scholarFlowSkipWait')?.addEventListener('click', skipWait);
    byId('scholarFlowPause')?.addEventListener('click', pause);
    byId('scholarFlowExport')?.addEventListener('click', () => exportResults(false));
    byId('scholarFlowReset')?.addEventListener('click', reset);
    try {
      await recoverInterruptedTasks();
      await render();
    } catch (err) {
      appendLog(`读取任务状态失败：${err.message || err}`);
    }
  });

  globalThis.AblesciScholarFlowLiterature = {
    normalizeDoi,
    extractDoiFromText,
    safePart,
    parseJsonl,
    parseDoiLines,
    parseCsv,
    parseInput,
    buildTasks,
    explicitDoiFromRow,
    rowValue,
    publisherFromDoi,
    publisherFromUrl,
    classifyPublisher,
    taskFilename,
    taskSubdir,
    pacingDelayMs,
    isIssueStatus
  };
})(globalThis);
