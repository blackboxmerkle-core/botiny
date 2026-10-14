import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { insertListing, validateListing } from "./listings";
import { normalizeInput, rank, canonicalRequest, RANKER_VERSION, RecommendInput } from "./rank";
import { EMBEDDING_MODEL } from "./embed";
import { sha256 } from "./canonical";
import { apiLogger, dashboardRouter } from "./dashboard";
import { basicAuth } from "./auth";
import { verifyPayment, settlePayment, accepts, reserveNonce, peekNonce, MODE, PAY_TO } from "./payment";
import { tosInfo, checkTos, currentTos, tosVersion, TosKind } from "./tos";
import { publicChains } from "./chains";
import { banGuard, clientIp } from "./bans";
import { payToState } from "./wallets";
import { activeChains, relayerAddress } from "./relayer";
import { currentSettings } from "./settings";
import { MARKET_LOCK, marketSeq, assertNonNegative, advertiserByKey, advertiserSummary, setBid, setIncentive, credit } from "./market";
import { portalRouter, suggestionsAdminRouter, sessionAdvertiser, sessionOf, listCampaigns, listingStats, createCampaign, rateLimit } from "./portal";
import { payerFromHeader } from "./bans";
import { recordSettlement } from "./reconcile";
import { replayRow } from "./replay";
import { creditAccountByKey, creditBalance, creditTopup, debitForQuery, latestTopupTos, creditSummary } from "./credits";
import { activeBans } from "./bans";
import { issueClickLinks, pgEngine, scoreClick, settleIncentives, clawbackClick, clearReview, earnings, clickKeys } from "./clicks";

export const botId = (req: express.Request) => { const b = req.get("X-Bot-Id"); return b && /^[A-Za-z0-9._:-]{1,64}$/.test(b) ? b : null; };
const publicBase = (req: express.Request) => process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`;
const fail = (res: express.Response, e: any) => { res.locals.error = String(e?.message ?? e); res.status(e?.status ?? 500).json({ error: String(e?.message ?? e), ...(typeof e?.code === "string" ? { code: e.code } : {}), ...(e?.field ? { field: e.field } : {}) }); };   // 5xx text is replaced by errorShape
/** Public redaction of a payer wallet: 0xabcd…1234 (non-wallet payers: first 6 chars + …). */
export const redactPayer = (p: string | null) => !p ? null : /^0x[0-9a-fA-F]{40}$/.test(p) ? `${p.slice(0, 6)}…${p.slice(-4)}`.toLowerCase() : String(p).slice(0, 6) + "…";
/** Per-IP / per-wallet fixed-window limits (in-process). Generous defaults so sim bots never hit them; env-tunable
 *  (RL_<NAME>_IP / RL_<NAME>_WALLET per minute). Direct loopback clients (local scripts, supervise health checks) are
 *  exempt unless RL_EXEMPT_LOOPBACK=0; ngrok traffic carries the real client IP (trust proxy = loopback). */
const rlExempt = (req: express.Request) => { const peer = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, ""); return process.env.RL_EXEMPT_LOOPBACK !== "0" && /^(127\.|::1$)/.test(peer) && req.get("x-forwarded-for") == null; };
export function limit(name: string, perIpMin: number, perWalletMin?: number): express.RequestHandler {
  return (req, res, next) => {
    const ip = clientIp(req);
    // exempt ONLY a direct local client: the TCP peer itself is loopback AND no X-Forwarded-For (ngrok always adds one,
    // so tunnelled traffic is limited by its forwarded client IP)
    const peer = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (process.env.RL_EXEMPT_LOOPBACK !== "0" && /^(127\.|::1$)/.test(peer) && req.get("x-forwarded-for") == null) return next();
    const N = name.toUpperCase();
    try {
      rateLimit(`${name}:ip:${ip}`, Number(process.env[`RL_${N}_IP`] ?? perIpMin), 60_000);
      const w = perWalletMin ? payerFromHeader(req.get("X-PAYMENT")) ?? (/^0x[0-9a-fA-F]{40}$/.test(req.get("X-Bot-Wallet") ?? "") ? req.get("X-Bot-Wallet")!.toLowerCase() : null) : null;
      if (w) rateLimit(`${name}:wallet:${w}`, Number(process.env[`RL_${N}_WALLET`] ?? perWalletMin), 60_000);
    } catch (e: any) { if (e?.retryAfter) res.set("Retry-After", String(e.retryAfter)); return res.status(429).json({ error: "rate_limited", message: `too many ${name} requests; retry after ${e?.retryAfter ?? 60}s` }); }
    next();
  };
}
export const TOPUP_MIN = 1000, TOPUP_MAX = 100_000; // 0.001 .. 0.1 test USDC per top-up

export interface SearchExec { request_id: string; inp: RecommendInput; settings_version: number; settings: any; pay: any; tos: any; credit: { wallet: string } | null; price: bigint;
  bot_id: string | null; channel?: string; client_req: { ip: string; ua: string; acceptLanguage: string } }
/** The single search transaction (serialized by MARKET_LOCK) shared by POST /v1/recommend and the MCP server: pin catalogue/market/
 *  settings, rank, log request + hash + impressions, debit credits (credit path) and advertisers, issue click links, assert no
 *  negative balance. Throws {insufficientCredit} if the credit balance raced below the price, pg 23505 on payment reuse. */
export async function executeSearch(o: SearchExec): Promise<{ out: any; click_links: any[]; creditAfter: number | null }> {
  const { request_id, inp, settings_version, settings, pay, tos, credit, price } = o;
  let creditAfter: number | null = null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MARKET_LOCK]);
    const seq = Number((await client.query("SELECT COALESCE(MAX(seq),0) AS s FROM listings")).rows[0].s);
    const mseq = await marketSeq(client);
    const pacing_at_ms = Date.now();
    const reqCanon = canonicalRequest(inp, seq, { market_seq: mseq, settings_version, pacing_at_ms });
    const out = await rank(client, { ...inp, catalogue_seq: seq, market_seq: mseq, settings_version, pacing_at_ms, embedding_model: EMBEDDING_MODEL, ranker_version: RANKER_VERSION });
    await client.query(
      `INSERT INTO requests(request_id,catalogue_seq,embedding_model,ranker_version,request_canonical,request_hash,
       response_canonical,response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_ref,bot_id,settings_version,market_seq,
       payment_chain_id,settle_via,tos_version,tos_hash,tos_proof,pay_to,payment_valid_before,payment_status,payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [request_id, seq, EMBEDDING_MODEL, RANKER_VERSION, reqCanon, sha256(reqCanon), out.canonical, out.hash,
       pay.payer, pay.mode, pay.network, pay.amount.toString(), pay.ref, o.bot_id, settings_version, mseq,
       pay.chainId, pay.settle_via, tos.tos_version, tos.tos_hash, tos.proof, pay.payTo,
       pay.mode === "x402" ? Number((pay as any).payload?.payload?.authorization?.validBefore ?? 0) || null : null,   // always stored (needed to ever compensate)
       credit ? "settled" : "verified", credit ? "credits" : "per_query"]);
    if (credit) {   // atomic debit in the same transaction as the request log + impressions
      const d = await debitForQuery(client, credit.wallet, Number(price), request_id);
      if (!d) throw Object.assign(new Error("insufficient credit"), { insufficientCredit: true });
      creditAfter = d.balance_atomic;
    }
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
    const cl = await issueClickLinks(client, { request_id, bot_wallet: pay.payer, channel: o.channel,
      client_req: o.client_req,
      market_seq: mseq, settings: out.settings ?? settings, results: out.body.results, providers: out.meta.map((m: any) => m.provider_id) });
    const click_links = cl.click_links;
    debited.push(...cl.debited);
    if (cl.kid) await client.query("UPDATE requests SET click_kid=$2, click_config=$3 WHERE request_id=$1", [request_id, cl.kid, cl.config]);
    if ((out as any).pacing && Object.keys((out as any).pacing).length) await client.query("UPDATE requests SET pacing=$2 WHERE request_id=$1", [request_id, (out as any).pacing]);
    await assertNonNegative(client, debited);
    if (process.env.FAIL_AFTER_IMPRESSIONS === "1") throw new Error("injected failure");
    await client.query("COMMIT");
    return { out, click_links, creditAfter };
  } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
}
/** Credit-path pay/tos descriptors (credit searches inherit the ToS accepted, nonce-bound, at the wallet's latest top-up). */
export async function creditPay(wallet: string, price: bigint, request_id: string) {
  const t = await latestTopupTos(pool, wallet);
  return { tos: { tos_version: t?.tos_version ?? null, tos_hash: t?.tos_hash ?? null, proof: t?.tos_proof ?? null },
    pay: { mode: "credits", payer: wallet, network: "credits", amount: price, ref: "credits:" + request_id, chainId: null, settle_via: "credits", payTo: null } };
}

