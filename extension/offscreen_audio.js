'use strict';

(function () {
  let audioContext = null;

  function ensureAudioContext() {
    if (!audioContext) {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctor) throw new Error('AudioContext unavailable');
      audioContext = new Ctor();
    }
    return audioContext;
  }

  async function playPattern(kind = 'default') {
    const ctx = ensureAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    const now = ctx.currentTime;
    const pattern = kind === 'urgent'
      ? [
          { at: 0.00, freq: 880, dur: 0.14, gain: 0.10 },
          { at: 0.18, freq: 740, dur: 0.16, gain: 0.12 },
          { at: 0.40, freq: 880, dur: 0.22, gain: 0.12 }
        ]
      : [
          { at: 0.00, freq: 740, dur: 0.12, gain: 0.08 },
          { at: 0.16, freq: 880, dur: 0.16, gain: 0.09 }
        ];

    for (const tone of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.freq;
      gain.gain.setValueAtTime(0.0001, now + tone.at);
      gain.gain.linearRampToValueAtTime(tone.gain, now + tone.at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.at);
      osc.stop(now + tone.at + tone.dur + 0.02);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'ablesciPlayNotificationSound') return false;
    playPattern(message.kind === 'urgent' ? 'urgent' : 'default')
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, reason: err?.message || String(err) }));
    return true;
  });
})();
