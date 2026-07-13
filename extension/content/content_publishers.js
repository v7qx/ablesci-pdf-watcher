(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  const registryModule = window.AblesciPublisherRegistry;
  if (!common || !registryModule) return;
  const registry = registryModule.createPublisherRegistry(window);

  common.canControlCurrentPublisherPage().then(ok => {
    if (!ok) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending task for this tab');
      return;
    }
    registry.start(common.currentPublisher());
  });
})();
