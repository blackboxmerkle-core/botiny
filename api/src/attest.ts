// Public per-click attestation feed: batches clicks onto the ClickAttestation contract on SKALE Europa
// TESTNET (gasless sFUEL). Off unless CLICK_ATTEST_CONTRACT and ATTEST_PRIVATE_KEY are set.
//
// Outbox design (idempotent, crash-safe):
//  1. discover  – new clicks on advertiser listings -> click_attestations (+ one 'click' event row)
//  2. diff      – current status (from clicks + incentive_ledger) vs last enqueued status -> 'status' event rows
//                 (covers hold / vest / clawback / review-cleared no matter which code path changed it)
//  3. reconcile – 'sent' rows: read receipt, record block_number + log_index; reverted/lost -> retry
//  4. send      – pending rows in batches (attestBatch / updateStatusBatch), backoff + max attempts
// The contract itself skips already-known clickHashes / unchanged statuses, so a resend after a crash
// can't create duplicate events; rows whose event came from an earlier tx are resolved via getLogs.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { keccak256, toBytes, createPublicClient, createWalletClient, http, decodeEventLog, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pool } from "./db";

export const SKALE_EUROPA_TESTNET = {
  id: 1_444_673_419, name: "SKALE Europa Testnet",
  rpc: "https://testnet.skalenodes.com/v1/juicy-low-small-testnet",
  explorer: "https://juicy-low-small-testnet.explorer.testnet.skalenodes.com",
};
/** Chains this code may write to. Mainnets (incl. SKALE Europa mainnet 2046399126) are refused. */
export const ALLOWED_CHAIN_IDS = new Set([SKALE_EUROPA_TESTNET.id, 31337 /* local anvil for tests */]);
export const BLOCKED_CHAIN_IDS = new Set([2046399126, 1, 8453]);

export const STATUS = { paid: 1, filtered: 2, held: 3, clawed: 4, vested: 5 } as const;
export const STATUS_NAME: Record<number, string> = { 1: "paid", 2: "filtered", 3: "held", 4: "clawed", 5: "vested" };
/** Reason codes (uint16 on chain). Published in the advertiser dashboard. */
export const REASONS: Record<string, number> = {
  none: 0, unfurler: 1, prefetch: 1, head: 1, range: 1, crawler_ua: 2, no_ua: 2, signed_agent: 2, headless: 3, datacenter_ip: 4,
  odd_accept: 5, missing_sec_fetch: 5, cf_bot_score: 5, too_fast_after_issue: 6, burst: 7, expired: 8, self_click: 9,
  token_already_paid: 10, user_listing_24h: 11, user_daily_cap: 12, set_click_cap: 13, bot_rate_review: 14, clawback: 15, other: 99,
};
export const REASON_NAME: Record<number, string> = { 0: "none", 1: "link preview / prefetch", 2: "crawler / declared bot", 3: "headless browser", 4: "data-centre IP",
  5: "non-browser headers", 6: "too fast after issue", 7: "click burst", 8: "link expired", 9: "self-click", 10: "duplicate (token already paid)",
  11: "duplicate (same visitor+listing 24h)", 12: "visitor daily cap", 13: "set click cap (2)", 14: "held: bot click-rate review", 15: "clawed back", 99: "other" };
export const reasonCode = (reasons: string[] | null | undefined) => { for (const r of reasons ?? []) if (r in REASONS) return REASONS[r]; return (reasons?.length ? REASONS.other : 0); };

export const linkHash = (code: string) => keccak256(toBytes(`botiny.link.v1|${code}`));
export const clickHash = (endUserKey: string, clickId: string) => keccak256(toBytes(`botiny.click.v1|${endUserKey}|${clickId}`));
export const campaignHash = (salt: string, adv: string, listing: string) => keccak256(toBytes(`botiny.campaign.v1|${salt}|${adv}|${listing}`));

const ART = join(__dirname, "..", "..", "contracts", "abi", "ClickAttestation.json");
let art: { abi: any[]; bytecode: Hex } | null = null;
export const artifact = () => (art ??= JSON.parse(readFileSync(ART, "utf8")));

