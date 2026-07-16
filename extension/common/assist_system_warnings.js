'use strict';

(function initAssistSystemWarnings(globalThis) {
  const SYSTEM_MARKER_RE = /系统提示|提醒：由于doi是数字文件的唯一标识/i;
  const SUPPLEMENT_RE = /Supplementary|补充材料|supporting information|并非全文|不是全文|该doi的文献可能是补充材料/i;
  const ABNORMAL_RE = /索引库|类似于搜索引擎|准确性不能保证|建议填写原始官方链接|无全文|没有全文|并非全文|不是全文/i;

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function classifyAlertItems(items = []) {
    const trusted = (Array.isArray(items) ? items : [])
      .map(item => ({
        text: normalizeText(item?.text),
        special: item?.special === true
      }))
      .filter(item => item.text && (item.special || SYSTEM_MARKER_RE.test(item.text)));
    const supplement = trusted.some(item => SUPPLEMENT_RE.test(item.text));
    // `.special-assist-alert` is an authoritative server-side warning container.
    // Its wording may change, so a non-SI special alert must remain fail-closed.
    const abnormal = !supplement && trusted.some(item => item.special || ABNORMAL_RE.test(item.text));

    if (supplement) {
      return {
        blocked: true,
        skipReason: 'detail_system_prompt_si',
        message: '网站系统提示该 DOI 可能对应补充材料或并非全文，已跳过本次应助。',
        flags: {
          systemRisk: true,
          systemPromptSupplementDoi: true,
          systemPromptAbnormalAssist: false
        }
      };
    }
    if (abnormal) {
      return {
        blocked: true,
        skipReason: 'detail_system_prompt_abnormal',
        message: '网站系统提示该求助可能是索引库链接、无全文或信息不准确，已跳过本次应助。',
        flags: {
          systemRisk: true,
          systemPromptSupplementDoi: false,
          systemPromptAbnormalAssist: true
        }
      };
    }
    return {
      blocked: false,
      skipReason: '',
      message: '',
      flags: {
        systemRisk: false,
        systemPromptSupplementDoi: false,
        systemPromptAbnormalAssist: false
      }
    };
  }

  function hardBlockFromPayload(payload = {}) {
    const flags = payload?.riskFlags || {};
    if (flags.systemPromptSupplementDoi === true) {
      return {
        blocked: true,
        skipReason: 'detail_system_prompt_si',
        message: '网站系统提示该 DOI 可能对应补充材料或并非全文，已跳过本次应助。'
      };
    }
    if (flags.systemPromptAbnormalAssist === true) {
      return {
        blocked: true,
        skipReason: 'detail_system_prompt_abnormal',
        message: '网站系统提示该求助可能是索引库链接、无全文或信息不准确，已跳过本次应助。'
      };
    }
    return { blocked: false, skipReason: '', message: '' };
  }

  globalThis.AblesciAssistSystemWarnings = {
    classifyAlertItems,
    hardBlockFromPayload
  };
})(globalThis);
