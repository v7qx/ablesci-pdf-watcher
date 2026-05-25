'use strict';

(function () {
  function createWatcherDemandApi() {
    async function recordDemandSnapshot() {
      return null;
    }

    function shouldObserveDemand() {
      return { due: false, reason: 'market_observe_removed' };
    }

    async function markObservedSlot() {
      return undefined;
    }

    async function collectDemandIfDue() {
      return null;
    }

    return {
      recordDemandSnapshot,
      shouldObserveDemand,
      markObservedSlot,
      collectDemandIfDue
    };
  }

  globalThis.AblesciWatcherDemandModule = {
    createWatcherDemandApi
  };
})();
