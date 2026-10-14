import { tosHashOf, DEFAULT_TOS } from "../src/tos";
const TOSH = tosHashOf(DEFAULT_TOS.bot);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "Test-Pass-0123456789";
const AUTH = { authorization: "Basic " + Buffer.from("admin:Test-Pass-0123456789").toString("base64") };
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { rank, RANKER_V3, RANKER_V4, RANKER_VERSION } from "../src/rank";
import { replayRow } from "../src/replay";
import { EMBEDDING_MODEL } from "../src/embed";
import { currentSettings } from "../src/settings";
import { marketSeq } from "../src/market";

let base = ""; let server: any;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const H = { "content-type": "application/json", ...AUTH };
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const setS = (settings: any) => admin("/settings", { settings, note: "test" });
let n = 0;
const W = "0x00000000000000000000000000000000000000c1", W2 = "0x00000000000000000000000000000000000000c2";
const topup = (wallet: string, q = "") => fetch(base + "/v1/credits/topup" + q, { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:cr${Date.now()}${n++}:${wallet}` }, body: "{}" }).then(async r => ({ status: r.status, ...(await r.json()) }));
const search = (key: string, query = "MCP server for browser automation", extra: Record<string, string> = {}) =>
  fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + key, ...extra }, body: JSON.stringify({ query, k: 5 }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const bal = async (w: string) => Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM search_credit_ledger WHERE wallet=$1", [w])).rows[0].b);
const listing = async (provider_id: string, name: string, description: string) =>
  (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id, name, description, address: "https://" + provider_id.replace(/\W/g, "") + n++ + ".example", kind: "mcp" }) })).json();

// ---------------- (A) prepaid search credits ----------------
let key = "";
test("credits: top-up via x402 (ToS-bound) issues a wallet-bound key once; pricing is an admin setting", async () => {
  const p = await (await fetch(base + "/v1/credits/pricing")).json();
  assert.equal(p.pack_price_atomic, 1_000_000); assert.equal(p.queries_per_pack, 1000);
  const unpaid = await fetch(base + "/v1/credits/topup", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unpaid.status, 402);
  const uj = await unpaid.json(); assert.equal(uj.accepts[0].maxAmountRequired, "1000000"); assert.ok(uj.tos);
  const noTos = await fetch(base + "/v1/credits/topup", { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": `mock:x${n++}:${W}` }, body: "{}" });
  assert.equal(noTos.status, 402, "ToS acceptance still required");
  const t = await topup(W);
  assert.equal(t.status, 200, JSON.stringify(t));
  assert.match(t.api_key, /^bck_[0-9a-f]{48}$/); key = t.api_key;
  assert.equal(t.wallet, W); assert.equal(t.balance_atomic, 1_000_000); assert.equal(t.queries_remaining, 1000);
  const row = (await pool.query("SELECT api_key_hash FROM search_credit_accounts WHERE wallet=$1", [W])).rows[0];
  assert.notEqual(row.api_key_hash, key, "only the hash is stored");
  const t2 = await topup(W);
  assert.equal(t2.api_key, null, "second top-up keeps the existing key"); assert.equal(t2.balance_atomic, 2_000_000);
  // reused payment header => 409
  const hdr = `mock:dup${Date.now()}:${W}`;
  const h = { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": hdr };
  assert.equal((await fetch(base + "/v1/credits/topup", { method: "POST", headers: h, body: "{}" })).status, 200);
  assert.equal((await fetch(base + "/v1/credits/topup", { method: "POST", headers: h, body: "{}" })).status, 409);
  assert.equal(await bal(W), 3_000_000);
  // admin setting changes the pack
  assert.equal((await setS({ credit_pack_price_atomic: 2000, credit_pack_credit_atomic: 2000 })).status, 200);
  const t3 = await topup(W2);
  assert.equal(t3.paid_atomic, 2000); assert.equal(t3.balance_atomic, 2000); assert.equal(t3.queries_remaining, 2);
});

test("credits: search debits atomically, logs payment_method=credits + ledger + impressions, replays identically", async () => {
  const before = await bal(W);
  const r = await search(key);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.payment.method, "credits"); assert.equal(r.payment.debited_atomic, 1000);
  assert.equal(r.payment.credit_balance_atomic, before - 1000);
  assert.equal(await bal(W), before - 1000);
  const row = (await pool.query("SELECT * FROM requests WHERE request_id=$1", [r.request_id])).rows[0];
  assert.equal(row.payment_method, "credits"); assert.equal(row.payment_mode, "credits"); assert.equal(row.payer, W);
  assert.equal(row.payment_status, "settled"); assert.equal(row.response_hash, r.response_hash); assert.equal(row.ranker_version, RANKER_V4);
  assert.equal(row.tos_hash, TOSH, "inherits the ToS accepted at top-up");
  const tx = (await pool.query(`SELECT (SELECT db_txid::text FROM requests WHERE request_id=$1) r, (SELECT array_agg(db_txid::text) FROM search_credit_ledger WHERE request_id=$1) l,
     (SELECT array_agg(DISTINCT db_txid::text) FROM impressions WHERE request_id=$1) i`, [r.request_id])).rows[0];
  assert.deepEqual(tx.l, [tx.r]); assert.deepEqual(tx.i, [tx.r]);
  const rp = await (await fetch(`${base}/v1/requests/${r.request_id}/replay`)).json();
  assert.equal(rp.match, true); assert.equal(rp.ranker_version, RANKER_V4);
  const me = await (await fetch(base + "/v1/credits/me", { headers: { authorization: "Bearer " + key } })).json();
  assert.equal(me.wallet, W); assert.equal(me.credit_queries, 1); assert.equal(me.balance_atomic, before - 1000);
  assert.equal((await fetch(base + "/v1/credits/me")).status, 401);
  assert.equal((await search("bck_" + "0".repeat(48))).status, 401);
});

test("credits: insufficient balance => 402 with normal x402 per-query requirements; X-PAYMENT falls back; concurrency never overdraws", async () => {
  const t = await topup("0x00000000000000000000000000000000000000c3");   // pack is now 2000 = 2 queries
  const k3 = t.api_key, W3 = t.wallet;
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => search(k3)));
  assert.equal(rs.filter(r => r.status === 200).length, 2);
  const denied = rs.filter(r => r.status === 402);
  assert.equal(denied.length, 3);
  assert.equal(denied[0].accepts[0].maxAmountRequired, "1000"); assert.equal(denied[0].credits.balance_atomic, 0);
  assert.equal(await bal(W3), 0);
  const fb = await search(k3, "MCP server for browser automation", { "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:fb${n++}:${W3}` });
  assert.equal(fb.status, 200); assert.equal(fb.payment.method, undefined);
  assert.equal((await pool.query("SELECT payment_method FROM requests WHERE request_id=$1", [fb.request_id])).rows[0].payment_method, "per_query");
  // no refunds: there is no credit refund kind at all
  await assert.rejects(pool.query("INSERT INTO search_credit_ledger(wallet,delta_atomic,kind) VALUES ($1,5,'refund')", [W3]));
});

