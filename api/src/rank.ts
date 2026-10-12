import { embed, fromPgVector, EMBEDDING_MODEL, toPgVector } from "./embed";
import { canonicalize, sha256 } from "./canonical";
import { PACING_RULE, pacingAt } from "./pacing";
export const RANKER_V1 = "cosine-ppm-v1;tiebreak=score_desc,listing_id_asc;exact-scan";
export const RANKER_V2 = "promo-v2;qualify=score>=threshold;promo=score+bid_weight*bid,funded(fixed+bid),slots-first;organic=score_desc,listing_id_asc;exact-scan";
export const RANKER_VERSION = "promo-v3;qualify=score>=threshold;promo=score+bid_weight*bid+pacing_boost,funded(fixed+bid),slots-first;organic=score_desc,listing_id_asc;exact-scan;" + PACING_RULE;
type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

export interface RecommendInput { query: string; k: number; }
export function normalizeInput(b: any): RecommendInput | string {
  if (typeof b?.query !== "string" || !b.query.trim()) return "query required";
  const k = b.k === undefined ? 5 : b.k;
  if (!Number.isSafeInteger(k) || k < 1 || k > 20) return "k must be integer 1..20";
  return { query: b.query.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 1000), k };
}
export function canonicalRequest(inp: RecommendInput, catalogue_seq: number, extra: { market_seq?: number; settings_version?: number; pacing_at_ms?: number } = {}, embedding_model = EMBEDDING_MODEL, ranker_version = RANKER_VERSION) {
  return canonicalize({ query: inp.query, k: inp.k, catalogue_seq, embedding_model, ranker_version, ...extra });
}

/** Pure, deterministic: given pinned inputs, produce the canonical response body. */
export interface RankReq { query: string; k: number; catalogue_seq: number; embedding_model: string; ranker_version: string; market_seq?: number; settings_version?: number; pacing_at_ms?: number }
export async function rank(db: Q, req: RankReq) {
  if (req.ranker_version === RANKER_VERSION) return rankV2(db, req, true);
  if (req.ranker_version === RANKER_V2) return rankV2(db, req, false);
  return rankV1(db, req);
}
async function scoredCandidates(db: Q, req: RankReq) {
  const qv = embed(req.query);
  const { rows } = await db.query(
    `SELECT l.listing_id, l.provider_id, l.name, l.description, l.address, l.kind, l.cpi_micro_usdc, l.embedding::text AS emb
       FROM listings l
      WHERE l.seq <= $1 AND l.embedding_model = $2
        AND NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes = l.listing_id AND n.seq <= $1)
      ORDER BY l.embedding <=> $3::vector, l.listing_id`,
    [req.catalogue_seq, req.embedding_model, toPgVector(qv)]);
  return rows.map(r => {
    const v = fromPgVector(r.emb); let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
    return { ...r, score_ppm: Math.round(dot * 1e6) };
  });
}
const byScore = (a: any, b: any) => b.score_ppm - a.score_ppm || (a.listing_id < b.listing_id ? -1 : a.listing_id > b.listing_id ? 1 : 0);
const brief = (d: string) => d.length > 200 ? d.slice(0, 197) + "..." : d;

/** v2: qualify by threshold, promote funded bidders into the first slots, then organic. Fully determined by
 *  (query, k, catalogue_seq, market_seq, settings_version, embedding_model, ranker_version). */
