/**
 * Our own x402 'exact' EVM facilitator: local verification of EIP-3009 transferWithAuthorization payloads and settlement
 * by submitting the transfer ourselves from a relayer (gas) wallet. No third-party facilitator involved.
 */
import { parseAbi, recoverTypedDataAddress, parseSignature, getAddress, isAddress, isHex, createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmChain } from "./chains";

export const USDC_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
export const TWA_TYPES = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] } as const;

export interface Authorization { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }
export interface ExactPayload { x402Version: number; scheme: string; network: string; payload: { signature: string; authorization: Authorization } }

/** RPC surface we need; injectable for tests. */
export interface ChainRpc {
  authorizationState(from: string, nonce: string): Promise<boolean>;
  balanceOf(addr: string): Promise<bigint>;
  nativeBalance(addr: string): Promise<bigint>;
  submitTransfer(a: Authorization, sig: string): Promise<string>;              // returns tx hash
  waitReceipt(hash: string): Promise<{ status: "success" | "reverted"; blockNumber?: bigint }>;
}
let factory: (c: EvmChain) => ChainRpc = viemRpc;
export const setRpcFactory = (f: ((c: EvmChain) => ChainRpc) | null) => { factory = f ?? viemRpc; };
export const rpcFor = (c: EvmChain) => factory(c);

export function relayerAccount() {
  const raw = process.env.RELAYER_PRIVATE_KEY;
  if (!raw) return null;
  const acct = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
  if (isPayerAddress(acct.address)) throw new Error("RELAYER_PRIVATE_KEY must not be the payer key");
  return acct;
}
/** Every configured payer address (lowercase): PAYER_ADDRESS, PAYER_ADDRESSES (comma list), the simulator payer default
 *  in chain.ts, and the address of PAYER_PRIVATE_KEY if that key happens to be set. Works with no payer key present. */
export function payerAddresses(): Set<string> {
  const out = new Set<string>();
  for (const a of [process.env.PAYER_ADDRESS, ...(process.env.PAYER_ADDRESSES ?? "").split(","), DEFAULT_SIM_PAYER]) if (a && /^0x[0-9a-fA-F]{40}$/.test(a.trim())) out.add(a.trim().toLowerCase());
  const k = process.env.PAYER_PRIVATE_KEY;
  if (k) try { out.add(privateKeyToAccount((k.startsWith("0x") ? k : "0x" + k) as `0x${string}`).address.toLowerCase()); } catch {}
  return out;
}
export const isPayerAddress = (a: string) => payerAddresses().has(a.toLowerCase());
const DEFAULT_SIM_PAYER = "0x0b68c3ecBB5DC0E79a4399eE7eA43d07Cb9A5402";   // public address of the simulator payer (chain.ts PAYER default)
function viemRpc(c: EvmChain): ChainRpc {
  const chain = defineChain({ id: c.chainId, name: c.label, nativeCurrency: { name: c.native, symbol: c.native, decimals: 18 }, rpcUrls: { default: { http: [c.rpc] } }, testnet: c.testnet });
  const pub = createPublicClient({ chain, transport: http(c.rpc, { timeout: 20_000 }) });
  return {
    authorizationState: (from, nonce) => pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: "authorizationState", args: [from as `0x${string}`, nonce as `0x${string}`] }),
    balanceOf: addr => pub.readContract({ address: c.usdc, abi: USDC_ABI, functionName: "balanceOf", args: [addr as `0x${string}`] }),
    nativeBalance: addr => pub.getBalance({ address: addr as `0x${string}` }),
    async submitTransfer(a, sig) {
      if (!c.testnet) throw new Error("refusing to settle on mainnet");
      const account = relayerAccount(); if (!account) throw new Error("RELAYER_PRIVATE_KEY not configured");
      const { r, s, v, yParity } = parseSignature(sig as `0x${string}`);
      const vv = Number(v ?? BigInt(27 + (yParity ?? 0)));
      const args = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, vv, r, s] as const;
      const { request } = await pub.simulateContract({ account, address: c.usdc, abi: USDC_ABI, functionName: "transferWithAuthorization", args: args as any });
      const wallet = createWalletClient({ account, chain, transport: http(c.rpc, { timeout: 20_000 }) });
      return wallet.writeContract(request as any);
    },
    async waitReceipt(hash) { const r = await pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 90_000 }); return { status: r.status, blockNumber: r.blockNumber }; },
  };
}

