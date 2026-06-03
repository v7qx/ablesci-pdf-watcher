'use strict';

(function () {
  function createBackgroundDiagnosticsApi(deps = {}) {
    const {
      chromeApi,
      lastDiagnosticKey,
      htmlDownloadMessage,
      maskId,
      redactLocalPaths,
      hostnameOf,
      urlHostPath,
      basenameOf,
      extensionOf,
      getOptions,
      post,
      escapeHtml,
      formatTaskError
    } = deps;

    function makeDiagnosticBase(payload, opts) {
      return {
        time: new Date().toISOString(),
        assistId: maskId(payload?.assistId),
        doi: payload?.doi || '',
        journalName: payload?.journalName || '',
        assistDetailUrl: payload?.pageUrl || '',
        publisherHost: hostnameOf(payload?.pdfUrl || ''),
        pickedUrl: urlHostPath(payload?.pdfUrl || ''),
        source: payload?.pdfUrlSource || '',
        downloadMode: opts?.downloadMode || 'auto'
      };
    }

    function traceSignature(entry = {}) {
      return [
        entry.step || '',
        entry.publisher || '',
        entry.reason || '',
        entry.source || '',
        entry.downloadId || '',
        entry.expectedHost || '',
        entry.sourceUrl || '',
        entry.itemUrl || '',
        entry.finalUrl || '',
        entry.pdfUrl || ''
      ].map(value => String(value || '')).join('|');
    }

    function diagnosticEnabled(opts) {
      return opts?.diagnosticsEnabled === true;
    }

    function classifyJournalAccessFailureReason(err) {
      const raw = String(err?.message || err || '');
      if (!raw) return '';
      if (/任务已取消|Ablesci 页面已关闭或刷新|页面已关闭|已停止等待下载/i.test(raw)) return 'user_cancelled';
      if (raw.includes(htmlDownloadMessage)) return 'html_login_or_error_page';
      if (/file header is not %PDF-|likely html\/login\/error page/i.test(raw)) return 'not_pdf';
      if (/DOI Not Found|doi not found|The DOI you requested|DOI you requested|does not exist|Invalid DOI|DOI 不存在|DOI不存在|找不到\s*DOI|DOI\s*未找到/i.test(raw)) return 'doi_not_found';
      if (/doi\.org/i.test(raw) && /not found|404|invalid|不存在|未找到/i.test(raw)) return 'doi_resolution_failed';
      if (/There was a problem providing the content you requested/i.test(raw)) return 'publisher_error_page';
      if (/publisher.*challenge|出版商.*验证|Cloudflare|Just a moment|captcha|security check/i.test(raw)) return 'cf_challenge';
      if (/明确返回无正文订阅权限|does not subscribe to this content on ScienceDirect/i.test(raw)) return 'explicit_no_subscription';
      if (/ScienceDirect 当前页面没有正文订阅权限|当前页面没有正文订阅权限|页面明确显示无正文访问权限|无正文访问权限|无访问权限/i.test(raw)) return 'no_access';
      if (/等待 ScienceDirect 登录\/机构访问超时|需要登录或机构访问|ScienceDirect 需要登录/i.test(raw)) return 'login_required';
      if (/暂不支持；当前规则只处理 \/article\/ 期刊文献|当前出版商页面类型不支持|Springer .*页面暂不支持|publisher unsupported/i.test(raw)) return 'publisher_unsupported';
      if (/未触发 PDF 下载超时|等待出版商页面触发 PDF 下载超时|后台标签页没有触发 PDF 下载/i.test(raw)) return 'download_not_triggered_timeout';
      if (/下载中超时|下载超时/i.test(raw)) return 'download_timeout';
      if (/任务总超时|单任务最长时间/i.test(raw)) return 'task_timeout';
      if (/下载中断/i.test(raw)) return 'download_interrupted';
      return '';
    }

    function isLikelyRscPayload(payload = {}) {
      const haystack = [
        payload.publisherName,
        payload.source,
        payload.pageUrl,
        payload.assistDetailUrl,
        payload.pdfUrl
      ].map(value => String(value || '')).join(' ');
      return /rsc|royal society of chemistry|pubs\.rsc\.org/i.test(haystack);
    }

    function isExpectedTimeoutFailure(reason) {
      return /^(download_not_triggered_timeout|download_timeout|task_timeout)$/.test(String(reason || ''));
    }

    function formatTimeoutDoneMessage(err, reason) {
      const raw = formatTaskError(err);
      if (reason === 'download_not_triggered_timeout') return `已按未触发下载超时结束本任务：${raw}`;
      if (reason === 'download_timeout') return `已按下载中超时结束本任务：${raw}`;
      if (reason === 'task_timeout') return `已按单任务最长时间超时结束本任务：${raw}`;
      return `已按超时结束本任务：${raw}`;
    }

    function sanitizeDownloadItem(item) {
      if (!item) return null;
      return {
        id: item.id,
        createdByPlugin: !!item._ablesciCreatedByPlugin,
        publisherTabId: item._ablesciPublisherTabId || null,
        matchSource: item._ablesciMatchSource || '',
        url: urlHostPath(item.url || ''),
        finalUrl: urlHostPath(item.finalUrl || ''),
        mime: item.mime || '',
        filename: basenameOf(item.filename || ''),
        extension: extensionOf(item.filename || ''),
        fileSize: Number(item.fileSize || 0),
        totalBytes: Number(item.totalBytes || 0),
        state: item.state || '',
        error: item.error || ''
      };
    }

    async function saveDiagnostic(diag) {
      try {
        const opts = await getOptions();
        if (!diagnosticEnabled(opts)) return;
      } catch (_) {
        return;
      }
      const clean = JSON.parse(JSON.stringify(diag || {}));
      await chromeApi.storage.local.set({ [lastDiagnosticKey]: clean });
      console.debug('[Ablesci PDF Watcher Diagnostic]', clean);
    }

    async function appendDiagnosticTrace(payload, entry) {
      try {
        const opts = await getOptions();
        if (!diagnosticEnabled(opts)) return;
        const stored = await chromeApi.storage.local.get(lastDiagnosticKey);
        const previous = stored[lastDiagnosticKey] || {};
        const currentAssistId = maskId(payload?.assistId);
        const base = previous && previous.assistId === currentAssistId
          ? { ...previous }
          : makeDiagnosticBase(payload, opts);
        const trace = Array.isArray(base.publisherTrace) ? base.publisherTrace.slice(-29) : [];
        const next = {
          time: new Date().toISOString(),
          ...(entry || {})
        };
        const last = trace[trace.length - 1];
        if (last && last._signature && last._signature === traceSignature(next)) {
          last.time = next.time;
          last.repeatCount = Number(last.repeatCount || 1) + 1;
        } else {
          trace.push({
            ...next,
            _signature: traceSignature(next)
          });
        }
        await saveDiagnostic({ ...base, publisherTrace: trace });
      } catch (err) {
        console.warn('[Ablesci PDF Watcher] append diagnostic trace failed', err);
      }
    }

    async function saveErrorDiagnostic(payload, err) {
      const raw = redactLocalPaths(err && err.message ? err.message : String(err || '未知错误'));
      try {
        const opts = await getOptions();
        const stored = await chromeApi.storage.local.get(lastDiagnosticKey);
        const previous = stored[lastDiagnosticKey] || {};
        const base = previous && previous.assistId === maskId(payload?.assistId)
          ? { ...previous, assistDetailUrl: previous.assistDetailUrl || payload?.pageUrl || '' }
          : makeDiagnosticBase(payload, opts);
        const stage = base.downloadItem && base.stage ? base.stage : 'error';
        await saveDiagnostic({ ...base, stage, error: raw });
      } catch (_) {}
    }

    function isNonPdfAccessPageError(err) {
      const raw = err && err.message ? err.message : String(err || '');
      return raw.includes(htmlDownloadMessage) ||
        /file header is not %PDF-|likely html\/login\/error page/i.test(raw);
    }

    function isHtmlDownloadItem(item) {
      const mime = String(item?.mime || '').toLowerCase();
      const ext = extensionOf(item?.filename || '');
      if (mime.includes('text/html') || mime.includes('application/xhtml+xml')) return true;
      return ext === '.htm' || ext === '.html';
    }

    function isHtmlExtension(pathOrName) {
      const ext = extensionOf(pathOrName || '');
      return ext === '.html' || ext === '.htm';
    }

    function canRemoveHtmlDownloadItem(item) {
      if (!item || !item.id) return false;
      if (!isHtmlExtension(item.filename || '')) return false;
      return isHtmlDownloadItem(item);
    }

    async function removeDownloadArtifact(item) {
      if (!canRemoveHtmlDownloadItem(item)) {
        console.warn('[Ablesci PDF Watcher] refuse to remove non-html download artifact', sanitizeDownloadItem(item));
        return false;
      }
      try {
        await chromeApi.downloads.removeFile(item.id);
        return true;
      } catch (_) {
        return false;
      }
    }

    async function stopForNonPdfDownload(port, diag, item, downloadMeta, stage, reason, opts = {}) {
      let removed = false;
      let removeReason = 'autoRemoveHtmlDownloads disabled';
      if (opts.autoRemoveHtmlDownloads) {
        if (canRemoveHtmlDownloadItem(item)) {
          removed = await removeDownloadArtifact(item);
          removeReason = removed ? 'removed html/htm download artifact' : 'failed to remove html/htm download artifact';
        } else {
          removeReason = 'refuse to remove non-html download artifact';
        }
      }
      const message = htmlDownloadMessage + (removed
        ? ' 已删除本地 HTML 异常文件，并保留浏览器下载记录。'
        : ' 已保留本地异常文件，未自动删除。');

      await saveDiagnostic({
        ...diag,
        stage,
        downloadItem: downloadMeta || sanitizeDownloadItem(item),
        error: reason || htmlDownloadMessage,
        removedDownloadFile: removed,
        removeReason
      });
      post(port, 'done', message, {
        html: escapeHtml(message),
        recomend: false,
        reload: false,
        downloadOnly: true,
        blocked: true
      });
    }

    return {
      makeDiagnosticBase,
      classifyJournalAccessFailureReason,
      isLikelyRscPayload,
      isExpectedTimeoutFailure,
      formatTimeoutDoneMessage,
      sanitizeDownloadItem,
      saveDiagnostic,
      appendDiagnosticTrace,
      saveErrorDiagnostic,
      isNonPdfAccessPageError,
      isHtmlDownloadItem,
      isHtmlExtension,
      canRemoveHtmlDownloadItem,
      removeDownloadArtifact,
      stopForNonPdfDownload
    };
  }

  globalThis.AblesciBackgroundDiagnostics = {
    createBackgroundDiagnosticsApi
  };
})();
