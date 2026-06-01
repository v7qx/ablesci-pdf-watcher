'use strict';

(function () {
  const DEFAULT_WORKDAYS = '1,2,3,4,5';
  const DEFAULT_WORK_WINDOWS = '09:00-12:00\n13:30-18:00';

  function parseMinuteOfDay(value) {
    const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return NaN;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return NaN;
    return hour * 60 + minute;
  }

  function minutesOfDay(value) {
    return parseMinuteOfDay(value);
  }

  function normalizeWorkdaysSet(value, fallback = DEFAULT_WORKDAYS) {
    const items = String(value || fallback)
      .split(/[,\s]+/)
      .map(item => Number(item.trim()))
      .filter(day => Number.isInteger(day) && day >= 1 && day <= 7);
    return new Set(items.length ? items : [1, 2, 3, 4, 5]);
  }

  function normalizeWorkWindowsDetailed(value, fallback = DEFAULT_WORK_WINDOWS) {
    const raw = Array.isArray(value) ? value : String(value || fallback).split(/\r?\n|,/);
    const windows = raw
      .map(line => String(line || '').trim())
      .filter(Boolean)
      .map(line => {
        const parts = line.split(/\s*[-~]\s*/);
        if (parts.length !== 2) return null;
        const start = parseMinuteOfDay(parts[0]);
        const end = parseMinuteOfDay(parts[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
        return {
          start,
          end,
          label: `${parts[0]}-${parts[1]}`
        };
      })
      .filter(Boolean);
    return windows.length ? windows : [
      { start: parseMinuteOfDay('09:00'), end: parseMinuteOfDay('12:00'), label: '09:00-12:00' },
      { start: parseMinuteOfDay('13:30'), end: parseMinuteOfDay('18:00'), label: '13:30-18:00' }
    ];
  }

  function weekdayNumber(date = new Date()) {
    const utcDay = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })).getDay();
    return utcDay === 0 ? 7 : utcDay;
  }

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

  function isInWorkSchedule(workdays, workWindows, date = new Date()) {
    if (!(workdays instanceof Set) || !Array.isArray(workWindows)) return false;
    if (!workdays.has(weekdayNumber(date))) return false;
    const minute = beijingMinutesNow(date);
    return workWindows.some(win => minute >= win.start && minute < win.end);
  }

  globalThis.AblesciWatcherWorktime = {
    DEFAULT_WORKDAYS,
    DEFAULT_WORK_WINDOWS,
    parseMinuteOfDay,
    minutesOfDay,
    normalizeWorkdaysSet,
    normalizeWorkWindowsDetailed,
    weekdayNumber,
    beijingMinutesNow,
    isInWorkSchedule
  };
})();
