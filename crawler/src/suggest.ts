// Listing suggestions accepted by an admin arrive here as crawl_jobs(kind='suggestion'). The worker re-validates the
// host (DNS must resolve to public addresses only), upserts a crawl item (source 'suggestions', user-submitted),
// probes x402 endpoints (one unpaid request), scores it and publishes when it clears the normal quality bar;
// otherwise the suggestion goes to needs_review with what is missing.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { q } from "./db";
import { upsertItem } from "./store";
import { probeItem } from "./probe";
import { scoreItem } from "./score";
import { publish } from "./publish";
import { normUrl, hostOf } from "./normalize";
const PRIVATE = new BlockList();
for (const [a, b] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) PRIVATE.addSubnet(a, b, "ipv4");
for (const [a, b] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) PRIVATE.addSubnet(a, b, "ipv6");
type Resolver = (host: string) => Promise<string[]>;
let resolver: Resolver = async h => (await lookup(h, { all: true })).map(x => x.address);
export const _setResolver = (r: Resolver | null) => { resolver = r ?? (async h => (await lookup(h, { all: true })).map(x => x.address)); };
export async function assertPublicHost(host: string) {
  let addrs: string[] = [];
  try { addrs = await resolver(host); } catch { throw Object.assign(new Error(`host ${host} does not resolve`), { review: true }); }
  if (!addrs.length) throw Object.assign(new Error(`host ${host} does not resolve`), { review: true });
  for (const raw of addrs) { const a = raw.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1"); if (/^::ffff:/.test(a) || PRIVATE.check(a, isIP(a) === 6 ? "ipv6" : "ipv4")) throw Object.assign(new Error(`host ${host} resolves to a non-public address`), { review: true }); }
}
const TYPE: Record<string, "x402" | "mcp" | "agent" | "package" | "service"> = { x402_api: "x402", mcp_server: "mcp", agent: "agent", repo: "package", other: "service" };
const upd = (id: string, state: string, detail: any, extra = "", p: any[] = []) =>
  q(`UPDATE listing_suggestions SET state=$2, detail=$3, updated_at=now()${extra} WHERE suggestion_id=$1`, [id, state, detail, ...p]);
export async function runSuggestion(id: string) {
  const s = (await q("SELECT * FROM listing_suggestions WHERE suggestion_id=$1", [id]))[0];
  if (!s) throw Object.assign(new Error("unknown suggestion"), { fatal: true });
  if (s.state !== "queued" && s.state !== "crawling") return { skipped: `state ${s.state}` };
  const minQ = Number(process.env.CRAWL_PUBLISH_MIN_QUALITY ?? 45);
  await upd(id, "crawling", { progress: "resolving host", pct: 10 });
  const host = new URL(s.url).hostname;
  try { await assertPublicHost(host); }
  catch (e: any) { if (!e.review) throw e; await upd(id, "needs_review", { needed: e.message, pct: 100 }); return { suggestion_id: id, state: "needs_review" }; }
  const type = TYPE[s.type] ?? "service", norm = normUrl(s.url) ?? s.url_norm;
  const prior = (await q(`SELECT i.item_id, i.published_listing_id FROM crawl_item_keys k JOIN crawl_items i USING (item_id) WHERE k.key=$1`, ["url:" + norm]))[0];
  if (prior?.published_listing_id) {
    await upd(id, "duplicate", { note: "already in the catalogue", pct: 100 }, ", duplicate_of=$4, crawl_item_id=$5", [prior.published_listing_id, prior.item_id]);
    return { suggestion_id: id, state: "duplicate", duplicate_of: prior.published_listing_id };
  }
  await upd(id, "crawling", { progress: "indexing", pct: 35 });
  const it = await upsertItem({ source_id: "suggestions", source_key: id, source_url: `botiny:suggestion:${id}`, licence_class: "user-submitted", type, name: s.name,
    domain: hostOf(s.url), urls: { primary: s.url, ...(type === "x402" ? { endpoint: s.url } : {}), ...(s.type === "repo" ? { repo: s.url } : {}) },
    summary: s.description, keys: ["url:" + norm], signals: { submitted_at: s.created_at, suggestion_type: s.type }, facts: { suggestion_id: id } });
  await q("UPDATE listing_suggestions SET crawl_item_id=$2 WHERE suggestion_id=$1", [id, it.item_id]);
  if (type === "x402") { await upd(id, "crawling", { progress: "probing x402 endpoint (one unpaid request)", pct: 60 }); await probeItem(it.item_id).catch(() => null); }
  await upd(id, "crawling", { progress: "scoring", pct: 85 });
  const row = (await q("SELECT item_id, type, summary, urls, category, pricing, signals, domain FROM crawl_items WHERE item_id=$1", [it.item_id]))[0];
  const sc = scoreItem(row); await q("UPDATE crawl_items SET scores=$2 WHERE item_id=$1", [it.item_id, sc]);
  if (sc.quality >= minQ) {
    await publish({ itemIds: [it.item_id], minQuality: minQ });
    const lid = (await q("SELECT published_listing_id FROM crawl_items WHERE item_id=$1", [it.item_id]))[0]?.published_listing_id;
    if (lid) { await upd(id, "indexed", { pct: 100, quality: sc.quality }, ", listing_id=$4", [lid]); return { suggestion_id: id, state: "indexed", listing_id: lid }; }
  }
  const probe = row.pricing?.probe;
  const needed = [`quality score ${sc.quality} is below the publish bar ${minQ}`, type === "x402" && !probe?.ok_402 ? "x402 probe did not return a valid 402 challenge" : null,
    !s.description ? "a description" : null, "admin review (publish or reject)"].filter(Boolean).join("; ");
  await upd(id, "needs_review", { needed, quality: sc.quality, pct: 100 });
  return { suggestion_id: id, state: "needs_review", quality: sc.quality };
}
