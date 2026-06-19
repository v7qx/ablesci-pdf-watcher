(function () {
  'use strict';

  const AUTO_WATCHER_STATE_KEY = 'autoWatcherState';
  const JOURNAL_ACCESS_STYLE_ID = 'ablesci-journal-access-style';
  const JOURNAL_ACCESS_TTL_TOOLTIP = '本地记录：当前出版社明确无订阅权限；过期后会自动重试';
  const HIDE_NO_ACCESS_ROWS_KEY = 'hideScienceDirectNoAccessRows';
  let hideNoAccessRows = false;
  let journalAccessCache = new Map();
  let journalAccessScanTimer = null;
  let journalAccessObserver = null;

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
      .replace(/\s*\|\s*本地记录：(?:ScienceDirect|当前出版社)明确无订阅权限；过期后会自动重试\s*/g, '')
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

  function publisherKeyFromText(value) {
    const text = String(value || '');
    if (/ieee/i.test(text)) return 'ieee';
    if (/elsevier|science\s*direct|sciencedirect/i.test(text)) return 'sciencedirect';
    if (/wiley/i.test(text)) return 'wiley';
    if (/\brsc\b|royal\s+society\s+of\s+chemistry/i.test(text)) return 'rsc';
    if (/\bacs\b/i.test(text)) return 'acs';
    if (/sage/i.test(text)) return 'sage';
    return '';
  }

  function publisherKeyFromListPage() {
    try {
      const url = new URL(location.href);
      const publisher = String(url.searchParams.get('publisher') || '').toLowerCase();
      const key = publisherKeyFromText(publisher);
      if (key) return key;
    } catch (_) {}
    const activePublisher = document.querySelector('.waiting-publisher-item-this img[title], .waiting-publisher-item.active img[title]');
    return publisherKeyFromText(activePublisher?.getAttribute('title') || '');
  }

  function publisherKeyFromRow(row) {
    const iconTitle = row?.querySelector?.('.paper-publisher img[title]')?.getAttribute('title') || '';
    return publisherKeyFromText(iconTitle) || publisherKeyFromListPage();
  }

  function journalAccessCacheKey(publisher, journalKey) {
    return publisher && journalKey ? `${publisher}:${journalKey}` : '';
  }

  function validJournalAccessEntries(state) {
    const stats = state?.journalAccessStats || {};
    const now = Date.now();
    const entries = new Map();
    Object.entries(stats).forEach(([key, entry]) => {
      if (!entry || typeof entry !== 'object') return;
      const publisher = publisherKeyFromText(entry.publisher || '');
      if (!publisher || publisher === 'ieee') return;
      if (entry.status && entry.status !== 'blocked') return;
      if (entry.reason !== 'explicit_no_subscription') return;
      const expiresAt = Date.parse(entry.expiresAt || '');
      if (!Number.isFinite(expiresAt) || expiresAt <= now) return;
      const normalizedKey = normalizeJournalKey(entry.shortName || key);
      if (!normalizedKey) return;
      entries.set(journalAccessCacheKey(publisher, normalizedKey), entry);
      if (publisher === 'sciencedirect') entries.set(normalizedKey, entry);
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
    if (!journalAccessCache.size) {
      document.querySelectorAll('.ablesci-journal-no-access-row').forEach(clearJournalAccessMark);
      return;
    }
    ensureJournalAccessStyle();
    const rows = Array.from(document.querySelectorAll('ul.assist-list > li, .assist-list li'));
    rows.forEach(row => {
      const badge = journalBadgeFromRow(row);
      const key = normalizeJournalKey(cleanJournalBadgeTitle(badge?.getAttribute('title') || badge?.textContent || ''));
      const publisher = publisherKeyFromRow(row);
      const entry = key ? (journalAccessCache.get(journalAccessCacheKey(publisher, key)) || journalAccessCache.get(key)) : null;
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

  startJournalAccessMarker();
})();