test("credits: bans and per-wallet rate limits apply; rotate_key replaces the key", async () => {
  const b = await admin("/bans", { kind: "wallet", value: W, reason: "test" });
  assert.equal(b.status, 201);
  assert.equal((await search(key)).status, 403);
  assert.equal((await topup(W)).status, 403, "banned wallet cannot top up");
  await admin(`/bans/${b.ban_id}/revoke`, {});
  process.env.RL_EXEMPT_LOOPBACK = "0"; process.env.RL_RECOMMEND_WALLET = "2";
  try {
    const rs = []; for (let i = 0; i < 3; i++) rs.push((await search(key)).status);
    assert.deepEqual(rs, [200, 200, 429]);
  } finally { delete process.env.RL_EXEMPT_LOOPBACK; delete process.env.RL_RECOMMEND_WALLET; }
  const r = await topup(W, "?rotate_key=1");
  assert.match(r.api_key, /^bck_/); assert.notEqual(r.api_key, key);
  assert.equal((await search(key)).status, 401);
  key = r.api_key;
  assert.equal((await search(key)).status, 200);
});

test("credits: dashboard + financials show credits without double counting query revenue", async () => {
  const cr = await fetch(base + "/dashboard/api/credits", { headers: AUTH }); const c = await cr.json(); assert.equal(cr.status, 200, JSON.stringify(c));
  const a = c.accounts.find((x: any) => x.wallet === W); assert.ok(a); assert.ok(a.credit_queries >= 4);
  assert.ok(c.recent.length >= 1);
  const f = await (await fetch(base + "/dashboard/api/financials", { headers: AUTH })).json();
  assert.ok(!f.ledger.some((x: any) => x.type === "bot_query_payment" && x.mode === "credits"));
  assert.ok(f.ledger.some((x: any) => x.type === "bot_credit_topup" && x.counterparty === W));
});

