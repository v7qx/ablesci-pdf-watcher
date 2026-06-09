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
      extractScienceDirectPii,
      cleanupOrphanPublisherTabs,
      post,
      downloadPdf,
      pauseWatcherForAccessEnvironment,
      recordAccessEnvironmentSuccess,
      clearPublisherCfChallengeState,
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

    function pdfCleanerResultFromResponse(cleanRes, overrides = {}) {
      const result = {
        enabled: true,
        status: String(cleanRes?.clean_status || overrides.status || 'unknown'),
        matched: Number(cleanRes?.clean_matched || 0),
        rules: Array.isArray(cleanRes?.clean_rules) ? cleanRes.clean_rules.slice(0, 20) : [],
        engine: String(cleanRes?.clean_engine || ''),
        elapsedMs: Number(cleanRes?.clean_elapsed_ms || 0),
        errorCode: String(cleanRes?.clean_error_code || ''),
        error: String(cleanRes?.error || overrides.error || ''),
        outputPath: String(cleanRes?.path || ''),
        originalPath: String(overrides.originalPath || ''),
        preservedOriginalPath: String(overrides.preservedOriginalPath || (cleanRes?.clean_backup_created ? cleanRes?.clean_backup_path : '') || ''),
        preservedCleanedPath: String(overrides.preservedCleanedPath || '')
      };
      if (overrides.status) result.status = String(overrides.status);
      if (overrides.error) result.error = String(overrides.error);
      return result;
    }

    function pdfCleanerSummaryText(result) {
      if (!result || !result.enabled) return '';
      const engine = result.engine ? `，引擎 ${result.engine}` : '';
      const elapsed = result.elapsedMs ? `，耗时 ${result.elapsedMs}ms` : '';
      const preserved = result.preservedOriginalPath ? '；已保留 *.original.pdf' : '';
      const preservedCleaned = result.preservedCleanedPath ? '；已保留 *.cleaned.pdf' : '';
      if (result.status === 'cleaned') {
        return `去水印：已去除 ${Number(result.matched || 0)} 处${engine}${elapsed}${preserved}${preservedCleaned}`;
      }
      if (result.status === 'no_watermark') {
        return `去水印：未检测到匹配水印${engine}${elapsed}${preserved}`;
      }
      if (result.status === 'skipped') {
        return `去水印：已跳过${result.error ? `（${result.error}）` : ''}${preserved}`;
      }
      return `去水印：失败或异常（状态 ${result.status || 'unknown'}${result.error ? `：${result.error}` : ''}）${preserved}`;
    }

    function pdfCleanerSummaryHtml(result) {
      const text = pdfCleanerSummaryText(result);
      return text ? `<span class="ablesci-cleaner-summary">${escapeHtml(text)}</span>` : '';
    }

    function doneExtraForCleaner(result) {
      const text = pdfCleanerSummaryText(result);
      return result ? {
        pdfCleanerResult: result,
        pdfCleanerSummary: text,
        pdfCleanerHtml: pdfCleanerSummaryHtml(result)
      } : {};
    }

    function dirnameOf(path) {
      const value = String(path || '');
      const idx = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
      return idx > 0 ? value.slice(0, idx) : '';
    }

    function truncateFilename(filename, maxLen = 30) {
      const str = String(filename || '');
      if (str.length <= maxLen) return str;
      const extIdx = str.lastIndexOf('.');
      const ext = extIdx > 0 ? str.slice(extIdx) : '';
      const base = extIdx > 0 ? str.slice(0, extIdx) : str;
      if (base.length <= maxLen - ext.length) return str;
      const avail = maxLen - ext.length - 3;
      if (avail <= 0) return '...' + ext;
      const prefixLen = Math.floor(avail * 0.6);
      const suffixLen = avail - prefixLen;
      return base.slice(0, prefixLen) + '...' + base.slice(base.length - suffixLen) + ext;
    }

    function downloadOnlyDone(port, reasons, stat, pdfCleanerResult = null, pii = '') {
      const reasonText = Array.isArray(reasons) && reasons.length ? reasons.join('；') : '当前任务需要人工核对';
      const cleanerHtml = pdfCleanerSummaryHtml(pdfCleanerResult);
      post(port, 'done', `已仅下载并校验 PDF，未自动上传。${reasonText}`, {
        html: `已仅下载并校验 PDF，未自动上传。<br>原因：${escapeHtml(reasonText)}<br>文件：${escapeHtml(stat?.filename || 'paper.pdf')}${cleanerHtml ? `<br>${cleanerHtml}` : ''}`,
        recomend: false,
        reload: false,
        downloadOnly: true,
        filename: stat?.filename,
        md5: stat?.md5,
        size: stat?.size,
        pii,
        ...doneExtraForCleaner(pdfCleanerResult)
      });
    }

    function debugDownloadOnlyDone(port, stat, pdfCleanerResult = null, pii = '') {
      const name = stat?.filename || basenameOf(stat?.path || '') || 'paper.pdf';
      const truncatedName = truncateFilename(name, 35);
      const cleanerText = pdfCleanerSummaryText(pdfCleanerResult);
      const message = `调试模式已开启，未自动上传。准备上传文件：${truncatedName}${cleanerText ? `；${cleanerText}` : ''}`;
      post(port, 'done', message, {
        html: escapeHtml(message),
        recomend: false,
        reload: false,
        downloadOnly: true,
        debugOnly: true,
        filename: stat?.filename,
        md5: stat?.md5,
        size: stat?.size,
        pii,
        ...doneExtraForCleaner(pdfCleanerResult)
      });
    }

    async function handleUpload(port, payload, signal = null, optsOverride = null) {
      throwIfAborted(signal);
      const opts = optsOverride || await getOptions();
      const diag = makeDiagnosticBase(payload, opts);

      // 1. 校验 Corrigendum 更正类求助
      if (opts.watcherSkipCorrigendum && payload?.title && /^Corrigendum\s+to/i.test(String(payload.title).trim())) {
        await saveDiagnostic({ ...diag, stage: 'skipped-corrigendum', error: '已按设置跳过 Corrigendum 更正类求助' });
        post(port, 'done', '已跳过 Corrigendum 更正类求助', {
          html: '已按设置跳过 Corrigendum 更正类求助。',
          recomend: false,
          reload: false,
          downloadOnly: true,
          blocked: true,
          skipped: true,
          skipReason: 'corrigendum',
          message: '已按设置跳过 Corrigendum 更正类求助'
        });
        return;
      }

      // 2. 校验求助人黑名单 (异步读取本地黑名单文件)
      if (opts.watcherEnableBlacklist && payload?.requesterId) {
        let isBlacklisted = false;
        let blacklistComment = '';
        try {
          const res = await sendNativeMessage(opts.nativeHostName, {
            action: 'read_text_file',
            path: opts.watcherBlacklistPath || ''
          }, nativeMessageLongTimeoutMs);
          if (res && res.ok && res.body) {
            const blacklistMap = new Map();
            const lines = res.body.split(/\r?\n/);
            for (let line of lines) {
              line = line.trim();
              if (!line || line.startsWith('#') || line.startsWith('//')) {
                continue;
              }
              const commentIdx = line.indexOf('#') >= 0 ? line.indexOf('#') : (line.indexOf('//') >= 0 ? line.indexOf('//') : -1);
              let comment = '';
              if (commentIdx >= 0) {
                comment = line.substring(commentIdx + 1).trim();
                if (comment.startsWith('/') || comment.startsWith('#')) {
                  comment = comment.replace(/^[\/#\s]+/, '').trim();
                }
                line = line.substring(0, commentIdx).trim();
              }
              const parts = line.split(/[\s,，]+/).map(p => p.trim()).filter(Boolean);
              for (const part of parts) {
                blacklistMap.set(part, comment);
              }
            }
            if (blacklistMap.has(payload.requesterId)) {
              isBlacklisted = true;
              blacklistComment = blacklistMap.get(payload.requesterId) || '';
            }
          }
        } catch (err) {
          await saveDiagnostic({ ...diag, stage: 'blacklist-read-error-ignored', error: `读取本地黑名单文件失败，已跳过本次黑名单检查: ${err.message || err}` });
          post(port, 'progress', `读取本地黑名单文件失败，已跳过本次黑名单检查并继续应助：${err.message || err}`);
        }

        if (isBlacklisted) {
          const blockMsg = blacklistComment ? `求助人已被列入黑名单，拒绝应助。备注: ${blacklistComment}` : '求助人已被列入黑名单，拒绝应助。';
          await saveDiagnostic({ ...diag, stage: 'skipped-blacklist', error: blockMsg });
          let htmlMsg = `当前求助人（ID: ${escapeHtml(payload.requesterId)}）已被列入本地黑名单，拒绝下载和上传。`;
          if (blacklistComment) {
            htmlMsg += `<br><span style="color: #e6a23c; font-size: 0.95em;"><strong>拉黑备注：</strong>${escapeHtml(blacklistComment)}</span>`;
          }
          post(port, 'done', '已跳过黑名单求助人', {
            html: htmlMsg,
            recomend: false,
            reload: false,
            downloadOnly: true,
            blocked: true,
            skipped: true,
            skipReason: 'blacklist',
            message: `求助人 ID (${payload.requesterId}) 在本地黑名单中，任务已安全终止。${blacklistComment ? '备注: ' + blacklistComment : ''}`
          });
          return;
        }
      }

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

      let pii = '';
      if (extractScienceDirectPii) {
        pii = extractScienceDirectPii(payload.pdfUrl || payload.pageUrl || item.url || item.finalUrl || '');
      }

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
          path: item.filename
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

      let pdfCleanerResult = null;
      if (opts.pdfCleanerEnabled) {
        const originalPdfPath = stat.path || item.filename || '';
        const shouldPreserveCleanerOriginal = opts.pdfCleanerPreserveOriginal === true || opts.debugDownloadOnly === true;
        post(port, 'progress', '正在对 PDF 进行去水印处理...');
        try {
          const cleanRes = await sendNativeMessage(opts.nativeHostName, {
            action: 'clean_pdf',
            path: stat.path || item.filename,
            extra: {
              cleaner_path: opts.pdfCleanerCliPath || '',
              patterns_path: opts.pdfCleanerPatternsPath || '',
              engine: opts.pdfCleanerEngine || 'auto',
              timeout_seconds: String(opts.pdfCleanerTimeoutSeconds || 60),
              preserve_original: String(shouldPreserveCleanerOriginal)
            }
          }, nativeMessageLongTimeoutMs);

          if (cleanRes && cleanRes.ok) {
            pdfCleanerResult = pdfCleanerResultFromResponse(cleanRes, {
              originalPath: originalPdfPath
            });
            if (cleanRes.clean_status === 'cleaned') {
              post(port, 'progress', `${pdfCleanerSummaryText(pdfCleanerResult)}。`);
              post(port, 'progress', '正在重新校验去水印后的 PDF 并计算 MD5...');
              stat = await sendNativeMessage(opts.nativeHostName, {
                action: 'stat_pdf',
                path: cleanRes.path || stat.path || item.filename
              }, nativeMessageLongTimeoutMs);
            } else if (cleanRes.clean_status === 'no_watermark') {
              post(port, 'progress', `${pdfCleanerSummaryText(pdfCleanerResult)}。`);
            } else {
              const cleanerErr = cleanRes.error || '未知去水印状态或错误';
              if (opts.pdfCleanerOnError === 'stop_upload') {
                const stopErr = new Error(`去水印未成功（状态: ${cleanRes.clean_status}）：${cleanerErr}`);
                stopErr.pdfCleanerResult = pdfCleanerResult;
                throw stopErr;
              } else {
                post(port, 'progress', `去水印未成功（状态: ${cleanRes.clean_status}）：${cleanerErr}。按配置继续使用原始 PDF 进行上传。`);
              }
            }
          } else {
            throw new Error((cleanRes && cleanRes.error) || '去水印助手返回异常');
          }
        } catch (err) {
          console.error('[pdf-cleaner] error:', err);
          pdfCleanerResult = pdfCleanerResult || pdfCleanerResultFromResponse(null, {
            status: 'error',
            error: err.message || String(err),
            originalPath: originalPdfPath
          });
          if (opts.pdfCleanerOnError === 'stop_upload') {
            const stopErr = new Error(`去水印失败，已终止上传：${err.message || err}`);
            stopErr.pdfCleanerResult = pdfCleanerResult;
            throw stopErr;
          } else {
            post(port, 'progress', `去水印出错：${err.message || err}。按配置继续使用原始 PDF 进行上传。`);
          }
        }
      }
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
          pdfCleanerResult,
          message: 'debug mode: download and validate only; upload-request and OSS upload skipped'
        });
        post(port, 'progress', `调试模式：准备上传文件 ${stat.filename}，${formatBytes(size)}，MD5=${stat.md5}；已跳过自动上传。`);
        debugDownloadOnlyDone(port, stat, pdfCleanerResult, pii);
        return;
      }

      const minAutoUploadBytes = sizeToBytes(opts.minAutoUploadMB, opts.minAutoUploadUnit, defaultOptions.minAutoUploadMB, defaultOptions.minAutoUploadUnit);
      const maxAutoUploadBytes = sizeToBytes(opts.maxAutoUploadMB, opts.maxAutoUploadUnit, defaultOptions.maxAutoUploadMB, defaultOptions.maxAutoUploadUnit);
      if (size > 0 && minAutoUploadBytes > 0 && size < minAutoUploadBytes) {
        downloadOnlyReasons.push(`PDF 文件小于 ${formatConfiguredSize(opts.minAutoUploadMB || defaultOptions.minAutoUploadMB, opts.minAutoUploadUnit || defaultOptions.minAutoUploadUnit)}（当前 ${formatBytes(size)}），已改为仅下载。`);
        await saveDiagnostic({ ...diag, stage: 'download-only-small-file', downloadItem: downloadMeta, fileSize: size });
        downloadOnlyDone(port, downloadOnlyReasons, stat, pdfCleanerResult, pii);
        return;
      }
      if (size > 0 && maxAutoUploadBytes > 0 && size > maxAutoUploadBytes) {
        downloadOnlyReasons.push(`PDF 文件大于 ${formatConfiguredSize(opts.maxAutoUploadMB || defaultOptions.maxAutoUploadMB, opts.maxAutoUploadUnit || defaultOptions.maxAutoUploadUnit)}（当前 ${formatBytes(size)}），超过自动上传范围，已改为仅下载。`);
        await saveDiagnostic({ ...diag, stage: 'download-only-large-file', downloadItem: downloadMeta, fileSize: size });
        downloadOnlyDone(port, downloadOnlyReasons, stat, pdfCleanerResult, pii);
        return;
      }

      if (payload.downloadOnly) {
        await saveDiagnostic({ ...diag, stage: 'download-only-risk', downloadItem: downloadMeta, fileSize: size, reasons: downloadOnlyReasons });
        downloadOnlyDone(port, downloadOnlyReasons.length ? downloadOnlyReasons : ['当前求助需要人工核对'], stat, pdfCleanerResult, pii);
        return;
      }

      const permit = await uploadRequest(payload, stat);
      console.log('[Ablesci PDF Watcher] upload-request code', permit && permit.code);

      if (permit.code === 10) {
        if (opts.deleteAfterUpload) {
          await deleteUploadedFile(opts.nativeHostName, stat.path);
        }
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        if (port.name === 'ablesci-pdf-upload' && typeof recordManualWatcherDaily === 'function') {
          await recordManualWatcherDaily('uploaded').catch(() => {});
        }
        postDoneFromSiteResponse(port, permit, '上传成功', { ...doneExtraForCleaner(pdfCleanerResult), pii });
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
        postDoneFromSiteResponse(port, parsed, '上传成功', { ...doneExtraForCleaner(pdfCleanerResult), pii });
      } else {
        await saveDiagnostic({ ...diag, stage: 'uploaded', downloadItem: downloadMeta, fileSize: size });
        await clearPublisherCfChallengeState();
        await recordAccessEnvironmentSuccess(payload);
        const cleanerExtra = doneExtraForCleaner(pdfCleanerResult);
        const cleanerText = cleanerExtra.pdfCleanerSummary ? `；${cleanerExtra.pdfCleanerSummary}` : '';
        const cleanerHtml = cleanerExtra.pdfCleanerHtml ? `<br>${cleanerExtra.pdfCleanerHtml}` : '';
        post(port, 'done', `OSS 上传完成，请检查 Ablesci 页面状态。${cleanerText}`, {
          html: `OSS 上传完成，请检查 Ablesci 页面状态。${cleanerHtml}`,
          recomend: false,
          reload: true,
          pii,
          ...cleanerExtra
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
