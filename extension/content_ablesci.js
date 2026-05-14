(function () {
  'use strict';

  const BTN_ID = 'ablesci-native-oneclick-pdf-btn';
  const LOG_ID = 'ablesci-native-oneclick-pdf-log';
  const DEFAULT_PAGE_OPTIONS = {
    smartRecommendPush: true,
    buttonLabel: '上传PDF',
    buttonColor: '#FF5722',
    buttonTextColor: '#ffffff',
    buttonPosition: 'end'
  };
  let currentUploadPort = null;
  let pageOptions = { ...DEFAULT_PAGE_OPTIONS };

  function $(sel, root = document) { return root.querySelector(sel); }

  function getCsrf() {
    const csrfParam = $('meta[name="csrf-param"]')?.content || '_csrf';
    const csrfToken = $('meta[name="csrf-token"]')?.content || '';
    if (!csrfToken) throw new Error('没有找到 csrf-token');
    return { csrfParam, csrfToken };
  }

  function getAssistId() {
    const v =
      $('.uploading-assist-id-val')?.value ||
      $('.assist-id-val')?.value ||
      $('input[name="assist_id"]')?.value ||
      new URLSearchParams(location.search).get('id') ||
      '';
    if (!v) throw new Error('没有找到 assist_id');
    return v;
  }

  function isUploadBlocked() {
    const t = document.body ? document.body.innerText : '';
    return /已经有人上传了文献|请等待求助人确认|待确认|已完成|已关闭/.test(t);
  }

  function findQuickAssistButtonBar() {
    const rows = Array.from(document.querySelectorAll('tr'));
    const row = rows.find(tr => (tr.innerText || tr.textContent || '').includes('快捷应助'));
    if (!row) return null;
    const td = row.querySelector('td[colspan="2"]') ||
      row.querySelector('td[colspan]') ||
      row.querySelector('td:last-child') ||
      row.querySelector('td');
    if (!td) return null;
    const divs = Array.from(td.querySelectorAll(':scope > div'));
    if (divs.length >= 2) return divs[1];
    return td;
  }

  function findFallbackButtonMount() {
    return $('.assist-doi') ||
      $('.assist-url') ||
      $('.assist-title') ||
      $('.assist-detail td[colspan="2"]') ||
      $('.assist-detail td[colspan]') ||
      $('.assist-detail');
  }

  function findButtonMount() {
    const quickBar = findQuickAssistButtonBar();
    if (quickBar) return { mount: quickBar, kind: 'quick-assist' };
    const fallback = findFallbackButtonMount();
    if (fallback) return { mount: fallback, kind: 'fallback' };
    return { mount: null, kind: 'none' };
  }

  function ensureStyle() {
    if ($('#ablesci-native-oneclick-style')) return;
    const style = document.createElement('style');
    style.id = 'ablesci-native-oneclick-style';
    style.textContent = `
      #${BTN_ID} {
        margin-left: 5px !important;
        margin-right: 5px !important;
        background: var(--ablesci-btn-bg, #FF5722) !important;
        border-color: var(--ablesci-btn-bg, #FF5722) !important;
        color: var(--ablesci-btn-fg, #ffffff) !important;
        font-weight: bold !important;
        line-height: 22px !important;
        height: 22px !important;
        padding: 0 8px !important;
        border-radius: 2px !important;
        vertical-align: middle !important;
      }
      #${BTN_ID}:hover { color:var(--ablesci-btn-fg, #ffffff) !important; opacity:.86 !important; text-decoration:none !important; }
      #${BTN_ID}.busy { background:#999 !important; border-color:#999 !important; cursor:wait !important; }
      #${BTN_ID}.ok { background:#009688 !important; border-color:#009688 !important; }
      #${BTN_ID}.warn { background:#e5e7eb !important; border-color:#cbd5e1 !important; color:#334155 !important; }
      #${BTN_ID}.warn:hover { color:#334155 !important; }
      #${BTN_ID}.err { background:#a94442 !important; border-color:#a94442 !important; }
      #${LOG_ID} { display:inline-block; margin-left:8px; color:#777; font-size:12px; vertical-align:middle; max-width:520px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ablesci-native-layer-shade { position: fixed; inset: 0; background: rgba(0,0,0,.32); z-index: 2147483000; }
      .ablesci-native-layer { position: fixed; left: 50%; top: 12%; transform: translateX(-50%); width: min(680px, calc(100vw - 48px)); background: #fff; border-radius: 2px; box-shadow: 1px 1px 50px rgba(0,0,0,.3); z-index: 2147483001; font-size: 14px; color: #222; }
      .ablesci-native-layer-content { padding: 20px 28px; max-height: 62vh; overflow: auto; line-height: 1.65; }
      .ablesci-native-layer-content a { color: #01AAED; }
      .ablesci-native-layer-btn { padding: 12px 20px; border-top: 1px solid #eee; text-align: right; }
      .ablesci-native-layer-btn button { min-width: 86px; height: 38px; border: none; border-radius: 4px; background: #1E9FFF; color: #fff; cursor: pointer; font-size: 14px; }
      .ablesci-native-toast { position: fixed; left: 50%; top: 28%; transform: translateX(-50%); background: rgba(0,0,0,.78); color: #fff; z-index: 2147483001; padding: 10px 18px; border-radius: 3px; max-width: min(680px, calc(100vw - 48px)); line-height: 1.6; }
    `;
    document.head.appendChild(style);
  }

  function normalizeButtonLabel(value) {
    const s = String(value || '').trim();
    return (s.slice(0, 20) || DEFAULT_PAGE_OPTIONS.buttonLabel);
  }

  function isSafeHexColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(String(value || ''));
  }

  function normalizeButtonPosition(value) {
    return value === 'start' ? 'start' : 'end';
  }

  function normalizeUiOptions(opts) {
    return {
      smartRecommendPush: opts?.smartRecommendPush !== false,
      buttonLabel: normalizeButtonLabel(opts?.buttonLabel),
      buttonColor: isSafeHexColor(opts?.buttonColor) ? opts.buttonColor : DEFAULT_PAGE_OPTIONS.buttonColor,
      buttonTextColor: isSafeHexColor(opts?.buttonTextColor) ? opts.buttonTextColor : DEFAULT_PAGE_OPTIONS.buttonTextColor,
      buttonPosition: normalizeButtonPosition(opts?.buttonPosition)
    };
  }

  async function loadUiOptions() {
    const keys = Object.keys(DEFAULT_PAGE_OPTIONS);
    const local = await chrome.storage.local.get(keys);
    if (keys.some(k => local[k] !== undefined)) return normalizeUiOptions({ ...DEFAULT_PAGE_OPTIONS, ...local });
    const legacy = await chrome.storage.sync.get(DEFAULT_PAGE_OPTIONS);
    return normalizeUiOptions({ ...DEFAULT_PAGE_OPTIONS, ...legacy });
  }

  function idleButtonText() {
    return pageOptions.buttonLabel || DEFAULT_PAGE_OPTIONS.buttonLabel;
  }

  function applyButtonAppearance(btn) {
    if (!btn) return;
    const opts = normalizeUiOptions(pageOptions);
    btn.style.setProperty('--ablesci-btn-bg', opts.buttonColor);
    btn.style.setProperty('--ablesci-btn-fg', opts.buttonTextColor);
  }

  function placeButton(found, btn, log) {
    const mount = found?.mount;
    if (!mount || !btn || !log) return;
    if (found.kind === 'quick-assist' && pageOptions.buttonPosition === 'start') {
      mount.insertBefore(log, mount.firstChild);
      mount.insertBefore(btn, mount.firstChild);
      return;
    }
    if (found.kind !== 'quick-assist' && btn.parentElement !== mount && log.parentElement !== mount) {
      mount.appendChild(document.createTextNode(' '));
    }
    mount.appendChild(btn);
    mount.appendChild(log);
  }

  function updateExistingButton() {
    const found = findButtonMount();
    const btn = $('#' + BTN_ID);
    const log = $('#' + LOG_ID);
    if (!found.mount || !btn || !log) return;
    applyButtonAppearance(btn);
    placeButton(found, btn, log);
    if (!btn.classList.contains('busy') &&
        !btn.classList.contains('ok') &&
        !btn.classList.contains('warn') &&
        !btn.classList.contains('err')) {
      btn.textContent = idleButtonText();
    }
  }

  function setStatus(msg, type) {
    const btn = $('#' + BTN_ID);
    const log = $('#' + LOG_ID);
    if (btn) {
      btn.classList.remove('busy', 'ok', 'err');
      btn.classList.remove('warn');
      if (type === 'downloadOnly') btn.classList.add('ok');
      else if (type === 'blocked') btn.classList.add('warn');
      else if (type) btn.classList.add(type);
      btn.textContent = type === 'busy'
        ? '处理中/取消'
        : type === 'downloadOnly'
          ? '仅下载完成'
          : type === 'blocked'
            ? '已停止'
          : type === 'ok'
            ? '上传成功'
            : type === 'err'
              ? '上传失败'
              : idleButtonText();
      if (!type) applyButtonAppearance(btn);
      btn.title = msg || '一键下载并上传 PDF';
    }
    if (log) log.textContent = msg || '';
    console.log('[Ablesci Native PDF Uploader]', msg);
  }


  function stripHtml(s) {
    const div = document.createElement('div');
    div.innerHTML = String(s || '');
    return (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
  }

  function reloadPageSoon(delay = 0) {
    setTimeout(() => {
      try { location.reload(); } catch (_) {}
    }, delay);
  }

  function showSiteLikeCompletion(msg) {
    const rawHtml = msg.html || msg.message || '上传成功';
    const plain = stripHtml(rawHtml) || '上传成功';
    const hasRecommend = msg.recomend === true || msg.recomend === 1 || msg.recomend === '1' || msg.recommend === true || msg.recommend === 1 || msg.recommend === '1';
    const shouldReload = msg.reload !== false;

    document.querySelectorAll('.ablesci-native-layer-shade,.ablesci-native-layer,.ablesci-native-toast').forEach(n => n.remove());

    if (!hasRecommend) {
      const toast = document.createElement('div');
      toast.className = 'ablesci-native-toast';
      toast.textContent = plain;
      document.body.appendChild(toast);
      if (shouldReload) reloadPageSoon(1500);
      return;
    }

    const shade = document.createElement('div');
    shade.className = 'ablesci-native-layer-shade';

    const box = document.createElement('div');
    box.className = 'ablesci-native-layer layui-layer layui-layer-dialog layui-layer-msg';

    const content = document.createElement('div');
    content.className = 'ablesci-native-layer-content layui-layer-content';
    content.innerHTML = rawHtml;

    const btnBar = document.createElement('div');
    btnBar.className = 'ablesci-native-layer-btn';

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '确定';
    ok.addEventListener('click', () => {
      shade.remove();
      box.remove();
      if (shouldReload) reloadPageSoon(0);
    });

    btnBar.appendChild(ok);
    box.appendChild(content);
    box.appendChild(btnBar);
    document.body.appendChild(shade);
    document.body.appendChild(box);
  }

  function normalizeText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function visibleText(el) {
    if (!el) return '';
    try {
      const style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return '';
    } catch (_) {}
    return normalizeText(el.innerText || el.textContent || '');
  }

  function detectPageRisk() {
    const reasons = [];
    const titleText = visibleText($('.assist-title'));

    if (/求助补充材料|补充材料求助|supporting information|supplementary material/i.test(titleText)) {
      reasons.push('当前求助类型是补充材料/SI，插件尚未支持补充材料自动应助。');
    }

    const rejectAlerts = Array.from(document.querySelectorAll('.reject-info-alert'))
      .map(visibleText)
      .filter(t => /驳回|应助历史|核实您的应助文件/.test(t));
    if (rejectAlerts.length > 0) {
      reasons.push('当前求助存在驳回应助记录，可能需要先人工核对应助文件。');
    }

    const reportWarnings = Array.from(document.querySelectorAll('.assist-detail [title], .assist-detail .text-orange'))
      .some(el => {
        const title = normalizeText(el.getAttribute?.('title') || '');
        const text = visibleText(el);
        return /涉嫌违规|正在被举报/.test(title) || /涉嫌违规.*举报|正在被举报/.test(text);
      });
    if (reportWarnings) {
      reasons.push('当前求助被网站标记为涉嫌违规或正在被举报。');
    }

    const systemWarnings = Array.from(document.querySelectorAll('.special-assist-alert, .assist-detail .alert-warning'))
      .map(visibleText)
      .filter(t => /系统提示/.test(t))
      .filter(t => /Supplementary|补充材料|并非全文|不是全文/i.test(t));
    if (systemWarnings.length > 0) {
      reasons.push('网站系统提示 DOI 可能对应补充材料或并非全文，需要人工核对。');
    }

    const remarkRows = Array.from(document.querySelectorAll('.assist-detail tr'))
      .map(tr => {
        const cells = Array.from(tr.children || []);
        return {
          label: visibleText(cells[0]),
          value: visibleText(cells[1])
        };
      })
      .filter(row => /^备注$/.test(row.label) && row.value);
    const remarkNotice = Array.from(document.querySelectorAll('.assist-detail td, .assist-detail div, .assist-detail span'))
      .map(visibleText)
      .some(t => /该求助存在备注|以备注为准/.test(t));
    if (remarkRows.length > 0 || remarkNotice) {
      reasons.push('当前求助存在备注，可能要求特定版本或附加条件，需以备注为准人工核对。');
    }

    return {
      downloadOnly: reasons.length > 0,
      reasons
    };
  }

  function collectPayload() {
    if (isUploadBlocked()) {
      throw new Error('当前页面看起来已经有人上传、待确认、已完成或已关闭，已停止。');
    }
    const picked = window.AblesciPdfAdapters.pickPdfUrlFromDocument(document);
    if (!picked.url) throw new Error('没有识别到 PDF 或出版商文章链接；当前版本只处理可下载的 PDF。');

    const { csrfParam, csrfToken } = getCsrf();
    const assistId = getAssistId();
    const doi = window.AblesciPdfAdapters.getFullDoiFromDocument(document);
    const suggestedFilename = window.AblesciPdfAdapters.makePdfFilename(document);
    const risk = detectPageRisk();

    return {
      pageUrl: location.href,
      csrfParam,
      csrfToken,
      assistId,
      doi,
      pdfUrl: picked.url,
      pdfUrlSource: picked.source,
      suggestedFilename,
      downloadOnly: risk.downloadOnly,
      riskReasons: risk.reasons
    };
  }

  function startUpload() {
    const btn = $('#' + BTN_ID);
    if (btn && btn.classList.contains('busy')) {
      if (currentUploadPort) {
        try { currentUploadPort.disconnect(); } catch (_) {}
        currentUploadPort = null;
      }
      setStatus('已取消当前任务；如果它在队列中会被移除，如果正在等待出版商页会关闭对应标签页。', null);
      return;
    }

    let payload;
    try {
      payload = collectPayload();
    } catch (err) {
      setStatus(err.message || String(err), 'err');
      return;
    }

    setStatus(payload.downloadOnly ? '风险页面：准备仅下载 PDF，不会自动上传...' : '准备下载 PDF...', 'busy');
    const port = chrome.runtime.connect({ name: 'ablesci-pdf-upload' });
    currentUploadPort = port;

    port.onMessage.addListener(msg => {
      if (!msg) return;
      if (msg.type === 'progress') setStatus(msg.message, 'busy');
      if (msg.type === 'done') {
        const completionMsg = (!msg.downloadOnly && !pageOptions.smartRecommendPush)
          ? { ...msg, message: '上传成功', html: '上传成功', recomend: false, recommend: false }
          : msg;
        setStatus(completionMsg.message || '上传成功', completionMsg.blocked ? 'blocked' : (completionMsg.downloadOnly ? 'downloadOnly' : 'ok'));
        if (!msg.downloadOnly) {
          showSiteLikeCompletion(completionMsg);
        }
        if (currentUploadPort === port) currentUploadPort = null;
        try { port.disconnect(); } catch (_) {}
      }
      if (msg.type === 'error') {
        setStatus(msg.message || '上传失败', 'err');
        if (currentUploadPort === port) currentUploadPort = null;
        try { port.disconnect(); } catch (_) {}
      }
    });

    port.onDisconnect.addListener(() => {
      if (currentUploadPort === port) currentUploadPort = null;
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message, 'err');
      }
    });

    port.postMessage({ type: 'startUpload', payload });
  }

  function addButton() {
    if ($('#' + BTN_ID)) return;
    const found = findButtonMount();
    if (!found.mount) {
      console.warn('[Ablesci Native PDF Uploader] no mount point found');
      return;
    }
    ensureStyle();

    const btn = document.createElement('a');
    btn.id = BTN_ID;
    btn.href = 'javascript:void(0);';
    btn.className = 'layui-btn layui-btn-xs';
    btn.textContent = idleButtonText();
    btn.title = 'Chrome 插件 + Native Helper：下载 PDF、算 MD5、上传 OSS；处理中可再次点击取消';
    applyButtonAppearance(btn);
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      startUpload();
    });

    const log = document.createElement('span');
    log.id = LOG_ID;

    placeButton(found, btn, log);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const keys = Object.keys(DEFAULT_PAGE_OPTIONS);
    if (!keys.some(k => changes[k])) return;
    loadUiOptions().then(opts => {
      pageOptions = opts;
      updateExistingButton();
    }).catch(() => {});
  });

  loadUiOptions().then(opts => {
    pageOptions = opts;
    addButton();
    setTimeout(addButton, 1000);
    setTimeout(addButton, 3000);
  }).catch(() => {
    addButton();
    setTimeout(addButton, 1000);
    setTimeout(addButton, 3000);
  });
})();
