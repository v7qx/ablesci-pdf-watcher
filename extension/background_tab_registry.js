'use strict';

(function () {
  function createBackgroundTabRegistryApi(deps = {}) {
    const {
      chromeApi,
      publisherTabRegistryKey,
      pendingPublisherTabs,
      orphanPublisherTabMaxAgeMs
    } = deps;

    async function getPublisherTabRegistry() {
      try {
        const stored = await chromeApi.storage.local.get(publisherTabRegistryKey);
        return Array.isArray(stored[publisherTabRegistryKey]) ? stored[publisherTabRegistryKey] : [];
      } catch (_) {
        return [];
      }
    }

    async function savePublisherTabRegistry(items) {
      const compact = (Array.isArray(items) ? items : [])
        .filter(item => item && item.tabId != null)
        .slice(-50)
        .map(item => ({
          tabId: Number(item.tabId),
          createdAt: Number(item.createdAt || Date.now()),
          reason: String(item.reason || '')
        }));
      await chromeApi.storage.local.set({ [publisherTabRegistryKey]: compact });
    }

    async function registerPublisherTab(tabId, meta = {}) {
      if (tabId == null) return;
      const items = await getPublisherTabRegistry();
      const filtered = items.filter(item => Number(item.tabId) !== Number(tabId));
      filtered.push({ tabId: Number(tabId), createdAt: Date.now(), ...meta });
      await savePublisherTabRegistry(filtered);
    }

    async function unregisterPublisherTab(tabId) {
      if (tabId == null) return;
      const items = await getPublisherTabRegistry();
      await savePublisherTabRegistry(items.filter(item => Number(item.tabId) !== Number(tabId)));
    }

    async function cleanupOrphanPublisherTabs(reason = 'orphan_cleanup') {
      const now = Date.now();
      const registered = await getPublisherTabRegistry();
      const keep = [];
      for (const item of registered) {
        const tabId = Number(item?.tabId);
        const createdAt = Number(item?.createdAt || 0);
        if (!tabId) continue;
        const inMemoryPending = pendingPublisherTabs.has(tabId);
        if (inMemoryPending || !createdAt || now - createdAt < orphanPublisherTabMaxAgeMs) {
          keep.push(item);
          continue;
        }
        try {
          await chromeApi.tabs.remove(tabId);
          console.warn('[Ablesci PDF Uploader] closed orphan publisher tab', { tabId, reason });
        } catch (_) {}
      }
      await savePublisherTabRegistry(keep);
    }

    return {
      getPublisherTabRegistry,
      savePublisherTabRegistry,
      registerPublisherTab,
      unregisterPublisherTab,
      cleanupOrphanPublisherTabs
    };
  }

  globalThis.AblesciBackgroundTabRegistry = {
    createBackgroundTabRegistryApi
  };
})();
