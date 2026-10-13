import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
process.env.DASHBOARD_PASSWORD = "Test-Pass-0123456789";
const ENVF = join(mkdtempSync(join(tmpdir(), "envt-")), ".env"); writeFileSync(ENVF, "PORT=1\n"); process.env.ENV_FILE = ENVF;
import { tosHashOf, DEFAULT_TOS } from "../src/tos";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { acceptablePayTos, _resetWalletCache, validatePayTo } from "../src/wallets";
const TOSH = tosHashOf(DEFAULT_TOS.bot);
const A = { authorization: "Basic " + Buffer.from("admin:Test-Pass-0123456789").toString("base64"), "content-type": "application/json" };
const OLD = "0x0e66433540a91D9683E939c8Ac17BC084571D050", NEW = "0x7A21956f3bD1821229ba3EA40e82056f1CA16e24";
let base = "", server: any, n = 0;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const adm = (p: string, body?: any, method = body ? "POST" : "GET") => fetch(base + "/dashboard" + p, { method, headers: A, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, ...(await r.json()) }));
const rec = (h: Record<string, string> = {}) => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:w${Date.now()}${n++}`, ...h }, body: JSON.stringify({ query: "x402 facilitator", k: 2 }) }).then(async r => ({ status: r.status, ...(await r.json()) }));

test("payTo validation: EIP-55 checksum, typed confirmation, zero address", () => {
  assert.match(validatePayTo(NEW.toLowerCase(), NEW.toLowerCase())!, /checksum/);
  assert.match(validatePayTo("0x7a21956f3bD1821229ba3EA40e82056f1CA16e24", "0x7a21956f3bD1821229ba3EA40e82056f1CA16e24")!, /checksum/);
  assert.match(validatePayTo(NEW, NEW.slice(0, -1) + "5")!, /confirmation/);
  assert.match(validatePayTo("0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000")!, /zero/);
  assert.match(validatePayTo("0x123", "0x123")!, /40 hex/);
  assert.equal(validatePayTo(NEW, NEW), null);
});

test("payTo change: versioned + audited, new 402s use it, requests store payTo, replay unaffected, grace for previous", async () => {
  assert.equal((await fetch(base + "/dashboard/api/admin/wallets/payto", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const before = await rec(); assert.equal(before.status, 200);
  assert.equal((await adm("/api/admin/wallets/payto", { address: NEW, confirm: NEW.toLowerCase() })).status, 400);
  const ch = await adm("/api/admin/wallets/payto", { address: NEW, confirm: NEW, note: "test" });
  assert.equal(ch.status, 200); assert.equal(ch.previous, OLD); assert.equal(ch.version, 2);
  assert.equal((await adm("/api/admin/wallets/payto", { address: NEW, confirm: NEW })).status, 409);
  const un = await (await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"query\":\"x\"}" })).json();
  assert.ok(un.accepts.every((a: any) => a.payTo === NEW), "402 uses new payTo immediately");
  const after = await rec(); assert.equal(after.status, 200);
  const rows = (await pool.query("SELECT request_id, pay_to FROM requests WHERE request_id = ANY($1)", [[before.request_id, after.request_id]])).rows;
  assert.equal(rows.find(r => r.request_id === before.request_id).pay_to, OLD); assert.equal(rows.find(r => r.request_id === after.request_id).pay_to, NEW);
  const rp = await (await fetch(`${base}/v1/requests/${before.request_id}/replay`)).json();
  assert.equal(rp.match, true); assert.equal(rp.payment.pay_to, OLD);
  const au = await adm("/api/admin/audit");
  const e = (Object.values(au) as any[]).find((x: any) => x?.action === "payto_change");
  assert.deepEqual([e.actor, e.details.from, e.details.to], ["admin", OLD, NEW]);
  _resetWalletCache(); assert.deepEqual(await acceptablePayTos(), [NEW, OLD], "previous accepted in grace window");
  await pool.query("UPDATE wallet_settings SET created_at = now() - interval '2 hours' WHERE version=2"); _resetWalletCache();
  assert.deepEqual(await acceptablePayTos(), [NEW], "previous rejected after grace");
  const w = await adm("/api/admin/wallets");
  assert.equal(w.pay_to.pay_to, NEW); assert.equal(w.history.length, 2); assert.ok(!JSON.stringify(w).match(/PRIVATE|[0-9a-f]{64}/i));
});

test("relayer rotation: requires ROTATE, stores key server-side only, returns address only, audited", async () => {
  assert.equal((await adm("/api/admin/relayer/rotate", { generate: true })).status, 400);
  const r = await adm("/api/admin/relayer/rotate", { generate: true, confirm: "ROTATE" });
  assert.equal(r.status, 200); assert.match(r.address, /^0x[0-9a-fA-F]{40}$/);
  const env = readFileSync(ENVF, "utf8"); const key = /^RELAYER_PRIVATE_KEY=(0x[0-9a-f]{64})$/m.exec(env)![1];
  assert.ok(!JSON.stringify(r).includes(key.slice(2)), "key never returned");
  assert.match(env, new RegExp(`^RELAYER_ADDRESS=${r.address}$`, "m")); assert.match(env, /^PORT=1$/m);
  assert.equal(statSync(ENVF).mode & 0o777, 0o600);
  const k2 = "0x" + "22".repeat(32);
  const r2 = await adm("/api/admin/relayer/rotate", { private_key: k2, confirm: "ROTATE" });
  assert.equal(r2.previous, r.address); assert.ok(!JSON.stringify(r2).includes("2222222222"));
  assert.equal((await adm("/api/admin/relayer/rotate", { private_key: "nothex", confirm: "ROTATE" })).status, 400);
});

test("bans: 403 before any 402/payment (wallet, IP/CIDR, bot id), counts blocked attempts, expiry, unban", async () => {
  const PAYER = "0x00000000000000000000000000000000000000b4";
  const cnt = async () => Number((await pool.query("SELECT count(*) FROM requests")).rows[0].count);
  const w = await adm("/api/admin/bans", { kind: "wallet", value: PAYER, reason: "abuse test" });
  assert.equal(w.status, 201);
  const c0 = await cnt();
  const blocked = await rec({ "X-PAYMENT": `mock:ban${Date.now()}:${PAYER}` });
  assert.equal(blocked.status, 403); assert.equal(blocked.ban.reason, "abuse test");
  assert.equal(await cnt(), c0, "no request logged / no payment taken");
  assert.equal((await rec()).status, 200, "other payers unaffected");
  // unpaid call from banned bot id gets 403 (not 402)
  const b = await adm("/api/admin/bans", { kind: "bot", value: "evil-bot", reason: "spam" });
  const r402 = await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-Bot-Id": "evil-bot" }, body: "{\"query\":\"x\"}" });
  assert.equal(r402.status, 403);
  // CIDR ban covering localhost
  const ip = await adm("/api/admin/bans", { kind: "ip", value: "127.0.0.0/8", reason: "cidr test" });
  assert.equal((await rec()).status, 403);
  assert.equal((await adm(`/api/admin/bans/${ip.ban_id}/revoke`, {})).status, 200);
  assert.equal((await rec()).status, 200, "unban restores access");
  assert.equal((await adm(`/api/admin/bans/${ip.ban_id}/revoke`, {})).status, 404);
  // expiry
  await pool.query("UPDATE bans SET expires_at = now() - interval '1 second' WHERE ban_id=$1", [b.ban_id]);
  assert.equal((await rec({ "X-Bot-Id": "evil-bot" })).status, 200, "expired ban not enforced");
  assert.equal((await adm("/api/admin/bans", { kind: "ip", value: "300.1.1.1", reason: "bad" })).status, 400);
  assert.equal((await adm("/api/admin/bans", { kind: "wallet", value: PAYER, reason: "x" })).status, 400, "reason too short");
  assert.equal((await adm("/api/admin/bans", { kind: "bot", value: "a", reason: "past", expires_at: "2001-01-01T00:00:00Z" })).status, 400);
  const list = await adm("/api/admin/bans");
  const wb = list.bans.find((x: any) => x.ban_id === w.ban_id);
  assert.equal(wb.blocked_count, 1); assert.equal(wb.active, true);
  assert.ok(list.events.some((e: any) => e.event === "blocked") && list.events.some((e: any) => e.event === "revoked"));
  const au = Object.values(await adm("/api/admin/audit")) as any[];
  assert.ok(au.some(x => x?.action === "ban_create") && au.some(x => x?.action === "ban_revoke"));
});

test("IP ban uses the LAST X-Forwarded-For entry: spoofed leading entries can't evade or frame", async () => {
  const b = await adm("/api/admin/bans", { kind: "ip", value: "203.0.113.0/24", reason: "xff test" });
  assert.equal(b.status, 201);
  assert.equal((await rec({ "X-Forwarded-For": "8.8.8.8, 203.0.113.7" })).status, 403, "spoofed leading entry does not evade");
  assert.equal((await rec({ "X-Forwarded-For": "1.1.1.1,9.9.9.9 , 203.0.113.9" })).status, 403);
  assert.equal((await rec({ "X-Forwarded-For": "203.0.113.7, 9.9.9.9" })).status, 200, "leading entry is ignored");
  assert.equal((await adm(`/api/admin/bans/${b.ban_id}/revoke`, {})).status, 200);
});
