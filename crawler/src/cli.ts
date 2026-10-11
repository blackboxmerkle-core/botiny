// npm run crawl -- <sync SOURCE [maxPages] | postprocess | probe [n] | publish | schedule>
import { migrateCrawler, pool } from "./db";
import { runSync, runJob, runProbes, schedule } from "./jobs";
(async () => {
  await migrateCrawler();
  const [cmd, a, b] = process.argv.slice(2);
  let r: any;
  if (cmd === "sync") r = await runSync(a, null, b ? { max_pages: Number(b) } : {});
  else if (cmd === "probe") r = await runProbes(Number(a ?? 60));
  else if (cmd === "schedule") r = await schedule();
  else r = await runJob({ kind: cmd ?? "postprocess", payload: {} });
  console.log(JSON.stringify(r)); await pool.end();
})().catch(async e => { console.error(e.message); await pool.end(); process.exit(1); });
