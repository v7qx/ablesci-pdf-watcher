'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

require('../extension/common/publisher_capabilities.js');

const { forPublisher } = globalThis.AblesciPublisherCapabilities;

test('inspects a synthetic ScienceDirect asset URL in one pass', () => {
  const capability = forPublisher('sciencedirect');

  const result = capability.inspectUrl(
    'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S0000000000000000-main.pdf'
  );

  assert.deepEqual(result, {
    publisher: 'sciencedirect',
    kind: 'direct_asset_pdf',
    related: true,
    piis: ['S0000000000000000'],
    identity: {
      publisher: 'sciencedirect',
      articleUrl: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000',
      pii: 'S0000000000000000',
      doi: ''
    }
  });
});

test('identifies a synthetic ScienceDirect article without retaining PDF route details', () => {
  const capability = forPublisher('sciencedirect');

  const result = capability.identifyArticle({
    url: 'https://www.sciencedirect.com/science/article/abs/pii/S0000000000000000/pdfft?fixture=1'
  });

  assert.deepEqual(result, {
    ok: true,
    identity: {
      publisher: 'sciencedirect',
      articleUrl: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000',
      pii: 'S0000000000000000',
      doi: ''
    }
  });
});

test('identifies a synthetic ScienceDirect DOI without inventing a PII', () => {
  const capability = forPublisher('sciencedirect');

  const result = capability.identifyArticle({
    doi: '10.1016/j.ablesci-fixture.2026.000001'
  });

  assert.deepEqual(result, {
    ok: true,
    identity: {
      publisher: 'sciencedirect',
      articleUrl: 'https://doi.org/10.1016/j.ablesci-fixture.2026.000001',
      pii: '',
      doi: '10.1016/j.ablesci-fixture.2026.000001'
    }
  });
});

test('creates a main-PDF candidate for the identified ScienceDirect article', () => {
  const capability = forPublisher('sciencedirect');
  const identity = capability.identifyArticle({
    url: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000'
  }).identity;

  const result = capability.createPdfCandidate({
    identity,
    url: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000/pdfft?fixture=1',
    source: 'native_view_pdf_link'
  });

  assert.deepEqual(result, {
    ok: true,
    candidate: {
      publisher: 'sciencedirect',
      url: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000/pdfft?fixture=1',
      source: 'native_view_pdf_link',
      pii: 'S0000000000000000'
    }
  });
});

test('accepts a matching ScienceDirect asset download for the article identity', () => {
  const capability = forPublisher('sciencedirect');
  const identity = capability.identifyArticle({
    url: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000'
  }).identity;

  const result = capability.decideDownloadOwnership({
    identity,
    expectedHost: 'www.sciencedirect.com',
    sourceUrl: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000/pdf',
    item: {
      url: 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S0000000000000000-main.pdf',
      finalUrl: 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S0000000000000000-main.pdf',
      filename: 'fixture.pdf',
      mime: 'application/pdf'
    }
  });

  assert.deepEqual(result, {
    ok: true,
    reasonCode: 'sciencedirect_related_pdf'
  });
});

test('rejects a ScienceDirect download whose PII belongs to another article', () => {
  const capability = forPublisher('sciencedirect');
  const identity = capability.identifyArticle({
    url: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000'
  }).identity;

  const result = capability.decideDownloadOwnership({
    identity,
    expectedHost: 'www.sciencedirect.com',
    sourceUrl: identity.articleUrl,
    item: {
      finalUrl: 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S1111111111111111-main.pdf',
      filename: 'fixture.pdf',
      mime: 'application/pdf'
    }
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'sciencedirect_pii_mismatch'
  });
});

test('rejects a ScienceDirect asset when a DOI-only identity cannot prove ownership', () => {
  const capability = forPublisher('sciencedirect');
  const identity = capability.identifyArticle({
    doi: '10.1016/j.ablesci-fixture.2026.000001'
  }).identity;

  const result = capability.decideDownloadOwnership({
    identity,
    expectedHost: 'doi.org',
    sourceUrl: identity.articleUrl,
    item: {
      finalUrl: 'https://pdf.sciencedirectassets.com/fixture/1-s2.0-S0000000000000000-main.pdf',
      filename: 'fixture.pdf',
      mime: 'application/pdf'
    }
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'article_identity_evidence_missing'
  });
});

test('rejects a ScienceDirect asset with no article PII when the identity has one', () => {
  const capability = forPublisher('sciencedirect');
  const identity = capability.identifyArticle({
    url: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000'
  }).identity;

  const result = capability.decideDownloadOwnership({
    identity,
    sourceUrl: identity.articleUrl + '/pdf',
    item: {
      finalUrl: 'https://pdf.sciencedirectassets.com/fixture/download.pdf',
      filename: 'download.pdf',
      mime: 'application/pdf'
    }
  });

  assert.deepEqual(result, {
    ok: false,
    reasonCode: 'sciencedirect_pii_missing'
  });
});

test('fails safely for an unknown ScienceDirect article input', () => {
  const capability = forPublisher('sciencedirect');

  assert.deepEqual(capability.identifyArticle({ url: 'https://example.invalid/fixture' }), {
    ok: false,
    reasonCode: 'article_identity_not_found'
  });
});

test('does not identify a ScienceDirect PII copied into an unrelated host URL', () => {
  const capability = forPublisher('sciencedirect');

  assert.deepEqual(capability.identifyArticle({
    url: 'https://example.invalid/science/article/pii/S0000000000000000'
  }), {
    ok: false,
    reasonCode: 'article_identity_not_found'
  });
});

test('does not create a PDF candidate from an unrelated absolute URL', () => {
  const capability = forPublisher('sciencedirect');
  const identity = capability.identifyArticle({
    url: 'https://www.sciencedirect.com/science/article/pii/S0000000000000000'
  }).identity;

  assert.deepEqual(capability.createPdfCandidate({
    identity,
    url: 'https://example.invalid/science/article/pii/S0000000000000000/pdf',
    source: 'fixture'
  }), {
    ok: false,
    reasonCode: 'publisher_url_not_allowed'
  });
});
