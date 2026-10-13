// Security audit 2026-10-13: trust proxy / client IP, SSRF-safe fetch, settle_failed compensation, public redaction,
// rate limits, admin lockout + CSRF, no error-text leaks, relayer-vs-payer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
process.env.DASHBOARD_PASSWORD = "Test-Pass-0123456789";
import { tosHashOf, DEFAULT_TOS } from "../src/tos";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { _resetRateLimits } from "../src/portal";
import { _resetAdminLockout, passwordStrong } from "../src/auth";
import { voidUnbilledRequest } from "../src/compensate";
import { isPublicIp, canonicalIp, safeFetch, resolvePublic, _setSafeFetchResolver, _safeFetchAllowForTests } from "../../crawler/src/safe-fetch";
import { payerAddresses, relayerAccount } from "../src/facilitator";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const TOSH = tosHashOf(DEFAULT_TOS.bot);
const AUTH = { authorization: "Basic " + Buffer.from("admin:Test-Pass-0123456789").toString("base64") };
const H = { "content-type": "application/json", ...AUTH };
let base = "", server: any, n = 0;
before(async () => { await resetTestDb(); server = await new Promise(ok => { const sv = createApp().listen(0, "127.0.0.1", () => ok(sv)); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const rec = (query: string, extra: Record<string, string> = {}, k = 8) => fetch(base + "/v1/recommend", { method: "POST",
  headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:s${Date.now()}${n++}:0x00000000000000000000000000000000000000c1`, ...extra }, body: JSON.stringify({ query, k }) })
  .then(async r => ({ status: r.status, ...(await r.json()) }));
const balance = async (a: string) => Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id=$1", [a])).rows[0].b);

test("client IP: X-Forwarded-For honoured only from a loopback peer, last hop wins; bans use req.ip", async () => {
  _resetRateLimits();
  const ban = await admin("/bans", { kind: "ip", value: "203.0.113.9", reason: "trust proxy test" }); assert.ok(ban.ban_id);
  assert.equal((await rec("x", { "X-Forwarded-For": "203.0.113.9" })).status, 403, "loopback peer (ngrok): XFF hop is the client");
  assert.notEqual((await rec("x", { "X-Forwarded-For": "203.0.113.9, 198.51.100.7" })).status, 403, "spoofed earlier XFF entries are ignored");
  // a NON-loopback peer's X-Forwarded-For must be ignored entirely
  const ext = Object.values(networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal)?.address;
  if (ext) {
    const s2: any = await new Promise(ok => { const sv = createApp().listen(0, ext, () => ok(sv)); }); const b2 = `http://${ext}:${(s2.address() as AddressInfo).port}`;
    await admin("/bans", { kind: "ip", value: ext, reason: "direct peer" });
    const r = await fetch(b2 + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-Forwarded-For": "8.8.8.8" }, body: "{\"query\":\"x\"}" });
    assert.equal(r.status, 403, "direct peer is identified by its socket address, not by its XFF");
    s2.close();
  }
  await admin(`/bans/${ban.ban_id}/revoke`, {});
});

test("safe-fetch: address classes, v4-mapped, 198.18/15 policy, redirects re-checked, pinned IP, caps", async () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1",
    "::1", "::", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1"]) assert.equal(isPublicIp(a), false, a);
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPublicIp(a), true, a);
  assert.equal(canonicalIp("::ffff:7f00:1"), "127.0.0.1");
  process.env.SAFE_FETCH_ALLOW_CIDRS = "198.18.0.0/15,127.0.0.0/8"; process.env.BOTINY_BOX_DEV = "1";
  assert.equal(isPublicIp("198.18.0.1"), true, "box egress fake-IP range can be allowed explicitly");
  assert.equal(isPublicIp("127.0.0.1"), false, "loopback can never be allowed via env"); delete process.env.SAFE_FETCH_ALLOW_CIDRS; delete process.env.BOTINY_BOX_DEV;
  _setSafeFetchResolver(async h => h === "mixed.test" ? ["8.8.8.8", "10.0.0.1"] : h === "fixture.test" ? ["127.0.0.1"] : ["93.184.216.34"]);
  await assert.rejects(resolvePublic("mixed.test"), /non-public/, "any private answer => refused (anti-rebinding)");
  await assert.rejects(safeFetch("http://localhost:1/"), /not allowed/);
  await assert.rejects(safeFetch("file:///etc/passwd"), /scheme/);
  await assert.rejects(safeFetch("http://user:pw@example.com/"), /credentials/);
  await assert.rejects(safeFetch("http://[::ffff:127.0.0.1]:1/"), /non-public/);
  const seen: any[] = [];
  const srv = createServer((req, res) => { seen.push({ url: req.url, host: req.headers.host });
    if (req.url === "/to-private") { res.writeHead(302, { location: "http://10.0.0.1/x" }); return res.end(); }
    if (req.url?.startsWith("/loop")) { res.writeHead(302, { location: "/loop" + (Number(req.url.slice(5) || 0) + 1) }); return res.end(); }
    if (req.url === "/big") { res.end("x".repeat(5000)); return; }
    res.end(JSON.stringify({ ok: 1 })); });
  await new Promise<void>(ok => srv.listen(0, "127.0.0.1", () => ok()));
  const port = (srv.address() as AddressInfo).port;
  await assert.rejects(safeFetch(`http://fixture.test:${port}/`), /non-public/, "fixture resolves to loopback: refused by default");
  _safeFetchAllowForTests(["127.0.0.1"]);
  const ok = await safeFetch(`http://fixture.test:${port}/`); assert.equal(ok.json().ok, 1);
  assert.equal(seen.at(-1).host, `fixture.test:${port}`, "connects to the vetted (pinned) IP but keeps the Host");
  await assert.rejects(safeFetch(`http://fixture.test:${port}/to-private`), /non-public/, "redirect target re-validated");
  await assert.rejects(safeFetch(`http://fixture.test:${port}/loop`, { maxRedirects: 3 }), /too many redirects/);
  await assert.rejects(safeFetch(`http://fixture.test:${port}/big`, { maxBytes: 1000 }), /larger than/);
  assert.equal((await safeFetch(`http://fixture.test:${port}/big`, { maxBytes: 1000, truncate: true })).body.length, 1000);
  _safeFetchAllowForTests([]); _setSafeFetchResolver(null); srv.close();
});

test("settle_failed: impression debit + escrow reversed, links voided, request not billed, replay still MATCH, idempotent", async () => {
  _resetRateLimits();
  const a = await admin("/advertisers", { advertiser_id: "adv:sf", name: "SF" }); const key = a.api_key;
  const L = (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:sf", name: "SF browser automation MCP", description: "MCP server for browser automation and scraping", address: "https://sf.example/mcp", kind: "mcp" }) }).then(r => r.json())).listing_id;
  await admin("/advertisers/adv:sf/credit", { amount_atomic: 50_000 });
  const AH = { "content-type": "application/json", authorization: "Bearer " + key };
  assert.equal((await fetch(`${base}/v1/advertisers/me/listings/${L}/bid`, { method: "PUT", headers: AH, body: JSON.stringify({ bid_atomic: 500 }) })).status, 200);
  assert.equal((await fetch(`${base}/v1/advertisers/me/listings/${L}/incentive`, { method: "PUT", headers: AH, body: JSON.stringify({ show_atomic: 100, click_atomic: 200, budget_atomic: 40_000 }) })).status, 200);
  const before = await balance("adv:sf");
  process.env.MOCK_SETTLE_FAIL = "1";
  const r = await rec("MCP server for browser automation", { "X-Bot-Channel": "chat" });
  delete process.env.MOCK_SETTLE_FAIL;
  assert.equal(r.status, 402); assert.equal(r.error, "settlement_failed"); assert.equal(r.billed, false); assert.equal(r.voided, true);
  assert.ok(!("reason" in r) && !JSON.stringify(r).includes("mock_settle_failure"), "no settlement error text in the public body");
  const led = (await pool.query("SELECT kind, delta_atomic::int d FROM balance_ledger WHERE request_id=$1 ORDER BY seq", [r.request_id])).rows;
  assert.ok(led.some(x => x.kind === "impression_debit") && led.some(x => x.kind === "impression_refund"), "sponsored impression was debited, then refunded");
  assert.ok(led.some(x => x.kind === "incentive_escrow") && led.some(x => x.kind === "incentive_escrow_void"), "escrow taken, then returned");
  assert.equal(await balance("adv:sf"), before, "advertiser balance fully restored");
  const pl = (await pool.query("SELECT kind, SUM(amount_atomic)::int a FROM incentive_pool_ledger WHERE request_id=$1 GROUP BY 1", [r.request_id])).rows;
  assert.equal(pl.find(x => x.kind === "funded")?.a, pl.find(x => x.kind === "void_funded")?.a, "budget consumption un-counted");
  const toks = (await pool.query("SELECT show_atomic::int s, click_atomic::int c, tracked_only, voided_at FROM harvest_tokens WHERE request_id=$1", [r.request_id])).rows;
  assert.ok(toks.length && toks.every(t => t.s === 0 && t.c === 0 && t.tracked_only && t.voided_at), "links voided (nothing payable)");
  const req = (await pool.query("SELECT payment_status, billing_status, response_hash FROM requests WHERE request_id=$1", [r.request_id])).rows[0];
  assert.equal(req.payment_status, "settle_failed"); assert.equal(req.billing_status, "voided"); assert.ok(req.response_hash, "request/response log kept for audit");
  assert.equal((await (await fetch(base + "/v1/requests/" + r.request_id + "/replay")).json()).match, true);
  const again = await voidUnbilledRequest(r.request_id); assert.equal(again.voided, false); assert.equal((again as any).already, "voided");
  assert.equal(await balance("adv:sf"), before, "idempotent");
  // a normal (settled) request is untouched and still debits
  const ok = await rec("MCP server for browser automation"); assert.equal(ok.status, 200);
  assert.ok(await balance("adv:sf") < before);
  assert.equal((await voidUnbilledRequest(ok.request_id)).voided, false, "settled requests are never voided");
});

test("public /v1/requests/:id: payer redacted, no settle_error; rate limits on replay/request/recommend/click; loopback exempt", async () => {
  _resetRateLimits();
  const r = await rec("anything"); assert.equal(r.status, 200);
  const d = await (await fetch(base + "/v1/requests/" + r.request_id)).json();
  assert.equal(d.payer, "0x0000…00c1"); assert.match(d.payer_sha256, /^[0-9a-f]{64}$/); assert.ok(!("settle_error" in d) && !("db_txid" in d));
  const XF = { "X-Forwarded-For": "198.51.100.23" };
  process.env.RL_REPLAY_IP = "2";
  for (let i = 0; i < 2; i++) assert.equal((await fetch(base + "/v1/requests/" + r.request_id + "/replay", { headers: XF })).status, 200);
  const lim = await fetch(base + "/v1/requests/" + r.request_id + "/replay", { headers: XF });
  assert.equal(lim.status, 429); assert.ok(lim.headers.get("retry-after")); assert.equal((await lim.json()).error, "rate_limited");
  assert.equal((await fetch(base + "/v1/requests/" + r.request_id + "/replay")).status, 200, "direct loopback (local scripts) exempt");
  delete process.env.RL_REPLAY_IP;
  process.env.RL_RECOMMEND_WALLET = "1";
  const w = "0x00000000000000000000000000000000000000d7";
  const p1 = await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", ...XF, "X-PAYMENT": `mock:rw1:${w}`, "X-TOS-ACCEPT": TOSH }, body: "{\"query\":\"q\"}" });
  assert.equal(p1.status, 200);
  const p2 = await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-Forwarded-For": "198.51.100.99", "X-PAYMENT": `mock:rw2:${w}`, "X-TOS-ACCEPT": TOSH }, body: "{\"query\":\"q\"}" });
  assert.equal(p2.status, 429, "per-wallet limit applies before the payment is verified/taken");
  assert.equal((await pool.query("SELECT count(*)::int n FROM payment_nonces WHERE nonce LIKE '%rw2%'").catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n, 0);
  delete process.env.RL_RECOMMEND_WALLET;
  process.env.RL_CLICK_IP = "1";
  await fetch(base + "/c/AAAAAAAAAA", { headers: XF, redirect: "manual" });
  assert.equal((await fetch(base + "/c/AAAAAAAAAA", { headers: XF, redirect: "manual" })).status, 429);
  delete process.env.RL_CLICK_IP; _resetRateLimits();
});

test("admin: strong password required, per-IP lockout, CSRF on browser writes; curl-style clients unaffected", async () => {
  _resetAdminLockout();
  assert.equal(passwordStrong("test-pass"), false); assert.equal(passwordStrong("Test-Pass-0123456789"), true);
  const bad = { authorization: "Basic " + Buffer.from("admin:wrong").toString("base64"), "X-Forwarded-For": "198.51.100.66" };
  for (let i = 0; i < 10; i++) assert.equal((await fetch(base + "/dashboard/api/overview", { headers: bad })).status, 401);
  const locked = await fetch(base + "/dashboard/api/overview", { headers: { ...AUTH, "X-Forwarded-For": "198.51.100.66" } });
  assert.equal(locked.status, 429, "locked out even with the right password"); assert.ok(locked.headers.get("retry-after"));
  assert.equal((await fetch(base + "/dashboard/api/admin/bans", { headers: { ...AUTH, "X-Forwarded-For": "198.51.100.67" } })).status, 200, "other IPs unaffected");
  const body = JSON.stringify({ advertiser_id: "adv:csrf", name: "C" });
  assert.equal((await fetch(base + "/dashboard/api/admin/advertisers", { method: "POST", headers: { ...H, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" }, body })).status, 403);
  assert.equal((await fetch(base + "/dashboard/api/admin/advertisers", { method: "POST", headers: { ...H, Origin: "https://evil.example" }, body })).status, 403);
  assert.equal((await fetch(base + "/dashboard/api/admin/advertisers", { method: "POST", headers: { ...H, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" }, body })).status, 403, "browser write without X-Botiny-Client");
  assert.equal((await fetch(base + "/dashboard/api/admin/advertisers", { method: "POST", headers: { ...H, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "X-Botiny-Client": "dashboard" }, body })).status, 201);
  const page = await fetch(base + "/dashboard/", { headers: AUTH }); assert.equal(page.headers.get("x-frame-options"), "DENY"); assert.equal(page.headers.get("cache-control"), "no-store");
  _resetAdminLockout();
});

test("errors: 5xx bodies never carry exception/SQL/RPC text", async () => {
  _resetRateLimits();
  process.env.FAIL_AFTER_IMPRESSIONS = "1";
  const r = await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:e${Date.now()}` }, body: "{\"query\":\"x\"}" });
  delete process.env.FAIL_AFTER_IMPRESSIONS;
  const j = await r.json(); assert.equal(r.status, 500);
  assert.deepEqual(Object.keys(j).sort(), ["error", "message", "request_id"]); assert.equal(j.message, "internal error"); assert.ok(!JSON.stringify(j).includes("injected"));
});

test("relayer-vs-payer: refused even with no PAYER_PRIVATE_KEY set (configured payer addresses)", () => {
  const k = generatePrivateKey(), addr = privateKeyToAccount(k).address;
  const save = { ...process.env };
  delete process.env.PAYER_PRIVATE_KEY; process.env.PAYER_ADDRESSES = "0x1111111111111111111111111111111111111111," + addr; process.env.RELAYER_PRIVATE_KEY = k;
  assert.ok(payerAddresses().has(addr.toLowerCase()));
  assert.throws(() => relayerAccount(), /must not be the payer/);
  process.env.PAYER_ADDRESSES = "0x1111111111111111111111111111111111111111";
  assert.equal(relayerAccount()?.address, addr);
  for (const v of ["PAYER_ADDRESSES", "RELAYER_PRIVATE_KEY", "PAYER_PRIVATE_KEY"]) { if (save[v] == null) delete process.env[v]; else process.env[v] = save[v]; }
});
