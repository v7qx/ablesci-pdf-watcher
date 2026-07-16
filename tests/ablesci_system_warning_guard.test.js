'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

require('../extension/common/assist_system_warnings.js');
require('../extension/watcher/candidate.js');

const warningApi = globalThis.AblesciAssistSystemWarnings;
const repoRoot = path.resolve(__dirname, '..');

function makeCandidateApi() {
  return globalThis.AblesciWatcherCandidateModule.createWatcherCandidateApi({
    chromeApi: {},
    saveWatcherState: async () => {},
    getWatcherState: async () => ({}),
    appendWatcherTrace: async () => {},
    publisherAlias: value => String(value || '') || 'Unknown',
    normalizeText: value => String(value || '').replace(/\s+/g, ' ').trim(),
    journalShortNameMapKey: 'journalShortNameMap',
    highRiskFailThreshold: 3,
    doiFailureSkipThreshold: 3
  });
}

test('classifies the NCBI index-library system alert as an authoritative hard block', () => {
  const result = warningApi.classifyAlertItems([{
    special: true,
    text: '系统提示 该文献链接来自 ncbi，该网站是索引库，类似于搜索引擎，其准确性不能保证。建议填写原始官方链接。'
  }]);

  assert.equal(result.blocked, true);
  assert.equal(result.skipReason, 'detail_system_prompt_abnormal');
  assert.equal(result.flags.systemPromptAbnormalAssist, true);
});

test('fails closed when the site changes wording inside special-assist-alert', () => {
  const result = warningApi.classifyAlertItems([{
    special: true,
    text: '系统提示：请人工核实当前求助信息。'
  }]);

  assert.equal(result.blocked, true);
  assert.equal(result.skipReason, 'detail_system_prompt_abnormal');
});

test('does not treat generic index-library boilerplate as a site warning', () => {
  const result = warningApi.classifyAlertItems([{
    special: false,
    text: '科研通学术中心是文献索引库。'
  }]);

  assert.equal(result.blocked, false);
});

test('background derives an upload hard block from the detail-page risk flags', () => {
  const result = warningApi.hardBlockFromPayload({
    riskFlags: { systemPromptAbnormalAssist: true }
  });

  assert.equal(result.blocked, true);
  assert.equal(result.skipReason, 'detail_system_prompt_abnormal');
});

test('watcher cannot override a site system warning by disabling generic risk-text filtering', () => {
  const result = makeCandidateApi().isDetailAllowedForWatcher({
    assistId: 'example',
    doi: '10.1016/example',
    pdfUrl: 'https://example.invalid/article.pdf',
    title: 'Example title',
    riskFlags: { systemPromptAbnormalAssist: true }
  }, {
    watcherSkipRiskText: false,
    watcherSkipBookChapter: false,
    watcherSkipPatentReport: false,
    watcherSkipSupplement: false,
    watcherRequireDoi: true,
    watcherSkipRejected: false,
    watcherSkipReported: false,
    watcherSkipRemark: false,
    watcherSkipCorrigendum: false,
    watcherEnableBlacklist: false
  });

  assert.deepEqual(result, { ok: false, reason: 'detail_system_prompt_abnormal' });
});

test('loads the warning guard before both the detail parser and background upload pipeline', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension/manifest.json'), 'utf8'));
  const assistScripts = manifest.content_scripts.find(entry => entry.js.includes('content/content_ablesci.js')).js;
  const backgroundSource = fs.readFileSync(path.join(repoRoot, 'extension/background.js'), 'utf8');
  const uploadSource = fs.readFileSync(path.join(repoRoot, 'extension/background/upload.js'), 'utf8');

  assert.ok(
    assistScripts.indexOf('common/assist_system_warnings.js') < assistScripts.indexOf('content/content_ablesci.js'),
    'detail pages must load the system-warning guard before parsing the request'
  );
  assert.ok(
    backgroundSource.indexOf("'common/assist_system_warnings.js'") < backgroundSource.indexOf("'background/upload.js'"),
    'background must load the system-warning guard before the upload pipeline'
  );
  assert.match(uploadSource, /stage:\s*'skipped-site-system-warning'/);
});
