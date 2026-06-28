'use strict';

// Ablesci upload-request and OSS/native upload helpers.
(function initBackgroundUploadClient(globalThis) {
  function createBackgroundUploadClientApi(deps = {}) {
    const {
      nativeMessageLongTimeoutMs,
      post,
      sendNativeMessage,
      stripHtml,
      escapeHtml
    } = deps;

    function responsePageTitle(raw) {
      const match = String(raw || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      return match ? stripHtml(match[1]).replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    }

    function responseTextSummary(raw) {
      return stripHtml(String(raw || ''))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 260);
    }

    function isLikelyAblesciServiceHtml(raw, status, title, summary) {
      if (Number(status) >= 500) return true;
      return /502 Bad Gateway|504 Gateway Time(?:-out)?|500 Internal Server(?: Error)?|503 Service|科研通.*网络错误|科研通.*系统维护|当前服务器负载过高|系统错误|服务器错误/i.test(
        `${title} ${summary} ${String(raw || '').slice(0, 1000)}`
      );
    }

    async function uploadRequest(payload, stat) {
      const body = new URLSearchParams();
      body.set(payload.csrfParam || '_csrf', payload.csrfToken);
      body.set('assist_id', payload.assistId);
      body.set('filename', stat.filename);
      body.set('file_md5', stat.md5);
      body.set('filesize', String(stat.size));

      const resp = await fetch('https://www.ablesci.com/assist/upload-request?t=' + Date.now(), {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body
      });
      const raw = await resp.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch (_) {
        const contentType = resp.headers?.get?.('content-type') || '';
        const title = responsePageTitle(raw);
        const summary = responseTextSummary(raw);
        const meta = {
          request: 'POST /assist/upload-request',
          status: resp.status,
          statusText: resp.statusText || '',
          contentType,
          responseUrl: resp.url || '',
          redirected: resp.redirected === true,
          responseLength: raw.length,
          pageTitle: title,
          summary
        };
        const likelyServiceError = isLikelyAblesciServiceHtml(raw, resp.status, title, summary);
        const err = new Error(
          `科研通 upload-request 返回 HTML 而不是 JSON；` +
          `HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}；` +
          `Content-Type=${contentType || 'unknown'}；最终地址=${resp.url || 'unknown'}；` +
          `页面标题=${title || '未识别'}；响应长度=${raw.length}；摘要=${summary || '无可见文本'}`
        );
        err.failureReason = likelyServiceError ? 'ablesci_service_error' : 'upload_response_not_json';
        err.responseMeta = meta;
        throw err;
      }
      if (!resp.ok) throw new Error('upload-request HTTP ' + resp.status + '：' + (data.msg || raw.slice(0, 200)));
      return data;
    }

    function isRecommendResponse(res) {
      return res && (res.recomend === 1 || res.recomend === '1' || res.recommend === 1 || res.recommend === '1');
    }

    function postDoneFromSiteResponse(port, res, fallbackMsg, extra = {}) {
      const rawHtml = res && res.msg ? String(res.msg) : (fallbackMsg || '上传成功');
      const finalHtml = extra.pdfCleanerHtml ? `${rawHtml}<br>${extra.pdfCleanerHtml}` : rawHtml;
      post(port, 'done', stripHtml(finalHtml), {
        ...extra,
        html: finalHtml,
        recomend: isRecommendResponse(res),
        reload: true,
        responseCode: res && res.code
      });
    }

    function isAssistStateChangedMessage(text) {
      const plain = stripHtml(text || '');
      return /该求助状态已经发生改变|请刷新页面查看或下载|已经有人上传了文献|请等待求助人确认|待确认|已完成|已关闭|不在求助中|已被修改状态|状态.*发生改变/.test(plain);
    }

    function postAssistStateChangedDone(port, text) {
      const plain = stripHtml(text || '该求助状态已经发生改变，请刷新页面查看或下载。');
      post(port, 'done', plain, {
        html: escapeHtml(plain),
        recomend: false,
        reload: true,
        blocked: true,
        stateChanged: true
      });
    }

    function normalizeOSSData(data) {
      const d = data || {};
      return {
        host: d.host,
        key: d.key || ((d.dir || '') + (d.randFilename || '')),
        policy: d.policy,
        accessid: d.accessid || d.OSSAccessKeyId,
        signature: d.signature,
        callback: d.callback,
        assist_id: d.assist_id,
        user_id: d.user_id,
        filename: d.filename,
        dir: d.dir,
        randFilename: d.randFilename
      };
    }

    async function uploadOssViaNative(nativeHostName, payload, stat, permit, opts) {
      return sendNativeMessage(nativeHostName, {
        action: 'upload_oss',
        path: stat.path,
        csrf_param: payload.csrfParam || '_csrf',
        csrf_token: payload.csrfToken,
        assist_id: payload.assistId,
        oss: normalizeOSSData(permit.data)
      }, nativeMessageLongTimeoutMs);
    }

    async function deleteUploadedFile(nativeHostName, path) {
      try {
        await sendNativeMessage(nativeHostName, { action: 'delete_file', path });
      } catch (err) {
        console.warn(err);
      }
    }

    return {
      uploadRequest,
      postDoneFromSiteResponse,
      isAssistStateChangedMessage,
      postAssistStateChangedDone,
      uploadOssViaNative,
      deleteUploadedFile
    };
  }

  globalThis.AblesciBackgroundUploadClient = {
    createBackgroundUploadClientApi
  };
})(globalThis);
