'use strict';

(function () {
  function createBackgroundTaskSnapshotApi(deps = {}) {
    const {
      chromeApi,
      uploadTaskSnapshotKey,
      urlHostPath,
      maskId,
      saveDiagnostic
    } = deps;

    function compactTaskSnapshot(task, status = 'running') {
      const payload = task?.payload || {};
      return {
        taskId: task?.id || '',
        assistId: String(payload.assistId || '').slice(0, 80),
        detailUrl: urlHostPath(payload.detailUrl || payload.pageUrl || ''),
        journalName: String(payload.journalName || payload.journalShortName || '').slice(0, 160),
        startedAt: task?.startedAt || new Date().toISOString(),
        status
      };
    }

    async function saveUploadTaskSnapshot(task, status = 'running') {
      if (!task) return;
      await chromeApi.storage.local.set({ [uploadTaskSnapshotKey]: compactTaskSnapshot(task, status) });
    }

    async function clearUploadTaskSnapshot(task = null) {
      try {
        if (task) {
          const stored = await chromeApi.storage.local.get(uploadTaskSnapshotKey);
          const current = stored[uploadTaskSnapshotKey] || {};
          if (current.taskId && Number(current.taskId) !== Number(task.id)) return;
        }
        await chromeApi.storage.local.remove(uploadTaskSnapshotKey);
      } catch (_) {}
    }

    async function recoverUploadTaskSnapshot(reason = 'service_worker_init') {
      const stored = await chromeApi.storage.local.get(uploadTaskSnapshotKey);
      const snapshot = stored[uploadTaskSnapshotKey];
      if (!snapshot || typeof snapshot !== 'object') return;
      if (snapshot.status === 'recovered_cancelled') return;
      await chromeApi.storage.local.set({
        [uploadTaskSnapshotKey]: {
          ...snapshot,
          status: 'recovered_cancelled',
          recoveredAt: new Date().toISOString(),
          recoveryReason: reason
        }
      });
      await saveDiagnostic({
        time: new Date().toISOString(),
        stage: 'recovered-cancelled',
        assistId: snapshot.assistId ? maskId(snapshot.assistId) : '',
        detailUrlHostPath: snapshot.detailUrl || null,
        journalName: snapshot.journalName || '',
        error: 'service worker restarted; stale upload task was cancelled'
      }).catch(() => {});
      console.warn('[Ablesci PDF Watcher] recovered stale upload task snapshot', { taskId: snapshot.taskId, reason });
    }

    return {
      compactTaskSnapshot,
      saveUploadTaskSnapshot,
      clearUploadTaskSnapshot,
      recoverUploadTaskSnapshot
    };
  }

  globalThis.AblesciBackgroundTaskSnapshot = {
    createBackgroundTaskSnapshotApi
  };
})();
