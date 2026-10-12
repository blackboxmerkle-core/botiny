import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { sha256 } from "./canonical";
import { currentSettings } from "./settings";
/** Every writer of listings / balance_ledger / listing_bid_events and every paid recommend takes this lock,
 *  so "max(seq) committed" read under the lock is a stable snapshot boundary for replay. */
export const MARKET_LOCK = 424242;
export async function withMarketLock<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await c.query("SELECT pg_advisory_xact_lock($1)", [MARKET_LOCK]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
export async function marketSeq(c: { query: PoolClient["query"] }) {
  return Number((await c.query(`SELECT GREATEST((SELECT COALESCE(MAX(seq),0) FROM balance_ledger),(SELECT COALESCE(MAX(seq),0) FROM listing_bid_events),(SELECT COALESCE(MAX(seq),0) FROM incentive_offers),(SELECT COALESCE(MAX(seq),0) FROM incentive_pool_ledger)) AS m`)).rows[0].m);
}
export async function balanceOf(c: { query: PoolClient["query"] }, adv: string) {
  return Number((await c.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id=$1", [adv])).rows[0].b);
}
export async function assertNonNegative(c: { query: PoolClient["query"] }, advs: string[]) {
  for (const a of new Set(advs)) if ((await balanceOf(c, a)) < 0) throw Object.assign(new Error(`balance would go negative for ${a}`), { status: 409 });
}
export const ADV_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
export async function createAdvertiser(id: string, name: string) {
  if (!ADV_ID_RE.test(id)) throw Object.assign(new Error("bad advertiser_id"), { status: 400 });
  const key = "adv_" + randomBytes(24).toString("hex");
  await pool.query("INSERT INTO advertisers(advertiser_id,name,api_key_hash) VALUES ($1,$2,$3)", [id, name || id, sha256(key)]);
  return { advertiser_id: id, api_key: key };
}
export async function advertiserByKey(key: string | undefined | null) {
  if (!key) return null;
  return (await pool.query("SELECT advertiser_id, name FROM advertisers WHERE api_key_hash=$1", [sha256(key)])).rows[0] ?? null;
}
export async function credit(adv: string, amount: number, kind: "admin_credit" | "topup_x402", extra: { settle_tx?: string; payment_ref?: string; payer?: string; note?: string; payment_network?: string; payment_chain_id?: number | null; settle_via?: string; tos_version?: number; tos_hash?: string; tos_proof?: any; pay_to?: string } = {}) {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) throw Object.assign(new Error("amount_atomic must be 1..10000000"), { status: 400 });
  return withMarketLock(async c => {
    const r = await c.query(`INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,settle_tx,payment_ref,payer,note,payment_network,payment_chain_id,settle_via,tos_version,tos_hash,tos_proof,pay_to)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING seq`,
      [adv, amount, kind, extra.settle_tx ?? null, extra.payment_ref ?? null, extra.payer ?? null, extra.note ?? null, extra.payment_network ?? null, extra.payment_chain_id ?? null,
       extra.settle_via ?? null, extra.tos_version ?? null, extra.tos_hash ?? null, extra.tos_proof ?? null, extra.pay_to ?? null]);
    return { seq: Number(r.rows[0].seq), balance_atomic: await balanceOf(c, adv) };
  });
}
export async function currentBid(c: { query: PoolClient["query"] }, listing: string) {
  const r = (await c.query("SELECT bid_atomic, paused FROM listing_bid_events WHERE listing_id=$1 ORDER BY seq DESC LIMIT 1", [listing])).rows[0];
  return { bid_atomic: r ? Number(r.bid_atomic) : 0, paused: r ? r.paused : false };
}
export async function setBid(listing: string, patch: { bid_atomic?: number; paused?: boolean }, by: string, ownerCheck?: string) {
  const { settings } = await currentSettings();
  if (patch.bid_atomic !== undefined && (!Number.isSafeInteger(patch.bid_atomic) || patch.bid_atomic < 0 || patch.bid_atomic > settings.max_bid_atomic))
    throw Object.assign(new Error(`bid_atomic must be integer 0..${settings.max_bid_atomic}`), { status: 400 });
  return withMarketLock(async c => {
    const l = (await c.query("SELECT provider_id FROM listings WHERE listing_id=$1", [listing])).rows[0];
    if (!l) throw Object.assign(new Error("listing not found"), { status: 404 });
    if (ownerCheck && l.provider_id !== ownerCheck) throw Object.assign(new Error("not your listing"), { status: 403 });
    const cur = await currentBid(c, listing);
    const next = { bid_atomic: patch.bid_atomic ?? cur.bid_atomic, paused: patch.paused ?? cur.paused };
    const r = await c.query("INSERT INTO listing_bid_events(listing_id,bid_atomic,paused,set_by) VALUES ($1,$2,$3,$4) RETURNING seq", [listing, next.bid_atomic, next.paused, by]);
    return { listing_id: listing, ...next, seq: Number(r.rows[0].seq) };
  });
}
export async function advertiserSummary(adv: string) {
  const q = async (s: string, p: any[]) => (await pool.query(s, p)).rows;
  const tot = (await q(`SELECT COALESCE(SUM(delta_atomic),0)::text balance,
      COALESCE(SUM(delta_atomic) FILTER (WHERE kind='topup_x402'),0)::text topups_onchain,
      COALESCE(SUM(delta_atomic) FILTER (WHERE kind='admin_credit'),0)::text admin_credits,
      COALESCE(-SUM(delta_atomic) FILTER (WHERE kind='impression_debit'),0)::text spend,
      COUNT(*) FILTER (WHERE kind='impression_debit')::int sponsored_impressions FROM balance_ledger WHERE advertiser_id=$1`, [adv]))[0];
  const listings = await q(`SELECT l.listing_id, l.name, l.kind, l.address,
      COALESCE((SELECT bid_atomic FROM listing_bid_events e WHERE e.listing_id=l.listing_id ORDER BY seq DESC LIMIT 1),0)::int bid_atomic,
      COALESCE((SELECT paused FROM listing_bid_events e WHERE e.listing_id=l.listing_id ORDER BY seq DESC LIMIT 1),false) paused,
      (SELECT count(*)::int FROM impressions i WHERE i.listing_id=l.listing_id AND i.sponsored) sponsored_impressions,
      (SELECT count(*)::int FROM impressions i WHERE i.listing_id=l.listing_id AND NOT i.sponsored) organic_impressions
    FROM listings l WHERE l.provider_id=$1 AND NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id) ORDER BY l.seq`, [adv]);
  const ledger = await q(`SELECT seq::int, created_at, kind, delta_atomic::text, request_id, listing_id, settle_tx, note FROM balance_ledger WHERE advertiser_id=$1 ORDER BY seq DESC LIMIT 50`, [adv]);
  return { advertiser_id: adv, ...tot, listings, ledger };
}

export const MAX_INCENTIVE_ATOMIC = 1_000_000;
/** Advertiser sets per-listing show/click incentive offers (append-only, market_seq-sequenced). Caps apply at issue time. */
export async function setIncentive(listing: string, patch: { show_atomic?: number; click_atomic?: number; budget_atomic?: number | null; expires_at?: string | null }, by: string, ownerCheck?: string) {
  for (const k of ["show_atomic", "click_atomic"] as const) {
    const v = patch[k];
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0 || v > MAX_INCENTIVE_ATOMIC)) throw Object.assign(new Error(`${k} must be integer 0..${MAX_INCENTIVE_ATOMIC}`), { status: 400 });
  }
  if (patch.budget_atomic != null && (!Number.isSafeInteger(patch.budget_atomic) || patch.budget_atomic <= 0 || patch.budget_atomic > 1_000_000_000_000)) throw Object.assign(new Error("budget_atomic must be integer 1..1e12"), { status: 400 });
  let exp: Date | null = null;
  if (patch.expires_at != null) { exp = new Date(patch.expires_at); if (isNaN(+exp) || exp <= new Date() || +exp - Date.now() > 366 * 86_400_000) throw Object.assign(new Error("expires_at must be a future time within 366 days"), { status: 400 }); }
  return withMarketLock(async c => {
    const l = (await c.query("SELECT provider_id FROM listings WHERE listing_id=$1", [listing])).rows[0];
    if (!l) throw Object.assign(new Error("listing not found"), { status: 404 });
    if (ownerCheck && l.provider_id !== ownerCheck) throw Object.assign(new Error("not your listing"), { status: 403 });
    const cur = (await c.query("SELECT show_atomic, click_atomic, budget_atomic, expires_at, created_at FROM incentive_offers WHERE listing_id=$1 ORDER BY seq DESC LIMIT 1", [listing])).rows[0];
    const { DEFAULT_OFFER_DAYS } = await import("./pacing");
    // expiry: explicit, else carried over, else first offer + 30d (offers are never open-ended)
    const first = (await c.query("SELECT MIN(created_at) f FROM incentive_offers WHERE listing_id=$1", [listing])).rows[0].f;
    const expires_at = exp ?? cur?.expires_at ?? new Date((first ? +new Date(first) : Date.now()) + DEFAULT_OFFER_DAYS * 86_400_000);
    const next = { show_atomic: patch.show_atomic ?? Number(cur?.show_atomic ?? 0), click_atomic: patch.click_atomic ?? Number(cur?.click_atomic ?? 0),
      budget_atomic: patch.budget_atomic !== undefined ? patch.budget_atomic : (cur?.budget_atomic == null ? null : Number(cur.budget_atomic)) };
    const r = await c.query("INSERT INTO incentive_offers(listing_id,show_atomic,click_atomic,budget_atomic,expires_at,set_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING seq",
      [listing, next.show_atomic, next.click_atomic, next.budget_atomic, expires_at, by]);
    return { listing_id: listing, ...next, expires_at: new Date(expires_at).toISOString(), seq: Number(r.rows[0].seq) };
  });
}
