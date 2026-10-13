// Deterministic re-rank of a logged request (shared by GET /v1/requests/:id/replay, tests and scripts/replay-all.ts).
import { pool } from "./db";
import { rank } from "./rank";
export async function replayRow(r: any) {
  const p = JSON.parse(r.request_canonical);
  return rank(pool, { query: p.query, k: p.k, catalogue_seq: Number(r.catalogue_seq), embedding_model: r.embedding_model, ranker_version: r.ranker_version,
    market_seq: r.market_seq == null ? undefined : Number(r.market_seq), settings_version: r.settings_version ?? undefined, pacing_at_ms: p.pacing_at_ms });
}
/** Internal (not an HTTP route): replay any request regardless of payment status. */
export async function replayRequest(request_id: string) {
  const r = (await pool.query("SELECT * FROM requests WHERE request_id=$1", [request_id])).rows[0];
  if (!r) return null;
  const out = await replayRow(r);
  return { request_id, payment_status: r.payment_status, logged_hash: r.response_hash, replayed_hash: out.hash, match: out.hash === r.response_hash };
}
