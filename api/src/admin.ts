import express from "express";
import { pool } from "./db";
import { currentSettings, saveSettings } from "./settings";
import { createAdvertiser, credit, setBid } from "./market";
import { MODE } from "./payment";
import { audit, actorOf, payToState, setPayTo, rotateRelayer, GRACE_SEC } from "./wallets";
import { addBan, revokeBan } from "./bans";
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const fail = (res: express.Response, e: any) => res.status(e?.status ?? (e?.code === "23505" ? 409 : 500)).json({ error: String(e?.message ?? e) });
export const SIM_BOTS = ["research-bot", "dev-bot"];
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export function adminRouter() {
  const r = express.Router();
  r.get("/api/admin/state", async (_q2, res) => {
    const cur = await currentSettings();
    res.json({
      settings: cur,
      history: await q("SELECT version, settings, changed_by, note, created_at FROM settings_versions ORDER BY version DESC LIMIT 30"),
      advertisers: await q(`SELECT a.advertiser_id, a.name, a.created_at,
          COALESCE(SUM(b.delta_atomic),0)::text balance,
          COALESCE(SUM(b.delta_atomic) FILTER (WHERE b.kind='topup_x402'),0)::text topups_onchain,
          COALESCE(SUM(b.delta_atomic) FILTER (WHERE b.kind='admin_credit'),0)::text admin_credits,
          COALESCE(-SUM(b.delta_atomic) FILTER (WHERE b.kind='impression_debit'),0)::text spend,
          COUNT(b.*) FILTER (WHERE b.kind='impression_debit')::int sponsored_impressions
        FROM advertisers a LEFT JOIN balance_ledger b USING (advertiser_id) GROUP BY 1,2,3 ORDER BY 1`),
      listings: await q(`SELECT l.listing_id, l.provider_id, l.name, l.kind,
          COALESCE(e.bid_atomic,0)::int bid_atomic, COALESCE(e.paused,false) paused, (a.advertiser_id IS NOT NULL) has_account
        FROM listings l LEFT JOIN advertisers a ON a.advertiser_id=l.provider_id
        LEFT JOIN LATERAL (SELECT bid_atomic, paused FROM listing_bid_events x WHERE x.listing_id=l.listing_id ORDER BY seq DESC LIMIT 1) e ON true
        WHERE NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id) AND (l.crawl_item_id IS NULL OR a.advertiser_id IS NOT NULL)
        ORDER BY (a.advertiser_id IS NULL), l.provider_id, l.seq`),
      bid_events: await q("SELECT seq::int, listing_id, bid_atomic::int, paused, set_by, created_at FROM listing_bid_events ORDER BY seq DESC LIMIT 30"),
    });
  });
  r.post("/api/admin/settings", async (req, res) => {
    try { const r = await saveSettings(req.body?.settings ?? {}, req.body?.note ?? null); await audit(actorOf(req.headers.authorization), "settings_save", { version: (r as any).version, note: req.body?.note ?? null }); res.json(r); } catch (e) { fail(res, e); }
  });
  r.post("/api/admin/advertisers", async (req, res) => {
    try { res.status(201).json(await createAdvertiser(String(req.body?.advertiser_id ?? ""), String(req.body?.name ?? ""))); } catch (e) { fail(res, e); }
  });
  r.post("/api/admin/advertisers/:id/credit", async (req, res) => {
    try {
      const ok = (await q("SELECT 1 FROM advertisers WHERE advertiser_id=$1", [req.params.id])).length; if (!ok) return res.status(404).json({ error: "no such advertiser" });
      const c = await credit(req.params.id, Number(req.body?.amount_atomic), "admin_credit", { note: req.body?.note ?? "manual test credit (no funds moved)" });
      await audit(actorOf(req.headers.authorization), "advertiser_credit", { advertiser_id: req.params.id, amount_atomic: Number(req.body?.amount_atomic) }); res.json(c);
    } catch (e) { fail(res, e); }
  });
  r.post("/api/admin/listings/:lid", async (req, res) => {
    try { res.json(await setBid(req.params.lid, { bid_atomic: req.body?.bid_atomic, paused: req.body?.paused }, "admin")); } catch (e) { fail(res, e); }
  });

  // ---------- "Try a search" as a simulator bot: server-side REAL x402 payment (testnet, capped) ----------
  r.post("/api/try", async (req, res) => {
    const bot = String(req.body?.bot_id ?? ""), query = String(req.body?.query ?? ""), k = Number(req.body?.k ?? 5);
    if (!SIM_BOTS.includes(bot)) return res.status(400).json({ error: "bot_id must be one of " + SIM_BOTS.join(", ") });
    const url = `http://127.0.0.1:${req.socket.localPort}/v1/recommend`;
    const init = { method: "POST", headers: { "content-type": "application/json", "X-Bot-Id": bot } as Record<string, string>, body: JSON.stringify({ query, k }) };
    try {
      let r2: Response;
      if (MODE === "mock") {
        init.headers["X-PAYMENT"] = `mock:try${Date.now()}${Math.floor(Math.random() * 1e6)}`;
        init.headers["X-TOS-ACCEPT"] = (await (await import("./tos")).currentTos("bot")).sha256;
        r2 = await fetch(url, init);
      } else {
        const raw = process.env.PAYER_PRIVATE_KEY;
        if (!raw) return res.status(503).json({ error: "PAYER_PRIVATE_KEY not configured on the server" });
        const { privateKeyToAccount } = await import("viem/accounts");
        const { paidFetch } = await import("./payclient");
        const account = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
        r2 = (await paidFetch(url, "/v1/recommend", { query, k }, init.body, { account, networks: ["base-sepolia"], maxAmount: 10_000n, headers: { "X-Bot-Id": bot } })).res;
      }
      const body: any = await r2.json().catch(() => ({}));
      const row = body.request_id ? (await q(`SELECT payment_amount_atomic::text amount_atomic, payment_status, settle_tx, payer, payment_mode, payment_network, settle_via, tos_version, tos_hash FROM requests WHERE request_id=$1`, [body.request_id]))[0] : null;
      res.status(r2.status === 200 ? 200 : 502).json({ status: r2.status, bot_id: bot, ...body, payment: row });
    } catch (e: any) { res.status(502).json({ error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) }); }
  });
  r.get("/api/bots/:bot/history", async (req, res) => { const { pageArgs } = await import("./dashboard"); const pg = pageArgs(req.query, 2); pg.limit = Math.min(pg.limit, Number(req.query.limit) || 25); const rows = await q(
    `SELECT r.request_id, r.received_at, r.request_canonical::json->>'query' AS query, r.payment_status, r.settle_tx, r.settle_error, r.response_hash,
            r.payment_amount_atomic::text amount_atomic, r.settings_version,
            (SELECT json_agg(json_build_object('rank',x->'rank','name',x->'name','sponsored',COALESCE((x->>'sponsored')::bool,false)) ORDER BY (x->>'rank')::int)
               FROM json_array_elements(r.response_canonical::json->'results') x) AS results
       FROM requests r WHERE r.bot_id=$1${pg.where} ORDER BY r.received_at DESC, r.request_id DESC LIMIT ${pg.limit}`, [req.params.bot, ...pg.params]);
    if (rows.length === pg.limit) res.set("X-Next-Before", new Date(rows[rows.length - 1].received_at).toISOString());
    res.json(rows); });
  // ---------- Wallets (public addresses only; keys never leave the server) ----------
  r.get("/api/admin/wallets", async (_q2, res) => {
    const { relayerAddress, gasStatus, fallbackOn } = await import("./relayer");
    const { PAYER } = await import("./chain");
    res.json({ pay_to: await payToState(), grace_sec: GRACE_SEC, history: await q("SELECT version, pay_to, changed_by, note, created_at FROM wallet_settings ORDER BY version DESC LIMIT 50"),
      relayer: { address: relayerAddress(), fallback_enabled: fallbackOn(), gas: MODE === "mock" ? [] : await gasStatus().catch(() => []) },
      payer: { address: PAYER, used_by: SIM_BOTS, note: "simulator/test payer; key held only in the sim process environment" } });
  });
  r.post("/api/admin/wallets/payto", async (req, res) => {
    try { res.json(await setPayTo(String(req.body?.address ?? ""), String(req.body?.confirm ?? ""), actorOf(req.headers.authorization), req.body?.note ?? null)); } catch (e) { fail(res, e); }
  });
  r.post("/api/admin/relayer/rotate", async (req, res) => {
    try { res.json(await rotateRelayer({ generate: !!req.body?.generate, private_key: req.body?.private_key, confirm: req.body?.confirm }, actorOf(req.headers.authorization))); } catch (e) { fail(res, e); }
  });
  // ---------- Incentives: pacing + advertiser reports (no refunds; unconsumed at expiry = platform revenue) ----------
  r.get("/api/admin/incentives/report", async (req, res) => {
    const { incentiveReport, reportCsv } = await import("./pacing");
    const adv = typeof req.query.advertiser === "string" && req.query.advertiser ? req.query.advertiser : null;
    const rep = await incentiveReport(pool, adv);
    if (req.query.format === "csv") return res.type("text/csv").set("Content-Disposition", `attachment; filename="incentives-${(adv ?? "all").replace(/\W/g, "_")}.csv"`).send(reportCsv(rep));
    res.json(rep);
  });
  r.get("/api/admin/incentives/pacing", async (_q2, res) => {
    const { incentiveReport } = await import("./pacing");
    const rep = await incentiveReport(pool, null);
    const alerts = rep.offers.filter((o: any) => o.pacing.status === "at_risk" || o.pacing.status === "behind")
      .sort((a: any, b: any) => (a.pacing.status === "at_risk" ? 0 : 1) - (b.pacing.status === "at_risk" ? 0 : 1) || b.pacing.lag_ppm - a.pacing.lag_ppm);
    const counts: Record<string, number> = {}; for (const o of rep.offers) counts[o.pacing.status] = (counts[o.pacing.status] ?? 0) + 1;
    const rev = (await q("SELECT COALESCE(SUM(amount_atomic),0)::text s FROM incentive_pool_ledger WHERE kind='expired_revenue'"))[0].s;
    res.json({ counts, alerts, platform_expired_revenue_atomic: Number(rev), policy: rep.policy });
  });
  // ---------- Bans ----------
  r.get("/api/admin/bans", async (_q2, res) => res.json({
    bans: await q(`SELECT *, (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS active FROM bans ORDER BY active DESC, ban_id DESC LIMIT 200`),
    events: await q("SELECT e.*, b.kind, b.value FROM ban_events e JOIN bans b USING (ban_id) ORDER BY e.id DESC LIMIT 100"),
    blocked_24h: (await q("SELECT count(*)::int n FROM ban_events WHERE event='blocked' AND at > now() - interval '24 hours'"))[0].n,
    note: "X-Bot-Id is self-declared (weak); wallet and IP/CIDR bans are the strong ones." }));
  r.post("/api/admin/bans", async (req, res) => {
    try { res.status(201).json(await addBan({ kind: req.body?.kind, value: req.body?.value, reason: req.body?.reason, expires_at: req.body?.expires_at || null }, actorOf(req.headers.authorization))); } catch (e) { fail(res, e); }
  });
  r.post("/api/admin/bans/:id/revoke", async (req, res) => { try { res.json(await revokeBan(Number(req.params.id), actorOf(req.headers.authorization))); } catch (e) { fail(res, e); } });
  r.get("/api/admin/audit", async (_q2, res) => res.json(await q("SELECT * FROM admin_audit ORDER BY id DESC LIMIT 300")));
  // ---------- Terms of Service (DRAFT placeholder; each save = new version) ----------
  r.get("/api/admin/tos", async (_q2, res) => {
    const { currentTos, tosHistory } = await import("./tos");
    res.json({ bot: { current: await currentTos("bot"), history: await tosHistory("bot") }, advertiser: { current: await currentTos("advertiser"), history: await tosHistory("advertiser") } });
  });
  r.post("/api/admin/tos", async (req, res) => {
    const { saveTos } = await import("./tos");
    const kind = req.body?.kind; if (kind !== "bot" && kind !== "advertiser") return res.status(400).json({ error: "kind must be bot|advertiser" });
    try { const t = await saveTos(kind, String(req.body?.body ?? ""), req.body?.note ?? null); await audit(actorOf(req.headers.authorization), "tos_save", { kind, version: t.version, sha256: t.sha256 }); res.json(t); } catch (e) { fail(res, e); }
  });
  return r;
}
