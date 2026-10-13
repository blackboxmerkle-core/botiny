// Round 4 spot-check: classify every historical settle_failed row under the current rules; for non-definite ones read
// EIP-3009 authorizationState(from, nonce) on-chain. Read-only.
import { pool } from "../src/db";
import { isAmbiguousSettleError } from "../src/facilitator";
(async () => {
const rows = (await pool.query(`SELECT r.request_id, r.settle_via, r.settle_error, r.settle_tx, r.payer, r.payment_chain_id, r.billing_status, n.nonce
  FROM requests r LEFT JOIN payment_nonces n ON n.payment_ref=r.payment_ref WHERE r.payment_status='settle_failed' ORDER BY r.received_at`)).rows;
const { configuredChains } = await import("../src/chains"); const { rpcFor } = await import("../src/facilitator");
const cat = (e: string) => (e ?? "").replace(/^fallback facilitator: /, "").split("\n")[0].slice(0, 60) || "(empty)";
const out: Record<string, any> = {}; const used: string[] = [];
for (const r of rows) {
  const src = r.settle_via === "facilitator-fallback" ? "facilitator" : "self";
  const msg = String(r.settle_error ?? "").replace(/^fallback facilitator: /, "");
  const amb = isAmbiguousSettleError(msg, r.settle_tx && !String(r.settle_tx).startsWith("reconciled") ? r.settle_tx : null, src);
  const k = `${src} | ${cat(r.settle_error)} | ${amb ? "AMBIGUOUS" : "definite"}`;
  out[k] ??= { n: 0, onchain_used: 0, onchain_unused: 0, unknown: 0 }; out[k].n++;
  let st: boolean | null = null;
  const c = configuredChains().find(x => x.chainId === Number(r.payment_chain_id));
  if (c && r.nonce && r.payer) st = await rpcFor(c).authorizationState(r.payer, r.nonce).catch(() => null);
  if (st === true) { out[k].onchain_used++; used.push(r.request_id); } else if (st === false) out[k].onchain_unused++; else out[k].unknown++;
}
console.log(JSON.stringify({ total: rows.length, categories: out, used }, null, 1));
await pool.end();

})();
