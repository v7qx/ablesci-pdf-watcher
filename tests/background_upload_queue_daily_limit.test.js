'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/background/upload_queue.js');

const { createBackgroundUploadQueueApi } = globalThis.AblesciBackgroundUploadQueue;

test('does not start an already queued Elsevier task after the daily stop is recorded', async () => {
  const messages = [];
  let uploads = 0;
  const port = {
    name: 'ablesci-pdf-upload',
    onDisconnect: { addListener() {} }
  };
  const api = createBackgroundUploadQueueApi({
    chromeApi: {
      storage: {
        local: {
          async get(key) {
            assert.equal(key, 'publisherDailyLimitStops');
            return {
              publisherDailyLimitStops: {
                elsevier: { expiresAt: Date.now() + 60_000 }
              }
            };
          },
          async set() {}
        }
      }
    },
    pendingPublisherTabs: new Map(),
    defaultOptions: { watcherTaskTimeoutMinutes: 5 },
    htmlDownloadMessage: 'html',
    getOptions: async () => ({ watcherTaskTimeoutMinutes: 5 }),
    post(_port, type, message, extra) { messages.push({ type, message, extra }); },
    cleanupOrphanPublisherTabs: async () => {},
    clearUploadTaskSnapshot: async () => {},
    saveUploadTaskSnapshot: async () => {},
    async handleUpload() { uploads += 1; },
    classifyJournalAccessFailureReason: error => error.failureReason || '',
    isDoiUrl: () => false,
    isScienceDirectAssetPdfUrl: url => /pdf\.sciencedirectassets\.com/.test(String(url || '')),
    isLikelyRscPayload: () => false,
    saveErrorDiagnostic: async () => {},
    appendDiagnosticTrace: async () => {},
    isNonPdfAccessPageError: () => false,
    escapeHtml: value => value,
    formatTaskError: error => error.message,
    isExpectedTimeoutFailure: () => false,
    formatTimeoutDoneMessage: error => error.message,
    recordManualWatcherDaily: async () => {}
  });

  api.enqueueUpload(port, {
    assistId: 'fixture-assist',
    watcherPublisher: 'elsevier',
    watcherMultiPublisherEnabled: true,
    triggeredBy: 'auto_watcher'
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(uploads, 0);
  assert.ok(messages.some(item => item.type === 'done' && item.extra?.skipReason === 'publisher_daily_limit'));
});

test('infers Elsevier for a queued ScienceDirect asset URL without watcher metadata', async () => {
  const messages = [];
  let uploads = 0;
  const port = { name: 'ablesci-pdf-upload', onDisconnect: { addListener() {} } };
  const api = createBackgroundUploadQueueApi({
    chromeApi: {
      storage: {
        local: {
          async get() {
            return { publisherDailyLimitStops: { elsevier: { expiresAt: Date.now() + 60_000 } } };
          },
          async set() {}
        }
      }
    },
    pendingPublisherTabs: new Map(),
    defaultOptions: { watcherTaskTimeoutMinutes: 5 },
    htmlDownloadMessage: 'html',
    getOptions: async () => ({ watcherTaskTimeoutMinutes: 5 }),
    post(_port, type, message, extra) { messages.push({ type, message, extra }); },
    cleanupOrphanPublisherTabs: async () => {},
    clearUploadTaskSnapshot: async () => {},
    saveUploadTaskSnapshot: async () => {},
    async handleUpload() { uploads += 1; },
    classifyJournalAccessFailureReason: error => error.failureReason || '',
    isDoiUrl: () => false,
    isScienceDirectAssetPdfUrl: url => /pdf\.sciencedirectassets\.com/.test(String(url || '')),
    isLikelyRscPayload: () => false,
    saveErrorDiagnostic: async () => {},
    appendDiagnosticTrace: async () => {},
    isNonPdfAccessPageError: () => false,
    escapeHtml: value => value,
    formatTaskError: error => error.message,
    isExpectedTimeoutFailure: () => false,
    formatTimeoutDoneMessage: error => error.message,
    recordManualWatcherDaily: async () => {}
  });

  const queued = api.enqueueUpload(port, {
    assistId: 'fixture-direct-asset',
    pdfUrl: 'https://pdf.sciencedirectassets.com/fixture/main.pdf'
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(queued.publisher, 'elsevier');
  assert.equal(uploads, 0);
  assert.ok(messages.some(item => item.extra?.skipReason === 'publisher_daily_limit'));
});
