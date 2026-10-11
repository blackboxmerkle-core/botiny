import { q, pool } from "./db";
import { nameTokens, jaccard } from "./normalize";
import { mergeInto } from "./store";
/** Near-match candidates for human review (never auto-merged):
 *  (a) same domain, different items, name token Jaccard >= 0.6
 *  (b) identical normalised name across different domains/providers. */
export async function findNearDuplicates(limitPerBlock = 50): Promise<number> {
  let added = 0;
  const rows = await q(`SELECT item_id, name, domain, type FROM crawl_items WHERE status='active' ORDER BY item_id`);
  const byDomain = new Map<string, any[]>(), byName = new Map<string, any[]>();
  for (const r of rows) {
    if (r.domain) (byDomain.get(r.domain) ?? byDomain.set(r.domain, []).get(r.domain)!).push(r);
    const nk = [...nameTokens(r.name)].sort().join(" ");
    if (nk.length >= 4) (byName.get(nk) ?? byName.set(nk, []).get(nk)!).push(r);
  }
  const add = async (a: any, b: any, sim: number, reason: string) => {
    const [x, y] = a.item_id < b.item_id ? [a, b] : [b, a];
    const r = await q(`INSERT INTO crawl_dedup_queue(item_a,item_b,similarity_ppm,reason) VALUES ($1,$2,$3,$4) ON CONFLICT (item_a,item_b) DO NOTHING RETURNING id`,
      [x.item_id, y.item_id, Math.round(sim * 1e6), reason]);
    added += r.length;
  };
  for (const [dom, list] of byDomain) {
    if (list.length < 2 || list.length > 200) continue;               // huge domains (e.g. github.com) are not a signal
    let n = 0;
    for (let i = 0; i < list.length && n < limitPerBlock; i++) for (let j = i + 1; j < list.length && n < limitPerBlock; j++) {
      const s = jaccard(nameTokens(list[i].name), nameTokens(list[j].name));
      if (s >= 0.6) { await add(list[i], list[j], s, `same domain ${dom}, similar names`); n++; }
    }
  }
  for (const [nk, list] of byName) {
    if (list.length < 2 || list.length > 6) continue;
    for (let i = 1; i < list.length; i++) if (list[i].domain !== list[0].domain) await add(list[0], list[i], 1, `identical name "${nk}" on different domains`);
  }
  return added;
}
export async function decideDuplicate(id: number, decision: "merge" | "distinct") {
  const d = (await q("SELECT * FROM crawl_dedup_queue WHERE id=$1", [id]))[0];
  if (!d) throw Object.assign(new Error("not found"), { status: 404 });
  if (d.status !== "pending") throw Object.assign(new Error("already decided"), { status: 409 });
  if (decision === "distinct") { await q("UPDATE crawl_dedup_queue SET status='distinct', decided_at=now() WHERE id=$1", [id]); return { id, status: "distinct" }; }
  const c = await pool.connect();
  try { await c.query("BEGIN"); await mergeInto(c, d.item_b, d.item_a, "review"); await c.query("UPDATE crawl_dedup_queue SET status='merged', decided_at=now() WHERE id=$1", [id]); await c.query("COMMIT"); }
  catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  return { id, status: "merged", kept: d.item_a, merged: d.item_b };
}
