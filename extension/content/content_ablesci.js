(function () {
  'use strict';

  const BTN_ID = 'ablesci-native-oneclick-pdf-btn';
  const LOG_ID = 'ablesci-native-oneclick-pdf-log';
  const DEFAULT_PAGE_OPTIONS = {
    smartRecommendPush: true,
    openAssistLinksInCurrentTab: false,
    buttonLabel: '上传PDF',
    buttonColor: '#FF5722',
    buttonTextColor: '#ffffff',
    buttonPosition: 'end',
    watcherLanguage: 'auto',
    watcherSkipCorrigendum: true,
    watcherEnableBlacklist: true,
    watcherBlacklistPath: ''
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
      #${LOG_ID} { display:none !important; }
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

  function getActiveLanguage() {
    const lang = pageOptions.watcherLanguage || 'auto';
    if (lang === 'zh') return 'zh';
    if (lang === 'en') return 'en';
    const browserLang = (navigator.language || '').toLowerCase();
    return browserLang.startsWith('zh') ? 'zh' : 'en';
  }

  const MESSAGE_MAP = {
    '当前出版商页面显示无正文订阅权限，已跳过本次任务并记录期刊权限状态。': 'The publisher page shows no full-text subscription access. This task has been skipped and the journal permission status recorded.',
    'ScienceDirect 需要登录或机构访问后才能继续。插件已保留这次为登录阻塞，不计入无权限期刊；完成登录后可重新触发。': 'ScienceDirect requires login or institutional access. The plugin has flagged this as login blocked, which is excluded from no-access journals; you can retry after logging in.',
    '检测到出版商验证页，已中断本次任务并计入验证次数；达到阈值后会自动暂停低频值守。': 'Publisher verification page (Cloudflare) detected. Task aborted and challenge count incremented; auto watcher will pause if threshold is reached.',
    'DOI 解析失败或不存在，已跳过本次任务。': 'DOI resolution failed or does not exist. Task skipped.',
    '已排队：等待当前 PDF 任务完成；关闭本页可取消。': 'Queued: Waiting for current PDF task to complete; close this page to cancel.',
    '已跳过': 'Skipped',
    '当前任务已跳过': 'Current task skipped',
    '上传成功': 'Upload Successful',
    '上传失败': 'Upload Failed',
    '仅下载完成': 'Downloaded Only'
  };

  function translateBackgroundMessage(msgText) {
    if (getActiveLanguage() !== 'en') return msgText;
    let trimmed = String(msgText || '').trim();
    let prefix = '';
    const prefixes = ['Failed: ', 'Failed：', '失败：', 'Warning: ', 'Warning：', '警告：', 'Success: ', 'Success：', '成功：'];
    for (const p of prefixes) {
      if (trimmed.startsWith(p)) {
        prefix = p.replace('失败：', 'Failed: ')
                  .replace('Failed：', 'Failed: ')
                  .replace('警告：', 'Warning: ')
                  .replace('Warning：', 'Warning: ')
                  .replace('成功：', 'Success: ')
                  .replace('Success：', 'Success: ');
        trimmed = trimmed.substring(p.length).trim();
        break;
      }
    }

    let translated = MESSAGE_MAP[trimmed];
    if (!translated) {
      if (trimmed.startsWith('开始处理任务：')) {
        translated = trimmed.replace('开始处理任务：', 'Starting task: ');
      } else if (trimmed.startsWith('已排队：')) {
        translated = 'Queued: Waiting for current PDF task to complete; close this page to cancel.';
      } else if (trimmed.includes('无正文订阅权限')) {
        translated = 'The publisher page shows no full-text subscription access. Task skipped.';
      } else if (trimmed.includes('需要登录或机构访问')) {
        translated = 'Login or institutional access required. Task marked as login blocked.';
      } else if (trimmed.includes('检测到出版商验证页')) {
        translated = 'Publisher verification page detected. Task aborted.';
      } else if (trimmed.includes('已取消当前任务')) {
        translated = 'Current task cancelled.';
      } else if (trimmed.includes('超时')) {
        translated = trimmed.replace('任务最长超时', 'Max task timeout')
                            .replace('已超过', ' exceeded ')
                            .replace('已超过', ' exceeded ')
                            .replace('分钟', ' minutes')
                            .replace('未触发下载超时', 'No download triggered timeout');
      } else {
        translated = trimmed;
      }
    }
    return prefix + translated;
  }

  function normalizeUiOptions(opts) {
    return {
      smartRecommendPush: opts?.smartRecommendPush !== false,
      openAssistLinksInCurrentTab: opts?.openAssistLinksInCurrentTab === true,
      buttonLabel: normalizeButtonLabel(opts?.buttonLabel),
      buttonColor: isSafeHexColor(opts?.buttonColor) ? opts.buttonColor : DEFAULT_PAGE_OPTIONS.buttonColor,
      buttonTextColor: isSafeHexColor(opts?.buttonTextColor) ? opts.buttonTextColor : DEFAULT_PAGE_OPTIONS.buttonTextColor,
      buttonPosition: normalizeButtonPosition(opts?.buttonPosition),
      watcherLanguage: ['auto', 'zh', 'en'].includes(opts?.watcherLanguage) ? opts.watcherLanguage : 'auto',
      watcherSkipCorrigendum: opts?.watcherSkipCorrigendum !== false,
      watcherEnableBlacklist: opts?.watcherEnableBlacklist !== false,
      watcherBlacklistPath: String(opts?.watcherBlacklistPath !== undefined ? opts.watcherBlacklistPath : DEFAULT_PAGE_OPTIONS.watcherBlacklistPath).trim()
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
    const label = pageOptions.buttonLabel || DEFAULT_PAGE_OPTIONS.buttonLabel;
    if (label === '上传PDF' && getActiveLanguage() === 'en') {
      return 'Upload PDF';
    }
    return label;
  }

  function defaultButtonTitle() {
    if (getActiveLanguage() === 'en') {
      return 'Download PDF, verify and upload; click again to cancel during processing';
    }
    return '下载 PDF、校验并上传；处理中可再次点击取消';
  }

  function setButtonTitle(btn, titleText = '') {
    if (!btn) return;
    const statusTitle = String(titleText || defaultButtonTitle()).trim();
    btn.dataset.ablesciStatusTitle = statusTitle;
    btn.title = statusTitle;
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
      setButtonTitle(btn, defaultButtonTitle());
    } else if (btn.classList.contains('busy')) {
      btn.textContent = getActiveLanguage() === 'en' ? 'Processing/Cancel' : '处理中/取消';
    } else if (btn.classList.contains('ok')) {
      btn.textContent = getActiveLanguage() === 'en' ? 'Upload Successful' : '上传成功';
      setButtonTitle(btn, getActiveLanguage() === 'en' ? 'Upload Successful' : '上传成功');
    } else if (btn.classList.contains('warn')) {
      btn.textContent = getActiveLanguage() === 'en' ? 'Stopped' : '已停止';
    } else if (btn.classList.contains('err')) {
      btn.textContent = getActiveLanguage() === 'en' ? 'Upload Failed' : '上传失败';
      setButtonTitle(btn, getActiveLanguage() === 'en' ? 'Upload Failed' : '上传失败');
    }
  }

  function setStatus(msg, type, extra = null) {
    const btn = $('#' + BTN_ID);
    const log = $('#' + LOG_ID);
    const titleText = extra && extra.title ? extra.title : msg;
    const logText = extra && Object.prototype.hasOwnProperty.call(extra, 'logText') ? extra.logText : msg;
    if (btn) {
      btn.classList.remove('busy', 'ok', 'err');
      btn.classList.remove('warn');
      if (type === 'downloadOnly') btn.classList.add('ok');
      else if (type === 'blocked') btn.classList.add('warn');
      else if (type) btn.classList.add(type);
      btn.textContent = type === 'busy'
        ? (getActiveLanguage() === 'en' ? 'Processing/Cancel' : '处理中/取消')
        : type === 'downloadOnly'
          ? (getActiveLanguage() === 'en' ? 'Downloaded Only' : '仅下载完成')
          : type === 'blocked'
            ? (getActiveLanguage() === 'en' ? 'Stopped' : '已停止')
          : type === 'ok'
            ? (getActiveLanguage() === 'en' ? 'Upload Successful' : '上传成功')
            : type === 'err'
              ? (getActiveLanguage() === 'en' ? 'Upload Failed' : '上传失败')
              : idleButtonText();
      if (!type) applyButtonAppearance(btn);
      setButtonTitle(btn, titleText || defaultButtonTitle());
    }
    if (log) log.textContent = logText || '';
    console.log('[Ablesci Native PDF Watcher]', msg);
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

  function isAssistDetailUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      return (url.hostname === 'ablesci.com' || url.hostname === 'www.ablesci.com') &&
        url.pathname.startsWith('/assist/detail');
    } catch (_) {
      return false;
    }
  }

  function shouldKeepDefaultClick(event) {
    return event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
  }

  function attachCurrentTabAssistLinkBehavior(root) {
    if (!root || root.dataset.ablesciCurrentTabAssistBound === '1') return;
    root.dataset.ablesciCurrentTabAssistBound = '1';

    const anchors = Array.from(root.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute('href');
      if (!isAssistDetailUrl(href)) continue;
      anchor.removeAttribute('target');
      anchor.rel = 'noopener noreferrer';
    }

    root.addEventListener('click', event => {
      if (!pageOptions.openAssistLinksInCurrentTab) return;
      if (shouldKeepDefaultClick(event)) return;
      const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!anchor) return;
      const href = anchor.href || anchor.getAttribute('href');
      if (!isAssistDetailUrl(href)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      location.assign(new URL(href, location.href).href);
    }, true);
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
    attachCurrentTabAssistLinkBehavior(content);

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
    const flags = {
      supplement: false,
      rejectedHistory: false,
      reportedWarning: false,
      systemRisk: false,
      systemPromptSupplementDoi: false,
      remark: false
    };
    const titleText = visibleText($('.assist-title'));

    if (/求助补充材料|补充材料求助|supporting information|supplementary material/i.test(titleText)) {
      flags.supplement = true;
      reasons.push('当前求助类型是补充材料/SI，插件尚未支持补充材料自动应助。');
    }

    const rejectAlerts = Array.from(document.querySelectorAll('.reject-info-alert'))
      .map(visibleText)
      .filter(t => /驳回|应助历史|核实您的应助文件/.test(t));
    if (rejectAlerts.length > 0) {
      flags.rejectedHistory = true;
      reasons.push('当前求助存在驳回应助记录，可能需要先人工核对应助文件。');
    }

    const reportWarnings = Array.from(document.querySelectorAll('.assist-detail [title], .assist-detail .text-orange'))
      .some(el => {
        const title = normalizeText(el.getAttribute?.('title') || '');
        const text = visibleText(el);
        return /涉嫌违规|正在被举报/.test(title) || /涉嫌违规.*举报|正在被举报/.test(text);
      });
    if (reportWarnings) {
      flags.reportedWarning = true;
      reasons.push('当前求助被网站标记为涉嫌违规或正在被举报。');
    }

    const systemWarnings = Array.from(document.querySelectorAll('.special-assist-alert, .assist-detail .alert-warning, .assist-detail .layui-alert, .assist-detail .layui-card-body'))
      .map(visibleText)
      .filter(t => /系统提示|提醒：由于doi是数字文件的唯一标识/i.test(t))
      .filter(t => /Supplementary|补充材料|并非全文|不是全文|该doi的文献可能是补充材料/i.test(t));
    if (systemWarnings.length > 0) {
      flags.systemRisk = true;
      flags.systemPromptSupplementDoi = true;
      reasons.push('网站系统提示该 DOI 可能对应补充材料或并非全文，已按异常情况跳过。');
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
      flags.remark = true;
      reasons.push('当前求助存在备注，可能要求特定版本或附加条件，需以备注为准人工核对。');
    }

    return {
      downloadOnly: reasons.length > 0,
      reasons,
      flags,
      remarkText: remarkRows.map(row => row.value).filter(Boolean).join('；')
    };
  }

  function cleanJournalName(value) {
    return String(value || '')
      .replace(/^期刊[:：]\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractDocumentTypeInfo() {
    const raw = visibleText(document.querySelector('.assist-title [title="文献类型"], .assist-title .paper-type, .assist-title .layui-badge'));
    const label = normalizeText(raw);
    if (!label) return { type: '', label: '' };
    if (/补充材料|supporting information|supplement/i.test(label)) return { type: 'supplement', label };
    if (/书籍（章节）|书籍章节|book chapter|chapter/i.test(label)) return { type: 'book_chapter', label };
    if (/专利、报告等|专利|patent|report/i.test(label)) return { type: 'patent_report', label };
    return { type: '', label };
  }

  function extractRequesterId() {
    const rows = Array.from(document.querySelectorAll('.assist-detail tr'));
    for (const tr of rows) {
      const cells = Array.from(tr.children || []);
      const label = visibleText(cells[0]);
      if (/^(求助人|requester)$/i.test(label)) {
        const link = cells[1]?.querySelector('a');
        if (link) {
          const dataId = link.getAttribute('data-id');
          if (dataId) return dataId;
          try {
            const url = new URL(link.href, location.href);
            const id = url.searchParams.get('id');
            if (id) return id;
          } catch (_) {}
        }
      }
    }
    return '';
  }

  function extractJournalName() {
    const rows = Array.from(document.querySelectorAll('.assist-detail tr'));
    for (const tr of rows) {
      const cells = Array.from(tr.children || []);
      const label = cleanJournalName(visibleText(cells[0]));
      const value = cleanJournalName(visibleText(cells[1]));
      if (!label || !value) continue;
      if (/^(期刊|刊名|journal)$/i.test(label)) return value;
    }

    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const match = bodyText.match(/期刊[:：]\s*([A-Za-z0-9&.,:;()'\/\- ]{3,160})/);
    return match ? cleanJournalName(match[1]) : '';
  }

  function isAblesciErrorPage() {
    const bodyText = String(document.body ? document.body.innerText || document.body.textContent || '' : '');
    const titleText = String(document.title || '');
    return /502 Bad Gateway|504 Gateway Time|500 Internal Server|503 Service Temporarily|403 Forbidden|404 Not Found/i.test(titleText + ' ' + bodyText) ||
           /科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|您所访问的资源出现网络错误/i.test(titleText + ' ' + bodyText);
  }

  function collectPayload() {
    if (isAblesciErrorPage()) {
      throw new Error('科研通网站返回服务错误（502 Bad Gateway 或其他网络错误）');
    }
    if (isUploadBlocked()) {
      throw new Error('当前页面看起来已经有人上传、待确认、已完成或已关闭，已停止。');
    }
    const picked = window.AblesciPdfAdapters.pickPdfUrlFromDocument(document);

    const { csrfParam, csrfToken } = getCsrf();
    const assistId = getAssistId();
    const doi = window.AblesciPdfAdapters.getFullDoiFromDocument(document);
    const suggestedFilename = window.AblesciPdfAdapters.makePdfFilename(document);
    const title = visibleText($('.assist-title')) || document.title || suggestedFilename;
    const journalName = extractJournalName();
    const risk = detectPageRisk();
    const documentTypeInfo = extractDocumentTypeInfo();
    const requesterId = extractRequesterId();

    return {
      pageUrl: location.href,
      csrfParam,
      csrfToken,
      assistId,
      doi,
      title,
      journalName,
      documentType: documentTypeInfo.type,
      documentTypeLabel: documentTypeInfo.label,
      requesterId,
      hasRemark: risk.flags?.remark === true,
      remarkText: risk.remarkText || '',
      riskFlags: risk.flags || {},
      pdfUrl: picked.url,
      pdfUrlSource: picked.source,
      suggestedFilename,
      downloadOnly: risk.downloadOnly,
      riskReasons: risk.reasons
    };
  }

  function extractStatusText() {
    return Array.from(document.querySelectorAll('.assist-badge, .assist-status-badge, .close-daojishi'))
      .map(visibleText)
      .filter(Boolean)
      .join(' ');
  }

  function buildPayloadFromCurrentPage() {
    const payload = collectPayload();
    return {
      ...payload,
      statusText: extractStatusText(),
      riskText: (payload.riskReasons || []).join('；')
    };
  }

  function startUpload() {
    const btn = $('#' + BTN_ID);
    const isEn = getActiveLanguage() === 'en';
    if (btn && btn.classList.contains('busy')) {
      if (currentUploadPort) {
        try { currentUploadPort.disconnect(); } catch (_) {}
        currentUploadPort = null;
      }
      const cancelMsg = isEn
        ? 'Current task cancelled. It will be removed if in queue, and any waiting publisher tabs will close.'
        : '已取消当前任务；如果它在队列中会被移除，如果正在等待出版商页会关闭对应标签页。';
      setStatus(cancelMsg, null);
      return;
    }

    let payload;
    try {
      payload = collectPayload();
      if (pageOptions.watcherSkipCorrigendum && payload.title && /^Corrigendum\s+to/i.test(String(payload.title).trim())) {
        throw new Error(isEn ? 'Skipped corrigendum requests.' : '已按设置跳过 Corrigendum 更正类求助');
      }
    } catch (err) {
      setStatus(err.message || String(err), 'err');
      return;
    }

    const initMsg = payload.downloadOnly
      ? (isEn ? 'Risk page: Preparing to download PDF only, will not upload...' : '风险页面：准备仅下载 PDF，不会自动上传...')
      : (isEn ? 'Preparing to download PDF...' : '准备下载 PDF...');
    setStatus(initMsg, 'busy');
    const port = chrome.runtime.connect({ name: 'ablesci-pdf-upload' });
    currentUploadPort = port;

    port.onMessage.addListener(msg => {
      if (!msg) return;
      if (msg.type === 'progress') setStatus(translateBackgroundMessage(msg.message), 'busy');
      if (msg.type === 'done') {
        const defaultSuccess = isEn ? 'Upload Successful' : '上传成功';
        const completionMsg = (!msg.downloadOnly && !pageOptions.smartRecommendPush && !msg.pdfCleanerResult)
          ? { ...msg, message: defaultSuccess, html: defaultSuccess, recomend: false, recommend: false }
          : msg;

        completionMsg.message = translateBackgroundMessage(completionMsg.message);
        if (completionMsg.html) {
          completionMsg.html = translateBackgroundMessage(completionMsg.html);
        }

        if (completionMsg.blocked) {
          const skipLabel = isEn ? 'Skipped' : '已跳过';
          setStatus(skipLabel, 'blocked', {
            title: completionMsg.message || (isEn ? 'Current task skipped' : '当前任务已跳过'),
            logText: ''
          });
        } else {
          setStatus(completionMsg.message || defaultSuccess, completionMsg.downloadOnly ? 'downloadOnly' : 'ok');
        }
        if (!msg.downloadOnly) {
          showSiteLikeCompletion(completionMsg);
        }
        if (currentUploadPort === port) currentUploadPort = null;
        try { port.disconnect(); } catch (_) {}
      }
      if (msg.type === 'error') {
        const defaultError = isEn ? 'Upload Failed' : '上传失败';
        setStatus(translateBackgroundMessage(msg.message) || defaultError, 'err');
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
      console.warn('[Ablesci Native PDF Watcher] no mount point found');
      return;
    }
    ensureStyle();

    const btn = document.createElement('a');
    btn.id = BTN_ID;
    btn.href = 'javascript:void(0);';
    btn.className = 'layui-btn layui-btn-xs';
    btn.textContent = idleButtonText();
    setButtonTitle(btn, defaultButtonTitle());
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

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'ablesciExtractDetailPayload') return;
    try {
      sendResponse({
        ok: true,
        payload: buildPayloadFromCurrentPage()
      });
    } catch (err) {
      sendResponse({
        ok: false,
        error: err?.message || String(err)
      });
    }
    return true;
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
