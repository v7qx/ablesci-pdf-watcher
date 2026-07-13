(function (root) {
  'use strict';

  function createPublisherRegistry(scope) {
    const directPdf = () => scope.AblesciDirectPdfPublisher;
    const adapters = new Map([
      ['sciencedirect', () => scope.AblesciScienceDirectPublisher],
      ['springer', directPdf],
      ['wiley', directPdf],
      ['acs', directPdf],
      ['oxford', directPdf],
      ['nature', () => scope.AblesciNaturePublisher],
      ['cnpe', () => scope.AblesciSageCnpePublisher],
      ['ieee', () => scope.AblesciIeeePublisher],
      ['rsc', () => scope.AblesciRscPublisher],
      ['aip', () => scope.AblesciAipPublisher],
      ['iop', () => scope.AblesciIopPublisher]
    ]);

    function start(publisher) {
      const publisherId = String(publisher || '').toLowerCase();
      const adapter = adapters.get(publisherId)?.();
      if (typeof adapter?.start !== 'function') return;

      adapter.start();
    }

    return { start };
  }

  root.AblesciPublisherRegistry = { createPublisherRegistry };
})(globalThis);
