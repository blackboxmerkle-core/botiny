import type { PoolClient } from "pg";
import { pool } from "./db";
import { NormItem, sha, TYPE_RANK } from "./normalize";
const TEXT_OK = new Set(["public-metadata", "catalogue-facts", "package-registry"]);   // licences allowing a short summary

/** Upsert one normalised record. Hard-key dedupe: any shared key => same item; if keys span several items they are merged. */
export async function upsertItem(n: NormItem): Promise<{ item_id: string; created: boolean; changed: boolean }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // serialize writers touching the same keys
    for (const k of [...n.keys].sort()) await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [k]);
    const prior = (await c.query(`SELECT item_id FROM crawl_item_sources WHERE source_id=$1 AND source_key=$2`, [n.source_id, n.source_key])).rows[0]?.item_id;
    const hits = (await c.query(`SELECT DISTINCT i.item_id, i.first_seen FROM crawl_item_keys k JOIN crawl_items i USING (item_id)
        WHERE k.key = ANY($1) ORDER BY i.first_seen, i.item_id`, [n.keys])).rows.map(r => r.item_id as string);
    const ids = [...new Set([...(prior ? [prior] : []), ...hits])];
    let item_id = ids[0], created = false;
    if (!item_id) {
      item_id = "itm_" + sha(n.keys[0] ?? `${n.source_id}:${n.source_key}`).slice(0, 16);
      await c.query(`INSERT INTO crawl_items(item_id,type,name) VALUES ($1,$2,$3) ON CONFLICT (item_id) DO NOTHING`, [item_id, n.type, n.name]);
      created = true;
    }
    for (const other of ids.slice(1)) await mergeInto(c, other, item_id, "hard-key overlap");
    const cur = (await c.query("SELECT * FROM crawl_items WHERE item_id=$1", [item_id])).rows[0];
    const summary = TEXT_OK.has(n.licence_class) && n.summary ? (cur.summary && cur.summary_source !== n.source_id && TYPE_RANK[cur.type] > TYPE_RANK[n.type] ? cur.summary : n.summary) : cur.summary;
    const summary_source = summary === cur.summary ? cur.summary_source : n.source_id;
    const type = !cur.type || created || (TYPE_RANK[n.type] ?? 0) > (TYPE_RANK[cur.type] ?? 0) ? n.type : cur.type;
    const urls = { ...stripNull(n.urls), ...stripNull(cur.urls) };            // first-seen wins for urls
    if (!urls.primary) urls.primary = n.urls.primary;
    const name = created || !cur.name ? n.name : cur.name;
    const signals = { ...cur.signals, [n.source_id]: n.signals ?? {} };
    const pricing = { ...cur.pricing, ...Object.fromEntries(Object.entries(n.pricing ?? {}).filter(([, v]) => v != null)) };
    const tags = [...new Set([...(cur.tags ?? []), ...(n.tags ?? [])])].slice(0, 15);
    const category = cur.category ?? n.category ?? null;
    const domain = cur.domain ?? n.domain ?? null, provider = cur.provider ?? n.provider ?? null;
    const content_hash = sha(JSON.stringify([type, name, summary, urls.primary, category, domain]));
    await c.query(`UPDATE crawl_items SET type=$2,name=$3,provider=$4,domain=$5,urls=$6,summary=$7,summary_source=$8,category=$9,tags=$10,
        pricing=$11,signals=$12,content_hash=$13,last_seen=now() WHERE item_id=$1`,
      [item_id, type, name.slice(0, 200), provider, domain, urls, summary, summary_source, category, tags, pricing, signals, content_hash]);
    for (const k of n.keys) await c.query(`INSERT INTO crawl_item_keys(key,item_id) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [k, item_id]);
    await c.query(`INSERT INTO crawl_item_sources(source_id,source_key,item_id,source_url,licence_class,fetched_at,facts) VALUES ($1,$2,$3,$4,$5,now(),$6)
        ON CONFLICT (source_id,source_key) DO UPDATE SET item_id=$3, source_url=$4, licence_class=$5, fetched_at=now(), facts=$6`,
      [n.source_id, n.source_key, item_id, n.source_url, n.licence_class, { keys: n.keys, ...(n.facts ?? {}) }]);
    await c.query("COMMIT");
    return { item_id, created, changed: created || content_hash !== cur.content_hash };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
const stripNull = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)));

export async function mergeInto(c: PoolClient | typeof pool, from: string, into: string, reason: string) {
  if (from === into) return;
  await c.query("UPDATE crawl_item_keys SET item_id=$2 WHERE item_id=$1", [from, into]);
  await c.query("UPDATE crawl_item_sources SET item_id=$2 WHERE item_id=$1", [from, into]);
  await c.query("UPDATE crawl_probes SET item_id=$2 WHERE item_id=$1", [from, into]);
  const f = (await c.query("SELECT signals, pricing, tags FROM crawl_items WHERE item_id=$1", [from])).rows[0];
  if (f) await c.query(`UPDATE crawl_items SET signals = $2 || signals, pricing = $3 || pricing,
      tags = (SELECT array(SELECT DISTINCT unnest(tags || $4::text[]) LIMIT 15)) WHERE item_id=$1`, [into, f.signals, f.pricing, f.tags ?? []]);
  await c.query("UPDATE crawl_items SET status='merged', merged_into=$2 WHERE item_id=$1", [from, into]);
  await c.query("UPDATE crawl_dedup_queue SET status='merged', decided_at=now() WHERE status='pending' AND ((item_a=$1 AND item_b=$2) OR (item_a=$2 AND item_b=$1))", [from, into]);
}
