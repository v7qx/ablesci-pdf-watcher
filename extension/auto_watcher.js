'use strict';

(function () {
  const ALARM_NAME = 'ablesciAutoWatcher';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const AUTO_WATCHER_LOG_KEY = 'autoWatcherLogs';
  const JOURNAL_ACCESS_STATS_KEY = 'journalAccessStats';
  const MAX_LOGS = 200;
  const REPORT_DIR = 'ablesci-watcher-reports';

  let deps = null;
  let autoWatcherRunning = false;

  function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeListUrls(value, fallback) {
    const raw = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
    const urls = raw
      .map(s => String(s || '').trim())
      .filter(Boolean)
      .filter(url => {
        try {
          const u = new URL(url);
          return u.protocol === 'https:' && /(^|\.)ablesci\.com$/i.test(u.hostname);
        } catch (_) {
          return false;
        }
      });
    return urls.length ? urls : fallback.slice();
  }

  function normalizeOptions(opts) {
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 60);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    return {
      ...opts,
      watcherEnabled: opts.watcherEnabled === true,
      watcherIntervalMinutes: clampNumber(opts.watcherIntervalMinutes, 30, min, max),
      watcherMinIntervalMinutes: min,
      watcherMaxIntervalMinutes: max,
      watcherMaxCandidatesPerRun: 1,
      watcherListUrls: normalizeListUrls(opts.watcherListUrls, deps.defaultListUrls),
      watcherUploadCountdownSeconds: clampNumber(opts.watcherUploadCountdownSeconds, 10, 0, 120),
      watcherDailyLimit: clampNumber(opts.watcherDailyLimit, 10, 0, 100),
      watcherSkipHighRiskJournal: opts.watcherSkipHighRiskJournal !== false,
      watcherDailyReportEnabled: opts.watcherDailyReportEnabled !== false
    };
  }

  function randomIntervalMinutes(opts) {
    const base = clampNumber(opts.watcherIntervalMinutes, 30, 10, 60);
    const min = clampNumber(opts.watcherMinIntervalMinutes, 10, 1, 60);
    const max = clampNumber(opts.watcherMaxIntervalMinutes, 60, min, 1440);
    const jitter = Math.max(1, Math.round(base * 0.2));
    const low = Math.max(min, base - jitter);
    const high = Math.min(max, base + jitter);
    return low + Math.random() * Math.max(1, high - low);
  }

  async function refreshAutoWatcherAlarm(clearExisting = true) {
    const opts = normalizeOptions(await deps.getOptions());
    if (clearExisting) await chrome.alarms.clear(ALARM_NAME);
    if (!opts.watcherEnabled) return;
    await chrome.alarms.create(ALARM_NAME, { delayInMinutes: randomIntervalMinutes(opts) });
  }

  function notifyWatcherNeedsAttention(reason, url) {
    const message = normalizeText(reason || '低频值守需要人工处理。').slice(0, 160);
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Ablesci PDF Watcher',
        message,
        priority: 1,
        requireInteraction: false
      });
    } catch (_) {}
    if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
  }

  async function getWatcherState() {
    const stored = await chrome.storage.local.get(AUTO_WATCHER_STATE_KEY);
    return stored[AUTO_WATCHER_STATE_KEY] || { processed: {}, daily: {} };
  }

  async function saveWatcherState(state) {
    await chrome.storage.local.set({ [AUTO_WATCHER_STATE_KEY]: state });
  }

  async function updateProcessed(key, status, reason) {
    if (!key) return;
    const state = await getWatcherState();
    state.processed = state.processed || {};
    state.processed[key] = {
      lastAt: new Date().toISOString(),
      status,
      reason: normalizeText(reason).slice(0, 160)
    };
    await saveWatcherState(state);
  }

  async function incrementDaily(field) {
    const state = await getWatcherState();
    const key = todayKey();
    state.daily = state.daily || {};
    state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
    state.daily[key][field] = Number(state.daily[key][field] || 0) + 1;
    await saveWatcherState(state);
  }

  async function getDailyCount(field) {
    const state = await getWatcherState();
    const item = state.daily?.[todayKey()] || {};
    return Number(item[field] || 0);
  }

  async function appendWatcherLog(entry) {
    const stored = await chrome.storage.local.get(AUTO_WATCHER_LOG_KEY);
    const logs = Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [];
    logs.unshift({
      time: new Date().toISOString(),
      assistId: entry.assistId || '',
      title: normalizeText(entry.title).slice(0, 160),
      doi: normalizeText(entry.doi).slice(0, 160),
      journalName: normalizeText(entry.journalName).slice(0, 160),
      detailUrlHostPath: deps.urlHostPath(entry.detailUrl || ''),
      status: normalizeText(entry.status).slice(0, 80),
      reason: normalizeText(entry.reason).slice(0, 160)
    });
    await chrome.storage.local.set({ [AUTO_WATCHER_LOG_KEY]: logs.slice(0, MAX_LOGS) });
  }

  function csvEscape(value) {
    return '"' + String(value ?? '').replace(/"/g, '""') + '"';
  }

  function dataUrl(content, mime) {
    return `data:${mime};charset=utf-8,${encodeURIComponent(content)}`;
  }

  async function writeReportFile(filename, content, mime) {
    try {
      await chrome.downloads.download({
        url: dataUrl(content, mime),
        filename,
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
    const stored = await chrome.storage.local.get([AUTO_WATCHER_STATE_KEY, AUTO_WATCHER_LOG_KEY]);
    const state = stored[AUTO_WATCHER_STATE_KEY] || {};
    const daily = state.daily?.[date] || {};
    const logs = (Array.isArray(stored[AUTO_WATCHER_LOG_KEY]) ? stored[AUTO_WATCHER_LOG_KEY] : [])
      .filter(log => String(log.time || '').startsWith(date));

    const csvRows = [
      ['time', 'assistId', 'doi', 'journalName', 'detailUrlHostPath', 'status', 'reason'],
      ...logs.map(log => [
        log.time || '',
        log.assistId || '',
        log.doi || '',
        log.journalName || '',
        `${log.detailUrlHostPath?.host || ''}${log.detailUrlHostPath?.path || ''}`,
        log.status || '',
        log.reason || ''
      ])
    ];
    const csv = csvRows.map(row => row.map(csvEscape).join(',')).join('\n') + '\n';

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
      '',
      '## Recent Logs',
      '',
      '| Time | Status | Reason | Journal | DOI | Detail |',
      '| --- | --- | --- | --- | --- | --- |',
      ...logs.slice(0, 80).map(log => [
        log.time || '',
        log.status || '',
        log.reason || '',
        log.journalName || '',
        log.doi || '',
        `${log.detailUrlHostPath?.host || ''}${log.detailUrlHostPath?.path || ''}`
      ].map(v => String(v).replace(/\|/g, '\\|')).join(' | '))
        .map(row => `| ${row} |`),
      ''
    ].join('\n');

    await writeReportFile(`${REPORT_DIR}/${date}.csv`, csv, 'text/csv');
    await writeReportFile(`${REPORT_DIR}/${date}.md`, md, 'text/markdown');
  }

  function getProcessedKey(candidate, payload) {
    return payload?.assistId || candidate?.assistId || candidate?.detailUrl || '';
  }

  async function wasRecentlyProcessed(candidate) {
    const key = getProcessedKey(candidate);
    if (!key) return false;
    const state = await getWatcherState();
    return !!state.processed?.[key];
  }

  function parseAssistListPage() {
    function text(el) {
      return String(el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function absUrl(href) {
      try { return new URL(href, location.href).href; } catch (_) { return ''; }
    }
    function doiFrom(textValue) {
      const match = String(textValue || '').match(/10\.\d{4,9}\/[\S"'<>]+/i);
      if (!match) return '';
      return match[0].split('#')[0].split('?')[0].replace(/[)\].,;，。]+$/, '');
    }
    const bodyText = text(document.body);
    if (/Cloudflare|Just a moment|请完成验证|验证你是真人|人机验证|安全检查/i.test(bodyText)) {
      return { cfChallenge: true, candidates: [] };
    }

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
      const journalShortName = detailAnchor?.querySelector('span[title]')?.getAttribute('title') ||
        row.querySelector('.paper-publisher img[title]')?.getAttribute('title') || '';
      const doi = doiFrom(rowText);
      return {
        assistId,
        detailUrl,
        title,
        rowText,
        doi,
        hasDoi: !!doi,
        journalShortName,
        reported: /举报|被举报|涉嫌违规/.test(rowText),
        rejected: /驳回|已驳回/.test(rowText),
        supplement: /补充材料|Supplement|supporting information|学位论文/i.test(rowText),
        statusText,
        sticky: /stick-assist|置顶/.test(classText + ' ' + rowText),
        index
      };
    }).filter(item => item.detailUrl);

    return { cfChallenge: false, candidates: candidates.reverse() };
  }

  function isListCandidateAllowed(candidate, opts) {
    const textValue = [candidate.rowText, candidate.title, candidate.statusText].join(' ');
    if (!candidate.detailUrl) return { ok: false, reason: 'missing_detail_url' };
    if (candidate.sticky) return { ok: false, reason: 'sticky_assist' };
    if (!/求助中|waiting|我要应助|可应助/i.test(textValue)) return { ok: false, reason: 'not_waiting' };
    if (opts.watcherSkipReported && candidate.reported) return { ok: false, reason: 'reported' };
    if (opts.watcherSkipRejected && candidate.rejected) return { ok: false, reason: 'rejected' };
    if (opts.watcherSkipSupplement && candidate.supplement) return { ok: false, reason: 'supplement' };
    if (opts.watcherSkipRiskText && /特殊文件|指定版本|不是全文|网页即可阅读|CAJ|epub/i.test(textValue)) {
      return { ok: false, reason: 'risk_text' };
    }
    return { ok: true };
  }

  function isDetailAllowedForWatcher(payload, opts) {
    if (!payload?.assistId) return { ok: false, reason: 'missing_assist_id' };
    if (opts.watcherRequireDoi && !payload?.doi) return { ok: false, reason: 'missing_doi' };
    if (!payload?.pdfUrl) return { ok: false, reason: 'missing_pdf_url' };

    const textValue = [
      payload.statusText || '',
      payload.riskText || '',
      payload.title || '',
      ...(Array.isArray(payload.riskReasons) ? payload.riskReasons : [])
    ].join(' ');

    if (/举报|被举报|驳回|已驳回|投诉|补充材料|Supplement|supporting information/i.test(textValue)) {
      return { ok: false, reason: 'detail_risk_text' };
    }
    return { ok: true };
  }

  async function isHighRiskJournal(journalName) {
    const journal = normalizeText(journalName);
    if (!journal) return false;
    const stored = await chrome.storage.local.get(JOURNAL_ACCESS_STATS_KEY);
    const stats = stored[JOURNAL_ACCESS_STATS_KEY] || {};
    const item = stats[journal];
    if (!item) return false;
    const failCount = Number(item.failCount || 0);
    const successCount = Number(item.successCount || 0);
    return failCount >= 2 && failCount > successCount;
  }

  async function waitForTabComplete(tabId, timeoutMs = 45000) {
    return await new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(false, new Error('tab_load_timeout')), timeoutMs);
      function finish(ok, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        ok ? resolve(value) : reject(value);
      }
      function listener(updatedTabId, changeInfo, tab) {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === 'complete') finish(true, tab);
      }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId).then(tab => {
        if (tab.status === 'complete') finish(true, tab);
      }).catch(err => finish(false, err));
    });
  }

  async function openHiddenTab(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tab.id);
    return tab;
  }

  async function closeTabQuietly(tabId) {
    try { await chrome.tabs.remove(tabId); } catch (_) {}
  }

  async function parseListUrl(url) {
    const tab = await openHiddenTab(url);
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: parseAssistListPage
      });
      return result?.[0]?.result || { cfChallenge: false, candidates: [] };
    } finally {
      await closeTabQuietly(tab.id);
    }
  }

  async function sendDetailMessage(tabId) {
    return await chrome.tabs.sendMessage(tabId, { type: 'ablesciExtractDetailPayload' });
  }

  async function extractDetailPayload(tabId) {
    for (let i = 0; i < 5; i += 1) {
      try {
        const response = await sendDetailMessage(tabId);
        if (response) return response;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['adapters.js', 'content_ablesci.js']
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    return await sendDetailMessage(tabId);
  }

  async function inspectDetail(candidate) {
    const tab = await openHiddenTab(candidate.detailUrl);
    try {
      const response = await extractDetailPayload(tab.id);
      if (!response?.ok) {
        return { ok: false, reason: response?.error || 'extract_detail_failed', tabId: tab.id };
      }
      return { ok: true, payload: response.payload, tabId: tab.id };
    } catch (err) {
      return { ok: false, reason: err?.message || String(err), tabId: tab.id };
    }
  }

  function makeWatcherPort(context) {
    return {
      name: 'ablesci-auto-watcher',
      postMessage(msg) {
        if (!msg || !context) return;
        if (msg.type === 'error') {
          updateProcessed(context.key, 'failed', msg.message || 'upload_failed').catch(() => {});
          incrementDaily('failed').catch(() => {});
          appendWatcherLog({
            ...context.payload,
            detailUrl: context.detailUrl,
            status: 'failed',
            reason: msg.message || 'upload_failed'
          }).then(writeDailyReports).catch(() => {});
        }
        if (msg.type === 'done' && msg.blocked) {
          updateProcessed(context.key, 'failed', msg.message || 'blocked').catch(() => {});
          incrementDaily('failed').catch(() => {});
          appendWatcherLog({
            ...context.payload,
            detailUrl: context.detailUrl,
            status: 'failed',
            reason: msg.message || 'blocked'
          }).then(writeDailyReports).catch(() => {});
        }
      },
      onDisconnect: {
        addListener() {}
      }
    };
  }

  async function handleAllowedPayload(candidate, payload, opts, detailTabId) {
    payload.triggeredBy = 'auto_watcher';
    const key = getProcessedKey(candidate, payload);

    if (opts.watcherSkipHighRiskJournal && await isHighRiskJournal(payload.journalName)) {
      await closeTabQuietly(detailTabId);
      await updateProcessed(key, 'skipped', 'high_risk_journal');
      await incrementDaily('skipped');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: '本地记录近期多次失败，可能无权限' });
      return false;
    }

    if (!opts.watcherAutoDownload) {
      notifyWatcherNeedsAttention('低频值守发现候选，已保留求助详情页等待人工处理。', candidate.detailUrl);
      await incrementDaily('notified');
      await updateProcessed(key, 'skipped', 'manual_detail_opened');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: 'manual_detail_opened' });
      return true;
    }

    if (!opts.watcherAutoUpload || opts.watcherUploadConfirmRequired) {
      payload.downloadOnly = true;
      payload.riskReasons = [
        ...(Array.isArray(payload.riskReasons) ? payload.riskReasons : []),
        '低频值守默认仅下载并校验 PDF，上传需要人工确认。'
      ];
    }

    if (deps.hasActiveTask()) {
      await updateProcessed(key, 'skipped', 'active_task');
      await incrementDaily('skipped');
      await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: 'active_task' });
      return false;
    }

    deps.enqueueUpload(makeWatcherPort({ key, payload, detailUrl: candidate.detailUrl }), payload);
    if (!payload.downloadOnly) await closeTabQuietly(detailTabId);
    await incrementDaily('downloaded');
    if (opts.watcherAutoUpload && !opts.watcherUploadConfirmRequired) await incrementDaily('uploaded');
    await updateProcessed(key, 'success', payload.downloadOnly ? 'queued_download_only' : 'queued_upload');
    await appendWatcherLog({
      ...payload,
      detailUrl: candidate.detailUrl,
      status: payload.downloadOnly ? 'download_only' : 'queued_upload',
      reason: payload.downloadOnly ? 'upload_confirmation_required' : 'auto_upload_enabled'
    });
    notifyWatcherNeedsAttention(payload.downloadOnly ? '低频值守已排队下载校验一个候选，并保留求助详情页等待人工上传确认。' : '低频值守已排队处理一个候选。');
    await incrementDaily('notified');
    return true;
  }

  async function runAutoWatcherOnce(trigger = 'alarm') {
    if (autoWatcherRunning) return { ok: false, reason: 'already_running' };
    autoWatcherRunning = true;
    try {
      const opts = normalizeOptions(await deps.getOptions());
      if (!opts.watcherEnabled && trigger !== 'manual') return { ok: false, reason: 'disabled' };
      if (deps.hasActiveTask()) return { ok: false, reason: 'active_task' };
      if (opts.watcherDailyLimit > 0 && await getDailyCount('downloaded') >= opts.watcherDailyLimit) {
        return { ok: false, reason: 'daily_limit' };
      }

      for (const listUrl of opts.watcherListUrls) {
        await incrementDaily('checked');
        const parsed = await parseListUrl(listUrl);
        if (parsed.cfChallenge) {
          if (opts.watcherStopOnCfChallenge) notifyWatcherNeedsAttention('Ablesci 出现验证页，需要手动处理。', listUrl);
          await incrementDaily('notified');
          await incrementDaily('failed');
          await appendWatcherLog({ detailUrl: listUrl, status: 'blocked', reason: 'cf_challenge' });
          return { ok: false, reason: 'cf_challenge' };
        }

        for (const candidate of parsed.candidates || []) {
          const listAllowed = isListCandidateAllowed(candidate, opts);
          if (!listAllowed.ok) continue;
          if (await wasRecentlyProcessed(candidate)) continue;

          const detail = await inspectDetail(candidate);
          if (!detail.ok) {
            await closeTabQuietly(detail.tabId);
            await updateProcessed(getProcessedKey(candidate), 'failed', detail.reason);
            await incrementDaily('failed');
            await appendWatcherLog({ ...candidate, status: 'failed', reason: detail.reason });
            continue;
          }

          const payload = detail.payload;
          const detailAllowed = isDetailAllowedForWatcher(payload, opts);
          const key = getProcessedKey(candidate, payload);
          if (!detailAllowed.ok) {
            await closeTabQuietly(detail.tabId);
            await updateProcessed(key, 'skipped', detailAllowed.reason);
            await incrementDaily('skipped');
            await appendWatcherLog({ ...payload, detailUrl: candidate.detailUrl, status: 'skipped', reason: detailAllowed.reason });
            continue;
          }

          const handled = await handleAllowedPayload(candidate, payload, opts, detail.tabId);
          if (!handled) await closeTabQuietly(detail.tabId);
          if (handled) return { ok: true, reason: 'candidate_handled' };
        }
      }

      return { ok: true, reason: 'no_candidate' };
    } catch (err) {
      await incrementDaily('failed');
      await appendWatcherLog({ status: 'failed', reason: err?.message || String(err) });
      return { ok: false, reason: err?.message || String(err) };
    } finally {
      try { await writeDailyReports(); } catch (_) {}
      if (trigger === 'alarm') refreshAutoWatcherAlarm().catch(() => {});
      autoWatcherRunning = false;
    }
  }

  function initPrivateAutoWatcher(nextDeps) {
    deps = nextDeps;
    try { chrome.action.setBadgeText({ text: '' }); } catch (_) {}

    chrome.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM_NAME) runAutoWatcherOnce('alarm');
    });

    chrome.runtime.onStartup.addListener(() => {
      refreshAutoWatcherAlarm().catch(() => {});
    });

    chrome.runtime.onInstalled.addListener(() => {
      refreshAutoWatcherAlarm().catch(() => {});
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (Object.keys(changes).some(key => key.startsWith('watcher'))) {
        refreshAutoWatcherAlarm().catch(() => {});
      }
    });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'ablesciRunAutoWatcherNow') {
        runAutoWatcherOnce('manual').then(sendResponse);
        return true;
      }
      if (msg?.type === 'ablesciClearAutoWatcherState') {
        chrome.storage.local.remove(AUTO_WATCHER_STATE_KEY).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg?.type === 'ablesciClearAutoWatcherLogs') {
        chrome.storage.local.remove(AUTO_WATCHER_LOG_KEY).then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    });

    refreshAutoWatcherAlarm().catch(() => {});
  }

  globalThis.initPrivateAutoWatcher = initPrivateAutoWatcher;
})();
