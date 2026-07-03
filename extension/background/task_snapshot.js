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
    let snapshotMutation = Promise.resolve();

    function serializeSnapshotMutation(operation) {
      const next = snapshotMutation.then(operation, operation);
      snapshotMutation = next.catch(() => {});
      return next;
    }

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
      return serializeSnapshotMutation(async () => {
        const stored = await chromeApi.storage.local.get(uploadTaskSnapshotKey);
        const current = stored[uploadTaskSnapshotKey];
        const tasks = current && current.tasks && typeof current.tasks === 'object'
          ? { ...current.tasks }
          : {};
        tasks[String(task.id)] = compactTaskSnapshot(task, status);
        await chromeApi.storage.local.set({
          [uploadTaskSnapshotKey]: { version: 2, tasks }
        });
      });
    }

    async function clearUploadTaskSnapshot(task = null) {
      return serializeSnapshotMutation(async () => {
        try {
          const stored = await chromeApi.storage.local.get(uploadTaskSnapshotKey);
          const current = stored[uploadTaskSnapshotKey] || {};
          if (!task) {
            await chromeApi.storage.local.remove(uploadTaskSnapshotKey);
            return;
          }
          if (current.tasks && typeof current.tasks === 'object') {
            const tasks = { ...current.tasks };
            delete tasks[String(task.id)];
            if (Object.keys(tasks).length) {
              await chromeApi.storage.local.set({ [uploadTaskSnapshotKey]: { version: 2, tasks } });
            } else {
              await chromeApi.storage.local.remove(uploadTaskSnapshotKey);
            }
            return;
          }
          if (!current.taskId || Number(current.taskId) === Number(task.id)) {
            await chromeApi.storage.local.remove(uploadTaskSnapshotKey);
          }
        } catch (_) {}
      });
    }

    async function recoverUploadTaskSnapshot(reason = 'service_worker_init') {
      const stored = await chromeApi.storage.local.get(uploadTaskSnapshotKey);
      const snapshot = stored[uploadTaskSnapshotKey];
      if (!snapshot || typeof snapshot !== 'object') return;
      const staleTasks = snapshot.tasks && typeof snapshot.tasks === 'object'
        ? Object.values(snapshot.tasks)
        : [snapshot];
      const recoveredTasks = {};
      for (const stale of staleTasks) {
        if (!stale || stale.status === 'recovered_cancelled') continue;
        const recovered = {
          ...stale,
          status: 'recovered_cancelled',
          recoveredAt: new Date().toISOString(),
          recoveryReason: reason
        };
        recoveredTasks[String(stale.taskId || Object.keys(recoveredTasks).length + 1)] = recovered;
        await saveDiagnostic({
          time: new Date().toISOString(),
          stage: 'recovered-cancelled',
          assistId: stale.assistId ? maskId(stale.assistId) : '',
          detailUrlHostPath: stale.detailUrl || null,
          journalName: stale.journalName || '',
          error: 'service worker restarted; stale upload task was cancelled'
        }).catch(() => {});
      }
      if (!Object.keys(recoveredTasks).length) return;
      await chromeApi.storage.local.set({
        [uploadTaskSnapshotKey]: { version: 2, tasks: recoveredTasks }
      });
      console.warn('[Ablesci PDF Watcher] recovered stale upload task snapshots', { count: Object.keys(recoveredTasks).length, reason });
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
