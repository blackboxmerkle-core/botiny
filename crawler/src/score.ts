import { q } from "./db";
const lg = (x: any, cap: number) => { const v = Number(x); return v > 0 ? Math.min(1, Math.log10(v + 1) / Math.log10(cap + 1)) : 0; };
const recent = (d: any, days: number) => d && Date.now() - Date.parse(d) < days * 86400_000;
/** quality 0..100 (trust/completeness/usage); usage 0..1; lead 0..100 = quality × (1 − usage) for items with a reachable provider. */
export function scoreItem(it: any) {
  const s = it.signals ?? {}, nsrc = Object.keys(s).length;
  const bz = s["x402-bazaar"] ?? {}, sm = s.smithery ?? {}, np = s.npm ?? {}, mr = s["mcp-registry"] ?? {}, va = s["virtuals-acp"] ?? {};
  const probe = it.pricing?.probe;
  let qn = 0;
  qn += it.summary ? 10 : 0;
  qn += it.urls?.primary ? 5 : 0;
  qn += it.category ? 5 : 0;
  qn += Math.min(nsrc, 3) * 5;                                                     // corroboration across sources (max 15)
  qn += probe?.ok_402 ? 15 : probe && probe.http_status ? 3 : 0;                     // live, correctly priced x402 endpoint
  qn += it.pricing?.x402 ? 5 : 0;
  qn += mr.registry_status === "active" ? 5 : 0;
  qn += mr.remote || sm.remote ? 5 : 0;
  qn += sm.verified ? 5 : 0;
  qn += recent(bz.last_called_at ?? mr.updated_at ?? np.updated ?? va.last_active_at ?? bz.last_updated, 90) ? 10 : 0;
  qn += Number(va.success_rate) >= 80 ? 5 : 0;
  const usage = Math.max(lg(bz.unique_payers_30d, 5000), lg(bz.calls_30d, 1_000_000), lg(sm.smithery_use_count, 100_000), lg(np.downloads_monthly, 10_000_000), lg(va.successful_jobs, 10_000));
  qn += Math.round(usage * (it.type === "package" ? 8 : 20));
  const quality = Math.min(100, qn);
  const reachable = !!(it.domain || it.urls?.homepage);
  const lead = reachable && quality >= 40 && it.type !== "package" ? Math.round(Math.min(100, quality * 1.5) * (1 - usage)) : 0;
  return { quality, usage: Math.round(usage * 1000) / 1000, lead };
}
export async function rescoreAll() {
  const rows = await q("SELECT item_id, type, summary, urls, category, pricing, signals, domain FROM crawl_items WHERE status='active'");
  let n = 0;
  for (const r of rows) { await q("UPDATE crawl_items SET scores=$2 WHERE item_id=$1", [r.item_id, scoreItem(r)]); n++; }
  await q(`INSERT INTO crawl_leads(item_id) SELECT item_id FROM crawl_items WHERE status='active' AND (scores->>'lead')::int >= 45 ON CONFLICT DO NOTHING`);
  return n;
}
