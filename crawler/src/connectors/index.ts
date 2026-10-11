import { politeJson } from "../http";
import { NormItem, normUrl, hostOf, clip } from "../normalize";
export interface PageResult { items: NormItem[]; next: any | null; total?: number }
export type Connector = (cursor: any, cfg: any) => Promise<PageResult>;
const base = (n: string) => (n.startsWith("eip155:8453") ? "base" : n === "eip155:84532" ? "base-sepolia" : n);

// ---- x402 Bazaar ----------------------------------------------------------------------------------------
export const bazaar: Connector = async (cur, cfg) => {
  const offset = Number(cur?.offset ?? 0), limit = cfg.page_size ?? 100;
  const url = `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=${limit}&offset=${offset}`;
  const d = await politeJson(url, { minIntervalMs: 1000 });
  const items: NormItem[] = (d.items ?? []).map((it: any) => {
    const a = (it.accepts ?? [])[0] ?? {};
    const res = normUrl(it.resource) ?? it.resource;
    const dom = hostOf(it.resource);
    const method = it.extensions?.bazaar?.info?.input?.method ?? it.accepts?.[0]?.extra?.method ?? null;
    return {
      source_id: "x402-bazaar", source_key: String(it.resource), source_url: url, licence_class: "public-metadata",
      type: "x402", name: it.serviceName || dom || "x402 resource", provider: dom, domain: dom,
      urls: { primary: it.resource, endpoint: it.resource },
      summary: clip(it.description), category: (it.tags ?? [])[0] ?? null, tags: (it.tags ?? []).slice(0, 8),
      pricing: { x402: { network: base(a.network ?? ""), amount: a.amount ?? a.maxAmountRequired ?? null, asset: a.asset ?? null, payTo: a.payTo ?? null, scheme: a.scheme ?? null, x402Version: it.x402Version, method } },
      signals: { calls_30d: it.quality?.l30DaysTotalCalls ?? null, unique_payers_30d: it.quality?.l30DaysUniquePayers ?? null, last_called_at: it.quality?.lastCalledAt ?? null, last_updated: it.lastUpdated ?? null },
      keys: [res && `url:${res}`, a.payTo && dom && `payto:${String(a.payTo).toLowerCase()}@${dom}`].filter(Boolean) as string[],
    };
  });
  const total = d.pagination?.total ?? 0;
  return { items, next: offset + limit < total && items.length ? { offset: offset + limit } : null, total };
};

// ---- Agentic Market: IDs/categories/URLs/prices only (no descriptions stored; never sent to an LLM) ----------------
export const agenticMarket: Connector = async (cur, cfg) => {
  const offset = Number(cur?.offset ?? 0), limit = cfg.page_size ?? 100;
  const url = `https://api.agentic.market/v1/services?limit=${limit}&offset=${offset}`;
  const d = await politeJson(url, { minIntervalMs: 1500 });
  const items: NormItem[] = [];
  for (const s of d.services ?? []) {
    const eps = (s.endpoints ?? []) as any[];
    const ep = eps[0];
    items.push({
      source_id: "agentic-market", source_key: String(s.id), source_url: `https://agentic.market/services/${encodeURIComponent(s.id)}`, licence_class: "ids-only",
      type: "x402", name: s.serviceName || s.name || s.domain, provider: s.provider ?? s.domain, domain: hostOf("https://" + (s.domain ?? "")) ?? s.domain,
      urls: { primary: ep?.url ?? s.providerUrl, endpoint: ep?.url, homepage: s.providerUrl },
      summary: null, category: s.category ?? null, tags: (s.tags ?? []).slice(0, 8),
      pricing: { x402: ep?.pricing ? { network: base(ep.pricing.network ?? ""), amount_usdc: ep.pricing.amount, scheme: ep.pricing.scheme, method: ep.method } : null, price_summary: s.priceSummary ?? null },
      signals: { agentic_market_id: s.id, endpoints: eps.length, integration: s.integrationType ?? null },
      keys: [`am:${s.id}`, ...eps.map(e => normUrl(e.url)).filter(Boolean).map(u => `url:${u}`)],
    });
  }
  const total = d.total ?? 0;
  return { items, next: offset + limit < total && items.length ? { offset: offset + limit } : null, total };
};

