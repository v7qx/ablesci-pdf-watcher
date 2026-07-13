'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension/manifest.json'), 'utf8'));

test('loads publisher capabilities before both content adapters', () => {
  const assistScripts = manifest.content_scripts.find(entry => entry.js.includes('content/adapters.js')).js;
  const publisherScripts = manifest.content_scripts.find(entry => entry.js.includes('content/publisher_sciencedirect.js')).js;

  assert.ok(
    assistScripts.indexOf('common/publisher_capabilities.js') < assistScripts.indexOf('content/adapters.js'),
    'assist detail must load publisher capabilities before adapters'
  );
  assert.ok(
    publisherScripts.indexOf('common/publisher_capabilities.js') < publisherScripts.indexOf('content/publishers_common.js'),
    'publisher pages must load capabilities before publisher common code'
  );
  assert.ok(
    publisherScripts.indexOf('common/publisher_capabilities.js') < publisherScripts.indexOf('content/publisher_sciencedirect.js'),
    'publisher pages must load capabilities before the ScienceDirect adapter'
  );
  assert.ok(
    publisherScripts.includes('content/sciencedirect_download_guard.js'),
    'publisher pages must include the ScienceDirect download guard'
  );
  assert.ok(
    publisherScripts.indexOf('content/sciencedirect_download_guard.js') < publisherScripts.indexOf('content/publisher_sciencedirect.js'),
    'publisher pages must load the ScienceDirect download guard before the adapter'
  );
});

test('loads publisher capabilities before background publisher adapters', () => {
  const backgroundSource = fs.readFileSync(path.join(repoRoot, 'extension/background.js'), 'utf8');

  assert.ok(
    backgroundSource.indexOf("'common/publisher_capabilities.js'") <
      backgroundSource.indexOf("'background/publishers.js'"),
    'background must load publisher capabilities before publisher adapters'
  );
  assert.ok(
    backgroundSource.includes("'watcher/publisher_limits.js'"),
    'background must load publisher daily-limit helpers'
  );
  assert.ok(
    backgroundSource.indexOf("'watcher/publisher_limits.js'") < backgroundSource.indexOf("'watcher/state.js'"),
    'publisher daily-limit helpers must load before watcher state'
  );
});
