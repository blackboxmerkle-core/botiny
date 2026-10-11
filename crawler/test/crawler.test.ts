import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resetTestDb } from "../../api/src/seed";
import { createApp } from "../../api/src/app";
import { pool, q } from "../src/db";
import { ensureSources } from "../src/sources";
import { isAllowed } from "../src/http";
import { decode402, probeItem } from "../src/probe";
import { upsertItem } from "../src/store";
import { findNearDuplicates, decideDuplicate } from "../src/dedupe";
import { scoreItem, rescoreAll } from "../src/score";
import { publish } from "../src/publish";
import { enqueue, claim, failJob, retryJob } from "../src/queue";
import { runSync } from "../src/jobs";
import { CONNECTORS } from "../src/connectors";
import type { NormItem } from "../src/normalize";

let api: any, base = "";
before(async () => { await resetTestDb(); await ensureSources(); api = createApp().listen(0); base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`; });
after(async () => { api.close(); await pool.end(); });

const item = (o: Partial<NormItem>): NormItem => ({ source_id: "x402-bazaar", source_key: "k", source_url: "https://example.test/src", licence_class: "public-metadata",
  type: "x402", name: "Thing", urls: { primary: "https://svc.example.test/a" }, keys: ["url:https://svc.example.test/a"], ...o } as NormItem);

test("robots.txt matcher: longest match, Allow beats Disallow, our UA group preferred", () => {
  const r = "User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: botsource-crawler\nDisallow: /nobots\n";
  assert.equal(isAllowed(r, "/private/x"), true, "own group used, * group ignored");
  assert.equal(isAllowed(r, "/nobots/a"), false);
  assert.equal(isAllowed("User-agent: *\nDisallow: /private\nAllow: /private/ok", "/private/ok/1"), true);
  assert.equal(isAllowed("User-agent: *\nDisallow: /private\nAllow: /private/ok", "/private/no"), false);
  assert.equal(isAllowed("User-agent: *\nDisallow: /", "/"), false);
  assert.equal(isAllowed("", "/anything"), true);
});

test("decode402 reads v1 JSON body and v2 PAYMENT-REQUIRED header", () => {
  const acc = { scheme: "exact", network: "base", amount: "1000", asset: "0xA", payTo: "0xB" };
  assert.deepEqual(decode402(402, new Headers(), JSON.stringify({ x402Version: 1, accepts: [acc] }))?.payTo, "0xB");
  const h = new Headers({ "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [acc, acc] })).toString("base64") });
  const d = decode402(402, h, "<html>");
  assert.equal(d?.x402Version, 2); assert.equal(d?.options, 2); assert.equal(d?.amount, "1000");
  assert.equal(decode402(200, h, ""), null);
});

test("hard-key dedupe merges across sources; ids-only licence never stores text", async () => {
  const a = await upsertItem(item({ source_key: "https://svc.example.test/a", summary: "Weather forecasts for agents", keys: ["url:https://svc.example.test/a", "payto:0xabc@svc.example.test"], domain: "svc.example.test" }));
  const b = await upsertItem(item({ source_id: "agentic-market", source_key: "svc-1", licence_class: "ids-only", summary: "PROPRIETARY TEXT", category: "Weather",
    keys: ["am:svc-1", "url:https://svc.example.test/a"] }));
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(b.item_id, a.item_id);
  const [it] = await q("SELECT * FROM crawl_items WHERE item_id=$1", [a.item_id]);
  assert.equal(it.summary, "Weather forecasts for agents"); assert.equal(it.category, "Weather");
  // an agentic-market-only item has no summary
  const c = await upsertItem(item({ source_id: "agentic-market", source_key: "svc-2", licence_class: "ids-only", summary: "PROPRIETARY", keys: ["am:svc-2"], urls: { primary: "https://other.test/x" } }));
  assert.equal((await q("SELECT summary FROM crawl_items WHERE item_id=$1", [c.item_id]))[0].summary, null);
  assert.equal((await q("SELECT count(*)::int n FROM crawl_items WHERE summary LIKE '%PROPRIETARY%'"))[0].n, 0);
  // a record whose keys bridge two existing items merges them
  const d = await upsertItem(item({ source_id: "npm", source_key: "bridge", licence_class: "package-registry", type: "package", keys: ["am:svc-2", "payto:0xabc@svc.example.test"] }));
  const merged = await q("SELECT item_id, merged_into FROM crawl_items WHERE status='merged'");
  assert.equal(merged.length, 1); assert.equal(d.item_id, a.item_id);
  assert.equal((await q("SELECT count(DISTINCT item_id)::int n FROM crawl_item_keys WHERE key IN ('am:svc-2','am:svc-1')"))[0].n, 1);
});

test("near-duplicates go to the review queue and can be merged or marked distinct", async () => {
  await upsertItem(item({ source_id: "mcp-registry", source_key: "io.acme/weather", type: "mcp", name: "Acme Weather", domain: "acme.test", keys: ["mcp:io.acme/weather"] }));
  await upsertItem(item({ source_id: "smithery", source_key: "acme-weather", type: "mcp", name: "Acme Weather MCP Server", domain: "acme.test", keys: ["smithery:acme-weather"] }));
  await upsertItem(item({ source_id: "smithery", source_key: "acme-maps", type: "mcp", name: "Totally Different Maps", domain: "acme.test", keys: ["smithery:acme-maps"] }));
  assert.ok(await findNearDuplicates() >= 1);
  const pend = await q("SELECT d.*, a.name an, b.name bn FROM crawl_dedup_queue d JOIN crawl_items a ON a.item_id=d.item_a JOIN crawl_items b ON b.item_id=d.item_b WHERE d.status='pending' AND a.domain='acme.test'");
  assert.equal(pend.length, 1); assert.ok(/Weather/.test(pend[0].an) && /Weather/.test(pend[0].bn));
  assert.equal(await findNearDuplicates(), 0, "idempotent");
  const r = await decideDuplicate(pend[0].id, "merge");
  assert.equal(r.status, "merged");
  assert.equal((await q("SELECT status FROM crawl_items WHERE item_id=$1", [pend[0].item_b]))[0].status, "merged");
  await assert.rejects(decideDuplicate(pend[0].id, "distinct"), /already decided/);
});

test("quality and advertiser-lead scores: good + low usage => high lead; heavy usage => low lead", () => {
  const base = { type: "x402", summary: "s", domain: "d.test", urls: { primary: "https://d.test" }, category: "c", pricing: { x402: {}, probe: { ok_402: true } } };
  const quiet = scoreItem({ ...base, signals: { "x402-bazaar": { calls_30d: 3, last_called_at: new Date().toISOString() }, "agentic-market": {} } });
  const busy = scoreItem({ ...base, signals: { "x402-bazaar": { calls_30d: 900000, unique_payers_30d: 4000, last_called_at: new Date().toISOString() } } });
  assert.ok(quiet.quality >= 50, JSON.stringify(quiet)); assert.ok(quiet.lead > busy.lead + 30, JSON.stringify([quiet, busy]));
  assert.equal(scoreItem({ type: "x402", signals: {}, urls: {} }).lead, 0, "unreachable / low quality => no lead");
});

test("free 402 probe: one unpaid request, decodes challenge, never sends a payment header", async () => {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === "/robots.txt") { res.end("User-agent: *\nDisallow: /blocked\n"); return; }
    res.writeHead(402, { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:84532", amount: "5000", asset: "0xUSDC", payTo: "0xPAY" }] })).toString("base64") });
    res.end("{}");
  }).listen(0);
  const port = (srv.address() as AddressInfo).port;
  const ok = await upsertItem(item({ source_key: "probe-ok", keys: [`url:http://127.0.0.1:${port}/paid`], urls: { primary: `http://127.0.0.1:${port}/paid`, endpoint: `http://127.0.0.1:${port}/paid` }, pricing: { x402: { method: "POST" } } }));
  const blocked = await upsertItem(item({ source_key: "probe-blocked", keys: [`url:http://127.0.0.1:${port}/blocked`], urls: { primary: `http://127.0.0.1:${port}/blocked` } }));
  const r: any = await probeItem(ok.item_id);
  assert.equal(r.http_status, 402); assert.equal(r.ok_402, true); assert.equal(r.x402.payTo, "0xPAY"); assert.equal(r.x402.amount, "5000");
  const rb: any = await probeItem(blocked.item_id);
  assert.equal(rb.error, "robots.txt disallows");
  const hits = seen.filter(s => s.url !== "/robots.txt");
  assert.equal(hits.length, 1, "exactly one request to the paid endpoint; blocked path never fetched");
  for (const s of seen) { assert.ok(!s.headers["x-payment"] && !s.headers["payment-signature"]); assert.match(String(s.headers["user-agent"]), /botsource-crawler.*github\.com/); }
  const [it] = await q("SELECT pricing FROM crawl_items WHERE item_id=$1", [ok.item_id]);
  assert.equal(it.pricing.probe.ok_402, true);
  srv.close();
});

