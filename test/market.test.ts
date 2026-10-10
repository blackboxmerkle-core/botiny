import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "test-pass";
const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
let base = ""; let server: any;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const H = { "content-type": "application/json", ...AUTH };
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
let n = 0;
const rec = (query: string, k = 5, extra: Record<string, string> = {}) => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": `mock:m${Date.now()}${n++}`, ...extra }, body: JSON.stringify({ query, k }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const balance = async (a: string) => Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id=$1", [a])).rows[0].b);
const listing = async (provider_id: string, name: string, description: string) =>
  (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id, name, description, address: "https://" + provider_id.replace(/\W/g, "") + ".example", kind: "mcp" }) })).json();
const Q = "MCP server for browser automation";
let key = "", L1 = "", L2 = "";

test("setup advertiser with two bidding listings; promotion is transparent and debited in the same tx", async () => {
  const a = await admin("/advertisers", { advertiser_id: "adv:brow", name: "Brow" });
  assert.equal(a.status, 201); key = a.api_key;
  L1 = (await listing("adv:brow", "Brow web helper", "Hosted helper tools for agents including browser automation")).listing_id;
  L2 = (await listing("adv:brow", "Brow web helper lite", "Lightweight hosted helper with browser automation")).listing_id;
  const organic = await rec(Q);
  const pos = organic.response.results.findIndex((r: any) => r.listing_id === L1);
  assert.ok(organic.response.results.every((r: any) => r.sponsored === false), "no balance yet -> nothing sponsored");
  // fixed 100 + bid 300 = 400 per promoted impression; credit exactly ONE promoted impression's worth
  await admin(`/advertisers/adv:brow/credit`, { amount_atomic: 400 });
  for (const l of [L1, L2]) assert.equal((await fetch(`${base}/v1/advertisers/me/listings/${l}/bid`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ bid_atomic: 300 }) })).status, 200);
  const p = await rec(Q);
  const sp = p.response.results.filter((r: any) => r.sponsored);
  assert.equal(sp.length, 1, "balance covers exactly one promoted impression -> only one promoted (never negative)");
  assert.equal(p.response.results[0].sponsored, true);
  assert.equal(p.response.results[0].label, "Sponsored");
  assert.equal(p.response.results[0].advertiser, "adv:brow");
  assert.ok(pos === -1 || pos > 0, "organic position is below the promoted top slot");
  assert.equal(await balance("adv:brow"), 0);
  const tx = (await pool.query(`SELECT (SELECT db_txid FROM requests WHERE request_id=$1)::text r,
      (SELECT array_agg(DISTINCT db_txid::text) FROM impressions WHERE request_id=$1) i,
      (SELECT array_agg(DISTINCT db_txid::text) FROM balance_ledger WHERE request_id=$1) b`, [p.request_id])).rows[0];
  assert.deepEqual(tx.i, [tx.r]); assert.deepEqual(tx.b, [tx.r]);
  const imp = (await pool.query("SELECT sponsored, fixed_atomic::int f, bid_atomic::int b, charge_micro_usdc::int c FROM impressions WHERE request_id=$1 AND sponsored", [p.request_id])).rows;
  assert.deepEqual(imp, [{ sponsored: true, f: 100, b: 300, c: 400 }]);
});

