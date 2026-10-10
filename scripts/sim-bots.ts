// Two simulated bot personas making REAL x402 payments on Base Sepolia TESTNET against the public URL.
// Key: PAYER_PRIVATE_KEY (env only; never logged). Stop: npm run sim:stop (SIGTERM via logs/sim.pid).
import { createWalletClient, createPublicClient, http, publicActions, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAX_PER_PAYMENT = 10_000n;                                   // 0.01 USDC hard cap
const DAILY_BUDGET = BigInt(process.env.SIM_DAILY_BUDGET_ATOMIC ?? "500000"); // 0.5 USDC per bot per day
const MIN_PAYER_BALANCE = 1_000_000n;                              // global stop below 1 USDC
const MIN_MS = Number(process.env.SIM_MIN_MS ?? 60_000), MAX_MS = Number(process.env.SIM_MAX_MS ?? 180_000);
const REPLAY_P = 0.25;
mkdirSync("logs", { recursive: true });
const STATE = "logs/sim-state.json", PID = "logs/sim.pid";

const raw = process.env.PAYER_PRIVATE_KEY; if (!raw) throw new Error("PAYER_PRIVATE_KEY not set");
const account = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org") }).extend(publicActions);
const pub = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
if (wallet.chain.id !== 84532) throw new Error("refusing: not Base Sepolia");

// Only ever pay exact/base-sepolia/testnet-USDC requirements at or below the cap.
const selector = (reqs: any[]) => {
  const r = reqs.find(x => x.scheme === "exact" && x.network === "base-sepolia" && x.asset?.toLowerCase() === USDC.toLowerCase() && BigInt(x.maxAmountRequired) <= MAX_PER_PAYMENT);
  if (!r) throw new Error("no acceptable testnet requirement (network/asset/amount)");
  return r;
};
const payFetch = wrapFetchWithPayment(fetch, wallet as any, MAX_PER_PAYMENT, selector as any);

function baseUrl(): string {
  const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  return (/^PUBLIC_BASE_URL=(.+)$/m.exec(env)?.[1] ?? process.env.SIM_BASE_URL ?? "http://localhost:8402").trim().replace(/\/$/, "");
}
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
function loadState(): any { try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return {}; } }
function addSpend(bot: string, amt: bigint) { const s = loadState(); const k = today(); s[k] ??= {}; s[k][bot] = (BigInt(s[k][bot] ?? "0") + amt).toString(); writeFileSync(STATE, JSON.stringify(s, null, 1)); }
const spent = (bot: string) => BigInt(loadState()[today()]?.[bot] ?? "0");
const log = (bot: string, ev: string, data: object = {}) =>
  appendFileSync(`logs/sim-${bot.replace(/[^A-Za-z0-9_-]/g, "_")}.log`, JSON.stringify({ at: new Date().toISOString(), bot, ev, ...data }) + "\n");

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const PERSONAS: Record<string, { lead: string[]; topics: string[]; tail: string[]; off: string[] }> = {
  "research-bot": {
    lead: ["find", "best", "recommend", "which service for", "need an API to", "cheapest way to", "agent-payable API for"],
    topics: ["discover x402 paid APIs", "search a catalogue of agent services", "query open knowledge graph data with SPARQL", "settle USDC micropayments on Base",
      "look up package download statistics", "check known vulnerabilities for a package version", "x402 facilitator verify and settle", "list services on agentic market",
      "dependency graph and licence data for open source packages", "testnet USDC faucet for Base Sepolia", "Base Sepolia RPC endpoint"],
    tail: ["", " for a research agent", " pay per call", " with JSON output", " no API key", " via x402"],
    off: ["satellite imagery of crop fields", "real-time weather forecast API", "translate Swahili news articles", "historical FX rates for Zambian kwacha"],
  },
  "dev-bot": {
    lead: ["MCP server to", "tool for", "how do I", "recommend a dev tool to", "best MCP for", "agent tool that can"],
    topics: ["automate a browser and fill forms", "manage GitHub issues and pull requests", "read and write local files", "query Sentry errors and stack traces",
      "search Cloudflare Workers docs", "update Linear tickets", "edit Notion pages", "inspect git diff and commit", "fetch a web page as markdown",
      "persistent memory knowledge graph", "convert timezones", "add x402 paywall to an express server", "vector similarity search in postgres", "accept Stripe payments"],
    tail: ["", " in TypeScript", " for a coding agent", " remotely over streamable http", " locally", " quickly"],
    off: ["compile Rust to WebAssembly", "Kubernetes autoscaling advice", "generate unit tests for Java", "deploy a Django app"],
  },
};
function query(bot: string) {
  const p = PERSONAS[bot];
  const topic = Math.random() < 0.15 ? pick(p.off) : pick(p.topics);
  return `${pick(p.lead)} ${topic}${pick(p.tail)}`.replace(/\s+/g, " ").trim();
}

