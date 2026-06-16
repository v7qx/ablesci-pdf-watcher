(function () {
  'use strict';

  const common = window.AblesciPublisherCommon;
  if (!common) return;

  // ScienceDirect 有时先经过验证/跳转，持续等待原生 View PDF 入口；成功或超时后断开观察器，避免影响普通浏览。
  common.canControlCurrentPublisherPage().then(ok => {
    if (!ok) {
      console.debug('[Ablesci PDF Watcher] publisher page ignored: no pending task for this tab');
      return;
    }
    if (common.isScienceDirect()) {
      window.AblesciScienceDirectPublisher?.start();
      return;
    }
    if (common.isNature()) {
      window.AblesciNaturePublisher?.start();
      return;
    }
    if (location.hostname.includes('cnpereading.com')) {
      window.AblesciCnpePublisher?.start();
      return;
    }
    if (common.isIeee()) {
      window.AblesciIeeePublisher?.start();
      return;
    }
    if (common.isSpringer() || common.isWiley() || common.isAcs() || common.isOxford() || common.isSage()) {
      window.AblesciDirectPdfPublisher?.start();
      return;
    }
    if (common.isRsc()) {
      window.AblesciRscPublisher?.start();
      return;
    }
    if (common.isAip()) {
      window.AblesciAipPublisher?.start();
      return;
    }
    if (common.isIop()) {
      window.AblesciIopPublisher?.start();
    }
  });
})();
