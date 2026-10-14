import express from "express";
import { join } from "node:path";
import { pool } from "./db";
import { chainView } from "./chain";
import { financialsRouter } from "./financials";
import { adminRouter } from "./admin";
import { crawlerRouter } from "./crawlerAdmin";
/** Keyset pagination over requests: ?limit (1..500, default 100) &before=<ISO received_at> &q=<request id or query text>. */
export function pageArgs(qs: any, startIdx = 1) {
  const limit = Math.min(Math.max(Number(qs.limit) || 100, 1), 500);
  const w: string[] = [], p: any[] = [];
  if (qs.before && !isNaN(Date.parse(String(qs.before)))) { p.push(String(qs.before)); w.push(`r.received_at < $${startIdx + p.length - 1}::timestamptz`); }
  if (qs.q) { p.push("%" + String(qs.q).slice(0, 100) + "%"); w.push(`(r.request_id ILIKE $${startIdx + p.length - 1} OR r.request_canonical ILIKE $${startIdx + p.length - 1})`); }
  return { limit, where: w.length ? " AND " + w.join(" AND ") : "", params: p };
}
const nextBefore = (rows: any[], limit: number) => rows.length === limit ? new Date(rows[rows.length - 1].received_at).toISOString() : null;
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;

export function apiLogger(): express.RequestHandler {
  return (req, res, next) => {
    if (!req.path.startsWith("/v1/")) return next();
    const t0 = Date.now();
    res.on("finish", () => {
      const route = (req.route?.path as string | undefined) ?? req.path;
      const b = req.get("X-Bot-Id"); pool.query("INSERT INTO api_log(method,route,status,ms,request_id,error,bot_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [req.method, route, res.statusCode, Date.now() - t0, (res.locals.request_id as string) ?? null, (res.locals.error as string) ?? null, b && /^[A-Za-z0-9._:-]{1,64}$/.test(b) ? b : null]).catch(() => {});
    });
    next();
  };
}

export function dashboardRouter() {
  const r = express.Router();
  r.use(financialsRouter());
  r.use(adminRouter());
  r.use(crawlerRouter());
  r.get("/", (_q, res) => res.sendFile(join(__dirname, "..", "public", "dashboard.html")));
  r.get("/api/credits", async (_q2, res) => {   // prepaid search credits: per-wallet balances + recent credit-debited queries
    const { allCreditAccounts } = await import("./credits");
    res.json({ query_price_atomic: (await (await import("./settings")).currentSettings()).settings.query_price_atomic, accounts: await allCreditAccounts(),
      recent: await q(`SELECT r.request_id, r.received_at, r.payer, r.bot_id, r.payment_amount_atomic::text amount_atomic, r.request_canonical::json->>'query' AS query FROM requests r WHERE r.payment_method='credits' ORDER BY received_at DESC LIMIT 30`),
      daily: await q(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'Europe/London'),'YYYY-MM-DD') AS day, count(*) FILTER (WHERE kind='query_debit')::int queries,
          COALESCE(-SUM(delta_atomic) FILTER (WHERE kind='query_debit'),0)::text debited_atomic, COALESCE(SUM(delta_atomic) FILTER (WHERE kind<>'query_debit'),0)::text topped_up_atomic
        FROM search_credit_ledger GROUP BY 1 ORDER BY 1 DESC LIMIT 14`) });
  });
  r.get("/api/usage", async (req, res) => {
    const hours = Math.min(Number(req.query.hours ?? 24) || 24, 168);
    const bot = typeof req.query.bot === "string" && req.query.bot ? req.query.bot : null;
    const bf = bot === "(none)" ? " AND bot_id IS NULL" : bot ? " AND bot_id = $2" : "";
    const bp = bot && bot !== "(none)" ? [hours, bot] : [hours];
    res.json({
      hours,
      series: await q(`SELECT to_char(date_trunc('minute', at) - (extract(minute from at)::int % 10) * interval '1 minute','YYYY-MM-DD"T"HH24:MI') AS bucket,
        count(*)::int AS total, count(*) FILTER (WHERE status=200)::int AS ok, count(*) FILTER (WHERE status=402)::int AS s402,
        count(*) FILTER (WHERE status>=400 AND status<>402)::int AS other_err
        FROM api_log WHERE at > now() - $1 * interval '1 hour'${bf} GROUP BY 1 ORDER BY 1`, bp),
      by_route: await q(`SELECT method, route, status, count(*)::int AS n, round(avg(ms))::int AS avg_ms FROM api_log
        WHERE at > now() - $1 * interval '1 hour'${bf} GROUP BY 1,2,3 ORDER BY n DESC`, bp),
      recent: await q(`SELECT id, at, method, route, status, ms, request_id, error, bot_id FROM api_log WHERE at > now() - $1 * interval '1 hour'${bf} ORDER BY id DESC LIMIT 50`, bp),
      by_bot: await q(`SELECT coalesce(bot_id,'(none)') AS bot_id, count(*)::int AS calls,
          count(*) FILTER (WHERE status=200 AND route='/v1/recommend')::int AS paid_ok, count(*) FILTER (WHERE status=402)::int AS s402,
          count(*) FILTER (WHERE route='/v1/requests/:id/replay')::int AS replays, count(*) FILTER (WHERE status>=500 OR status IN (409,400))::int AS errors,
          max(at) AS last_at FROM api_log WHERE at > now() - $1 * interval '1 hour' GROUP BY 1 ORDER BY 2 DESC`, [hours]),
    });
  });
  // Click analytics over EVERY tracked result link (organic / promoted / incentive). CTR = links with >=1 human
  // click (class not bot/preview/self) / links issued. Window: ?hours (1..720, default 168).
  r.get("/api/click-analytics", async (req, res) => {
    const hours = Math.min(Math.max(Number(req.query.hours) || 168, 1), 720);
    const base = `WITH t AS (
        SELECT h.token, h.listing_id, h.rank, h.tracked_only, (h.show_atomic + h.click_atomic) > 0 AS incentive,
               COALESCE(i.sponsored, false) AS sponsored,
               CASE WHEN (h.show_atomic + h.click_atomic) > 0 THEN 'incentive' WHEN COALESCE(i.sponsored,false) THEN 'promoted' ELSE 'organic' END AS segment
          FROM harvest_tokens h LEFT JOIN impressions i ON i.request_id = h.request_id AND i.rank = h.rank
         WHERE h.issued_at > now() - $1 * interval '1 hour'),
      c AS (SELECT token, count(*)::int AS clicks, count(*) FILTER (WHERE class NOT IN ('bot','preview','self'))::int AS human,
                   count(*) FILTER (WHERE paid AND NOT clawed_back)::int AS paid FROM clicks GROUP BY 1)
      SELECT %s, count(*)::int AS links, COALESCE(sum(c.clicks),0)::int AS clicks, COALESCE(sum(c.human),0)::int AS human_clicks,
             COALESCE(sum(c.paid),0)::int AS paid_clicks, count(c.human) FILTER (WHERE c.human > 0)::int AS clicked_links,
             round(100.0 * count(c.human) FILTER (WHERE c.human > 0) / NULLIF(count(*),0), 2)::float AS ctr_pct
        FROM t LEFT JOIN c USING (token) %s`;
    const by_segment = await q(base.replace("%s", "t.segment").replace("%s", "GROUP BY 1 ORDER BY 1"), [hours]);
    const by_rank = await q(base.replace("%s", "t.rank").replace("%s", "GROUP BY 1 ORDER BY 1"), [hours]);
    const by_listing = await q(base.replace("%s", "t.listing_id, (SELECT name FROM listings l WHERE l.listing_id=t.listing_id) AS name, string_agg(DISTINCT t.segment, ',') AS segments, round(avg(t.rank),2)::float AS avg_rank")
      .replace("%s", "GROUP BY 1 ORDER BY 4 DESC, 3 DESC LIMIT 50"), [hours]);
    const totals = (await q(base.replace("%s", "'all' AS scope").replace("%s", ""), [hours]))[0];
    const by_class = await q(`SELECT c.class, count(*)::int AS n FROM clicks c JOIN harvest_tokens h USING (token) WHERE h.issued_at > now() - $1 * interval '1 hour' GROUP BY 1 ORDER BY 2 DESC`, [hours]);
    const recent = await q(`SELECT c.at, c.class, c.paid, h.listing_id, h.rank, h.tracked_only, h.request_id FROM clicks c JOIN harvest_tokens h USING (token) ORDER BY c.at DESC LIMIT 20`);
    res.json({ hours, totals, by_segment, by_rank, by_listing, by_class, recent });
  });
  r.get("/api/payments", async (req, res) => {
    const pg = pageArgs(req.query);
    const pays = await q(`SELECT request_id, received_at, payer, payment_mode, payment_network, payment_amount_atomic::text AS amount_atomic,
      payment_status, settle_tx, settle_error, bot_id, settle_via, tos_version FROM requests r WHERE true${pg.where} ORDER BY received_at DESC, request_id DESC LIMIT ${pg.limit}`, pg.params);
    const totals = await q(`SELECT payment_mode, payment_status, count(*)::int AS n, sum(payment_amount_atomic)::text AS atomic FROM requests GROUP BY 1,2 ORDER BY 1,2`);
    res.json({ payments: pays, totals, next_before: nextBefore(pays, pg.limit), total_count: (await q(`SELECT count(*)::int n FROM requests`))[0].n });
  });
  r.get("/api/chain", async (_q2, res) => {
    const settled = await q(`SELECT request_id, settle_tx, payment_network, settle_via FROM requests WHERE payment_mode='x402' AND payment_status='settled'`);
    const chain = await chainView(settled.filter(s => s.settle_tx).map(s => ({ tx: s.settle_tx, network: s.payment_network })));
    const seen = new Set(chain.transfers.map((t: any) => String(t.tx).toLowerCase()));
    const reconciliation = settled.map(s => {
      const rc = s.settle_tx ? chain.receipts[s.settle_tx] : undefined;
      const ok = rc === "success" || seen.has(String(s.settle_tx).toLowerCase());
      return { request_id: s.request_id, settle_tx: s.settle_tx, network: s.payment_network, settle_via: s.settle_via, receipt: rc ?? "no_tx", confirmed: ok };
    });
    const by_chain = await q(`SELECT payment_network AS network, payment_mode AS mode, count(*)::int n, count(*) FILTER (WHERE payment_status='settled')::int settled,
      count(*) FILTER (WHERE payment_status='settle_failed')::int failed, coalesce(sum(payment_amount_atomic) FILTER (WHERE payment_status='settled'),0)::text atomic,
      count(*) FILTER (WHERE settle_via='self')::int via_self, count(*) FILTER (WHERE settle_via='facilitator-fallback')::int via_fallback
      FROM requests GROUP BY 1,2 ORDER BY 3 DESC`);
    res.json({ ...chain, reconciliation, by_chain, unconfirmed: reconciliation.filter(r => !r.confirmed).length });
  });
  r.get("/api/requests", async (req, res) => {
    const pg = pageArgs(req.query);
    const rows = await q(`SELECT r.request_id, r.received_at, r.bot_id, r.payment_status, r.payment_mode, r.response_hash, r.ranker_version, r.settings_version,
            (r.request_canonical::json->>'query') AS query, (SELECT count(*)::int FROM impressions i WHERE i.request_id=r.request_id) AS n
       FROM requests r WHERE true${pg.where} ORDER BY received_at DESC, request_id DESC LIMIT ${pg.limit}`, pg.params);
    if (rows.length === pg.limit) res.set("X-Next-Before", new Date(rows[rows.length - 1].received_at).toISOString());
    res.set("X-Total-Count", String((await q("SELECT count(*)::int n FROM requests"))[0].n));
    res.json(rows);
  });
  r.get("/api/requests/:id", async (req, res) => {
    const row = (await q(`SELECT request_id, received_at, catalogue_seq, embedding_model, ranker_version, request_canonical, request_hash,
      response_canonical, response_hash, payer, payment_mode, payment_network, payment_amount_atomic::text AS amount_atomic, payment_status, settle_tx, settle_error, db_txid::text, bot_id, settings_version, market_seq::text,
      payment_chain_id, settle_via, tos_version, tos_hash, tos_proof, pay_to
      FROM requests WHERE request_id=$1`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: "not found" });
    const imps = await q(`SELECT i.rank, i.listing_id, i.provider_id, i.charge_micro_usdc::text AS charge, i.sponsored, i.fixed_atomic::text fixed, i.bid_atomic::text bid, i.db_txid::text, l.name
      FROM impressions i JOIN listings l USING (listing_id) WHERE request_id=$1 ORDER BY rank`, [req.params.id]);
    res.json({ ...row, request: JSON.parse(row.request_canonical), response: JSON.parse(row.response_canonical), impressions: imps });
  });
  r.get("/api/advertisers", async (_q2, res) => res.json(await q(
    `SELECT i.provider_id, count(*)::int AS impressions, count(DISTINCT i.listing_id)::int AS listings, sum(i.charge_micro_usdc)::text AS spend_micro_usdc,
            max(i.created_at) AS last_impression FROM impressions i GROUP BY 1 ORDER BY sum(i.charge_micro_usdc) DESC, 2 DESC`)));
  r.get("/api/catalogue", async (_q2, res) => res.json(await q(
    `SELECT l.seq::int, l.listing_id, l.provider_id, l.name, l.kind, l.address, l.description, l.source_url, l.cpi_micro_usdc::text AS cpi,
            l.supersedes, l.licence_class, l.crawl_item_id, EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id) AS superseded,
            (SELECT count(*)::int FROM impressions i WHERE i.listing_id=l.listing_id) AS impressions
       FROM listings l ORDER BY seq`)));
  return r;
}
