import { hostname } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";
import { migrateCrawler } from "./db";
import { claim, complete, failJob } from "./queue";
import { runJob, schedule } from "./jobs";
const ME = `${hostname()}:${process.pid}`;
let stopping = false;
process.on("SIGTERM", () => (stopping = true)); process.on("SIGINT", () => (stopping = true));
const log = (o: any) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
(async () => {
  mkdirSync("logs", { recursive: true }); writeFileSync("logs/worker.pid", String(process.pid));
  await migrateCrawler();
  let lastSched = 0;
  log({ ev: "worker_start", worker: ME });
  while (!stopping) {
    if (process.env.CRAWLER_NO_SCHEDULE !== "1" && Date.now() - lastSched > 60_000) { lastSched = Date.now(); const n = await schedule().catch(e => (log({ ev: "schedule_error", error: e.message }), 0)); if (n) log({ ev: "scheduled", n }); }
    const job = await claim(ME).catch(() => null);
    if (!job) { await new Promise(r => setTimeout(r, 3000)); continue; }
    log({ ev: "job_start", job_id: job.job_id, kind: job.kind, source: job.source_id });
    try { const r = await runJob(job); await complete(job.job_id, r); log({ ev: "job_done", job_id: job.job_id, result: r }); }
    catch (e: any) { await failJob(job, e); log({ ev: "job_failed", job_id: job.job_id, error: String(e.message).slice(0, 300) }); }
  }
  log({ ev: "worker_stop" }); process.exit(0);
})();
