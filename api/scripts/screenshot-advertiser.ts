// Renders docs/screenshots/advertiser-click-feed.png from DEMO data in botrec_test + a local anvil chain.
//   DATABASE_URL=postgres://bot:bot@localhost:5432/botrec_test PAYMENT_MODE=mock npx tsx scripts/screenshot-advertiser.ts
import "../test/helpers/testdb";
import { spawn } from "node:child_process";
import { join } from "node:path"; import { homedir } from "node:os";
import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
process.env.CS_CFG_minClickDelayMs = "0"; process.env.CS_CFG_maxPaidClicksPerSet = "10"; process.env.DASHBOARD_PASSWORD ??= "demo";
const PORT = 18650, RPC = `http://127.0.0.1:${PORT}`;
(async () => {
  const anvil = spawn(join(homedir(), ".foundry/bin/anvil"), ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  const chain = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
  const pub = createPublicClient({ chain, transport: http(RPC) });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  const pk = generatePrivateKey(); const acct = privateKeyToAccount(pk);
  await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [acct.address, "0x56BC75E2D63100000"] }) });
  const { artifact, attestTick } = await import("../src/attest");
  const wal = createWalletClient({ chain, account: acct, transport: http(RPC) });
  const h = await wal.deployContract({ abi: artifact().abi, bytecode: artifact().bytecode, args: [acct.address] });
  const contract = (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
  Object.assign(process.env, { CLICK_ATTEST_CONTRACT: contract, ATTEST_PRIVATE_KEY: pk, CLICK_ATTEST_RPC: RPC, CLICK_ATTEST_PUBLIC_RPC: RPC, CLICK_ATTEST_CHAIN_ID: "31337" });
  const { resetTestDb } = await import("../src/seed"); const { pool } = await import("../src/db"); const { createApp } = await import("../src/app");
  const { settleIncentives, clawbackClick } = await import("../src/clicks"); const { tosHashOf, DEFAULT_TOS } = await import("../src/tos");
  await resetTestDb(); const srv = createApp().listen(8499); const base = "http://127.0.0.1:8499";
  const AUTH = { authorization: "Basic " + Buffer.from("admin:" + process.env.DASHBOARD_PASSWORD).toString("base64"), "content-type": "application/json" };
  const key = (await (await fetch(base + "/dashboard/api/admin/advertisers", { method: "POST", headers: AUTH, body: JSON.stringify({ advertiser_id: "adv:demo", name: "Demo Browser Co" }) })).json()).api_key;
  for (const nm of ["Pro", "Lite"]) {
    const l = await (await fetch(base + "/v1/listings", { method: "POST", headers: AUTH, body: JSON.stringify({ provider_id: "adv:demo", name: `Demo browser automation MCP ${nm}`, description: "MCP server for browser automation", address: `https://demo.example/${nm}`, kind: "mcp" }) })).json();
    await fetch(`${base}/v1/advertisers/me/listings/${l.listing_id}/incentive`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ show_atomic: 50, click_atomic: 100 }) });
  }
  await fetch(base + "/dashboard/api/admin/advertisers/adv:demo/credit", { method: "POST", headers: AUTH, body: JSON.stringify({ amount_atomic: 100000 }) });
  const bot = privateKeyToAccount(generatePrivateKey()); const UA = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
  let ip = 1; const ids: string[] = [];
  for (let i = 0; i < 18; i++) {
    const r = await (await fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": tosHashOf(DEFAULT_TOS.bot), "X-PAYMENT": `mock:d${i}${Date.now()}:${bot.address}` }, body: JSON.stringify({ query: "MCP server for browser automation", k: 8 }) })).json();
    for (const l of r.click_links.filter((c: any) => c.click_incentive_atomic > 0)) {
      const ua = i % 6 === 5 ? "Slackbot-LinkExpanding 1.0" : i % 7 === 3 ? "Mozilla/5.0 HeadlessChrome/120" : UA;
      const res = await fetch(`${base}/c/${l.short_url.split("/").pop()}`, { redirect: "manual", headers: { "user-agent": ua, accept: "text/html", "sec-fetch-mode": "navigate", "accept-language": "en-GB", "x-forwarded-for": `82.40.${ip++}.7` } });
      ids.push(new URL(res.headers.get("location")!).searchParams.get("bs_click")!);
    }
  }
  await new Promise(r => setTimeout(r, 1500));
  // DEMO ONLY: spread click times over the last 3 weeks so the histograms have shape
  await pool.query(`UPDATE clicks SET at = now() - (random()*21) * interval '1 day' - ((random()*random())*10 + 9) * interval '1 hour'`);
  await attestTick();
  await settleIncentives(Date.now());
  const paid = (await pool.query("SELECT click_id FROM clicks WHERE paid ORDER BY at LIMIT 2")).rows;
  await clawbackClick(paid[0].click_id, "provider_report");
  await pool.query("UPDATE incentive_ledger SET release_after = now() - interval '1 minute' WHERE kind='accrue_held' AND click_id IN (SELECT click_id FROM clicks WHERE paid ORDER BY at LIMIT 8)");
  await settleIncentives(Date.now()); await attestTick(); await attestTick();
  const b = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  await p.goto(base + "/advertiser"); await p.fill("#key", key); await p.click("header button"); await p.waitForSelector("#rows tr");
  await p.click("text=Verify visible (on chain)"); await p.waitForTimeout(3000);
  await p.click("text=Scan chain for my Click events"); await p.waitForTimeout(1000);
  await p.screenshot({ path: join(__dirname, "../../docs/screenshots/advertiser-click-feed.png"), fullPage: true });
  await b.close(); srv.close(); await pool.end(); anvil.kill(); console.log("ok");
})().catch(e => { console.error(e); process.exit(1); });