test("publishing appends listings (with source URL + licence) without breaking replay of earlier requests", async () => {
  const pay = (id: string, query: string) => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-PAYMENT": "mock:" + id }, body: JSON.stringify({ query, k: 5 }) }).then(r => r.json());
  const before = await pay("cr-before-" + Date.now(), "weather forecast api for agents");
  const seedCount = (await q("SELECT count(*)::int n FROM listings"))[0].n;
  await upsertItem(item({ source_key: "pub-1", name: "Zephyr Weather Forecast API", summary: "Hourly weather forecast API for agents, pay per call with x402", domain: "zephyr.test",
    urls: { primary: "https://zephyr.test/forecast" }, keys: ["url:https://zephyr.test/forecast"], signals: { calls_30d: 10, last_called_at: new Date().toISOString() } }));
  await rescoreAll();
  const p1 = await publish({ minQuality: 0 });
  assert.ok(p1.published >= 1);
  const [l] = await q("SELECT * FROM listings WHERE name='Zephyr Weather Forecast API'");
  assert.equal(l.source_url, "https://example.test/src"); assert.equal(l.licence_class, "public-metadata"); assert.ok(l.crawl_item_id);
  assert.ok((await q("SELECT count(*)::int n FROM listings WHERE crawl_item_id IS NULL"))[0].n === seedCount, "seed listings kept");
  assert.equal((await publish({ minQuality: 0 })).published, 0, "unchanged items are not re-appended");
  // change -> new row superseding the old (append-only)
  await upsertItem(item({ source_id: "agentic-market", source_key: "zephyr", licence_class: "ids-only", keys: ["url:https://zephyr.test/forecast"], category: "Weather" }));
  await q("UPDATE crawl_items SET content_hash='changed' WHERE item_id=$1", [l.crawl_item_id]);
  await publish({ minQuality: 0 });
  const rows = await q("SELECT listing_id, supersedes FROM listings WHERE crawl_item_id=$1 ORDER BY seq", [l.crawl_item_id]);
  assert.equal(rows.length, 2); assert.equal(rows[1].supersedes, rows[0].listing_id);
  // the request made before publishing still replays to the identical hash
  const rp = await (await fetch(`${base}/v1/requests/${before.request_id}/replay`)).json();
  assert.equal(rp.match, true); assert.equal(rp.replayed_hash ?? rp.response_hash, before.response_hash);
  const after = await pay("cr-after-" + Date.now(), "weather forecast api for agents");
  assert.ok(after.response.results.some((x: any) => x.name === "Zephyr Weather Forecast API"), "new listing is discoverable");
});