let stopping = false;
const pastIds: Record<string, string[]> = { "research-bot": [], "dev-bot": [] };
const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); const iv = setInterval(() => { if (stopping) { clearTimeout(t); clearInterval(iv); r(); } }, 500); setTimeout(() => clearInterval(iv), ms + 10); });

async function payerBalance() { return pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }); }

async function step(bot: string) {
  const base = baseUrl();
  if (pastIds[bot].length && Math.random() < REPLAY_P) {
    const id = pick(pastIds[bot]);
    const r = await fetch(`${base}/v1/requests/${id}/replay`, { headers: { "X-Bot-Id": bot, "ngrok-skip-browser-warning": "1" } });
    const j: any = await r.json().catch(() => ({}));
    log(bot, j.match ? "replay_match" : "REPLAY_MISMATCH", { request_id: id, status: r.status, logged: j.logged_hash, replayed: j.replayed_hash, error: j.error });
    return;
  }
  const bal = await payerBalance();
  if (bal < MIN_PAYER_BALANCE) { log(bot, "GLOBAL_STOP_low_balance", { balance_atomic: bal.toString() }); stopping = true; return; }
  if (spent(bot) + MAX_PER_PAYMENT > DAILY_BUDGET) { log(bot, "daily_budget_reached", { spent_atomic: spent(bot).toString() }); return; }
  const q = query(bot), k = 3 + Math.floor(Math.random() * 3);
  const t0 = Date.now();
  const r = await payFetch(`${base}/v1/recommend`, { method: "POST", headers: { "content-type": "application/json", "X-Bot-Id": bot, "ngrok-skip-browser-warning": "1" }, body: JSON.stringify({ query: q, k }) });
  const xpr = r.headers.get("x-payment-response");
  const pr = xpr ? decodeXPaymentResponse(xpr) : null;
  const body: any = await r.json().catch(() => ({}));
  if (pr?.success) addSpend(bot, 1000n); // server price; capped by selector at MAX_PER_PAYMENT
  if (r.status === 200) pastIds[bot].push(body.request_id);
  log(bot, r.status === 200 ? "paid_ok" : "paid_FAIL", { status: r.status, ms: Date.now() - t0, query: q, k, request_id: body.request_id, response_hash: body.response_hash,
    tx: pr?.transaction, top: body.response?.results?.slice(0, 3).map((x: any) => x.name), error: body.error });
}

async function loop(bot: string, initialDelay: number) {
  log(bot, "start", { base: baseUrl(), payer: account.address, daily_budget_atomic: DAILY_BUDGET.toString(), cap_atomic: MAX_PER_PAYMENT.toString() });
  await sleep(initialDelay);
  while (!stopping) {
    try { await step(bot); } catch (e: any) { log(bot, "error", { error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) }); }
    await sleep(MIN_MS + Math.random() * (MAX_MS - MIN_MS));
  }
  log(bot, "stopped");
}