async function rankV2(db: Q, req: RankReq, v3: boolean) {
  if (v3 && !Number.isSafeInteger(req.pacing_at_ms)) throw new Error("v3 requires pacing_at_ms");
  if (req.embedding_model !== EMBEDDING_MODEL) throw new Error(`cannot replay: embedding ${req.embedding_model} unavailable`);
  if (req.market_seq === undefined || req.settings_version === undefined) throw new Error("v2 requires market_seq and settings_version");
  const { settingsAt } = await import("./settings");
  const S = await settingsAt(db, req.settings_version);
  const M = req.market_seq;
  const all = await scoredCandidates(db, req);
  const bids = new Map<string, { bid: number; paused: boolean }>((await db.query(
    `SELECT DISTINCT ON (listing_id) listing_id, bid_atomic, paused FROM listing_bid_events WHERE seq <= $1 ORDER BY listing_id, seq DESC`, [M])).rows
    .map(r => [r.listing_id, { bid: Number(r.bid_atomic), paused: r.paused }]));
  const bal = new Map<string, number>((await db.query(
    `SELECT a.advertiser_id, COALESCE(SUM(b.delta_atomic) FILTER (WHERE b.seq <= $1), 0)::text AS bal
       FROM advertisers a LEFT JOIN balance_ledger b USING (advertiser_id) GROUP BY 1`, [M])).rows.map(r => [r.advertiser_id, Number(r.bal)]));
  const qualified = all.filter(r => r.score_ppm >= S.relevance_threshold_ppm && !bids.get(r.listing_id)?.paused).sort(byScore);
  // v3: incentive offers behind their consumption schedule get a bounded pacing boost inside the promoted slots
  const pace = v3 ? await pacingAt(db, M, req.pacing_at_ms!, qualified.map(r => r.listing_id)) : new Map();
  const boostOf = (id: string) => pace.get(id)?.boost_ppm ?? 0;
  const promoCands = qualified.filter(r => bal.has(r.provider_id) && ((bids.get(r.listing_id)?.bid ?? 0) > 0 || boostOf(r.listing_id) > 0))
    .map(r => { const bid = Math.min(bids.get(r.listing_id)?.bid ?? 0, S.max_bid_atomic); const pacing_boost_ppm = boostOf(r.listing_id);
      return { ...r, bid, pacing_boost_ppm, promo_score_ppm: r.score_ppm + S.bid_weight_ppm_per_atomic * bid + pacing_boost_ppm }; })
    .sort((a, b) => b.promo_score_ppm - a.promo_score_ppm || byScore(a, b));
  const remaining = new Map(bal);
  const promoted: any[] = [];
  for (const c of promoCands) {
    if (promoted.length >= Math.min(S.promoted_slots, req.k)) break;
    const cost = S.fixed_cpi_atomic + c.bid;
    if ((remaining.get(c.provider_id) ?? 0) >= cost) { remaining.set(c.provider_id, remaining.get(c.provider_id)! - cost); promoted.push({ ...c, cost }); }
  }
  const pid = new Set(promoted.map(p => p.listing_id));
  const organic = qualified.filter(r => !pid.has(r.listing_id)).slice(0, req.k - promoted.length);
  const ordered = [...promoted.map(p => ({ ...p, sponsored: true })), ...organic.map(o => ({ ...o, sponsored: false, cost: 0, bid: 0 }))];
  const body = {
    catalogue_seq: req.catalogue_seq, market_seq: M, settings_version: req.settings_version,
    embedding_model: req.embedding_model, ranker_version: req.ranker_version, query: req.query, k: req.k,
    ...(v3 ? { pacing_at_ms: req.pacing_at_ms } : {}),
    results: ordered.map((r, i) => ({
      rank: i + 1, listing_id: r.listing_id, name: r.name, description: brief(r.description), address: r.address, kind: r.kind,
      score_ppm: r.score_ppm, sponsored: r.sponsored,
      ...(r.sponsored ? { label: "Sponsored", advertiser: r.provider_id, bid_atomic: r.bid, promo_score_ppm: r.promo_score_ppm, ...(r.pacing_boost_ppm ? { pacing_boost_ppm: r.pacing_boost_ppm } : {}) } : {}),
    })),
  };
  const canonical = canonicalize(body);
  return { body, canonical, hash: sha256(canonical), settings: S, pacing: v3 ? Object.fromEntries([...pace].filter(([id]) => ordered.some(o => o.listing_id === id))) : null,
    meta: ordered.map(r => ({ listing_id: r.listing_id, provider_id: r.provider_id, sponsored: r.sponsored, fixed: r.sponsored ? S.fixed_cpi_atomic : 0, bid: r.bid, cpi: r.cost })) };
}

async function rankV1(db: Q, req: RankReq) {
  if (req.embedding_model !== EMBEDDING_MODEL || req.ranker_version !== RANKER_V1)
    throw new Error(`cannot replay: model/ranker ${req.embedding_model}/${req.ranker_version} not available in this build`);
  const qv = embed(req.query);
  // Exact (non-ANN) scan over the pinned snapshot. pgvector gives the candidate order; final scores are
  // recomputed in JS from the stored 6dp vectors as integer parts-per-million so ordering is bit-stable.
  const { rows } = await db.query(
    `SELECT l.listing_id, l.provider_id, l.name, l.description, l.address, l.kind, l.cpi_micro_usdc, l.embedding::text AS emb
       FROM listings l
      WHERE l.seq <= $1 AND l.embedding_model = $2
        AND NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes = l.listing_id AND n.seq <= $1)
      ORDER BY l.embedding <=> $3::vector, l.listing_id`,
    [req.catalogue_seq, req.embedding_model, toPgVector(qv)]);
  const scored = rows.map(r => {
    const v = fromPgVector(r.emb); let dot = 0;
    for (let i = 0; i < v.length; i++) dot += v[i] * qv[i];
    return { ...r, score_ppm: Math.round(dot * 1e6) };
  }).filter(r => r.score_ppm > 0)
    .sort((a, b) => b.score_ppm - a.score_ppm || (a.listing_id < b.listing_id ? -1 : a.listing_id > b.listing_id ? 1 : 0))
    .slice(0, req.k);
  const body = {
    catalogue_seq: req.catalogue_seq, embedding_model: req.embedding_model, ranker_version: req.ranker_version,
    query: req.query, k: req.k,
    results: scored.map((r, i) => ({
      rank: i + 1, listing_id: r.listing_id, name: r.name,
      description: r.description.length > 200 ? r.description.slice(0, 197) + "..." : r.description,
      address: r.address, kind: r.kind, score_ppm: r.score_ppm,
    })),
  };
  const canonical = canonicalize(body);
  return { body, canonical, hash: sha256(canonical), settings: null as any, meta: scored.map(r => ({ listing_id: r.listing_id, provider_id: r.provider_id, sponsored: false, fixed: 0, bid: 0, cpi: Number(r.cpi_micro_usdc) })) };
}