export function attestConfig(env = process.env) {
  const contract = env.CLICK_ATTEST_CONTRACT ?? "";
  const enabled = /^0x[0-9a-fA-F]{40}$/.test(contract) && !!env.ATTEST_PRIVATE_KEY;
  return {
    enabled, contract: contract.toLowerCase(),
    chainId: Number(env.CLICK_ATTEST_CHAIN_ID ?? SKALE_EUROPA_TESTNET.id),
    rpc: env.CLICK_ATTEST_RPC ?? SKALE_EUROPA_TESTNET.rpc,
    publicRpc: env.CLICK_ATTEST_PUBLIC_RPC ?? SKALE_EUROPA_TESTNET.rpc,           // used by the advertiser's browser
    explorer: (env.CLICK_ATTEST_EXPLORER ?? SKALE_EUROPA_TESTNET.explorer).replace(/\/$/, ""),
    intervalMs: Number(env.CLICK_ATTEST_INTERVAL_MS ?? 15_000),
    batch: Math.max(1, Math.min(200, Number(env.CLICK_ATTEST_BATCH ?? 100))),
    maxAttempts: Number(env.CLICK_ATTEST_MAX_ATTEMPTS ?? 8),
    backoffMs: Number(env.CLICK_ATTEST_BACKOFF_MS ?? 30_000),
    sentTimeoutMs: Number(env.CLICK_ATTEST_SENT_TIMEOUT_MS ?? 120_000),
    fromBlock: BigInt(env.CLICK_ATTEST_FROM_BLOCK ?? 0),
  };
}
export type AttestConfig = ReturnType<typeof attestConfig>;

export function assertTestnet(chainId: number) {
  if (BLOCKED_CHAIN_IDS.has(chainId) || !ALLOWED_CHAIN_IDS.has(chainId)) throw new Error(`refusing chain ${chainId}: attestation is TESTNET-only (SKALE Europa testnet ${SKALE_EUROPA_TESTNET.id})`);
}

/** Per-advertiser salt (created on first use). */
export async function saltFor(db: { query: PoolClient["query"] }, adv: string) {
  await db.query("INSERT INTO attest_salts(advertiser_id,salt) VALUES ($1,$2) ON CONFLICT DO NOTHING", [adv, "0x" + randomBytes(16).toString("hex")]);
  return (await db.query("SELECT salt FROM attest_salts WHERE advertiser_id=$1", [adv])).rows[0].salt as string;
}

/** Status of a click right now, derived from the click row and its incentive_ledger events. */
const CURRENT_STATUS_SQL = `
  SELECT a.click_id, c.class, c.reasons, c.paid, c.clawed_back,
         (SELECT l.kind FROM incentive_ledger l WHERE l.click_id = a.click_id AND l.line = 'click' ORDER BY l.seq DESC LIMIT 1) AS click_kind,
         (SELECT l.kind FROM incentive_ledger l WHERE l.click_id = a.click_id ORDER BY l.seq DESC LIMIT 1) AS any_kind,
         (SELECT e.status FROM click_attestation_events e WHERE e.click_id = a.click_id ORDER BY e.id DESC LIMIT 1) AS last_status
    FROM click_attestations a JOIN clicks c USING (click_id)`;
export function deriveStatus(r: { class: string; reasons: string[]; paid: boolean; clawed_back: boolean; click_kind: string | null; any_kind: string | null }) {
  if (!r.paid) return { status: STATUS.filtered, reason: reasonCode(r.reasons) };
  if (r.clawed_back) return { status: STATUS.clawed, reason: REASONS.clawback };
  const k = r.click_kind ?? r.any_kind;
  if (k === "clawback") return { status: STATUS.clawed, reason: REASONS.clawback };
  if (k === "release" || k === "payout") return { status: STATUS.vested, reason: 0 };
  if (k === "review_hold") return { status: STATUS.held, reason: REASONS.bot_rate_review };
  return { status: STATUS.paid, reason: 0 };
}

