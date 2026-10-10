import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "test-pass";
const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { seed } from "../src/seed";
let base = ""; let server: any;
before(async () => { await seed(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const get = async (p: string) => { const r = await fetch(base + p, { headers: AUTH }); assert.equal(r.status, 200, p); return r; };

test("dashboard serves HTML and read-only JSON APIs", async () => {
  await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"query\":\"dash\"}" }); // 402
  const ok = await (await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": "mock:dash" + Date.now() }, body: "{\"query\":\"github issues mcp\",\"k\":2}" })).json();
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
