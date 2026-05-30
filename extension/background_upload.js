'use strict';

// Upload/download pipeline and publisher-page runtime listeners.
(function initBackgroundUpload(globalThis) {
  function createBackgroundUploadApi(deps) {
    const {
      chromeApi,
      // PRIVATE_WATCHER_ONLY
      pendingPublisherTabs,
      defaultOptions,
      htmlDownloadMessage,
      nativeMessageLongTimeoutMs,
      getOptions,
      throwIfAborted,
      isDoiUrl,
      cleanupOrphanPublisherTabs,
      post,
      downloadPdf,
      pauseWatcherForAccessEnvironment,
      recordAccessEnvironmentSuccess,
      clearPublisherCfChallengeState,
      recordJournalAccessResult,
      sendNativeMessage,
      formatBytes,
      formatConfiguredSize,
      basenameOf,
      extensionOf,
      sizeToBytes,
      formatTaskError,
      stripHtml,
      escapeHtml,
      makeDiagnosticBase,
      classifyJournalAccessFailureReason,
      isLikelyRscPayload,
      isExpectedTimeoutFailure,
      formatTimeoutDoneMessage,
      sanitizeDownloadItem,
      saveDiagnostic,
      saveErrorDiagnostic,
      isNonPdfAccessPageError,
      isHtmlDownloadItem,
      stopForNonPdfDownload,
      saveUploadTaskSnapshot,
      clearUploadTaskSnapshot,
      createBackgroundUploadQueueApi,
      createBackgroundUploadClientApi,
      handlePublisherTabUpdated,
      handlePublisherRuntimeMessage,
      recordManualWatcherDaily
    } = deps;

    const {
      uploadRequest,
      postDoneFromSiteResponse,
      isAssistStateChangedMessage,
      postAssistStateChangedDone,
      uploadOssViaNative,
      deleteUploadedFile
    } = createBackgroundUploadClientApi({
      nativeMessageLongTimeoutMs,
      post,
      sendNativeMessage,
      stripHtml,
      escapeHtml
    });

    function downloadOnlyDone(port, reasons, stat) {
      const reasonText = Array.isArray(reasons) && reasons.length ? reasons.join('；') : '当前任务需要人工核对';
      post(port, 'done', `已仅下载并校验 PDF，未自动上传。${reasonText}`, {
        html: `已仅下载并校验 PDF，未自动上传。<br>原因：${escapeHtml(reasonText)}<br>文件：${escapeHtml(stat?.filename || 'paper.pdf')}`,
        recomend: false,
        reload: false,
        downloadOnly: true
      });
    }

    function debugDownloadOnlyDone(port, stat) {
      const name = stat?.filename || basenameOf(stat?.path || '') || 'paper.pdf';
      const message = `调试模式已开启，未自动上传。准备上传文件：${name}`;
      post(port, 'done', message, {
        html: escapeHtml(message),
        recomend: false,
        reload: false,
        downloadOnly: true,
        debugOnly: true
      });
    }

    async function handleUpload(port, payload, signal = null, optsOverride = null) {
      throwIfAborted(signal);
      const opts = optsOverride || await getOptions();
      const diag = makeDiagnosticBase(payload, opts);

      if (!payload?.pdfUrl) {
        await saveDiagnostic({ ...diag, stage: 'skipped-missing-pdf-url', error: '缺少 pdfUrl，已按信息不全跳过' });
        post(port, 'done', '当前求助缺少可识别的 PDF 链接，已按信息不全跳过；不会下载或上传。', {
          html: '当前求助缺少可识别的 PDF 链接，已按信息不全跳过；不会下载或上传。',
          recomend: false,
          reload: false,
          downloadOnly: true,
          skipped: true,
          skipReason: 'missing_pdf_url'
        });
        return;
      }
      if (!payload?.assistId) throw new Error('缺少 assistId');
      if (!payload?.csrfToken) throw new Error('缺少 csrfToken');

      if (payload.downloadOnly) {
        const reasons = Array.isArray(payload.riskReasons) && payload.riskReasons.length ? payload.riskReasons.join('；') : '当前求助需要人工核对';
        post(port, 'progress', `当前任务命中仅下载保护：${reasons}；下载完成后不会自动提交。`);
      }

      await saveDiagnostic({ ...diag, stage: 'picked' });
      post(port, 'progress', 'PDF URL：' + payload.pdfUrl);
      const item = await downloadPdf(payload.pdfUrl, payload.suggestedFilename || 'paper.pdf', { ...opts, payloadContext: payload }, port, signal);
      throwIfAborted(signal);
      if (!item.filename) throw new Error('下载完成但没有得到本地文件路径');

      if (port.name === 'ablesci-pdf-upload' && typeof recordManualWatcherDaily === 'function') {
        await recordManualWatcherDaily('downloaded').catch(() => {});
      }

      const downloadMeta = sanitizeDownloadItem(item);
      await saveDiagnostic({ ...diag, stage: 'download-complete', downloadItem: downloadMeta });
      if (isHtmlDownloadItem(item)) {
        await stopForNonPdfDownload(port, diag, item, downloadMeta, 'blocked-html-download', htmlDownloadMessage, opts);
        return;
      }

      post(port, 'progress', '下载完成，调用本地 Helper 校验 PDF 和计算 MD5...');
      throwIfAborted(signal);
      let stat;
      try {
        stat = await sendNativeMessage(opts.nativeHostName, {
          action: 'stat_pdf',
          path: item.filename,
          move_to_dir: opts.moveToDir || ''
        }, nativeMessageLongTimeoutMs);
      } catch (err) {
        if (isNonPdfAccessPageError(err)) {
          await stopForNonPdfDownload(port, diag, item, downloadMeta, 'blocked-non-pdf-download', formatTaskError(err), opts);
          return;
        }
        throw err;
      }

      throwIfAborted(signal);
      if (!opts.keepDownloadHistory) {
        try { await chromeApi.downloads.erase({ id: item.id }); } catch (_) {}
      }
      await saveDiagnostic({
        ...diag,
        stage: 'pdf-validated',
        downloadItem: downloadMeta,
        file: {
          filename: stat.filename || basenameOf(stat.path || ''),
          extension: extensionOf(stat.filename || stat.path || ''),
          size: Number(stat.size || 0)
        }
      });
      post(port, 'progress', `PDF 校验通过：${stat.filename}，${formatBytes(stat.size)}，MD5=${stat.md5}`);
      const downloadOnlyReasons = Array.isArray(payload.riskReasons) && payload.riskReasons.length ? payload.riskReasons.slice() : [];
      const size = Number(stat.size || 0);
      if (opts.debugDownloadOnly) {
        await saveDiagnostic({
          ...diag,
          stage: 'debug-download-only',
          downloadItem: downloadMeta,
          file: {
            filename: stat.filename || basenameOf(stat.path || ''),
            extension: extensionOf(stat.filename || stat.path || ''),
            size,
            md5: stat.md5 || ''
          },
          message: 'debug mode: download and validate only; upload-request and OSS upload skipped'
        });
        post(port, 'progress', `调试模式：准备上传文件 ${stat.filename}，${formatBytes(size)}，MD5=${stat.md5}；已跳过自动上传。`);
        debugDownloadOnlyDone(port, stat);
        return;
      }

      const minAutoUploadBytes = sizeToBytes(opts.minAutoUploadMB, opts.minAutoUploadUnit, defaultOptions.minAutoUploadMB, defaultOptions.minAutoUploadUnit);
      const maxAutoUploadBytes = sizeToBytes(opts.maxAutoUploadMB, opts.maxAutoUploadUnit, defaultOptions.maxAutoUploadMB, defaultOptions.maxAutoUploadUnit);
      if (size > 0 && minAutoUploadBytes > 0 && size < minAutoUploadBytes) {
        downloadOnlyReasons.push(`PDF 文件小于 ${formatConfiguredSize(opts.minAutoUploadMB || defaultOptions.minAutoUploadMB, opts.minAutoUploadUnit || defaultOptions.minAutoUploadUnit)}（当前 ${formatBytes(size)}），已改为仅下载。`);
        await saveDiagnostic({ ...diag, stage: 'download-only-small-file', downloadItem: downloadMeta, fileSize: size });
        downloadOnlyDone(port, downloadOnlyReasons, stat);
        return;
      }
      if (size > 0 && maxAutoUploadBytes > 0 && size > maxAutoUploadBytes) {
        downloadOnlyReasons.push(`PDF 文件大于 ${formatConfiguredSize(opts.maxAutoUploadMB || defaultOptions.maxAutoUploadMB, opts.maxAutoUploadUnit || defaultOptions.maxAutoUploadUnit)}（当前 ${formatBytes(size)}），超过自动上传范围，已改为仅下载。`);
        await saveDiagnostic({ ...diag, stage: 'download-only-large-file', downloadItem: downloadMeta, fileSize: size });
        downloadOnlyDone(port, downloadOnlyReasons, stat);
        return;
      }

      if (payload.downloadOnly) {
        await saveDiagnostic({ ...diag, stage: 'download-only-risk', downloadItem: downloadMeta, fileSize: size, reasons: downloadOnlyReasons });
        downloadOnlyDone(port, downloadOnlyReasons.length ? downloadOnlyReasons : ['当前求助需要人工核对'], stat);
        return;
      }

      const permit = await uploadRequest(payload, stat);
      console.log('[Ablesci PDF Uploader] upload-request code', permit && permit.code);

      if (permit.code === 10) {
        if (opts.deleteAfterUpload) {
          await deleteUploadedFile(opts.nativeHostName, stat.path);
        }
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        await recordJournalAccessResult(payload, { ok: true });
        if (port.name === 'ablesci-pdf-upload' && typeof recordManualWatcherDaily === 'function') {
          await recordManualWatcherDaily('uploaded').catch(() => {});
        }
        postDoneFromSiteResponse(port, permit, '上传成功');
        return;
      }

      if (permit.code !== 0) {
        if (isAssistStateChangedMessage(permit.msg || '')) {
          await saveDiagnostic({ ...diag, stage: 'assist-state-changed-before-upload', downloadItem: downloadMeta, fileSize: size });
          postAssistStateChangedDone(port, permit.msg || '该求助状态已经发生改变，请刷新页面查看或下载。');
          return;
        }
        throw new Error(stripHtml(permit.msg || 'upload-request 未允许上传'));
      }

      throwIfAborted(signal);
      post(port, 'progress', '开始上传到 OSS...');
      const ossRes = await uploadOssViaNative(opts.nativeHostName, payload, stat, permit, opts);

      let parsed = null;
      try { parsed = JSON.parse(ossRes.body || '{}'); } catch (_) {}
      if (parsed && parsed.code === 1) {
        if (isAssistStateChangedMessage(parsed.msg || '')) {
          await saveDiagnostic({ ...diag, stage: 'assist-state-changed-after-upload', downloadItem: downloadMeta, fileSize: size });
          postAssistStateChangedDone(port, parsed.msg || '该求助状态已经发生改变，请刷新页面查看或下载。');
          return;
        }
        throw new Error(stripHtml(parsed.msg || 'OSS 回调返回上传失败'));
      }
      if (opts.deleteAfterUpload) {
        await deleteUploadedFile(opts.nativeHostName, stat.path);
      }
      if (port.name === 'ablesci-pdf-upload' && typeof recordManualWatcherDaily === 'function') {
        await recordManualWatcherDaily('uploaded').catch(() => {});
      }
      if (parsed && parsed.msg) {
        await saveDiagnostic({ ...diag, stage: 'uploaded', downloadItem: downloadMeta, fileSize: size });
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        await recordJournalAccessResult(payload, { ok: true });
        postDoneFromSiteResponse(port, parsed, '上传成功');
      } else {
        await saveDiagnostic({ ...diag, stage: 'uploaded', downloadItem: downloadMeta, fileSize: size });
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        await recordJournalAccessResult(payload, { ok: true });
        post(port, 'done', 'OSS 上传完成，请检查 Ablesci 页面状态。', {
          html: 'OSS 上传完成，请检查 Ablesci 页面状态。',
          recomend: false,
          reload: true
        });
      }
    }

    const {
      enqueueUpload,
      processQueue,
      cancelTask,
      hasActiveTask
    } = createBackgroundUploadQueueApi({
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
      recordJournalAccessResult,
      saveErrorDiagnostic,
      isNonPdfAccessPageError,
      escapeHtml,
      formatTaskError,
      isExpectedTimeoutFailure,
      formatTimeoutDoneMessage,
      recordManualWatcherDaily
    });

    function attachRuntimeListeners() {
      chromeApi.runtime.onConnect.addListener(port => {
        if (port.name !== 'ablesci-pdf-upload') return;
        port.onMessage.addListener(msg => {
          if (!msg || msg.type !== 'startUpload') return;
          enqueueUpload(port, msg.payload);
        });
      });
      chromeApi.tabs.onUpdated.addListener(handlePublisherTabUpdated);
      chromeApi.runtime.onMessage.addListener(handlePublisherRuntimeMessage);
    }

    return {
      enqueueUpload,
      processQueue,
      cancelTask,
      attachRuntimeListeners,
      hasActiveTask
    };
  }

  globalThis.AblesciBackgroundUpload = { createBackgroundUploadApi };
})(globalThis);
