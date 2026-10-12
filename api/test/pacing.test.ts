import { tosHashOf, DEFAULT_TOS } from "../src/tos";
const TOSH = tosHashOf(DEFAULT_TOS.bot);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "test-pass";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { pacingAt } from "../src/pacing";
import { rank, RANKER_V2, RANKER_VERSION } from "../src/rank";
import { EMBEDDING_MODEL } from "../src/embed";
import { marketSeq } from "../src/market";
import { settleIncentives } from "../src/clicks";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
const bot = privateKeyToAccount(generatePrivateKey());
const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
const H = { "content-type": "application/json", ...AUTH };
const ADV = "adv:pace", Q = "vector database MCP server for embeddings";
let base = "", server: any, key = "", LP = "", LX = "", n = 0;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const admin = (p: string, body?: any) => fetch(base + "/dashboard/api/admin" + p, { method: body ? "POST" : "GET", headers: H, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, ...(await r.json()) }));
const rec = () => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:p${Date.now()}${n++}:${bot.address}` },
  body: JSON.stringify({ query: Q, k: 5 }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const offer = (l: string, b: any) => fetch(`${base}/v1/advertisers/me/listings/${l}/incentive`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify(b) });
const listing = async (name: string, description: string) => (await (await fetch(base + "/v1/listings", { method: "POST", headers: H,
  body: JSON.stringify({ provider_id: ADV, name, description, address: "https://pace.example/" + name.replace(/\W/g, ""), kind: "mcp" }) })).json()).listing_id;

test("setup: offer with budget + expiry; validation", async () => {
  key = (await admin("/advertisers", { advertiser_id: ADV, name: "Pace" })).api_key;
  LP = await listing("Pace vector database MCP", "MCP server exposing a vector database for embeddings search");
  LX = await listing("Pace knitting patterns", "Knitting patterns and wool shop catalogue");   // irrelevant to Q
  assert.equal((await offer(LP, { show_atomic: 100, click_atomic: 100, budget_atomic: 0 })).status, 400);
  assert.equal((await offer(LP, { show_atomic: 100, click_atomic: 100, expires_at: "2001-01-01T00:00:00Z" })).status, 400);
  const o = await (await offer(LP, { show_atomic: 100, click_atomic: 100, budget_atomic: 50_000, expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString() })).json();
  assert.equal(o.budget_atomic, 50_000);
  assert.equal((await offer(LX, { show_atomic: 100, click_atomic: 100, budget_atomic: 50_000, expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString() })).status, 200);
  await admin(`/advertisers/${ADV}/credit`, { amount_atomic: 100_000 });
  // pretend the offers started 20 days ago with nothing consumed => far behind schedule
  await pool.query("UPDATE incentive_offers SET created_at = now() - interval '20 days'");
});

test("pacing: behind-schedule offer gets a bounded boost into a promoted slot; irrelevant offers never shown; deterministic", async () => {
  const M = await marketSeq(pool), now = Date.now();
  const p1 = await pacingAt(pool, M, now), p2 = await pacingAt(pool, M, now);
  assert.deepEqual([...p1], [...p2], "pure function of (market_seq, now)");
  const pl = p1.get(LP)!;
  assert.equal(pl.status, "at_risk"); assert.equal(pl.boost_ppm, 200_000); assert.ok(pl.lag_ppm > 800_000);
  const r = await rec();
  assert.equal(r.status, 200);
  const hit = r.response.results.find((x: any) => x.listing_id === LP);
  assert.ok(hit && hit.sponsored && hit.pacing_boost_ppm === 200_000 && hit.rank === 1, JSON.stringify(r.response.results.map((x: any) => [x.listing_id, x.sponsored, x.score_ppm])));
  assert.ok(!r.response.results.some((x: any) => x.listing_id === LX), "irrelevant listing never boosted into results");
  assert.equal(typeof r.response.pacing_at_ms, "number");
  const rq = (await pool.query("SELECT request_canonical, pacing FROM requests WHERE request_id=$1", [r.request_id])).rows[0];
  assert.equal(JSON.parse(rq.request_canonical).pacing_at_ms, r.response.pacing_at_ms);
  assert.equal(rq.pacing[LP].boost_ppm, 200_000);
  // later activity (more escrow, settlement) must not change the replay
  await rec(); await settleIncentives(Date.now() + 8 * 86_400_000);
  const rp = await (await fetch(`${base}/v1/requests/${r.request_id}/replay`)).json();
  assert.equal(rp.match, true);
  // v2 (pre-pacing) requests still rank without pacing
  const v2 = await rank(pool, { query: Q, k: 5, catalogue_seq: 1e9, market_seq: M, settings_version: 1, embedding_model: EMBEDDING_MODEL, ranker_version: RANKER_V2 });
  assert.ok(!("pacing_at_ms" in v2.body)); assert.ok(!v2.body.results.some((x: any) => x.pacing_boost_ppm));
  await assert.rejects(rank(pool, { query: Q, k: 5, catalogue_seq: 1e9, market_seq: M, settings_version: 1, embedding_model: EMBEDDING_MODEL, ranker_version: RANKER_VERSION }));
  // at a time with no lag (right at start) there is no boost
  assert.equal((await pacingAt(pool, M, pl.start_ms)).get(LP)!.boost_ppm, 0);
});

test("budget cap: escrow never exceeds the offer budget", async () => {
  await offer(LP, { budget_atomic: 1 });
  const r = await rec();
  assert.ok(r.click_links.filter((c: any) => c.listing_id === LP).every((c: any) => c.show_incentive_atomic + c.click_incentive_atomic === 0));
  await offer(LP, { budget_atomic: 50_000 });
});

test("advertiser report: auth, totals reconcile with the ledgers, CSV; admin pacing alerts", async () => {
  assert.equal((await fetch(base + "/v1/advertisers/me/incentives/report")).status, 401);
  const rep = await (await fetch(base + "/v1/advertisers/me/incentives/report", { headers: { authorization: "Bearer " + key } })).json();
  const o = rep.offers.find((x: any) => x.listing_id === LP);
  assert.ok(o && o.issued_atomic > 0);
  const escrow = -Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text s FROM balance_ledger WHERE kind='incentive_escrow' AND advertiser_id=$1", [ADV])).rows[0].s);
  assert.equal(rep.totals.funded_atomic, escrow, "funded = advertiser escrow debits");
  for (const x of rep.offers) {
    assert.equal(x.issued_atomic, x.funded_atomic + x.pool_draw_atomic, "issued = funded + pool draws");
    assert.equal(x.pool_atomic, x.returned_to_pool_atomic - x.pool_draw_atomic - x.expired_to_platform_atomic);
    assert.equal(x.consumed_atomic, x.issued_atomic - x.returned_to_pool_atomic);
    assert.equal(x.remaining_atomic, Math.max(0, x.budget_atomic - x.consumed_atomic));
  }
  const tl = rep.timeline.reduce((s: number, d: any) => s + (d.issued ?? 0), 0);
  assert.equal(tl, rep.totals.issued_atomic, "timeline sums to totals");
  const csv = await (await fetch(base + "/v1/advertisers/me/incentives/report?format=csv", { headers: { authorization: "Bearer " + key } })).text();
  assert.match(csv, /^listing_id,name,advertiser_id,budget_atomic,funded_atomic/); assert.ok(csv.includes(LP));
  assert.equal((await fetch(base + "/dashboard/api/admin/incentives/pacing")).status, 401);
  const pa = await admin("/incentives/pacing");
  assert.ok(pa.alerts.some((x: any) => x.listing_id === LP && x.pacing.status === "at_risk"));
  const all = await admin("/incentives/report");
  assert.equal(all.totals.funded_atomic, escrow);
});

test("offer expiry: expired offers get no boost and no new incentives; pool swept to platform revenue", async () => {
  await pool.query("UPDATE incentive_offers SET expires_at = now() - interval '1 second'");
  const M = await marketSeq(pool);
  assert.equal((await pacingAt(pool, M, Date.now())).get(LP)!.status, "expired");
  const r = await rec();
  assert.ok(!r.response.results.some((x: any) => x.pacing_boost_ppm));
  assert.ok(r.click_links.every((c: any) => c.show_incentive_atomic + c.click_incentive_atomic === 0));
  const b = Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text s FROM balance_ledger WHERE advertiser_id=$1", [ADV])).rows[0].s);
  const s = await settleIncentives(Date.now() + 8 * 86_400_000);
  // (the +8d settlement in the pacing test was already past this offer's 2-day expiry and swept the pool)
  const rev = Number((await pool.query("SELECT COALESCE(SUM(amount_atomic),0)::text s FROM incentive_pool_ledger WHERE kind='expired_revenue' AND provider_id=$1", [ADV])).rows[0].s);
  const ret = Number((await pool.query("SELECT COALESCE(SUM(amount_atomic),0)::text s FROM incentive_pool_ledger WHERE kind LIKE 'returned%' AND provider_id=$1", [ADV])).rows[0].s);
  assert.ok(rev > 0); assert.equal(rev, ret, "everything returned after expiry went to platform revenue");
  assert.equal(s.expired_revenue_atomic, 0, "idempotent");
  const pa = await admin("/incentives/pacing"); assert.equal(pa.platform_expired_revenue_atomic, rev);
  assert.equal(Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text s FROM balance_ledger WHERE advertiser_id=$1", [ADV])).rows[0].s), b, "never credited back");
});
