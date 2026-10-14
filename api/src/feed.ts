// Bulk catalogue data feed: paginated snapshot export + incremental change feed (listing seq). Access by API key (bfk_...) bound
// to the payer wallet of an x402 (testnet) monthly tier purchase; each feed request consumes one unit of the active month's
// quota atomically and is logged in feed_usage. Same prepaid pattern as search credits: settle first, then grant; no refunds.
import { randomBytes } from "node:crypto";
import { pool } from "./db";
import { sha256 } from "./canonical";
import type { Settings } from "./settings";
export const FEED_KEY_RE = /^bfk_[0-9a-f]{48}$/;
export const FEED_LOCK = 424245;
export type Tier = "basic" | "pro";
export const TIERS: Tier[] = ["basic", "pro"];
export const PERIOD_DAYS = 30;
export const tierOf = (S: Settings, t: Tier) => ({ tier: t, price_atomic: S[`feed_${t}_price_atomic`], monthly_quota: S[`feed_${t}_quota`], max_page: S[`feed_${t}_max_page`], period_days: PERIOD_DAYS });
const norm = (w: string) => String(w).toLowerCase();

export async function feedAccountByKey(key: string | null | undefined): Promise<{ wallet: string } | null> {
  if (!key || !FEED_KEY_RE.test(key)) return null;
  return (await pool.query("SELECT wallet FROM feed_accounts WHERE api_key_hash=$1", [sha256(key)])).rows[0] ?? null;
}
/** Grant one month of `tier` (after settlement). Starts now, or queued after the wallet's last unexpired period. Key on first grant / rotate. */
export async function grantPeriod(wallet: string, tier: Tier, S: Settings, settings_version: number | null, extra: { payment_ref?: string; settle_tx?: string | null; payment_network?: string; payment_chain_id?: number | null; settle_via?: string; pay_to?: string; tos_version?: number; tos_hash?: string; tos_proof?: any; kind?: "purchase_x402" | "admin_grant"; price_atomic?: number }, rotate_key = false) {
  const w = norm(wallet), T = tierOf(S, tier);
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [FEED_LOCK, w]);
    const exists = (await c.query("SELECT 1 FROM feed_accounts WHERE wallet=$1", [w])).rows.length > 0;
    let api_key: string | null = null;
    if (!exists || rotate_key) {
      api_key = "bfk_" + randomBytes(24).toString("hex");
      if (exists) await c.query("UPDATE feed_accounts SET api_key_hash=$2, key_rotated_at=now() WHERE wallet=$1", [w, sha256(api_key)]);
      else await c.query("INSERT INTO feed_accounts(wallet, api_key_hash) VALUES ($1,$2)", [w, sha256(api_key)]);
    }
    const start = (await c.query("SELECT GREATEST(now(), COALESCE(MAX(ends_at), now())) s FROM feed_periods WHERE wallet=$1 AND ends_at > now()", [w])).rows[0].s;
    const p = (await c.query(`INSERT INTO feed_periods(wallet,tier,starts_at,ends_at,quota,max_page,price_atomic,kind,payment_ref,settle_tx,payment_network,payment_chain_id,settle_via,pay_to,tos_version,tos_hash,tos_proof,settings_version)
        VALUES ($1,$2,$3,$3::timestamptz + make_interval(days => $4),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING period_id, tier, starts_at, ends_at, quota, max_page`,
      [w, tier, start, PERIOD_DAYS, T.monthly_quota, T.max_page, extra.price_atomic ?? T.price_atomic, extra.kind ?? "purchase_x402", extra.payment_ref ?? null, extra.settle_tx ?? null, extra.payment_network ?? null,
       extra.payment_chain_id ?? null, extra.settle_via ?? null, extra.pay_to ?? null, extra.tos_version ?? null, extra.tos_hash ?? null, extra.tos_proof ?? null, settings_version])).rows[0];
    await c.query("COMMIT");
    return { wallet: w, period: p, api_key };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
