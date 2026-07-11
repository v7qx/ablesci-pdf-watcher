(function () {
  'use strict';

  const BTN_ID = 'ablesci-native-oneclick-pdf-btn';
  const LOG_ID = 'ablesci-native-oneclick-pdf-log';
  const DEFAULT_PAGE_OPTIONS = {
    buttonLabel: '上传PDF',
    buttonColor: '#FF5722',
    buttonTextColor: '#ffffff',
    buttonPosition: 'end',
    smartRecommendPush: true,
    watcherLanguage: 'auto',
    watcherSkipCorrigendum: true,
    watcherEnableBlacklist: true,
    watcherBlacklistPath: ''
  };
  let currentUploadPort = null;
  let pageOptions = { ...DEFAULT_PAGE_OPTIONS };
  const { styleText } = globalThis.AblesciContentUi.createContentUiApi({
    buttonId: BTN_ID,
    logId: LOG_ID
  });

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

  function uploadBlockedReason() {
    const t = document.body ? document.body.innerText : '';
    if (/已经有人上传了文献|请等待求助人确认|待确认|已完成|已关闭/.test(t)) {
      return '当前页面看起来已经有人上传、待确认、已完成或已关闭，正常应助应停止。';
    }
    return '';
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
    style.textContent = styleText();
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

  const { translateBackgroundMessage } = globalThis.AblesciContentI18n.createContentI18nApi({
    getActiveLanguage
  });

  function normalizeUiOptions(opts) {
    return {
      buttonLabel: normalizeButtonLabel(opts?.buttonLabel),
      buttonColor: isSafeHexColor(opts?.buttonColor) ? opts.buttonColor : DEFAULT_PAGE_OPTIONS.buttonColor,
      buttonTextColor: isSafeHexColor(opts?.buttonTextColor) ? opts.buttonTextColor : DEFAULT_PAGE_OPTIONS.buttonTextColor,
      buttonPosition: normalizeButtonPosition(opts?.buttonPosition),
      smartRecommendPush: opts?.smartRecommendPush !== false,
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
    try {
      const doc = new DOMParser().parseFromString(String(s || ''), 'text/html');
      return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (_) {
      return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function reloadPageSoon(delay = 0) {
    setTimeout(() => {
      try { location.reload(); } catch (_) {}
    }, delay);
  }

  function safeDisplayHref(rawHref) {
    const raw = String(rawHref || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, location.href);
      return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function safeStyleValue(raw) {
    const s = String(raw || '');
    // Inline CSS can't run script in modern browsers; still drop the legacy vectors.
    if (/expression\s*\(|javascript:/i.test(s)) return '';
    return s;
  }

  // Copy only presentational attributes so the site's own CSS (loaded on this page)
  // styles the recommendation block exactly like the native popup. Event handlers
  // (on*) and any other attributes are intentionally never copied.
  function applySafePresentationAttrs(el, source) {
    const cls = source.getAttribute('class');
    if (cls) el.setAttribute('class', cls);
    const style = safeStyleValue(source.getAttribute('style'));
    if (style) el.setAttribute('style', style);
    const title = source.getAttribute('title');
    if (title) el.setAttribute('title', title);
  }

  // Render the site's recommendation HTML faithfully but safely (no innerHTML):
  // first-party tags that the native popup uses survive WITH their class/style so the
  // page CSS (journal icons, orange "相同期刊★★★", dashed tip box) applies; scripts,
  // event handlers, embeds and non-http(s) URLs are dropped.
  function appendSanitizedHtmlNode(target, source) {
    if (!source) return;
    if (source.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(source.textContent || ''));
      return;
    }
    if (source.nodeType !== Node.ELEMENT_NODE) return;

    const tag = source.tagName.toLowerCase();
    if (['script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'link', 'meta', 'base', 'form', 'input'].includes(tag)) return;
    const passthroughTags = new Set(['span', 'strong', 'b', 'em', 'i', 'small', 'br', 'p', 'div', 'ul', 'ol', 'li']);
    let nextTarget = target;

    if (tag === 'a') {
      const anchor = document.createElement('a');
      const href = safeDisplayHref(source.getAttribute('href') || '');
      if (href) anchor.href = href;
      anchor.rel = 'noopener noreferrer';
      anchor.target = '_blank';
      applySafePresentationAttrs(anchor, source);
      target.appendChild(anchor);
      nextTarget = anchor;
    } else if (tag === 'img') {
      const src = safeDisplayHref(source.getAttribute('src') || '');
      if (src) {
        const img = document.createElement('img');
        img.src = src;
        const alt = source.getAttribute('alt');
        if (alt) img.alt = alt;
        for (const dim of ['width', 'height']) {
          const v = source.getAttribute(dim);
          if (v) img.setAttribute(dim, v);
        }
        applySafePresentationAttrs(img, source);
        target.appendChild(img);
      }
      return; // <img> is a void element
    } else if (passthroughTags.has(tag)) {
      const el = document.createElement(tag);
      applySafePresentationAttrs(el, source);
      target.appendChild(el);
      nextTarget = el;
    }
    // Unknown tags: element is skipped but its children are still flattened in.

    for (const child of Array.from(source.childNodes || [])) {
      appendSanitizedHtmlNode(nextTarget, child);
    }
  }

  function setSanitizedHtml(target, html) {
    target.textContent = '';
    try {
      const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
      for (const child of Array.from(doc.body?.childNodes || [])) {
        appendSanitizedHtmlNode(target, child);
      }
    } catch (_) {
      target.textContent = stripHtml(html);
    }
  }

  function showSiteLikeCompletion(msg) {
    const rawHtml = msg.html || msg.message || '上传成功';
    const plain = stripHtml(rawHtml) || '上传成功';
    const hasRecommend = msg.recomend === true || msg.recomend === 1 || msg.recomend === '1' ||
      msg.recommend === true || msg.recommend === 1 || msg.recommend === '1';
    const shouldReload = msg.reload !== false;

    document.querySelectorAll('.ablesci-native-layer-shade,.ablesci-native-layer,.ablesci-native-toast').forEach(n => n.remove());

    // No recommendations: keep the lightweight toast + auto reload.
    if (!hasRecommend) {
      const toast = document.createElement('div');
      toast.className = 'ablesci-native-toast';
      toast.textContent = plain;
      document.body.appendChild(toast);
      if (shouldReload) reloadPageSoon(1500);
      return;
    }

    // Recommendations present: reproduce the site's "智能推荐" modal so the user can
    // jump to the suggested requests, and reload only after they click 确定.
    const shade = document.createElement('div');
    shade.className = 'ablesci-native-layer-shade';

    const box = document.createElement('div');
    box.className = 'ablesci-native-layer layui-layer layui-layer-dialog layui-layer-msg';

    const content = document.createElement('div');
    content.className = 'ablesci-native-layer-content layui-layer-content';
    setSanitizedHtml(content, rawHtml);

    const btnBar = document.createElement('div');
    btnBar.className = 'ablesci-native-layer-btn';

    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = getActiveLanguage() === 'en' ? 'OK' : '确定';
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

  function extractAssistTitle() {
    const copiedTitle = document.querySelector('.assist-title [data-clipboard-text]')?.getAttribute('data-clipboard-text') || '';
    if (normalizeText(copiedTitle)) return normalizeText(copiedTitle);
    const primaryTitle = document.querySelector('.assist-title > div:first-child');
    return visibleText(primaryTitle) || visibleText(document.querySelector('.assist-title'));
  }

  function isLikelyCorrigendumTitle(title) {
    const value = String(title || '').trim();
    return /^(corrigendum|correction|erratum|addendum)\s+(to|for)\b/i.test(value) ||
      /^retraction\s+(notice|of|to)\b/i.test(value);
  }

  function hasHanCharacters(value) {
    return /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(String(value || ''));
  }

  function cleanRemarkText(value) {
    return normalizeText(value)
      .replace(/该求助存在备注，如果存在信息冲突，请以备注为准/g, '')
      .replace(/该求助存在备注/g, '')
      .replace(/如果存在信息冲突，请以备注为准/g, '')
      .replace(/以备注为准/g, '')
      .replace(/^[：:]+/, '')
      .trim();
  }

  function extractRemarkInfo() {
    const remarks = [];
    Array.from(document.querySelectorAll('.assist-detail tr')).forEach(tr => {
      const cells = Array.from(tr.children || []);
      const label = visibleText(cells[0]);
      if (!/^备注$/.test(label)) return;
      const value = cleanRemarkText(cells.slice(1).map(visibleText).join(' '));
      if (value) remarks.push(value);
    });

    Array.from(document.querySelectorAll('.assist-detail .layui-row, .assist-detail [class*="assist-"], .assist-detail > div')).forEach(row => {
      const children = Array.from(row.children || []);
      if (children.length < 2) return;
      const labelIndex = children.findIndex(child => /^备注$/.test(visibleText(child)));
      if (labelIndex < 0) return;
      const value = cleanRemarkText(children.slice(labelIndex + 1).map(visibleText).join(' '));
      if (value) remarks.push(value);
    });

    Array.from(document.querySelectorAll('.assist-detail td, .assist-detail div, .assist-detail span')).forEach(el => {
      const text = visibleText(el);
      if (!/^备注(?:\s|[:：]|$)/.test(text)) return;
      const inlineValue = cleanRemarkText(text.replace(/^备注\s*[:：]?/, ''));
      if (inlineValue) {
        remarks.push(inlineValue);
        return;
      }
      const parentValue = cleanRemarkText(visibleText(el.parentElement).replace(/^备注\s*[:：]?/, ''));
      if (parentValue && !/^备注$/.test(parentValue)) remarks.push(parentValue);
    });

    const detailText = visibleText(document.querySelector('.assist-detail'));
    const notice = /该求助存在备注|以备注为准/.test(detailText);
    const uniqueRemarks = Array.from(new Set(remarks.filter(Boolean)));
    return {
      hasRemark: uniqueRemarks.length > 0 || notice,
      text: uniqueRemarks.join('；')
    };
  }

  function detectPageRisk() {
    const reasons = [];
    const flags = {
      supplement: false,
      rejectedHistory: false,
      reportedWarning: false,
      systemRisk: false,
      systemPromptSupplementDoi: false,
      systemPromptAbnormalAssist: false,
      chineseTitle: false,
      remark: false
    };
    const titleText = extractAssistTitle();

    if (hasHanCharacters(titleText)) {
      flags.chineseTitle = true;
      reasons.push('当前求助标题含中文字符，可能将备注或附加要求写入标题，已停止自动上传。');
    }

    if (/求助补充材料|补充材料求助|supporting information|supplementary material/i.test(titleText)) {
      flags.supplement = true;
      reasons.push('当前求助类型是补充材料/SI，插件尚未支持补充材料自动应助。');
    }

    const rejectStructures = Array.from(document.querySelectorAll('.reject-info-alert, .assistfile-badge-reject'))
      .map(visibleText)
      .filter(Boolean);
    if (rejectStructures.length > 0) {
      flags.rejectedHistory = true;
      reasons.push('当前求助存在驳回应助记录，可能需要先人工核对应助文件。');
    }

    const reportedCount = Array.from(document.querySelectorAll('.alreay-report-time, .already-report-time'))
      .some(el => Number(visibleText(el).match(/\d+/)?.[0] || 0) > 0);
    const reportWarningStructures = Array.from(document.querySelectorAll('.assist-detail [title], .assist-detail .text-orange'))
      .some(el => {
        const title = normalizeText(el.getAttribute?.('title') || '');
        const text = visibleText(el);
        return /涉嫌违规|正在被举报|已被举报/.test(`${title} ${text}`);
      });
    if (reportedCount || reportWarningStructures) {
      flags.reportedWarning = true;
      reasons.push('当前求助被网站标记为涉嫌违规或正在被举报。');
    }

    // System risk: only trust the site's own warning blocks (`.special-assist-alert`,
    // which is injected only for flagged requests, or an alert element that actually
    // contains a 系统提示 marker), then require a recognized risk keyword. Do NOT scan
    // the whole .assist-detail container: every page carries boilerplate such as
    // "科研通『学术中心』是文献索引库…", so a wholesale keyword scan plus a catch-all
    // skip false-flags every normal request.
    const systemAlertTexts = Array.from(document.querySelectorAll('.special-assist-alert, .assist-detail .alert-warning, .assist-detail .layui-alert, .assist-detail .layui-card-body'))
      .map(el => ({ text: visibleText(el), special: el.classList?.contains('special-assist-alert') }))
      .filter(item => item.text && (item.special || /系统提示|提醒：由于doi是数字文件的唯一标识/i.test(item.text)))
      .map(item => item.text);
    const systemWarnings = systemAlertTexts.filter(t => /Supplementary|补充材料|supporting information|并非全文|不是全文|该doi的文献可能是补充材料/i.test(t));
    const abnormalSystemWarnings = systemAlertTexts.filter(t => /索引库|类似于搜索引擎|准确性不能保证|建议填写原始官方链接|无全文|没有全文|并非全文|不是全文/i.test(t));
    if (systemWarnings.length > 0 || abnormalSystemWarnings.length > 0) {
      flags.systemRisk = true;
      if (systemWarnings.length > 0) {
        flags.systemPromptSupplementDoi = true;
        reasons.push('网站系统提示该 DOI 可能对应补充材料或并非全文，已按异常情况跳过。');
      } else {
        flags.systemPromptAbnormalAssist = true;
        reasons.push('网站系统提示该求助可能是索引库链接、无全文或信息不准确，已按异常情况跳过。');
      }
    }

    const remarkInfo = extractRemarkInfo();
    if (remarkInfo.hasRemark) {
      flags.remark = true;
      reasons.push('当前求助存在备注，可能要求特定版本或附加条件，需以备注为准人工核对。');
    }

    return {
      downloadOnly: reasons.length > 0,
      reasons,
      flags,
      remarkText: remarkInfo.text
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
    if (/书籍|图书|book|chapter/i.test(label)) return { type: 'book_chapter', label };
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

  function ablesciServiceErrorInfo() {
    const bodyText = String(document.body ? document.body.innerText || document.body.textContent || '' : '');
    const titleText = String(document.title || '');
    const combined = `${titleText} ${bodyText}`;
    const marker = combined.match(/502 Bad Gateway|504 Gateway Time(?:-out)?|500 Internal Server(?: Error)?|503 Service (?:Temporarily Unavailable|Unavailable)|403 Forbidden|404 Not Found/i)?.[0] ||
      combined.match(/科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|您所访问的资源出现网络错误/i)?.[0] || '';
    return {
      isServiceError: !!marker,
      marker,
      title: titleText.trim(),
      bodyText: bodyText.replace(/\s+/g, ' ').trim()
    };
  }

  function isAblesciErrorPage() {
    return ablesciServiceErrorInfo().isServiceError;
  }

  function collectPayload(options = {}) {
    if (isAblesciErrorPage()) {
      throw new Error('科研通网站返回服务错误（502 Bad Gateway 或其他网络错误）');
    }
    const blockedReason = uploadBlockedReason();
    if (blockedReason && options.debugSimulation !== true) {
      throw new Error(blockedReason.replace('正常应助应停止。', '已停止。'));
    }
    const picked = window.AblesciPdfAdapters.pickPdfUrlFromDocument(document);

    const { csrfParam, csrfToken } = getCsrf();
    const assistId = getAssistId();
    const doi = window.AblesciPdfAdapters.getFullDoiFromDocument(document);
    const suggestedFilename = window.AblesciPdfAdapters.makePdfFilename(document);
    const title = extractAssistTitle() || document.title || suggestedFilename;
    const journalName = extractJournalName();
    const risk = detectPageRisk();
    const riskReasons = risk.reasons.slice();
    if (blockedReason) riskReasons.unshift(blockedReason);
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
      downloadOnly: riskReasons.length > 0,
      riskReasons,
      debugBlockReasons: blockedReason ? [blockedReason] : []
    };
  }

  function extractStatusText() {
    return Array.from(document.querySelectorAll('.assist-badge, .assist-status-badge, .close-daojishi'))
      .map(visibleText)
      .filter(Boolean)
      .join(' ');
  }

  function buildPayloadFromCurrentPage(options = {}) {
    const payload = collectPayload(options);
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
      if (pageOptions.watcherSkipCorrigendum && payload.title && isLikelyCorrigendumTitle(payload.title)) {
        throw new Error(isEn ? 'Skipped correction/erratum requests.' : '已按设置跳过更正类求助');
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
      const finished = renderBackgroundMessage(msg);
      if (finished) {
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

  function renderBackgroundMessage(msg) {
    if (!msg) return false;
    const isEn = getActiveLanguage() === 'en';
    if (msg.type === 'progress') {
      setStatus(translateBackgroundMessage(msg.message), 'busy');
      return false;
    }
    if (msg.type === 'done') {
      const defaultSuccess = isEn ? 'Upload Successful' : '上传成功';
      const completionMsg = (!msg.downloadOnly && !pageOptions.smartRecommendPush && !msg.pdfCleanerResult)
        ? { ...msg, message: defaultSuccess, html: defaultSuccess, recomend: false, recommend: false }
        : { ...msg };

      completionMsg.message = translateBackgroundMessage(completionMsg.message);
      if (completionMsg.html) {
        completionMsg.html = translateBackgroundMessage(completionMsg.html);
      }
      const completionTitle = translateBackgroundMessage(completionMsg.title || completionMsg.message || defaultSuccess);

      if (completionMsg.blocked) {
        const skipLabel = isEn ? 'Skipped' : '已跳过';
        setStatus(skipLabel, 'blocked', {
          title: completionTitle || (isEn ? 'Current task skipped' : '当前任务已跳过'),
          logText: ''
        });
      } else {
        setStatus(completionMsg.message || defaultSuccess, completionMsg.downloadOnly ? 'downloadOnly' : 'ok', {
          title: completionTitle
        });
      }
      if (!msg.downloadOnly) {
        showSiteLikeCompletion(completionMsg);
      }
      return true;
    }
    if (msg.type === 'error') {
      const defaultError = isEn ? 'Upload Failed' : '上传失败';
      setStatus(translateBackgroundMessage(msg.message) || defaultError, 'err');
      return true;
    }
    return false;
  }

  function addButton(options = {}) {
    if ($('#' + BTN_ID)) return;
    const found = findButtonMount();
    if (!found.mount) {
      if (options.finalAttempt === true) {
        const serviceError = ablesciServiceErrorInfo();
        const selectorState = {
          quickAssistRows: Array.from(document.querySelectorAll('tr')).filter(tr => /快捷应助/.test(tr.innerText || tr.textContent || '')).length,
          assistDetail: document.querySelectorAll('.assist-detail').length,
          assistTitle: document.querySelectorAll('.assist-title').length,
          assistDoi: document.querySelectorAll('.assist-doi').length,
          assistUrl: document.querySelectorAll('.assist-url').length
        };
        const reason = serviceError.isServiceError
          ? `ablesci_service_error:${serviceError.marker || 'unknown'}`
          : (/登录|请先登录|login/i.test(serviceError.bodyText) ? 'login_page_or_session_expired' : 'expected_detail_dom_missing');
        console.warn(
          `[Ablesci Native PDF Watcher] upload button mount skipped; reason=${reason}; ` +
          `url=${location.href}; title=${serviceError.title || '(empty)'}; readyState=${document.readyState}; ` +
          `bodyLength=${serviceError.bodyText.length}; selectors=${JSON.stringify(selectorState)}; ` +
          `summary=${serviceError.bodyText.slice(0, 240) || '(empty)'}`
        );
      }
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
    if (msg?.type === 'ablesciExtractDetailPayload') {
      try {
        sendResponse({
          ok: true,
          payload: buildPayloadFromCurrentPage({
            debugSimulation: msg.debugSimulation === true
          })
        });
      } catch (err) {
        sendResponse({
          ok: false,
          error: err?.message || String(err)
        });
      }
      return true;
    }
    if (msg?.type === 'ablesciAutoWatcherProgress') {
      const innerMsg = msg.msg;
      if (!innerMsg) return;
      renderBackgroundMessage(innerMsg);
    }
  });

  loadUiOptions().then(opts => {
    pageOptions = opts;
    addButton();
    setTimeout(addButton, 1000);
    setTimeout(() => addButton({ finalAttempt: true }), 3000);
  }).catch(() => {
    addButton();
    setTimeout(addButton, 1000);
    setTimeout(() => addButton({ finalAttempt: true }), 3000);
  });
})();
