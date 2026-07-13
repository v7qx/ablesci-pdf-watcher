'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

globalThis.window = globalThis;
globalThis.location = { href: 'https://www.ablesci.com/assist/detail?id=fixture' };

require('../extension/common/publisher_capabilities.js');
require('../extension/content/adapters.js');

test('content adapter canonicalizes a synthetic ScienceDirect PDF route through the capability', () => {
  assert.equal(
    globalThis.AblesciPdfAdapters.convertKnownUrlToPdf(
      'https://sciencedirect.com/science/article/pii/S0000000000000000/pdfft?fixture=1'
    ),
    'https://sciencedirect.com/science/article/pii/S0000000000000000'
  );
});

test('content adapter keeps an unknown URL safely unsupported', () => {
  assert.equal(
    globalThis.AblesciPdfAdapters.convertKnownUrlToPdf('https://example.invalid/fixture.pdf'),
    null
  );
});
