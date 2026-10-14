// Settlement outcome recording + reconciliation (security re-check C/D).
//
// recordSettlement(): ONE transaction (ledger locks) that writes the settlement outcome and, for a DEFINITE failure,
// compensates in that same transaction (compensate.ts), so a request can't stay billed + settle_failed after a crash.
//   ok                -> payment_status 'settled'
//   ambiguous failure -> 'settle_unknown' (timeout / network / tx without receipt: the authorization may be on-chain)
//   definite failure  -> 'settle_failed' + compensation
// sweep() (crawler worker loop, every 60 s): resolves settle_unknown from the chain, and compensates any
// billed + settle_failed row left behind (e.g. a crash between commit and compensation). Idempotent.
// Resolution rule: authorizationState(from, nonce) == used  => settled (billing kept).
//                  unused AND validBefore has passed (+60 s) => can never settle => settle_failed + compensate.
//                  unused and still valid                    => wait (re-check next sweep).
import type { PoolClient } from "pg";
import { pool } from "./db";
import { compensateInTx, lockLedgers, voidUnbilledRequest } from "./compensate";
import type { SettleResult } from "./payment";

export async function recordSettlement(request_id: string, s: SettleResult, extra: { via?: string; valid_before?: number | null } = {}) {
  const status = s.ok ? "settled" : s.ambiguous ? "settle_unknown" : "settle_failed";
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED"); await lockLedgers(c);
    await c.query("UPDATE requests SET payment_status=$2, settle_tx=$3, settle_error=$4, settle_via=$5, payment_valid_before=COALESCE($6, payment_valid_before) WHERE request_id=$1",
      [request_id, status, s.tx ?? null, s.ok ? null : (s.error ?? "unknown"), s.via ?? extra.via ?? null, extra.valid_before ?? null]);
    const comp = status === "settle_failed" ? await compensateInTx(c, request_id, "settle_failed") : null;
    await c.query("COMMIT");
    return { status, compensation: comp };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    // last resort: at least record the status; the sweeper compensates later
    await pool.query("UPDATE requests SET payment_status=$2, settle_error=$3 WHERE request_id=$1", [request_id, status, s.error ?? null]).catch(() => {});
    throw e;
  } finally { c.release(); }
}

/** On-chain truth for an EIP-3009 authorization. Injectable for tests. */
export type AuthChecker = (a: { request_id?: string; payment_ref?: string; mode: string; chain_id: number | null; payer: string; nonce: string | null; tx: string | null }) => Promise<boolean | null>;   // true used, false unused, null unknown
const defaultChecker: AuthChecker = async a => {
  if (a.mode === "mock") return process.env.MOCK_AUTH_STATE === "used" ? true : process.env.MOCK_AUTH_STATE === "unused" ? false : null;
  if (!a.nonce || !a.chain_id) return null;
  const { configuredChains } = await import("./chains"); const { rpcFor } = await import("./facilitator");
  const chain = configuredChains().find(c => c.chainId === a.chain_id); if (!chain) return null;
  return await rpcFor(chain).authorizationState(a.payer, a.nonce);
};
let checker: AuthChecker = defaultChecker;
export const _setAuthChecker = (f: AuthChecker | null) => { checker = f ?? defaultChecker; };
const GRACE_S = 60;
const nowS = () => Math.floor(Date.now() / 1000);
// Never compensate without a known validBefore: legacy rows without it go to admin review instead (no time-based fallback).
const expired = (validBefore: number | null) => validBefore != null && nowS() > validBefore + GRACE_S;
export const STALE_VERIFIED_MIN = () => Number(process.env.SETTLE_STALE_VERIFIED_MIN ?? 10);

async function resolveRequest(r: any) {
  let used: boolean | null = null, err: string | null = null;
  try { used = await checker({ request_id: r.request_id, mode: r.payment_mode, chain_id: r.payment_chain_id, payer: r.payer, nonce: r.nonce, tx: r.settle_tx }); } catch (e: any) { err = String(e?.shortMessage ?? e?.message ?? e).slice(0, 300); }
  await pool.query("UPDATE requests SET settle_checks=settle_checks+1, settle_checked_at=now() WHERE request_id=$1", [r.request_id]);
  if (used === true) {
    await pool.query("UPDATE requests SET payment_status='settled', settle_error=NULL, settle_review=false, settle_tx=COALESCE(settle_tx,'reconciled:authorizationState') WHERE request_id=$1 AND payment_status IN ('settle_unknown','verified')", [r.request_id]);
    return "settled";
  }
  if (used === false && r.payment_valid_before == null) {
    await pool.query("UPDATE requests SET settle_review=true WHERE request_id=$1", [r.request_id]);
    return "review";
  }
  if (used === false && expired(Number(r.payment_valid_before))) {
    const out = await recordSettlement(r.request_id, { ok: false, ambiguous: false, error: `reconciled: authorization unused and expired (was: ${String(r.settle_error ?? "").slice(0, 200)})`, via: r.settle_via, tx: r.settle_tx ?? undefined });
    return out.status;
  }
  if (err) console.error("reconcile", r.request_id, err);
  return "pending";
}

