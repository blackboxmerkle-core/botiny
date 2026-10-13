import { isAmbiguousSettleError } from "./facilitator";
import { sha256 } from "./canonical";
import { getAddress } from "viem";
import { pool } from "./db";
import { configuredChains, chainFor, EvmChain, MAINNET_ALLOWED } from "./chains";
import { decodeExactPayload, verifyExact, settleExact, ExactPayload } from "./facilitator";
import { activeChains, FALLBACK_URL } from "./relayer";
/**
 * x402 'exact' on EVM TESTNETS, verified and settled by OUR OWN facilitator (src/facilitator.ts).
 * PAYMENT_MODE=mock -> header "mock:<nonce>[:<0xpayer>]" accepted; no chain calls (tests/dev).
 * PAYMENT_MODE=x402 -> EIP-3009 payload verified locally (EIP-712 recovery, payTo, amount, window, nonce via DB + authorizationState,
 *                      balance) and settled by submitting transferWithAuthorization from our relayer wallet.
 */
export const PRICE_ATOMIC = BigInt(process.env.PRICE_ATOMIC ?? "1000");
export const MODE = (process.env.PAYMENT_MODE ?? "mock") as "mock" | "x402";
import { payToState, acceptablePayTos, DEFAULT_PAY_TO } from "./wallets";
export const PAY_TO = DEFAULT_PAY_TO;   // initial default only; the payTo in force is versioned in wallet_settings (Admin → Wallets)
export const NETWORK = "multi-evm-testnet";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
if (MAINNET_ALLOWED as boolean) throw new Error("mainnet is hard-disabled in this build");
if (!/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) throw new Error("PAY_TO_ADDRESS invalid");

export function acceptFor(c: EvmChain, settle_via: string, resource: string, amount: bigint, description: string, tos?: any, payTo: string = PAY_TO) {
  return { scheme: "exact", network: c.key, maxAmountRequired: amount.toString(), resource, description, mimeType: "application/json",
    payTo, maxTimeoutSeconds: 120, asset: c.usdc,
    extra: { name: c.eip712.name, version: c.eip712.version, chainId: c.chainId, caip2: c.caip2, settlement: settle_via, ...(tos ? { tos: { version: tos.version, url: tos.url, sha256: tos.sha256 } } : {}) } };
}
/** One 'accepts' entry per enabled testnet whose relayer has gas (mock mode: all configured testnets). */
export async function accepts(resource: string, amount: bigint, description: string, tos?: any) {
  const list = MODE === "mock" ? configuredChains().map(chain => ({ chain, settle_via: "mock" })) : await activeChains();
  const { pay_to } = await payToState();
  return list.map(x => acceptFor(x.chain, x.settle_via, resource, amount, description, tos, pay_to));
}
/** Back-compat helper (single Base Sepolia entry). */
export function requirements(resource: string, amount: bigint = PRICE_ATOMIC, description = "Ranked bot-service recommendations") {
  return acceptFor(configuredChains().find(c => c.key === "base-sepolia") ?? configuredChains()[0], MODE === "mock" ? "mock" : "self", resource, amount, description);
}

export interface Verified { mode: "mock" | "x402"; payer: string; ref: string; amount: bigint; network: string; chainId: number | null; nonce: string | null;
  settle_via: string; payload?: ExactPayload; accept?: any; chain?: EvmChain; payTo: string }
/** Decode only (to read the authorization nonce for ToS binding before full verification). */
export function peekNonce(header: string): string | null { return MODE === "mock" ? null : decodeExactPayload(header)?.payload.authorization.nonce ?? null; }

const nonceUsedInDb = async (chainId: number, from: string, nonce: string) =>
  (await pool.query("SELECT 1 FROM payment_nonces WHERE chain_id=$1 AND payer=$2 AND nonce=$3", [chainId, from, nonce])).rows.length > 0;

