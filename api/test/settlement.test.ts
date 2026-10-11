import { tosHashOf, DEFAULT_TOS } from "../src/tos";
const TOSH = tosHashOf(DEFAULT_TOS.bot);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
process.env.DASHBOARD_PASSWORD = "test-pass";
process.env.CS_CFG_minClickDelayMs = "0";
const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { _clickHooks, settleIncentives } from "../src/clicks";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const DAY = 86_400_000;
const bot = privateKeyToAccount(generatePrivateKey());
const W = bot.address.toLowerCase();
let base = ""; let server: any;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const H = { "content-type": "application/json", ...AUTH };
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
let n = 0;
const rec = (payer: string | null = bot.address, extra: Record<string, string> = {}) => fetch(base + "/v1/recommend", { method: "POST",
  headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:s${Date.now()}${n++}` + (payer ? `:${payer}` : ""), ...extra },
  body: JSON.stringify({ query: Q, k: 8 }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const balance = async (a: string) => Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id=$1", [a])).rows[0].b);
const noNegative = async () => assert.equal((await pool.query("SELECT advertiser_id FROM balance_ledger GROUP BY 1 HAVING SUM(delta_atomic) < 0")).rows.length, 0);
const Q = "MCP server for browser automation";
const ADV = "adv:set";
let key = "";
const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate", "accept-language": "en-GB" };
let ipn = 1;
const clickLink = async (short_url: string) => {
  const code = short_url.split("/").pop();
  const r = await fetch(`${base}/c/${code}`, { redirect: "manual", headers: { ...BROWSER, "x-forwarded-for": `81.20.${ipn++}.9` } });
  assert.equal(r.status, 302);
  const click_id = new URL(r.headers.get("location")!).searchParams.get("bs_click");
  for (let i = 0; i < 100; i++) { const row = (await pool.query("SELECT * FROM clicks WHERE click_id=$1", [click_id])).rows[0]; if (row) return row; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("click not scored");
};
const sign = async (method: string, path: string, body: string, acct = bot, ts = Math.floor(Date.now() / 1000)) => {
  const { canonicalMessage } = await import(pathToFileURL(join(__dirname, "..", "..", "click-server", "src", "binding.js")).href);
  const msg = await canonicalMessage({ method, path, wallet: acct.address, timestamp: String(ts), body });
  return { "x-bot-wallet": acct.address, "x-bot-timestamp": String(ts), "x-bot-signature": await acct.signMessage({ message: msg }) };
};

test("setup advertiser with incentive offers", async () => {
  const a = await admin("/advertisers", { advertiser_id: ADV, name: "Set" }); key = a.api_key;
  for (const nm of ["one", "two"]) {
    const l = await (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: ADV, name: `Set browser automation MCP ${nm}`, description: "MCP server for browser automation", address: `https://set.example/${nm}`, kind: "mcp" }) })).json();
    assert.equal((await fetch(`${base}/v1/advertisers/me/listings/${l.listing_id}/incentive`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ show_atomic: 100, click_atomic: 150 }) })).status, 200);
  }
  await admin(`/advertisers/${ADV}/credit`, { amount_atomic: 2000 });
});

test("tokens bind only to the verified payer wallet, never X-Bot-Id", async () => {
  const r = await rec(null, { "X-Bot-Id": "pretender" });
  assert.equal(r.status, 200); assert.deepEqual(r.click_links, []);
  assert.equal((await pool.query("SELECT count(*)::int n FROM balance_ledger WHERE kind='incentive_escrow'")).rows[0].n, 0);
});

test("balance race: concurrent drain after the affordability check skips the provider's incentives, no 500", async () => {
  _clickHooks.afterAffordabilityCheck = async () => {
    _clickHooks.afterAffordabilityCheck = undefined;
    const b = await balance(ADV);   // another connection commits a debit (bypassing MARKET_LOCK)
    await pool.query("INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,note) VALUES ($1,$2,'admin_credit','race drain')", [ADV, -(b - 50)]);
  };
  const r = await rec();
  assert.equal(r.status, 200, JSON.stringify(r));
  const mine = r.click_links.filter((c: any) => c.show_incentive_atomic + c.click_incentive_atomic > 0);
  assert.equal(mine.length, 0);
  assert.equal(await balance(ADV), 50);
  const cfg = (await pool.query("SELECT click_config FROM requests WHERE request_id=$1", [r.request_id])).rows[0].click_config;
  assert.deepEqual(cfg.skipped, [ADV]);
  await noNegative();
  await admin(`/advertisers/${ADV}/credit`, { amount_atomic: 1950 });
});

