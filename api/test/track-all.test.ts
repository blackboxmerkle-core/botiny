// Every /v1/recommend result gets its own tracked link (short_url + track_url), with or without an incentive.
process.env.CS_CFG_minClickDelayMs = "0";
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
import { canonicalize, sha256 } from "../src/canonical";
import { _resetClickKeys, linkKeys } from "../src/clicks";

let base = ""; let server: any;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const H = { "content-type": "application/json", ...AUTH };
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
let n = 0;
const W = "0x00000000000000000000000000000000000000c1";
const rec = (query = "MCP server for browser automation", k = 8) => fetch(base + "/v1/recommend", { method: "POST",
  headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:t${Date.now()}${n++}:${W}` }, body: JSON.stringify({ query, k }) })
  .then(async r => ({ status: r.status, ...(await r.json()) }));
const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", accept: "text/html,application/xhtml+xml",
  "sec-fetch-mode": "navigate", "accept-language": "en-GB", "x-forwarded-for": "81.2.69.160" };
const ledgerRows = async (rid: string) => Number((await pool.query("SELECT count(*)::int n FROM balance_ledger WHERE request_id=$1 AND kind LIKE 'incentive%'", [rid])).rows[0].n);
const clickRows = async (tok: string) => { for (let i = 0; i < 50; i++) { const r = (await pool.query("SELECT class, paid FROM clicks WHERE token=$1", [tok])).rows; if (r.length) return r; await new Promise(f => setTimeout(f, 50)); } return []; };
let L = "", key = "";

test("every result has a unique link (no offers anywhere), outside the hash, replay MATCH", async () => {
  const r = await rec();
  assert.equal(r.status, 200); assert.ok(r.response.results.length > 1);
  assert.equal(r.click_links.length, r.response.results.length);
  for (const c of r.click_links) {
    assert.equal(r.response.results[c.rank - 1].listing_id, c.listing_id);
    assert.ok(c.short_url && c.track_url && c.harvest_token);
    assert.equal(c.show_incentive_atomic + c.click_incentive_atomic, 0);
  }
  assert.equal(new Set(r.click_links.map((c: any) => c.short_url)).size, r.click_links.length);
  assert.equal(new Set(r.click_links.map((c: any) => c.track_url)).size, r.click_links.length);
  assert.equal(r.response_hash, sha256(canonicalize(r.response))); assert.ok(!JSON.stringify(r.response).includes("hv_"));
  assert.equal(await ledgerRows(r.request_id), 0);
  assert.equal((await (await fetch(`${base}/v1/requests/${r.request_id}/replay`)).json()).match, true);
});

test("zero-incentive link redirects to the destination and the click is recorded (class tracked, unpaid, no ledger)", async () => {
  const r = await rec(); const c = r.click_links[r.click_links.length - 1];
  const code = c.short_url.split("/").pop();
  const res = await fetch(`${base}/c/${code}`, { headers: BROWSER, redirect: "manual" });
  assert.ok([302, 303, 307].includes(res.status), String(res.status));
  assert.ok(res.headers.get("location")!.startsWith(r.response.results[c.rank - 1].address));
  const rows = await clickRows(c.harvest_token);
  assert.equal(rows.length, 1); assert.equal(rows[0].paid, false);
  assert.equal(rows[0].class, "tracked");
  const tr = await fetch(`${base}/c/r/${c.harvest_token}`, { headers: { ...BROWSER, "x-forwarded-for": "81.2.70.9" }, redirect: "manual" });
  assert.ok(tr.headers.get("location")!.startsWith(r.response.results[c.rank - 1].address));
  assert.equal(await ledgerRows(r.request_id), 0);
  assert.equal(Number((await pool.query("SELECT count(*)::int n FROM incentive_ledger WHERE token=$1", [c.harvest_token])).rows[0].n), 0);
});

test("with an offer: incentivised rows paid as before, rest tracked; CLICK_INCENTIVES=0 still issues links", async () => {
  const a = await admin("/advertisers", { advertiser_id: "adv:trk", name: "Trk" }); key = a.api_key;
  L = (await (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:trk", name: "Trk browser automation MCP", description: "MCP server for browser automation", address: "https://trk.example/m", kind: "mcp" }) })).json()).listing_id;
  assert.equal((await fetch(`${base}/v1/advertisers/me/listings/${L}/incentive`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ show_atomic: 50, click_atomic: 50 }) })).status, 200);
  await admin(`/advertisers/adv:trk/credit`, { amount_atomic: 100000 });
  const r = await rec();
  assert.equal(r.click_links.length, r.response.results.length);
  const inc = r.click_links.filter((c: any) => c.show_incentive_atomic + c.click_incentive_atomic > 0);
  assert.ok(inc.length > 0, JSON.stringify(r.click_links.map((c: any) => [c.listing_id, c.tracked_only])) + JSON.stringify(r.config ?? null)); assert.ok(inc.every((c: any) => c.listing_id === L));
  assert.equal((await (await fetch(`${base}/v1/requests/${r.request_id}/replay`)).json()).match, true);
  process.env.CLICK_INCENTIVES = "0";
  try {
    const d = await rec();
    assert.equal(d.click_links.length, d.response.results.length);
    assert.ok(d.click_links.every((c: any) => c.tracked_only && c.show_incentive_atomic + c.click_incentive_atomic === 0));
    assert.equal(await ledgerRows(d.request_id), 0);
    assert.equal((await (await fetch(`${base}/v1/requests/${d.request_id}/replay`)).json()).match, true);
  } finally { delete process.env.CLICK_INCENTIVES; }
});

test("no signing key in production: tracking-only links, still redirect after key loss", async () => {
  const pm = process.env.PAYMENT_MODE, jwk = process.env.CLICK_SIGNING_KEY_JWK;
  delete process.env.CLICK_SIGNING_KEY_JWK;
  let r: any;
  try {
    // resolve keys as production would (non-mock, no JWK), then serve the request with mock payments
    process.env.PAYMENT_MODE = "x402"; _resetClickKeys(); const k = await linkKeys(); process.env.PAYMENT_MODE = pm;
    assert.equal(k.tracking_only, true);
    r = await rec();
    assert.equal(r.click_links.length, r.response.results.length);
    assert.ok(r.click_links.every((c: any) => c.tracked_only && c.show_incentive_atomic + c.click_incentive_atomic === 0));
    assert.equal(await ledgerRows(r.request_id), 0);
  } finally { process.env.PAYMENT_MODE = pm; if (jwk) process.env.CLICK_SIGNING_KEY_JWK = jwk; _resetClickKeys(); }
  // new process key (simulated restart): the tracking-only link still resolves from the stored row
  const code = r.click_links[0].short_url.split("/").pop();
  const res = await fetch(`${base}/c/${code}`, { headers: { ...BROWSER, "x-forwarded-for": "81.2.71.1" }, redirect: "manual" });
  assert.ok(res.headers.get("location")!.startsWith(r.response.results[0].address));
});

test("dashboard click analytics: organic / promoted / incentive segments, by rank, by listing", async () => {
  const a = await (await fetch(base + "/dashboard/api/click-analytics", { headers: AUTH })).json();
  assert.ok(a.totals.links > 0); assert.ok(a.totals.clicks >= 2);
  const segs = a.by_segment.map((s: any) => s.segment);
  assert.ok(segs.includes("organic"), JSON.stringify(a)); assert.ok(segs.includes("incentive"), JSON.stringify(a.by_segment));
  assert.ok(a.by_rank.length > 1); assert.ok(a.by_listing.length > 0); assert.ok(a.by_class.some((c: any) => c.class === "tracked"));
});
