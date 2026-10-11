import { q } from "./db";
export interface SourceDef { source_id: string; name: string; base_url: string; licence_class: string; config: any; notes: string }
export const SOURCES: SourceDef[] = [
  { source_id: "x402-bazaar", name: "x402 Bazaar (CDP discovery)", base_url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
    licence_class: "public-metadata", config: { page_size: 100, max_pages: 20, interval_min: 360 }, notes: "Public, no key. ~32k resources; resumable offset." },
  { source_id: "agentic-market", name: "Agentic Market", base_url: "https://api.agentic.market/v1/services",
    licence_class: "ids-only", config: { page_size: 100, max_pages: 40, interval_min: 720 }, notes: "IDs, categories, URLs and prices only. Descriptions are NOT stored and never sent to an LLM." },
  { source_id: "mcp-registry", name: "Official MCP Registry", base_url: "https://registry.modelcontextprotocol.io/v0.1/servers",
    licence_class: "public-metadata", config: { page_size: 100, max_pages: 30, interval_min: 60 }, notes: "Hourly incremental via updated_since + cursor." },
  { source_id: "smithery", name: "Smithery registry", base_url: "https://api.smithery.ai/servers",
    licence_class: "catalogue-facts", config: { page_size: 100, max_pages: 15, interval_min: 720 }, notes: "Facts + link; short summary only." },
  { source_id: "virtuals-acp", name: "Virtuals ACP agents", base_url: "https://acpx.virtuals.io/api/agents",
    licence_class: "public-metadata", config: { page_size: 100, max_pages: 15, interval_min: 720 }, notes: "Strapi API; agents with offerings and job metrics." },
  { source_id: "npm", name: "npm search (keywords mcp, x402, a2a)", base_url: "https://registry.npmjs.org/-/v1/search",
    licence_class: "package-registry", config: { page_size: 250, max_pages: 4, keywords: ["mcp", "x402", "a2a"], interval_min: 1440 }, notes: "Package metadata + download counts." },
  { source_id: "glama", name: "Glama (skipped)", base_url: "https://glama.ai", licence_class: "excluded", config: {}, notes: "Skipped: ToS does not permit automated collection." },
];
export async function ensureSources() {
  for (const s of SOURCES) {
    await q(`INSERT INTO crawl_sources(source_id,name,base_url,licence_class,config,notes,enabled,health)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source_id) DO NOTHING`,
      [s.source_id, s.name, s.base_url, s.licence_class, s.config, s.notes, s.licence_class !== "excluded", s.licence_class === "excluded" ? "excluded" : "unknown"]);
  }
}
