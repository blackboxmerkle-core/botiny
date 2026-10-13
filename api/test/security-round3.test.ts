// Security round 3 on 860e0ba: unpaid request privacy (payer proof), stale 'verified' sweep, no compensation without validBefore,
// validBefore cap at verify, permanent-error classification.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "Test-Pass-0123456789";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tosHashOf, DEFAULT_TOS } from "../src/tos";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { _resetRateLimits } from "../src/portal";
import { sweep, _setAuthChecker } from "../src/reconcile";
import { verifyExact, isAmbiguousSettleError } from "../src/facilitator";

const TOSH = tosHashOf(DEFAULT_TOS.bot);
const H = { "content-type": "application/json", authorization: "Basic " + Buffer.from("admin:Test-Pass-0123456789").toString("base64") };
let base = "", server: any, n = 0;
const acct = privateKeyToAccount(generatePrivateKey());

after(async () => { server.close(); await pool.end(); });
const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(r => r.json());
const rec = () => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:r3${Date.now()}${n++}:${acct.address}` },
  body: JSON.stringify({ query: "MCP server for browser automation", k: 8 }) }).then(async r => ({ status: r.status, ...(await r.json()) }));
const get = (p: string, h: Record<string, string> = {}) => fetch(base + p, { headers: h }).then(r => r.json());
const row = async (id: string) => (await pool.query("SELECT payment_status, billing_status, settle_review FROM requests WHERE request_id=$1", [id])).rows[0];

before(async () => {
  await resetTestDb(); server = await new Promise(ok => { const sv = createApp().listen(0, "127.0.0.1", () => ok(sv)); }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ad = await admin("/advertisers", { advertiser_id: "adv:r3", name: "R3" });
  const L = (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:r3", name: "R3 browser automation MCP", description: "MCP server for browser automation", address: "https://r3.example/mcp", kind: "mcp" }) }).then(r => r.json())).listing_id;
  await admin("/advertisers/adv:r3/credit", { amount_atomic: 50_000 });
  await fetch(`${base}/v1/advertisers/me/listings/${L}/bid`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + ad.api_key }, body: JSON.stringify({ bid_atomic: 500 }) });
});

test("1) unsettled request: no impressions/results publicly; replay gives MATCH + hashes only; payer signature unlocks; settled is public", async () => {
  _resetRateLimits();
  process.env.MOCK_SETTLE_UNKNOWN = "1"; const u = await rec(); delete process.env.MOCK_SETTLE_UNKNOWN;
  assert.equal(u.status, 202);
  const pub = await get("/v1/requests/" + u.request_id);
  assert.equal(pub.restricted, true); assert.equal(pub.impressions, undefined); assert.equal(pub.request_canonical, undefined); assert.ok(pub.response_hash);
  const rp = await get(`/v1/requests/${u.request_id}/replay`);
  assert.ok(rp.logged_hash && rp.request_hash); assert.equal(rp.replayed_hash, undefined, "round 4: no re-rank when unsettled"); assert.equal(rp.payment, undefined); assert.equal(rp.restricted, true);
  assert.equal((await get(`/v1/requests/${u.request_id}/replay`, { "x-payer-signature": "0x" + "ab".repeat(65), "x-payer-timestamp": "1e9" })).restricted, true, "non-digit timestamp rejected");
  const ts = Math.floor(Date.now() / 1000);
  const sig = await acct.signMessage({ message: `botiny:request:${u.request_id}:${ts}` });
  const mine = await get("/v1/requests/" + u.request_id, { "x-payer-signature": sig, "x-payer-timestamp": String(ts) });
  assert.ok(Array.isArray(mine.impressions) && mine.impressions.length > 0, "payer sees impressions");
  const prp = await get(`/v1/requests/${u.request_id}/replay`, { "x-payer-signature": sig, "x-payer-timestamp": String(ts) });
  assert.ok(prp.payment); assert.equal(prp.result, "MATCH");
  assert.equal((await get("/v1/requests/" + u.request_id, { "x-payer-signature": sig, "x-payer-timestamp": String(ts) + ".0" })).restricted, true, "timestamp must be /^\\d{1,12}$/");
  assert.equal((await get("/v1/requests/" + u.request_id, { "x-payer-signature": sig, "x-payer-timestamp": "0" + String(ts) })).restricted, true, "signed string must match exactly");
  const other = privateKeyToAccount(generatePrivateKey());
  const bad = await other.signMessage({ message: `botiny:request:${u.request_id}:${ts}` });
  assert.equal((await get("/v1/requests/" + u.request_id, { "x-payer-signature": bad, "x-payer-timestamp": String(ts) })).restricted, true, "wrong signer");
  const old = ts - 3600, stale = await acct.signMessage({ message: `botiny:request:${u.request_id}:${old}` });
  assert.equal((await get("/v1/requests/" + u.request_id, { "x-payer-signature": stale, "x-payer-timestamp": String(old) })).restricted, true, "stale timestamp");
  const s = await rec(); assert.equal(s.status, 200);
  assert.ok((await get("/v1/requests/" + s.request_id)).impressions.length > 0, "settled is public");
});

test("3+4) sweeper resolves stale 'verified' rows; unused without validBefore -> admin review, never compensated", async () => {
  _resetRateLimits();
  const a = await rec(), b = await rec(), c = await rec();
  const vb = Math.floor(Date.now() / 1000) - 3600;
  await pool.query("UPDATE requests SET payment_status='verified', received_at=now()-interval '11 minutes' WHERE request_id = ANY($1)", [[a.request_id, b.request_id, c.request_id]]);
  await pool.query("UPDATE requests SET payment_valid_before=$2 WHERE request_id=$1", [b.request_id, vb]);
  await pool.query("UPDATE requests SET payment_valid_before=NULL WHERE request_id=$1", [c.request_id]);
  const fresh = await rec(); await pool.query("UPDATE requests SET payment_status='verified' WHERE request_id=$1", [fresh.request_id]);
  const st = new Map([[a.request_id, true], [b.request_id, false], [c.request_id, false], [fresh.request_id, true]]);
  _setAuthChecker(async (x: any) => st.get(x.request_id) ?? null);
  const r: any = await sweep();
  assert.deepEqual(await row(a.request_id), { payment_status: "settled", billing_status: "billed", settle_review: false });
  assert.deepEqual(await row(b.request_id), { payment_status: "settle_failed", billing_status: "voided", settle_review: false });
  assert.deepEqual(await row(c.request_id), { payment_status: "verified", billing_status: "billed", settle_review: true }, "no validBefore: review, not compensated");
  assert.equal((await row(fresh.request_id)).payment_status, "verified", "fresh verified rows are left alone");
  assert.equal(r.review, 1);
  await sweep(); assert.equal((await row(c.request_id)).billing_status, "billed", "review rows are not retried/compensated");
  const vbStored = (await pool.query("SELECT payment_valid_before FROM requests WHERE request_id=$1", [fresh.request_id])).rows[0];
  assert.ok("payment_valid_before" in vbStored);
  _setAuthChecker(null);
});

test("6) validBefore capped at verify (default now+600 s, X402_MAX_VALID_BEFORE_S)", async () => {
  const now = 1_800_000_000, to = "0x000000000000000000000000000000000000dEaD";
  const p = (vb: number) => ({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { signature: "0x" + "11".repeat(65), authorization: { from: acct.address, to, value: "1000", validAfter: String(now - 10), validBefore: String(vb), nonce: "0x" + "22".repeat(32) } } }) as any;
  const r1: any = await verifyExact(p(now + 3600), { chainId: 84532 } as any, { amount: 1000n, payTo: to }, { now });
  assert.equal(r1.ok, false); assert.match(r1.reason, /invalid_valid_before/);
  const r2: any = await verifyExact(p(now + 300), { chainId: 84532 } as any, { amount: 1000n, payTo: to }, { now });
  assert.doesNotMatch(String(r2.reason), /invalid_valid_before/, "within cap passes this check");
  process.env.X402_MAX_VALID_BEFORE_S = "60";
  const r3: any = await verifyExact(p(now + 300), { chainId: 84532 } as any, { amount: 1000n, payTo: to }, { now });
  assert.match(r3.reason, /invalid_valid_before/); delete process.env.X402_MAX_VALID_BEFORE_S;
});

test("round 4: settle-error classification (ambiguous first, exact definite strings only)", () => {
  const def: [string, "self" | "facilitator"][] = [
    ['The contract function "transferWithAuthorization" reverted with the following reason:\nFiatTokenV2: authorization is used or canceled', "self"],
    ["execution reverted: FiatTokenV2: authorization is expired", "self"], ["FiatTokenV2: authorization is not yet valid", "self"],
    ["FiatTokenV2: invalid signature", "self"], ["EIP3009: invalid signature", "self"], ["invalid signature", "self"],
    ["ERC20: transfer amount exceeds balance", "self"], ["transaction reverted", "self"],
    ["pre-broadcast: refusing to settle on mainnet", "self"], ["pre-broadcast: RELAYER_PRIVATE_KEY not configured", "facilitator"],
    ["Missing or invalid parameters.\nDouble check you have provided the correct parameters.", "facilitator"]];
  for (const [m, src] of def) assert.equal(isAmbiguousSettleError(m, null, src), false, m);
  const amb: [string, "self" | "facilitator"][] = [
    ["request timed out", "self"], ["fetch failed", "self"], ["ECONNRESET", "self"], ["HTTP request failed.\n\nStatus: 503", "facilitator"], ["Status: 429", "self"],
    ["nonce too low", "self"], ["replacement transaction underpriced", "self"], ["already known", "self"], ["transaction broadcast but not mined", "self"],
    ["Missing or invalid parameters.\nDouble check you have provided the correct parameters.\n\nURL: https://sepolia.base.org", "self"],   // RPC on eth_sendRawTransaction
    ["Missing or invalid parameters.", "self"], ["HTTP request failed.\n\nStatus: 429\nURL: https://sepolia.base.org/", "facilitator"],
    ["nonce", "self"], ["expired", "self"], ["invalid_exact_evm_payload_signature", "facilitator"], ["insufficient_funds", "facilitator"],
    ["FiatTokenV2: authorization is used or canceled", "facilitator"],   // self-only USDC revert patterns
    ["", "self"], ["something odd happened", "self"]];
  for (const [m, src] of amb) assert.equal(isAmbiguousSettleError(m, null, src), true, m);
  assert.equal(isAmbiguousSettleError("FiatTokenV2: invalid signature", "0xabc"), true, "a broadcast tx is always ambiguous");
  assert.equal(isAmbiguousSettleError("FiatTokenV2: authorization is expired; request timed out"), true, "ambiguous patterns checked first");
});