// ---- Official MCP Registry: cursor + updated_since (incremental) ------------------------------------------------
export const mcpRegistry: Connector = async (cur, cfg) => {
  const p = new URLSearchParams({ limit: String(cfg.page_size ?? 100) });
  if (cur?.cursor) p.set("cursor", cur.cursor);
  if (cur?.updated_since) p.set("updated_since", cur.updated_since);
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers?${p}`;
  const d = await politeJson(url, { minIntervalMs: 1000 });
  const items: NormItem[] = [];
  for (const e of d.servers ?? []) {
    const s = e.server ?? {}, meta = e._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
    if (meta.isLatest === false) continue;                         // keep only the latest version of each server
    const remotes = (s.remotes ?? []).map((r: any) => r.url).filter(Boolean);
    const pkg = (s.packages ?? [])[0];
    const repo = s.repository?.url ?? null;
    const primary = remotes[0] ?? s.websiteUrl ?? repo ?? null;
    items.push({
      source_id: "mcp-registry", source_key: String(s.name), source_url: `https://registry.modelcontextprotocol.io/v0.1/servers?search=${encodeURIComponent(s.name)}`, licence_class: "public-metadata",
      type: "mcp", name: s.title || s.name, provider: String(s.name).split("/")[0], domain: hostOf(remotes[0] ?? s.websiteUrl ?? null) ?? String(s.name).split("/")[0].split(".").reverse().join("."),
      urls: { primary, remotes, repo, homepage: s.websiteUrl ?? null },
      summary: clip(s.description), category: "mcp", tags: ["mcp", ...(remotes.length ? ["remote"] : []), ...(pkg?.registryType ? [pkg.registryType] : [])],
      pricing: {}, signals: { registry_status: meta.status ?? null, version: s.version ?? null, updated_at: meta.updatedAt ?? null, remote: remotes.length > 0, package: pkg ? `${pkg.registryType}:${pkg.identifier}` : null },
      keys: [`mcp:${s.name}`, ...remotes.map((u: string) => normUrl(u)).filter(Boolean).map((u: any) => `url:${u}`), ...(pkg?.registryType === "npm" ? [`npm:${pkg.identifier}`] : [])],
    });
  }
  const next = d.metadata?.nextCursor ? { cursor: d.metadata.nextCursor, updated_since: cur?.updated_since } : null;
  return { items, next };
};

// ---- Smithery ---------------------------------------------------------------------------------------------------
// Smithery's listing caps pagination at 5 pages (500 results) regardless of totalCount (~19.5k).
// Workaround: walk the unfiltered list, then a configurable set of search terms, each up to its own page cap.
export const SMITHERY_QUERIES = ["", "search", "database", "github", "browser", "finance", "crypto", "memory", "email", "calendar", "docs", "weather",
  "maps", "payments", "slack", "notion", "code", "file", "image", "video", "news", "travel", "sql", "analytics", "security", "agent", "llm", "scraping", "x402", "blockchain"];
export const smithery: Connector = async (cur, cfg) => {
  const qs: string[] = cfg.queries ?? SMITHERY_QUERIES;
  const qi = Number(cur?.qi ?? 0), page = Number(cur?.page ?? 1), size = cfg.page_size ?? 100;
  if (qi >= qs.length) return { items: [], next: null };
  const url = `https://api.smithery.ai/servers?${qs[qi] ? `q=${encodeURIComponent(qs[qi])}&` : ""}page=${page}&pageSize=${size}`;
  const d = await politeJson(url, { minIntervalMs: 1500 });
  const raw = d.servers ?? [];
  const items: NormItem[] = raw.filter((s: any) => !s.unlisted && !s.inactive).map((s: any) => ({
    source_id: "smithery", source_key: String(s.qualifiedName), source_url: `https://smithery.ai/server/${s.qualifiedName}`, licence_class: "catalogue-facts",
    type: "mcp", name: s.displayName || s.qualifiedName, provider: s.namespace || null, domain: hostOf(s.homepage) ?? null,
    urls: { primary: `https://smithery.ai/server/${s.qualifiedName}`, homepage: s.homepage ?? null },
    summary: clip(s.description, 200), category: "mcp", tags: ["mcp", ...(s.remote ? ["remote"] : []), ...(s.verified ? ["verified"] : [])],
    pricing: {}, signals: { smithery_use_count: s.useCount ?? 0, verified: !!s.verified, remote: !!s.remote, deployed: !!s.isDeployed, created_at: s.createdAt },
    keys: [`smithery:${s.qualifiedName}`],
  }));
  const tp = Math.min(d.pagination?.totalPages ?? page, cfg.max_pages_per_query ?? 5);
  const next = page < tp && raw.length ? { qi, page: page + 1 } : (qi + 1 < qs.length ? { qi: qi + 1, page: 1 } : null);
  return { items, next, total: d.pagination?.totalCount };
};

