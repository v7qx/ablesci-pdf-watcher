'use strict';

// Responsibility: current watcher session-size calculation.
(function () {
  function createWatcherSessionApi(config) {
    const {
      sessionExecutionCap
    } = config;

    function sessionSize(opts, state) {
      const cap = sessionExecutionCap(opts, state, false);
      const finalSize = cap > 0 ? 1 : 0;
      if (state) {
        state.lastSessionCapacityDecision = {
          mode: state.speedMode || 'normal',
          cap,
          finalSize,
          allowZero: false
        };
        delete state.lastSessionSizeDecision;
      }
      return finalSize;
    }

    return {
      sessionSize
    };
  }

  globalThis.AblesciWatcherSessionModule = {
    createWatcherSessionApi
  };
}());
