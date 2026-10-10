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
import { currentSettings } from "./settings";
import { MARKET_LOCK, marketSeq, assertNonNegative, advertiserByKey, advertiserSummary, setBid, credit } from "./market";

export const botId = (req: express.Request) => { const b = req.get("X-Bot-Id"); return b && /^[A-Za-z0-9._:-]{1,64}$/.test(b) ? b : null; };
const publicBase = (req: express.Request) => process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`;
const fail = (res: express.Response, e: any) => { res.locals.error = String(e?.message ?? e); res.status(e?.status ?? 500).json({ error: String(e?.message ?? e) }); };
export const TOPUP_MIN = 1000, TOPUP_MAX = 100_000; // 0.001 .. 0.1 test USDC per top-up

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(apiLogger());
  app.use("/dashboard", basicAuth(), dashboardRouter()); // HTTP basic auth (admin / DASHBOARD_PASSWORD)
  app.get("/v1/health", (_q, r) => r.json({ ok: true, payment_mode: MODE, network: NETWORK }));

  app.post("/v1/listings", basicAuth(), async (req, res) => {
    const err = validateListing(req.body); if (err) return res.status(400).json({ error: err });
    res.status(201).json(await insertListing(req.body));
  });

  app.post("/v1/recommend", async (req, res) => {
    const inp = normalizeInput(req.body);
    if (typeof inp === "string") return res.status(400).json({ error: inp });
    const resource = `${publicBase(req)}/v1/recommend`;
    const { version: settings_version, settings } = await currentSettings();   // price + ranking rules pinned here
    const price = BigInt(settings.query_price_atomic);
    const header = req.get("X-PAYMENT");
    if (!header) return res.status(402).json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirements(resource, price)] });
    const pay = await verifyPayment(header, resource, price);
    if ("error" in pay) { res.locals.error = pay.error; return res.status(402).json({ x402Version: 1, error: pay.error, accepts: [requirements(resource, price)] }); }

    // ONE transaction (serialized by MARKET_LOCK): pin catalogue/market/settings, rank, log request + hash +
    // impressions, debit advertisers for sponsored impressions, assert no negative balance.
    const client = await pool.connect();
    const request_id = "req_" + randomUUID();
    res.locals.request_id = request_id;
    let out;
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MARKET_LOCK]);
      const seq = Number((await client.query("SELECT COALESCE(MAX(seq),0) AS s FROM listings")).rows[0].s);
      const mseq = await marketSeq(client);
      const reqCanon = canonicalRequest(inp, seq, { market_seq: mseq, settings_version });
      out = await rank(client, { ...inp, catalogue_seq: seq, market_seq: mseq, settings_version, embedding_model: EMBEDDING_MODEL, ranker_version: RANKER_VERSION });
      await client.query(
        `INSERT INTO requests(request_id,catalogue_seq,embedding_model,ranker_version,request_canonical,request_hash,
           response_canonical,response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_ref,payment_status,bot_id,settings_version,market_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'verified',$14,$15,$16)`,
        [request_id, seq, EMBEDDING_MODEL, RANKER_VERSION, reqCanon, sha256(reqCanon), out.canonical, out.hash,
         pay.payer, pay.mode, NETWORK, pay.amount.toString(), pay.ref, botId(req), settings_version, mseq]);
      const debited: string[] = [];
      for (let i = 0; i < out.meta.length; i++) {
        const m = out.meta[i];
        await client.query(`INSERT INTO impressions(request_id,rank,listing_id,provider_id,charge_micro_usdc,sponsored,fixed_atomic,bid_atomic) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [request_id, i + 1, m.listing_id, m.provider_id, m.cpi, m.sponsored, m.fixed, m.bid]);
        if (m.sponsored && m.cpi > 0) {
          await client.query(`INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,request_id,listing_id,note) VALUES ($1,$2,'impression_debit',$3,$4,$5)`,
            [m.provider_id, -m.cpi, request_id, m.listing_id, `fixed ${m.fixed} + bid ${m.bid}`]);
          debited.push(m.provider_id);
        }
      }
      await assertNonNegative(client, debited);
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
      const out = await rank(pool, { query: p.query, k: p.k, catalogue_seq: Number(r.catalogue_seq), embedding_model: r.embedding_model, ranker_version: r.ranker_version,
        market_seq: r.market_seq == null ? undefined : Number(r.market_seq), settings_version: r.settings_version ?? undefined });
      res.json({ request_id: r.request_id, logged_hash: r.response_hash, replayed_hash: out.hash, match: out.hash === r.response_hash,
        request_hash_ok: sha256(r.request_canonical) === r.request_hash, catalogue_seq: Number(r.catalogue_seq),
        market_seq: r.market_seq == null ? null : Number(r.market_seq), settings_version: r.settings_version, ranker_version: r.ranker_version });
    } catch (e: any) { res.status(409).json({ error: String(e.message) }); }
  });

  app.get("/v1/requests/:id", async (req, res) => {
    const r = (await pool.query(`SELECT request_id,received_at,catalogue_seq,market_seq,settings_version,embedding_model,ranker_version,request_canonical,request_hash,
      response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_status,settle_tx,db_txid,bot_id FROM requests WHERE request_id=$1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: "not found" });
    const imp = (await pool.query("SELECT rank,listing_id,provider_id,sponsored,fixed_atomic,bid_atomic,charge_micro_usdc FROM impressions WHERE request_id=$1 ORDER BY rank", [req.params.id])).rows;
    res.json({ ...r, impressions: imp });
  });
  app.get("/v1/audit/providers/:id", basicAuth(), async (req, res) => {
    const rows = (await pool.query(`SELECT i.listing_id, COUNT(*)::int AS impressions, COUNT(*) FILTER (WHERE sponsored)::int AS sponsored, SUM(i.charge_micro_usdc)::text AS spend_micro_usdc
      FROM impressions i WHERE i.provider_id=$1 GROUP BY i.listing_id ORDER BY i.listing_id`, [req.params.id])).rows;
    res.json({ provider_id: req.params.id, listings: rows });
  });

  // ---------- Advertiser API (Authorization: Bearer <advertiser api key>) ----------
  const advAuth: express.RequestHandler = async (req, res, next) => {
    const m = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "");
    const a = await advertiserByKey(m?.[1]);
    if (!a) return res.status(401).json({ error: "advertiser API key required (Authorization: Bearer ...)" });
    res.locals.adv = a.advertiser_id; next();
  };
  app.get("/v1/advertisers/me", advAuth, async (_req, res) => res.json(await advertiserSummary(res.locals.adv)));
  app.put("/v1/advertisers/me/listings/:lid/bid", advAuth, async (req, res) => {
    try { res.json(await setBid(String(req.params.lid), { bid_atomic: req.body?.bid_atomic }, "advertiser:" + res.locals.adv, res.locals.adv)); } catch (e) { fail(res, e); }
  });
  // Prepay via x402: the advertiser pays amount_atomic test USDC to the payee; credited only AFTER on-chain settlement.
  app.post("/v1/advertisers/me/topup", advAuth, async (req, res) => {
    const amt = Number(req.query.amount_atomic ?? req.body?.amount_atomic);
    if (!Number.isSafeInteger(amt) || amt < TOPUP_MIN || amt > TOPUP_MAX) return res.status(400).json({ error: `amount_atomic must be ${TOPUP_MIN}..${TOPUP_MAX}` });
    const resource = `${publicBase(req)}/v1/advertisers/me/topup`, desc = `Prepaid advertiser balance top-up (${res.locals.adv})`;
    const header = req.get("X-PAYMENT");
    if (!header) return res.status(402).json({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirements(resource, BigInt(amt), desc)] });
    const pay = await verifyPayment(header, resource, BigInt(amt), desc);
    if ("error" in pay) { res.locals.error = pay.error; return res.status(402).json({ x402Version: 1, error: pay.error, accepts: [requirements(resource, BigInt(amt), desc)] }); }
    const dup = (await pool.query("SELECT 1 FROM balance_ledger WHERE payment_ref=$1", [pay.ref])).rows.length;
    if (dup) return res.status(409).json({ error: "payment already used" });
    const s = await settlePayment(pay).catch(() => ({ ok: false } as any));
    if (!s.ok) { res.locals.error = "settlement failed"; return res.status(402).json({ error: "settlement failed; balance not credited" }); }
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    try {
      const c = await credit(res.locals.adv, amt, "topup_x402", { settle_tx: s.tx, payment_ref: pay.ref, payer: pay.payer, note: pay.mode });
      res.json({ advertiser_id: res.locals.adv, credited_atomic: amt, settle_tx: s.tx, mode: pay.mode, ...c });
    } catch (e) { fail(res, e); }
  });
  return app;
}
