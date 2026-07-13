'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/common/publisher_capabilities.js');
require('../extension/background/publishers.js');

const publishers = globalThis.AblesciBackgroundPublishers;

test('background publisher adapter delegates synthetic ScienceDirect identity facts', () => {
  const assetUrl = 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S0000000000000000-main.pdf';

  assert.equal(publishers.publisherForDoi('10.1016/j.ablesci-fixture.2026.000001'), 'sciencedirect');
  assert.equal(publishers.extractScienceDirectPii(assetUrl), 'S0000000000000000');
  assert.equal(
    publishers.scienceDirectArticleUrlFromPdfUrl(assetUrl),
    'https://www.sciencedirect.com/science/article/pii/S0000000000000000'
  );
  assert.equal(publishers.isScienceDirectAssetPdfUrl(assetUrl), true);
});

test('background publisher adapter preserves ScienceDirect download acceptance', () => {
  const result = publishers.isLikelyTargetDownload(
    {
      finalUrl: 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S0000000000000000-main.pdf',
      filename: 'fixture.pdf',
      mime: 'application/pdf'
    },
    'www.sciencedirect.com',
    'https://www.sciencedirect.com/science/article/pii/S0000000000000000/pdf'
  );

  assert.deepEqual(result, { ok: true });
});

test('background publisher adapter preserves the ScienceDirect PII mismatch reason', () => {
  const result = publishers.isLikelyTargetDownload(
    {
      finalUrl: 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S1111111111111111-main.pdf',
      filename: 'fixture.pdf',
      mime: 'application/pdf'
    },
    'www.sciencedirect.com',
    'https://www.sciencedirect.com/science/article/pii/S0000000000000000/pdf'
  );

  assert.equal(result.ok, false);
  assert.match(result.reason, /^pii_mismatch \(/);
  assert.match(result.reason, /S0000000000000000/);
  assert.match(result.reason, /S1111111111111111/);
});

test('background publisher adapter rejects an unverified DOI-only ScienceDirect download', () => {
  const result = publishers.isLikelyTargetDownload(
    {
      finalUrl: 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S0000000000000000-main.pdf',
      filename: 'fixture.pdf',
      mime: 'application/pdf'
    },
    'doi.org',
    'https://doi.org/10.1016/j.ablesci-fixture.2026.000001'
  );

  assert.deepEqual(result, {
    ok: false,
    reason: 'sciencedirect_download_ownership_not_established'
  });
});
