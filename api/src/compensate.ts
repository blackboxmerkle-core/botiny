// settle_failed compensation (security audit item 5).
//
// Design (chosen over "settle first, then commit"): the recommend transaction must commit BEFORE settlement so the
// EIP-3009 nonce is reserved (replay protection) and the ranked response is pinned to its market_seq (replay MATCH).
// Settling first would move the bot's money before we know the commit succeeds, and a commit failure after a
// successful settlement would charge the bot for nothing. So we keep commit -> settle, and when settlement fails we
// run ONE follow-up transaction (MARKET_LOCK + CLICK_LEDGER_LOCK) that appends compensating rows:
//   - balance_ledger 'impression_refund'      (+ the request's impression debits, per advertiser)
//   - balance_ledger 'incentive_escrow_void'  (+ the request's click escrow, per advertiser)
//   - incentive_pool_ledger 'void_funded' / 'void_draw' (un-count the escrow from the offer budget; pool draws go back to the pool)
//   - harvest_tokens of the request: incentives zeroed + tracked_only + voided_at (links still redirect, nothing is payable)
//   - requests.billing_status = 'voided' (voided_at, void_detail). The request/response rows and impressions stay for audit.
// Everything is idempotent (unique partial indexes + billing_status guard). Ledgers stay append-only. The new rows
// carry a later market_seq than any request already pinned, so replay of every logged request is unchanged.
// If any incentive line of the request already accrued (should be impossible: the bot never received the links on
// a 402), nothing is reversed and the request is flagged billing_status='void_review' for an admin.
import type { PoolClient } from "pg";
import { pool } from "./db";
import { MARKET_LOCK } from "./market";
import { CLICK_LEDGER_LOCK } from "./clicks";

/** Lock order used by everything that writes the market/click ledgers. */
export async function lockLedgers(c: PoolClient) {
  await c.query("SELECT pg_advisory_xact_lock($1)", [MARKET_LOCK]);
  await c.query("SELECT pg_advisory_xact_lock($1)", [CLICK_LEDGER_LOCK]);
}
/** Compensate INSIDE the caller's transaction (ledger locks already held). Idempotent via billing_status + unique indexes. */
export async function compensateInTx(c: PoolClient, request_id: string, reason = "settle_failed") {
  const r = (await c.query("SELECT request_id, payment_status, billing_status FROM requests WHERE request_id=$1 FOR UPDATE", [request_id])).rows[0];
  if (!r) return { request_id, voided: false, reason: "unknown request" };
  if (r.billing_status !== "billed") return { request_id, voided: false, already: r.billing_status };
  if (r.payment_status !== "settle_failed") return { request_id, voided: false, reason: `payment_status ${r.payment_status}` };
  const accrued = Number((await c.query(`SELECT count(*)::int n FROM incentive_ledger l JOIN harvest_tokens h ON h.token = l.token WHERE h.request_id=$1`, [request_id])).rows[0].n);
  if (accrued > 0) {
    await c.query("UPDATE requests SET billing_status='void_review', void_detail=$2 WHERE request_id=$1", [request_id, { reason, accrued_lines: accrued, at: new Date().toISOString() }]);
    return { request_id, voided: false, review: true, accrued_lines: accrued };
  }
  const deb = (await c.query(`SELECT advertiser_id, kind, (-SUM(delta_atomic))::bigint AS amt FROM balance_ledger
      WHERE request_id=$1 AND kind IN ('impression_debit','incentive_escrow') GROUP BY 1,2 HAVING SUM(delta_atomic) < 0`, [request_id])).rows;
  let refunded_impressions = 0, returned_escrow = 0;
  for (const d of deb) {
    const kind = d.kind === "impression_debit" ? "impression_refund" : "incentive_escrow_void";
    const ins = await c.query(`INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,request_id,note) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (request_id, advertiser_id, kind) WHERE kind IN ('impression_refund','incentive_escrow_void') DO NOTHING RETURNING seq`,
      [d.advertiser_id, Number(d.amt), kind, request_id, `${reason}: request not billed`]);
    if (ins.rows.length) { if (kind === "impression_refund") refunded_impressions += Number(d.amt); else returned_escrow += Number(d.amt); }
  }
  const pl = (await c.query(`SELECT listing_id, provider_id, kind, SUM(amount_atomic)::bigint amt FROM incentive_pool_ledger
      WHERE request_id=$1 AND kind IN ('funded','pool_draw') GROUP BY 1,2,3`, [request_id])).rows;
  for (const p of pl)
    await c.query(`INSERT INTO incentive_pool_ledger(listing_id,provider_id,kind,amount_atomic,request_id,note) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (request_id, listing_id, kind) WHERE kind IN ('void_funded','void_draw') DO NOTHING`,
      [p.listing_id, p.provider_id, p.kind === "funded" ? "void_funded" : "void_draw", Number(p.amt), request_id, `${reason}: request not billed`]);
  const tok = await c.query(`UPDATE harvest_tokens SET show_atomic=0, click_atomic=0, tracked_only=true, voided_at=now() WHERE request_id=$1 AND voided_at IS NULL`, [request_id]);
  const detail = { reason, refunded_impressions_atomic: refunded_impressions, returned_escrow_atomic: returned_escrow, pool_rows: pl.length, voided_links: tok.rowCount, at: new Date().toISOString() };
  await c.query("UPDATE requests SET billing_status='voided', voided_at=now(), void_detail=$2 WHERE request_id=$1", [request_id, detail]);
  return { request_id, voided: true, ...detail };
}
/** Standalone (own transaction): used by the sweeper and the backfill. */
export async function voidUnbilledRequest(request_id: string, reason = "settle_failed") {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED"); await lockLedgers(c);
    const out = await compensateInTx(c, request_id, reason);
    await c.query("COMMIT"); return out;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

/** Backfill: void every settle_failed request still marked billed (idempotent). */
export async function voidAllUnbilled() {
  const ids = (await pool.query("SELECT request_id FROM requests WHERE payment_status='settle_failed' AND billing_status='billed' ORDER BY received_at")).rows.map(r => r.request_id);
  const out = []; for (const id of ids) out.push(await voidUnbilledRequest(id));
  return { candidates: ids.length, voided: out.filter(o => o.voided).length, review: out.filter((o: any) => o.review).length,
    refunded_impressions_atomic: out.reduce((a: number, o: any) => a + (o.refunded_impressions_atomic ?? 0), 0), returned_escrow_atomic: out.reduce((a: number, o: any) => a + (o.returned_escrow_atomic ?? 0), 0) };
}
