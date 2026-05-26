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
      try { data = JSON.parse(raw); } catch (_) { throw new Error('upload-request 返回不是 JSON：' + raw.slice(0, 200)); }
      if (!resp.ok) throw new Error('upload-request HTTP ' + resp.status + '：' + (data.msg || raw.slice(0, 200)));
      return data;
    }

    function isRecommendResponse(res) {
      return res && (res.recomend === 1 || res.recomend === '1' || res.recommend === 1 || res.recommend === '1');
    }

    function postDoneFromSiteResponse(port, res, fallbackMsg) {
      const rawHtml = res && res.msg ? String(res.msg) : (fallbackMsg || '上传成功');
      post(port, 'done', stripHtml(rawHtml), {
        html: rawHtml,
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
        move_to_dir: opts.moveToDir || '',
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