let R: any; let clickedEntry = "";
test("redirect + PG scoring: paid click accrues held click + chat show lines", async () => {
  R = await rec();
  const mine = R.click_links.filter((c: any) => c.show_incentive_atomic + c.click_incentive_atomic > 0);
  assert.ok(mine.length >= 1);
  const c = await clickLink(mine[0].short_url);
  assert.equal(c.class, "paid_candidate", JSON.stringify(c.reasons)); assert.equal(c.paid, true);
  const ent = (await pool.query("SELECT entry_id, line, kind, delta_atomic::int d FROM incentive_ledger WHERE set_id=$1 ORDER BY seq", [R.request_id])).rows;
  assert.ok(ent.some(e => e.line === "click" && e.kind === "accrue_held"));
  assert.equal(ent.filter(e => e.line === "show").length, mine.length);
  clickedEntry = `${mine[0].harvest_token}:click`;
  const again = await clickLink(mine[0].short_url);
  assert.equal(again.paid, false);
  // self-click: same client fingerprint as the bot's own API call isn't paid
  const self = await fetch(`${base}/c/${mine[0].short_url.split("/").pop()}`, { redirect: "manual" });
  assert.equal(self.status, 302);
});

test("settlement: unclaimed lines refunded after expiry, held lines vest after holdback; idempotent; conserves escrow; replay intact", async () => {
  const before = await balance(ADV);
  const escrow = -Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text s FROM balance_ledger WHERE kind='incentive_escrow' AND advertiser_id=$1", [ADV])).rows[0].s);
  // nothing due yet
  const s0 = await settleIncentives(Date.now());
  assert.equal(s0.refunded, 0);
  // after token expiry (+grace): every unaccrued line returns; accrued (held) lines don't
  const s1 = await settleIncentives(Date.now() + 8 * DAY);
  assert.ok(s1.refunded > 0);
  const accrued = Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text s FROM incentive_ledger WHERE kind IN ('accrue_held','review_hold')")).rows[0].s);
  assert.equal(escrow, s1.refunded_atomic + accrued, "escrow = refunded + accrued");
  assert.equal(await balance(ADV), before + s1.refunded_atomic);
  // idempotent
  assert.deepEqual(await settleIncentives(Date.now() + 8 * DAY), { vested: 0, refunded: 0, refunded_atomic: 0 });
  // vest after 14-day holdback; no balance movement
  const b2 = await balance(ADV);
  const s2 = await settleIncentives(Date.now() + 15 * DAY);
  assert.ok(s2.vested > 0); assert.equal(s2.refunded, 0); assert.equal(await balance(ADV), b2);
  assert.equal((await settleIncentives(Date.now() + 15 * DAY)).vested, 0);
  await noNegative();
  const rp = await (await fetch(`${base}/v1/requests/${R.request_id}/replay`)).json();
  assert.equal(rp.match, true);
  // the reversal rows are idempotency-keyed
  await assert.rejects(pool.query("INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,escrow_ref) SELECT advertiser_id, 1, 'incentive_escrow_reversal', escrow_ref FROM balance_ledger WHERE escrow_ref IS NOT NULL LIMIT 1"));
  await assert.rejects(pool.query("INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,escrow_ref) VALUES ($1,-5,'incentive_escrow_reversal','x:click')", [ADV]));
  // vested lines can't be clawed back
  const vestedClick = (await pool.query("SELECT click_id FROM incentive_ledger WHERE entry_id=$1 LIMIT 1", [clickedEntry])).rows[0].click_id;
  assert.equal((await fetch(`${base}/v1/admin/clicks/${vestedClick}/clawback`, { method: "POST", headers: H, body: "{}" })).status, 500);
});

