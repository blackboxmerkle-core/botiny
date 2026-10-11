import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { insertListing, validateListing } from "./listings";
import { normalizeInput, rank, canonicalRequest, RANKER_VERSION } from "./rank";
import { EMBEDDING_MODEL } from "./embed";
import { sha256 } from "./canonical";
import { apiLogger, dashboardRouter } from "./dashboard";
import { basicAuth } from "./auth";
import { verifyPayment, settlePayment, accepts, reserveNonce, peekNonce, MODE, PAY_TO } from "./payment";
import { tosInfo, checkTos, currentTos, tosVersion, TosKind } from "./tos";
import { publicChains } from "./chains";
import { banGuard } from "./bans";
import { payToState } from "./wallets";
import { activeChains, relayerAddress } from "./relayer";
import { currentSettings } from "./settings";
import { MARKET_LOCK, marketSeq, assertNonNegative, advertiserByKey, advertiserSummary, setBid, setIncentive, credit } from "./market";
import { issueClickLinks } from "./clicks";

export const botId = (req: express.Request) => { const b = req.get("X-Bot-Id"); return b && /^[A-Za-z0-9._:-]{1,64}$/.test(b) ? b : null; };
const publicBase = (req: express.Request) => process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`;
const fail = (res: express.Response, e: any) => { res.locals.error = String(e?.message ?? e); res.status(e?.status ?? 500).json({ error: String(e?.message ?? e) }); };
export const TOPUP_MIN = 1000, TOPUP_MAX = 100_000; // 0.001 .. 0.1 test USDC per top-up

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(apiLogger());
  app.use("/dashboard", basicAuth(), dashboardRouter()); // HTTP basic auth (admin / DASHBOARD_PASSWORD)
  app.get("/v1/health", async (_q, r) => {
    const act = MODE === "mock" ? [] : await activeChains().catch(() => []);
    r.json({ ok: true, payment_mode: MODE, network: MODE === "mock" ? "mock" : act.map(a => a.chain.key).join(",") || "none", settlement: MODE === "mock" ? "mock" : "own-facilitator",
      chains: act.map(a => ({ network: a.chain.key, caip2: a.chain.caip2, settle_via: a.settle_via })), pay_to: (await payToState()).pay_to, relayer: relayerAddress() });
  });
  app.get("/v1/chains", async (_q, r) => r.json({ chains: publicChains(), active: MODE === "mock" ? [] : (await activeChains()).map(a => ({ network: a.chain.key, settle_via: a.settle_via })) }));
  // Versioned Terms of Service (DRAFT placeholder). /v1/terms/:version = bot ToS; /v1/terms/advertiser/:version
  const sendTos = async (kind: TosKind, v: string, res: express.Response) => {
    const t = v === "current" ? await currentTos(kind) : await tosVersion(kind, Number(v));
    if (!t) return res.status(404).json({ error: "no such ToS version" });
    res.set("X-TOS-SHA256", t.sha256).set("X-TOS-VERSION", String(t.version)).type("text/plain; charset=utf-8").send(t.body);
  };
  app.get("/v1/terms", async (req, res) => res.json({ bot: await tosInfo("bot", publicBase(req)), advertiser: await tosInfo("advertiser", publicBase(req)) }));
  app.get("/v1/terms/advertiser/:version", (req, res) => sendTos("advertiser", String(req.params.version), res));
  app.get("/v1/terms/:version", (req, res) => sendTos("bot", String(req.params.version), res));

  app.post("/v1/listings", basicAuth(), async (req, res) => {
    const err = validateListing(req.body); if (err) return res.status(400).json({ error: err });
    res.status(201).json(await insertListing(req.body));
  });

  app.post("/v1/recommend", banGuard(), async (req, res) => {
    const inp = normalizeInput(req.body);
    if (typeof inp === "string") return res.status(400).json({ error: inp });
    const { version: settings_version, settings } = await currentSettings();   // price + ranking rules pinned here
    const price = BigInt(settings.query_price_atomic);
    const g = await paymentGate(req, res, "bot", "/v1/recommend", req.body, price, "Ranked bot-service recommendations");
    if (!g) return;
    const { pay, tos } = g;

    // ONE transaction (serialized by MARKET_LOCK): pin catalogue/market/settings, rank, log request + hash +
    // impressions, debit advertisers for sponsored impressions, assert no negative balance.
    const client = await pool.connect();
    const request_id = "req_" + randomUUID();
    res.locals.request_id = request_id;
    let out;
    let click_links: any[] = [];
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT pg_advisory_xact_lock($1)", [MARKET_LOCK]);
      const seq = Number((await client.query("SELECT COALESCE(MAX(seq),0) AS s FROM listings")).rows[0].s);
      const mseq = await marketSeq(client);
      const reqCanon = canonicalRequest(inp, seq, { market_seq: mseq, settings_version });
      out = await rank(client, { ...inp, catalogue_seq: seq, market_seq: mseq, settings_version, embedding_model: EMBEDDING_MODEL, ranker_version: RANKER_VERSION });
      await client.query(
        `INSERT INTO requests(request_id,catalogue_seq,embedding_model,ranker_version,request_canonical,request_hash,
           response_canonical,response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_ref,payment_status,bot_id,settings_version,market_seq,
           payment_chain_id,settle_via,tos_version,tos_hash,tos_proof,pay_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'verified',$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [request_id, seq, EMBEDDING_MODEL, RANKER_VERSION, reqCanon, sha256(reqCanon), out.canonical, out.hash,
         pay.payer, pay.mode, pay.network, pay.amount.toString(), pay.ref, botId(req), settings_version, mseq,
         pay.chainId, pay.settle_via, tos.tos_version, tos.tos_hash, tos.proof, pay.payTo]);
      await reserveNonce(client, pay);   // same tx: replayed EIP-3009 nonce => 23505 => 409
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
      // click-server: signed per-result links + incentive escrow, same transaction; kept out of response_hash
      const cl = await issueClickLinks(client, { request_id, bot_wallet: (pay.payer || botId(req) || "unknown").toLowerCase(), channel: req.get("X-Bot-Channel"),
        market_seq: mseq, settings: out.settings ?? settings, results: out.body.results, providers: out.meta.map((m: any) => m.provider_id) });
      click_links = cl.click_links;
      debited.push(...cl.debited);
      if (cl.kid) await client.query("UPDATE requests SET click_kid=$2, click_config=$3 WHERE request_id=$1", [request_id, cl.kid, cl.config]);
      await assertNonNegative(client, debited);
      if (process.env.FAIL_AFTER_IMPRESSIONS === "1") throw new Error("injected failure");
      await client.query("COMMIT");
    } catch (e: any) {
      await client.query("ROLLBACK").catch(() => {});
      res.locals.error = String(e?.message ?? e);
      if (e?.code === "23505") return res.status(409).json({ error: "payment already used" });
      return res.status(500).json({ error: "internal error", detail: String(e?.message ?? e) });
    } finally { client.release(); }

    const s = await settlePayment(pay).catch((e: any) => ({ ok: false, error: "exception: " + String(e?.shortMessage ?? e?.message ?? e).slice(0, 480) } as any));
    await pool.query("UPDATE requests SET payment_status=$2, settle_tx=$3, settle_error=$4, settle_via=$5 WHERE request_id=$1",
      [request_id, s.ok ? "settled" : "settle_failed", s.tx ?? null, s.ok ? null : (s.error ?? "unknown"), s.via ?? pay.settle_via]);
    if (!s.ok) res.locals.error = "settlement failed: " + (s.error ?? "unknown");
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    if (!s.ok) return res.status(402).json({ error: "settlement failed", reason: s.error ?? "unknown", request_id });
    res.json({ request_id, response_hash: out.hash, response: out.body, click_links, payment: { network: pay.network, settle_tx: s.tx ?? null, settle_via: s.via }, tos: { version: tos.tos_version, sha256: tos.tos_hash, proof: tos.proof } });
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
        market_seq: r.market_seq == null ? null : Number(r.market_seq), settings_version: r.settings_version, ranker_version: r.ranker_version,
        tos: r.tos_version == null ? null : { version: r.tos_version, sha256: r.tos_hash, proof: r.tos_proof }, payment: { network: r.payment_network, chain_id: r.payment_chain_id, settle_tx: r.settle_tx, settle_via: r.settle_via, pay_to: r.pay_to } });
    } catch (e: any) { res.status(409).json({ error: String(e.message) }); }
  });

  app.get("/v1/requests/:id", async (req, res) => {
    const r = (await pool.query(`SELECT request_id,received_at,catalogue_seq,market_seq,settings_version,embedding_model,ranker_version,request_canonical,request_hash,
      response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_status,settle_tx,settle_error,db_txid,bot_id,payment_chain_id,settle_via,tos_version,tos_hash,tos_proof,pay_to FROM requests WHERE request_id=$1`, [req.params.id])).rows[0];
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
  app.put("/v1/advertisers/me/listings/:lid/incentive", advAuth, async (req, res) => {
    try { res.json(await setIncentive(String(req.params.lid), { show_atomic: req.body?.show_atomic, click_atomic: req.body?.click_atomic }, "advertiser:" + res.locals.adv, res.locals.adv)); } catch (e) { fail(res, e); }
  });
  // Prepay via x402: the advertiser pays amount_atomic test USDC to the payee; credited only AFTER on-chain settlement.
  app.post("/v1/advertisers/me/topup", banGuard(), advAuth, async (req, res) => {
    const amt = Number(req.query.amount_atomic ?? req.body?.amount_atomic);
    if (!Number.isSafeInteger(amt) || amt < TOPUP_MIN || amt > TOPUP_MAX) return res.status(400).json({ error: `amount_atomic must be ${TOPUP_MIN}..${TOPUP_MAX}` });
    const desc = `Prepaid advertiser balance top-up (${res.locals.adv})`;
    const g = await paymentGate(req, res, "advertiser", "/v1/advertisers/me/topup", { advertiser_id: res.locals.adv, amount_atomic: amt }, BigInt(amt), desc);
    if (!g) return;
    const { pay, tos } = g;
    const dup = (await pool.query("SELECT 1 FROM balance_ledger WHERE payment_ref=$1", [pay.ref])).rows.length;
    if (dup) return res.status(409).json({ error: "payment already used" });
    try { await reserveNonce(pool, pay); } catch (e: any) { if (e?.code === "23505") return res.status(409).json({ error: "payment already used (nonce)" }); throw e; }
    const s = await settlePayment(pay).catch((e: any) => ({ ok: false, error: "exception: " + String(e?.message ?? e).slice(0, 480) } as any));
    if (!s.ok) { res.locals.error = "settlement failed: " + (s.error ?? "unknown"); return res.status(402).json({ error: "settlement failed; balance not credited", reason: s.error ?? "unknown" }); }
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    try {
      const c = await credit(res.locals.adv, amt, "topup_x402", { settle_tx: s.tx, payment_ref: pay.ref, payer: pay.payer, note: pay.mode,
        payment_network: pay.network, payment_chain_id: pay.chainId, settle_via: s.via, tos_version: tos.tos_version, tos_hash: tos.tos_hash, tos_proof: tos.proof, pay_to: pay.payTo });
      res.json({ advertiser_id: res.locals.adv, credited_atomic: amt, settle_tx: s.tx, mode: pay.mode, network: pay.network, settle_via: s.via, tos: { version: tos.tos_version, sha256: tos.tos_hash }, ...c });
    } catch (e) { fail(res, e); }
  });
  return app;
}

/** x402 + ToS gate: 402 with accepts (one per active EVM chain) + ToS; ToS acceptance must be bound into the EIP-3009 nonce. */
async function paymentGate(req: express.Request, res: express.Response, kind: TosKind, route: string, params: unknown, amount: bigint, description: string) {
  const base = publicBase(req);
  const tos = await tosInfo(kind, base);
  const acc = await accepts(base + route, amount, description, tos);
  const fail = (error: string) => { res.locals.error = error; res.status(402).json({ x402Version: 1, error, accepts: acc, tos }); return null; };
  if (!acc.length) return fail("no payment network currently available (relayer has no gas on any enabled chain)");
  const header = req.get("X-PAYMENT");
  if (!header) return fail("X-PAYMENT header is required (and ToS acceptance: X-TOS-ACCEPT + X-TOS-SALT bound into the nonce)");
  const nonce = MODE === "mock" ? null : peekNonce(header);
  if (MODE !== "mock" && !nonce) return fail("malformed X-PAYMENT (expected base64 JSON x402 'exact' EVM payload)");
  const t = await checkTos(kind, { accept: req.get("X-TOS-ACCEPT"), salt: req.get("X-TOS-SALT") }, route, params, nonce);
  if (!t.ok) return fail(t.reason);
  const pay = await verifyPayment(header, acc, amount);
  if ("error" in pay) return fail(pay.error);
  return { pay, tos: t };
}
