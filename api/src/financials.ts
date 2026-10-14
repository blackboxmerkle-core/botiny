import express from "express";
import { pool } from "./db";
import { chainView } from "./chain";
import { gasStatus, relayerAddress, fallbackOn } from "./relayer";
import { MODE } from "./payment";
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

// Unified ledger. All amounts in USDC atomic units (6dp). Testnet only.
const LEDGER = `
  SELECT r.received_at AS at, 'bot_query_payment' AS type, r.payment_status AS status, r.payment_mode AS mode,
         r.payer AS counterparty, r.payment_amount_atomic AS amount_atomic, r.request_id, r.settle_tx, NULL::text AS listing_id,
         NULL::int AS rank, NULL::text AS kind, r.bot_id, r.payment_network AS network, r.settle_via, r.tos_version
    FROM requests r WHERE r.payment_method='per_query'   -- credit-debited queries are prepaid: the cash is the bot_credit_topup row
  UNION ALL
  SELECT c.created_at, CASE c.kind WHEN 'topup_x402' THEN 'bot_credit_topup' ELSE 'bot_credit_admin' END, CASE c.kind WHEN 'topup_x402' THEN 'settled' ELSE 'credited' END,
         CASE c.kind WHEN 'topup_x402' THEN COALESCE(NULLIF(c.note,''),'x402') ELSE 'offchain' END, c.wallet, c.delta_atomic, NULL, c.settle_tx, NULL, NULL, NULL, NULL,
         c.payment_network, c.settle_via, c.tos_version
    FROM search_credit_ledger c WHERE c.kind IN ('topup_x402','admin_credit')
  UNION ALL
  SELECT f.created_at, 'data_feed_purchase', 'settled', CASE WHEN f.settle_via='mock' THEN 'mock' ELSE 'x402' END, f.wallet, f.price_atomic, NULL, f.settle_tx, NULL, NULL, f.tier, NULL, f.payment_network, f.settle_via, f.tos_version
    FROM feed_periods f WHERE f.kind='purchase_x402'
  UNION ALL
  SELECT b.created_at, CASE b.kind WHEN 'topup_x402' THEN 'advertiser_topup' ELSE 'advertiser_admin_credit' END,
         CASE b.kind WHEN 'topup_x402' THEN 'settled' ELSE 'credited' END,
         CASE b.kind WHEN 'topup_x402' THEN COALESCE(NULLIF(b.note,''),'x402') ELSE 'offchain' END,
         b.advertiser_id, b.delta_atomic, NULL, b.settle_tx, NULL, NULL, NULL, NULL,
         CASE WHEN b.kind='topup_x402' THEN COALESCE(b.payment_network, CASE WHEN b.note='mock' THEN 'mock' ELSE 'base-sepolia' END) END, b.settle_via, b.tos_version
    FROM balance_ledger b WHERE b.kind IN ('topup_x402','admin_credit')
  UNION ALL
  SELECT b.created_at, 'advertiser_impression_charge', 'consumed', 'offchain', b.advertiser_id, -b.delta_atomic, b.request_id, NULL,
         b.listing_id, i.rank, l.kind, rq.bot_id, NULL, NULL, NULL
    FROM balance_ledger b JOIN listings l USING (listing_id) JOIN requests rq USING (request_id)
    LEFT JOIN impressions i ON i.request_id=b.request_id AND i.listing_id=b.listing_id
   WHERE b.kind='impression_debit'`;

function filters(qs: any) {
  const w: string[] = [], p: any[] = [];
  if (qs.from) { p.push(qs.from); w.push(`at >= $${p.length}::date`); }
  if (qs.to) { p.push(qs.to); w.push(`at < $${p.length}::date + 1`); }
  if (qs.type) { p.push(qs.type); w.push(`type = $${p.length}`); }
  if (qs.status) { p.push(qs.status); w.push(`status = $${p.length}`); }
  if (qs.bot) { if (qs.bot === "(none)") w.push("bot_id IS NULL"); else { p.push(qs.bot); w.push(`bot_id = $${p.length}`); } }
  if (qs.network) { p.push(qs.network); w.push(`network = $${p.length}`); }
  if (qs.mode) { p.push(qs.mode); w.push(`mode = $${p.length}`); }
  return { where: w.length ? "WHERE " + w.join(" AND ") : "", params: p };
}
async function ledger(qs: any, limit = 1000) {
  const { where, params } = filters(qs);
  return q(`SELECT * FROM (${LEDGER}) x ${where} ORDER BY at DESC LIMIT ${limit}`, params);
}