export function createApp() {
  const app = express();
  app.set("trust proxy", "loopback");   // only ngrok's local agent (loopback) may set X-Forwarded-For; see bans.clientIp
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb", verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
  app.use(apiLogger());
  app.use(errorShape());                                          // every error body => {error: <code>, message, ...extra}
  app.use("/portal", portalStatic());                             // portal front end, same origin (no CORS)
  app.use("/dashboard", basicAuth(), dashboardRouter()); // HTTP basic auth (admin / DASHBOARD_PASSWORD)
  app.use("/dashboard", basicAuth(), suggestionsAdminRouter());   // listing-suggestion review (admin)
  app.use(portalRouter());                                         // human portal: SIWE, suggestions, bot-owner monitoring
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

  app.post("/v1/recommend", banGuard(), limit("recommend", 600, 300), async (req, res) => {   // limited BEFORE the payment gate
    const inp = normalizeInput(req.body);
    if (typeof inp === "string") return res.status(400).json({ error: inp });
    const { version: settings_version, settings } = await currentSettings();   // price + ranking rules pinned here
    const price = BigInt(settings.query_price_atomic);
    const request_id = "req_" + randomUUID();
    // Prepaid search credits: Authorization: Bearer bck_... (key bound to the payer wallet of its top-up). Without enough
    // credit (or with an explicit X-PAYMENT) the normal per-query x402 flow applies, so pay-per-query stays the fallback.
    let credit: { wallet: string; balance_atomic: number } | null = null, creditShort: any = null;
    const ck = /^Bearer (bck_\S+)$/.exec(req.get("authorization") ?? "");
    if (ck) {
      const acct = await creditAccountByKey(ck[1]);
      if (!acct) return res.status(401).json({ error: "credit_key_invalid", message: "unknown or revoked search-credit API key" });
      const ban = (await activeBans()).find((b: any) => b.kind === "wallet" && b.value === acct.wallet);
      if (ban) { res.locals.error = "banned (wallet)"; return res.status(403).json({ error: "forbidden: banned", ban: { id: ban.ban_id, kind: ban.kind, reason: ban.reason, expires_at: ban.expires_at } }); }
      if (!rlExempt(req)) try { rateLimit(`recommend:wallet:${acct.wallet}`, Number(process.env.RL_RECOMMEND_WALLET ?? 300), 60_000); }
        catch (e: any) { if (e?.retryAfter) res.set("Retry-After", String(e.retryAfter)); return res.status(429).json({ error: "rate_limited", message: `too many recommend requests; retry after ${e?.retryAfter ?? 60}s` }); }
      const bal = await creditBalance(pool, acct.wallet);
      if (bal >= Number(price) && !req.get("X-PAYMENT")) credit = { wallet: acct.wallet, balance_atomic: bal };
      else creditShort = { credits: { balance_atomic: bal, required_atomic: Number(price), topup: "/v1/credits/topup", message: "insufficient search credit: pay this query with x402 (accepts) or top up" } };
    }
    let pay: any, tos: any;
    if (credit) {
      ({ pay, tos } = await creditPay(credit.wallet, price, request_id));
    } else {
      const g = await paymentGate(req, res, "bot", "/v1/recommend", req.body, price, "Ranked bot-service recommendations", creditShort);
      if (!g) return;
      ({ pay, tos } = g);
    }
    let creditAfter: number | null = null;

    res.locals.request_id = request_id;
    let out: any, click_links: any[] = [];
    try {
      ({ out, click_links, creditAfter } = await executeSearch({ request_id, inp, settings_version, settings, pay, tos, credit, price, bot_id: botId(req), channel: req.get("X-Bot-Channel"),
        client_req: { ip: clientIp(req), ua: req.get("user-agent") ?? "", acceptLanguage: req.get("accept-language") ?? "" } }));
    } catch (e: any) {
      res.locals.error = String(e?.message ?? e);
      if (e?.insufficientCredit)   // raced to zero: same 402 as an unpaid request
        return void await paymentGate(req, res, "bot", "/v1/recommend", req.body, price, "Ranked bot-service recommendations", { credits: { balance_atomic: await creditBalance(pool, credit!.wallet), required_atomic: Number(price), topup: "/v1/credits/topup" } }, true);
      if (e?.code === "23505") return res.status(409).json({ error: "payment already used" });
      console.error("recommend", request_id, e?.stack ?? e);
      return res.status(500).json({ error: "internal_error", message: "internal error", request_id });
    }
    if (credit) return res.json({ request_id, response_hash: out.hash, response: out.body, click_links,
      payment: { method: "credits", debited_atomic: Number(price), credit_balance_atomic: creditAfter, queries_remaining: Math.floor(creditAfter! / Number(price)) },
      tos: { version: tos.tos_version, sha256: tos.tos_hash, proof: tos.proof } });

    // a thrown settle is AMBIGUOUS (the authorization may have been broadcast): settle_unknown, reconciled on-chain later
    const s = await settlePayment(pay).catch((e: any) => ({ ok: false, ambiguous: true, via: pay.settle_via, error: "exception: " + String(e?.shortMessage ?? e?.message ?? e).slice(0, 480) } as any));
    const vb = pay.mode === "x402" ? Number((pay as any).payload?.payload?.authorization?.validBefore ?? 0) || null : null;
    // outcome + (definite failure) compensation in ONE transaction; the worker sweeper covers anything left behind
    const rec = await recordSettlement(request_id, s, { via: pay.settle_via, valid_before: vb }).catch((e: any) => { console.error("record settlement", request_id, e?.stack ?? e); return null; });
    if (!s.ok) {
      res.locals.error = "settlement " + (s.ambiguous ? "unknown" : "failed") + ": " + (s.error ?? "unknown");   // full text: server log + admin dashboard only
      console.error(s.ambiguous ? "settle_unknown" : "settle_failed", request_id, s.error);
      if (s.ambiguous) return res.status(202).json({ state: "settle_unknown", request_id, billed: "pending",
        message: "Payment settlement outcome is unknown and is being reconciled on-chain. Check GET /v1/requests/" + request_id + " (payment_status). If the payment did not settle you are not charged." });
      return res.status(402).json({ error: "settlement_failed", message: "Payment settlement failed; you were not charged and this request was not billed.", request_id, billed: false, voided: !!rec?.compensation?.voided });
    }
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    res.json({ request_id, response_hash: out.hash, response: out.body, click_links, payment: { network: pay.network, settle_tx: s.tx ?? null, settle_via: s.via }, tos: { version: tos.tos_version, sha256: tos.tos_hash, proof: tos.proof } });
  });

  // Result content (impressions, request/response bodies, payment details) is public only once the payment SETTLED, or to the
  // proven payer: X-Payer-Signature = EIP-191 personal_sign over `botiny:request:<request_id>:<X-Payer-Timestamp>` (unix s, ±300 s).
  const payerProved = async (req: express.Request, r: any) => {
    const sig = req.get("x-payer-signature"), tsRaw = req.get("x-payer-timestamp") ?? "";
    if (!sig || !r.payer || !/^\d{1,12}$/.test(tsRaw) || !/^0x[0-9a-fA-F]+$/.test(sig) || sig.length > 4096) return false;
    const ts = Number(tsRaw); if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const message = `botiny:request:${r.request_id}:${tsRaw}`;
    try {
      const { verifyMessage } = await import("viem");
      if (sig.length === 132 && await verifyMessage({ address: r.payer as `0x${string}`, message, signature: sig as `0x${string}` })) return true;   // EOA
      // EIP-1271 (smart-contract wallet): public client on the request's payment chain, testnets only, 5 s timeout
      const { configuredChains } = await import("./chains");
      const c = configuredChains().find(x => x.chainId === Number(r.payment_chain_id));
      if (!c || !c.testnet || !c.rpc) return false;
      const { createPublicClient, http } = await import("viem");
      const pc = createPublicClient({ transport: http(c.rpc, { timeout: 5000, retryCount: 0 }) });
      return await Promise.race([pc.verifyMessage({ address: r.payer as `0x${string}`, message, signature: sig as `0x${string}` }), new Promise<boolean>(ok => setTimeout(() => ok(false), 6000))]);
    } catch { return false; }
  };
  const fullView = async (req: express.Request, r: any) => r.payment_status === "settled" || await payerProved(req, r);

  app.get("/v1/requests/:id/replay", limit("replay", 120), async (req, res) => {
    const r = (await pool.query("SELECT * FROM requests WHERE request_id=$1", [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: "not found" });
    const logged = { request_id: r.request_id, logged_hash: r.response_hash, request_hash: r.request_hash, payment_status: r.payment_status };
    // unsettled + not the payer: no re-rank at all (no result-derived signal), only the logged hashes + status
    if (!(await fullView(req, r))) return res.json({ ...logged, restricted: true, message: "replay is computed once payment settled, or for the payer (X-Payer-Signature)" });
    try {
      const out = await replayRow(r);
      const base = { request_id: r.request_id, logged_hash: r.response_hash, replayed_hash: out.hash, match: out.hash === r.response_hash, result: out.hash === r.response_hash ? "MATCH" : "MISMATCH",
        request_hash_ok: sha256(r.request_canonical) === r.request_hash, payment_status: r.payment_status };
      res.json({ ...base, catalogue_seq: Number(r.catalogue_seq),
        market_seq: r.market_seq == null ? null : Number(r.market_seq), settings_version: r.settings_version, ranker_version: r.ranker_version,
        tos: r.tos_version == null ? null : { version: r.tos_version, sha256: r.tos_hash, proof: r.tos_proof }, payment: { network: r.payment_network, chain_id: r.payment_chain_id, settle_tx: r.settle_tx, settle_via: r.settle_via, pay_to: r.pay_to } });
    } catch (e: any) { console.error("replay", r.request_id, e?.stack ?? e); res.status(409).json({ error: "replay_failed", message: "replay could not be computed for this request" }); }
  });

  app.get("/v1/requests/:id", limit("request", 600), async (req, res) => {
    // PUBLIC (bots verify with it): payer is redacted to a short form + sha256 (match your own wallet), no settle_error, no db_txid.
    // Unsettled requests expose only hashes/status unless the caller proves to be the payer (see fullView).
    const r = (await pool.query(`SELECT request_id,received_at,catalogue_seq,market_seq,settings_version,embedding_model,ranker_version,request_canonical,request_hash,
      response_hash,payer,payment_mode,payment_network,payment_amount_atomic,payment_status,billing_status,settle_tx,bot_id,payment_chain_id,settle_via,tos_version,tos_hash,tos_proof,pay_to FROM requests WHERE request_id=$1`, [req.params.id])).rows[0];
    if (!r) return res.status(404).json({ error: "not found" });
    const { payer, ...pub } = r;
    const id = { payer: redactPayer(payer), payer_sha256: payer ? sha256(String(payer).toLowerCase()) : null };
    if (!(await fullView(req, r))) return res.json({ request_id: r.request_id, received_at: r.received_at, payment_status: r.payment_status, request_hash: r.request_hash, response_hash: r.response_hash, ...id, restricted: true,
      message: "results are shown once payment settled, or to the payer (X-Payer-Signature over botiny:request:<id>:<X-Payer-Timestamp>)" });
    const imp = (await pool.query("SELECT rank,listing_id,provider_id,sponsored,fixed_atomic,bid_atomic,charge_micro_usdc FROM impressions WHERE request_id=$1 ORDER BY rank", [req.params.id])).rows;
    res.json({ ...pub, ...id, impressions: imp });
  });
  app.get("/v1/audit/providers/:id", basicAuth(), async (req, res) => {
    const rows = (await pool.query(`SELECT i.listing_id, COUNT(*)::int AS impressions, COUNT(*) FILTER (WHERE sponsored)::int AS sponsored, SUM(i.charge_micro_usdc)::text AS spend_micro_usdc
      FROM impressions i WHERE i.provider_id=$1 GROUP BY i.listing_id ORDER BY i.listing_id`, [req.params.id])).rows;
    res.json({ provider_id: req.params.id, listings: rows });
  });

  // ---------- Advertiser API (Authorization: Bearer <advertiser api key>) ----------
  const advAuth: express.RequestHandler = async (req, res, next) => {
    const m = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "");
    const a = m && !m[1].startsWith("bts_") ? await advertiserByKey(m[1]) : null;
    if (!a) { const sa = await sessionAdvertiser(req); if (sa) { res.locals.adv = sa; res.locals.adv_via = "siwe"; return next(); } }
    if (!a) return res.status(401).json({ error: "advertiser_auth_required", message: "Advertiser authentication required: send an advertiser API key (Authorization: Bearer adv_...) or use a SIWE session whose wallet is linked to an advertiser (POST /v1/advertisers/me/link-key)." });
    res.locals.adv = a.advertiser_id; next();
  };
  app.get("/v1/advertisers/me", advAuth, async (_req, res) => res.json(await advertiserSummary(res.locals.adv)));
  app.put("/v1/advertisers/me/listings/:lid/bid", advAuth, async (req, res) => {
    try { res.json(await setBid(String(req.params.lid), { bid_atomic: req.body?.bid_atomic }, "advertiser:" + res.locals.adv, res.locals.adv)); } catch (e) { fail(res, e); }
  });
  app.get("/v1/advertisers/me/incentives/report", advAuth, async (req, res) => {
    try { const { incentiveReport, reportCsv } = await import("./pacing"); const r = await incentiveReport(pool, res.locals.adv);
      if (req.query.format === "csv") { res.type("text/csv").set("Content-Disposition", `attachment; filename="incentives-${res.locals.adv.replace(/\W/g, "_")}.csv"`).send(reportCsv(r)); } else res.json(r);
    } catch (e) { fail(res, e); }
  });
  app.delete("/v1/advertisers/me/link", async (req, res, next) => {   // CSRF: cookie sessions must send X-Botiny-Client
    const s = await sessionOf(req).catch(() => null);
    if (s?.via === "cookie" && !req.get("X-Botiny-Client") && !/^Bearer adv_/.test(req.get("authorization") ?? "")) return res.status(403).json({ error: "csrf", message: "X-Botiny-Client header required for cookie-authenticated writes" });
    next();
  }, advAuth, async (_req, res) => {
    try { const { unlinkAdvertiser } = await import("./portal"); res.json(await unlinkAdvertiser(res.locals.adv, res.locals.adv_via === "siwe" ? "advertiser-session:" + res.locals.adv : "advertiser-key:" + res.locals.adv)); } catch (e) { fail(res, e); }
  });
  app.get("/v1/advertisers/me/campaigns", advAuth, async (req, res) => { try { res.json(await listCampaigns(res.locals.adv, req.query.all === "1")); } catch (e) { fail(res, e); } });
  app.get("/v1/advertisers/me/campaigns/:lid", advAuth, async (req, res) => { try { res.json(await listingStats(res.locals.adv, String(req.params.lid), String(req.query.range ?? "30d"))); } catch (e) { fail(res, e); } });
  app.get("/v1/advertisers/me/listings/:lid/stats", advAuth, async (req, res) => { try { res.json(await listingStats(res.locals.adv, String(req.params.lid), String(req.query.range ?? "30d"))); } catch (e) { fail(res, e); } });
  app.post("/v1/advertisers/me/campaigns", advAuth, async (req, res) => {
    try { const r = await createCampaign(res.locals.adv, req.body); res.status(r.status).json(r.body); }
    catch (e: any) { if (e?.code === "insufficient_balance") { res.locals.error = e.message; return res.status(409).json({ error: e.message, code: e.code, summary: e.summary, topup: "/v1/advertisers/me/topup" }); } fail(res, e); }
  });
  // Public click attestation feed (SKALE Europa testnet) for this advertiser: JSON or CSV.
  app.get("/v1/advertisers/me/attestations", advAuth, async (req, res) => {
    try { const { advertiserFeed, feedCsv } = await import("./attest"); const f = await advertiserFeed(res.locals.adv);
      if (req.query.format === "csv") res.type("text/csv").set("Content-Disposition", `attachment; filename="clicks-${res.locals.adv.replace(/\W/g, "_")}.csv"`).send(feedCsv(f)); else res.json(f);
    } catch (e) { fail(res, e); }
  });
  app.get("/advertiser", (_req, res) => res.sendFile(require("node:path").join(__dirname, "..", "public", "advertiser.html")));
  app.post("/v1/admin/attest/tick", basicAuth(), async (_req, res) => { try { res.json(await (await import("./attest")).attestTick()); } catch (e) { fail(res, e); } });
  app.put("/v1/advertisers/me/listings/:lid/incentive", advAuth, async (req, res) => {
    try { res.json(await setIncentive(String(req.params.lid), { show_atomic: req.body?.show_atomic, click_atomic: req.body?.click_atomic, budget_atomic: req.body?.budget_atomic, expires_at: req.body?.expires_at }, "advertiser:" + res.locals.adv, res.locals.adv)); } catch (e) { fail(res, e); }
  });
  // ---------- Click server (redirect, proofs, earnings, settlement) ----------
  const clickHandler = async (req: express.Request, res: express.Response, path: string) => {
    try {
      const engine = await pgEngine(pool);
      const { makeHandler } = await import(require("node:url").pathToFileURL(require("node:path").join(__dirname, "..", "..", "click-server", "src", "worker.js")).href);
      const h = makeHandler(engine, { enqueue: (ev: any) => scoreClick(ev).catch((e: any) => console.error("click score", e?.message)) });
      const trustCf = process.env.TRUST_CF_HEADER === "1";
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && (trustCf || k !== "cf-connecting-ip")) headers.set(k, v);
      // client IP: same rule as bans (LAST X-Forwarded-For entry, appended by ngrok, else socket); cf-connecting-ip only if TRUST_CF_HEADER=1
      const r: Response = await h(new Request("http://click.local" + path, { method: req.method, headers }), { clientIp: clientIp(req), trustCf }, { waitUntil: (p: Promise<any>) => p });
      res.status(r.status); r.headers.forEach((v, k) => res.set(k, v)); res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) { fail(res, e); }
  };
  app.get("/c/:code", limit("click", 300), (req, res) => clickHandler(req, res, "/" + req.params.code));
  app.get("/c/:code/preview", limit("click", 300), (req, res) => clickHandler(req, res, "/" + req.params.code + "/preview"));
  app.get("/r/:token", limit("click", 300), (req, res) => clickHandler(req, res, "/r/" + req.params.token));
  app.get("/c/r/:token", limit("click", 300), (req, res) => clickHandler(req, res, "/r/" + req.params.token));   // track_url = CLICK_SHORT_BASE + /r/<token>
  app.get("/.well-known/botsource-keys", async (_req, res) => {
    const k = await clickKeys(); if (!k) return res.json({ keys: [] });
    const jwk = await crypto.subtle.exportKey("jwk", k.publicKey); res.json({ keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: k.kid, use: "sig", alg: "EdDSA" }] });
  });
  // Bot proof claim. Bound to the paying wallet via an EIP-191 signed request (X-Bot-Wallet/-Signature/-Timestamp).
  app.post("/v1/proofs", limit("proof", 120, 60), async (req: any, res) => {
    try {
      const engine = await pgEngine(pool);
      const r = await engine.submitProof({ body: req.body, rawBody: req.rawBody ?? "", headers: req.headers, method: "POST", path: "/v1/proofs" });
      res.status(r.status).json(r.body ?? { error: r.error });
    } catch (e) { fail(res, e); }
  });
  // Earnings: signature REQUIRED (new endpoint, no legacy header mode).
  app.get("/v1/bots/me/earnings", async (req: any, res) => {
    try {
      if (!req.get("X-Bot-Signature")) {   // portal: SIWE session => earnings for the signed-in wallet + linked wallets
        const s = await sessionOf(req);
        if (s) { const ws = [s.address, ...(await pool.query("SELECT wallet FROM bot_owner_wallets WHERE owner_address=$1", [s.address])).rows.map((r: any) => r.wallet)];
          return res.json({ address: s.address, wallets: await Promise.all(ws.map(w => earnings(w))) }); }
      }
      const engine = await pgEngine(pool);
      const { verifySignedRequest } = await import(require("node:url").pathToFileURL(require("node:path").join(__dirname, "..", "..", "click-server", "src", "binding.js")).href);
      const a = await verifySignedRequest({ method: "GET", path: "/v1/bots/me/earnings", headers: req.headers, body: "", cfg: { ...engine.cfg, allowUnsignedBotRequests: false }, verifyMessage: engine.verifyMessage, store: engine.store });
      if (!a.ok) return res.status(401).json({ error: "wallet_required", message: `Bot wallet required: sign the request (X-Bot-Wallet / X-Bot-Signature / X-Bot-Timestamp) or use a SIWE portal session (${a.error})` });
      res.json(await earnings(a.wallet));
    } catch (e) { fail(res, e); }
  });
  app.post("/v1/admin/incentives/settle", basicAuth(), async (_req, res) => { try { res.json(await settleIncentives()); } catch (e) { fail(res, e); } });
  app.post("/v1/admin/clicks/:id/clawback", basicAuth(), async (req, res) => {
    try { const rows = await clawbackClick(String(req.params.id), String(req.body?.reason ?? "admin")); res.json({ clawed_back: rows.length, settlement: await settleIncentives() }); } catch (e) { fail(res, e); }
  });
  app.post("/v1/admin/incentives/review/:entry/clear", basicAuth(), async (req, res) => { try { res.json(await clearReview(String(req.params.entry))); } catch (e) { fail(res, e); } });
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
    const s = await settlePayment(pay).catch((e: any) => ({ ok: false, ambiguous: true, error: "exception: " + String(e?.message ?? e).slice(0, 480) } as any));
    if (!s.ok && s.ambiguous) {   // may have settled: never credit blindly; the sweeper credits once authorizationState proves it
      console.error("topup settle_unknown", res.locals.adv, s.error);
      await pool.query(`INSERT INTO topup_pending(payment_ref,advertiser_id,amount_atomic,chain_id,payer,nonce,valid_before,mode,settle_tx,settle_via,credit_meta,last_error)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (payment_ref) DO NOTHING`,
        [pay.ref, res.locals.adv, amt, pay.chainId ?? null, pay.payer, (pay as any).nonce ?? null, Number((pay as any).payload?.payload?.authorization?.validBefore ?? 0) || null, pay.mode, s.tx ?? null, s.via ?? null,
         { payer: pay.payer, note: pay.mode, payment_network: pay.network, payment_chain_id: pay.chainId, settle_via: s.via, tos_version: tos.tos_version, tos_hash: tos.tos_hash, tos_proof: tos.proof, pay_to: pay.payTo }, String(s.error ?? "").slice(0, 300)]);
      return res.status(202).json({ state: "settle_unknown", message: "Payment settlement outcome is unknown; it is being reconciled on-chain and your balance is credited automatically if it settled." });
    }
    if (!s.ok) { res.locals.error = "settlement failed: " + (s.error ?? "unknown"); console.error("topup settle_failed", res.locals.adv, s.error);
      return res.status(402).json({ error: "settlement_failed", message: "Payment settlement failed; balance not credited and you were not charged." }); }
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    try {
      const c = await credit(res.locals.adv, amt, "topup_x402", { settle_tx: s.tx, payment_ref: pay.ref, payer: pay.payer, note: pay.mode,
        payment_network: pay.network, payment_chain_id: pay.chainId, settle_via: s.via, tos_version: tos.tos_version, tos_hash: tos.tos_hash, tos_proof: tos.proof, pay_to: pay.payTo });
      res.json({ advertiser_id: res.locals.adv, credited_atomic: amt, settle_tx: s.tx, mode: pay.mode, network: pay.network, settle_via: s.via, tos: { version: tos.tos_version, sha256: tos.tos_hash }, ...c });
    } catch (e) { fail(res, e); }
  });
  // ---------- MCP server (streamable HTTP, stateless JSON) ----------
  app.post("/mcp", banGuard(), limit("mcp", 600), async (req, res, next) => { try { (await import("./mcp")).mcpHandler(publicBase)(req, res, next); } catch (e) { next(e); } });
  app.get("/mcp", (_req, res) => { res.set("Allow", "POST").status(405).json({ error: "method_not_allowed", message: "this MCP endpoint is stateless: POST JSON-RPC messages (no SSE stream)" }); });
  app.delete("/mcp", (_req, res) => { res.set("Allow", "POST").status(405).json({ error: "method_not_allowed", message: "no sessions to terminate" }); });
  // ---------- Prepaid search credits (searcher bots) ----------
  // Top-up: one x402 payment of settings.credit_pack_price_atomic (ToS bound into the nonce, bans apply). Credited only after
  // settlement. First top-up (or ?rotate_key=1) returns an API key bound to the payer wallet, shown once. No refunds.
  app.get("/v1/credits/pricing", async (_req, res) => { const { settings: S } = await currentSettings();
    res.json({ pack_price_atomic: S.credit_pack_price_atomic, pack_credit_atomic: S.credit_pack_credit_atomic, query_price_atomic: S.query_price_atomic,
      queries_per_pack: Math.floor(S.credit_pack_credit_atomic / S.query_price_atomic), topup: "POST /v1/credits/topup", tos_params: { pack_price_atomic: S.credit_pack_price_atomic }, refunds: "none" }); });
  app.post("/v1/credits/topup", banGuard(), limit("credits_topup", 30, 10), async (req, res) => {
    const { settings: S } = await currentSettings();
    const amt = S.credit_pack_price_atomic, grant = S.credit_pack_credit_atomic;
    const rotate = req.query.rotate_key === "1" || req.body?.rotate_key === true;
    const g = await paymentGate(req, res, "bot", "/v1/credits/topup", { pack_price_atomic: amt }, BigInt(amt), `Prepaid search credits: ${Math.floor(grant / S.query_price_atomic)} queries`);
    if (!g) return;
    const { pay, tos } = g;
    if (!/^0x[0-9a-fA-F]{40}$/.test(pay.payer) && pay.payer !== "0xmock") return res.status(400).json({ error: "payer wallet required" });
    if ((await pool.query("SELECT 1 FROM search_credit_ledger WHERE payment_ref=$1", [pay.ref])).rows.length) return res.status(409).json({ error: "payment already used" });
    try { await reserveNonce(pool, pay); } catch (e: any) { if (e?.code === "23505") return res.status(409).json({ error: "payment already used (nonce)" }); throw e; }
    const s = await settlePayment(pay).catch((e: any) => ({ ok: false, ambiguous: true, error: "exception: " + String(e?.message ?? e).slice(0, 480) } as any));
    const meta = { payment_network: pay.network, payment_chain_id: pay.chainId, settle_via: s.via, tos_version: tos.tos_version, tos_hash: tos.tos_hash, tos_proof: tos.proof, pay_to: pay.payTo, note: pay.mode };
    if (!s.ok && s.ambiguous) {
      console.error("credits topup settle_unknown", s.error);
      await pool.query(`INSERT INTO topup_pending(payment_ref,target,advertiser_id,amount_atomic,chain_id,payer,nonce,valid_before,mode,settle_tx,settle_via,credit_meta,last_error)
          VALUES ($1,'search_credits',NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (payment_ref) DO NOTHING`,
        [pay.ref, grant, pay.chainId ?? null, pay.payer.toLowerCase(), (pay as any).nonce ?? null, Number((pay as any).payload?.payload?.authorization?.validBefore ?? 0) || null, pay.mode, s.tx ?? null, s.via ?? null, meta, String(s.error ?? "").slice(0, 300)]);
      return res.status(202).json({ state: "settle_unknown", message: "Settlement outcome unknown; reconciled on-chain and credited automatically if it settled (top up again with rotate_key=1 to obtain a key if this was your first top-up)." });
    }
    if (!s.ok) { res.locals.error = "settlement failed: " + (s.error ?? "unknown"); return res.status(402).json({ error: "settlement_failed", message: "Payment settlement failed; no credit granted and you were not charged." }); }
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    try {
      const c = await creditTopup(pay.payer, grant, { ...meta, payment_ref: pay.ref, settle_tx: s.tx ?? null }, rotate);
      res.json({ wallet: c.wallet, paid_atomic: amt, credited_atomic: grant, balance_atomic: c.balance_atomic, queries_remaining: Math.floor(c.balance_atomic / S.query_price_atomic),
        ...(c.api_key ? { api_key: c.api_key, api_key_note: "shown once; send as Authorization: Bearer <key> on POST /v1/recommend" } : { api_key: null, api_key_note: "existing key unchanged (top up with rotate_key=1 to issue a new one)" }),
        settle_tx: s.tx ?? null, network: pay.network, settle_via: s.via, tos: { version: tos.tos_version, sha256: tos.tos_hash }, refunds: "none" });
    } catch (e) { fail(res, e); }
  });
  app.get("/v1/credits/me", limit("credits_me", 120), async (req, res) => {
    const ck = /^Bearer (bck_\S+)$/.exec(req.get("authorization") ?? "");
    const a = ck ? await creditAccountByKey(ck[1]) : null;
    if (!a) return res.status(401).json({ error: "credit_key_required", message: "send Authorization: Bearer <search-credit API key>" });
    res.json(await creditSummary(a.wallet, (await currentSettings()).settings.query_price_atomic));
  });
  // ---------- Data feed (bulk catalogue access; monthly API-key tiers bought via x402) ----------
  app.get("/v1/feed/tiers", async (_req, res) => { const { tierOf, TIERS, PERIOD_DAYS } = await import("./feed"); const { settings: S } = await currentSettings();
    res.json({ tiers: TIERS.map(t => ({ ...tierOf(S, t), tos_params: { tier: t, price_atomic: tierOf(S, t).price_atomic }, subscribe: `POST /v1/feed/subscribe?tier=${t}` })), period_days: PERIOD_DAYS,
      endpoints: { export: "GET /v1/feed/listings?cursor=&limit=", changes: "GET /v1/feed/changes?since=<seq>&limit=", me: "GET /v1/feed/me" }, auth: "Authorization: Bearer bfk_...", refunds: "none" }); });
  app.post("/v1/feed/subscribe", banGuard(), limit("feed_subscribe", 30, 10), async (req, res) => {
    const F = await import("./feed");
    const tier = String(req.query.tier ?? req.body?.tier ?? "") as any;
    if (!F.TIERS.includes(tier)) return res.status(400).json({ error: "validation", message: `tier must be one of ${F.TIERS.join(", ")}` });
    const { version, settings: S } = await currentSettings();
    const T = F.tierOf(S, tier), rotate = req.query.rotate_key === "1" || req.body?.rotate_key === true;
    const g = await paymentGate(req, res, "bot", "/v1/feed/subscribe", { tier, price_atomic: T.price_atomic }, BigInt(T.price_atomic), `Botiny data feed: ${tier} tier, ${T.monthly_quota} requests / ${T.period_days} days`);
    if (!g) return;
    const { pay, tos } = g;
    if (!/^0x[0-9a-fA-F]{40}$/.test(pay.payer) && pay.payer !== "0xmock") return res.status(400).json({ error: "payer wallet required" });
    if ((await pool.query("SELECT 1 FROM feed_periods WHERE payment_ref=$1", [pay.ref])).rows.length) return res.status(409).json({ error: "payment already used" });
    try { await reserveNonce(pool, pay); } catch (e: any) { if (e?.code === "23505") return res.status(409).json({ error: "payment already used (nonce)" }); throw e; }
    const s = await settlePayment(pay).catch((e: any) => ({ ok: false, ambiguous: true, error: "exception: " + String(e?.message ?? e).slice(0, 480) } as any));
    const meta = { payment_network: pay.network, payment_chain_id: pay.chainId, settle_via: s.via, tos_version: tos.tos_version, tos_hash: tos.tos_hash, tos_proof: tos.proof, pay_to: pay.payTo, price_atomic: T.price_atomic, settings_version: version };
    if (!s.ok && s.ambiguous) {
      console.error("feed subscribe settle_unknown", s.error);
      await pool.query(`INSERT INTO topup_pending(payment_ref,target,advertiser_id,amount_atomic,chain_id,payer,nonce,valid_before,mode,settle_tx,settle_via,credit_meta,last_error)
          VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (payment_ref) DO NOTHING`,
        [pay.ref, "feed_" + tier, T.price_atomic, pay.chainId ?? null, pay.payer.toLowerCase(), (pay as any).nonce ?? null, Number((pay as any).payload?.payload?.authorization?.validBefore ?? 0) || null, pay.mode, s.tx ?? null, s.via ?? null, meta, String(s.error ?? "").slice(0, 300)]);
      return res.status(202).json({ state: "settle_unknown", message: "Settlement outcome unknown; reconciled on-chain and the month is granted automatically if it settled (subscribe again with rotate_key=1 to obtain a key if this was your first purchase)." });
    }
    if (!s.ok) { res.locals.error = "settlement failed: " + (s.error ?? "unknown"); return res.status(402).json({ error: "settlement_failed", message: "Payment settlement failed; nothing granted and you were not charged." }); }
    if (s.header) res.set("X-PAYMENT-RESPONSE", s.header);
    try {
      const r = await F.grantPeriod(pay.payer, tier, S, version, { ...meta, payment_ref: pay.ref, settle_tx: s.tx ?? null }, rotate);
      res.json({ wallet: r.wallet, tier, paid_atomic: T.price_atomic, period: r.period,
        ...(r.api_key ? { api_key: r.api_key, api_key_note: "shown once; send as Authorization: Bearer <key> to /v1/feed/*" } : { api_key: null, api_key_note: "existing key unchanged (rotate_key=1 issues a new one)" }),
        settle_tx: s.tx ?? null, network: pay.network, settle_via: s.via, tos: { version: tos.tos_version, sha256: tos.tos_hash }, refunds: "none" });
    } catch (e) { fail(res, e); }
  });
  const feedAuth: express.RequestHandler = async (req, res, next) => {
    const F = await import("./feed");
    const m = /^Bearer (bfk_\S+)$/.exec(req.get("authorization") ?? "");
    const a = m ? await F.feedAccountByKey(m[1]) : null;
    if (!a) return res.status(401).json({ error: "feed_key_required", message: "send Authorization: Bearer <data-feed key>; buy a tier via x402 at POST /v1/feed/subscribe (see GET /v1/feed/tiers)" });
    const ban = (await activeBans()).find((b: any) => b.kind === "wallet" && b.value === a.wallet);
    if (ban) return res.status(403).json({ error: "forbidden: banned", ban: { id: ban.ban_id, kind: ban.kind, reason: ban.reason } });
    if (!rlExempt(req)) try { rateLimit(`feed:wallet:${a.wallet}`, Number(process.env.RL_FEED_WALLET ?? 120), 60_000); }
      catch (e: any) { await F.logUsage({ wallet: a.wallet, endpoint: req.path.split("/").pop()!, status: 429, ip: clientIp(req) }); if (e?.retryAfter) res.set("Retry-After", String(e.retryAfter)); return res.status(429).json({ error: "rate_limited", message: `too many feed requests; retry after ${e?.retryAfter ?? 60}s` }); }
    res.locals.feedWallet = a.wallet; next();
  };
  const feedServe = (endpoint: "listings" | "changes") => async (req: express.Request, res: express.Response) => {
    const F = await import("./feed");
    const w = res.locals.feedWallet as string;
    const cursorIn = endpoint === "listings" ? (typeof req.query.cursor === "string" ? req.query.cursor : null) : String(req.query.since ?? "0");
    if (endpoint === "listings" && cursorIn && !F.decodeCursor(cursorIn)) return res.status(400).json({ error: "validation", message: "invalid cursor" });
    if (endpoint === "changes" && !/^\d{1,15}$/.test(cursorIn!)) return res.status(400).json({ error: "validation", message: "since must be a non-negative integer seq" });
    const q = await F.consumeQuota(w);
    if (!q) { await F.logUsage({ wallet: w, endpoint, status: 402, cursor_in: cursorIn, ip: clientIp(req) });
      return res.status(402).json({ error: "feed_quota_exhausted", message: "no active data-feed month with quota left; buy one via x402 at POST /v1/feed/subscribe?tier=basic|pro (no refunds)", subscribe: "/v1/feed/subscribe", tiers: "/v1/feed/tiers" }); }
    const lim = Math.min(Math.max(1, Number(req.query.limit ?? q.max_page) | 0 || q.max_page), q.max_page);
    try {
      const page = endpoint === "listings" ? await F.exportPage(cursorIn, lim) : await F.changesPage(Number(cursorIn), lim);
      const items = endpoint === "listings" ? (page as any).items.length : (page as any).changes.length;
      await F.logUsage({ wallet: w, period_id: q.period_id, endpoint, status: 200, cursor_in: cursorIn, cursor_out: endpoint === "listings" ? (page as any).next_cursor : String((page as any).next_since), items,
        catalogue_seq: endpoint === "listings" ? (page as any).catalogue_seq : (page as any).head_seq, ip: clientIp(req) });
      res.set("X-Feed-Quota-Remaining", String(q.quota - q.used));
      res.json({ ...page, limit: lim, quota: { tier: q.tier, used: q.used, remaining: q.quota - q.used, period_ends_at: q.ends_at } });
    } catch (e) { fail(res, e); }   // quota already consumed: no refunds (validated inputs above make this an internal error only)
  };
  app.get("/v1/feed/listings", limit("feed", 600), feedAuth, feedServe("listings"));
  app.get("/v1/feed/changes", limit("feed", 600), feedAuth, feedServe("changes"));
  app.get("/v1/feed/me", limit("feed", 600), feedAuth, async (_req, res) => res.json(await (await import("./feed")).feedSummary(res.locals.feedWallet)));
  app.use((req, res) => { res.status(404).json({ error: "not_found", message: `no route ${req.method} ${req.path}` }); });
  app.use((e: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = e?.status ?? e?.statusCode ?? 500; res.locals.error = String(e?.message ?? e);
    res.status(status).json({ error: e?.type === "entity.parse.failed" ? "invalid_json" : e?.code && typeof e.code === "string" && /^[a-z_]+$/.test(e.code) ? e.code : ERROR_CODES[status] ?? "internal_error", message: status >= 500 ? "internal error" : String(e?.message ?? e) });
  });
  return app;
}
/** Default machine codes by HTTP status (used when a handler only supplied a human message). */
export const ERROR_CODES: Record<number, string> = { 400: "validation", 401: "unauthorized", 402: "payment_required", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "payload_too_large", 422: "unprocessable", 429: "rate_limited", 500: "internal_error", 502: "bad_gateway", 503: "unavailable" };
const CODE_RE = /^[a-z][a-z0-9_]*$/;
/** Normalise every JSON error body to {error: <code>, message, ...rest}. Handlers may send {error: code, message},
 *  {error: message, code} (portal helpers) or legacy {error: message}; the code then defaults from the status. */
