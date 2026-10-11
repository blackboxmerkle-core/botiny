import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toHex } from "viem";
import { randomBytes } from "node:crypto";
import { CHAINS, chainFor, configuredChains } from "../src/chains";
import { verifyExact, settleExact, decodeExactPayload, ChainRpc, TWA_TYPES, setRpcFactory } from "../src/facilitator";
import { _resetGasCache, activeChains, GasRow } from "../src/relayer";
import { requestHashOf, boundNonce, checkTos, tosHashOf, DEFAULT_TOS, saveTos } from "../src/tos";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";

const payer = privateKeyToAccount(generatePrivateKey());
const PAYTO = "0x0e66433540a91D9683E939c8Ac17BC084571D050";
const bs = chainFor("base-sepolia")!;
async function sign(o: { to?: string; value?: bigint; validAfter?: number; validBefore?: number; nonce?: string; chain?: typeof bs } = {}) {
  const c = o.chain ?? bs, now = Math.floor(Date.now() / 1000);
  const auth = { from: payer.address, to: (o.to ?? PAYTO) as `0x${string}`, value: o.value ?? 1000n, validAfter: BigInt(o.validAfter ?? now - 60), validBefore: BigInt(o.validBefore ?? now + 120),
    nonce: (o.nonce ?? toHex(randomBytes(32))) as `0x${string}` };
  const signature = await payer.signTypedData({ domain: { name: c.eip712.name, version: c.eip712.version, chainId: c.chainId, verifyingContract: c.usdc }, types: TWA_TYPES, primaryType: "TransferWithAuthorization", message: auth });
  const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: c.key, payload: { signature, authorization: { ...auth, value: String(auth.value), validAfter: String(auth.validAfter), validBefore: String(auth.validBefore) } } })).toString("base64");
  return decodeExactPayload(header)!;
}
const usedOnChain = new Set<string>();
const fakeRpc = (over: Partial<ChainRpc> = {}): ChainRpc => ({
  authorizationState: async (_f, n) => usedOnChain.has(n), balanceOf: async () => 5_000_000n, nativeBalance: async () => 10n ** 18n,
  submitTransfer: async (a) => { usedOnChain.add(a.nonce); return "0x" + "ab".repeat(32); }, waitReceipt: async () => ({ status: "success", blockNumber: 1n }), ...over });
before(async () => { await resetTestDb(); });
after(async () => { setRpcFactory(null); await pool.end(); });

test("EIP-3009 verify: valid passes; wrong payTo, expired, insufficient amount, wrong chain domain, replayed nonce fail", async () => {
  const rpc = fakeRpc();
  assert.deepEqual(await verifyExact(await sign(), bs, { amount: 1000n, payTo: PAYTO }, { rpc }), { ok: true, payer: payer.address });
  const r1 = await verifyExact(await sign({ to: "0x000000000000000000000000000000000000dEaD" }), bs, { amount: 1000n, payTo: PAYTO }, { rpc });
  assert.match((r1 as any).reason, /invalid_payto/);
  const now = Math.floor(Date.now() / 1000);
  assert.match((await verifyExact(await sign({ validBefore: now - 1 }), bs, { amount: 1000n, payTo: PAYTO }, { rpc }) as any).reason, /expired/);
  assert.match((await verifyExact(await sign({ validAfter: now + 600 }), bs, { amount: 1000n, payTo: PAYTO }, { rpc }) as any).reason, /not_yet_valid/);
  assert.match((await verifyExact(await sign({ value: 999n }), bs, { amount: 1000n, payTo: PAYTO }, { rpc }) as any).reason, /insufficient_amount/);
  // signed for Arbitrum Sepolia domain but presented as Base Sepolia -> signature recovery mismatch
  assert.match((await verifyExact(await sign({ chain: chainFor("arbitrum-sepolia")! }), bs, { amount: 1000n, payTo: PAYTO }, { rpc }) as any).reason, /invalid_signature/);
  // tampered value after signing
  const p = await sign(); p.payload.authorization.value = "5000";
  assert.match((await verifyExact(p, bs, { amount: 1000n, payTo: PAYTO }, { rpc }) as any).reason, /invalid_signature/);
  // replayed nonce: on-chain authorizationState, and our DB
  const once = await sign(); usedOnChain.add(once.payload.authorization.nonce);
  assert.match((await verifyExact(once, bs, { amount: 1000n, payTo: PAYTO }, { rpc }) as any).reason, /nonce_reused.*on-chain/);
  const dbn = await sign();
  assert.match((await verifyExact(dbn, bs, { amount: 1000n, payTo: PAYTO }, { rpc, nonceUsedInDb: async () => true }) as any).reason, /nonce_reused/);
  assert.match((await verifyExact(await sign(), bs, { amount: 1000n, payTo: PAYTO }, { rpc: fakeRpc({ balanceOf: async () => 10n }) }) as any).reason, /insufficient_funds/);
});

