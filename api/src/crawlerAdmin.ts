import express from "express";
import { pool } from "./db";
import { decideDuplicate } from "../../crawler/src/dedupe";
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const fail = (res: express.Response, e: any) => res.status(e?.status ?? 500).json({ error: String(e?.message ?? e) });
const JOB_KINDS = ["sync", "postprocess", "probe", "score", "dedupe", "publish"];
const STAGES = ["new", "qualified", "contacted", "won", "lost", "ignore"];

/** Crawler monitoring & management API (mounted under /dashboard, behind basic auth). Management actions only touch
 *  crawler tables / the job queue; the crawler worker (crawler/src/worker.ts) executes the jobs. */
export function crawlerRouter() {
  const r = express.Router();
  const h = (fn: (req: express.Request, res: express.Response) => Promise<any>) => async (req: express.Request, res: express.Response) => { try { await fn(req, res); } catch (e) { fail(res, e); } };
  r.get("/api/crawler/summary", h(async (_q2, res) => {
    const [c] = await q(`SELECT count(*) FILTER (WHERE status='active')::int items, count(*) FILTER (WHERE status='merged')::int merged,
        count(*) FILTER (WHERE status='active' AND published_listing_id IS NOT NULL)::int published,
        count(*) FILTER (WHERE status='active' AND (pricing->'probe'->>'ok_402')::boolean)::int probed_ok FROM crawl_items`);
    res.json({ ...c,
      by_type: await q("SELECT type, count(*)::int n FROM crawl_items WHERE status='active' GROUP BY 1 ORDER BY 2 DESC"),
      jobs: await q("SELECT status, count(*)::int n FROM crawl_jobs GROUP BY 1"),
      dedup_pending: (await q("SELECT count(*)::int n FROM crawl_dedup_queue WHERE status='pending'"))[0].n,
      leads: (await q("SELECT count(*)::int n FROM crawl_leads"))[0].n,
      catalogue: (await q("SELECT count(*)::int n, max(seq)::int max_seq FROM listings WHERE crawl_item_id IS NOT NULL"))[0] });
  }));
  r.get("/api/crawler/sources", h(async (_q2, res) => res.json(await q(`SELECT s.*,
      (SELECT count(DISTINCT item_id)::int FROM crawl_item_sources x WHERE x.source_id=s.source_id) items,
      (SELECT row_to_json(r) FROM (SELECT run_id, status, started_at, finished_at, pages, fetched, new_items, errors FROM crawl_runs r WHERE r.source_id=s.source_id ORDER BY run_id DESC LIMIT 1) r) last_run,
      (SELECT count(*)::int FROM crawl_jobs j WHERE j.source_id=s.source_id AND j.status IN ('queued','running')) active_jobs
    FROM crawl_sources s ORDER BY s.source_id`))));
  r.post("/api/crawler/sources/:id/:action", h(async (req, res) => {
    const id = String(req.params.id), a = String(req.params.action);
    if (!["run", "pause", "resume"].includes(a)) return res.status(404).json({ error: "unknown action" });
    const s = (await q("SELECT * FROM crawl_sources WHERE source_id=$1", [id]))[0];
    if (!s) return res.status(404).json({ error: "unknown source" });
    if (a === "run") {
      if (!s.enabled) return res.status(409).json({ error: `source disabled (${s.licence_class})` });
      const job = (await q("INSERT INTO crawl_jobs(kind, source_id, payload) VALUES ('sync',$1,$2) RETURNING *", [id, { requested_by: "dashboard" }]))[0];
      return res.json({ job });
    }
    await q("UPDATE crawl_sources SET paused=$2 WHERE source_id=$1", [id, a === "pause"]);
    if (a === "pause") await q("UPDATE crawl_jobs SET status='paused' WHERE source_id=$1 AND status='queued'", [id]);
    else await q("UPDATE crawl_jobs SET status='queued' WHERE source_id=$1 AND status='paused'", [id]);
    res.json({ source_id: id, paused: a === "pause" });
  }));
  r.get("/api/crawler/runs", h(async (req, res) => {
    const src = typeof req.query.source === "string" && req.query.source ? req.query.source : null;
    res.json(await q(`SELECT * FROM crawl_runs ${src ? "WHERE source_id=$1" : ""} ORDER BY run_id DESC LIMIT 200`, src ? [src] : []));
  }));
  r.get("/api/crawler/jobs", h(async (req, res) => {
    const st = typeof req.query.status === "string" && req.query.status ? req.query.status : null;
    res.json(await q(`SELECT job_id, kind, source_id, status, attempts, max_attempts, run_after, locked_by, last_error, result, created_at, finished_at
      FROM crawl_jobs ${st ? "WHERE status=$1" : ""} ORDER BY job_id DESC LIMIT 200`, st ? [st] : []));
  }));
  r.post("/api/crawler/jobs", h(async (req, res) => {
    const kind = String(req.body?.kind ?? "");
    if (!JOB_KINDS.includes(kind) || kind === "sync") return res.status(400).json({ error: "kind must be one of " + JOB_KINDS.filter(k => k !== "sync").join(", ") + " (use a source's Run for sync)" });
    res.json({ job: (await q("INSERT INTO crawl_jobs(kind, payload) VALUES ($1,$2) RETURNING *", [kind, { requested_by: "dashboard" }]))[0] });
  }));
  r.post("/api/crawler/jobs/:id/:action", h(async (req, res) => {
    const id = Number(req.params.id), a = String(req.params.action);
    if (!["retry", "pause", "resume", "cancel"].includes(a)) return res.status(404).json({ error: "unknown action" });
    const sql: Record<string, string> = {
      retry: "UPDATE crawl_jobs SET status='queued', attempts=0, run_after=now(), last_error=NULL, finished_at=NULL WHERE job_id=$1 AND status IN ('failed','cancelled') RETURNING *",
      pause: "UPDATE crawl_jobs SET status='paused' WHERE job_id=$1 AND status='queued' RETURNING *",
      resume: "UPDATE crawl_jobs SET status='queued', run_after=now() WHERE job_id=$1 AND status='paused' RETURNING *",
      cancel: "UPDATE crawl_jobs SET status='cancelled', finished_at=now() WHERE job_id=$1 AND status IN ('queued','paused') RETURNING *" };
    const row = (await q(sql[a as string], [id]))[0];
    if (!row) return res.status(409).json({ error: `cannot ${a} job ${id} in its current state` });
    res.json({ job: row });
  }));
  r.get("/api/crawler/items", h(async (req, res) => {
    const w: string[] = ["i.status='active'"], p: any[] = [];
    const add = (sql: string, v: any) => { p.push(v); w.push(sql.replace("$?", "$" + p.length)); };
    if (req.query.q) add("(i.name ILIKE $? OR i.domain ILIKE $? OR i.summary ILIKE $?)".replace(/\$\?/g, `$${p.length + 1}`), `%${req.query.q}%`);
    if (req.query.type) add("i.type = $?", req.query.type);
    if (req.query.source) add("EXISTS (SELECT 1 FROM crawl_item_sources s WHERE s.item_id=i.item_id AND s.source_id=$?)", req.query.source);
    if (req.query.min_quality) add("(i.scores->>'quality')::int >= $?", Number(req.query.min_quality));
    if (req.query.published === "1") w.push("i.published_listing_id IS NOT NULL");
    const sort = ({ quality: "(i.scores->>'quality')::int DESC NULLS LAST", lead: "(i.scores->>'lead')::int DESC NULLS LAST", recent: "i.last_seen DESC", name: "i.name" } as any)[String(req.query.sort ?? "quality")] ?? "(i.scores->>'quality')::int DESC NULLS LAST";
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500), offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const where = w.join(" AND ");
    const total = (await q(`SELECT count(*)::int n FROM crawl_items i WHERE ${where}`, p))[0].n;
    const rows = await q(`SELECT i.item_id, i.type, i.name, i.domain, i.category, i.summary, i.urls->>'primary' url, i.scores, i.pricing->'x402' x402, i.pricing->'probe' probe,
        i.published_listing_id, (SELECT array_agg(DISTINCT s.source_id) FROM crawl_item_sources s WHERE s.item_id=i.item_id) sources, i.last_seen
      FROM crawl_items i WHERE ${where} ORDER BY ${sort}, i.item_id LIMIT ${limit} OFFSET ${offset}`, p);
    res.json({ total, offset, items: rows });
  }));
  r.get("/api/crawler/items/:id", h(async (req, res) => {
    const it = (await q("SELECT * FROM crawl_items WHERE item_id=$1", [req.params.id]))[0];
    if (!it) return res.status(404).json({ error: "not found" });
    res.json({ item: it,
      sources: await q("SELECT source_id, source_key, source_url, licence_class, fetched_at FROM crawl_item_sources WHERE item_id=$1 ORDER BY source_id", [it.item_id]),
      keys: (await q("SELECT key FROM crawl_item_keys WHERE item_id=$1 ORDER BY key", [it.item_id])).map(k => k.key),
      probes: await q("SELECT at, url, method, http_status, ok_402, x402, error, ms FROM crawl_probes WHERE item_id=$1 ORDER BY id DESC LIMIT 10", [it.item_id]),
      listings: await q("SELECT seq::int, listing_id, supersedes, licence_class, source_url, created_at FROM listings WHERE crawl_item_id=$1 ORDER BY seq", [it.item_id]),
      lead: (await q("SELECT * FROM crawl_leads WHERE item_id=$1", [it.item_id]))[0] ?? null });
  }));
  r.get("/api/crawler/dedup", h(async (req, res) => {
    const st = String(req.query.status ?? "pending");
    res.json(await q(`SELECT d.*, a.name a_name, a.domain a_domain, a.type a_type, a.urls->>'primary' a_url, b.name b_name, b.domain b_domain, b.type b_type, b.urls->>'primary' b_url,
        (SELECT array_agg(DISTINCT source_id) FROM crawl_item_sources WHERE item_id=d.item_a) a_sources, (SELECT array_agg(DISTINCT source_id) FROM crawl_item_sources WHERE item_id=d.item_b) b_sources
      FROM crawl_dedup_queue d JOIN crawl_items a ON a.item_id=d.item_a JOIN crawl_items b ON b.item_id=d.item_b
      WHERE d.status=$1 ORDER BY d.similarity_ppm DESC, d.id LIMIT 200`, [st]));
  }));
  r.post("/api/crawler/dedup/:id", h(async (req, res) => {
    const dec = req.body?.decision;
    if (dec !== "merge" && dec !== "distinct") return res.status(400).json({ error: "decision must be merge|distinct" });
    res.json(await decideDuplicate(Number(req.params.id), dec));
  }));
  r.get("/api/crawler/leads", h(async (req, res) => {
    const st = typeof req.query.stage === "string" && req.query.stage ? req.query.stage : null;
    res.json({ stages: STAGES, counts: await q("SELECT stage, count(*)::int n FROM crawl_leads GROUP BY 1"),
      leads: await q(`SELECT l.item_id, l.stage, l.notes, l.updated_at, i.name, i.type, i.domain, i.category, i.urls->>'primary' url, i.urls->>'homepage' homepage, i.scores, i.signals,
          i.published_listing_id, (SELECT array_agg(DISTINCT source_id) FROM crawl_item_sources s WHERE s.item_id=i.item_id) sources
        FROM crawl_leads l JOIN crawl_items i USING (item_id) WHERE i.status='active' ${st ? "AND l.stage=$1" : ""}
        ORDER BY (i.scores->>'lead')::int DESC, l.item_id LIMIT 300`, st ? [st] : []) });
  }));
  r.put("/api/crawler/leads/:id", h(async (req, res) => {
    const stage = req.body?.stage;
    if (stage && !STAGES.includes(stage)) return res.status(400).json({ error: "bad stage" });
    const row = (await q(`INSERT INTO crawl_leads(item_id, stage, notes) VALUES ($1, COALESCE($2,'new'), $3)
        ON CONFLICT (item_id) DO UPDATE SET stage=COALESCE($2, crawl_leads.stage), notes=COALESCE($3, crawl_leads.notes), updated_at=now() RETURNING *`,
      [req.params.id, stage ?? null, req.body?.notes ?? null]))[0];
    res.json(row);
  }));
  return r;
}
