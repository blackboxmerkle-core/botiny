import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { insertListing, validateListing } from "./listings";
import { normalizeInput, rank, canonicalRequest, RANKER_VERSION } from "./rank";
import { EMBEDDING_MODEL } from "./embed";
import { sha256 } from "./canonical";
import { apiLogger, dashboardRouter } from "./dashboard";
import { basicAuth } from "./auth";
import { verifyPayment, settlePayment, requirements, MODE, NETWORK } from "./payment";

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(apiLogger());
  app.use("/dashboard", basicAuth(), dashboardRouter()); // read-only, HTTP basic auth (admin / DASHBOARD_PASSWORD)
  app.get("/v1/health", (_q, r) => r.json({ ok: true, payment_mode: MODE, network: NETWORK }));

  app.post("/v1/listings", basicAuth(), async (req, res) => {
    const err = validateListing(req.body); if (err) return res.status(400).json({ error: err });
    res.status(201).json(await insertListing(req.body));
  });

  app.post("/v1/recommend", async (req, res) => {
    const inp = normalizeInput(req.body);
    if (typeof inp === "string") return res.status(400).json({ error: inp });
    const resource = `${process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`}/v1/recommend`;
    const header = req.get("X-PAYMENT");
    if (!header) return res.status(402).json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirements(resource)] });
    const pay = await verifyPayment(header, resource);
    if ("error" in pay) { res.locals.error = pay.error; } if ("error" in pay) return res.status(402).json({ x402Version: 1, error: pay.error, accepts: [requirements(resource)] });

    // ONE transaction: pin snapshot, rank, log request + response hash + impressions.
    const client = await pool.connect();
    const request_id = "req_" + randomUUID();
    res.locals.request_id = request_id;
    let out;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const seq = Number((await client.query("SELECT COALESCE(MAX(seq),0) AS s FROM listings")).rows[0].s);
      const reqCanon = canonicalRequest(inp, seq);
      out = await rank(client, { ...inp, catalogue_seq: seq, embedding_model: EMBEDDING_MODEL, ranker_version: RANKER_VERSION });
      await client.query(
        `INSERT INTO requests(request_id,catalogue_seq,embedding_model,ranker_version,request_canonical,request_hash,
           response_canonical,response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_ref,payment_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'verified')`,
        [request_id, seq, EMBEDDING_MODEL, RANKER_VERSION, reqCanon, sha256(reqCanon), out.canonical, out.hash,
         pay.payer, pay.mode, NETWORK, pay.amount.toString(), pay.ref]);
      for (let i = 0; i < out.meta.length; i++) {
        const m = out.meta[i];
        await client.query(`INSERT INTO impressions(request_id,rank,listing_id,provider_id,charge_micro_usdc) VALUES ($1,$2,$3,$4,$5)`,
          [request_id, i + 1, m.listing_id, m.provider_id, m.cpi]);
      }
      if (process.env.FAIL_AFTER_IMPRESSIONS === "1") throw new Error("injected failure");
      await client.query("COMMIT");
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => {});
      res.locals.error = String(e?.message ?? e);
      if (e?.code === "23505") return res.status(409).json({ error: "payment already used" });
      return res.status(500).json({ error: "internal error", detail: String(e?.message ?? e) });
    } finally { client.release(); }

    const s = await settlePayment(pay).catch(() => ({ ok: false } as any));
    await pool.query("UPDATE requests SET payment_status=$2, settle_tx=$3 WHERE request_id=$1",
      [request_id, s.ok ? "settled" : "settle_failed", s.tx ?? null]);
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    if (!s.ok) return res.status(402).json({ error: "settlement failed", request_id });
    res.json({ request_id, response_hash: out.hash, response: out.body });
  });

  app.get("/v1/requests/:id/replay", async (req, res) => {
    const r = (await pool.query("SELECT * FROM requests WHERE request_id=$1", [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: "not found" });
    const p = JSON.parse(r.request_canonical);
    try {
      const out = await rank(pool, { query: p.query, k: p.k, catalogue_seq: Number(r.catalogue_seq), embedding_model: r.embedding_model, ranker_version: r.ranker_version });
      res.json({ request_id: r.request_id, logged_hash: r.response_hash, replayed_hash: out.hash, match: out.hash === r.response_hash,
        request_hash_ok: sha256(r.request_canonical) === r.request_hash, catalogue_seq: Number(r.catalogue_seq) });
    } catch (e: any) { res.status(409).json({ error: String(e.message) }); }
  });

  // Audit (cheap): one request with its impressions, and per-provider spend.
  app.get("/v1/requests/:id", async (req, res) => {
    const r = (await pool.query(`SELECT request_id,received_at,catalogue_seq,embedding_model,ranker_version,request_canonical,request_hash,
      response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_status,settle_tx,db_txid FROM requests WHERE request_id=$1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: "not found" });
    const imp = (await pool.query("SELECT rank,listing_id,provider_id,charge_micro_usdc FROM impressions WHERE request_id=$1 ORDER BY rank", [req.params.id])).rows;
    res.json({ ...r, impressions: imp });
  });
  app.get("/v1/audit/providers/:id", basicAuth(), async (req, res) => {
    const rows = (await pool.query(`SELECT i.listing_id, COUNT(*)::int AS impressions, SUM(i.charge_micro_usdc)::text AS spend_micro_usdc
      FROM impressions i WHERE i.provider_id=$1 GROUP BY i.listing_id ORDER BY i.listing_id`, [req.params.id])).rows;
    res.json({ provider_id: req.params.id, listings: rows });
  });
  return app;
}
