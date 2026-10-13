import { q } from "./db";
import { safeFetch } from "./safe-fetch";
/** Identifying UA with contact URL. */
export const UA = process.env.CRAWLER_UA ?? "botsource-crawler/0.1 (+https://github.com/blackboxmerkle-core/botsource; bot-service discovery; contact via repo issues)";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Per-host politeness: serialise by host using crawl_hosts.next_allowed_at (works across workers). */
export async function waitForHost(host: string, minIntervalMs = 1000) {
  for (;;) {
    const r = (await q(`INSERT INTO crawl_hosts(host, min_interval_ms) VALUES ($1,$2)
        ON CONFLICT (host) DO UPDATE SET host=EXCLUDED.host
        RETURNING GREATEST(0, EXTRACT(EPOCH FROM (next_allowed_at - clock_timestamp()))*1000)::int AS wait_ms, min_interval_ms`, [host, minIntervalMs]))[0];
    if (r.wait_ms <= 0) {
      const ok = await q(`UPDATE crawl_hosts SET next_allowed_at = clock_timestamp() + (min_interval_ms || ' milliseconds')::interval
          WHERE host=$1 AND next_allowed_at <= clock_timestamp() RETURNING host`, [host]);
      if (ok.length) return;
    }
    await sleep(Math.min(Math.max(r.wait_ms, 50), 5000));
  }
}

/** robots.txt (cached 24h). Only consulted for HTML/page fetches and probes; documented APIs are fetched directly. */
export async function robotsAllowed(url: string): Promise<boolean> {
  const u = new URL(url);
  let row = (await q("SELECT robots_txt, robots_fetched_at FROM crawl_hosts WHERE host=$1", [u.host]))[0];
  if (!row || !row.robots_fetched_at || Date.now() - new Date(row.robots_fetched_at).getTime() > 86400_000) {
    let txt = "";
    try {
      await waitForHost(u.host);
      const r = await safeFetch(`${u.protocol}//${u.host}/robots.txt`, { headers: { "user-agent": UA }, timeoutMs: 8000, maxBytes: 100_000, truncate: true, maxRedirects: 5 });
      txt = r.ok ? r.text() : "";
    } catch (e: any) { if (e?.code === "blocked_address") throw e; txt = ""; }   // SSRF-blocked host: never cache, never fetch
    await q(`INSERT INTO crawl_hosts(host, robots_txt, robots_fetched_at) VALUES ($1,$2,now())
      ON CONFLICT (host) DO UPDATE SET robots_txt=$2, robots_fetched_at=now()`, [u.host, txt]);
    row = { robots_txt: txt };
  }
  return isAllowed(row.robots_txt ?? "", u.pathname + u.search);
}
/** Minimal robots.txt matcher: groups for our UA token or '*', longest match wins, Allow beats Disallow on tie. */
export function isAllowed(robots: string, path: string, agent = "botsource-crawler"): boolean {
  const groups: { agents: string[]; rules: [string, string][] }[] = [];
  let cur: any = null, lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") { if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasAgent = true; }
    else { lastWasAgent = false; if (cur && (k === "allow" || k === "disallow")) cur.rules.push([k, v]); }
  }
  const mine = groups.filter(g => g.agents.some(a => a !== "*" && agent.toLowerCase().includes(a)));
  const use = mine.length ? mine : groups.filter(g => g.agents.includes("*"));
  let best: [string, number] = ["allow", -1];
  for (const g of use) for (const [k, v] of g.rules) {
    if (!v) continue;
    const re = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    if (re.test(path) && (v.length > best[1] || (v.length === best[1] && k === "allow"))) best = [k, v.length];
  }
  return best[0] === "allow";
}

export async function politeJson(url: string, opts: { minIntervalMs?: number; timeoutMs?: number; retries?: number; maxBytes?: number } = {}): Promise<any> {
  const host = new URL(url).host;
  let lastErr: any;
  for (let i = 0; i <= (opts.retries ?? 2); i++) {
    await waitForHost(host, opts.minIntervalMs ?? 1000);
    try {
      const r = await safeFetch(url, { headers: { "user-agent": UA, accept: "application/json" }, timeoutMs: opts.timeoutMs ?? 30000, maxBytes: opts.maxBytes ?? 50_000_000, maxRedirects: 5 });
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`HTTP ${r.status}`); await sleep(2000 * (i + 1) ** 2); continue; }
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${r.text().slice(0, 120)}`), { status: r.status, fatal: true });
      const ct = r.headers["content-type"] ?? "";
      if (!ct.includes("json")) throw Object.assign(new Error(`non-JSON response (${ct.slice(0, 40)}) — endpoint moved?`), { fatal: true });
      return r.json();
    } catch (e: any) { lastErr = e; if (e.fatal || e.code === "blocked_address" || e.code === "too_large") throw e; await sleep(1000 * (i + 1)); }
  }
  throw lastErr;
}