export async function verifyPayment(header: string | undefined, acceptList: any[], amount: bigint): Promise<Verified | { error: string }> {
  if (!header) return { error: "X-PAYMENT header is required" };
  const ref = sha256(header);
  if (MODE === "mock") {
    const m = /^mock:([A-Za-z0-9_-]{1,64})(?::(0x[0-9a-fA-F]{40}))?$/.exec(header);
    if (!m) return { error: "mock mode: X-PAYMENT must be mock:<nonce>[:<0xpayer>]" };
    return { mode: "mock", payer: m[2] ?? "0xmock", ref, amount, network: "mock", chainId: null, nonce: null, settle_via: "mock", payTo: (await payToState()).pay_to };
  }
  const p = decodeExactPayload(header);
  if (!p) return { error: "malformed X-PAYMENT (expected base64 JSON x402 'exact' EVM payload)" };
  const chain = chainFor(p.network);
  if (!chain) return { error: `unsupported network ${p.network}: EVM testnets only (v1 names or CAIP-2)` };
  const accept = acceptList.find(a => a.network === chain.key);
  if (!accept) return { error: `network ${chain.key} not currently accepted (disabled or relayer has no gas)` };
  const v = await verifyExact(p, chain, { amount, payTo: await acceptablePayTos() }, { nonceUsedInDb });   // current payTo, or previous within grace
  if (!v.ok) return { error: "payment invalid: " + v.reason };
  return { mode: "x402", payer: v.payer, ref, amount, network: chain.key, chainId: chain.chainId, nonce: p.payload.authorization.nonce.toLowerCase(), settle_via: accept.extra.settlement, payload: p, accept, chain, payTo: getAddress(p.payload.authorization.to) };
}
/** Reserve the nonce inside the caller's DB transaction (PK violation => replay => 409). */
export async function reserveNonce(c: { query: (s: string, p?: any[]) => Promise<any> }, p: Verified) {
  if (p.mode !== "x402") return;
  await c.query("INSERT INTO payment_nonces(chain_id,payer,nonce,payment_ref) VALUES ($1,$2,$3,$4)", [p.chainId, p.payer, p.nonce, p.ref]);
}
export type SettleResult = { ok: boolean; tx?: string; header?: string; error?: string; via: string; ambiguous?: boolean };
/** ok => settled; !ok && ambiguous => settle_unknown (reconciled on-chain later); !ok && !ambiguous => definite failure. */
export async function settlePayment(p: Verified): Promise<SettleResult> {
  if (p.mode === "mock") return process.env.MOCK_SETTLE_UNKNOWN === "1" ? { ok: false, error: "mock_settle_timeout", via: "mock", ambiguous: true }
    : process.env.MOCK_SETTLE_FAIL === "1" ? { ok: false, error: "mock_settle_failure", via: "mock" } : { ok: true, tx: "mock", via: "mock" };
  if (p.settle_via === "facilitator-fallback") {
    // TEMPORARY: relayer unfunded on Base Sepolia -> x402.org facilitator settles. Verification above was still ours.
    const { useFacilitator } = await import("x402/verify");
    const reqs = { ...p.accept, payTo: p.payTo, extra: { name: p.accept.extra.name, version: p.accept.extra.version } };
    const s = await useFacilitator({ url: FALLBACK_URL as `${string}://${string}` }).settle({ ...p.payload, network: p.network } as any, reqs as any);
    return { ok: s.success, tx: s.transaction || undefined, via: "facilitator-fallback", header: Buffer.from(JSON.stringify({ ...s, settledBy: "x402.org-fallback" })).toString("base64"),
      error: s.success ? undefined : "fallback facilitator: " + String((s as any).errorReason ?? (s as any).error ?? "unknown").slice(0, 400),
      // an explicit facilitator rejection reason is definite; no reason / unexpected / a tx hash without success is ambiguous
      ambiguous: !s.success && (!(s as any).errorReason ? true : isAmbiguousSettleError(String((s as any).errorReason), s.transaction || null)) };
  }
  const s = await settleExact(p.payload!, p.chain!);
  return { ...s, via: "self", header: Buffer.from(JSON.stringify({ success: s.ok, transaction: s.tx ?? "", network: p.network, payer: p.payer, settledBy: "self" })).toString("base64") };
}
