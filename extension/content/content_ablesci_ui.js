(function () {
  'use strict';

  function createContentUiApi(config = {}) {
    const {
      buttonId = 'ablesci-native-oneclick-pdf-btn',
      logId = 'ablesci-native-oneclick-pdf-log'
    } = config;

    function styleText() {
      return `
      #${buttonId} {
        margin-left: 5px !important;
        margin-right: 5px !important;
        background: var(--ablesci-btn-bg, #FF5722) !important;
        border-color: var(--ablesci-btn-bg, #FF5722) !important;
        color: var(--ablesci-btn-fg, #ffffff) !important;
        font-weight: bold !important;
        line-height: 22px !important;
        height: 22px !important;
        padding: 0 8px !important;
        border-radius: 2px !important;
        vertical-align: middle !important;
      }
      #${buttonId}:hover { color:var(--ablesci-btn-fg, #ffffff) !important; opacity:.86 !important; text-decoration:none !important; }
      #${buttonId}.busy { background:#999 !important; border-color:#999 !important; cursor:wait !important; }
      #${buttonId}.ok { background:#009688 !important; border-color:#009688 !important; }
      #${buttonId}.warn { background:#e5e7eb !important; border-color:#cbd5e1 !important; color:#334155 !important; }
      #${buttonId}.warn:hover { color:#334155 !important; }
      #${buttonId}.err { background:#a94442 !important; border-color:#a94442 !important; }
      #${logId} { display:none !important; }
      .ablesci-native-layer-shade { position: fixed; inset: 0; background: rgba(0,0,0,.32); z-index: 2147483000; }
      .ablesci-native-layer { position: fixed; left: 50%; top: 12%; transform: translateX(-50%); width: min(680px, calc(100vw - 48px)); background: #fff; border-radius: 2px; box-shadow: 1px 1px 50px rgba(0,0,0,.3); z-index: 2147483001; font-size: 14px; color: #222; }
      .ablesci-native-layer-content { padding: 20px 28px; max-height: 62vh; overflow: auto; line-height: 1.65; }
      .ablesci-native-layer-content a { color: #01AAED; }
      .ablesci-native-layer-btn { padding: 12px 20px; border-top: 1px solid #eee; text-align: right; }
      .ablesci-native-layer-btn button { min-width: 86px; height: 38px; border: none; border-radius: 4px; background: #1E9FFF; color: #fff; cursor: pointer; font-size: 14px; }
      .ablesci-native-toast { position: fixed; left: 50%; top: 28%; transform: translateX(-50%); background: rgba(0,0,0,.78); color: #fff; z-index: 2147483001; padding: 10px 18px; border-radius: 3px; max-width: min(680px, calc(100vw - 48px)); line-height: 1.6; }
    `;
    }

    return { styleText };
  }

  globalThis.AblesciContentUi = {
    createContentUiApi
  };
})();
