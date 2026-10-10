import express from "express";
import { join } from "node:path";
import { pool } from "./db";
import { chainView } from "./chain";
import { financialsRouter } from "./financials";
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
  r.get("/", (_q, res) => res.sendFile(join(__dirname, "..", "public", "dashboard.html")));
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
  r.get("/api/payments", async (_q2, res) => {
    const pays = await q(`SELECT request_id, received_at, payer, payment_mode, payment_network, payment_amount_atomic::text AS amount_atomic,
      payment_status, settle_tx FROM requests ORDER BY received_at DESC LIMIT 100`);
    const totals = await q(`SELECT payment_mode, payment_status, count(*)::int AS n, sum(payment_amount_atomic)::text AS atomic FROM requests GROUP BY 1,2 ORDER BY 1,2`);
    res.json({ payments: pays, totals });
  });
  r.get("/api/chain", async (_q2, res) => {
    const settled = await q(`SELECT request_id, settle_tx FROM requests WHERE payment_mode='x402' AND payment_status='settled'`);
    const chain = await chainView(settled.map(s => s.settle_tx).filter(Boolean));
    const seen = new Set(chain.transfers.map((t: any) => String(t.tx).toLowerCase()));
    const reconciliation = settled.map(s => {
      const rc = s.settle_tx ? chain.receipts[s.settle_tx] : undefined;
      const ok = rc === "success" || seen.has(String(s.settle_tx).toLowerCase());
      return { request_id: s.request_id, settle_tx: s.settle_tx, receipt: rc ?? "no_tx", confirmed: ok };
    });
    res.json({ ...chain, reconciliation, unconfirmed: reconciliation.filter(r => !r.confirmed).length });
  });
  r.get("/api/requests", async (_q2, res) => res.json(await q(
    `SELECT r.request_id, r.received_at, r.bot_id, r.payment_status, r.payment_mode, r.response_hash,
            (r.request_canonical::json->>'query') AS query, (SELECT count(*)::int FROM impressions i WHERE i.request_id=r.request_id) AS n
       FROM requests r ORDER BY received_at DESC LIMIT 100`)));
  r.get("/api/requests/:id", async (req, res) => {
    const row = (await q(`SELECT request_id, received_at, catalogue_seq, embedding_model, ranker_version, request_canonical, request_hash,
      response_canonical, response_hash, payer, payment_mode, payment_network, payment_amount_atomic::text AS amount_atomic, payment_status, settle_tx, db_txid::text, bot_id
      FROM requests WHERE request_id=$1`, [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: "not found" });
    const imps = await q(`SELECT i.rank, i.listing_id, i.provider_id, i.charge_micro_usdc::text AS charge, i.db_txid::text, l.name
      FROM impressions i JOIN listings l USING (listing_id) WHERE request_id=$1 ORDER BY rank`, [req.params.id]);
    res.json({ ...row, request: JSON.parse(row.request_canonical), response: JSON.parse(row.response_canonical), impressions: imps });
  });
  r.get("/api/advertisers", async (_q2, res) => res.json(await q(
    `SELECT i.provider_id, count(*)::int AS impressions, count(DISTINCT i.listing_id)::int AS listings, sum(i.charge_micro_usdc)::text AS spend_micro_usdc,
            max(i.created_at) AS last_impression FROM impressions i GROUP BY 1 ORDER BY sum(i.charge_micro_usdc) DESC, 2 DESC`)));
  r.get("/api/catalogue", async (_q2, res) => res.json(await q(
    `SELECT l.seq::int, l.listing_id, l.provider_id, l.name, l.kind, l.address, l.description, l.source_url, l.cpi_micro_usdc::text AS cpi,
            l.supersedes, EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id) AS superseded,
            (SELECT count(*)::int FROM impressions i WHERE i.listing_id=l.listing_id) AS impressions
       FROM listings l ORDER BY seq`)));
  return r;
}
