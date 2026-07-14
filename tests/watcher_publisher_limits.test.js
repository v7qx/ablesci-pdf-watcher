'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/watcher/publisher_limits.js');

const {
  filterStoppedPublisherUrls,
  pruneExpiredPublisherStops
} = globalThis.AblesciWatcherPublisherLimits;

const elsevierUrl = 'https://www.ablesci.com/assist/list?publisher=elsevier';
const rscUrl = 'https://www.ablesci.com/assist/list?publisher=rsc';

test('keeps other publisher sources eligible while Elsevier is stopped for the day', () => {
  const now = 1_700_000_000_000;
  const state = {
    publisherDailyLimitStops: {
      elsevier: { expiresAt: now + 60_000 }
    }
  };

  assert.deepEqual(
    filterStoppedPublisherUrls([elsevierUrl, rscUrl], state, now),
    [rscUrl]
  );
});

test('removes expired daily stops so Elsevier becomes eligible again', () => {
  const now = 1_700_000_000_000;
  const state = {
    publisherDailyLimitStops: {
      elsevier: { expiresAt: now - 1 }
    }
  };

  assert.equal(pruneExpiredPublisherStops(state, now), true);
  assert.deepEqual(state.publisherDailyLimitStops, {});
  assert.deepEqual(
    filterStoppedPublisherUrls([elsevierUrl, rscUrl], state, now),
    [elsevierUrl, rscUrl]
  );
});

test('removes legacy counter-unavailable stops instead of closing Elsevier for the day', () => {
  const now = 1_700_000_000_000;
  const state = {
    publisherDailyLimitStops: {
      elsevier: {
        reason: 'direct_counter_unavailable',
        expiresAt: now + 60_000
      }
    }
  };

  assert.deepEqual(
    filterStoppedPublisherUrls([elsevierUrl, rscUrl], state, now),
    [elsevierUrl, rscUrl]
  );
  assert.equal(pruneExpiredPublisherStops(state, now), true);
  assert.deepEqual(state.publisherDailyLimitStops, {});
});