export function decodeExactPayload(header: string): ExactPayload | null {
  try {
    const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    const a = p?.payload?.authorization;
    const network = p?.network ?? p?.accepted?.network;
    if (p?.scheme !== "exact" && p?.accepted?.scheme !== "exact") return null;
    if (!a || !isHex(p.payload.signature) || !isAddress(a.from) || !isAddress(a.to) || !isHex(a.nonce) || a.nonce.length !== 66) return null;
    for (const k of ["value", "validAfter", "validBefore"]) if (!/^\d+$/.test(String(a[k]))) return null;
    return { x402Version: p.x402Version ?? 1, scheme: "exact", network, payload: { signature: p.payload.signature, authorization: { ...a, value: String(a.value), validAfter: String(a.validAfter), validBefore: String(a.validBefore) } } };
  } catch { return null; }
}

export type VerifyResult = { ok: true; payer: string } | { ok: false; reason: string };
/** Local verification. Order: static checks -> signature -> DB nonce -> on-chain nonce -> balance. */
export async function verifyExact(p: ExactPayload, c: EvmChain, req: { amount: bigint; payTo: string | string[] }, opts: { rpc?: ChainRpc; nonceUsedInDb?: (chainId: number, from: string, nonce: string) => Promise<boolean>; now?: number } = {}): Promise<VerifyResult> {
  const a = p.payload.authorization, now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!(Array.isArray(req.payTo) ? req.payTo : [req.payTo]).some(x => getAddress(x) === getAddress(a.to))) return { ok: false, reason: "invalid_payto: authorization.to does not match payTo" };
  if (BigInt(a.value) < req.amount) return { ok: false, reason: `insufficient_amount: ${a.value} < ${req.amount}` };
  if (BigInt(a.validAfter) > BigInt(now)) return { ok: false, reason: "not_yet_valid: validAfter in the future" };
  if (BigInt(a.validBefore) <= BigInt(now + 6)) return { ok: false, reason: "expired: validBefore passed (or < 6s left to settle)" };
  let signer: string;
  try {
    signer = await recoverTypedDataAddress({ domain: { name: c.eip712.name, version: c.eip712.version, chainId: c.chainId, verifyingContract: c.usdc },
      types: TWA_TYPES, primaryType: "TransferWithAuthorization",
      message: { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as `0x${string}` },
      signature: p.payload.signature as `0x${string}` });
  } catch { return { ok: false, reason: "invalid_signature: cannot recover signer" }; }
  if (getAddress(signer) !== getAddress(a.from)) return { ok: false, reason: "invalid_signature: signer != authorization.from (wrong chain/token domain?)" };
  if (opts.nonceUsedInDb && await opts.nonceUsedInDb(c.chainId, getAddress(a.from), a.nonce.toLowerCase())) return { ok: false, reason: "nonce_reused: authorization nonce already used" };
  const rpc = opts.rpc ?? rpcFor(c);
  try {
    if (await rpc.authorizationState(a.from, a.nonce)) return { ok: false, reason: "nonce_reused: authorization already used on-chain" };
    const bal = await rpc.balanceOf(a.from);
    if (bal < BigInt(a.value)) return { ok: false, reason: `insufficient_funds: payer USDC balance ${bal} < ${a.value}` };
  } catch (e: any) { console.error("verify rpc_error", String(e?.shortMessage ?? e?.message ?? e).slice(0, 500)); return { ok: false, reason: "rpc_error (chain RPC unavailable, try again)" }; }
  return { ok: true, payer: getAddress(a.from) };
}
/** Errors that prove the transfer did NOT and can not happen from this attempt (simulation revert, bad signature,
 *  nonce already used, no gas). Everything else (timeouts, network errors, a tx hash without a receipt) is AMBIGUOUS:
 *  the authorization may have been broadcast, so the outcome is settled later from authorizationState on-chain. */
export const DEFINITE_SETTLE_ERROR = /revert|execution reverted|insufficient funds|invalid signature|authorization is (used|expired|not yet valid)|nonce|FiatTokenV2|refusing to settle on mainnet|not configured/i;
export const AMBIGUOUS_SETTLE_ERROR = /timeout|timed out|took too long|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket|network|fetch failed|HTTP request failed|aborted|503|502|504|rate limit|429/i;
export async function settleExact(p: ExactPayload, c: EvmChain, rpc: ChainRpc = rpcFor(c)): Promise<{ ok: boolean; tx?: string; error?: string; ambiguous?: boolean }> {
  let tx: string | undefined;
  try {
    tx = await rpc.submitTransfer(p.payload.authorization, p.payload.signature);
    const r = await rpc.waitReceipt(tx);
    return r.status === "success" ? { ok: true, tx } : { ok: false, tx, error: "transaction reverted" };   // mined + reverted: definite (nonce not consumed)
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? e?.details ?? e?.message ?? e).slice(0, 480);
    // a tx hash exists but no receipt => broadcast, outcome unknown. Before broadcast: definite only for known rejection classes.
    const ambiguous = !!tx || AMBIGUOUS_SETTLE_ERROR.test(msg) || !DEFINITE_SETTLE_ERROR.test(msg);
    return { ok: false, tx, error: msg, ambiguous };
  }
}
