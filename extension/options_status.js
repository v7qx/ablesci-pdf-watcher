'use strict';

(function () {
  function createOptionsStatusApi(deps = {}) {
    const {
      chromeApi,
      defaultOptions,
      autoWatcherStateKey,
      formatBeijingDateTime,
      countdownText,
      nextDisplaySchedule,
      todayKeyBeijing,
      setText,
      el
    } = deps;

    let advancedStatusCache = null;
    let advancedCountdownTimer = null;
    let cfCookieCache = null;
    let cfCookieCacheAt = 0;
    const cfCookieCacheMs = 30 * 1000;

    function setCookiePill(elementId, text, isError = false, title = '') {
      const cookieEl = el(elementId);
      if (!cookieEl) return;
      cookieEl.textContent = text;
      cookieEl.title = title || text;
      cookieEl.className = `pill${isError ? ' error' : ' ok'}`;
    }

    function updatePillFromCookie(cookie, elementId, missingTitle = '') {
      const cookieEl = el(elementId);
      if (!cookieEl) return;

      if (cookie) {
        const expiryMs = cookie.expirationDate ? cookie.expirationDate * 1000 : 0;
        if (expiryMs > 0) {
          const remainingMs = expiryMs - Date.now();
          if (remainingMs > 0) {
            const remainingMinutes = Math.floor(remainingMs / 60000);
            const expiryDate = new Date(expiryMs);
            const expiryTimeStr = expiryDate.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            cookieEl.textContent = `剩 ${remainingMinutes} 分钟 (${expiryTimeStr})`;
            const partitionInfo = cookie.partitionKey ? `\n分区: ${JSON.stringify(cookie.partitionKey)}` : '';
            cookieEl.title = `域: ${cookie.domain}\n路径: ${cookie.path || '/'}\n失效时间: ${expiryDate.toLocaleString('zh-CN')}${partitionInfo}`;
            cookieEl.className = 'pill ok';
          } else {
            cookieEl.textContent = '已失效 (需验证)';
            cookieEl.title = `域: ${cookie.domain || '-'}\n该 cf_clearance 已过期，请在当前专用浏览器 Profile 中重新完成验证。`;
            cookieEl.className = 'pill error';
          }
        } else {
          cookieEl.textContent = '会话有效';
          cookieEl.title = `域: ${cookie.domain || '-'}\n该 cf_clearance 是会话 Cookie，浏览器关闭后可能失效。`;
          cookieEl.className = 'pill ok';
        }
      } else {
        cookieEl.textContent = '未检测到 (需验证)';
        cookieEl.title = missingTitle || '当前专用浏览器 Profile 中未检测到对应 cf_clearance。请在这个专用浏览器窗口中打开出版商页面并完成验证。';
        cookieEl.className = 'pill error';
      }
    }

    function cookieKey(cookie) {
      return [
        cookie.name || '',
        cookie.domain || '',
        cookie.path || '',
        cookie.storeId || '',
        cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : ''
      ].join('|');
    }

    function newerCookie(a, b) {
      const aExpiry = Number(a?.expirationDate || 0);
      const bExpiry = Number(b?.expirationDate || 0);
      if (!a) return b || null;
      if (!b) return a;
      if (bExpiry === 0 && aExpiry > 0) return b;
      if (bExpiry > aExpiry) return b;
      return a;
    }

    async function queryCookiesSafe(details) {
      try {
        return await chromeApi.cookies.getAll(details);
      } catch (err) {
        console.debug('[Ablesci PDF Watcher] Cookie query skipped:', details, err?.message || err);
        return [];
      }
    }

    async function queryCfClearanceCookies() {
      const targets = [
        'https://www.sciencedirect.com/',
        'https://sciencedirect.com/',
        'https://linkinghub.elsevier.com/',
        'https://www.elsevier.com/',
        'https://elsevier.com/'
      ];
      const topLevelSites = [
        'https://www.sciencedirect.com',
        'https://sciencedirect.com',
        'https://linkinghub.elsevier.com',
        'https://www.elsevier.com',
        'https://elsevier.com'
      ];
      const queries = [{ name: 'cf_clearance' }];
      for (const url of targets) queries.push({ name: 'cf_clearance', url });
      queries.push({ name: 'cf_clearance', partitionKey: {} });
      for (const url of targets) queries.push({ name: 'cf_clearance', url, partitionKey: {} });
      for (const topLevelSite of topLevelSites) {
        queries.push({ name: 'cf_clearance', partitionKey: { topLevelSite } });
        for (const url of targets) queries.push({ name: 'cf_clearance', url, partitionKey: { topLevelSite } });
      }

      const merged = new Map();
      for (const query of queries) {
        const found = await queryCookiesSafe(query);
        for (const cookie of found || []) {
          if (cookie?.name !== 'cf_clearance') continue;
          merged.set(cookieKey(cookie), cookie);
        }
      }
      return Array.from(merged.values());
    }

    async function updateCfCookieCountdown() {
      if (!chromeApi.cookies) {
        const title = '当前扩展上下文没有 chrome.cookies API。请确认 manifest 包含 cookies 权限，并在扩展详情页允许站点访问。';
        setCookiePill('watcherElsevierCookieStatus', '无权限', true, title);
        setCookiePill('watcherSdCookieStatus', '无权限', true, title);
        return;
      }

      try {
        const now = Date.now();
        if (!cfCookieCache || now - cfCookieCacheAt > cfCookieCacheMs) {
          cfCookieCache = await queryCfClearanceCookies();
          cfCookieCacheAt = now;
        }
        const cookies = cfCookieCache;

        let elsevierCookie = null;
        let sdCookie = null;

        for (const c of cookies) {
          const dom = String(c.domain || '').toLowerCase();
          if (dom.includes('elsevier.com')) {
            elsevierCookie = newerCookie(elsevierCookie, c);
          } else if (dom.includes('sciencedirect.com')) {
            sdCookie = newerCookie(sdCookie, c);
          }
        }

        updatePillFromCookie(
          elsevierCookie,
          'watcherElsevierCookieStatus',
          '未在当前专用浏览器 Profile 中检测到 Elsevier / LinkingHub 的 cf_clearance。请在这个 Profile 内打开 linkinghub.elsevier.com 或 Elsevier 文章页并完成验证。'
        );
        updatePillFromCookie(
          sdCookie,
          'watcherSdCookieStatus',
          '未在当前专用浏览器 Profile 中检测到 ScienceDirect 的 cf_clearance。请在这个 Profile 内打开 www.sciencedirect.com 并完成验证。'
        );
      } catch (err) {
        console.warn('[Ablesci PDF Watcher] Failed to query cf_clearance cookies:', err);
        const message = err?.message || String(err);
        const title = `读取 cf_clearance 失败：${message}\n请检查扩展详情页的网站访问权限是否允许 Elsevier / ScienceDirect。`;
        setCookiePill('watcherElsevierCookieStatus', '读取失败', true, title);
        setCookiePill('watcherSdCookieStatus', '读取失败', true, title);
      }
    }

    async function renderAdvancedWatcherStatus() {
      const stored = await chromeApi.storage.local.get([
        autoWatcherStateKey,
        'watcherEnabled',
        'watcherDailyLimit'
      ]);
      const state = stored[autoWatcherStateKey] || {};
      const daily = state.daily?.[todayKeyBeijing()] || {};
      const downloaded = Math.max(0, Number(daily.downloaded || 0));
      const dailyLimit = Math.max(0, Number(stored.watcherDailyLimit || defaultOptions.watcherDailyLimit || 0));
      const schedule = nextDisplaySchedule(state);
      advancedStatusCache = { state, schedule };
      setText('advancedWorkProgress', `${Math.round(Number(state.workTimeProgressRatio || 0) * 100)}%`);
      setText('advancedActiveProgress', `${Math.round(Number(state.activeTimeProgressRatio || state.workTimeProgressRatio || 0) * 100)}%`);
      setText('advancedAvailability', `${Math.round(Number(state.availabilityFactor || 1) * 100)}%`);
      setText('advancedExpectedActual', `${Number(state.actualDone || state.monthDone || 0)} / ${Number(state.expectedDone || 0)}`);
      
      let syncText = '-';
      if (Number.isFinite(state.actualTotalAssists)) {
        syncText = String(state.actualTotalAssists);
      }
      setText('watcherWebTotalAssists', syncText);

      setText('advancedError', String(Number(state.targetError || state.lag || 0)));
      setText('advancedRateMultiplier', Number(state.rateMultiplier || 1).toFixed(3));
      setText('advancedRiskBudget', `${Number(daily.riskUsed || state.riskUsed || 0)} / ${Number(state.riskLimit || 0)}`);
      setText('advancedSessionStatus', state.currentSession?.status || state.lastSession?.status || '-');
      setText('watcherRuntimeLogic', `${state.currentSchedulerMode || '-'} / ${state.currentExecutionModel || '-'}`);
      setText('watcherNextRunAt', formatBeijingDateTime(schedule.nextRunAt));
      setText('watcherNextAssistAt', formatBeijingDateTime(schedule.nextAssistAt));
      setText('watcherAssistCountdown', countdownText(schedule.assistCountdownAt));
      setText('watcherWakeCountdown', dailyLimit > 0 ? String(dailyLimit) : '-');
      const downloadedAuto = Math.max(0, Number(daily.downloadedAuto || 0));
      let downloadedManual = Math.max(0, Number(daily.downloadedManual || 0));
      if (downloaded > 0 && downloadedAuto === 0 && downloadedManual === 0) {
        downloadedManual = downloaded;
      }
      setText('watcherRunCounts', `自动: ${downloadedAuto} / 手动: ${downloadedManual}`);
      await updateCfCookieCountdown();
    }

    function renderAdvancedWatcherCountdowns() {
      if (!advancedStatusCache) return;
      const state = advancedStatusCache.state || {};
      const schedule = advancedStatusCache.schedule || nextDisplaySchedule(state);
      setText('watcherAssistCountdown', countdownText(schedule.assistCountdownAt));
      updateCfCookieCountdown().catch(() => {});
    }

    function startAdvancedCountdownTimer() {
      if (advancedCountdownTimer || document.hidden) return;
      advancedCountdownTimer = setInterval(renderAdvancedWatcherCountdowns, 1000);
    }

    function stopAdvancedCountdownTimer() {
      if (!advancedCountdownTimer) return;
      clearInterval(advancedCountdownTimer);
      advancedCountdownTimer = null;
    }

    return {
      renderAdvancedWatcherStatus,
      renderAdvancedWatcherCountdowns,
      startAdvancedCountdownTimer,
      stopAdvancedCountdownTimer
    };
  }

  globalThis.AblesciOptionsStatus = {
    createOptionsStatusApi
  };
})();
