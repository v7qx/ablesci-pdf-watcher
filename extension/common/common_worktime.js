'use strict';

(function () {

  function beijingMinutesNow(date = new Date()) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(date).reduce((acc, item) => {
      acc[item.type] = item.value;
      return acc;
    }, {});
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  globalThis.AblesciWatcherWorktime = {
    beijingMinutesNow
  };
})();
