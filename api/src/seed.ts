import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool, migrate } from "./db";
import { insertListing } from "./listings";
export async function seed() {
  await migrate();
  const n = Number((await pool.query("SELECT count(*) FROM listings WHERE provider_id LIKE 'seed:%'")).rows[0].count);
  if (n > 0) return n;
  const items = JSON.parse(readFileSync(join(__dirname, "..", "db", "seed-catalogue.json"), "utf8"));
  for (const it of items) await insertListing({ ...it, provider_id: "seed:" + new URL(it.source_url).hostname, cpi_micro_usdc: 0 });
  return items.length;
}
if (require.main === module) seed().then(n => { console.log(`seeded ${n} listings`); return pool.end(); });
/** Test-only: wipe and reseed, refusing unless the connected database name ends in _test. */
export async function resetTestDb() {
  await migrate();
  const { migrateCrawlerSchema } = await import("./db"); await migrateCrawlerSchema();
  const db = (await pool.query("SELECT current_database() AS d")).rows[0].d as string;
  if (!db.endsWith("_test")) throw new Error(`refusing to reset non-test database ${db}`);
  await pool.query("TRUNCATE payment_nonces, tos_versions, crawl_leads, crawl_probes, crawl_dedup_queue, crawl_item_sources, crawl_item_keys, crawl_items, crawl_jobs, crawl_runs, crawl_sources, crawl_hosts, api_log, balance_ledger, listing_bid_events, advertisers, impressions, requests, listings, settings_versions RESTART IDENTITY CASCADE");
  const { ensureSettings } = await import("./settings"); await ensureSettings();
  const { ensureTos } = await import("./tos"); await ensureTos();
  return seed();
}
