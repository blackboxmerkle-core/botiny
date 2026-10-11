import { q } from "./db";
import { insertListing } from "../../api/src/listings";
const KIND: Record<string, string> = { x402: "x402", mcp: "mcp", package: "devtool", agent: "agent", service: "service" };
const LABEL: Record<string, string> = { x402: "x402 pay-per-call API", mcp: "MCP server", package: "Developer package", agent: "Autonomous agent (ACP)", service: "Service" };
/** Description used in the catalogue. Text from ids-only sources (Agentic Market) is never used: a template is built from facts. */
export function listingDescription(it: any, sources: string[]) {
  const facts = [LABEL[it.type] ?? "Service", it.category ? `category ${it.category}` : null, it.domain ? `at ${it.domain}` : null].filter(Boolean).join(", ");
  const price = it.pricing?.probe?.x402?.amount ?? it.pricing?.x402?.amount ?? null;
  const net = it.pricing?.probe?.x402?.network ?? it.pricing?.x402?.network ?? null;
  const tail = [price && net ? `x402 price ${price} (atomic) on ${net}` : null, `listed on ${sources.join(", ")}`].filter(Boolean).join("; ");
  const body = it.summary ? `${it.summary} (${facts}; ${tail})` : `${facts}. ${tail}.`;
  return body.length > 500 ? body.slice(0, 497) + "..." : body;
}
/** Append crawled items to the recommend catalogue as NEW listing rows (never edits): changed items get a new row that
 *  supersedes the previous one, so earlier requests replay against their pinned catalogue_seq unchanged. */
export async function publish(opts: { minQuality?: number; limit?: number } = {}) {
  const minQ = opts.minQuality ?? Number(process.env.CRAWL_PUBLISH_MIN_QUALITY ?? 45), lim = opts.limit ?? Number(process.env.CRAWL_PUBLISH_LIMIT ?? 1500);
  const rows = await q(`SELECT i.*, (SELECT array_agg(DISTINCT s.source_id ORDER BY s.source_id) FROM crawl_item_sources s WHERE s.item_id=i.item_id) srcs,
        (SELECT array_agg(DISTINCT s.licence_class) FROM crawl_item_sources s WHERE s.item_id=i.item_id) lics,
        (SELECT s.source_url FROM crawl_item_sources s WHERE s.item_id=i.item_id ORDER BY (s.licence_class='ids-only'), s.source_id LIMIT 1) src_url
      FROM crawl_items i WHERE i.status='active' AND (i.scores->>'quality')::int >= $1 AND (i.published_hash IS DISTINCT FROM i.content_hash)
        AND (i.urls->>'primary') ~ '^https?://'
      ORDER BY (i.scores->>'quality')::int DESC, i.item_id LIMIT $2`, [minQ, lim]);
  let n = 0;
  for (const it of rows) {
    const lic = (it.lics ?? []).filter((l: string) => l !== "ids-only")[0] ?? "ids-only";
    const res = await insertListing({
      provider_id: "crawl:" + String(it.domain ?? it.provider ?? "unknown").slice(0, 60), name: String(it.name).slice(0, 120),
      description: listingDescription(it, it.srcs ?? []), address: it.urls.primary, kind: KIND[it.type] ?? "service",
      tags: (it.tags ?? []).slice(0, 8), source_url: it.src_url, licence_class: lic, crawl_item_id: it.item_id, supersedes: it.published_listing_id ?? null,
    });
    await q("UPDATE crawl_items SET published_listing_id=$2, published_hash=content_hash WHERE item_id=$1", [it.item_id, res.listing_id]);
    n++;
  }
  return { published: n };
}
