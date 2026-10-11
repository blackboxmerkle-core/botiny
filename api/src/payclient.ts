/**
 * Minimal x402 'exact' EVM client that ALSO accepts the ToS by binding it into the EIP-3009 nonce:
 *   nonce = keccak256(tosHash || keccak256(canonicalJSON({route, params})) || salt)
 * Used by sim bots, scripts/pay-recommend.ts and the dashboard "Try a search". Testnet only; caller supplies caps.
 */
import { toHex } from "viem";
import { randomBytes } from "node:crypto";
import type { PrivateKeyAccount } from "viem/accounts";
import { TWA_TYPES } from "./facilitator";
import { requestHashOf, boundNonce } from "./tos";
import { chainFor } from "./chains";

export interface PayOpts { account: PrivateKeyAccount; networks: string[]; maxAmount: bigint; headers?: Record<string, string>; method?: string }
export async function paidFetch(url: string, route: string, params: unknown, body: string | undefined, o: PayOpts) {
  const base = { "content-type": "application/json", "ngrok-skip-browser-warning": "1", ...(o.headers ?? {}) };
  const r1 = await fetch(url, { method: o.method ?? "POST", headers: base, body });
  if (r1.status !== 402) return { res: r1, paid: false as const };
  const ch: any = await r1.json();
  const acc = (ch.accepts ?? []).find((a: any) => a.scheme === "exact" && o.networks.includes(a.network) && chainFor(a.network)?.usdc.toLowerCase() === String(a.asset).toLowerCase()
    && BigInt(a.maxAmountRequired) <= o.maxAmount);
  if (!acc) throw new Error(`no acceptable requirement (networks ${o.networks.join(",")}, cap ${o.maxAmount}); server said: ${ch.error}`);
  const tos = ch.tos ?? acc.extra?.tos;
  if (!tos?.sha256) throw new Error("server did not present ToS");
  const salt = toHex(randomBytes(32));
  const nonce = boundNonce(tos.sha256, requestHashOf(route, params), salt);
  const now = Math.floor(Date.now() / 1000);
  const authorization = { from: o.account.address, to: acc.payTo, value: String(acc.maxAmountRequired), validAfter: String(now - 600), validBefore: String(now + Number(acc.maxTimeoutSeconds ?? 120)), nonce };
  const signature = await o.account.signTypedData({ domain: { name: acc.extra.name, version: acc.extra.version, chainId: Number(acc.extra.chainId), verifyingContract: acc.asset },
    types: TWA_TYPES, primaryType: "TransferWithAuthorization",
    message: { ...authorization, from: authorization.from, to: authorization.to as `0x${string}`, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: nonce as `0x${string}` } });
  const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: acc.network, payload: { signature, authorization } })).toString("base64");
  const res = await fetch(url, { method: o.method ?? "POST", headers: { ...base, "X-PAYMENT": header, "X-TOS-ACCEPT": tos.sha256, "X-TOS-SALT": salt }, body });
  return { res, paid: true as const, accept: acc, tos: { version: tos.version, sha256: tos.sha256, salt, nonce } };
}
