import express from "express";
import { pool } from "./db";
import { chainView } from "./chain";
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

// Unified ledger. All amounts in USDC atomic units (6dp). Testnet only.
const LEDGER = `
  SELECT r.received_at AS at, 'bot_query_payment' AS type, r.payment_status AS status, r.payment_mode AS mode,
         r.payer AS counterparty, r.payment_amount_atomic AS amount_atomic, r.request_id, r.settle_tx, NULL::text AS listing_id,
         NULL::int AS rank, NULL::text AS kind, r.bot_id
    FROM requests r
  UNION ALL
  SELECT i.created_at, 'advertiser_impression_charge', 'accrued', 'offchain', i.provider_id, i.charge_micro_usdc, i.request_id, NULL,
         i.listing_id, i.rank, l.kind, rq.bot_id
    FROM impressions i JOIN listings l USING (listing_id) JOIN requests rq USING (request_id) WHERE i.charge_micro_usdc > 0`;

function filters(qs: any) {
  const w: string[] = [], p: any[] = [];
  if (qs.from) { p.push(qs.from); w.push(`at >= $${p.length}::date`); }
  if (qs.to) { p.push(qs.to); w.push(`at < $${p.length}::date + 1`); }
  if (qs.type) { p.push(qs.type); w.push(`type = $${p.length}`); }
  if (qs.status) { p.push(qs.status); w.push(`status = $${p.length}`); }
  if (qs.bot) { if (qs.bot === "(none)") w.push("bot_id IS NULL"); else { p.push(qs.bot); w.push(`bot_id = $${p.length}`); } }
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
    const settled = await q(`SELECT settle_tx FROM requests WHERE payment_mode='x402' AND payment_status='settled' AND settle_tx IS NOT NULL`);
    const chain = await chainView(settled.map(s => s.settle_tx));
    const rows = await ledger(req.query);
    for (const x of rows) {
      x.amount_atomic = String(x.amount_atomic);
      x.onchain = x.type !== "bot_query_payment" ? "n/a (accrued only)" : x.mode === "mock" ? "n/a (mock)" : x.settle_tx ? (chain.receipts[x.settle_tx] ?? "unknown") : "none";
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
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_impression_charge'),0)::text AS ad_accrued,
        count(*) FILTER (WHERE type='advertiser_impression_charge')::int AS charged_impressions
      FROM (${LEDGER}) x WHERE ${cond}${bc}`).then(r => {
        const t = r[0]; t.avg_per_query = t.paid_queries ? String(Math.round(Number(t.query_gross) / t.paid_queries)) : "0"; return t; });
    const totals = {
      today: await win(`(at AT TIME ZONE 'Europe/London')::date = (now() AT TIME ZONE 'Europe/London')::date`),
      d7: await win(`at > now() - interval '7 days'`), all: await win("true"),
    };
    const series = await q(`SELECT to_char(date_trunc('hour', at AT TIME ZONE 'Europe/London'),'YYYY-MM-DD HH24:00') AS bucket,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND status='settled'),0)::text AS settled,
        coalesce(sum(amount_atomic) FILTER (WHERE type='bot_query_payment' AND status<>'settled'),0)::text AS unsettled,
        coalesce(sum(amount_atomic) FILTER (WHERE type='advertiser_impression_charge'),0)::text AS ad_accrued
      FROM (${LEDGER}) x WHERE at > now() - interval '7 days'${bc} GROUP BY 1 ORDER BY 1`);
    const distributions = {
      by_provider: await q(`SELECT provider_id AS key, count(*)::int AS impressions, sum(charge_micro_usdc)::text AS atomic FROM impressions GROUP BY 1 ORDER BY sum(charge_micro_usdc) DESC, 2 DESC LIMIT 20`),
      by_kind: await q(`SELECT l.kind AS key, count(*)::int AS impressions, sum(i.charge_micro_usdc)::text AS atomic FROM impressions i JOIN listings l USING (listing_id) GROUP BY 1 ORDER BY 2 DESC`),
      by_payer: await q(`SELECT payer AS key, payment_mode AS mode, count(*)::int AS queries, sum(payment_amount_atomic)::text AS atomic FROM requests GROUP BY 1,2 ORDER BY sum(payment_amount_atomic) DESC LIMIT 20`),
      by_bot: await q(`SELECT coalesce(bot_id,'(none)') AS key, count(*)::int AS queries, sum(payment_amount_atomic)::text AS atomic,
          count(*) FILTER (WHERE payment_status='settled')::int AS settled, count(*) FILTER (WHERE payment_status<>'settled')::int AS not_settled
          FROM requests GROUP BY 1 ORDER BY sum(payment_amount_atomic) DESC`),
      by_rank: await q(`SELECT rank AS key, count(*)::int AS impressions, sum(charge_micro_usdc)::text AS atomic FROM impressions GROUP BY 1 ORDER BY 1`),
    };
    res.json({
      network: "base-sepolia (TESTNET)", asset: chain.usdc, units: "USDC atomic (6 decimals)",
      wallets: { payee: chain.payee, payer: chain.payer, balances: chain.balances ?? null, errors: chain.errors },
      totals, series, distributions, ledger: rows,
      notes: {
        real_onchain: "Only bot_query_payment rows with mode=x402 and status=settled whose tx receipt is 'success' are real Base Sepolia testnet USDC transfers to the payee.",
        accrued_only: "advertiser_impression_charge rows are an off-chain accrual ledger; advertisers do not deposit or pay yet, no funds move.",
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
