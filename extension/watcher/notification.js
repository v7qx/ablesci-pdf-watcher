// Responsibility: watcher attention notifications, CF challenge pause flow, and risk budget accounting.
(function () {
  function createWatcherNotificationApi(config) {
    const {
      chromeApi,
      deps,
      clampNumber,
      todayKey,
      getWatcherState,
      saveWatcherState,
      incrementDaily,
      appendWatcherLog,
      normalizeText,
      nextRiskResumeAt,
      appendWatcherTrace,
      nativeNotifyTimeoutMs
    } = config;

    let creatingOffscreenDocument = null;

    async function ensureOffscreenAudioDocument() {
      if (!chromeApi.offscreen?.createDocument || !chromeApi.runtime?.getContexts) return false;
      const offscreenUrl = chromeApi.runtime.getURL('offscreen_audio.html');
      const contexts = await chromeApi.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [offscreenUrl]
      });
      if (Array.isArray(contexts) && contexts.length) return true;
      if (!creatingOffscreenDocument) {
        creatingOffscreenDocument = chromeApi.offscreen.createDocument({
          url: 'offscreen_audio.html',
          reasons: ['AUDIO_PLAYBACK'],
          justification: 'Play watcher notification sounds without relying on native helper.'
        }).finally(() => {
          creatingOffscreenDocument = null;
        });
      }
      await creatingOffscreenDocument;
      return true;
    }

    async function playBrowserNotificationSound(kind = 'default') {
      try {
        const ok = await ensureOffscreenAudioDocument();
        if (!ok) return { ok: false, reason: 'offscreen_unavailable' };
        const response = await chromeApi.runtime.sendMessage({
          type: 'ablesciPlayNotificationSound',
          kind
        });
        return response?.ok ? { ok: true } : { ok: false, reason: response?.reason || 'sound_failed' };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
      }
    }

    async function sendBrowserNotification(message, opts = {}) {
      await chromeApi.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Ablesci PDF Watcher',
        message,
        priority: opts.priority || 1,
        requireInteraction: opts.requireInteraction === true
      });
      if (opts.playSound !== false) {
        await playBrowserNotificationSound(opts.soundKind === 'urgent' ? 'urgent' : 'default');
      }
      return { ok: true, mode: 'browser' };
    }

    async function notifyWatcherNeedsAttention(reason, url, notifyOptions = {}) {
      const message = normalizeText(reason || '低频值守需要人工处理。').slice(0, 160);
      const opts = await deps.getOptions();
      if (!opts.watcherNotificationEnabled) {
        if (url) console.warn('[Ablesci Auto Watcher] notification disabled, skip:', message, deps.urlHostPath(url));
        return { ok: false, mode: 'disabled', reason: 'notification_disabled' };
      }
      if (opts.watcherNotifyMode === 'native') {
        try {
          await deps.sendNativeMessage(opts.nativeHostName, {
            action: 'notify_user',
            title: 'Ablesci PDF Watcher',
            message
          }, nativeNotifyTimeoutMs);
          if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
          return { ok: true, mode: 'native' };
        } catch (err) {
          console.warn('[Ablesci Auto Watcher] native notify failed', err);
          try {
            const fallback = await sendBrowserNotification(message, notifyOptions);
            if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
            return {
              ok: true,
              mode: 'browser',
              fallbackFrom: 'native',
              reason: err?.message || String(err),
              fallback
            };
          } catch (browserErr) {
            if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
            return { ok: false, mode: 'native', reason: err?.message || String(err), fallbackReason: browserErr?.message || String(browserErr) };
          }
        }
      }
      try {
        await sendBrowserNotification(message, notifyOptions);
        if (url) console.warn('[Ablesci Auto Watcher] needs attention:', message, deps.urlHostPath(url));
        return { ok: true, mode: 'browser' };
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] browser notification failed', err);
        return { ok: false, mode: 'browser', reason: err?.message || String(err) };
      }
    }

    async function notifyCfChallengeTelegram(opts, listUrl, streak, paused) {
      if (!opts.watcherTelegramNotifyEnabled || !deps.sendNativeMessage) return { ok: false, reason: 'telegram_disabled' };
      const title = paused ? 'Ablesci 值守已因验证暂停' : 'Ablesci 值守遇到验证';
      const hostPath = deps.urlHostPath(listUrl || '');
      const message = [
        'CF / challenge detected',
        `streak: ${streak}`,
        `paused: ${paused ? 'yes' : 'no'}`,
        `url: ${hostPath?.host || ''}${hostPath?.path || ''}`
      ].join('\n');
      try {
        return await deps.sendNativeMessage(opts.nativeHostName, {
          action: 'send_telegram',
          config_path: opts.watcherTelegramConfigPath || '',
          title,
          message
        }, nativeNotifyTimeoutMs);
      } catch (err) {
        console.warn('[Ablesci Auto Watcher] telegram notify failed', err);
        return { ok: false, reason: err?.message || String(err) };
      }
    }

    async function resetCfChallengeStreak() {
      const state = await getWatcherState();
      if (!state.cfChallengeStreak && !state.pausedByCfChallenge) return;
      state.cfChallengeStreak = 0;
      state.pausedByCfChallenge = false;
      await saveWatcherState(state);
    }

    function riskSnapshot(state, opts) {
      const daily = state.daily?.[todayKey()] || {};
      const used = Number(daily.riskUsed || 0);
      const limit = clampNumber(opts.watcherRiskBudgetLimit, 10, 1, 100);
      return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
        ratio: used / Math.max(1, limit),
        exhausted: used >= limit,
        nearLimit: used >= limit * 0.75
      };
    }

    function riskCostFor(reason, status = '') {
      const text = `${reason || ''} ${status || ''}`;
      if (/cf|challenge/i.test(text)) return 5;
      if (/login|permission|权限|publisher_error_page/i.test(text)) return 3;
      if (/html|not_pdf|PDF 校验失败|file header/i.test(text)) return 2;
      if (/failed|blocked|timeout|interrupted|error/i.test(text)) return 1;
      return 0;
    }

    async function recordRiskEvent(opts, reason, status = '') {
      const cost = riskCostFor(reason, status);
      const state = await getWatcherState();
      const key = todayKey();
      state.daily = state.daily || {};
      state.daily[key] = state.daily[key] || { checked: 0, downloaded: 0, uploaded: 0, skipped: 0, failed: 0, notified: 0 };
      if (cost > 0) {
        state.daily[key].riskUsed = Number(state.daily[key].riskUsed || 0) + cost;
        state.daily[key].consecutiveFailures = Number(state.daily[key].consecutiveFailures || 0) + 1;
        if (state.daily[key].consecutiveFailures >= 3) state.daily[key].riskUsed += 1;
      } else if (/success|queued|download_only|uploaded/i.test(status || reason || '')) {
        state.daily[key].consecutiveFailures = 0;
      }
      const risk = riskSnapshot(state, opts);
      if (opts.watcherAdvancedSchedulerEnabled && risk.exhausted) {
        state.riskPausedUntil = nextRiskResumeAt(opts);
        state.riskPauseReason = 'risk_budget_exhausted';
      }
      await saveWatcherState(state);
      return risk;
    }

    async function recordCfChallenge(opts, listUrl) {
      const state = await getWatcherState();
      const threshold = clampNumber(opts.watcherCfPauseThreshold, 3, 1, 10);
      state.cfChallengeStreak = Number(state.cfChallengeStreak || 0) + 1;
      const reached = opts.watcherAdvancedSchedulerEnabled || state.cfChallengeStreak >= threshold;
      if (reached) {
        state.pausedByCfChallenge = true;
        await chromeApi.storage.local.set({ watcherEnabled: false });
        await chromeApi.alarms.clear('ablesciAutoWatcher');
      }
      await saveWatcherState(state);
      await incrementDaily('failed');
      if (opts.watcherAdvancedSchedulerEnabled) await recordRiskEvent(opts, 'cf_challenge', 'blocked');
      await appendWatcherLog({
        detailUrl: listUrl,
        status: reached ? 'paused' : 'blocked',
        reason: reached ? `cf_challenge_${state.cfChallengeStreak}_paused` : `cf_challenge_${state.cfChallengeStreak}`
      });
      await appendWatcherTrace('cf_challenge_recorded', {
        reason: reached ? 'cf_challenge_paused' : 'cf_challenge',
        streak: state.cfChallengeStreak,
        paused: reached,
        listUrl
      });
      if (reached) {
        await notifyWatcherNeedsAttention(
          `连续 ${state.cfChallengeStreak} 次遇到 Ablesci 验证页，已暂停低频值守。手动处理后请重新开启。`,
          listUrl,
          { requireInteraction: true, soundKind: 'urgent', priority: 2 }
        );
        await incrementDaily('notified');
      }
      const tg = await notifyCfChallengeTelegram(opts, listUrl, state.cfChallengeStreak, reached);
      if (tg?.ok) {
        await appendWatcherLog({
          detailUrl: listUrl,
          status: 'notified',
          reason: reached ? 'telegram_cf_paused' : 'telegram_cf_challenge'
        });
      }
      return reached;
    }

    return {
      notifyWatcherNeedsAttention,
      notifyCfChallengeTelegram,
      resetCfChallengeStreak,
      riskSnapshot,
      riskCostFor,
      recordRiskEvent,
      recordCfChallenge
    };
  }

  globalThis.AblesciWatcherNotificationModule = {
    createWatcherNotificationApi
  };
})();
