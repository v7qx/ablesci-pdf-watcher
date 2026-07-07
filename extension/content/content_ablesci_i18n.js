(function () {
  'use strict';

  const MESSAGE_MAP = {
    '当前出版商无正文订阅权限，任务已跳过。': 'No subscription access, task skipped.',
    '当前出版商页面显示无正文订阅权限，已跳过本次任务并记录期刊权限状态。': 'The publisher page shows no full-text subscription access. This task has been skipped and the journal permission status recorded.',
    'ScienceDirect 需要登录或机构访问后才能继续。插件已保留这次为登录阻塞，不计入无权限期刊；完成登录后可重新触发。': 'ScienceDirect requires login or institutional access. The plugin has flagged this as login blocked, which is excluded from no-access journals; you can retry after logging in.',
    '检测到出版商验证页，已中断本次任务并计入验证次数；达到阈值后会自动暂停低频值守。': 'Publisher verification page (Cloudflare) detected. Task aborted and challenge count incremented; auto watcher will pause if threshold is reached.',
    'DOI 解析失败或不存在，已跳过本次任务。': 'DOI resolution failed or does not exist. Task skipped.',
    '已排队：等待当前 PDF 任务完成；关闭本页可取消。': 'Queued: Waiting for current PDF task to complete; close this page to cancel.',
    '已跳过': 'Skipped',
    '当前任务已跳过': 'Current task skipped',
    '上传成功': 'Upload Successful',
    '上传失败': 'Upload Failed',
    '仅下载完成': 'Downloaded Only'
  };

  function createContentI18nApi(deps = {}) {
    const getActiveLanguage = typeof deps.getActiveLanguage === 'function'
      ? deps.getActiveLanguage
      : () => 'zh';

    function translateBackgroundMessage(msgText) {
      if (getActiveLanguage() !== 'en') return msgText;
      let trimmed = String(msgText || '').trim();
      let prefix = '';
      const prefixes = ['Failed: ', 'Failed：', '失败：', 'Warning: ', 'Warning：', '警告：', 'Success: ', 'Success：', '成功：'];
      for (const p of prefixes) {
        if (trimmed.startsWith(p)) {
          prefix = p.replace('失败：', 'Failed: ')
                    .replace('Failed：', 'Failed: ')
                    .replace('警告：', 'Warning: ')
                    .replace('Warning：', 'Warning: ')
                    .replace('成功：', 'Success: ')
                    .replace('Success：', 'Success: ');
          trimmed = trimmed.substring(p.length).trim();
          break;
        }
      }

      let translated = MESSAGE_MAP[trimmed];
      if (!translated) {
        if (trimmed.startsWith('开始处理任务：')) {
          translated = trimmed.replace('开始处理任务：', 'Starting task: ');
        } else if (trimmed.startsWith('已排队：')) {
          translated = 'Queued: Waiting for current PDF task to complete; close this page to cancel.';
        } else if (trimmed.includes('无正文订阅权限')) {
          translated = 'The publisher page shows no full-text subscription access. Task skipped.';
        } else if (trimmed.includes('需要登录或机构访问')) {
          translated = 'Login or institutional access required. Task marked as login blocked.';
        } else if (trimmed.includes('检测到出版商验证页')) {
          translated = 'Publisher verification page detected. Task aborted.';
        } else if (trimmed.includes('已取消当前任务')) {
          translated = 'Current task cancelled.';
        } else if (trimmed.includes('超时')) {
          translated = trimmed.replace('任务最长超时', 'Max task timeout')
                              .replace('已超过', ' exceeded ')
                              .replace('已超过', ' exceeded ')
                              .replace('分钟', ' minutes')
                              .replace('未触发下载超时', 'No download triggered timeout');
        } else {
          translated = trimmed;
        }
      }
      return prefix + translated;
    }

    return { translateBackgroundMessage };
  }

  globalThis.AblesciContentI18n = {
    createContentI18nApi
  };
})();
