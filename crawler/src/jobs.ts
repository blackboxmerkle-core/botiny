import { q } from "./db";
import { CONNECTORS } from "./connectors";
import { upsertItem } from "./store";
import { rescoreAll } from "./score";
import { findNearDuplicates } from "./dedupe";
import { probeItem } from "./probe";
import { publish } from "./publish";
import { enqueue } from "./queue";
import { runSuggestion } from "./suggest";

/** Sync one source for up to max_pages pages from its saved cursor; cursor persisted after every page (resumable). */
export async function runSync(source_id: string, job_id: number | null = null, override: any = {}) {
  const src = (await q("SELECT * FROM crawl_sources WHERE source_id=$1", [source_id]))[0];
  if (!src) throw Object.assign(new Error("unknown source"), { fatal: true });
  if (!src.enabled) throw Object.assign(new Error("source disabled (" + src.licence_class + ")"), { fatal: true });
  const conn = CONNECTORS[source_id]; if (!conn) throw Object.assign(new Error("no connector"), { fatal: true });
  const cfg = { ...src.config, ...override };
  const run = (await q("INSERT INTO crawl_runs(source_id, job_id) VALUES ($1,$2) RETURNING run_id", [source_id, job_id]))[0];
  const started = new Date().toISOString();
  let cursor = src.cursor ?? {}, pages = 0, fetched = 0, created = 0, changed = 0, errors = 0, sample: string | null = null, status = "ok";
  try {
    for (; pages < (cfg.max_pages ?? 10); pages++) {
      const page = await conn(cursor, cfg);
      fetched += page.items.length;
      for (const it of page.items) {
        try { const r = await upsertItem(it); if (r.created) created++; else if (r.changed) changed++; }
        catch (e: any) { errors++; sample ??= `${it.source_key}: ${e.message}`; }
      }
      cursor = page.next ?? (source_id === "mcp-registry" ? { updated_since: started } : {});   // wrap: incremental for MCP registry
      await q("UPDATE crawl_sources SET cursor=$2 WHERE source_id=$1", [source_id, cursor]);
      await q("UPDATE crawl_runs SET pages=$2, fetched=$3, new_items=$4, updated_items=$5, errors=$6 WHERE run_id=$1", [run.run_id, pages + 1, fetched, created, changed, errors]);
      if (!page.next) { pages++; break; }
    }
    status = errors ? "partial" : "ok";
    await q("UPDATE crawl_sources SET health=$2, last_ok_at=now(), last_error=$3 WHERE source_id=$1", [source_id, errors ? "degraded" : "healthy", sample]);
  } catch (e: any) {
    status = fetched ? "partial" : "failed"; sample = String(e.message).slice(0, 300); errors++;
    await q("UPDATE crawl_sources SET health=$2, last_error=$3 WHERE source_id=$1", [source_id, fetched ? "degraded" : "unhealthy", sample]);
    if (!fetched) { await q("UPDATE crawl_runs SET finished_at=now(), status=$2, errors=$3, error_sample=$4 WHERE run_id=$1", [run.run_id, status, errors, sample]); throw e; }
  }
  await q("UPDATE crawl_runs SET finished_at=now(), status=$2, pages=$3, fetched=$4, new_items=$5, updated_items=$6, errors=$7, error_sample=$8 WHERE run_id=$1",
    [run.run_id, status, pages, fetched, created, changed, errors, sample]);
  return { run_id: run.run_id, status, pages, fetched, new_items: created, updated_items: changed, errors };
}
export async function runProbes(limit = 60) {
  const items = await q(`SELECT item_id FROM crawl_items WHERE status='active' AND type='x402' AND (urls->>'endpoint' IS NOT NULL OR urls->>'primary' IS NOT NULL)
     AND (pricing->'probe' IS NULL OR (pricing->'probe'->>'at')::timestamptz < now() - interval '1 day')
     ORDER BY (scores->>'quality')::int DESC NULLS LAST, item_id LIMIT $1`, [limit]);
  let ok = 0, n = 0;
  // probe different hosts concurrently (per-host politeness enforced in waitForHost)
  const pool = [...items]; const workers = Array.from({ length: 6 }, async () => { for (let it; (it = pool.shift());) { const r: any = await probeItem(it.item_id); n++; if (r.ok_402) ok++; } });
  await Promise.all(workers);
  return { probed: n, ok_402: ok };
}
export async function runJob(job: any) {
  switch (job.kind) {
    case "sync": { const r = await runSync(job.source_id, job.job_id, job.payload?.config ?? {}); await enqueue("postprocess", null, { after: job.job_id }); return r; }
    case "postprocess": return { scored: await rescoreAll(), dedup_added: await findNearDuplicates(), ...(await runProbes(job.payload?.probe_limit ?? 60)), rescored: await rescoreAll(), ...(await publish()) };
    case "probe": return runProbes(job.payload?.limit ?? 60);
    case "score": return { scored: await rescoreAll() };
    case "dedupe": return { added: await findNearDuplicates() };
    case "publish": return publish(job.payload ?? {});
    case "suggestion": return runSuggestion(String(job.payload?.suggestion_id ?? ""));
    default: throw Object.assign(new Error("unknown job kind " + job.kind), { fatal: true });
  }
}
/** Schedule a sync for each enabled, unpaused source whose interval has elapsed and has no pending sync. */
export async function schedule() {
  const due = await q(`SELECT s.source_id FROM crawl_sources s WHERE s.enabled AND NOT s.paused
      AND NOT EXISTS (SELECT 1 FROM crawl_jobs j WHERE j.source_id=s.source_id AND j.kind='sync' AND j.status IN ('queued','running','paused'))
      AND COALESCE((SELECT max(started_at) FROM crawl_runs r WHERE r.source_id=s.source_id), 'epoch') < now() - ((COALESCE((s.config->>'interval_min')::int, 360)) || ' minutes')::interval`);
  for (const d of due) await enqueue("sync", d.source_id);
  return due.length;
}
