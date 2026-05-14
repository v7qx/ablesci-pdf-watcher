(function () {
  'use strict';

  const OPTION_KEY = 'openAssistLinksInCurrentTab';
  let enabled = false;

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
  document.addEventListener('click', onClick, true);
})();
