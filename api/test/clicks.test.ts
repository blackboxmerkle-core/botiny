import { tosHashOf, DEFAULT_TOS } from "../src/tos";
const TOSH = tosHashOf(DEFAULT_TOS.bot);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
process.env.DASHBOARD_PASSWORD = "test-pass";
const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { canonicalize, sha256 } from "../src/canonical";
import { clickKeys } from "../src/clicks";
import { saveSettings } from "../src/settings";

let base = ""; let server: any;
before(async () => { await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); await pool.end(); });
const H = { "content-type": "application/json", ...AUTH };
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
let n = 0;
const rec = (query: string, k = 8, extra: Record<string, string> = {}) => fetch(base + "/v1/recommend", { method: "POST",
  headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:c${Date.now()}${n++}:0x00000000000000000000000000000000000000b0`, ...extra },
  body: JSON.stringify({ query, k }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const balance = async (a: string) => Number((await pool.query("SELECT COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id=$1", [a])).rows[0].b);
const Q = "MCP server for browser automation";
let key = "", L1 = "", L2 = "", L3 = "";
const listing = async (provider_id: string, name: string, description: string) =>
  (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id, name, description, address: "https://" + provider_id.replace(/\W/g, "") + ".example/" + name.replace(/\W/g, ""), kind: "mcp" }) })).json();
const offer = (l: string, b: any, k = key) => fetch(`${base}/v1/advertisers/me/listings/${l}/incentive`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + k }, body: JSON.stringify(b) });

test("setup: advertiser offers incentives; validation + ownership", async () => {
  const a = await admin("/advertisers", { advertiser_id: "adv:inc", name: "Inc" }); key = a.api_key;
  L1 = (await listing("adv:inc", "Inc browser automation MCP", "MCP server for browser automation and scraping")).listing_id;
  L2 = (await listing("adv:inc", "Inc browser automation MCP two", "MCP server for browser automation, second")).listing_id;
  L3 = (await listing("adv:inc", "Inc browser automation MCP three", "MCP server for browser automation, third")).listing_id;
  assert.equal((await offer(L1, { show_atomic: -1 })).status, 400);
  const other = (await pool.query("SELECT listing_id FROM listings WHERE provider_id LIKE 'seed:%' LIMIT 1")).rows[0].listing_id;
  assert.equal((await offer(other, { show_atomic: 10 })).status, 403);
  for (const l of [L1, L2, L3]) assert.equal((await offer(l, { show_atomic: 100000, click_atomic: 100000 })).status, 200);
});

test("unfunded advertiser: links issued but zero incentive, no escrow, nothing negative", async () => {
  const r = await rec(Q);
  assert.equal(r.status, 200);
  assert.equal(r.click_links.length, r.response.results.length);
  assert.ok(r.click_links.every((c: any) => c.show_incentive_atomic === 0 && c.click_incentive_atomic === 0));
  assert.equal((await pool.query("SELECT count(*)::int n FROM balance_ledger WHERE kind='incentive_escrow'")).rows[0].n, 0);
});

test("funded: caps applied, escrow in same tx as request/impressions, tokens verify, hash excludes links, replay matches", async () => {
  await admin(`/advertisers/adv:inc/credit`, { amount_atomic: 5000 });
  const before = await balance("adv:inc");
  const r = await rec(Q, 8, { "X-Bot-Channel": "chat" });
  assert.equal(r.status, 200);
  const fee = 1000; // default query_price_atomic
  const all = r.click_links.filter((c: any) => [L1, L2, L3].includes(c.listing_id));
  const mine = all.filter((c: any) => !c.tracked_only);
  assert.ok(mine.length > 0 && mine.length <= 2, "≤2 slots per cluster get incentivised links");
  assert.equal(all.length, r.response.results.filter((x: any) => [L1, L2, L3].includes(x.listing_id)).length, "every result has a link");
  assert.ok(all.filter((c: any) => c.tracked_only).every((c: any) => c.show_incentive_atomic + c.click_incentive_atomic === 0));
  for (const c of mine) { assert.ok(c.show_incentive_atomic <= 0.25 * fee && c.click_incentive_atomic <= 0.25 * fee); assert.equal(c.disclosure, "Incentivised listing"); }
  const total = mine.reduce((s: number, c: any) => s + c.show_incentive_atomic + c.click_incentive_atomic, 0);
  assert.ok(total > 0 && total <= 0.5 * fee, `cluster cap: ${total}`);
  // links match response ranks
  for (const c of r.click_links) assert.equal(r.response.results[c.rank - 1].listing_id, c.listing_id);
  // escrow
  const esc = (await pool.query("SELECT delta_atomic::int d, db_txid::text x FROM balance_ledger WHERE kind='incentive_escrow' AND request_id=$1", [r.request_id])).rows;
  assert.equal(esc.length, 1); assert.equal(esc[0].d, -total);
  const rx = (await pool.query("SELECT db_txid::text x, click_kid, click_config FROM requests WHERE request_id=$1", [r.request_id])).rows[0];
  assert.equal(esc[0].x, rx.x); assert.equal(rx.click_config.fee_atomic, fee); assert.ok(rx.click_kid);
  assert.ok(before - (await balance("adv:inc")) >= total);
  const toks = (await pool.query("SELECT count(*)::int n FROM harvest_tokens WHERE request_id=$1", [r.request_id])).rows[0].n;
  assert.equal(toks, r.click_links.length);
  assert.equal((await pool.query("SELECT count(*)::int n FROM short_links s JOIN harvest_tokens h USING (token) WHERE h.request_id=$1", [r.request_id])).rows[0].n, toks);
  // token signature verifies with the click-server verifier and binds wallet + dest
  const { verifyToken } = await import(pathToFileURL(join(__dirname, "..", "..", "click-server", "src", "token.js")).href);
  const k = (await clickKeys())!;
  const v = await verifyToken({ [k.kid]: k.publicKey }, mine[0].harvest_token);
  assert.equal(v.ok, true); assert.equal(v.payload.bot_wallet, "0x00000000000000000000000000000000000000b0"); assert.equal(v.payload.channel, "chat");
  // response hash covers only the ranked response; links are a sibling
  assert.equal(r.response_hash, sha256(canonicalize(r.response)));
  assert.ok(!JSON.stringify(r.response).includes("hv_"));
  const rp = await (await fetch(`${base}/v1/requests/${r.request_id}/replay`)).json();
  assert.equal(rp.match, true);
  // a second identical request gets different tokens but the same ranking proof inputs logic
  const r2 = await rec(Q);
  assert.notEqual(r2.click_links[0]?.harvest_token, r.click_links[0]?.harvest_token);
});

test("never-negative: provider that can't cover its capped total carries no incentive", async () => {
  const bal = await balance("adv:inc");
  await pool.query("INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,note) VALUES ('adv:inc',$1,'admin_credit','test drain')", [-(bal - 10)]);
  const r = await rec(Q);
  assert.equal(r.status, 200);
  assert.ok(r.click_links.every((c: any) => c.show_incentive_atomic + c.click_incentive_atomic === 0));
  assert.equal(await balance("adv:inc"), 10);
  assert.equal((await pool.query("SELECT advertiser_id FROM balance_ledger GROUP BY 1 HAVING SUM(delta_atomic) < 0")).rows.length, 0);
});

test("fee is config: raising query price raises caps", async () => {
  await admin(`/advertisers/adv:inc/credit`, { amount_atomic: 100000 });
  await saveSettings({ query_price_atomic: 10000 }, "test $0.01");
  const r = await rec(Q);
  const mine = r.click_links.filter((c: any) => [L1, L2, L3].includes(c.listing_id));
  const total = mine.reduce((s: number, c: any) => s + c.show_incentive_atomic + c.click_incentive_atomic, 0);
  assert.ok(total > 500 && total <= 5000, `${total}`);
  await saveSettings({ query_price_atomic: 1000 }, "back");
});

test("failure mid-transaction leaves no tokens, links or escrow", async () => {
  const c = async () => (await pool.query("SELECT (SELECT count(*) FROM harvest_tokens)::int t, (SELECT count(*) FROM short_links)::int s, (SELECT count(*) FROM balance_ledger WHERE kind='incentive_escrow')::int e")).rows[0];
  const b = await c();
  process.env.FAIL_AFTER_IMPRESSIONS = "1";
  const r = await rec(Q);
  delete process.env.FAIL_AFTER_IMPRESSIONS;
  assert.equal(r.status, 500);
  assert.deepEqual(await c(), b);
});

test("migration recorded once; balance_ledger accepts incentive_escrow only via new constraint", async () => {
  assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name='0001_click_incentives.sql'")).rows[0].n, 1);
  await assert.rejects(pool.query("INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind) VALUES ('adv:inc',0,'bogus')"));
});
