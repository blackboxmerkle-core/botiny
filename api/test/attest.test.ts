import "./helpers/testdb";
// Click attestation queue against a local anvil chain (chain 31337) running the real ClickAttestation bytecode.
import { tosHashOf, DEFAULT_TOS } from "../src/tos";
const TOSH = tosHashOf(DEFAULT_TOS.bot);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
process.env.DASHBOARD_PASSWORD = "test-pass";
process.env.CS_CFG_minClickDelayMs = "0";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { settleIncentives, clawbackClick } from "../src/clicks";
import { attestTick, artifact, assertTestnet, campaignHash, clickHash, enqueue, SKALE_EUROPA_TESTNET } from "../src/attest";

const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
const H = { "content-type": "application/json", ...AUTH };
const DAY = 86_400_000;
const anvilBin = [process.env.ANVIL_BIN, join(homedir(), ".foundry", "bin", "anvil"), "/usr/local/bin/anvil"].find(p => p && existsSync(p));
const PORT = 18545 + Math.floor(Math.random() * 1000);
const RPC = `http://127.0.0.1:${PORT}`;
const bot = privateKeyToAccount(generatePrivateKey());
const chain = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
const pub = createPublicClient({ chain, transport: http(RPC) });
let anvil: ChildProcess | null = null; let base = ""; let server: any; let CONTRACT = ""; let key = ""; let key2 = "";
const ENV = () => ({ ...process.env, CLICK_ATTEST_CONTRACT: CONTRACT, ATTEST_PRIVATE_KEY: attesterKey, CLICK_ATTEST_RPC: RPC, CLICK_ATTEST_CHAIN_ID: "31337", CLICK_ATTEST_BACKOFF_MS: "0" });
let attesterKey = "";

before(async () => {
  if (!anvilBin) throw new Error("anvil not found (install Foundry: foundryup) or set ANVIL_BIN");
  anvil = spawn(anvilBin, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { await pub.getChainId(); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
  // fund a FRESH attester key on the local chain (no well-known keys in the repo)
  const pk = generatePrivateKey(); attesterKey = pk;
  const acct = privateKeyToAccount(pk);
  await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [acct.address, "0x56BC75E2D63100000"] }) });
  const wal = createWalletClient({ chain, account: acct, transport: http(RPC) });
  const { abi, bytecode } = artifact();
  const hash = await wal.deployContract({ abi, bytecode, args: [acct.address] });
  CONTRACT = (await pub.waitForTransactionReceipt({ hash })).contractAddress!.toLowerCase();
  (globalThis as any).ATT = acct;
  await resetTestDb(); server = createApp().listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server?.close(); await pool.end(); anvil?.kill(); });

const admin = (p: string, body: any) => fetch(base + "/dashboard/api/admin" + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async r => ({ status: r.status, ...(await r.json()) }));
let n = 0;
const rec = () => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH, "X-PAYMENT": `mock:a${Date.now()}${n++}:${bot.address}` },
  body: JSON.stringify({ query: "MCP server for browser automation", k: 8 }) }).then(r => r.json());
