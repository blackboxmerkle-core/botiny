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
const H = { "content-type": "application/json", ...AUTH };

test("financials API: totals, ledger, liability, distributions, filters, CSV, auth", async () => {
  const lst = await (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:fin", name: "Fin ledger reconciliation API", description: "ledger reconciliation accounting API for bots", address: "https://fin.example", kind: "x402" }) })).json();
  const A = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(r => r.json());
  await A("/advertisers", { advertiser_id: "adv:fin", name: "Fin" });
  await A("/advertisers/adv:fin/credit", { amount_atomic: 5000 });
  await A("/listings/" + lst.listing_id, { bid_atomic: 300 });
  const before = await (await fetch(base + "/dashboard/api/financials", { headers: AUTH })).json();
  const rec = await (await fetch(base + "/v1/recommend", { method: "POST", headers: { ...H, "X-TOS-ACCEPT": TOSH, "X-PAYMENT": "mock:fin" + Date.now() + ":0x00000000000000000000000000000000000000f1" }, body: JSON.stringify({ query: "ledger reconciliation accounting", k: 3 }) })).json();
  assert.equal(rec.response.results[0].name, "Fin ledger reconciliation API");
  assert.equal(rec.response.results[0].sponsored, true);
  const f = await (await fetch(base + "/dashboard/api/financials", { headers: AUTH })).json();
  assert.match(f.network, /TESTNET/);
  assert.equal(f.totals.all.paid_queries, before.totals.all.paid_queries + 1);
  assert.equal(BigInt(f.totals.all.query_gross) - BigInt(before.totals.all.query_gross), 1000n);
  assert.equal(BigInt(f.totals.all.ad_fees) - BigInt(before.totals.all.ad_fees), 400n); // fixed 100 + bid 300
  assert.equal(f.totals.all.admin_credits, "5000");
  assert.equal(f.liability.outstanding_prepaid_atomic, "4600");
  assert.ok(f.ledger.some((x: any) => x.request_id === rec.request_id && x.type === "bot_query_payment" && x.onchain === "n/a (mock)"));
  assert.ok(f.ledger.some((x: any) => x.request_id === rec.request_id && x.type === "advertiser_impression_charge" && x.status === "consumed" && x.counterparty === "adv:fin"));
  assert.ok(f.ledger.some((x: any) => x.type === "advertiser_admin_credit" && x.counterparty === "adv:fin"));
  assert.ok(f.distributions.by_payer.some((x: any) => x.key === "0x00000000000000000000000000000000000000f1"));
  assert.ok(f.distributions.by_rank.length >= 1 && f.distributions.sponsored_vs_organic.length >= 1);
  assert.ok(f.notes.liability);
  const only = await (await fetch(base + "/dashboard/api/financials?type=advertiser_impression_charge", { headers: AUTH })).json();
  assert.ok(only.ledger.length > 0 && only.ledger.every((x: any) => x.type === "advertiser_impression_charge"));
  const future = await (await fetch(base + "/dashboard/api/financials?from=2099-01-01", { headers: AUTH })).json();
  assert.equal(future.ledger.length, 0);
  const csv = await fetch(base + "/dashboard/api/financials.csv?type=bot_query_payment", { headers: AUTH });
  assert.match(csv.headers.get("content-type")!, /text\/csv/);
  const lines = (await csv.text()).trim().split("\n");
  assert.match(lines[0], /^at,bot_id,type,status,mode,counterparty,amount_atomic,amount_usdc/);
  assert.ok(lines.some(l => l.includes(rec.request_id) && l.includes("0.001000")));
  assert.equal((await fetch(base + "/dashboard/api/financials")).status, 401);
  assert.equal((await fetch(base + "/dashboard/api/financials.csv")).status, 401);
});

test("per-bot attribution: X-Bot-Id recorded and filterable in usage + financials", async () => {
  const mk = (bot: string, n: string) => fetch(base + "/v1/recommend", { method: "POST", headers: { ...H, "X-Bot-Id": bot, "X-TOS-ACCEPT": TOSH, "X-PAYMENT": "mock:" + n + Date.now() }, body: JSON.stringify({ query: "mcp server github", k: 2 }) }).then(r => r.json());
  const a = await mk("research-bot", "a"), b = await mk("dev-bot", "b");
  await fetch(base + "/v1/recommend", { method: "POST", headers: { ...H, "X-Bot-Id": "bad id!", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": "mock:c" + Date.now() }, body: JSON.stringify({ query: "x" }) });
  await new Promise(r => setTimeout(r, 150));
  const rows = (await pool.query("SELECT request_id, bot_id FROM requests WHERE request_id = ANY($1)", [[a.request_id, b.request_id]])).rows;
  assert.deepEqual(Object.fromEntries(rows.map(r => [r.request_id, r.bot_id])), { [a.request_id]: "research-bot", [b.request_id]: "dev-bot" });
  const u = await (await fetch(base + "/dashboard/api/usage?bot=dev-bot", { headers: AUTH })).json();
  assert.ok(u.recent.length > 0 && u.recent.every((r: any) => r.bot_id === "dev-bot"));
  assert.ok(u.by_bot.some((r: any) => r.bot_id === "research-bot" && r.paid_ok >= 1));
  const f = await (await fetch(base + "/dashboard/api/financials?bot=research-bot", { headers: AUTH })).json();
  assert.ok(f.ledger.length > 0 && f.ledger.every((x: any) => x.bot_id === "research-bot"));
  assert.equal(f.totals.all.paid_queries, 1);
  assert.ok(f.distributions.by_bot.some((x: any) => x.key === "dev-bot"));
  assert.equal((await pool.query("SELECT count(*)::int n FROM requests WHERE bot_id IS NULL AND request_canonical LIKE '%\"query\":\"x\"%'")).rows[0].n, 1); // invalid id -> NULL
});