function errorShape(): express.RequestHandler {
  return (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: any) => {
      if (res.statusCode >= 400 && body && typeof body === "object" && !Array.isArray(body) && "error" in body) {
        const { error, code, message, ...rest } = body;
        const isCode = typeof error === "string" && CODE_RE.test(error) && message !== undefined;
        const lead = !isCode && typeof error === "string" ? /(?:^|:\s)([a-z][a-z0-9]*_[a-z0-9_]+)(?::|$)/.exec(error)?.[1] : undefined;   // "tos_missing: ..." => tos_missing
        const c = isCode ? error : typeof code === "string" && CODE_RE.test(code) ? code : lead ?? ERROR_CODES[res.statusCode] ?? "error";
        const m = isCode ? String(message) : String(message ?? error ?? c);
        if (res.statusCode >= 500) {   // never leak exception / SQL / RPC text: log it, send a generic body
          console.error(`${res.statusCode} ${_req.method} ${_req.path}`, res.locals.request_id ?? "", m, Object.keys(rest).length ? JSON.stringify(rest).slice(0, 2000) : "");
          res.locals.error = m;
          const explicit = isCode ? error : typeof code === "string" && CODE_RE.test(code) ? code : null;   // a deliberate machine code is kept; message text never is
          return json({ error: explicit ?? ERROR_CODES[res.statusCode] ?? "internal_error", message: "internal error", ...(rest.request_id ? { request_id: rest.request_id } : {}) });
        }
        return json({ error: c, message: m, ...rest });
      }
      return json(body);
    };
    next();
  };
}
/** Serves the portal front end (PORTAL_APP_DIR, default ../botiny-brand/portal-app) at /portal: only *.html and assets/. */
function portalStatic(): express.RequestHandler {
  const { resolve, join: pj } = require("node:path");
  const dir = resolve(process.env.PORTAL_APP_DIR ?? pj(__dirname, "..", "..", "..", "botiny-brand", "portal-app"));
  const stat = express.static(dir, { index: "index.html", dotfiles: "deny", fallthrough: true, maxAge: 0 });
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path !== "/" && !/^\/[A-Za-z0-9_-]+\.html$/.test(req.path) && !/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|svg|png|ico|woff2?)$/.test(req.path)) return next();
    res.set("X-Content-Type-Options", "nosniff").set("Referrer-Policy", "same-origin").set("X-Frame-Options", "DENY");
    stat(req, res, next);
  };
}

/** x402 + ToS gate: 402 with accepts (one per active EVM chain) + ToS; ToS acceptance must be bound into the EIP-3009 nonce. */
async function paymentGate(req: express.Request, res: express.Response, kind: TosKind, route: string, params: unknown, amount: bigint, description: string, extra?: Record<string, unknown> | null, force402 = false) {
  const base = publicBase(req);
  const tos = await tosInfo(kind, base);
  const acc = await accepts(base + route, amount, description, tos);
  const fail = (error: string) => { res.locals.error = error; res.status(402).json({ x402Version: 1, error, accepts: acc, tos, ...(extra ?? {}) }); return null; };
  if (force402) return fail("insufficient search credit");
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