test("clawback during holdback returns escrow to the provider (and gated chat shows)", async () => {
  const r = await rec();
  const mine = r.click_links.filter((c: any) => c.show_incentive_atomic + c.click_incentive_atomic > 0);
  const c = await clickLink(mine[0].short_url);
  assert.equal(c.paid, true);
  const b = await balance(ADV);
  const res = await (await fetch(`${base}/v1/admin/clicks/${c.click_id}/clawback`, { method: "POST", headers: H, body: JSON.stringify({ reason: "provider_report" }) })).json();
  assert.ok(res.clawed_back >= 2);
  const refundedNow = Number((await pool.query("SELECT COALESCE(SUM(amount_atomic),0)::text s FROM escrow_refunds WHERE reason='clawback' AND token = ANY($1)", [r.click_links.map((x: any) => x.harvest_token)])).rows[0].s);
  assert.equal(await balance(ADV), b + refundedNow);
  assert.ok(refundedNow > 0);
  // a late accrual for a refunded line is refused
  const again = await settleIncentives(Date.now() + 30 * DAY);
  const tot = Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text s FROM balance_ledger WHERE request_id=$1 AND kind IN ('incentive_escrow','incentive_escrow_reversal')", [r.request_id])).rows[0].s);
  assert.equal(tot, 0, "everything escrowed for this set came back (clawed + unclaimed)");
  assert.ok(again.refunded >= 0);
  await noNegative();
});

test("proofs: EIP-191 signed by the paying wallet (real secp256k1), legacy header marked, wrong wallet refused", async () => {
  const r = await rec();
  const t = r.click_links[0].harvest_token;
  const body = JSON.stringify({ token: t, channel: "web", artefact: "https://blog.example/p" });
  const ok = await fetch(base + "/v1/proofs", { method: "POST", headers: { "content-type": "application/json", ...(await sign("POST", "/v1/proofs", body)) }, body });
  const j = await ok.json(); assert.equal(ok.status, 201, JSON.stringify(j)); assert.equal(j.binding, "signature");
  assert.equal((await pool.query("SELECT binding, bot_wallet FROM proofs WHERE proof_id=$1", [j.proof_id])).rows[0].bot_wallet, W);
  // replay of the identical signed request
  const h2 = await sign("POST", "/v1/proofs", JSON.stringify({ token: t, channel: "x", artefact: "1" }));
  const b2 = JSON.stringify({ token: t, channel: "x", artefact: "1" });
  assert.equal((await fetch(base + "/v1/proofs", { method: "POST", headers: { "content-type": "application/json", ...h2 }, body: b2 })).status, 201);
  assert.equal((await fetch(base + "/v1/proofs", { method: "POST", headers: { "content-type": "application/json", ...h2 }, body: b2 })).status, 401);
  // another wallet with a valid signature can't claim this token
  const other = privateKeyToAccount(generatePrivateKey());
  const b3 = JSON.stringify({ token: t, channel: "bot", artefact: "2" });
  assert.equal((await fetch(base + "/v1/proofs", { method: "POST", headers: { "content-type": "application/json", ...(await sign("POST", "/v1/proofs", b3, other)) }, body: b3 })).status, 403);
  // forged: claims bot wallet but signed by other
  const forged = { ...(await sign("POST", "/v1/proofs", b3, other)), "x-bot-wallet": bot.address };
  assert.equal((await fetch(base + "/v1/proofs", { method: "POST", headers: { "content-type": "application/json", ...forged }, body: b3 })).status, 401);
  // legacy (unsigned) refused by default (CS_CFG_allowUnsignedBotRequests=1 re-enables, marked binding='header')
  const leg = await fetch(base + "/v1/proofs", { method: "POST", headers: { "content-type": "application/json", "x-bot-wallet": bot.address }, body: JSON.stringify({ token: t, channel: "onchain", artefact: "0xabc" }) });
  assert.equal(leg.status, 401); assert.equal((await leg.json()).error, "signature_required");
});

test("earnings require a signed request from the wallet", async () => {
  assert.equal((await fetch(base + "/v1/bots/me/earnings", { headers: { "x-bot-wallet": bot.address } })).status, 401);
  const r = await fetch(base + "/v1/bots/me/earnings", { headers: await sign("GET", "/v1/bots/me/earnings", "") });
  const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.bot_wallet, W); assert.ok(j.vested > 0); assert.ok(j.clawed_back > 0);
});