test("settlement via mocked RPC: submits transferWithAuthorization, waits receipt, reports revert/errors", async () => {
  const p = await sign(); let submitted: any = null;
  const ok = await settleExact(p, bs, fakeRpc({ submitTransfer: async (a, s) => { submitted = { a, s }; return "0x" + "cd".repeat(32); } }));
  assert.deepEqual(ok, { ok: true, tx: "0x" + "cd".repeat(32) });
  assert.equal(submitted.a.nonce, p.payload.authorization.nonce); assert.equal(submitted.s, p.payload.signature);
  const rev = await settleExact(p, bs, fakeRpc({ waitReceipt: async () => ({ status: "reverted" }) }));
  assert.equal(rev.ok, false); assert.match(rev.error!, /reverted/);
  const err = await settleExact(p, bs, fakeRpc({ submitTransfer: async () => { throw new Error("insufficient funds for gas"); } }));
  assert.equal(err.ok, false); assert.match(err.error!, /gas/);
});

test("chain selection: v1 names + CAIP-2 accepted, mainnet never, chains without relayer gas drop out", async () => {
  assert.equal(chainFor("eip155:84532")?.key, "base-sepolia"); assert.equal(chainFor("base-sepolia")?.chainId, 84532);
  assert.equal(chainFor("eip155:421614")?.key, "arbitrum-sepolia");
  for (const m of ["base", "eip155:8453", "ethereum", "eip155:1", "polygon", "linea-sepolia", "solana-devnet"]) assert.equal(chainFor(m), null, m);
  assert.ok(CHAINS.filter(c => !c.testnet).every(c => !c.enabled));
  assert.ok(configuredChains().every(c => c.testnet));
  for (const k of ["base-sepolia", "sepolia", "arbitrum-sepolia", "optimism-sepolia", "polygon-amoy", "avalanche-fuji"]) assert.ok(configuredChains().some(c => c.key === k), k);
  const rows = (ok: string[]): GasRow[] => configuredChains().map(c => ({ key: c.key, label: c.label, chainId: c.chainId, native: c.native, wei: "0", balance: "0", min: "0", ok: ok.includes(c.key),
    settle_via: ok.includes(c.key) ? "self" : c.key === "base-sepolia" ? "facilitator-fallback" : "none" }));
  _resetGasCache(rows(["sepolia", "avalanche-fuji"]));
  const act = await activeChains();
  assert.deepEqual(act.map(a => a.chain.key).sort(), ["avalanche-fuji", "base-sepolia", "sepolia"]);
  assert.equal(act.find(a => a.chain.key === "base-sepolia")!.settle_via, "facilitator-fallback");
  _resetGasCache();
});

test("ToS binding: nonce must equal keccak256(tosHash||requestHash||salt); missing / stale / mismatched / unbound rejected", async () => {
  const h1 = tosHashOf(DEFAULT_TOS.bot), salt = toHex(randomBytes(32)), params = { query: "q", k: 3 };
  const nonce = boundNonce(h1, requestHashOf("/v1/recommend", params), salt);
  const ok = await checkTos("bot", { accept: h1, salt }, "/v1/recommend", params, nonce);
  assert.equal(ok.ok, true); assert.equal((ok as any).proof.method, "eip3009-nonce");
  assert.match(((await checkTos("bot", {}, "/v1/recommend", params, nonce)) as any).reason, /tos_missing/);
  assert.match(((await checkTos("bot", { accept: "0x" + "00".repeat(32), salt }, "/v1/recommend", params, nonce)) as any).reason, /tos_mismatch/);
  assert.match(((await checkTos("bot", { accept: h1 }, "/v1/recommend", params, nonce)) as any).reason, /tos_unbound/);
  assert.match(((await checkTos("bot", { accept: h1, salt }, "/v1/recommend", { query: "other", k: 3 }, nonce)) as any).reason, /tos_unbound/, "different request => different nonce");
  assert.match(((await checkTos("bot", { accept: h1, salt }, "/v1/recommend", params, toHex(randomBytes(32)))) as any).reason, /tos_unbound/);
  assert.match(((await checkTos("advertiser", { accept: h1, salt }, "/v1/recommend", params, nonce)) as any).reason, /tos_mismatch/, "bot ToS is not the advertiser ToS");
  await saveTos("bot", DEFAULT_TOS.bot + "\n7. DRAFT amendment.\n", "test edit");
  assert.match(((await checkTos("bot", { accept: h1, salt }, "/v1/recommend", params, nonce)) as any).reason, /tos_stale: version 1 accepted, current is 2/);
  await assert.rejects(saveTos("bot", "x".repeat(80), null), /DRAFT/);
});