// ---------------- (B) promo-v4 ----------------
const Q = "hosted vector database for agent memory";
test("promo-v4: default ranker; floor, capped labelled slots, band-then-bid ordering, organic never displaced beyond the slots", async () => {
  assert.equal(RANKER_VERSION, RANKER_V4); assert.match(RANKER_V4, /^promo-v4;/);
  const ids: string[] = [];
  for (const [i, d] of ["Hosted vector database for agent memory", "Vector database hosted for agents memory store", "Agent memory with hosted vector search database"].entries()) {
    const adv = `adv:v4_${i}`; assert.equal((await admin("/advertisers", { advertiser_id: adv, name: adv })).status, 201);
    await admin(`/advertisers/${adv}/credit`, { amount_atomic: 100000 });
    const l = await listing(adv, `V4 ${i} ${d}`, d); ids.push(l.listing_id);
    await admin("/listings/" + l.listing_id, { bid_atomic: [100, 3000, 2000][i] });
  }
  const run = async () => { const c = await pool.connect(); try {
    const { version, settings } = await currentSettings(c as any);
    const req = { query: Q, k: 5, catalogue_seq: 1e9, market_seq: await marketSeq(c as any), settings_version: version, pacing_at_ms: Date.now(), embedding_model: EMBEDDING_MODEL };
    return { S: settings, req, v4: await rank(c as any, { ...req, ranker_version: RANKER_V4 }), v3: await rank(c as any, { ...req, ranker_version: RANKER_V3 }) };
  } finally { c.release(); } };
  const check = (S: any, out: any) => {
    const res = out.body.results; const sp = res.filter((r: any) => r.sponsored), org = res.filter((r: any) => !r.sponsored);
    assert.ok(sp.length <= Math.min(S.sponsored_slots_max, S.promoted_slots, 2));
    for (const s of sp) { assert.equal(s.label, "Sponsored"); assert.ok(s.score_ppm >= S.sponsored_floor_ppm); }
    assert.ok(res.slice(0, sp.length).every((r: any) => r.sponsored), "sponsored only in the leading capped slots");
    for (let i = 1; i < sp.length; i++) { const a = sp[i - 1], b = sp[i]; assert.ok(a.relevance_band > b.relevance_band || (a.relevance_band === b.relevance_band && a.bid_atomic >= b.bid_atomic)); }
    for (let i = 1; i < org.length; i++) assert.ok(org[i - 1].score_ppm >= org[i].score_ppm, "organic in pure relevance order");
    return { sp, org };
  };
  // default: 1 slot
  let r = await run(); let { sp } = check(r.S, r.v4);
  assert.equal(r.S.sponsored_slots_max, 1); assert.equal(sp.length, 1);
  const scores = Object.fromEntries(r.v4.body.results.map((x: any) => [x.listing_id, x.score_ppm]));
  // 2 slots, one huge band => pure bid order among sponsored (3000 before 2000)
  assert.equal((await setS({ sponsored_slots_max: 2, relevance_band_ppm: 1000000, sponsored_floor_ppm: 150000 })).status, 200);
  r = await run(); ({ sp } = check(r.S, r.v4)); assert.equal(sp.length, 2);
  assert.deepEqual(sp.map((s: any) => s.bid_atomic), [3000, 2000]);
  // band width 1 => relevance decides, bid only a tiebreak
  assert.equal((await setS({ relevance_band_ppm: 1 })).status, 200);
  r = await run(); ({ sp } = check(r.S, r.v4)); assert.ok(sp[0].score_ppm >= sp[1].score_ppm);
  // floor above every score => nothing sponsored; v3 (replay-only) still promotes on bid
  assert.equal((await setS({ sponsored_floor_ppm: 1000000 })).status, 200);
  r = await run(); ({ sp } = check(r.S, r.v4)); assert.equal(sp.length, 0);
  assert.ok(r.v3.body.results.some((x: any) => x.sponsored), "v3 semantics preserved for replay");
  assert.equal(r.v3.body.ranker_version, RANKER_V3);
  // validation
  assert.equal((await setS({ sponsored_slots_max: 3 })).status, 400);
  assert.equal((await setS({ sponsored_floor_ppm: 100 })).status, 400, "floor must be >= organic threshold");
  await setS({ sponsored_floor_ppm: 250000, sponsored_slots_max: 1, relevance_band_ppm: 50000 });
  assert.ok(Object.keys(scores).length > 0);
});

test("promo-v4: replay dispatches on the stored ranker version (old promo-v3 rows still match)", async () => {
  const c = await pool.connect();
  try {
    const { version } = await currentSettings(c as any);
    const p = { query: Q, k: 5, catalogue_seq: 1e9, market_seq: await marketSeq(c as any), settings_version: version, pacing_at_ms: 1_700_000_000_000, embedding_model: EMBEDDING_MODEL };
    for (const v of [RANKER_V3, RANKER_V4]) {
      const out = await rank(c as any, { ...p, ranker_version: v });
      const row = { request_canonical: JSON.stringify({ query: p.query, k: p.k, pacing_at_ms: p.pacing_at_ms }), catalogue_seq: p.catalogue_seq, embedding_model: EMBEDDING_MODEL, ranker_version: v, market_seq: p.market_seq, settings_version: version };
      assert.equal((await replayRow(row)).hash, out.hash, v.slice(0, 8));
    }
  } finally { c.release(); }
  // every request logged in this file (credits + per-query, all promo-v4) replays identically
  for (const { request_id } of (await pool.query("SELECT request_id FROM requests")).rows)
    assert.equal((await (await fetch(`${base}/v1/requests/${request_id}/replay`)).json()).match, true, request_id);
});