test("promotion drops off when depleted; listing falls back to organic, free, lower rank; balance never negative", async () => {
  const r = await rec(Q);
  assert.ok(r.response.results.every((x: any) => !x.sponsored));
  const i = r.response.results.findIndex((x: any) => x.listing_id === L1);
  assert.ok(i !== 0, "no longer in top slot");
  assert.equal(await balance("adv:brow"), 0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM balance_ledger WHERE request_id=$1", [r.request_id])).rows[0].n, 0);
  const neg = (await pool.query("SELECT advertiser_id FROM balance_ledger GROUP BY 1 HAVING SUM(delta_atomic) < 0")).rows;
  assert.equal(neg.length, 0);
});

test("debit atomicity: failure after impressions/debits rolls back everything", async () => {
  await admin(`/advertisers/adv:brow/credit`, { amount_atomic: 2000 });
  const b0 = await balance("adv:brow");
  const c0 = (await pool.query("SELECT (SELECT count(*) FROM requests)::int r, (SELECT count(*) FROM balance_ledger)::int l")).rows[0];
  process.env.FAIL_AFTER_IMPRESSIONS = "1";
  const r = await rec(Q);
  delete process.env.FAIL_AFTER_IMPRESSIONS;
  assert.equal(r.status, 500);
  assert.equal(await balance("adv:brow"), b0);
  assert.deepEqual((await pool.query("SELECT (SELECT count(*) FROM requests)::int r, (SELECT count(*) FROM balance_ledger)::int l")).rows[0], c0);
});

test("concurrent requests never overspend a balance", async () => {
  await pool.query("INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,note) SELECT 'adv:brow', -SUM(delta_atomic), 'admin_credit', 'zero out' FROM balance_ledger WHERE advertiser_id='adv:brow' HAVING SUM(delta_atomic) > 0 AND false");
  const b = await balance("adv:brow"); // 2000 -> at most 5 promoted impressions of 400
  const rs = await Promise.all(Array.from({ length: 8 }, () => rec(Q, 5)));
  const promoted = rs.reduce((a, r) => a + r.response.results.filter((x: any) => x.sponsored).length, 0);
  assert.ok(promoted * 400 <= b);
  assert.ok(await balance("adv:brow") >= 0);
});

test("settings versions: request pins version; replay reproduces after settings change", async () => {
  await admin(`/advertisers/adv:brow/credit`, { amount_atomic: 4000 });
  const r1 = await rec(Q);
  const st = await admin("/settings", { settings: { promoted_slots: 0, relevance_threshold_ppm: 100000 }, note: "test: ads off" });
  assert.ok(st.version > 1);
  const r2 = await rec(Q);
  assert.equal(r2.response.settings_version, st.version);
  assert.notEqual(r1.response.settings_version, r2.response.settings_version);
  assert.ok(r2.response.results.every((x: any) => !x.sponsored));
  for (const r of [r1, r2]) {
    const rp = await (await fetch(`${base}/v1/requests/${r.request_id}/replay`)).json();
    assert.equal(rp.match, true, JSON.stringify(rp)); assert.equal(rp.settings_version, r.response.settings_version);
  }
  // every logged request replays identically (incl. promoted ones and earlier market states)
  for (const { request_id } of (await pool.query("SELECT request_id FROM requests")).rows)
    assert.equal((await (await fetch(`${base}/v1/requests/${request_id}/replay`)).json()).match, true, request_id);
  assert.equal((await admin("/settings", { settings: { promoted_slots: 99 } })).status, 400);
  await admin("/settings", { settings: { promoted_slots: 2, relevance_threshold_ppm: 150000 }, note: "restore" });
});

test("advertiser API: auth, balance view, bid cap, ownership, x402 top-up (mock) with no payment reuse", async () => {
  const B = { "content-type": "application/json", authorization: "Bearer " + key };
  assert.equal((await fetch(base + "/v1/advertisers/me")).status, 401);
  const me = await (await fetch(base + "/v1/advertisers/me", { headers: B })).json();
  assert.equal(me.advertiser_id, "adv:brow"); assert.equal(me.listings.length, 2); assert.ok(Number(me.spend) > 0);
  assert.equal((await fetch(`${base}/v1/advertisers/me/listings/${L1}/bid`, { method: "PUT", headers: B, body: JSON.stringify({ bid_atomic: 999999 }) })).status, 400);
  const other = (await pool.query("SELECT listing_id FROM listings WHERE provider_id LIKE 'seed:%' LIMIT 1")).rows[0].listing_id;
  assert.equal((await fetch(`${base}/v1/advertisers/me/listings/${other}/bid`, { method: "PUT", headers: B, body: JSON.stringify({ bid_atomic: 10 }) })).status, 403);
  assert.equal((await fetch(`${base}/v1/advertisers/me/topup?amount_atomic=5000`, { method: "POST", headers: B })).status, 402);
  const b0 = await balance("adv:brow");
  const pay = { ...B, "X-PAYMENT": "mock:topup" + Date.now() };
  const t = await (await fetch(`${base}/v1/advertisers/me/topup?amount_atomic=5000`, { method: "POST", headers: pay })).json();
  assert.equal(t.credited_atomic, 5000); assert.equal(await balance("adv:brow"), b0 + 5000);
  assert.equal((await fetch(`${base}/v1/advertisers/me/topup?amount_atomic=5000`, { method: "POST", headers: pay })).status, 409);
  assert.equal((await fetch(`${base}/v1/advertisers/me/topup?amount_atomic=99999999`, { method: "POST", headers: pay })).status, 400);
  // admin pause hides the listing entirely
  await admin("/listings/" + L1, { paused: true });
  const r = await rec(Q);
  assert.ok(!r.response.results.some((x: any) => x.listing_id === L1));
  await admin("/listings/" + L1, { paused: false });
});

test("Try-a-search (mock mode) as a sim bot + bot history; admin state requires auth", async () => {
  const t = await (await fetch(base + "/dashboard/api/try", { method: "POST", headers: H, body: JSON.stringify({ bot_id: "dev-bot", query: Q, k: 3 }) })).json();
  assert.equal(t.status, 200); assert.ok(t.request_id && t.response_hash); assert.equal(t.payment.payment_status, "settled");
  assert.equal((await fetch(base + "/dashboard/api/try", { method: "POST", headers: H, body: JSON.stringify({ bot_id: "evil-bot", query: Q }) })).status, 400);
  const h = await (await fetch(base + "/dashboard/api/bots/dev-bot/history", { headers: AUTH })).json();
  assert.equal(h[0].request_id, t.request_id); assert.ok(h[0].results.length > 0);
  assert.equal((await fetch(base + "/dashboard/api/admin/state")).status, 401);
  const s = await (await fetch(base + "/dashboard/api/admin/state", { headers: AUTH })).json();
  assert.ok(s.settings.version >= 1 && s.advertisers.some((a: any) => a.advertiser_id === "adv:brow"));
  assert.ok(!JSON.stringify(s).includes("api_key"));
});
