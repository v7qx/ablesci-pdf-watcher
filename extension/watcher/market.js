// Responsibility: publisher-market fallback/advanced models and related helpers.
(function () {
  function createWatcherMarketApi(config) {
    const {
      normalizeText,
      demandSnapshotDays,
      getDemandSnapshots,
      buildMarketDataModel,
      fallbackPublisherWeights,
      advancedModelMinDays
    } = config;

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
      return s.split(/[\/|,，;；\s]+/).filter(Boolean)[0] || 'Unknown';
    }

    function aggregatePublisherCounts(counts) {
      const out = {};
      for (const [name, count] of Object.entries(counts || {})) {
        const alias = publisherAlias(name);
        out[alias] = (out[alias] || 0) + Math.max(0, Number(count) || 0);
      }
      return out;
    }

    function buildFallbackPublisherModel(snapshot) {
      const counts = aggregatePublisherCounts(snapshot?.publisherCounts);
      const entries = Object.entries(counts).filter(([, count]) => count > 0);
      const total = entries.reduce((sum, [, count]) => sum + count, 0);
      if (!entries.length || total <= 0) return { ready: false, source: 'empty', days: 0, publishers: {} };
      const publishers = {};
      for (const [name, count] of entries) {
        const base = fallbackPublisherWeights[name] || fallbackPublisherWeights.Unknown;
        const share = count / total;
        publishers[name] = {
          count,
          pressure: Number(share.toFixed(4)),
          weight: Number((base * (0.8 + share * 0.6)).toFixed(3)),
          successRate: Number(Math.min(0.95, 0.45 + base * 0.08).toFixed(3))
        };
      }
      return { ready: false, source: 'fallback_current_snapshot', days: 1, publishers };
    }

    function buildAdvancedPublisherModel(snapshots) {
      const clean = (snapshots || []).filter(item => item && item.publisherCounts && !item.demandAnomaly);
      const days = demandSnapshotDays(clean);
      const latest = clean[0] || null;
      if (days.size < advancedModelMinDays) return buildFallbackPublisherModel(latest);
      const previous = clean.find(item => item.dayKey && item.dayKey !== latest?.dayKey) || clean[1] || null;
      const latestCounts = aggregatePublisherCounts(latest?.publisherCounts);
      const previousCounts = aggregatePublisherCounts(previous?.publisherCounts);
      const latestTotal = Math.max(1, Object.values(latestCounts).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0));
      const publishers = {};
      for (const [name, rawCount] of Object.entries(latestCounts)) {
        const count = Math.max(0, Number(rawCount) || 0);
        const previousCount = Math.max(0, Number(previousCounts[name] || 0) || 0);
        const delta = count - previousCount;
        const pressure = count / latestTotal;
        const trend = Math.max(-0.4, Math.min(0.6, delta / Math.max(1, previousCount || count)));
        const base = fallbackPublisherWeights[name] || fallbackPublisherWeights.Unknown;
        publishers[name] = {
          count,
          previousCount,
          delta,
          pressure: Number(pressure.toFixed(4)),
          trend: Number(trend.toFixed(4)),
          weight: Number((base * (0.85 + pressure * 0.8 + trend * 0.35)).toFixed(3)),
          successRate: Number(Math.min(0.97, 0.5 + base * 0.07 + Math.max(0, trend) * 0.12).toFixed(3))
        };
      }
      return { ready: true, source: 'advanced_2day_delta', days: days.size, publishers };
    }

    function demandFactorByRegime(regime) {
      if (regime === 'quiet') return 0.65;
      if (regime === 'busy') return 1.2;
      if (regime === 'very_busy') return 1.4;
      return 1;
    }

    function trendFactorFromModel(model) {
      const values = Object.values(model?.publishers || {});
      if (!values.length) return 1;
      const pressure = values.reduce((sum, item) => sum + Math.max(0, Number(item.pressure) || 0), 0) / values.length;
      const trend = values.reduce((sum, item) => sum + Number(item.trend || 0), 0) / values.length;
      return Math.max(0.75, Math.min(1.35, 1 + pressure * 0.4 + trend * 0.2));
    }

    async function refreshPublisherModelFromSnapshots(state) {
      const snapshots = await getDemandSnapshots();
      if (!snapshots.length) return state;
      const model = buildAdvancedPublisherModel(snapshots);
      const market = buildMarketDataModel(snapshots);
      state.publisherModel = model;
      state.marketData = market;
      state.schedulerModelMode = model.ready ? 'advanced' : 'simple';
      return state;
    }

    return {
      publisherAlias,
      aggregatePublisherCounts,
      buildFallbackPublisherModel,
      buildAdvancedPublisherModel,
      demandFactorByRegime,
      trendFactorFromModel,
      refreshPublisherModelFromSnapshots
    };
  }

  globalThis.AblesciWatcherMarketModule = {
    createWatcherMarketApi
  };
}());
