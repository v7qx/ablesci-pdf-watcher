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
        state.lastSessionSizeDecision = {
          mode: state.speedMode || 'normal',
          picked: finalSize,
          cap,
          finalSize,
          random: 0,
          total: 1,
          weights: [0, 1],
          allowZero: false
        };
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