const BROWSER = { "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36", accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate", "accept-language": "en-GB" };
let ipn = 1;
const click = async (short_url: string, headers: Record<string, string> = BROWSER) => {
  const r = await fetch(`${base}/c/${short_url.split("/").pop()}`, { redirect: "manual", headers: { ...headers, "x-forwarded-for": `82.30.${ipn++}.9` } });
  const id = new URL(r.headers.get("location")!).searchParams.get("bs_click");
  for (let i = 0; i < 100; i++) { const row = (await pool.query("SELECT * FROM clicks WHERE click_id=$1", [id])).rows[0]; if (row) return row; await new Promise(r => setTimeout(r, 20)); }
  throw new Error("not scored");
};
const ev = async (click_id: string) => (await pool.query("SELECT * FROM click_attestation_events WHERE click_id=$1 ORDER BY id", [click_id])).rows;

test("testnet-only guard", () => {
  assert.doesNotThrow(() => assertTestnet(SKALE_EUROPA_TESTNET.id));
  assert.throws(() => assertTestnet(2046399126), /TESTNET-only/);   // SKALE Europa MAINNET
  assert.throws(() => assertTestnet(8453), /TESTNET-only/);
});

test("off unless env set", async () => { assert.deepEqual(await attestTick({} as any), { enabled: false }); });

let paid: any, filtered: any, R: any;
test("clicks are batched on chain with tx hash + log index; event fields match", async () => {
  const a = await admin("/advertisers", { advertiser_id: "adv:att", name: "Att" }); key = a.api_key;
  key2 = (await admin("/advertisers", { advertiser_id: "adv:other", name: "Other" })).api_key;
  for (const nm of ["one", "two"]) {
    const l = await (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:att", name: `Att browser automation MCP ${nm}`, description: "MCP server for browser automation", address: `https://att.example/${nm}`, kind: "mcp" }) })).json();
    await fetch(`${base}/v1/advertisers/me/listings/${l.listing_id}/incentive`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + key }, body: JSON.stringify({ show_atomic: 100, click_atomic: 150 }) });
  }
  await admin(`/advertisers/adv:att/credit`, { amount_atomic: 5000 });
  R = await rec();
  const mine = R.click_links.filter((c: any) => c.click_incentive_atomic > 0);
  assert.ok(mine.length >= 1);
  paid = await click(mine[0].short_url); assert.equal(paid.paid, true);
  filtered = await click(mine[0].short_url, { ...BROWSER, "user-agent": "Slackbot-LinkExpanding 1.0" }); assert.equal(filtered.class, "preview");
  const t = await attestTick(ENV() as any) as any;
  assert.equal(t.enabled, true); assert.equal(t.chain_id, 31337); assert.ok(t.confirmed >= 2, JSON.stringify(t));
  const [e] = await ev(paid.click_id);
  assert.equal(e.state, "confirmed"); assert.match(e.tx_hash, /^0x[0-9a-f]{64}$/); assert.ok(e.log_index >= 0); assert.equal(e.status, 1);
  // read the log back from chain and compare with what we stored
  const rc = await pub.getTransactionReceipt({ hash: e.tx_hash });
  const log = rc.logs.find(l => l.logIndex === e.log_index)!;
  const a1 = (await pool.query("SELECT * FROM click_attestations WHERE click_id=$1", [paid.click_id])).rows[0];
  assert.equal(log.address.toLowerCase(), CONTRACT);
  assert.equal(log.topics[0], keccak256(toBytes("Click(bytes32,bytes32,bytes32,uint8,uint16,uint64)")));
  assert.equal(log.topics[2], a1.click_hash); assert.equal(log.topics[3], a1.campaign_hash);
  assert.equal(a1.click_hash, clickHash(paid.end_user_key, paid.click_id));
  const salt = (await pool.query("SELECT salt FROM attest_salts WHERE advertiser_id='adv:att'")).rows[0].salt;
  assert.equal(a1.campaign_hash, campaignHash(salt, "adv:att", a1.listing_id));
  assert.ok(!JSON.stringify(a1).includes("82.30."), "no raw IP");
  const [f] = await ev(filtered.click_id); assert.equal(f.status, 2); assert.equal(f.reason, 1);
  // one tx for the batch
  assert.equal(new Set((await pool.query("SELECT tx_hash FROM click_attestation_events WHERE kind='click'")).rows.map(r => r.tx_hash)).size, 1);
});

test("idempotent: re-running sends nothing; crash after send is reconciled from the receipt", async () => {
  const t = await attestTick(ENV() as any) as any; assert.equal(t.sent, 0);
  // simulate a crash between send and confirm: mark confirmed rows back to 'sent'
  await pool.query("UPDATE click_attestation_events SET state='sent', log_index=NULL, block_number=NULL, sent_at=now() WHERE click_id=$1", [paid.click_id]);
  const t2 = await attestTick(ENV() as any) as any; assert.equal(t2.sent, 0); assert.ok(t2.confirmed >= 1);
  assert.equal((await ev(paid.click_id))[0].state, "confirmed");
  // simulate a lost/pending row whose event is already on chain: resend is a no-op on chain, resolved via getLogs
  await pool.query("UPDATE click_attestation_events SET state='pending', tx_hash=NULL, log_index=NULL WHERE click_id=$1", [paid.click_id]);
  const t3 = await attestTick(ENV() as any) as any; assert.equal(t3.confirmed, 1);
  const e = (await ev(paid.click_id))[0]; assert.equal(e.state, "confirmed"); assert.ok(e.log_index != null);
  const onchain = await pub.readContract({ address: CONTRACT as Hex, abi: artifact().abi, functionName: "clickCount" });
  assert.equal(Number(onchain), 2, "no duplicate Click events on chain");
});