/** Steps 1+2 (pure DB, no chain). Returns counts. */
export async function enqueue(db: { query: PoolClient["query"] }, limit = 1000) {
  const fresh = (await db.query(`
    SELECT c.click_id, c.end_user_key, c.at, h.provider_id, h.listing_id, h.token,
           (SELECT s.code FROM short_links s WHERE s.token = h.token ORDER BY s.code LIMIT 1) AS code
      FROM clicks c JOIN harvest_tokens h ON h.token = c.token JOIN advertisers a ON a.advertiser_id = h.provider_id
     WHERE NOT EXISTS (SELECT 1 FROM click_attestations x WHERE x.click_id = c.click_id)
     ORDER BY c.at, c.click_id LIMIT $1`, [limit])).rows;
  for (const r of fresh) {
    const salt = await saltFor(db, r.provider_id);
    await db.query(`INSERT INTO click_attestations(click_id,link_hash,click_hash,campaign_hash,advertiser_id,listing_id,clicked_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [r.click_id, linkHash(r.code ?? r.token), clickHash(r.end_user_key, r.click_id), campaignHash(salt, r.provider_id, r.listing_id), r.provider_id, r.listing_id, r.at]);
  }
  let added = 0, changed = 0;
  for (const r of (await db.query(`SELECT * FROM (${CURRENT_STATUS_SQL}) s WHERE s.last_status IS NULL OR s.last_status IN (1,3)`)).rows) {
    const d = deriveStatus(r);
    if (r.last_status == null) {
      const ins = await db.query(`INSERT INTO click_attestation_events(click_id,kind,status,reason,at) SELECT $1,'click',$2,$3,clicked_at FROM click_attestations WHERE click_id=$1
        ON CONFLICT (click_id) WHERE kind='click' DO NOTHING RETURNING id`, [r.click_id, d.status, d.reason]);
      added += ins.rows.length;
    } else if (Number(r.last_status) !== d.status) {
      await db.query(`INSERT INTO click_attestation_events(click_id,kind,status,reason,at) VALUES ($1,'status',$2,$3,now())`, [r.click_id, d.status, d.reason]);
      changed++;
    }
  }
  return { discovered: fresh.length, click_events: added, status_events: changed };
}

const secs = (d: Date | string) => BigInt(Math.floor(new Date(d).getTime() / 1000));

function clients(cfg: AttestConfig, env = process.env) {
  const account = privateKeyToAccount(env.ATTEST_PRIVATE_KEY as Hex);
  const chain = { id: cfg.chainId, name: "attest", nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } } as const;
  return { account, pub: createPublicClient({ chain, transport: http(cfg.rpc) }), wal: createWalletClient({ chain, account, transport: http(cfg.rpc) }) };
}

/** Find the log for each event row in a receipt (or, if the event was emitted by an earlier tx, via getLogs). */
async function resolveLogs(cfg: AttestConfig, pub: any, rows: any[], receipt: any) {
  const { abi } = artifact();
  const found = new Map<number, { block: bigint; logIndex: number; tx: string }>();
  const dec = (receipt?.logs ?? []).filter((l: any) => l.address.toLowerCase() === cfg.contract).map((l: any) => {
    try { return { l, e: decodeEventLog({ abi, data: l.data, topics: l.topics }) as any }; } catch { return null; } }).filter(Boolean);
  for (const r of rows) {
    const want = r.kind === "click" ? "Click" : "StatusUpdate";
    const hit = dec.find((d: any) => d.e.eventName === want && d.e.args.clickHash.toLowerCase() === r.click_hash && Number(d.e.args.status) === r.status);
    if (hit) { found.set(Number(r.id), { block: hit.l.blockNumber, logIndex: hit.l.logIndex, tx: hit.l.transactionHash }); continue; }
    const ev = abi.find((x: any) => x.type === "event" && x.name === want);
    const logs = await pub.getLogs({ address: cfg.contract, event: ev, args: { clickHash: r.click_hash }, fromBlock: cfg.fromBlock, toBlock: "latest" });
    const m = logs.find((l: any) => Number(l.args.status) === r.status);
    if (m) found.set(Number(r.id), { block: m.blockNumber, logIndex: m.logIndex, tx: m.transactionHash });
  }
  return found;
}

let ticking = false;
/** One attestation pass. Safe to call concurrently (advisory lock) and repeatedly (idempotent). */
export async function attestTick(env = process.env) {
  const cfg = attestConfig(env);
  if (!cfg.enabled) return { enabled: false };
  if (ticking) return { enabled: true, skipped: "busy" };
  ticking = true;
  const lockC = await pool.connect();
  try {
    if (!(await lockC.query("SELECT pg_try_advisory_lock(424245) AS ok")).rows[0].ok) return { enabled: true, skipped: "locked" };
    try {
      const { pub, wal, account } = clients(cfg, env);
      const chainId = await pub.getChainId();
      assertTestnet(chainId);
      if (chainId !== cfg.chainId) throw new Error(`RPC chain ${chainId} != configured ${cfg.chainId}`);
      const q = await enqueue(pool);
      const { abi } = artifact();
      let sent = 0, confirmed = 0, failed = 0;
      const rowsSql = `SELECT e.*, a.link_hash, a.click_hash, a.campaign_hash FROM click_attestation_events e JOIN click_attestations a USING (click_id)`;
      const finish = async (rows: any[], receipt: any) => {
        const f = await resolveLogs(cfg, pub, rows, receipt);
        for (const r of rows) {
          const hit = f.get(Number(r.id));
          if (hit) { await pool.query(`UPDATE click_attestation_events SET state='confirmed', tx_hash=$2, block_number=$3, log_index=$4, chain_id=$5, contract=$6, confirmed_at=now(), last_error=NULL WHERE id=$1`,
            [r.id, hit.tx, hit.block.toString(), hit.logIndex, chainId, cfg.contract]); confirmed++; }
          else await retry(r, "event not found after tx");
        }
      };
      const retry = async (r: any, err: string) => {
        const att = Number(r.attempts) + 1; const dead = att >= cfg.maxAttempts;
        if (dead) failed++;
        await pool.query(`UPDATE click_attestation_events SET state=$2, attempts=$3, last_error=$4, next_attempt_at=now() + make_interval(secs => $5::float8/1000) WHERE id=$1`,
          [r.id, dead ? "failed" : "pending", att, err.slice(0, 500), cfg.backoffMs * 2 ** Math.min(att - 1, 6)]);
      };
      // 3. reconcile rows left 'sent' (crash / timeout)
      const stale = (await pool.query(rowsSql + ` WHERE e.state='sent' ORDER BY e.id`)).rows;
      for (const tx of [...new Set(stale.map(r => r.tx_hash))]) {
        const rows = stale.filter(r => r.tx_hash === tx);
        const rc = await pub.getTransactionReceipt({ hash: tx }).catch(() => null);
        if (rc?.status === "success") await finish(rows, rc);
        else if (rc || Date.now() - new Date(rows[0].sent_at).getTime() > cfg.sentTimeoutMs) for (const r of rows) await retry(r, rc ? "tx reverted" : "tx not mined in time");
      }
      // 4. send pending: first-status Click events, then StatusUpdates for clicks already confirmed on chain
      for (const kind of ["click", "status"] as const) {
        const rows = (await pool.query(rowsSql + ` WHERE e.state='pending' AND e.kind=$1 AND e.next_attempt_at <= now()
            ${kind === "status" ? "AND EXISTS (SELECT 1 FROM click_attestation_events c WHERE c.click_id=e.click_id AND c.kind='click' AND c.state='confirmed') AND NOT EXISTS (SELECT 1 FROM click_attestation_events p WHERE p.click_id=e.click_id AND p.id<e.id AND p.state IN ('pending','sent'))" : ""}
            ORDER BY e.id LIMIT $2`, [kind, cfg.batch])).rows;
        // one status change per click per tx (keeps on-chain order = DB order)
        const batch = kind === "status" ? rows.filter((r, i) => rows.findIndex(x => x.click_id === r.click_id) === i) : rows;
        if (!batch.length) continue;
        try {
          const args = kind === "click"
            ? [batch.map(r => ({ linkHash: r.link_hash, clickHash: r.click_hash, campaignHash: r.campaign_hash, status: r.status, reason: r.reason, at: secs(r.at) }))]
            : [batch.map(r => ({ clickHash: r.click_hash, campaignHash: r.campaign_hash, status: r.status, reason: r.reason, at: secs(r.at) }))];
          const hash = await wal.writeContract({ address: cfg.contract as Hex, abi, functionName: kind === "click" ? "attestBatch" : "updateStatusBatch", args, account, chain: wal.chain });
          await pool.query(`UPDATE click_attestation_events SET state='sent', tx_hash=$2, sent_at=now() WHERE id = ANY($1)`, [batch.map(r => r.id), hash]);
          sent += batch.length;
          const rc = await pub.waitForTransactionReceipt({ hash, timeout: cfg.sentTimeoutMs });
          if (rc.status !== "success") { for (const r of batch) await retry(r, "tx reverted"); continue; }
          await finish(batch.map(r => ({ ...r, tx_hash: hash })), rc);
        } catch (e: any) {
          const msg = String(e?.shortMessage ?? e?.message ?? e);
          for (const r of batch) {
            const st = (await pool.query("SELECT state FROM click_attestation_events WHERE id=$1", [r.id])).rows[0].state;
            if (st === "pending") await retry(r, msg);   // 'sent' rows are reconciled next tick
          }
        }
      }
      return { enabled: true, chain_id: chainId, attester: account.address, ...q, sent, confirmed, failed };
    } finally { await lockC.query("SELECT pg_advisory_unlock(424245)"); }
  } finally { lockC.release(); ticking = false; }
}

let timer: NodeJS.Timeout | null = null;
/** Background loop; off unless CLICK_ATTEST_CONTRACT + ATTEST_PRIVATE_KEY are set. */
export function startAttestationLoop() {
  const cfg = attestConfig();
  if (!cfg.enabled || timer) return false;
  timer = setInterval(() => { attestTick().catch(e => console.error("attest", e?.shortMessage ?? e?.message)); }, cfg.intervalMs); timer.unref();
  return true;
}

/** Advertiser feed: their clicks with on-chain status. */
export async function advertiserFeed(adv: string, limit = 5000) {
  const cfg = attestConfig();
  const salt = await saltFor(pool, adv);
  const listings = (await pool.query("SELECT listing_id, name FROM listings WHERE provider_id=$1 ORDER BY seq", [adv])).rows
    .map(l => ({ ...l, campaign_hash: campaignHash(salt, adv, l.listing_id) }));
  // Off-by-default must be inert: with attestation disabled the feed is read-only (no outbox writes, no global scan).
  if (cfg.enabled) await enqueue(pool);
  const rows = (await pool.query(`
    SELECT a.click_id, a.clicked_at, a.listing_id, a.link_hash, a.click_hash, a.campaign_hash,
           le.status, le.reason, le.state, le.tx_hash, le.block_number::text, le.log_index, le.kind,
           ce.state AS click_state, ce.tx_hash AS click_tx, ce.log_index AS click_log_index, ce.block_number::text AS click_block, ce.status AS click_status, ce.reason AS click_reason
      FROM click_attestations a
      JOIN LATERAL (SELECT * FROM click_attestation_events e WHERE e.click_id=a.click_id ORDER BY e.id DESC LIMIT 1) le ON true
      JOIN click_attestation_events ce ON ce.click_id=a.click_id AND ce.kind='click'
     WHERE a.advertiser_id=$1 ORDER BY a.clicked_at DESC LIMIT $2`, [adv, limit])).rows
    .map(r => ({ ...r, status_name: STATUS_NAME[r.status], reason_name: REASON_NAME[r.reason] ?? String(r.reason),
      tx_url: r.tx_hash ? `${cfg.explorer}/tx/${r.tx_hash}` : null, click_tx_url: r.click_tx ? `${cfg.explorer}/tx/${r.click_tx}` : null }));
  const uniq = (k: string) => new Set(rows.map((r: any) => r[k])).size;
  return {
    advertiser_id: adv, chain: { id: cfg.chainId, name: SKALE_EUROPA_TESTNET.name, public_rpc: cfg.publicRpc, explorer: cfg.explorer },
    contract: cfg.contract || null, attestation_enabled: cfg.enabled, from_block: cfg.fromBlock.toString(),
    topics: { Click: keccak256(toBytes("Click(bytes32,bytes32,bytes32,uint8,uint16,uint64)")), StatusUpdate: keccak256(toBytes("StatusUpdate(bytes32,bytes32,uint8,uint16,uint64)")) },
    salt, campaign_formula: 'keccak256(utf8("botiny.campaign.v1|" + salt + "|" + advertiser_id + "|" + listing_id))',
    listings, statuses: STATUS_NAME, reasons: REASON_NAME,
    uniqueness: { events: rows.length, distinct_click_hash: uniq("click_hash"), distinct_link_hash: uniq("link_hash"),
      by_status: Object.fromEntries(Object.values(STATUS).map(s => [STATUS_NAME[s], rows.filter((r: any) => r.status === s).length])) },
    clicks: rows,
  };
}
export function feedCsv(f: Awaited<ReturnType<typeof advertiserFeed>>) {
  const cols = ["clicked_at", "listing_id", "status_name", "reason_name", "status", "reason", "state", "click_hash", "link_hash", "campaign_hash", "click_tx", "click_log_index", "click_block", "tx_hash", "log_index", "block_number"];
  const esc = (v: any) => { const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...f.clicks.map((r: any) => cols.map(c => esc(r[c])).join(","))].join("\n") + "\n";
}