test("job queue: claim with SKIP LOCKED, backoff retry, terminal failure, manual retry", async () => {
  await q("DELETE FROM crawl_jobs");
  const j = await enqueue("score");
  const c1 = await claim("w1"); assert.equal(c1.job_id, j.job_id); assert.equal(await claim("w2"), null, "no double-claim");
  await failJob(c1, new Error("boom"));
  let [row] = await q("SELECT * FROM crawl_jobs WHERE job_id=$1", [j.job_id]);
  assert.equal(row.status, "queued"); assert.ok(new Date(row.run_after) > new Date(), "backoff");
  await q("UPDATE crawl_jobs SET attempts=3 WHERE job_id=$1", [j.job_id]);
  await failJob({ ...row, attempts: 3 }, new Error("boom again"));
  [row] = await q("SELECT * FROM crawl_jobs WHERE job_id=$1", [j.job_id]);
  assert.equal(row.status, "failed");
  assert.equal((await retryJob(j.job_id)).status, "queued");
});

test("sync run: connector pages are normalised, cursor persisted, unhealthy source recorded on failure", async () => {
  const orig = CONNECTORS.npm;
  let calls = 0;
  CONNECTORS.npm = async (cur: any) => { calls++; return { items: [item({ source_id: "npm", licence_class: "package-registry", type: "package", source_key: "pkg-" + (cur.from ?? 0), name: "pkg" + (cur.from ?? 0), keys: ["npm:pkg-" + (cur.from ?? 0)] })], next: (cur.from ?? 0) < 1 ? { from: 1 } : null }; };
  const r = await runSync("npm");
  assert.equal(r.status, "ok"); assert.equal(r.fetched, 2); assert.equal(calls, 2);
  assert.equal((await q("SELECT health FROM crawl_sources WHERE source_id='npm'"))[0].health, "healthy");
  CONNECTORS.npm = async () => { throw Object.assign(new Error("HTTP 404 moved"), { fatal: true }); };
  await assert.rejects(runSync("npm"), /moved/);
  const [s] = await q("SELECT health, last_error FROM crawl_sources WHERE source_id='npm'");
  assert.equal(s.health, "unhealthy"); assert.match(s.last_error, /moved/);
  assert.equal((await q("SELECT status FROM crawl_runs ORDER BY run_id DESC LIMIT 1"))[0].status, "failed");
  CONNECTORS.npm = orig;
  await assert.rejects(runSync("glama"), /disabled/);
});
