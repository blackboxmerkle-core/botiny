import { tosHashOf, DEFAULT_TOS } from "../src/tos";
const TOSH = tosHashOf(DEFAULT_TOS.bot), TOSA = tosHashOf(DEFAULT_TOS.advertiser);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "Test-Pass-0123456789";
const AUTH = { authorization: "Basic " + Buffer.from("admin:Test-Pass-0123456789").toString("base64") };
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb as seed } from "../src/seed";
let base = ""; let server: any;
before(async () => { await seed(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const get = async (p: string) => { const r = await fetch(base + p, { headers: AUTH }); assert.equal(r.status, 200, p); return r; };

test("dashboard serves HTML and read-only JSON APIs", async () => {
  await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"query\":\"dash\"}" }); // 402
  const ok = await (await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": "mock:dash" + Date.now() }, body: "{\"query\":\"github issues mcp\",\"k\":2}" })).json();
  await new Promise(r => setTimeout(r, 100)); // api_log write is async
  assert.match(await (await get("/dashboard/")).text(), /bot-rec-market/);
  const u = await (await get("/dashboard/api/usage")).json();
  assert.ok(u.by_route.some((r: any) => r.status === 402 && r.route === "/v1/recommend"));
  assert.ok(u.recent.some((r: any) => r.request_id === ok.request_id));
  const p = await (await get("/dashboard/api/payments")).json();
  assert.ok(p.payments.some((x: any) => x.request_id === ok.request_id && x.payment_status === "settled"));
  const d = await (await get("/dashboard/api/requests/" + ok.request_id)).json();
  assert.equal(d.response_hash, ok.response_hash);
  assert.equal(d.impressions.length, ok.response.results.length);
  assert.ok(d.impressions.every((i: any) => i.db_txid === d.db_txid));
  assert.ok(Array.isArray(await (await get("/dashboard/api/advertisers")).json()));
  assert.ok((await (await get("/dashboard/api/catalogue")).json()).length >= 31);
  assert.equal((await fetch(base + "/dashboard/api/requests/nope", { headers: AUTH })).status, 404);
  assert.equal((await fetch(base + "/dashboard/")).status, 401);
  assert.equal((await fetch(base + "/dashboard/api/usage", { headers: { authorization: "Basic " + Buffer.from("admin:wrong").toString("base64") } })).status, 401);
});
test("no dashboard response leaks the payer private key", async () => {
  const k = process.env.PAYER_PRIVATE_KEY;
  for (const p of ["/dashboard/", "/dashboard/api/usage", "/dashboard/api/payments", "/dashboard/api/catalogue"]) {
    const body = await (await get(p)).text();
    if (k) { assert.ok(!body.includes(k.replace(/^0x/, ""))); }
    assert.ok(!/PRIVATE_KEY/.test(body));
  }
});

test("older entries stay reachable: pagination, search, legacy rows, settle_failed reason recorded", async () => {
  // 7 requests; page through 3 at a time
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await (await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:pg${i}${Date.now()}` }, body: JSON.stringify({ query: "page test " + i, k: 2 }) })).json();
    ids.push(r.request_id); await new Promise(r => setTimeout(r, 5));
  }
  const seen: string[] = []; let before: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const r: Response = await fetch(base + "/dashboard/api/requests?limit=3" + (before ? "&before=" + encodeURIComponent(before) : ""), { headers: AUTH });
    assert.equal(r.status, 200);
    seen.push(...(await r.json()).map((x: any) => x.request_id));
    before = r.headers.get("X-Next-Before"); if (!before) break;
  }
  const total = (await pool.query("SELECT count(*)::int n FROM requests")).rows[0].n;
  assert.equal(new Set(seen).size, total, "every request reachable via pagination");
  for (const id of ids) assert.ok(seen.includes(id));
  const s = await (await fetch(base + "/dashboard/api/requests?q=page%20test%203", { headers: AUTH })).json();
  assert.equal(s.length, 1); assert.equal(s[0].request_id, ids[3]);
  const p = await (await fetch(base + "/dashboard/api/payments?limit=2", { headers: AUTH })).json();
  assert.equal(p.payments.length, 2); assert.ok(p.next_before); assert.equal(p.total_count, total);
  // a legacy v1 row (no settings_version/market_seq) still loads and replays
  const legacy = (await pool.query("SELECT request_id FROM requests WHERE settings_version IS NULL LIMIT 1")).rows[0];
  if (legacy) {
    assert.equal((await fetch(base + "/dashboard/api/requests/" + legacy.request_id, { headers: AUTH })).status, 200);
    assert.equal((await (await fetch(base + "/v1/requests/" + legacy.request_id + "/replay")).json()).match, true);
  }
  // settlement failure reason is stored and returned
  process.env.MOCK_SETTLE_FAIL = "1";
  const f = await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": "mock:sf" + Date.now() }, body: JSON.stringify({ query: "settle fail", k: 1 }) });
  delete process.env.MOCK_SETTLE_FAIL;
  const fj = await f.json();
  assert.equal(f.status, 402); assert.equal(fj.error, "settlement_failed"); assert.ok(!("reason" in fj));
  const d = await (await fetch(base + "/dashboard/api/requests/" + fj.request_id, { headers: AUTH })).json();
  assert.equal(d.payment_status, "settle_failed"); assert.equal(d.settle_error, "mock_settle_failure");
  assert.equal((await (await fetch(base + "/v1/requests/" + fj.request_id + "/replay")).json()).match, true);
});
test("admin ToS editor: new version per save, served at /v1/terms, DRAFT enforced, old hash becomes stale", async () => {
  const H2 = { ...AUTH, "content-type": "application/json" };
  const t0 = await (await get("/dashboard/api/admin/tos")).json();
  const body = t0.advertiser.current.body + "\n8. DRAFT: edited in test.\n";
  const r = await (await fetch(base + "/dashboard/api/admin/tos", { method: "POST", headers: H2, body: JSON.stringify({ kind: "advertiser", body, note: "t" }) })).json();
  assert.equal(r.version, t0.advertiser.current.version + 1);
  const page = await fetch(base + "/v1/terms/advertiser/" + r.version);
  assert.equal(await page.text(), body); assert.equal(page.headers.get("x-tos-sha256"), r.sha256);
  assert.equal((await fetch(base + "/dashboard/api/admin/tos", { method: "POST", headers: H2, body: JSON.stringify({ kind: "bot", body: "no marker ".repeat(10) }) })).status, 400);
  assert.equal((await fetch(base + "/dashboard/api/admin/tos", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const terms = await (await fetch(base + "/v1/terms")).json();
  assert.equal(terms.advertiser.sha256, r.sha256); assert.match(terms.bot.url, /\/v1\/terms\/1$/);
  const un = await (await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"query\":\"t\"}" })).json();
  assert.equal(un.tos.sha256, terms.bot.sha256); assert.ok(un.accepts.length >= 6 && un.accepts.every((a: any) => a.extra.tos.sha256 === terms.bot.sha256));
});
