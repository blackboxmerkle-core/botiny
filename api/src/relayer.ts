import { formatUnits } from "viem";
import { configuredChains, EvmChain } from "./chains";
import { relayerAccount, rpcFor } from "./facilitator";
/** Relayer gas per chain (cached 60s). Chains without gas drop out of 'accepts'.
 *  Temporary, clearly flagged fallback: Base Sepolia may settle via the x402.org facilitator while our relayer is unfunded
 *  (FACILITATOR_FALLBACK=1, default on; set 0 to disable). Verification is always local. */
export const FALLBACK_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
export const fallbackOn = () => (process.env.FACILITATOR_FALLBACK ?? "1") !== "0";
export interface GasRow { key: string; label: string; chainId: number; native: string; wei: string | null; balance: string | null; min: string; ok: boolean; error?: string; settle_via: "self" | "facilitator-fallback" | "none" }
let cache: { at: number; rows: GasRow[] } | null = null, inflight: Promise<GasRow[]> | null = null;
export const relayerAddress = () => { try { return relayerAccount()?.address ?? null; } catch { return null; } };
export async function gasStatus(force = false): Promise<GasRow[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.rows;
  if (inflight) return inflight;
  inflight = (async () => {
    const addr = relayerAddress();
    const rows = await Promise.all(configuredChains().map(async (c: EvmChain): Promise<GasRow> => {
      let wei: bigint | null = null, error: string | undefined;
      if (addr) try { wei = await Promise.race([rpcFor(c).nativeBalance(addr), new Promise<never>((_, j) => setTimeout(() => j(new Error("timeout")), 6000))]); } catch (e: any) { error = String(e?.shortMessage ?? e?.message ?? e).slice(0, 120); }
      else error = "no relayer key";
      const ok = wei != null && wei >= c.minGasWei;
      const settle_via = ok ? "self" : (c.key === "base-sepolia" && fallbackOn() ? "facilitator-fallback" : "none");
      return { key: c.key, label: c.label, chainId: c.chainId, native: c.native, wei: wei?.toString() ?? null, balance: wei == null ? null : formatUnits(wei, 18), min: formatUnits(c.minGasWei, 18), ok, error, settle_via };
    }));
    cache = { at: Date.now(), rows }; inflight = null; return rows;
  })();
  return inflight;
}
export const _resetGasCache = (rows?: GasRow[]) => { cache = rows ? { at: Date.now(), rows } : null; };
/** Chains currently offered in 'accepts' and how each settles. */
export async function activeChains(): Promise<{ chain: EvmChain; settle_via: "self" | "facilitator-fallback" }[]> {
  const g = await gasStatus();
  return configuredChains().flatMap(c => { const r = g.find(x => x.key === c.key); return r && r.settle_via !== "none" ? [{ chain: c, settle_via: r.settle_via as any }] : []; });
}
