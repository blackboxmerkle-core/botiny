// End-to-end x402 path (PAYMENT_MODE=x402) against a mocked RPC: 402 accepts per chain + ToS, own verification,
// atomic logging incl. ToS proof, settlement via relayer (mock RPC), replay output, nonce replay => 409.
import "./helpers/x402env";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { setRpcFactory, ChainRpc } from "../src/facilitator";
import { _resetGasCache } from "../src/relayer";
import { paidFetch } from "../src/payclient";
const payer = privateKeyToAccount(generatePrivateKey());
const used = new Set<string>(); const submitted: any[] = [];
const rpc = (c: any): ChainRpc => ({ authorizationState: async (_f, n) => used.has(n), balanceOf: async () => 1_000_000n,
  nativeBalance: async () => (["base-sepolia", "sepolia"].includes(c.key) ? 10n ** 18n : 0n),
  submitTransfer: async (a) => { used.add(a.nonce); submitted.push({ chain: c.key, a }); return "0x" + String(submitted.length).padStart(64, "0"); },
  waitReceipt: async () => ({ status: "success" }) });
let base = "", server: any;
before(async () => { setRpcFactory(rpc); _resetGasCache(); await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(async () => { server.close(); setRpcFactory(null); await pool.end(); });

test("402 lists one accept per gas-funded chain with ToS; paid call settles via our relayer; ToS proof logged + replayable", async () => {
  const r = await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "x402", k: 2 }) });
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.deepEqual(j.accepts.map((a: any) => a.network).sort(), ["base-sepolia", "sepolia"], "unfunded chains dropped");
  assert.ok(j.accepts.every((a: any) => a.payTo === "0x0e66433540a91D9683E939c8Ac17BC084571D050" && a.extra.tos.sha256 === j.tos.sha256 && a.extra.settlement === "self"));
  const terms = await fetch(j.tos.url.replace(/^https?:\/\/[^/]+/, base));
  assert.equal(terms.status, 200); assert.match(await terms.text(), /DRAFT/); assert.equal(terms.headers.get("x-tos-sha256"), j.tos.sha256);

  const params = { query: "x402 facilitator settle", k: 2 };
  const p = await paidFetch(base + "/v1/recommend", "/v1/recommend", params, JSON.stringify(params), { account: payer, networks: ["sepolia"], maxAmount: 10_000n, headers: { "X-Bot-Id": "t-bot" } });
  const body = await p.res.json();
  assert.equal(p.res.status, 200, JSON.stringify(body));
  assert.equal(body.payment.network, "sepolia"); assert.equal(body.payment.settle_via, "self");
  assert.equal(submitted.at(-1).chain, "sepolia");
  const row = (await pool.query("SELECT * FROM requests WHERE request_id=$1", [body.request_id])).rows[0];
  assert.equal(row.payment_status, "settled"); assert.equal(row.payment_chain_id, 11155111); assert.equal(row.tos_hash, j.tos.sha256);
  assert.equal(row.tos_proof.method, "eip3009-nonce"); assert.equal(row.tos_proof.nonce, submitted.at(-1).a.nonce.toLowerCase());
  const ix = (await pool.query("SELECT db_txid FROM impressions WHERE request_id=$1", [body.request_id])).rows;
  const nn = (await pool.query("SELECT 1 FROM payment_nonces WHERE nonce=$1", [row.tos_proof.nonce])).rows;
  assert.ok(ix.every(i => i.db_txid === row.db_txid)); assert.equal(nn.length, 1);
  const rp = await (await fetch(`${base}/v1/requests/${body.request_id}/replay`)).json();
  assert.equal(rp.match, true); assert.equal(rp.tos.sha256, j.tos.sha256); assert.equal(rp.tos.proof.salt, p.paid && p.tos.salt);
  const det = await (await fetch(`${base}/dashboard/api/requests/${body.request_id}`, { headers: { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") } })).json();
  assert.equal(det.tos_version, 1);
});

test("rejections: missing ToS, unbound ToS, replayed payment, unsupported network", async () => {
  const params = { query: "rejects", k: 1 };
  // capture a valid signed request, then mutate headers
  let captured: any = null; const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, i: any) => { if (i?.headers?.["X-PAYMENT"]) { captured = i; return new Response("{}", { status: 599 }); } return realFetch(u, i); }) as any;
  await paidFetch(base + "/v1/recommend", "/v1/recommend", params, JSON.stringify(params), { account: payer, networks: ["base-sepolia"], maxAmount: 10_000n });
  globalThis.fetch = realFetch;
  const send = (h: Record<string, string>) => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(params) }).then(async r => ({ status: r.status, ...(await r.json()) }));
  const H = captured.headers;
  const noTos = await send({ "X-PAYMENT": H["X-PAYMENT"] }); assert.equal(noTos.status, 402); assert.match(noTos.error, /tos_missing/);
  const badSalt = await send({ "X-PAYMENT": H["X-PAYMENT"], "X-TOS-ACCEPT": H["X-TOS-ACCEPT"], "X-TOS-SALT": "0x" + "00".repeat(32) }); assert.match(badSalt.error, /tos_unbound/);
  const other = await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": H["X-PAYMENT"], "X-TOS-ACCEPT": H["X-TOS-ACCEPT"], "X-TOS-SALT": H["X-TOS-SALT"] }, body: JSON.stringify({ query: "different", k: 1 }) }).then(r => r.json());
  assert.match(other.error, /tos_unbound/, "payment bound to a different request body");
  const ok = await send({ "X-PAYMENT": H["X-PAYMENT"], "X-TOS-ACCEPT": H["X-TOS-ACCEPT"], "X-TOS-SALT": H["X-TOS-SALT"] }); assert.equal(ok.status, 200);
  const again = await send({ "X-PAYMENT": H["X-PAYMENT"], "X-TOS-ACCEPT": H["X-TOS-ACCEPT"], "X-TOS-SALT": H["X-TOS-SALT"] });
  assert.ok(again.status === 409 || (again.status === 402 && /nonce_reused/.test(again.error)), JSON.stringify(again));
  const p = JSON.parse(Buffer.from(H["X-PAYMENT"], "base64").toString()); p.network = "eip155:8453";
  const main = await send({ "X-PAYMENT": Buffer.from(JSON.stringify(p)).toString("base64"), "X-TOS-ACCEPT": H["X-TOS-ACCEPT"], "X-TOS-SALT": H["X-TOS-SALT"] });
  assert.match(main.error, /unsupported network/);
});
