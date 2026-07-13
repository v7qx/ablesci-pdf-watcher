'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/content/sciencedirect_download_guard.js');

const {
  inspectDownloadSafety,
  reserveDirectAttempt,
  reserveSiteClickAttempt
} = globalThis.AblesciScienceDirectDownloadGuard;

function siteStorage(value) {
  return {
    getItem(key) {
      assert.equal(key, 'ARTICLE_DDM');
      return value;
    }
  };
}

function extensionStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(values) {
      Object.assign(data, values);
    }
  };
}

function noLimitDocument() {
  return {
    querySelector() { return null; },
    body: { innerText: 'View PDF' }
  };
}

test('allows the one-hundredth guarded ScienceDirect click', async () => {
  const result = await inspectDownloadSafety({
    siteStorage: siteStorage('{"2026_7_14":99}'),
    extensionStorage: extensionStorage(),
    document: noLimitDocument(),
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, false);
  assert.equal(result.siteCount, 99);
  assert.equal(result.directAttempts, 0);
  assert.equal(result.effectiveCount, 99);
});

test('blocks another ScienceDirect task once the combined daily count reaches one hundred', async () => {
  const result = await inspectDownloadSafety({
    siteStorage: siteStorage('{"2026_7_14":96}'),
    extensionStorage: extensionStorage({
      scienceDirectDownloadGuardState: { dateKey: '2026_7_14', directAttempts: 4 }
    }),
    document: noLimitDocument(),
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, true);
  assert.equal(result.effectiveCount, 100);
  assert.equal(result.reason, 'daily_count_reached');
});

test('uses the latest persisted site count for direct downloads that do not open a ScienceDirect page', async () => {
  const storage = extensionStorage({
    scienceDirectDownloadGuardState: { dateKey: '2026_7_14', directAttempts: 4 },
    scienceDirectSiteCountSnapshot: { dateKey: '2026_7_14', siteCount: 96 }
  });

  const result = await inspectDownloadSafety({
    siteStorage: siteStorage('{"2026_7_14":95}'),
    extensionStorage: storage,
    document: noLimitDocument(),
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, true);
  assert.equal(result.siteCount, 96);
  assert.equal(result.effectiveCount, 100);
});

test('inspection remains read-only while using the live ScienceDirect site count', async () => {
  const storage = extensionStorage();

  const result = await inspectDownloadSafety({
    siteStorage: siteStorage('{"2026_7_14":37}'),
    extensionStorage: storage,
    document: noLimitDocument(),
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, false);
  assert.equal(result.siteCount, 37);
  assert.equal(storage.data.scienceDirectSiteCountSnapshot, undefined);
});

test('blocks immediately when the real ScienceDirect limit dialog is visible', async () => {
  const result = await inspectDownloadSafety({
    siteStorage: siteStorage('{"2026_7_14":3}'),
    extensionStorage: extensionStorage(),
    document: {
      querySelector(selector) {
        return selector.includes('download-cap-modal') ? {} : null;
      },
      body: { innerText: 'You have reached the daily bulk download limit' }
    },
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, true);
  assert.equal(result.modalDetected, true);
  assert.equal(result.reason, 'daily_bulk_download_limit_dialog');
});

test('reserves direct-only attempts without writing the ScienceDirect site counter', async () => {
  const storage = extensionStorage();
  let directAttempts = 0;
  const reserveExtensionAttempt = async details => ({
    blocked: false,
    reason: '',
    siteCount: details.observedSiteCount,
    directAttempts: ++directAttempts,
    effectiveCount: details.observedSiteCount + directAttempts,
    limit: 100,
    dateKey: details.dateKey,
    expiresAt: new Date(2026, 6, 15).getTime()
  });
  const first = await reserveDirectAttempt({
    siteStorage: siteStorage('{"2026_7_14":99}'),
    extensionStorage: storage,
    document: noLimitDocument(),
    date: new Date(2026, 6, 14),
    reserveExtensionAttempt
  });
  const second = await reserveDirectAttempt({
    siteStorage: siteStorage('{"2026_7_14":99}'),
    extensionStorage: storage,
    document: noLimitDocument(),
    date: new Date(2026, 6, 14),
    reserveExtensionAttempt: async details => ({
      blocked: true,
      reason: 'daily_count_reached',
      siteCount: details.observedSiteCount,
      directAttempts,
      effectiveCount: 100,
      limit: 100,
      dateKey: details.dateKey,
      expiresAt: new Date(2026, 6, 15).getTime()
    })
  });

  assert.equal(first.blocked, false);
  assert.equal(first.effectiveCount, 100);
  assert.equal(storage.data.scienceDirectDownloadGuardState, undefined);
  assert.equal(second.blocked, true);
  assert.equal(second.reason, 'daily_count_reached');
});

test('reserves a native ScienceDirect site click before navigation', async () => {
  let details = null;
  const result = await reserveSiteClickAttempt({
    siteStorage: siteStorage('{"2026_7_14":99}'),
    extensionStorage: extensionStorage(),
    document: noLimitDocument(),
    date: new Date(2026, 6, 14),
    reserveExtensionAttempt: async value => {
      details = value;
      return {
        blocked: false,
        reason: '',
        siteCount: 100,
        directAttempts: 0,
        effectiveCount: 100,
        limit: 100,
        dateKey: value.dateKey,
        expiresAt: new Date(2026, 6, 15).getTime()
      };
    }
  });

  assert.equal(details.attemptKind, 'site');
  assert.equal(details.observedSiteCount, 99);
  assert.equal(result.blocked, false);
  assert.equal(result.effectiveCount, 100);
});

test('fails safely when a direct-only attempt cannot be persisted', async () => {
  const result = await reserveDirectAttempt({
    siteStorage: siteStorage('{"2026_7_14":10}'),
    extensionStorage: {
      async get() { return {}; },
      async set() { throw new Error('storage unavailable'); }
    },
    document: noLimitDocument(),
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'direct_counter_unavailable');
});

test('fails safely when the extension direct counter cannot be read', async () => {
  const result = await inspectDownloadSafety({
    siteStorage: siteStorage('{"2026_7_14":10}'),
    extensionStorage: {
      async get() { throw new Error('extension storage unavailable'); }
    },
    document: noLimitDocument(),
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'direct_counter_unavailable');
});

test('fails safely when the ScienceDirect site counter cannot be read', async () => {
  const result = await inspectDownloadSafety({
    siteStorage: {
      getItem() { throw new Error('site storage blocked'); }
    },
    extensionStorage: extensionStorage(),
    document: noLimitDocument(),
    date: new Date(2026, 6, 14)
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'site_counter_unavailable');
});
