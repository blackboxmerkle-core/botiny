import { createHash } from "node:crypto";
export interface NormItem {
  source_id: string; source_key: string; source_url: string; licence_class: string;
  type: "x402" | "mcp" | "package" | "agent" | "service";
  name: string; provider?: string | null; domain?: string | null;
  urls: { primary?: string; endpoint?: string; homepage?: string; docs?: string; repo?: string; remotes?: string[] };
  summary?: string | null; category?: string | null; tags?: string[];
  pricing?: any; signals?: any; keys: string[]; facts?: any;
}
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function normUrl(u?: string | null): string | null {
  if (!u) return null;
  try {
    const x = new URL(u.trim());
    if (!/^https?:$/.test(x.protocol)) return null;
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, "") || ""}`;
  } catch { return null; }
}
export function hostOf(u?: string | null): string | null { try { return u ? new URL(u).host.toLowerCase().replace(/^www\./, "") : null; } catch { return null; } }
/** Summary limited to a short factual snippet; text-restricted licences get none. */
export function clip(s: any, n = 300): string | null {
  if (typeof s !== "string") return null;
  const t = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  return t ? (t.length > n ? t.slice(0, n - 1) + "…" : t) : null;
}
export const nameTokens = (s: string) => new Set((s.toLowerCase().normalize("NFKC").match(/[a-z0-9]+/g) ?? []).filter(t => !["mcp", "server", "api", "the", "for", "and", "x402"].includes(t)));
export function jaccard(a: Set<string>, b: Set<string>) { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); }
export const TYPE_RANK: Record<string, number> = { x402: 5, mcp: 4, agent: 3, service: 2, package: 1 };
