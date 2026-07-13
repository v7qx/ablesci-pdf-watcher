'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/content/publisher_registry.js');

const { createPublisherRegistry } = globalThis.AblesciPublisherRegistry;

test('starts the ScienceDirect adapter for the sciencedirect publisher', () => {
  let starts = 0;
  const registry = createPublisherRegistry({
    AblesciScienceDirectPublisher: {
      start() {
        starts += 1;
      }
    }
  });

  registry.start('sciencedirect');

  assert.equal(starts, 1);
});

test('starts the shared direct-PDF adapter for its four publishers', () => {
  const starts = [];
  const registry = createPublisherRegistry({
    AblesciDirectPdfPublisher: {
      start() {
        starts.push('direct-pdf');
      }
    }
  });

  for (const publisher of ['springer', 'wiley', 'acs', 'oxford']) {
    registry.start(publisher);
  }

  assert.deepEqual(starts, [
    'direct-pdf',
    'direct-pdf',
    'direct-pdf',
    'direct-pdf'
  ]);
});

test('starts each remaining publisher adapter', () => {
  const started = [];
  const scope = {};
  const cases = [
    ['nature', 'nature', 'AblesciNaturePublisher'],
    ['cnpe', 'sage-cnpe', 'AblesciSageCnpePublisher'],
    ['ieee', 'ieee', 'AblesciIeeePublisher'],
    ['rsc', 'rsc', 'AblesciRscPublisher'],
    ['aip', 'aip', 'AblesciAipPublisher'],
    ['iop', 'iop', 'AblesciIopPublisher']
  ];

  for (const [, adapterId, globalName] of cases) {
    scope[globalName] = {
      start() {
        started.push(adapterId);
      }
    };
  }

  const registry = createPublisherRegistry(scope);
  for (const [publisher] of cases) {
    registry.start(publisher);
  }

  assert.deepEqual(started, cases.map(([, adapterId]) => adapterId));
});

test('does not start an adapter for an unknown publisher', () => {
  let starts = 0;
  const registry = createPublisherRegistry({
    AblesciNaturePublisher: {
      start() {
        starts += 1;
      }
    }
  });

  assert.doesNotThrow(() => registry.start('unknown'));
  assert.equal(starts, 0);
});

test('does not throw when a registered adapter is unavailable', () => {
  const registry = createPublisherRegistry({});

  assert.doesNotThrow(() => registry.start('nature'));
});
