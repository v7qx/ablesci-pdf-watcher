(function () {
  'use strict';

  const OPTION_KEY = 'openAssistLinksInCurrentTab';
  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const JOURNAL_ACCESS_STYLE_ID = 'ablesci-journal-access-style';
  const JOURNAL_ACCESS_TTL_TOOLTIP = '本地记录：ScienceDirect 明确无订阅权限；过期后会自动重试';
  const HIDE_NO_ACCESS_ROWS_KEY = 'hideScienceDirectNoAccessRows';
  let enabled = false;
  let hideNoAccessRows = false;
  let journalAccessCache = new Map();
  let journalAccessScanTimer = null;
  let journalAccessObserver = null;

  function isAblesciHost(hostname) {
    return hostname === 'ablesci.com' || hostname === 'www.ablesci.com';
  }

  function isAssistDetailUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      return isAblesciHost(url.hostname) && url.pathname.startsWith('/assist/detail');
    } catch (_) {
      return false;
    }
  }

  function isPlainLeftClick(event) {
    if (event.button !== 0) return false;
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    return true;
  }

  function isListPage() {
    const path = location.pathname || '';
    return path === '/assist' || (path.startsWith('/assist/') && !path.startsWith('/assist/detail'));
  }

  function normalizeJournalKey(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanJournalBadgeTitle(value) {
    return String(value || '')
      .replace(/\s*\|\s*本地记录：ScienceDirect 明确无订阅权限；过期后会自动重试\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isJournalBadgeSpan(span) {
    if (!span) return false;
    if (span.classList?.contains('title-hint')) return false;
    if (span.closest?.('.paper-publisher')) return false;
    if (span.querySelector?.('i')) return false;
    const value = cleanJournalBadgeTitle(span.dataset?.ablesciOriginalTitle || span.getAttribute('title') || span.textContent || '');
    if (!value) return false;
    if (/求助|违规|举报|高分|置顶|悬赏|文献类型|Book|Chapter|Supplement/i.test(value)) return false;
    return true;
  }

  function isScienceDirectListPage() {
    try {
      const url = new URL(location.href);
      const publisher = String(url.searchParams.get('publisher') || '').toLowerCase();
      if (/elsevier|sciencedirect/.test(publisher)) return true;
    } catch (_) {}
    const activePublisher = document.querySelector('.waiting-publisher-item-this img[title], .waiting-publisher-item.active img[title]');
    return /elsevier|sciencedirect/i.test(activePublisher?.getAttribute('title') || '');
  }

  function validJournalAccessEntries(state) {
    const stats = state?.journalAccessStats || {};
    const now = Date.now();
    const entries = new Map();
    Object.entries(stats).forEach(([key, entry]) => {
      if (!entry || typeof entry !== 'object') return;
      if (entry.publisher !== 'sciencedirect') return;
      if (entry.reason !== 'explicit_no_subscription') return;
      const expiresAt = Date.parse(entry.expiresAt || '');
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
      const normalizedKey = normalizeJournalKey(key || entry.shortName);
      if (!normalizedKey) return;
      entries.set(normalizedKey, entry);
    });
    return entries;
  }

  function loadJournalAccessCache() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get({ [AUTO_WATCHER_STATE_KEY]: {}, [HIDE_NO_ACCESS_ROWS_KEY]: false }, data => {
      journalAccessCache = validJournalAccessEntries(data[AUTO_WATCHER_STATE_KEY] || {});
      hideNoAccessRows = data[HIDE_NO_ACCESS_ROWS_KEY] === true;
      scheduleJournalAccessScan();
    });
  }

  function ensureJournalAccessStyle() {
    if (document.getElementById(JOURNAL_ACCESS_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = JOURNAL_ACCESS_STYLE_ID;
    style.textContent = `
      .ablesci-journal-no-access-row {
        border-left: 3px solid #d5d7dc !important;
      }
      .ablesci-journal-no-access-badge {
        border: 1px solid #cfd4dc !important;
        background: #f7f8fa !important;
        color: #5f6b7a !important;
      }
      .ablesci-journal-no-access-hidden {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function journalBadgeFromRow(row) {
    const detailAnchor = row.querySelector('a[href*="/assist/detail"][title*="查看详情"]') ||
      row.querySelector('.assist-list-title a[href*="/assist/detail"]') ||
      row.querySelector('a[href*="/assist/detail"]');
    if (!detailAnchor) return null;
    return Array.from(detailAnchor.querySelectorAll('span[title]'))
      .filter(isJournalBadgeSpan)
      .find(span => normalizeJournalKey(cleanJournalBadgeTitle(span.dataset?.ablesciOriginalTitle || span.getAttribute('title') || span.textContent || ''))) || null;
  }

  function clearJournalAccessMark(row) {
    row.classList.remove('ablesci-journal-no-access-row');
    row.classList.remove('ablesci-journal-no-access-hidden');
    row.querySelectorAll('.ablesci-journal-no-access-badge').forEach(badge => {
      badge.classList.remove('ablesci-journal-no-access-badge');
      if (badge.dataset.ablesciOriginalTitle !== undefined) {
        const originalTitle = cleanJournalBadgeTitle(badge.dataset.ablesciOriginalTitle);
        if (originalTitle) badge.setAttribute('title', originalTitle);
        else badge.removeAttribute('title');
        delete badge.dataset.ablesciOriginalTitle;
      }
    });
  }

  function applyJournalAccessMarks() {
    if (!isListPage()) return;
    if (!isScienceDirectListPage()) return;
    if (!journalAccessCache.size) {
      document.querySelectorAll('.ablesci-journal-no-access-row').forEach(clearJournalAccessMark);
      return;
    }
    ensureJournalAccessStyle();
    const rows = Array.from(document.querySelectorAll('ul.assist-list > li, .assist-list li'));
    rows.forEach(row => {
      const badge = journalBadgeFromRow(row);
      const key = normalizeJournalKey(cleanJournalBadgeTitle(badge?.getAttribute('title') || badge?.textContent || ''));
      const entry = key ? journalAccessCache.get(key) : null;
      if (!badge || !entry) {
        clearJournalAccessMark(row);
        return;
      }
      row.classList.add('ablesci-journal-no-access-row');
      row.classList.toggle('ablesci-journal-no-access-hidden', hideNoAccessRows);
      badge.classList.add('ablesci-journal-no-access-badge');
      if (badge.dataset.ablesciOriginalTitle === undefined) {
        badge.dataset.ablesciOriginalTitle = cleanJournalBadgeTitle(badge.getAttribute('title') || '');
      }
      const originalTitle = cleanJournalBadgeTitle(badge.dataset.ablesciOriginalTitle || badge.getAttribute('title') || entry.shortName || '');
      badge.setAttribute('title', `${originalTitle} | ${JOURNAL_ACCESS_TTL_TOOLTIP}`);
    });
  }

  function scheduleJournalAccessScan() {
    if (!isListPage()) return;
    clearTimeout(journalAccessScanTimer);
    journalAccessScanTimer = setTimeout(applyJournalAccessMarks, 250);
  }

  function startJournalAccessMarker() {
    if (!isListPage() || !chrome?.storage?.local) return;
    loadJournalAccessCache();
    const startObserver = () => {
      if (journalAccessObserver || !document.body) return;
      journalAccessObserver = new MutationObserver(scheduleJournalAccessScan);
      journalAccessObserver.observe(document.body, { childList: true, subtree: true });
      scheduleJournalAccessScan();
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObserver, { once: true });
    } else {
      startObserver();
    }
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[AUTO_WATCHER_STATE_KEY]) {
        journalAccessCache = validJournalAccessEntries(changes[AUTO_WATCHER_STATE_KEY].newValue || {});
      }
      if (changes[HIDE_NO_ACCESS_ROWS_KEY]) {
        hideNoAccessRows = changes[HIDE_NO_ACCESS_ROWS_KEY].newValue === true;
      }
      if (!changes[AUTO_WATCHER_STATE_KEY] && !changes[HIDE_NO_ACCESS_ROWS_KEY]) return;
      scheduleJournalAccessScan();
    });
  }

  function isDetailRecommendLink(anchor) {
    if (!(location.pathname || '').startsWith('/assist/detail')) return false;
    return !!anchor.closest('.ablesci-native-layer-content, .ablesci-native-layer, .layui-layer-content');
  }

  function isRelevantPageContext(anchor) {
    if (isListPage()) return true;
    return isDetailRecommendLink(anchor);
  }

  function onClick(event) {
    if (!enabled) return;
    if (!isPlainLeftClick(event)) return;

    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;

    const href = anchor.href || anchor.getAttribute('href');
    if (!href || !isAssistDetailUrl(href)) return;
    if (!isRelevantPageContext(anchor)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    location.assign(new URL(href, location.href).href);
  }

  function loadOption() {
    if (!chrome?.storage?.local) return;

    chrome.storage.local.get({ [OPTION_KEY]: false }, data => {
      enabled = data[OPTION_KEY] === true;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[OPTION_KEY]) return;
      enabled = changes[OPTION_KEY].newValue === true;
    });
  }

  loadOption();
  startJournalAccessMarker();
  document.addEventListener('click', onClick, true);
})();
