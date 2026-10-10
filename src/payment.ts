import { sha256 } from "./canonical";
/**
 * x402 (v1 "exact" scheme) on Base Sepolia ONLY. Mainnet is refused at startup.
 * PAYMENT_MODE=mock  -> any header "mock:<unique-nonce>" (optionally "mock:<nonce>:<payer>") is accepted. No chain calls.
 * PAYMENT_MODE=x402  -> header is decoded and verified via the facilitator (default https://x402.org/facilitator),
 *                       settled after the DB commit. Needs PAY_TO_ADDRESS (a testnet receiving address; no private key needed server-side).
 */
export const NETWORK = "base-sepolia";
export const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const PRICE_ATOMIC = BigInt(process.env.PRICE_ATOMIC ?? "1000"); // 0.001 USDC
export const MODE = (process.env.PAYMENT_MODE ?? "mock") as "mock" | "x402";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const PAY_TO = process.env.PAY_TO_ADDRESS ?? "";
if ((process.env.X402_NETWORK ?? NETWORK) !== NETWORK) throw new Error("Only base-sepolia testnet is allowed");
if (MODE === "x402" && !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) throw new Error("PAYMENT_MODE=x402 requires PAY_TO_ADDRESS (testnet)");

export function requirements(resource: string, amount: bigint = PRICE_ATOMIC, description = "Ranked bot-service recommendations") {
  return {
    scheme: "exact", network: NETWORK, maxAmountRequired: amount.toString(), resource,
    description, mimeType: "application/json",
    payTo: PAY_TO || "0x0000000000000000000000000000000000000000", maxTimeoutSeconds: 60,
    asset: USDC_BASE_SEPOLIA, extra: { name: "USDC", version: "2" },
  };
}
export interface Verified { mode: "mock" | "x402"; payer: string; ref: string; amount: bigint; payload?: any; reqs?: any }

export async function verifyPayment(header: string | undefined, resource: string, amount: bigint = PRICE_ATOMIC, description?: string): Promise<Verified | { error: string }> {
  if (!header) return { error: "X-PAYMENT header is required" };
  const ref = sha256(header);
  if (MODE === "mock") {
    const m = /^mock:([A-Za-z0-9_-]{1,64})(?::(0x[0-9a-fA-F]{40}))?$/.exec(header);
    if (!m) return { error: "mock mode: X-PAYMENT must be mock:<nonce>[:<0xpayer>]" };
    return { mode: "mock", payer: m[2] ?? "0xmock", ref, amount };
  }
  const { exact } = await import("x402/schemes");
  const { useFacilitator } = await import("x402/verify");
  let payload: any;
  try { payload = exact.evm.decodePayment(header); } catch { return { error: "malformed X-PAYMENT" }; }
  if (payload.network !== NETWORK) return { error: "wrong network; only base-sepolia" };
  const reqs = requirements(resource, amount, description);
  const v = await useFacilitator({ url: FACILITATOR as `${string}://${string}` }).verify(payload, reqs as any);
  if (!v.isValid) return { error: "payment invalid: " + v.invalidReason };
  return { mode: "x402", payer: v.payer ?? "unknown", ref, amount, payload, reqs };
}
export async function settlePayment(p: Verified): Promise<{ ok: boolean; tx?: string; header?: string }> {
  if (p.mode === "mock") return { ok: true, tx: "mock" };
  const { useFacilitator } = await import("x402/verify");
  const s = await useFacilitator({ url: FACILITATOR as `${string}://${string}` }).settle(p.payload, p.reqs);
  return { ok: s.success, tx: s.transaction, header: Buffer.from(JSON.stringify(s)).toString("base64") };
}
