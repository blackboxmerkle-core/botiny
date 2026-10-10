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
  appendFileSync(`logs/sim-${bot}.log`, JSON.stringify({ at: new Date().toISOString(), bot, ev, ...data }) + "\n");

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

if (existsSync(PID)) { try { process.kill(Number(readFileSync(PID, "utf8")), 0); console.error("simulator already running"); process.exit(1); } catch {} }
writeFileSync(PID, String(process.pid));
const shutdown = () => { stopping = true; };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
Promise.all([loop("research-bot", 2_000), loop("dev-bot", 20_000)]).finally(() => { try { unlinkSync(PID); } catch {} process.exit(0); });
