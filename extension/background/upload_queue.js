'use strict';

// Serial upload task queue and port lifecycle handling.
(function initBackgroundUploadQueue(globalThis) {
  function createBackgroundUploadQueueApi(deps = {}) {
    const {
      // PRIVATE_WATCHER_ONLY
      pendingPublisherTabs,
      defaultOptions,
      htmlDownloadMessage,
      getOptions,
      post,
      cleanupOrphanPublisherTabs,
      clearUploadTaskSnapshot,
      saveUploadTaskSnapshot,
      handleUpload,
      classifyJournalAccessFailureReason,
      isDoiUrl,
      isLikelyRscPayload,
      pauseWatcherForAccessEnvironment,
      saveErrorDiagnostic,
      isNonPdfAccessPageError,
      escapeHtml,
      formatTaskError,
      isExpectedTimeoutFailure,
      formatTimeoutDoneMessage,
      recordManualWatcherDaily
    } = deps;

    let taskQueue = [];
    let activeTask = null;
    let nextTaskId = 1;

    // PRIVATE_WATCHER_ONLY
    function hasSeenPublisherChallengeForTask(payload) {
      if (!payload?.assistId || !pendingPublisherTabs) return false;
      const targetId = String(payload.assistId).trim();
      for (const pending of pendingPublisherTabs.values()) {
        if (pending && String(pending.payloadSummary?.assistId).trim() === targetId) {
          if (pending.publisherChallengeSeen) return true;
        }
      }
      return false;
    }

    function uploadLabel(payload) {
      const id = payload?.assistId || '';
      const doi = payload?.doi || '';
      const title = payload?.suggestedFilename || '';
      return [id, doi || title].filter(Boolean).join(' / ') || '当前任务';
    }

    function removeQueuedTask(task) {
      const idx = taskQueue.indexOf(task);
      if (idx >= 0) taskQueue.splice(idx, 1);
    }

    function cancelTask(task, reason, options = {}) {
      if (!task || task.cancelled) return;
      task.cancelled = true;
      task.cancelReason = reason || '任务已取消';
      task.silentCancel = options.silent === true;
      removeQueuedTask(task);
      clearUploadTaskSnapshot(task).catch(() => {});
      if (activeTask === task && task.abortController) {
        try { task.abortController.abort(task.cancelReason); } catch (_) {}
      }
      cleanupOrphanPublisherTabs('task_cancelled').catch(() => {});
    }

    function processQueue() {
      if (activeTask) return;
      while (taskQueue.length && taskQueue[0].cancelled) taskQueue.shift();
      const task = taskQueue.shift();
      if (!task) return;

      activeTask = task;
      const { port, payload, label, abortController } = task;

      (async () => {
        post(port, 'progress', `开始处理任务：${label}`);
        task.startedAt = task.startedAt || new Date().toISOString();
        await saveUploadTaskSnapshot(task, 'running').catch(() => {});
        let opts = null;
        let taskTimer = null;
        try {
          opts = await getOptions();
          const taskTimeoutMs = Math.max(1000, Number(opts.watcherTaskTimeoutMinutes || defaultOptions.watcherTaskTimeoutMinutes) * 60 * 1000);
          taskTimer = setTimeout(() => {
            cancelTask(task, `任务总超时：${label} 已超过 ${opts.watcherTaskTimeoutMinutes} 分钟`, { silent: false });
          }, taskTimeoutMs);
          await handleUpload(port, payload, abortController.signal, opts);
        } catch (err) {
          const errorMsg = formatTaskError(err);
          const isAssistClosed = /求助状态出错|只有求助中才可以上传/.test(errorMsg);
          let failureReason = isAssistClosed ? 'assist_closed' : classifyJournalAccessFailureReason(err);
          if (failureReason === 'download_not_triggered_timeout' && isDoiUrl(payload?.pdfUrl) && isLikelyRscPayload(payload)) {
            failureReason = 'doi_resolution_failed';
          }
          // PRIVATE_WATCHER_ONLY
          if ((failureReason === 'download_not_triggered_timeout' || failureReason === 'task_timeout' || !failureReason) &&
              hasSeenPublisherChallengeForTask(payload)) {
            failureReason = 'cf_challenge';
          }
          let accessEnvironmentPause = null;
          if (failureReason === 'no_access' || failureReason === 'explicit_no_subscription') {
            accessEnvironmentPause = await pauseWatcherForAccessEnvironment(payload);
          }
          const normalSkipReasons = new Set(['publisher_unsupported', 'no_access', 'explicit_no_subscription', 'empty_pdf_file', 'assist_closed', 'tab_drag_locked']);
          if (!normalSkipReasons.has(failureReason) && port.name === 'ablesci-pdf-upload' && typeof recordManualWatcherDaily === 'function') {
            await recordManualWatcherDaily('failed').catch(() => {});
          }

          if (!task.cancelled || !task.silentCancel) {
            if (!normalSkipReasons.has(failureReason)) {
              await saveErrorDiagnostic(payload, err);
            }
            const cleanerExtra = err?.pdfCleanerResult ? { pdfCleanerResult: err.pdfCleanerResult } : {};
            if (failureReason === 'publisher_unsupported') {
              const message = formatTaskError(err) || '当前出版商页面类型不支持，已按正常情况跳过本次任务。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipped: true,
                skipReason: 'publisher_unsupported',
                ...cleanerExtra
              });
            } else if (isNonPdfAccessPageError(err)) {
              post(port, 'done', htmlDownloadMessage, {
                html: escapeHtml(htmlDownloadMessage),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                ...cleanerExtra
              });
            } else if (failureReason === 'login_required') {
              const message = 'ScienceDirect 需要登录或机构访问后才能继续。插件已保留这次为登录阻塞，不计入无权限期刊；完成登录后可重新触发。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'login_required',
                ...cleanerExtra
              });
            } else if (failureReason === 'cf_challenge') {
              const message = /暂停低频值守/.test(formatTaskError(err))
                ? formatTaskError(err)
                : '检测到出版商验证页，已中断本次任务并计入验证次数；达到阈值后会自动暂停低频值守。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'cf_challenge',
                ...cleanerExtra
              });
            } else if (failureReason === 'no_access' || failureReason === 'explicit_no_subscription') {
              const message = accessEnvironmentPause?.paused
                ? accessEnvironmentPause.message
                : '当前出版商无正文订阅权限，任务已跳过。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: failureReason,
                ...cleanerExtra
              });
            } else if (failureReason === 'doi_not_found' || failureReason === 'doi_resolution_failed') {
              const message = 'DOI 解析失败或不存在，已跳过本次任务。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: failureReason,
                ...cleanerExtra
              });
            } else if (failureReason === 'empty_pdf_file') {
              const message = '下载到了空 PDF 文件（大小为 0B），已按正常情况跳过本次任务。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'empty_pdf_file',
                ...cleanerExtra
              });
            } else if (isExpectedTimeoutFailure(failureReason)) {
              const message = formatTimeoutDoneMessage(err, failureReason);
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                timeout: true,
                timeoutReason: failureReason,
                ...cleanerExtra
              });
            } else if (failureReason === 'assist_closed') {
              const message = '该求助状态已改变（可能已被他人应助或已关闭），本次应助已取消。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'assist_closed',
                ...cleanerExtra
              });
            } else if (failureReason === 'tab_drag_locked') {
              const message = '由于您正在拖拽浏览器标签页，插件暂时无法操作该标签页，已跳过本次任务。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'tab_drag_locked',
                ...cleanerExtra
              });
            } else {
              console.error(
                `[Ablesci PDF Watcher Error] ${formatTaskError(err)}\n求助链接: ${payload?.pageUrl || '未知'}\nDOI: ${payload?.doi || '未知'}`,
                err
              );
              post(port, 'error', formatTaskError(err), cleanerExtra);
            }
          }
        } finally {
          if (taskTimer) clearTimeout(taskTimer);
          await clearUploadTaskSnapshot(task);
          if (activeTask === task) activeTask = null;
          cleanupOrphanPublisherTabs('task_finished').catch(() => {});
          processQueue();
        }
      })();
    }

    function enqueueUpload(port, payload) {
      const label = uploadLabel(payload);
      const task = {
        id: nextTaskId++,
        port,
        payload,
        label,
        startedAt: new Date().toISOString(),
        cancelled: false,
        cancelReason: '',
        abortController: new AbortController()
      };

      const hadActiveOrQueued = !!activeTask || taskQueue.length > 0;
      if (hadActiveOrQueued) {
        post(port, 'progress', '已排队：等待当前 PDF 任务完成；关闭本页可取消。');
      }

      port.onDisconnect.addListener(() => {
        cancelTask(task, `Ablesci 页面已关闭或刷新，取消任务：${label}`, { silent: true });
        processQueue();
      });

      taskQueue.push(task);
      processQueue();
    }

    return {
      enqueueUpload,
      processQueue,
      cancelTask,
      hasActiveTask() {
        return !!activeTask || taskQueue.length > 0;
      }
    };
  }

  globalThis.AblesciBackgroundUploadQueue = {
    createBackgroundUploadQueueApi
  };
})(globalThis);
