'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/background/upload_guards.js');

const { createBackgroundUploadGuardsApi } = globalThis.AblesciBackgroundUploadGuards;

function createHarness(options = {}) {
  const data = {
    watcherEnabled: true,
    autoWatcherState: {},
    publisherDailyLimitStops: {},
    scienceDirectDownloadGuardState: options.scienceDirectDownloadGuardState,
    scienceDirectSiteCountSnapshot: options.scienceDirectSiteCountSnapshot
  };
  const notifications = [];
  const clearedAlarms = [];
  const chromeApi = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: data[keys] };
          return Object.fromEntries(keys.map(key => [key, data[key]]));
        },
        async set(values) {
          Object.assign(data, values);
        }
      }
    },
    notifications: {
      async create(notification) {
        notifications.push(notification);
      }
    },
    alarms: {
      async clear(name) {
        clearedAlarms.push(name);
      }
    }
  };
  const api = createBackgroundUploadGuardsApi({
    chromeApi,
    defaultOptions: { watcherCfPauseThreshold: 3 },
    getOptions: async () => ({
      watcherMultiPublisherEnabled: true,
      watcherStopOnCfChallenge: true,
      watcherCfNotificationEnabled: true,
      ...options
    }),
    urlHostPath: value => value
  });
  return { api, data, notifications, clearedAlarms };
}

test('records a ScienceDirect daily stop without disabling other publisher lanes', async () => {
  const harness = createHarness({ watcherMultiPublisherEnabled: true });

  const result = await harness.api.recordPublisherDailyLimit({
    publisher: 'elsevier',
    pageUrl: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000',
    reason: 'daily_count_reached',
    effectiveCount: 100,
    limit: 100,
    expiresAt: Date.now() + 60_000
  });

  assert.equal(result.paused, true);
  assert.equal(result.publisher, 'elsevier');
  assert.equal(harness.data.watcherEnabled, true);
  assert.equal(harness.clearedAlarms.length, 0);
  assert.equal(harness.data.publisherDailyLimitStops.elsevier.effectiveCount, 100);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].requireInteraction, false);
  assert.match(harness.notifications[0].message, /100\/100/);
  assert.match(harness.notifications[0].message, /其他出版社继续/);
});

test('keeps publisher challenge notifications visible for manual handling', async () => {
  const harness = createHarness({ watcherMultiPublisherEnabled: true });

  await harness.api.recordPublisherCfChallenge(
    'https://www.sciencedirect.com/science/article/pii/S0000000000000000',
    'elsevier'
  );

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].requireInteraction, true);
});

test('does not turn a temporary ScienceDirect counter failure into a day-long publisher stop', async () => {
  const harness = createHarness({ watcherMultiPublisherEnabled: true });

  const result = await harness.api.recordPublisherDailyLimit({
    publisher: 'elsevier',
    reason: 'direct_counter_unavailable',
    effectiveCount: 0,
    limit: 100,
    expiresAt: Date.now() + 60_000
  });

  assert.equal(result.paused, false);
  assert.equal(result.temporary, true);
  assert.deepEqual(harness.data.publisherDailyLimitStops, {});
  assert.equal(harness.notifications.length, 0);
});

test('allows the one-hundredth background ScienceDirect direct download and blocks the next one', async () => {
  const harness = createHarness({
    scienceDirectDownloadGuardState: {
      dateKey: '2026_7_14',
      directAttempts: 3
    },
    scienceDirectSiteCountSnapshot: {
      dateKey: '2026_7_14',
      siteCount: 96
    }
  });
  const date = new Date(2026, 6, 14, 12, 0, 0);

  const hundredth = await harness.api.reserveScienceDirectAttempt({ date, attemptKind: 'direct' });
  const next = await harness.api.reserveScienceDirectAttempt({ date, attemptKind: 'direct' });

  assert.equal(hundredth.blocked, false);
  assert.equal(hundredth.effectiveCount, 100);
  assert.equal(harness.data.scienceDirectDownloadGuardState.directAttempts, 4);
  assert.equal(next.blocked, true);
  assert.equal(next.reason, 'daily_count_reached');
  assert.equal(next.effectiveCount, 100);
});

test('fails safely when the background ScienceDirect direct counter cannot be persisted', async () => {
  const harness = createHarness();
  harness.api = createBackgroundUploadGuardsApi({
    chromeApi: {
      storage: {
        local: {
          async get() { return {}; },
          async set() { throw new Error('storage unavailable'); }
        }
      },
      notifications: { async create() {} },
      alarms: { async clear() {} }
    },
    defaultOptions: { watcherCfPauseThreshold: 3 },
    getOptions: async () => ({}),
    urlHostPath: value => value
  });

  const result = await harness.api.reserveScienceDirectAttempt({
    date: new Date(2026, 6, 14, 12, 0, 0)
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'direct_counter_unavailable');
});

test('serializes site-click and direct ScienceDirect reservations through one background writer', async () => {
  const harness = createHarness({
    scienceDirectDownloadGuardState: { dateKey: '2026_7_14', directAttempts: 48 },
    scienceDirectSiteCountSnapshot: { dateKey: '2026_7_14', siteCount: 50 }
  });
  const date = new Date(2026, 6, 14, 12, 0, 0);

  const [siteClick, direct] = await Promise.all([
    harness.api.reserveScienceDirectAttempt({ date, attemptKind: 'site', observedSiteCount: 50 }),
    harness.api.reserveScienceDirectAttempt({ date, attemptKind: 'direct', observedSiteCount: 50 })
  ]);

  assert.equal(siteClick.blocked, false);
  assert.equal(siteClick.effectiveCount, 99);
  assert.equal(direct.blocked, false);
  assert.equal(direct.effectiveCount, 100);
  assert.equal(harness.data.scienceDirectSiteCountSnapshot.siteCount, 51);
  assert.equal(harness.data.scienceDirectDownloadGuardState.directAttempts, 49);
});

test('fails safely when a persisted ScienceDirect counter is malformed', async () => {
  const harness = createHarness({
    scienceDirectDownloadGuardState: { dateKey: '2026_7_14', directAttempts: 'broken' }
  });

  const result = await harness.api.reserveScienceDirectAttempt({
    date: new Date(2026, 6, 14, 12, 0, 0),
    attemptKind: 'direct'
  });

  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'direct_counter_unavailable');
});