/** Atomically take one request from the active period; null when there is no active period with quota left. */
export async function consumeQuota(wallet: string) {
  return (await pool.query(`UPDATE feed_periods SET used = used + 1
      WHERE period_id = (SELECT period_id FROM feed_periods WHERE wallet=$1 AND starts_at <= now() AND ends_at > now() AND used < quota ORDER BY starts_at, period_id LIMIT 1 FOR UPDATE)
        AND used < quota RETURNING period_id, tier, quota, used, max_page, ends_at`, [norm(wallet)])).rows[0] ?? null;
}
export async function logUsage(u: { wallet: string; period_id?: number | null; endpoint: string; status: number; cursor_in?: string | null; cursor_out?: string | null; items?: number; catalogue_seq?: number | null; ip?: string }) {
  await pool.query("INSERT INTO feed_usage(wallet,period_id,endpoint,status,cursor_in,cursor_out,items,catalogue_seq,ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [norm(u.wallet), u.period_id ?? null, u.endpoint, u.status, u.cursor_in?.slice(0, 200) ?? null, u.cursor_out ?? null, u.items ?? 0, u.catalogue_seq ?? null, u.ip ?? null]);
}

const COLS = `l.seq::text AS seq, l.listing_id, l.supersedes, l.provider_id, l.name, l.description, l.address, l.kind, l.tags, l.source_url, l.licence_class, l.created_at`;
const item = (r: any) => ({ ...r, seq: Number(r.seq) });
export const encodeCursor = (as_of: number, after: number) => Buffer.from(JSON.stringify({ a: as_of, s: after })).toString("base64url");
export function decodeCursor(c: string): { a: number; s: number } | null {
  try { const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")); return Number.isSafeInteger(o?.a) && Number.isSafeInteger(o?.s) && o.a >= 0 && o.s >= 0 ? o : null; } catch { return null; }
}
/** Snapshot export: current listings as of catalogue seq `as_of` (pinned by the first page, carried in the cursor), seq ascending. */
export async function exportPage(cursor: string | null, limit: number) {
  let as_of: number, after = 0;
  if (cursor) { const d = decodeCursor(cursor); if (!d) throw Object.assign(new Error("invalid cursor"), { status: 400, code: "validation" }); as_of = d.a; after = d.s; }
  else as_of = Number((await pool.query("SELECT COALESCE(MAX(seq),0) s FROM listings")).rows[0].s);
  const rows = (await pool.query(`SELECT ${COLS} FROM listings l WHERE l.seq > $1 AND l.seq <= $2
      AND NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes = l.listing_id AND n.seq <= $2) ORDER BY l.seq LIMIT $3`, [after, as_of, limit + 1])).rows.map(item);
  const more = rows.length > limit, page = rows.slice(0, limit);
  const next = more ? encodeCursor(as_of, page[page.length - 1].seq) : null;
  return { catalogue_seq: as_of, items: page, next_cursor: next, has_more: more, changes_since: as_of };
}
/** Incremental change feed: every catalogue row with seq > since (append-only; an update is a new row that supersedes the old id). */
export async function changesPage(since: number, limit: number) {
  const head = Number((await pool.query("SELECT COALESCE(MAX(seq),0) s FROM listings")).rows[0].s);
  const rows = (await pool.query(`SELECT ${COLS} FROM listings l WHERE l.seq > $1 AND l.seq <= $2 ORDER BY l.seq LIMIT $3`, [since, head, limit + 1])).rows.map(item);
  const more = rows.length > limit, page = rows.slice(0, limit);
  return { since, head_seq: head, changes: page.map(r => ({ op: r.supersedes ? "update" : "add", replaces: r.supersedes, ...r })), next_since: page.length ? page[page.length - 1].seq : since, has_more: more };
}
export async function feedSummary(wallet: string) {
  const w = norm(wallet);
  const periods = (await pool.query(`SELECT period_id::int, tier, starts_at, ends_at, quota, used, max_page, price_atomic::text, kind, settle_tx,
      (starts_at <= now() AND ends_at > now()) AS active FROM feed_periods WHERE wallet=$1 ORDER BY starts_at DESC LIMIT 24`, [w])).rows;
  const usage = (await pool.query(`SELECT endpoint, status, count(*)::int n, COALESCE(sum(items),0)::int items, max(at) last_at FROM feed_usage WHERE wallet=$1 AND at > now() - interval '30 days' GROUP BY 1,2 ORDER BY 1,2`, [w])).rows;
  const active = periods.find((p: any) => p.active) ?? null;
  return { wallet: w, active: active ? { tier: active.tier, quota: active.quota, used: active.used, remaining: active.quota - active.used, max_page: active.max_page, ends_at: active.ends_at } : null,
    periods, usage_30d: usage, refunds: "none" };
}
export async function allFeedAccounts() {
  return (await pool.query(`SELECT a.wallet, a.created_at, a.key_rotated_at,
      (SELECT row_to_json(x) FROM (SELECT tier, quota, used, ends_at FROM feed_periods p WHERE p.wallet=a.wallet AND starts_at<=now() AND ends_at>now() ORDER BY starts_at LIMIT 1) x) AS active,
      (SELECT count(*)::int FROM feed_periods p WHERE p.wallet=a.wallet) periods,
      (SELECT COALESCE(sum(price_atomic),0)::text FROM feed_periods p WHERE p.wallet=a.wallet AND kind='purchase_x402') paid_atomic,
      (SELECT count(*)::int FROM feed_usage u WHERE u.wallet=a.wallet AND u.status=200) requests_ok,
      (SELECT count(*)::int FROM feed_usage u WHERE u.wallet=a.wallet AND u.status<>200) requests_denied,
      (SELECT COALESCE(sum(items),0)::int FROM feed_usage u WHERE u.wallet=a.wallet) items_served,
      (SELECT max(at) FROM feed_usage u WHERE u.wallet=a.wallet) last_at
    FROM feed_accounts a ORDER BY a.created_at`)).rows;
}
