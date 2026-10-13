// Security re-check on 8135b04: allow-list overlap + gating, header stripping on cross-host redirects,
// settle_unknown + on-chain reconciliation, same-tx compensation + sweeper, rate-limit exemption only for direct local clients.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
process.env.DASHBOARD_PASSWORD = "Test-Pass-0123456789";
import { tosHashOf, DEFAULT_TOS } from "../src/tos";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { _resetRateLimits } from "../src/portal";
import { sweep, _setAuthChecker } from "../src/reconcile";
import { allowEntryError, allowListActive, isPublicIp, safeFetch, _setSafeFetchResolver, _safeFetchAllowForTests } from "../../crawler/src/safe-fetch";

const TOSH = tosHashOf(DEFAULT_TOS.bot), TOSA = tosHashOf(DEFAULT_TOS.advertiser);
const AUTH = { authorization: "Basic " + Buffer.from("admin:Test-Pass-0123456789").toString("base64") };
const H = { "content-type": "application/json", ...AUTH };
let base = "", server: any, n = 0;
before(async () => { await resetTestDb(); server = await new Promise(ok => { const sv = createApp().listen(0, "127.0.0.1", () => ok(sv)); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const rec = (extra: Record<string, string> = {}) => fetch(base + "/v1/recommend", { method: "POST",
  headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:r${Date.now()}${n++}:0x00000000000000000000000000000000000000e1`, ...extra }, body: JSON.stringify({ query: "MCP server for browser automation", k: 8 }) })
  .then(async r => ({ status: r.status, ...(await r.json()) }));
const balance = async (a: string) => Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id=$1", [a])).rows[0].b);
const row = async (id: string) => (await pool.query("SELECT payment_status, billing_status FROM requests WHERE request_id=$1", [id])).rows[0];

test("A) allow-list entries overlapping ANY blocked range are rejected (v4 + v6); only re-enableable ranges pass", () => {
  for (const c of ["126.0.0.0/7", "169.0.0.0/8", "::/0", "0.0.0.0/0", "10.0.0.0/8", "198.0.0.0/7", "198.16.0.0/12", "127.0.0.1/32", "169.254.169.254/32", "100.0.0.0/8",
    "::ffff:198.18.0.0/111", "::ffff:0:0/96", "fc00::/7", "fd00:ec2::254/128", "fe80::/9", "2000::/3", "::1/128", "224.0.0.0/3", "garbage", "198.18.0.0/33"])
    assert.ok(allowEntryError(c), `${c} must be rejected`);
  for (const c of ["198.18.0.0/15", "198.18.0.0/24", "198.19.255.255/32"]) assert.equal(allowEntryError(c), null, c);
  assert.ok(allowEntryError("8.8.8.0/24"), "public ranges are not 're-enableable' (nothing to allow)");
});

test("B) allow-list honoured only with NODE_ENV development|test or BOTINY_BOX_DEV=1", () => {
  const save = { N: process.env.NODE_ENV, B: process.env.BOTINY_BOX_DEV };
  process.env.SAFE_FETCH_ALLOW_CIDRS = "198.18.0.0/15,126.0.0.0/7"; delete process.env.BOTINY_BOX_DEV; process.env.NODE_ENV = "production";
  assert.equal(allowListActive(), false); assert.equal(isPublicIp("198.18.0.1"), false, "ignored in production");
  process.env.BOTINY_BOX_DEV = "1";
  assert.equal(allowListActive(), true); assert.equal(isPublicIp("198.18.0.1"), true); assert.equal(isPublicIp("127.0.0.1"), false, "overlapping entry was rejected");
  delete process.env.BOTINY_BOX_DEV; process.env.NODE_ENV = "test"; assert.equal(allowListActive(), true);
  delete process.env.SAFE_FETCH_ALLOW_CIDRS;
  if (save.N == null) delete process.env.NODE_ENV; else process.env.NODE_ENV = save.N; if (save.B != null) process.env.BOTINY_BOX_DEV = save.B;
});

test("E) cross-host redirects drop Authorization, Cookie and custom headers; same-host hops keep them", async () => {
  const seen: Record<string, any> = {};
  const mk = (name: string, h: (req: any, res: any) => void) => { const s = createServer((req, res) => { seen[name + req.url] = req.headers; h(req, res); }); return new Promise<any>(ok => s.listen(0, "127.0.0.1", () => ok(s))); };
  const b = await mk("b", (_q, res) => res.end("{}"));
  const a = await mk("a", (req, res) => {
    if (req.url === "/same") { res.writeHead(302, { location: "/final" }); return res.end(); }
    if (req.url === "/cross") { res.writeHead(307, { location: `http://other.test:${b.address().port}/landing` }); return res.end(); }
    res.end("{}");
  });
  _setSafeFetchResolver(async () => ["127.0.0.1"]); _safeFetchAllowForTests(["127.0.0.1"]);
  const hdr = { authorization: "Bearer s3cret", cookie: "sid=1", "x-api-key": "k", "user-agent": "ua-test", accept: "application/json" };
  await safeFetch(`http://one.test:${a.address().port}/same`, { headers: hdr });
  assert.equal(seen["a/final"].authorization, "Bearer s3cret", "same host keeps credentials");
  await safeFetch(`http://one.test:${a.address().port}/cross`, { headers: hdr });
  const l = seen["b/landing"];
  assert.ok(!l.authorization && !l.cookie && !l["x-api-key"], "credentials + custom headers stripped across hosts");
  assert.equal(l["user-agent"], "ua-test"); assert.equal(l.accept, "application/json");
  _safeFetchAllowForTests([]); _setSafeFetchResolver(null); a.close(); b.close();
});

test("C+D) settle_unknown: 202, stays billed; reconciler marks settled (used) or failed+compensated (unused & expired); sweeper compensates leftovers", async () => {
  _resetRateLimits();
  const ad = await admin("/advertisers", { advertiser_id: "adv:su", name: "SU" });
  const L = (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:su", name: "SU browser automation MCP", description: "MCP server for browser automation and scraping", address: "https://su.example/mcp", kind: "mcp" }) }).then(r => r.json())).listing_id;
  await admin("/advertisers/adv:su/credit", { amount_atomic: 50_000 });
  const AH = { "content-type": "application/json", authorization: "Bearer " + ad.api_key };
  await fetch(`${base}/v1/advertisers/me/listings/${L}/bid`, { method: "PUT", headers: AH, body: JSON.stringify({ bid_atomic: 500 }) });
  const b0 = await balance("adv:su");
  process.env.MOCK_SETTLE_UNKNOWN = "1";
  const u1 = await rec(), u2 = await rec();
  delete process.env.MOCK_SETTLE_UNKNOWN;
  assert.equal(u1.status, 202); assert.equal(u1.state, "settle_unknown"); assert.ok(!JSON.stringify(u1).includes("mock_settle_timeout"));
  assert.deepEqual(await row(u1.request_id), { payment_status: "settle_unknown", billing_status: "billed" }, "ambiguous: NOT compensated immediately");
  const debited = b0 - await balance("adv:su"); assert.ok(debited > 0);
  // chain says: u1 used, u2 unused (and its authorization has expired)
  await pool.query("UPDATE requests SET payment_valid_before=$2 WHERE request_id=$1", [u2.request_id, Math.floor(Date.now() / 1000) - 3600]);
  // simpler + deterministic: check per request id via a lookup table
  const state = new Map([[u1.request_id, true], [u2.request_id, false]]);
  _setAuthChecker(async (a: any) => state.get(a.request_id) ?? null);
  const r1: any = await sweep();
  assert.equal(r1.unknown_settled, 1); assert.equal(r1.unknown_failed, 1);
  assert.deepEqual(await row(u1.request_id), { payment_status: "settled", billing_status: "billed" });
  assert.deepEqual(await row(u2.request_id), { payment_status: "settle_failed", billing_status: "voided" });
  assert.equal(b0 - await balance("adv:su"), debited / 2, "only the unsettled request was refunded");
  assert.equal((await (await fetch(base + "/v1/requests/" + u2.request_id + "/replay")).json()).match, true);
  // leftover billed + settle_failed (e.g. crash between commit and compensation) -> sweeper compensates, idempotently
  const s3 = await rec(); assert.equal(s3.status, 200);
  await pool.query("UPDATE requests SET payment_status='settle_failed' WHERE request_id=$1", [s3.request_id]);
  assert.equal(((await sweep()) as any).compensated, 1); assert.equal(((await sweep()) as any).compensated, 0);
  assert.equal((await row(s3.request_id)).billing_status, "voided");
  // definite failure: compensated in the SAME transaction as the status update
  process.env.MOCK_SETTLE_FAIL = "1"; const f = await rec(); delete process.env.MOCK_SETTLE_FAIL;
  assert.equal(f.status, 402); assert.deepEqual(await row(f.request_id), { payment_status: "settle_failed", billing_status: "voided" });
  _setAuthChecker(null);
});

test("C) ambiguous top-up: 202, not credited until authorizationState proves it", async () => {
  _resetRateLimits();
  const ad = await admin("/advertisers", { advertiser_id: "adv:tu", name: "TU" });
  const B = { "content-type": "application/json", authorization: "Bearer " + ad.api_key, "X-TOS-ACCEPT": TOSA };
  process.env.MOCK_SETTLE_UNKNOWN = "1";
  const r = await fetch(`${base}/v1/advertisers/me/topup?amount_atomic=5000`, { method: "POST", headers: { ...B, "X-PAYMENT": "mock:tu" + Date.now() } });
  delete process.env.MOCK_SETTLE_UNKNOWN;
  assert.equal(r.status, 202); assert.equal(await balance("adv:tu"), 0);
  _setAuthChecker(async () => true);
  assert.equal(((await sweep()) as any).topups_credited, 1); assert.equal(await balance("adv:tu"), 5000);
  assert.equal(((await sweep()) as any).topups_credited, 0); assert.equal(await balance("adv:tu"), 5000, "idempotent");
  _setAuthChecker(null);
});

test("F) rate-limit exemption only for a direct local client (loopback socket AND no X-Forwarded-For)", async () => {
  _resetRateLimits(); process.env.RL_REQUEST_IP = "1";
  const id = (await pool.query("SELECT request_id FROM requests LIMIT 1")).rows[0].request_id;
  for (let i = 0; i < 3; i++) assert.equal((await fetch(base + "/v1/requests/" + id)).status, 200, "direct local: exempt");
  const XF = { "X-Forwarded-For": "127.0.0.1" };   // tunnelled request claiming loopback: still limited
  assert.equal((await fetch(base + "/v1/requests/" + id, { headers: XF })).status, 200);
  assert.equal((await fetch(base + "/v1/requests/" + id, { headers: XF })).status, 429);
  delete process.env.RL_REQUEST_IP; _resetRateLimits();
});
