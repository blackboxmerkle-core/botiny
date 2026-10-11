// Curation caps (Incentive model v3 §2). Ranking is relevance-only (C5): incentives
// are attached after ordering and never change rank or inclusion except via C3/C4.
const scale = (items, cap) => {
  const total = items.reduce((s, it) => s + it.show_atomic + it.click_atomic, 0);
  if (total <= cap) return;
  const r = cap / total;
  for (const it of items) { it.show_atomic = Math.floor(it.show_atomic * r); it.click_atomic = Math.floor(it.click_atomic * r); }
};

/** ranked: [{listing_id, cluster_id, relevance, show_offer_atomic, click_offer_atomic, ...}] sorted by relevance desc. */
export function buildResultSet(ranked, cfg) {
  const f = cfg.feeAtomic;
  const relevant = ranked.filter(r => r.relevance >= cfg.minRelevance);
  const perCluster = new Map(); const set = [];
  for (const r of relevant) {                       // C3 slot share
    const n = perCluster.get(r.cluster_id) ?? 0;
    if (n >= cfg.maxSlotsPerCluster) continue;
    perCluster.set(r.cluster_id, n + 1);
    set.push(r);
    if (set.length >= cfg.setSize) break;
  }
  const incentivised = perCluster.size >= cfg.minDistinctClusters; // C4
  const lineCap = Math.floor(cfg.lineItemCapMult * f);
  const items = set.map((r, i) => ({
    ...r, rank: i + 1,
    show_atomic: incentivised ? Math.min(Math.max(0, r.show_offer_atomic | 0), lineCap) : 0, // C1
    click_atomic: incentivised ? Math.min(Math.max(0, r.click_offer_atomic | 0), lineCap) : 0,
  }));
  const byCluster = new Map();
  for (const it of items) (byCluster.get(it.cluster_id) ?? byCluster.set(it.cluster_id, []).get(it.cluster_id)).push(it);
  for (const group of byCluster.values()) scale(group, Math.floor(cfg.clusterCapMult * f)); // C2
  scale(items, Math.floor(cfg.setCapMult * f));                                              // C6
  for (const it of items) it.disclosure = it.show_atomic + it.click_atomic > 0 ? 'Incentivised listing' : null;
  return { incentivised, items };
}
