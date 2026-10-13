// Legacy settle_failed rows (no stored nonce/chain): look for EIP-3009 AuthorizationUsed events by the same payer on Base Sepolia
// in the rows' time window, and check every such event's tx is one we already recorded as settled. Read-only.
import { pool } from "../src/db";
import { createPublicClient, http, parseAbiItem } from "viem";
(async () => {
  const { configuredChains } = await import("../src/chains");
  const c = configuredChains().find(x => x.key === "base-sepolia")!;
  const pc = createPublicClient({ transport: http(c.rpc, { timeout: 20000 }) });
  const leg = (await pool.query(`SELECT request_id, payer, received_at FROM requests WHERE payment_status='settle_failed' AND payment_chain_id IS NULL ORDER BY received_at`)).rows;
  const payers = [...new Set(leg.map(r => r.payer.toLowerCase()))];
  const t0 = Math.floor(new Date(leg[0].received_at).getTime() / 1000) - 600, t1 = Math.floor(new Date(leg.at(-1).received_at).getTime() / 1000) + 3600;
  const head = await pc.getBlock();
  const blockAt = async (t: number) => { let lo = 46500001n, hi = head.number; while (lo < hi) { const mid = (lo + hi) / 2n; const b = await pc.getBlock({ blockNumber: mid }); if (Number(b.timestamp) < t) lo = mid + 1n; else hi = mid; } return lo; };
  const b0 = await blockAt(t0), b1 = await blockAt(t1);
  const ev = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
  const logs: any[] = [];
  for (const p of payers) for (let f = b0; f <= b1; f += 200n) {
    const to = f + 199n > b1 ? b1 : f + 199n;
    logs.push(...await pc.getLogs({ address: c.usdc, event: ev, args: { authorizer: p as `0x${string}` }, fromBlock: f, toBlock: to }));
  }
  const known = new Set((await pool.query("SELECT lower(settle_tx) t FROM requests WHERE settle_tx IS NOT NULL UNION SELECT lower(payment_ref) FROM balance_ledger WHERE payment_ref IS NOT NULL")).rows.map(r => r.t));
  const ledgerTx = new Set((await pool.query("SELECT lower(settle_tx) t FROM balance_ledger WHERE settle_tx IS NOT NULL")).rows.map(r => r.t));
  const unexplained = logs.filter(l => !known.has(l.transactionHash.toLowerCase()) && !ledgerTx.has(l.transactionHash.toLowerCase()));
  console.log(JSON.stringify({ legacy_rows: leg.length, payers: payers.length, blocks: [String(b0), String(b1)], authorization_used_events: logs.length,
    unexplained: unexplained.map(l => ({ tx: l.transactionHash, block: String(l.blockNumber), nonce: l.args.nonce })) }, null, 1));
  await pool.end();
})();