async function resolveTopup(t: any) {
  let used: boolean | null = null;
  try { used = await checker({ payment_ref: t.payment_ref, mode: t.mode, chain_id: t.chain_id, payer: t.payer, nonce: t.nonce, tx: t.settle_tx }); } catch (e: any) { await pool.query("UPDATE topup_pending SET checks=checks+1, last_error=$2 WHERE payment_ref=$1", [t.payment_ref, String(e?.message ?? e).slice(0, 300)]); return "pending"; }
  await pool.query("UPDATE topup_pending SET checks=checks+1 WHERE payment_ref=$1", [t.payment_ref]);
  if (used === true && /^feed_(basic|pro)$/.test(t.target)) {
    const dup = (await pool.query("SELECT 1 FROM feed_periods WHERE payment_ref=$1", [t.payment_ref])).rows.length;
    if (!dup) { const { settingsAt, currentSettings } = await import("./settings"); const v = t.credit_meta?.settings_version;
      const S = v ? await settingsAt(pool, v) : (await currentSettings()).settings;
      await (await import("./feed")).grantPeriod(t.payer, t.target.slice(5), S, v ?? null, { ...t.credit_meta, settle_tx: t.settle_tx ?? "reconciled:authorizationState", payment_ref: t.payment_ref }); }
    await pool.query("UPDATE topup_pending SET state='credited', resolved_at=now() WHERE payment_ref=$1", [t.payment_ref]);
    return "credited";
  }
  if (used === true && t.target === "search_credits") {
    const dup = (await pool.query("SELECT 1 FROM search_credit_ledger WHERE payment_ref=$1", [t.payment_ref])).rows.length;
    if (!dup) await (await import("./credits")).creditTopup(t.payer, Number(t.amount_atomic), { ...t.credit_meta, settle_tx: t.settle_tx ?? "reconciled:authorizationState", payment_ref: t.payment_ref });
    await pool.query("UPDATE topup_pending SET state='credited', resolved_at=now() WHERE payment_ref=$1", [t.payment_ref]);
    return "credited";
  }
  if (used === true) {
    const { credit } = await import("./market");
    const dup = (await pool.query("SELECT 1 FROM balance_ledger WHERE payment_ref=$1", [t.payment_ref])).rows.length;
    if (!dup) await credit(t.advertiser_id, Number(t.amount_atomic), "topup_x402", { ...t.credit_meta, settle_tx: t.settle_tx ?? "reconciled:authorizationState", payment_ref: t.payment_ref });
    await pool.query("UPDATE topup_pending SET state='credited', resolved_at=now() WHERE payment_ref=$1", [t.payment_ref]);
    return "credited";
  }
  if (used === false && t.valid_before == null) { await pool.query("UPDATE topup_pending SET state='review', last_error='admin review: no validBefore' WHERE payment_ref=$1", [t.payment_ref]); return "review"; }
  if (used === false && expired(Number(t.valid_before))) {
    await pool.query("UPDATE topup_pending SET state='failed', resolved_at=now() WHERE payment_ref=$1", [t.payment_ref]); return "failed";
  }
  return "pending";
}

let running = false;
/** Reconcile settle_unknown requests/top-ups and compensate leftover billed + settle_failed requests. */
export async function sweep(limit = 200) {
  if (running) return { skipped: "busy" };
  running = true;
  try {
    const out = { unknown_settled: 0, unknown_failed: 0, unknown_pending: 0, review: 0, compensated: 0, topups_credited: 0, topups_failed: 0 };
    const unk = (await pool.query(`SELECT r.request_id, r.payment_mode, r.payment_chain_id, r.payer, r.settle_tx, r.settle_error, r.settle_via, r.payment_valid_before, r.received_at, n.nonce
        FROM requests r LEFT JOIN payment_nonces n ON n.payment_ref = r.payment_ref
       WHERE (r.payment_status='settle_unknown' OR (r.payment_status='verified' AND r.received_at < now() - make_interval(mins => $2)))
         AND NOT r.settle_review ORDER BY r.received_at LIMIT $1`, [limit, STALE_VERIFIED_MIN()])).rows;
    for (const r of unk) { const s = await resolveRequest(r); if (s === "settled") out.unknown_settled++; else if (s === "settle_failed") out.unknown_failed++; else if (s === "review") out.review++; else out.unknown_pending++; }
    for (const { request_id } of (await pool.query("SELECT request_id FROM requests WHERE payment_status='settle_failed' AND billing_status='billed' ORDER BY received_at LIMIT $1", [limit])).rows)
      if ((await voidUnbilledRequest(request_id)).voided) out.compensated++;
    for (const t of (await pool.query("SELECT * FROM topup_pending WHERE state='unknown' ORDER BY created_at LIMIT $1", [limit])).rows) {
      const s = await resolveTopup(t); if (s === "credited") out.topups_credited++; else if (s === "failed") out.topups_failed++;
    }
    return out;
  } finally { running = false; }
}
export type { PoolClient };