test("status changes go out on vest and clawback", async () => {
  // vest: settle past the 14-day holdback
  await settleIncentives(Date.now() + 15 * DAY);
  await attestTick(ENV() as any);
  const es = await ev(paid.click_id);
  assert.equal(es.at(-1).kind, "status"); assert.equal(es.at(-1).status, 5); assert.equal(es.at(-1).state, "confirmed");
  // clawback on a new paid click
  const r2 = await rec(); const l2 = r2.click_links.find((c: any) => c.click_incentive_atomic > 0);
  const c2 = await click(l2.short_url); assert.equal(c2.paid, true);
  await attestTick(ENV() as any);
  await clawbackClick(c2.click_id, "provider_report");
  const t = await attestTick(ENV() as any) as any;
  const e2 = await ev(c2.click_id);
  assert.deepEqual(e2.map(e => [e.kind, e.status, e.state]), [["click", 1, "confirmed"], ["status", 4, "confirmed"]], JSON.stringify(t));
  const st = await pub.readContract({ address: CONTRACT as Hex, abi: artifact().abi, functionName: "statusOf", args: [(await pool.query("SELECT click_hash FROM click_attestations WHERE click_id=$1", [c2.click_id])).rows[0].click_hash] });
  assert.equal(Number(st), 4);
});

test("RPC failure: rows retry with backoff and are not lost", async () => {
  const r3 = await rec(); const c3 = await click(r3.click_links[0].short_url);
  await assert.rejects(attestTick({ ...ENV(), CLICK_ATTEST_RPC: "http://127.0.0.1:1" } as any));   // RPC down before send
  await enqueue(pool);
  // unauthorised attester -> tx reverts at estimate -> attempts++ and stays pending
  const t = await attestTick({ ...ENV(), ATTEST_PRIVATE_KEY: generatePrivateKey() } as any) as any;
  const e = (await ev(c3.click_id))[0];
  assert.equal(e.state, "pending"); assert.equal(e.attempts, 1); assert.ok(e.last_error); assert.equal(t.sent, 0);
  await attestTick(ENV() as any);
  assert.equal((await ev(c3.click_id))[0].state, "confirmed");
});

test("advertiser feed: own clicks only, salt, histogram data, CSV, dashboard page", async () => {
  const f = await (await fetch(base + "/v1/advertisers/me/attestations", { headers: { authorization: "Bearer " + key } })).json();
  assert.equal(f.advertiser_id, "adv:att"); assert.equal(typeof f.from_block, "string");
  assert.ok(f.clicks.length >= 4); assert.ok(f.salt.startsWith("0x"));
  assert.equal(f.uniqueness.distinct_click_hash, f.clicks.length);
  assert.ok(f.clicks.some((c: any) => c.status_name === "vested") && f.clicks.some((c: any) => c.status_name === "clawed") && f.clicks.some((c: any) => c.status_name === "filtered"));
  for (const l of f.listings) assert.equal(l.campaign_hash, campaignHash(f.salt, "adv:att", l.listing_id));
  const other = await (await fetch(base + "/v1/advertisers/me/attestations", { headers: { authorization: "Bearer " + key2 } })).json();
  assert.equal(other.clicks.length, 0); assert.notEqual(other.salt, f.salt);
  assert.equal((await fetch(base + "/v1/advertisers/me/attestations")).status, 401);
  const csv = await (await fetch(base + "/v1/advertisers/me/attestations?format=csv", { headers: { authorization: "Bearer " + key } })).text();
  assert.equal(csv.trim().split("\n").length, f.clicks.length + 1); assert.match(csv.split("\n")[0], /click_hash/);
  const page = await (await fetch(base + "/advertiser")).text();
  assert.match(page, /campaign salt/); assert.match(page, /Verify/);
});
