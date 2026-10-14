// Prepaid search credits for searcher bots: same pattern as the advertiser prepaid balance (append-only ledger, x402 top-up
// credited only after on-chain settlement, in-transaction non-negative check, no refunds). The API key is bound to the payer
// wallet that paid the top-up; only its sha256 is stored and the key is returned exactly once.
import { randomBytes } from "node:crypto";
import { pool } from "./db";
import { sha256 } from "./canonical";
type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
export const CREDIT_KEY_RE = /^bck_[0-9a-f]{48}$/;
export const CREDIT_LOCK = 424244;
const norm = (w: string) => String(w).toLowerCase();

export async function creditAccountByKey(key: string | null | undefined): Promise<{ wallet: string } | null> {
  if (!key || !CREDIT_KEY_RE.test(key)) return null;
  return (await pool.query("SELECT wallet FROM search_credit_accounts WHERE api_key_hash=$1", [sha256(key)])).rows[0] ?? null;
}
export async function creditBalance(db: Q, wallet: string) {
  return Number((await db.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM search_credit_ledger WHERE wallet=$1", [norm(wallet)])).rows[0].b);
}
/** Credit a settled top-up; creates the account (and returns a fresh key) on first top-up, or when rotate_key is set
 *  (the signed, settled payment proves control of the wallet). Idempotent per payment_ref (UNIQUE). */
export async function creditTopup(wallet: string, amount: number, extra: { payment_ref: string; settle_tx?: string | null; payment_network?: string; payment_chain_id?: number | null; settle_via?: string; pay_to?: string; tos_version?: number; tos_hash?: string; tos_proof?: any; note?: string; kind?: "topup_x402" | "admin_credit" }, rotate_key = false) {
  const w = norm(wallet);
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CREDIT_LOCK, w]);
    const exists = (await c.query("SELECT 1 FROM search_credit_accounts WHERE wallet=$1", [w])).rows.length > 0;
    let api_key: string | null = null;
    if (!exists || rotate_key) {
      api_key = "bck_" + randomBytes(24).toString("hex");
      if (exists) await c.query("UPDATE search_credit_accounts SET api_key_hash=$2, key_rotated_at=now() WHERE wallet=$1", [w, sha256(api_key)]);
      else await c.query("INSERT INTO search_credit_accounts(wallet, api_key_hash) VALUES ($1,$2)", [w, sha256(api_key)]);
    }
    await c.query(`INSERT INTO search_credit_ledger(wallet,delta_atomic,kind,payment_ref,settle_tx,payment_network,payment_chain_id,settle_via,pay_to,tos_version,tos_hash,tos_proof,note)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [w, amount, extra.kind ?? "topup_x402", extra.payment_ref, extra.settle_tx ?? null, extra.payment_network ?? null, extra.payment_chain_id ?? null,
      extra.settle_via ?? null, extra.pay_to ?? null, extra.tos_version ?? null, extra.tos_hash ?? null, extra.tos_proof ?? null, extra.note ?? null]);
    const balance_atomic = await creditBalance(c, w);
    await c.query("COMMIT");
    return { wallet: w, balance_atomic, api_key, key_issued: !!api_key };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
/** Inside the recommend transaction: lock the wallet, debit, refuse to go negative. Returns null when insufficient. */
export async function debitForQuery(c: Q, wallet: string, amount: number, request_id: string) {
  const w = norm(wallet);
  await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CREDIT_LOCK, w]);
  const bal = await creditBalance(c, w);
  if (bal < amount) return null;
  await c.query("INSERT INTO search_credit_ledger(wallet,delta_atomic,kind,request_id,note) VALUES ($1,$2,'query_debit',$3,'per-query fee')", [w, -amount, request_id]);
  const after = await creditBalance(c, w);
  if (after < 0) throw Object.assign(new Error("credit balance would go negative"), { status: 409 });
  return { balance_atomic: after };
}
/** The ToS acceptance carried by the wallet's latest x402 top-up (credit searches inherit it). */
export async function latestTopupTos(db: Q, wallet: string) {
  return (await db.query("SELECT tos_version, tos_hash, tos_proof FROM search_credit_ledger WHERE wallet=$1 AND kind='topup_x402' ORDER BY seq DESC LIMIT 1", [norm(wallet)])).rows[0] ?? null;
}
export async function creditSummary(wallet: string, query_price_atomic: number) {
  const w = norm(wallet);
  const t = (await pool.query(`SELECT COALESCE(SUM(delta_atomic),0)::text balance, COALESCE(SUM(delta_atomic) FILTER (WHERE kind<>'query_debit'),0)::text purchased,
      COALESCE(-SUM(delta_atomic) FILTER (WHERE kind='query_debit'),0)::text spent, COUNT(*) FILTER (WHERE kind='query_debit')::int queries,
      MAX(created_at) FILTER (WHERE kind='query_debit') last_query_at FROM search_credit_ledger WHERE wallet=$1`, [w])).rows[0];
  const ledger = (await pool.query("SELECT seq::int, created_at, kind, delta_atomic::text, request_id, settle_tx, payment_network FROM search_credit_ledger WHERE wallet=$1 ORDER BY seq DESC LIMIT 50", [w])).rows
    .map((r: any) => ({ ...r, delta_atomic: Number(r.delta_atomic) }));
  const bal = Number(t.balance);
  return { wallet: w, balance_atomic: bal, purchased_atomic: Number(t.purchased), spent_atomic: Number(t.spent), credit_queries: t.queries, last_query_at: t.last_query_at,
    query_price_atomic, queries_remaining: Math.floor(bal / query_price_atomic), refunds: "none (credits are non-refundable)", ledger };
}
export async function allCreditAccounts() {
  return (await pool.query(`SELECT a.wallet, a.created_at, a.key_rotated_at, COALESCE(SUM(l.delta_atomic),0)::text balance_atomic,
      COALESCE(SUM(l.delta_atomic) FILTER (WHERE l.kind<>'query_debit'),0)::text purchased_atomic,
      COALESCE(-SUM(l.delta_atomic) FILTER (WHERE l.kind='query_debit'),0)::text spent_atomic,
      COUNT(l.*) FILTER (WHERE l.kind='query_debit')::int credit_queries,
      COUNT(l.*) FILTER (WHERE l.kind='query_debit' AND l.created_at > now() - interval '24 hours')::int queries_24h,
      MAX(l.created_at) FILTER (WHERE l.kind='query_debit') last_query_at
    FROM search_credit_accounts a LEFT JOIN search_credit_ledger l USING (wallet) GROUP BY 1,2,3 ORDER BY 1`)).rows;
}
