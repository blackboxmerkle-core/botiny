import { q } from "./db";
export async function enqueue(kind: string, source_id: string | null = null, payload: any = {}, delaySec = 0) {
  return (await q(`INSERT INTO crawl_jobs(kind,source_id,payload,run_after) VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval) RETURNING *`, [kind, source_id, payload, delaySec]))[0];
}
export async function claim(worker: string) {
  await q(`UPDATE crawl_jobs SET status='queued', locked_at=NULL, locked_by=NULL WHERE status='running' AND locked_at < now() - interval '30 minutes'`);
  return (await q(`UPDATE crawl_jobs SET status='running', locked_at=now(), locked_by=$1, attempts=attempts+1
      WHERE job_id = (SELECT job_id FROM crawl_jobs WHERE status='queued' AND run_after <= now() ORDER BY run_after, job_id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`, [worker]))[0] ?? null;
}
export async function complete(job_id: number, result: any) { await q("UPDATE crawl_jobs SET status='done', finished_at=now(), result=$2, last_error=NULL WHERE job_id=$1", [job_id, result]); }
export async function failJob(job: any, err: any) {
  const msg = String(err?.message ?? err).slice(0, 500);
  if (job.attempts < job.max_attempts && !err?.fatal)
    await q(`UPDATE crawl_jobs SET status='queued', last_error=$2, locked_at=NULL, run_after=now() + ($3 || ' seconds')::interval WHERE job_id=$1`, [job.job_id, msg, 60 * 2 ** job.attempts]);
  else await q("UPDATE crawl_jobs SET status='failed', finished_at=now(), last_error=$2 WHERE job_id=$1", [job.job_id, msg]);
}
export async function retryJob(id: number) { return (await q(`UPDATE crawl_jobs SET status='queued', attempts=0, run_after=now(), last_error=NULL, finished_at=NULL WHERE job_id=$1 AND status IN ('failed','cancelled','paused') RETURNING *`, [id]))[0]; }
export async function pauseJob(id: number) { return (await q(`UPDATE crawl_jobs SET status='paused' WHERE job_id=$1 AND status='queued' RETURNING *`, [id]))[0]; }
export async function cancelJob(id: number) { return (await q(`UPDATE crawl_jobs SET status='cancelled', finished_at=now() WHERE job_id=$1 AND status IN ('queued','paused') RETURNING *`, [id]))[0]; }
