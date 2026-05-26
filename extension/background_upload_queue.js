'use strict';

// Serial upload task queue and port lifecycle handling.
(function initBackgroundUploadQueue(globalThis) {
  function createBackgroundUploadQueueApi(deps = {}) {
    const {
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
      recordJournalAccessResult,
      saveErrorDiagnostic,
      isNonPdfAccessPageError,
      escapeHtml,
      formatTaskError,
      isExpectedTimeoutFailure,
      formatTimeoutDoneMessage
    } = deps;

    let taskQueue = [];
    let activeTask = null;
    let nextTaskId = 1;

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
          let failureReason = classifyJournalAccessFailureReason(err);
          if (failureReason === 'download_not_triggered_timeout' && isDoiUrl(payload?.pdfUrl) && isLikelyRscPayload(payload)) {
            failureReason = 'doi_resolution_failed';
          }
          let accessEnvironmentPause = null;
          if (failureReason === 'no_access' || failureReason === 'explicit_no_subscription') {
            accessEnvironmentPause = await pauseWatcherForAccessEnvironment(payload);
          }
          if (failureReason && failureReason !== 'login_required' && failureReason !== 'cf_challenge') {
            await recordJournalAccessResult(payload, { ok: false, reason: failureReason });
          }

          if (!task.cancelled || !task.silentCancel) {
            await saveErrorDiagnostic(payload, err);
            if (isNonPdfAccessPageError(err)) {
              post(port, 'done', htmlDownloadMessage, {
                html: escapeHtml(htmlDownloadMessage),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true
              });
            } else if (failureReason === 'login_required') {
              const message = 'ScienceDirect 需要登录或机构访问后才能继续。插件已保留这次为登录阻塞，不计入无权限期刊；完成登录后可重新触发。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'login_required'
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
                skipReason: 'cf_challenge'
              });
            } else if (failureReason === 'no_access' || failureReason === 'explicit_no_subscription') {
              const message = accessEnvironmentPause?.paused
                ? accessEnvironmentPause.message
                : '当前出版商页面显示无正文订阅权限，已跳过本次任务并记录期刊权限状态。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: 'no_access'
              });
            } else if (failureReason === 'doi_not_found' || failureReason === 'doi_resolution_failed') {
              const message = 'DOI 解析失败或不存在，已跳过本次任务。';
              post(port, 'done', message, {
                html: escapeHtml(message),
                recomend: false,
                reload: false,
                downloadOnly: true,
                blocked: true,
                skipReason: failureReason
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
                timeoutReason: failureReason
              });
            } else {
              console.error('[Ablesci PDF Uploader Error]', err);
              post(port, 'error', formatTaskError(err));
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