export function financialsRouter() {
  const r = express.Router();
  r.get("/api/financials", async (req, res) => {
    const settled = await q(`SELECT settle_tx AS tx, payment_network AS network FROM requests WHERE payment_mode='x402' AND payment_status='settled' AND settle_tx IS NOT NULL
      UNION SELECT settle_tx, COALESCE(payment_network,'base-sepolia') FROM balance_ledger WHERE kind='topup_x402' AND note='x402' AND settle_tx IS NOT NULL
      UNION SELECT settle_tx, payment_network FROM search_credit_ledger WHERE kind='topup_x402' AND note='x402' AND settle_tx IS NOT NULL
      UNION SELECT settle_tx, payment_network FROM feed_periods WHERE kind='purchase_x402' AND settle_via<>'mock' AND settle_tx IS NOT NULL AND settle_tx<>'mock'`);
    const chain = await chainView(settled);
    const rows = await ledger(req.query);
    for (const x of rows) {
      x.amount_atomic = String(x.amount_atomic);
      x.onchain = x.type === "advertiser_impression_charge" ? "n/a (debit of prepaid balance)" : x.type === "advertiser_admin_credit" ? "n/a (manual credit, no funds moved)"
        : x.mode === "mock" ? "n/a (mock)" : x.settle_tx ? (chain.receipts[x.settle_tx] ?? "unknown") : "none";
    }
    const bot = typeof req.query.bot === "string" && req.query.bot ? req.query.bot : null;
    const bc = bot === "(none)" ? " AND bot_id IS NULL" : bot ? ` AND bot_id = '${bot.replace(/[^A-Za-z0-9._:-]/g, "")}'` : "";
    // Totals: London calendar day for "today".
    const win = (cond: string) => q(`SELECT
        count(*) FILTER (WHERE type='bot_query_payment')::int AS paid_queries,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment'),0)::text AS query_gross,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND status='settled'),0)::text AS query_settled,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND status='verified'),0)::text AS query_pending,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND status='settle_failed'),0)::text AS query_failed,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND mode='x402' AND status='settled'),0)::text AS query_settled_onchain,
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_impression_charge'),0)::text AS ad_fees,
        count(*) FILTER (WHERE type='advertiser_impression_charge')::int AS charged_impressions,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_credit_topup' AND status='settled'),0)::text AS credit_topups_settled,
        coalesce(sum(amount_atomic) FILTER (WHERE type='data_feed_purchase'),0)::text AS feed_purchases,
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_topup' AND mode='x402'),0)::text AS topups_onchain,
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_topup' AND mode<>'x402'),0)::text AS topups_mock,
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_admin_credit'),0)::text AS admin_credits
      FROM (${LEDGER}) x WHERE ${cond}${bc}`).then(r => {
        const t = r[0]; t.total_revenue = String(BigInt(t.query_settled) + BigInt(t.ad_fees)); t.avg_per_query = t.paid_queries ? String(Math.round(Number(t.query_gross) / t.paid_queries)) : "0"; return t; });
    const totals = {
      today: await win(`(at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date`),
      d7: await win(`at > now() - interval '7 days'`), all: await win("true"),
    };
    const liab = (await q(`SELECT COALESCE(SUM(delta_atomic),0)::text total,
        COALESCE(SUM(delta_atomic) FILTER (WHERE kind='topup_x402' AND note='x402'),0)::text funded_onchain FROM balance_ledger`))[0];
    const liability = { outstanding_prepaid_atomic: liab.total, ever_topped_up_onchain_atomic: liab.funded_onchain,
      per_advertiser: await q(`SELECT advertiser_id AS key, SUM(delta_atomic)::text AS atomic FROM balance_ledger GROUP BY 1 ORDER BY SUM(delta_atomic) DESC`) };
    const series = await q(`SELECT to_char(date_trunc('hour', at AT TIME ZONE 'Europe/London'),'YYYY-MM-DD HH24:00') AS bucket,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND status='settled'),0)::text AS settled,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND status<>'settled'),0)::text AS unsettled,
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_impression_charge'),0)::text AS ad_accrued,
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_topup'),0)::text AS topups
      FROM (${LEDGER}) x WHERE at > now() - interval '7 days'${bc} GROUP BY 1 ORDER BY 1`);
    const distributions = {
      by_provider: await q(`SELECT provider_id AS key, count(*)::int AS impressions, sum(charge_micro_usdc)::text AS atomic FROM impressions WHERE sponsored GROUP BY 1 ORDER BY sum(charge_micro_usdc) DESC, 2 DESC LIMIT 20`),
      sponsored_vs_organic: await q(`SELECT CASE WHEN sponsored THEN 'sponsored' ELSE 'organic' END AS key, count(*)::int AS impressions, sum(charge_micro_usdc)::text AS atomic FROM impressions GROUP BY 1 ORDER BY 1`),
      by_kind: await q(`SELECT l.kind AS key, count(*)::int AS impressions, sum(i.charge_micro_usdc)::text AS atomic FROM impressions i JOIN listings l USING (listing_id) GROUP BY 1 ORDER BY 2 DESC`),
      by_chain: await q(`SELECT coalesce(network,'(none)') AS key, count(*)::int AS payments,
          count(*) FILTER (WHERE status='settled')::int AS settled, count(*) FILTER (WHERE status='settle_failed')::int AS failed,
          coalesce(sum(amount_atomic) FILTER (WHERE status='settled'),0)::text AS atomic,
          count(*) FILTER (WHERE settle_via='facilitator-fallback')::int AS via_fallback, count(*) FILTER (WHERE settle_via='self')::int AS via_self
        FROM (${LEDGER}) x WHERE type IN ('bot_query_payment','advertiser_topup') GROUP BY 1 ORDER BY sum(amount_atomic) FILTER (WHERE status='settled') DESC NULLS LAST`),
      by_payer: await q(`SELECT payer AS key, payment_mode AS mode, count(*)::int AS queries, sum(payment_amount_atomic)::text AS atomic FROM requests GROUP BY 1,2 ORDER BY sum(payment_amount_atomic) DESC LIMIT 20`),
      by_bot: await q(`SELECT coalesce(bot_id,'(none)') AS key, count(*)::int AS queries, sum(payment_amount_atomic)::text AS atomic,
          count(*) FILTER (WHERE payment_status='settled')::int AS settled, count(*) FILTER (WHERE payment_status<>'settled')::int AS not_settled
          FROM requests GROUP BY 1 ORDER BY sum(payment_amount_atomic) DESC`),
      by_rank: await q(`SELECT rank AS key, count(*)::int AS impressions, count(*) FILTER (WHERE sponsored)::int AS sponsored, sum(charge_micro_usdc)::text AS atomic FROM impressions GROUP BY 1 ORDER BY 1`),
    };
    res.json({
      network: "EVM testnets (TESTNET ONLY)", asset: chain.usdc, units: "USDC atomic (6 decimals)",
      wallets: { payee: chain.payee, payer: chain.payer, balances: chain.balances ?? null, errors: chain.errors },
      relayer: { address: relayerAddress(), settlement: MODE === "mock" ? "mock" : "own facilitator (EIP-3009 transferWithAuthorization from relayer)", fallback_enabled: fallbackOn(),
        gas: MODE === "mock" && !req.query.gas ? [] : await gasStatus().catch(() => []) },
      totals, liability, series, distributions, ledger: rows,
      notes: {
        real_onchain: "bot_query_payment and advertiser_topup rows with mode=x402, status=settled and tx receipt 'success' are real Base Sepolia TESTNET USDC transfers to the payee.",
        prepaid_debits: "advertiser_impression_charge rows debit the advertiser's prepaid balance (already received on-chain via top-ups, or manually credited by admin); no per-impression chain transaction.",
        admin_credits: "advertiser_admin_credit rows are manual test credits: no funds moved on-chain, but they are spendable balance.",
        liability: "Outstanding prepaid liability = sum of all balance-ledger entries (credits minus consumed impression charges); owed to advertisers until consumed.",
        mock: "mode=mock rows come from mock-payment mode (tests/demos) and involve no chain activity.",
      },
    });
  });
  r.get("/api/financials.csv", async (req, res) => {
    const rows = await ledger(req.query, 100000);
    const cols = ["at", "bot_id", "type", "status", "mode", "counterparty", "amount_atomic", "amount_usdc", "request_id", "settle_tx", "listing_id", "rank", "kind"];
    const cell = (v: any) => { const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.join(","), ...rows.map(x => cols.map(c => cell(c === "amount_usdc" ? (Number(x.amount_atomic) / 1e6).toFixed(6) : x[c])).join(","))].join("\n");
    res.set("content-type", "text/csv").set("content-disposition", `attachment; filename="bot-rec-market-ledger-testnet.csv"`).send(csv + "\n");
  });
  return r;
}
