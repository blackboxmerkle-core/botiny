// Click-server integration for the API.
//
// Issuance runs INSIDE the /v1/recommend transaction (caller holds MARKET_LOCK): harvest_tokens,
// short_links and balance_ledger 'incentive_escrow' debits commit or roll back with requests/impressions.
//
// Replay: click tokens/links are kept OUT of the hashed `response` (sibling `click_links`). Tokens carry
// iat, a random nonce and a signature from a rotatable key; incentives never change rank (model C5).
//
// Settlement: escrow is returned per line item through balance_ledger 'incentive_escrow_reversal' rows
// (escrow_ref = entry_id, UNIQUE -> idempotent) when the line can no longer be earned (unclaimed/expired)
// or was clawed back. Vested lines stay with the bot. Settlement holds MARKET_LOCK (so market_seq stays a
// stable replay boundary) and CLICK_LEDGER_LOCK (so a click accrual and a refund of the same line can't race).
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import type { Settings } from "./settings";
import { pool } from "./db";

const CS = join(__dirname, "..", "..", "click-server", "src");
const load = (f: string) => import(pathToFileURL(join(CS, f)).href);
export const CLICK_LEDGER_LOCK = 424244;
const MARKET_LOCK = 424242;
export const isWallet = (w: unknown): w is string => typeof w === "string" && /^0x[0-9a-fA-F]{40}$/.test(w);

type Keys = { kid: string; privateKey: CryptoKey; publicKey: CryptoKey } | null;
let keysP: Promise<Keys> | null = null;
/** Signing key: CLICK_SIGNING_KEY_JWK (Ed25519 private JWK, from the deploy secret store) + CLICK_KID.
 *  Without it, mock/test mode uses an ephemeral key; otherwise incentives are disabled (no links). */
export function clickKeys(): Promise<Keys> {
  return keysP ??= (async () => {
    const raw = process.env.CLICK_SIGNING_KEY_JWK;
    if (raw) {
      const jwk = JSON.parse(raw);
      const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
      const publicKey = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
      return { kid: process.env.CLICK_KID ?? "k1", privateKey, publicKey };
    }
    if (process.env.PAYMENT_MODE !== "mock" && process.env.CLICK_EPHEMERAL_KEY !== "1") return null;
    const { generateKeyPair } = await load("token.js");
    const kp = await generateKeyPair();
    return { kid: "ephemeral-" + Date.now(), privateKey: kp.privateKey, publicKey: kp.publicKey };
  })();
}
export function _resetClickKeys() { keysP = null; }
// End-user key salt secret (daily-rotated inside the click server). Per-process random if unset.
const KEY_SECRET = process.env.CLICK_KEY_SECRET ?? randomBytes(32).toString("hex");

/** Test hooks (no-ops in production). */
export const _clickHooks: { afterAffordabilityCheck?: () => Promise<void> } = {};

export async function clickConfig(settings?: Settings) {
  const { makeConfig } = await load("config.js");
  const s = settings ?? (await (await import("./settings")).currentSettings()).settings;
  // Fee f = the pinned query price. θ defaults to the ranker's own threshold; override CS_CFG_minRelevance.
  return makeConfig({ feeAtomic: s.query_price_atomic, minRelevance: s.relevance_threshold_ppm / 1e6 }, process.env);
}

let verifyMessageFn: any = null;
async function verifyMessage(a: { address: string; message: string; signature: string }) {
  verifyMessageFn ??= (await import("viem")).verifyMessage;
  return verifyMessageFn({ address: a.address as `0x${string}`, message: a.message, signature: a.signature as `0x${string}` });
}

/** Engine over Postgres (`db` = pool or a transaction client). */
export async function pgEngine(db: { query: PoolClient["query"] }, settings?: Settings) {
  const keys = await clickKeys();
  const { PgStore } = await load("pg-store.js");
  const { ClickEngine } = await load("engine.js");
  const cfg = await clickConfig(settings);
  return new ClickEngine({ store: new PgStore(db), cfg, signingKey: keys?.privateKey, kid: keys?.kid,
    verifyKeys: keys ? { [keys.kid]: keys.publicKey } : {}, keySecret: KEY_SECRET, verifyMessage,
    shortBase: (process.env.CLICK_SHORT_BASE ?? (process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/$/, "") + "/c" : "https://bsrc.link")).replace(/\/$/, "") });
}

