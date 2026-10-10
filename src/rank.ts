import { embed, fromPgVector, EMBEDDING_MODEL, toPgVector } from "./embed";
import { canonicalize, sha256 } from "./canonical";
export const RANKER_VERSION = "cosine-ppm-v1;tiebreak=score_desc,listing_id_asc;exact-scan";
type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };

export interface RecommendInput { query: string; k: number; }
export function normalizeInput(b: any): RecommendInput | string {
  if (typeof b?.query !== "string" || !b.query.trim()) return "query required";
  const k = b.k === undefined ? 5 : b.k;
  if (!Number.isSafeInteger(k) || k < 1 || k > 20) return "k must be integer 1..20";
  return { query: b.query.normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 1000), k };
}
export function canonicalRequest(inp: RecommendInput, catalogue_seq: number, embedding_model = EMBEDDING_MODEL, ranker_version = RANKER_VERSION) {
  return canonicalize({ query: inp.query, k: inp.k, catalogue_seq, embedding_model, ranker_version });
}

/** Pure, deterministic: given pinned inputs, produce the canonical response body. */
export async function rank(db: Q, req: { query: string; k: number; catalogue_seq: number; embedding_model: string; ranker_version: string }) {
  if (req.embedding_model !== EMBEDDING_MODEL || req.ranker_version !== RANKER_VERSION)
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
  return { body, canonical, hash: sha256(canonical), meta: scored.map(r => ({ listing_id: r.listing_id, provider_id: r.provider_id, cpi: Number(r.cpi_micro_usdc) })) };
}