// ---- Virtuals ACP ----------------------------------------------------------------------------------------------
export const virtuals: Connector = async (cur, cfg) => {
  const page = Number(cur?.page ?? 1), size = cfg.page_size ?? 100;
  const url = `https://acpx.virtuals.io/api/agents?pagination%5Bpage%5D=${page}&pagination%5BpageSize%5D=${size}`;
  const d = await politeJson(url, { minIntervalMs: 1500 });
  const items: NormItem[] = (d.data ?? []).filter((a: any) => !a.isHidden).map((a: any) => {
    const offers = (a.offerings ?? a.jobs ?? []).slice(0, 5).map((o: any) => ({ name: o.name, price_usd: o.priceUsd ?? o.price ?? null }));
    return {
      source_id: "virtuals-acp", source_key: String(a.id), source_url: `https://app.virtuals.io/acp/agent-details/${a.id}`, licence_class: "public-metadata",
      type: "agent", name: a.name, provider: a.ownerAddress ?? null, domain: null,
      urls: { primary: `https://app.virtuals.io/acp/agent-details/${a.id}` },
      summary: clip(a.description), category: a.category ?? a.cluster ?? null, tags: ["acp", "agent", ...(a.cluster ? [String(a.cluster)] : [])],
      pricing: { acp_offerings: offers, wallet: a.walletAddress ?? null },
      signals: { successful_jobs: a.successfulJobCount ?? null, success_rate: a.successRate ?? null, unique_buyers: a.uniqueBuyerCount ?? null, tx_count: a.transactionCount ?? null, last_active_at: a.lastActiveAt ?? null },
      keys: [`acp:${a.id}`, ...(a.walletAddress ? [`wallet:${String(a.walletAddress).toLowerCase()}`] : [])],
    };
  });
  const pc = d.meta?.pagination?.pageCount ?? page;
  return { items, next: page < pc && items.length ? { page: page + 1 } : null, total: d.meta?.pagination?.total };
};

// ---- npm search (keywords) ------------------------------------------------------------------------------------
export const npm: Connector = async (cur, cfg) => {
  const kws: string[] = cfg.keywords ?? ["mcp", "x402", "a2a"];
  const ki = Number(cur?.ki ?? 0), from = Number(cur?.from ?? 0), size = Math.min(cfg.page_size ?? 250, 250);
  if (ki >= kws.length) return { items: [], next: null };
  const url = `https://registry.npmjs.org/-/v1/search?text=keywords:${encodeURIComponent(kws[ki])}&size=${size}&from=${from}`;
  const d = await politeJson(url, { minIntervalMs: 1000 });
  const items: NormItem[] = (d.objects ?? []).map((o: any) => {
    const p = o.package ?? {};
    return {
      source_id: "npm", source_key: String(p.name), source_url: `https://www.npmjs.com/package/${p.name}`, licence_class: "package-registry",
      type: "package", name: p.name, provider: p.publisher?.username ?? null, domain: hostOf(p.links?.homepage) ?? null,
      urls: { primary: `https://www.npmjs.com/package/${p.name}`, homepage: p.links?.homepage ?? null, repo: p.links?.repository ?? null },
      summary: clip(p.description), category: kws[ki], tags: [kws[ki], ...((p.keywords ?? []) as string[]).slice(0, 6)],
      pricing: {}, signals: { downloads_monthly: o.downloads?.monthly ?? null, dependents: Number(o.dependents ?? 0) || null, updated: o.updated ?? p.date ?? null, version: p.version },
      keys: [`npm:${p.name}`],
    };
  });
  const total = d.total ?? 0;
  const pagesThisKw = Math.ceil((from + size) / size);
  const kwDone = from + size >= total || items.length === 0 || pagesThisKw >= (cfg.max_pages_per_keyword ?? 2);
  return { items, next: kwDone ? (ki + 1 < kws.length ? { ki: ki + 1, from: 0 } : null) : { ki, from: from + size }, total };
};

export const CONNECTORS: Record<string, Connector> = {
  "x402-bazaar": bazaar, "agentic-market": agenticMarket, "mcp-registry": mcpRegistry, smithery, "virtuals-acp": virtuals, npm,
};
