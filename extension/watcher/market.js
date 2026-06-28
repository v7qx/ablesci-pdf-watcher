// Responsibility: normalize publisher/source names shared by watcher modules.
(function () {
  function createWatcherMarketApi(config) {
    const { normalizeText } = config;

    function publisherAlias(name) {
      const s = normalizeText(name);
      if (!s) return 'Unknown';
      if (/elsevier|science\s*direct/i.test(s)) return 'Elsevier';
      if (/wiley/i.test(s)) return 'Wiley';
      if (/springer/i.test(s)) return 'Springer';
      if (/nature/i.test(s)) return 'Nature';
      if (/oxford/i.test(s)) return 'Oxford';
      if (/ieee/i.test(s)) return 'IEEE';
      if (/\brsc\b|royal\s+society\s+of\s+chemistry|pubs\.rsc\.org/i.test(s)) return 'RSC';
      if (/\bacs\b|american\s+chemical\s+society|pubs\.acs\.org/i.test(s)) return 'ACS';
      if (/\baip\b|american\s+institute\s+of\s+physics|aip\.org|scitation\.org/i.test(s)) return 'AIP';
      if (/\biop\b|institute\s+of\s+physics|iopscience\.iop\.org/i.test(s)) return 'IOP';
      if (/\bsage\b|sagepub/i.test(s)) return 'SAGE';
      return s.split(/[\/|,，;；\s]+/).filter(Boolean)[0] || 'Unknown';
    }

    return { publisherAlias };
  }

  globalThis.AblesciWatcherMarketModule = {
    createWatcherMarketApi
  };
}());
