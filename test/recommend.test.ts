import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "test-pass";
const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb as seed } from "../src/seed";
import { canonicalize, sha256 } from "../src/canonical";
import { embed } from "../src/embed";

let base = ""; let server: any;
before(async () => { await seed(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const nonce = () => "t" + Date.now() + Math.floor(Math.random() * 1e9);
const post = (p: string, body: any, h: Record<string, string> = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...AUTH, ...h }, body: JSON.stringify(body) });

test("canonical JSON is key-order independent and rejects floats", () => {
  assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: "x" }] }), canonicalize({ a: [{ c: "x", d: 2 }], b: 1 }));
  assert.throws(() => canonicalize({ x: 0.5 }));
  assert.deepEqual(embed("pay with USDC on Base"), embed("pay with USDC on Base"));
});

test("unpaid recommend returns 402 with Base Sepolia USDC requirements", async () => {
  const r = await post("/v1/recommend", { query: "x402 facilitator" });
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.accepts[0].network, "base-sepolia");
  assert.equal(j.accepts[0].asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
});

test("paid recommend logs request + response hash + impressions atomically, and replay matches", async () => {
  const pr = await post("/v1/listings", { provider_id: "adv:acme", name: "Acme x402 transcription", description: "Speech to text transcription API payable with x402 USDC.", address: "https://acme.example/stt", cpi_micro_usdc: 250, tags: ["x402", "audio"] });
  assert.equal(pr.status, 201);
  const r = await post("/v1/recommend", { query: "x402 payments facilitator to settle USDC", k: 5 }, { "X-PAYMENT": "mock:" + nonce() });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.response.results.length > 0);
  assert.equal(j.response_hash, sha256(canonicalize(j.response)));
  const row = (await pool.query("SELECT * FROM requests WHERE request_id=$1", [j.request_id])).rows[0];
  assert.equal(row.response_hash, j.response_hash);
  assert.equal(row.payment_status, "settled");
  const imps = (await pool.query("SELECT rank, listing_id FROM impressions WHERE request_id=$1 ORDER BY rank", [j.request_id])).rows;
  assert.deepEqual(imps.map(i => i.listing_id), j.response.results.map((x: any) => x.listing_id));
  // same transaction: request and impressions share the creating xid
  const x = (await pool.query("SELECT (SELECT db_txid::text FROM requests WHERE request_id=$1) AS rx, array_agg(DISTINCT db_txid::text) AS ix FROM impressions WHERE request_id=$1", [j.request_id])).rows[0];
  assert.deepEqual(x.ix, [x.rx]);

  // catalogue changes after the request must not affect replay (snapshot pinned)
  await post("/v1/listings", { provider_id: "adv:late", name: "Late x402 facilitator settle USDC payments", description: "x402 payments facilitator settle USDC", address: "https://late.example" });
  const rp = await (await fetch(`${base}/v1/requests/${j.request_id}/replay`)).json();
  assert.equal(rp.match, true); assert.equal(rp.replayed_hash, j.response_hash); assert.equal(rp.request_hash_ok, true);
  // a fresh request now sees the new listing and yields a different hash
  const j2 = await (await post("/v1/recommend", { query: "x402 payments facilitator to settle USDC", k: 5 }, { "X-PAYMENT": "mock:" + nonce() })).json();
  assert.notEqual(j2.response_hash, j.response_hash);
});

test("failure mid-transaction leaves no request and no impressions", async () => {
  const before = Number((await pool.query("SELECT count(*) FROM impressions")).rows[0].count);
  const rbefore = Number((await pool.query("SELECT count(*) FROM requests")).rows[0].count);
  process.env.FAIL_AFTER_IMPRESSIONS = "1";
  const r = await post("/v1/recommend", { query: "browser automation" }, { "X-PAYMENT": "mock:" + nonce() });
  delete process.env.FAIL_AFTER_IMPRESSIONS;
  assert.equal(r.status, 500);
  assert.equal(Number((await pool.query("SELECT count(*) FROM impressions")).rows[0].count), before);
  assert.equal(Number((await pool.query("SELECT count(*) FROM requests")).rows[0].count), rbefore);
});

test("payment header cannot be reused", async () => {
  const h = { "X-PAYMENT": "mock:" + nonce() };
  assert.equal((await post("/v1/recommend", { query: "github issues" }, h)).status, 200);
  assert.equal((await post("/v1/recommend", { query: "github issues" }, h)).status, 409);
});

test("audit endpoints expose request impressions and provider spend", async () => {
  const j = await (await post("/v1/recommend", { query: "Acme transcription speech to text x402", k: 3 }, { "X-PAYMENT": "mock:" + nonce() })).json();
  const a = await (await fetch(`${base}/v1/requests/${j.request_id}`)).json();
  assert.equal(a.impressions.length, j.response.results.length);
  const sp = await (await fetch(`${base}/v1/audit/providers/adv:acme`, { headers: AUTH })).json();
  assert.ok(Number(sp.listings[0].spend_micro_usdc) >= 250);
});

test("auth: listings/audit need basic auth, recommend and health stay public", async () => {
  const l = await fetch(base + "/v1/listings", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(l.status, 401);
  assert.equal((await fetch(base + "/v1/audit/providers/x")).status, 401);
  assert.equal((await fetch(base + "/v1/health")).status, 200);
  assert.equal((await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"query\":\"x\"}" })).status, 402);
});
