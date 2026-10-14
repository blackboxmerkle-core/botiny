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

let base = ""; let server: any;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const H = { "content-type": "application/json", ...AUTH };
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
let n = 0;
const W = "0x00000000000000000000000000000000000000d1";
const buy = (url: string, wallet: string) => fetch(base + url, { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:mf${Date.now()}${n++}:${wallet}` }, body: "{}" }).then(async r => ({ status: r.status, ...(await r.json()) }));
let rid = 0;
const mcp = (method: string, params: any, key?: string, extra: Record<string, string> = {}) => fetch(base + "/mcp", { method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(key ? { authorization: "Bearer " + key } : {}), ...extra },
  body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) }).then(async r => ({ status: r.status, body: r.status === 202 ? null : await r.json() }));
const call = (name: string, args: any, key?: string) => mcp("tools/call", { name, arguments: args }, key).then(r => r.body.result);

// ---------------- MCP ----------------
let key = "";
test("mcp: initialize, tools/list, notifications; no key => clear error pointing to /v1/credits/topup", async () => {
  const i = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(i.status, 200); assert.equal(i.body.result.protocolVersion, "2025-06-18"); assert.ok(i.body.result.capabilities.tools);
  const nt = await fetch(base + "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  assert.equal(nt.status, 202);
  const l = await mcp("tools/list", {});
  assert.deepEqual(l.body.result.tools.map((t: any) => t.name), ["botiny_search", "botiny_listing", "botiny_credit_balance"]);
  const r = await call("botiny_search", { query: "x402 facilitator" });
  assert.equal(r.isError, true); assert.equal(r.structuredContent.error, "credit_key_required"); assert.match(r.content[0].text, /\/v1\/credits\/topup/);
  const bad = await call("botiny_search", { query: "x" }, "bck_" + "0".repeat(48));
  assert.equal(bad.structuredContent.error, "credit_key_invalid");
  assert.equal((await mcp("nope", {})).body.error.code, -32601);
  assert.equal((await fetch(base + "/mcp")).status, 405);
  assert.equal((await mcp("ping", {}, undefined, { origin: "https://evil.example" })).status, 403);
});

test("mcp: search debits credits via the same path (logged, replayable); balance + listing tools; insufficient => topup error", async () => {
  await admin("/settings", { settings: { credit_pack_price_atomic: 2000, credit_pack_credit_atomic: 2000 }, note: "2 queries" });
  const t = await buy("/v1/credits/topup", W); assert.equal(t.status, 200); key = t.api_key;
  const r = await call("botiny_search", { query: "MCP server for browser automation", k: 3 }, key);
  assert.ok(!r.isError, JSON.stringify(r));
  const s = r.structuredContent;
  assert.equal(s.payment.method, "credits"); assert.equal(s.payment.credit_balance_atomic, 1000);
  const row = (await pool.query("SELECT * FROM requests WHERE request_id=$1", [s.request_id])).rows[0];
  assert.equal(row.payment_method, "credits"); assert.equal(row.response_hash, s.response_hash); assert.equal(row.bot_id, "mcp");
  assert.equal((await pool.query("SELECT count(*)::int n FROM search_credit_ledger WHERE request_id=$1", [s.request_id])).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int n FROM impressions WHERE request_id=$1", [s.request_id])).rows[0].n, s.response.results.length);
  const rp = await (await fetch(`${base}/v1/requests/${s.request_id}/replay`)).json(); assert.equal(rp.match, true);
  const lid = s.response.results[0].listing_id;
  const l = await call("botiny_listing", { listing_id: lid }, key); assert.equal(l.structuredContent.listing_id, lid);
  assert.equal((await call("botiny_listing", { listing_id: "lst_nope" }, key)).structuredContent.error, "not_found");
  const b = await call("botiny_credit_balance", {}, key); assert.equal(b.structuredContent.balance_atomic, 1000); assert.equal(b.structuredContent.queries_remaining, 1);
  assert.ok(!(await call("botiny_search", { query: "vector database" }, key)).isError);
  const none = await call("botiny_search", { query: "vector database" }, key);
  assert.equal(none.structuredContent.error, "insufficient_credit"); assert.match(none.content[0].text, /\/v1\/credits\/topup/);
  assert.equal(none.structuredContent.balance_atomic, 0);
  assert.equal((await call("botiny_search", { query: "" }, key)).structuredContent.error, "validation");
  await admin("/settings", { settings: { credit_pack_price_atomic: 1000000, credit_pack_credit_atomic: 1000000 }, note: "restore" });
});

// ---------------- Data feed ----------------
let fk = "";
test("feed: tiers are admin settings; subscribe via x402 issues a wallet-bound key; no-key / no-ToS rejected", async () => {
  const t = await (await fetch(base + "/v1/feed/tiers")).json();
  assert.deepEqual(t.tiers.map((x: any) => [x.tier, x.price_atomic, x.monthly_quota]), [["basic", 500000, 2000], ["pro", 2000000, 20000]]);
  assert.equal((await fetch(base + "/v1/feed/listings")).status, 401);
  assert.equal((await fetch(base + "/v1/feed/subscribe?tier=gold", { method: "POST" })).status, 400);
  const u = await fetch(base + "/v1/feed/subscribe?tier=basic", { method: "POST" }); assert.equal(u.status, 402);
  assert.equal((await u.json()).accepts[0].maxAmountRequired, "500000");
  assert.equal((await admin("/settings", { settings: { feed_basic_quota: 3, feed_basic_max_page: 2, feed_basic_price_atomic: 1000 } })).status, 200);
  const s = await buy("/v1/feed/subscribe?tier=basic", W);
  assert.equal(s.status, 200, JSON.stringify(s)); assert.match(s.api_key, /^bfk_[0-9a-f]{48}$/); fk = s.api_key;
  assert.equal(s.period.quota, 3); assert.equal(s.paid_atomic, 1000);
});

test("feed: paginated snapshot export is stable, change feed is seq based, quota is enforced atomically and logged", async () => {
  const A = { authorization: "Bearer " + fk };
  const p1 = await (await fetch(base + "/v1/feed/listings?limit=50", { headers: A })).json();
  assert.equal(p1.items.length, 2, "capped at the tier max_page"); assert.ok(p1.has_more); assert.equal(p1.quota.remaining, 2);
  // a new listing after the snapshot does not leak into later pages of the same export
  const nl = await (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:feed", name: "Feed test listing", description: "added after snapshot", address: "https://feed.example" }) })).json();
  const p2 = await (await fetch(base + "/v1/feed/listings?cursor=" + p1.next_cursor, { headers: A })).json();
  assert.equal(p2.catalogue_seq, p1.catalogue_seq); assert.ok(p2.items.every((x: any) => x.seq <= p1.catalogue_seq && x.seq > p1.items[1].seq));
  const ch = await (await fetch(base + "/v1/feed/changes?since=" + p1.catalogue_seq, { headers: A })).json();
  assert.deepEqual(ch.changes.map((c: any) => [c.listing_id, c.op]), [[nl.listing_id, "add"]]); assert.equal(ch.next_since, nl.seq ?? ch.head_seq);
  const over = await fetch(base + "/v1/feed/changes?since=0", { headers: A });
  assert.equal(over.status, 402); const oj = await over.json(); assert.equal(oj.error, "feed_quota_exhausted"); assert.match(oj.message, /\/v1\/feed\/subscribe/);
  assert.equal((await fetch(base + "/v1/feed/listings?cursor=garbage", { headers: A })).status, 400);
  const u = (await pool.query("SELECT endpoint, status, items FROM feed_usage ORDER BY usage_id")).rows;
  assert.deepEqual(u.map((x: any) => x.status), [200, 200, 200, 402]);
  // a second month queues behind the active one, existing key unchanged; rotate replaces the key
  const s2 = await buy("/v1/feed/subscribe?tier=basic", W); assert.equal(s2.api_key, null);
  assert.ok(new Date(s2.period.starts_at) > new Date());
  const s3 = await buy("/v1/feed/subscribe?tier=pro&rotate_key=1", W); assert.match(s3.api_key, /^bfk_/);
  assert.equal((await fetch(base + "/v1/feed/me", { headers: A })).status, 401);
  const me = await (await fetch(base + "/v1/feed/me", { headers: { authorization: "Bearer " + s3.api_key } })).json();
  assert.equal(me.periods.length, 3); assert.equal(me.active.remaining, 0); assert.equal(me.refunds, "none");
  // concurrency: quota never oversold
  await pool.query("UPDATE feed_periods SET starts_at = now() - interval '1 day', ends_at = now() + interval '1 day', used = 0, quota = 3 WHERE period_id = (SELECT max(period_id) FROM feed_periods)");
  await pool.query("UPDATE feed_periods SET ends_at = now() - interval '1 second', starts_at = now() - interval '2 days' WHERE period_id < (SELECT max(period_id) FROM feed_periods)");
  const rs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => fetch(base + "/v1/feed/changes?since=0&limit=1", { headers: { authorization: "Bearer " + s3.api_key } }).then(r => r.status)));
  assert.equal(rs.filter(x => x === 200).length, 3); assert.equal(rs.filter(x => x === 402).length, 3);
});

test("feed + mcp: dashboard and financials", async () => {
  const f = await (await fetch(base + "/dashboard/api/feed", { headers: AUTH })).json();
  assert.equal(f.accounts.length, 1); assert.ok(f.accounts[0].requests_ok >= 6); assert.ok(f.recent.length > 0);
  const fin = await (await fetch(base + "/dashboard/api/financials", { headers: AUTH })).json();
  assert.equal(fin.ledger.filter((x: any) => x.type === "data_feed_purchase").length, 3);
});
