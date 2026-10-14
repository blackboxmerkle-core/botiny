// Testnet only: buy one month of a data-feed tier via x402 with PAYER_PRIVATE_KEY (never printed), then page the export and the
// change feed. Key goes to FEED_KEY_FILE (default ~/.botiny/data-feed.key, 0600) and is never printed.
// Usage: tsx --env-file=.env scripts/feed-subscribe.ts [basic|pro] [--rotate] [--no-buy]
import { privateKeyToAccount } from "viem/accounts";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { paidFetch } from "../src/payclient";
const raw = process.env.PAYER_PRIVATE_KEY; if (!raw) throw new Error("PAYER_PRIVATE_KEY not set");
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
const base = (process.env.API_BASE ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8402").replace(/\/$/, "");
const KF = process.env.FEED_KEY_FILE ?? `${process.env.HOME}/.botiny/data-feed.key`;
const tier = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "basic";
(async () => {
  const H = { "ngrok-skip-browser-warning": "1" };
  if (!process.argv.includes("--no-buy")) {
    const t = (await (await fetch(base + "/v1/feed/tiers", { headers: H })).json()).tiers.find((x: any) => x.tier === tier);
    const cap = BigInt(process.env.FEED_CAP_ATOMIC ?? "1000000");
    const r = await paidFetch(base + `/v1/feed/subscribe?tier=${tier}` + (process.argv.includes("--rotate") ? "&rotate_key=1" : ""), "/v1/feed/subscribe", t.tos_params, "{}", { account, networks: [process.env.PAY_NETWORK ?? "base-sepolia"], maxAmount: cap });
    const j: any = await r.res.json();
    if (j.api_key) { mkdirSync(dirname(KF), { recursive: true }); writeFileSync(KF, j.api_key + "\n", { mode: 0o600 }); chmodSync(KF, 0o600); }
    const { api_key, ...pub } = j; console.log(JSON.stringify({ subscribe_status: r.res.status, ...pub, api_key: api_key ? `(written to ${KF})` : null }));
  }
  if (!existsSync(KF)) throw new Error("no feed key file");
  const A = { ...H, authorization: "Bearer " + readFileSync(KF, "utf8").trim() };
  const p1: any = await (await fetch(base + "/v1/feed/listings?limit=50", { headers: A })).json();
  console.log(JSON.stringify({ export_page1: { catalogue_seq: p1.catalogue_seq, items: p1.items?.length, has_more: p1.has_more, quota: p1.quota } }));
  if (p1.next_cursor) { const p2: any = await (await fetch(base + "/v1/feed/listings?limit=50&cursor=" + p1.next_cursor, { headers: A })).json();
    console.log(JSON.stringify({ export_page2: { catalogue_seq: p2.catalogue_seq, items: p2.items?.length, first_seq: p2.items?.[0]?.seq, quota: p2.quota } })); }
  const ch: any = await (await fetch(base + `/v1/feed/changes?since=${Math.max(0, p1.catalogue_seq - 5)}&limit=10`, { headers: A })).json();
  console.log(JSON.stringify({ changes: { since: ch.since, head_seq: ch.head_seq, n: ch.changes?.length, ops: ch.changes?.map((c: any) => c.op), next_since: ch.next_since, quota: ch.quota } }));
})();
