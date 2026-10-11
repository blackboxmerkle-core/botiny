import { q } from "./db";
import { UA, waitForHost, robotsAllowed } from "./http";
/** Decode an x402 challenge from a 402 response: JSON body {accepts:[...]} (v1) or PAYMENT-REQUIRED header (base64 JSON, v2). */
export function decode402(status: number, headers: Headers | Record<string, string>, bodyText: string) {
  const get = (k: string) => headers instanceof Headers ? headers.get(k) : (headers as any)[k.toLowerCase()] ?? null;
  if (status !== 402) return null;
  let doc: any = null;
  const h = get("payment-required") ?? get("x-payment-required");
  if (h) { try { doc = JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { try { doc = JSON.parse(h); } catch {} } }
  if (!doc) { try { doc = JSON.parse(bodyText); } catch {} }
  const acc = doc?.accepts?.[0];
  if (!acc) return null;
  return { x402Version: doc.x402Version ?? null, network: acc.network, amount: acc.amount ?? acc.maxAmountRequired ?? null, asset: acc.asset ?? null,
    payTo: acc.payTo ?? null, scheme: acc.scheme ?? null, options: doc.accepts.length };
}
/** Free price probe: ONE unpaid request. Never signs or pays; never sends any payment header. */
export async function probeItem(item_id: string) {
  const it = (await q("SELECT item_id, urls, pricing FROM crawl_items WHERE item_id=$1", [item_id]))[0];
  const url = it?.urls?.endpoint ?? it?.urls?.primary;
  if (!url) return { skipped: "no url" };
  const method = String(it.pricing?.x402?.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const t0 = Date.now();
  let rec: any = { url, method, http_status: null, ok_402: false, x402: null, error: null };
  try {
    if (!(await robotsAllowed(url))) rec.error = "robots.txt disallows";
    else {
      await waitForHost(new URL(url).host, 2000);
      const r = await fetch(url, { method, headers: { "user-agent": UA, accept: "application/json", ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        body: method === "POST" ? "{}" : undefined, redirect: "manual", signal: AbortSignal.timeout(10000) });
      const text = (await r.text()).slice(0, 20000);
      rec.http_status = r.status; rec.x402 = decode402(r.status, r.headers, text); rec.ok_402 = !!rec.x402;
    }
  } catch (e: any) { rec.error = String(e?.cause?.code ?? e?.message ?? e).slice(0, 200); }
  rec.ms = Date.now() - t0;
  await q(`INSERT INTO crawl_probes(item_id,url,method,http_status,ok_402,x402,error,ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [item_id, url, method, rec.http_status, rec.ok_402, rec.x402, rec.error, rec.ms]);
  await q(`UPDATE crawl_items SET pricing = pricing || jsonb_build_object('probe', $2::jsonb) WHERE item_id=$1`,
    [item_id, { at: new Date().toISOString(), http_status: rec.http_status, ok_402: rec.ok_402, x402: rec.x402, error: rec.error }]);
  return rec;
}