const CHANNELS = new Set(["chat", "web", "x", "onchain", "bot"]);
const balanceOf = async (c: PoolClient, p: string) => Number((await c.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id=$1", [p])).rows[0].b);

/**
 * Issue signed per-result links, escrow provider funds, persist — all on `client` (inside the recommend tx).
 * Never-negative + race-safe: each provider's escrow is inserted under a SAVEPOINT and its live balance
 * re-checked; a provider that would go negative (e.g. a concurrent debit) is rolled back and its incentives
 * are zeroed for this set instead of failing the request.
 */
export async function issueClickLinks(client: PoolClient, a: {
  request_id: string; bot_wallet: string | null; channel?: string | null; market_seq: number; settings: Settings;
  results: { rank: number; listing_id: string; address: string; score_ppm: number }[]; providers: string[];
  client_req?: { ip?: string; ua?: string; acceptLanguage?: string };
}) {
  const none = { click_links: [] as any[], debited: [] as string[], config: null as any, kid: null as string | null, skipped: [] as string[] };
  const keys = await clickKeys();
  // Bind tokens ONLY to the verified x402 payer (never to X-Bot-Id): payouts go to that wallet.
  if (!keys || !a.results.length || !isWallet(a.bot_wallet)) return none;
  const wallet = a.bot_wallet.toLowerCase();
  const channel = a.channel && CHANNELS.has(a.channel) ? a.channel : "chat";
  const engine = await pgEngine(client, a.settings);
  const cfg = engine.cfg;
  const { buildResultSet } = await load("curation.js");
  const ids = a.results.map(r => r.listing_id);
  const offers = new Map<string, { s: number; c: number }>((await client.query(
    `SELECT DISTINCT ON (listing_id) listing_id, show_atomic, click_atomic FROM incentive_offers WHERE seq <= $1 AND listing_id = ANY($2) ORDER BY listing_id, seq DESC`,
    [a.market_seq, ids])).rows.map(r => [r.listing_id, { s: Number(r.show_atomic), c: Number(r.click_atomic) }]));
  const advs = new Set((await client.query("SELECT advertiser_id FROM advertisers WHERE advertiser_id = ANY($1)", [[...new Set(a.providers)]])).rows.map(r => r.advertiser_id));
  let ranked = a.results.map((r, i) => {
    const o = offers.get(r.listing_id); const funded = advs.has(a.providers[i]);
    return { listing_id: r.listing_id, response_rank: r.rank, cluster_id: a.providers[i], provider_id: a.providers[i], relevance: r.score_ppm / 1e6, dest_url: r.address,
      show_offer_atomic: funded && o ? o.s : 0, click_offer_atomic: funded && o ? o.c : 0 };
  });
  const needs = () => {
    const m = new Map<string, number>();
    for (const it of buildResultSet(ranked, cfg).items as any[]) if (it.show_atomic + it.click_atomic > 0) m.set(it.cluster_id, (m.get(it.cluster_id) ?? 0) + it.show_atomic + it.click_atomic);
    return m;
  };
  const zero = (bad: Set<string>) => { ranked = ranked.map(r => bad.has(r.cluster_id) ? { ...r, show_offer_atomic: 0, click_offer_atomic: 0 } : r); };
  // cheap pre-check against the live balance
  { const pre = needs(); const bad = new Set<string>(); for (const [p, n] of pre) if ((await balanceOf(client, p)) < n) bad.add(p); zero(bad); }
  if (_clickHooks.afterAffordabilityCheck) await _clickHooks.afterAffordabilityCheck();
  // escrow with per-provider savepoints; iterate because zeroing a provider can rescale others under the set cap
  const skipped = new Set<string>(); let escrowed = new Map<string, number>();
  for (let iter = 0; iter < 5; iter++) {
    await client.query("SAVEPOINT click_escrow");
    const need = needs(); const bad = new Set<string>(); escrowed = new Map();
    for (const [p, amt] of need) {
      await client.query("SAVEPOINT click_escrow_p");
      await client.query(`INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,request_id,note) VALUES ($1,$2,'incentive_escrow',$3,$4)`,
        [p, -amt, a.request_id, `click-server escrow, channel ${channel}`]);
      if ((await balanceOf(client, p)) < 0) { await client.query("ROLLBACK TO SAVEPOINT click_escrow_p"); bad.add(p); }
      else { await client.query("RELEASE SAVEPOINT click_escrow_p"); escrowed.set(p, amt); }
    }
    if (!bad.size) { await client.query("RELEASE SAVEPOINT click_escrow"); break; }
    for (const p of bad) skipped.add(p);
    await client.query("ROLLBACK TO SAVEPOINT click_escrow"); await client.query("RELEASE SAVEPOINT click_escrow");
    zero(skipped);
    if (iter === 4) { zero(new Set(ranked.map(r => r.cluster_id))); escrowed = new Map(); }
  }
  const set = await engine.issueSet({ set_id: a.request_id, request_id: a.request_id, bot_wallet: wallet, channel, ranked });
  // the signed amounts must equal what was escrowed, per provider
  const signed = new Map<string, number>();
  for (const r of set.results) { const p = ranked.find(x => x.listing_id === r.listing_id)!.provider_id; const v = r.show_incentive_atomic + r.click_incentive_atomic; if (v) signed.set(p, (signed.get(p) ?? 0) + v); }
  for (const p of new Set([...signed.keys(), ...escrowed.keys()])) if ((signed.get(p) ?? 0) !== (escrowed.get(p) ?? 0)) throw new Error(`escrow mismatch for ${p}`);
  if (a.client_req) await engine.noteBotApiCall(wallet, a.client_req);
  const config = { fee_atomic: cfg.feeAtomic, line_item_cap_mult: cfg.lineItemCapMult, cluster_cap_mult: cfg.clusterCapMult, set_cap_mult: cfg.setCapMult,
    max_slots_per_cluster: cfg.maxSlotsPerCluster, min_relevance: cfg.minRelevance, min_distinct_clusters: cfg.minDistinctClusters, channel, skipped: [...skipped] };
  const click_links = set.results.map((r: any) => ({ rank: r.rank, listing_id: r.listing_id, short_url: r.short_url, track_url: r.track_url, harvest_token: r.harvest_token,
    show_incentive_atomic: r.show_incentive_atomic, click_incentive_atomic: r.click_incentive_atomic, disclosure: r.disclosure }));
  return { click_links, debited: [...escrowed.keys()], config, kid: keys.kid, skipped: [...skipped] };
}

async function withLocks<T>(locks: number[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    for (const l of locks) await c.query("SELECT pg_advisory_xact_lock($1)", [l]);
    const out = await fn(c); await c.query("COMMIT"); return out;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

/** Queue consumer: score one click event in a transaction serialised with settlement on CLICK_LEDGER_LOCK. */
export function scoreClick(ev: any) {
  return withLocks([CLICK_LEDGER_LOCK], async c => (await pgEngine(c)).scoreClick(ev));
}
export function clawbackClick(click_id: string, reason: string, now = Date.now()) {
  return withLocks([CLICK_LEDGER_LOCK], async c => (await pgEngine(c)).clawbackClick(click_id, now, reason));
}
export async function clearReview(entry_id: string, now = Date.now()) {
  const { clearReview: cr } = await load("ledger.js");
  return withLocks([CLICK_LEDGER_LOCK], async c => { const e = await pgEngine(c); return cr(e.store, entry_id, now, e.cfg); });
}

/**
 * Idempotent settlement pass: (1) vest held lines past holdback; (2) return escrow for lines that can no
 * longer be earned (no accrual and past deadline+grace) or were clawed back. Positive reversal rows only,
 * so balances can't go negative. Safe to run concurrently / repeatedly.
 */
export async function settleIncentives(now = Date.now()) {
  const { releaseDue } = await load("ledger.js");
  return withLocks([MARKET_LOCK, CLICK_LEDGER_LOCK], async c => {
    const e = await pgEngine(c);
    const vested = (await releaseDue(e.store, now)).length;
    const cand = (await c.query(`
      WITH lines AS (
        SELECT h.token, h.request_id, h.listing_id, h.provider_id, h.channel, h.issued_at, h.expires_at, v.line, v.amount, h.token || ':' || v.line AS entry_id
          FROM harvest_tokens h CROSS JOIN LATERAL (VALUES ('show', h.show_atomic), ('click', h.click_atomic)) v(line, amount)
         WHERE v.amount > 0),
      st AS (SELECT DISTINCT ON (entry_id) entry_id, kind FROM incentive_ledger ORDER BY entry_id, seq DESC)
      SELECT l.*, st.kind AS last_kind FROM lines l LEFT JOIN st USING (entry_id)
       WHERE NOT EXISTS (SELECT 1 FROM escrow_refunds r WHERE r.entry_id = l.entry_id)
         AND (st.kind = 'clawback'
              OR (st.kind IS NULL AND (CASE WHEN l.line='show' AND l.channel='chat' THEN LEAST(l.issued_at + make_interval(secs => $2::float8/1000), l.expires_at) ELSE l.expires_at END)
                    + make_interval(secs => $3::float8/1000) < to_timestamp($1::float8/1000)))
       ORDER BY l.entry_id`, [now, e.cfg.chatShowClickWindowMs, e.cfg.settleGraceMs])).rows;
    let refunded = 0, refunded_atomic = 0;
    for (const r of cand) {
      const reason = r.last_kind === "clawback" ? "clawback" : "unclaimed";
      const ins = await c.query(`INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,request_id,listing_id,escrow_ref,note)
          VALUES ($1,$2,'incentive_escrow_reversal',$3,$4,$5,$6) ON CONFLICT (escrow_ref) DO NOTHING RETURNING seq`,
        [r.provider_id, Number(r.amount), r.request_id, r.listing_id, r.entry_id, `escrow reversal (${reason})`]);
      if (!ins.rows.length) continue;
      await c.query(`INSERT INTO escrow_refunds(entry_id,token,line,provider_id,amount_atomic,reason,balance_ledger_seq) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [r.entry_id, r.token, r.line, r.provider_id, Number(r.amount), reason, ins.rows[0].seq]);
      refunded++; refunded_atomic += Number(r.amount);
    }
    return { vested, refunded, refunded_atomic };
  });
}

/** Earnings view for a wallet (states from incentive_ledger + refunds). */
export async function earnings(wallet: string) {
  const { balances } = await load("ledger.js");
  const e = await pgEngine(pool);
  return { bot_wallet: wallet, ...(await balances(e.store, wallet)) };
}

let timer: NodeJS.Timeout | null = null;
/** Opt-in background settlement (CLICK_SETTLE_INTERVAL_MS). */
export function startSettlementLoop() {
  const ms = Number(process.env.CLICK_SETTLE_INTERVAL_MS ?? 0);
  if (!ms || timer) return;
  timer = setInterval(() => { settleIncentives().catch(e => console.error("settle", e)); }, ms); timer.unref();
}
