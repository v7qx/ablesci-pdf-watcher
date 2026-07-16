'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/watcher/logging.js');

function createLoggingHarness({ storedState, options }) {
  const badgeTexts = [];
  const titles = [];
  let stateReads = 0;
  const api = globalThis.AblesciWatcherLoggingModule.createWatcherLoggingApi({
    chromeApi: {
      action: {
        setBadgeText: async value => badgeTexts.push(value.text),
        setBadgeBackgroundColor: async () => {},
        setTitle: async value => titles.push(value.title)
      },
      storage: { local: { get: async () => ({}) } }
    },
    depsRef: { getOptions: async () => options },
    getWatcherState: async () => {
      stateReads += 1;
      return storedState;
    },
    normalizeOptions: value => value,
    normalizeText: value => String(value || '').trim(),
    formatBeijingDateTime: value => String(value),
    countdownText: value => value === storedState.parallelLaneSchedules.secondary1.scheduledAt ? '2m00s' : '5h00m',
    sanitizeTraceValue: value => value,
    sanitizeReportUrl: value => value,
    autoWatcherLogKey: 'logs',
    autoWatcherTraceKey: 'trace',
    autoWatcherAbnormalKey: 'abnormal',
    maxLogs: 10,
    maxTraceLogs: 10,
    traceFlushIntervalMs: 1000,
    traceFlushBatchSize: 10,
    watcherLogFlushIntervalMs: 1000,
    watcherLogFlushBatchSize: 10,
    badgeRefreshIntervalMs: 1000
  });
  return { api, badgeTexts, titles, get stateReads() { return stateReads; } };
}

test('badge schedule chooses the earliest runnable publisher lane before the SD resume alarm', () => {
  const now = Date.now();
  const api = createLoggingHarness({
    storedState: {
      parallelLaneSchedules: {
        elsevier: { scheduledAt: now + 5 * 60 * 60 * 1000, reason: 'publisher_daily_limit_resume' },
        secondary1: { scheduledAt: now + 2 * 60 * 1000, reason: 'after_secondary1_run' }
      }
    },
    options: { watcherEnabled: true, watcherMultiPublisherEnabled: true }
  }).api;

  const schedule = api.nextDisplaySchedule({
    parallelLaneSchedules: {
      elsevier: { scheduledAt: now + 5 * 60 * 60 * 1000, reason: 'publisher_daily_limit_resume' },
      secondary1: { scheduledAt: now + 2 * 60 * 1000, reason: 'after_secondary1_run' }
    }
  }, { watcherMultiPublisherEnabled: true });

  assert.equal(schedule.time, now + 2 * 60 * 1000);
});

test('multi-publisher badge ignores a stale lane state supplied by the SD callback', async () => {
  const now = Date.now();
  const storedState = {
    parallelLaneSchedules: {
      elsevier: { scheduledAt: now + 5 * 60 * 60 * 1000, reason: 'publisher_daily_limit_resume' },
      secondary1: { scheduledAt: now + 2 * 60 * 1000, reason: 'after_secondary1_run' }
    }
  };
  const harness = createLoggingHarness({
    storedState,
    options: {
      watcherEnabled: true,
      watcherMultiPublisherEnabled: true,
      watcherBadgeCountdownEnabled: true,
      watcherLanguage: 'zh'
    }
  });

  await harness.api.updateActionBadge({
    parallelLaneSchedules: {
      elsevier: storedState.parallelLaneSchedules.elsevier
    }
  });

  assert.equal(harness.stateReads, 1);
  assert.equal(harness.badgeTexts.at(-1), '2m');
  assert.match(harness.titles.at(-1), /倒计时: 2m00s/);
});