// ---------------- Simulated advertisers: prepay via x402 (small, capped) and bid ----------------
const ADV_FILE = "logs/sim-advertisers.json";                 // holds advertiser API keys -> gitignored logs/
const ADV_CAP_TOTAL = BigInt(process.env.SIM_ADV_CAP_ATOMIC ?? "50000");   // max 0.05 USDC top-ups per advertiser (lifetime)
const ADV_TOPUP = 5000n;                                        // 0.005 USDC per top-up
const ADV_REFILL_GAP_MS = Number(process.env.SIM_ADV_REFILL_GAP_MS ?? 20 * 60_000); // leave depletion visible before refilling
const ADVS: Record<string, { name: string; listings: { name: string; description: string; kind: string; address: string }[]; bid: [number, number] }> = {
  "adv:sim-scout": { name: "Scout Data (simulated)", bid: [200, 1200], listings: [
    { name: "Scout x402 data search", kind: "x402", address: "https://scout.sim.example/v1/search", description: "Pay-per-call x402 search API over public datasets, knowledge graph data and agent service catalogues; JSON output; USDC on Base." } ] },
  "adv:sim-forge": { name: "Forge Dev Tools (simulated)", bid: [200, 1200], listings: [
    { name: "Forge MCP dev toolkit", kind: "mcp", address: "https://forge.sim.example/mcp", description: "Remote MCP server for coding agents: browser automation, GitHub issues and pull requests, git diff, local files." },
    { name: "Forge MCP docs search", kind: "mcp", address: "https://forge.sim.example/docs/mcp", description: "MCP server to search developer documentation and errors for coding agents." } ] },
};
const envVal = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(existsSync(".env") ? readFileSync(".env", "utf8") : "")?.[1]?.trim());
const LOCAL = process.env.SIM_LOCAL_URL ?? "http://127.0.0.1:8402";
const adminH = () => ({ "content-type": "application/json", authorization: "Basic " + Buffer.from(`${envVal("DASHBOARD_USER") || "admin"}:${envVal("DASHBOARD_PASSWORD") ?? ""}`).toString("base64") });
function loadAdv(): any { try { return JSON.parse(readFileSync(ADV_FILE, "utf8")); } catch { return {}; } }
async function ensureAdvertiser(id: string) {
  const st = loadAdv();
  if (st[id]?.api_key && st[id]?.listing_ids?.length) return st[id];
  const r = await fetch(`${LOCAL}/dashboard/api/admin/advertisers`, { method: "POST", headers: adminH(), body: JSON.stringify({ advertiser_id: id, name: ADVS[id].name }) });
  const j: any = await r.json();
  if (!j.api_key) throw new Error(`create advertiser ${id}: ${r.status} ${j.error}`);
  const listing_ids: string[] = [];
  for (const l of ADVS[id].listings) {
    const lr: any = await (await fetch(`${LOCAL}/v1/listings`, { method: "POST", headers: adminH(), body: JSON.stringify({ provider_id: id, ...l, tags: ["simulated"] }) })).json();
    listing_ids.push(lr.listing_id);
  }
  st[id] = { api_key: j.api_key, listing_ids, last_topup: 0 };
  writeFileSync(ADV_FILE, JSON.stringify(st, null, 1));
  return st[id];
}
async function advStep(id: string) {
  const a = await ensureAdvertiser(id);
  const B = { authorization: "Bearer " + a.api_key, "content-type": "application/json", "ngrok-skip-browser-warning": "1" };
  const me: any = await (await fetch(`${LOCAL}/v1/advertisers/me`, { headers: B })).json();
  // bid: random walk inside the persona's range
  const [lo, hi] = ADVS[id].bid;
  for (const lid of a.listing_ids) {
    const bid = lo + Math.floor(Math.random() * (hi - lo));
    await fetch(`${LOCAL}/v1/advertisers/me/listings/${lid}/bid`, { method: "PUT", headers: B, body: JSON.stringify({ bid_atomic: bid }) });
  }
  const bal = BigInt(me.balance), topped = BigInt(me.topups_onchain);
  const st = loadAdv(); const since = Date.now() - (st[id].last_topup ?? 0);
  if (bal < 2000n && topped + ADV_TOPUP <= ADV_CAP_TOTAL && since > ADV_REFILL_GAP_MS) {
    const payer = await payerBalance();
    if (payer < MIN_PAYER_BALANCE) { log(id, "GLOBAL_STOP_low_balance", {}); stopping = true; return; }
    const r = await payFetch(`${baseUrl()}/v1/advertisers/me/topup?amount_atomic=${ADV_TOPUP}`, { method: "POST", headers: { ...B, "X-Bot-Id": id } });
    const xpr = r.headers.get("x-payment-response"); const pr = xpr ? decodeXPaymentResponse(xpr) : null;
    const j: any = await r.json().catch(() => ({}));
    if (r.status === 200) { st[id].last_topup = Date.now(); writeFileSync(ADV_FILE, JSON.stringify(st, null, 1)); }
    log(id, r.status === 200 ? "topup_ok" : "topup_FAIL", { status: r.status, amount_atomic: ADV_TOPUP.toString(), tx: pr?.transaction ?? j.settle_tx, balance_atomic: j.balance_atomic, error: j.error });
  } else log(id, "advertiser_tick", { balance_atomic: bal.toString(), topped_onchain_atomic: topped.toString(), spend_atomic: me.spend, sponsored_impressions: Number(me.sponsored_impressions) });
}
async function advLoop(id: string, initialDelay: number) {
  log(id, "start", { cap_total_atomic: ADV_CAP_TOTAL.toString(), topup_atomic: ADV_TOPUP.toString() });
  await sleep(initialDelay);
  while (!stopping) {
    try { await advStep(id); } catch (e: any) { log(id, "error", { error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) }); }
    await sleep(120_000 + Math.random() * 120_000);
  }
  log(id, "stopped");
}

if (existsSync(PID)) { try { process.kill(Number(readFileSync(PID, "utf8")), 0); console.error("simulator already running"); process.exit(1); } catch {} }
writeFileSync(PID, String(process.pid));
const shutdown = () => { stopping = true; };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
Promise.all([loop("research-bot", 2_000), loop("dev-bot", 20_000), advLoop("adv:sim-scout", 5_000), advLoop("adv:sim-forge", 12_000)]).finally(() => { try { unlinkSync(PID); } catch {} process.exit(0); });
