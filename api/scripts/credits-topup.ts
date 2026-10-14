// Testnet only: buy one search-credit pack via x402 (ToS bound into the nonce) with PAYER_PRIVATE_KEY (never printed), then run
// N credit-debited searches. The issued API key is written to CREDIT_KEY_FILE (default ~/.botiny/search-credit.key, 0600, outside
// the repo) and never printed. Usage: tsx --env-file=.env scripts/credits-topup.ts [searches=3] [--rotate]
import { privateKeyToAccount } from "viem/accounts";
import { writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { paidFetch } from "../src/payclient";
const raw = process.env.PAYER_PRIVATE_KEY; if (!raw) throw new Error("PAYER_PRIVATE_KEY not set");
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
const base = (process.env.API_BASE ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8402").replace(/\/$/, "");
const KF = process.env.CREDIT_KEY_FILE ?? `${process.env.HOME}/.botiny/search-credit.key`;
const N = Number(process.argv[2] ?? 3), rotate = process.argv.includes("--rotate"), skipTopup = process.argv.includes("--no-topup");
(async () => {
  const H = { "ngrok-skip-browser-warning": "1" };
  if (!skipTopup) {
    const pricing = await (await fetch(base + "/v1/credits/pricing", { headers: H })).json();
    const cap = BigInt(process.env.CREDIT_TOPUP_CAP_ATOMIC ?? "1000000");   // never pay more than 1 test USDC without opting in
    const r = await paidFetch(base + "/v1/credits/topup" + (rotate ? "?rotate_key=1" : ""), "/v1/credits/topup", pricing.tos_params, "{}", { account, networks: [process.env.PAY_NETWORK ?? "base-sepolia"], maxAmount: cap });
    const j: any = await r.res.json();
    if (j.api_key) { mkdirSync(dirname(KF), { recursive: true }); writeFileSync(KF, j.api_key + "\n", { mode: 0o600 }); chmodSync(KF, 0o600); }
    const { api_key, ...pub } = j;
    console.log(JSON.stringify({ topup_status: r.res.status, payer: account.address, ...pub, api_key: api_key ? `(written to ${KF})` : null }));
  }
  if (!existsSync(KF)) throw new Error("no credit key file; top up first");
  const key = readFileSync(KF, "utf8").trim();
  const qs = ["x402 facilitator to settle USDC payments", "MCP server for browser automation", "hosted vector database for agent memory", "speech to text API payable with USDC"];
  for (let i = 0; i < N; i++) {
    const res = await fetch(base + "/v1/recommend", { method: "POST", headers: { ...H, "content-type": "application/json", authorization: "Bearer " + key, "X-Bot-Id": "credits-check" }, body: JSON.stringify({ query: qs[i % qs.length], k: 3 }) });
    const j: any = await res.json();
    console.log(JSON.stringify({ search_status: res.status, request_id: j.request_id, response_hash: j.response_hash, ranker: j.response?.ranker_version?.slice(0, 8), payment: j.payment ?? j.error,
      results: j.response?.results?.map((x: any) => `${x.rank}:${x.sponsored ? "S:" : ""}${x.listing_id}`) }));
  }
})();
