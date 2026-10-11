import express from "express";
import { pool } from "./db";
import { currentSettings, saveSettings } from "./settings";
import { createAdvertiser, credit, setBid } from "./market";
import { MODE } from "./payment";
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
        WHERE NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id) ORDER BY (a.advertiser_id IS NULL), l.provider_id, l.seq`),
      bid_events: await q("SELECT seq::int, listing_id, bid_atomic::int, paused, set_by, created_at FROM listing_bid_events ORDER BY seq DESC LIMIT 30"),
    });
  });
  r.post("/api/admin/settings", async (req, res) => {
    try { res.json(await saveSettings(req.body?.settings ?? {}, req.body?.note ?? null)); } catch (e) { fail(res, e); }
  });
  r.post("/api/admin/advertisers", async (req, res) => {
    try { res.status(201).json(await createAdvertiser(String(req.body?.advertiser_id ?? ""), String(req.body?.name ?? ""))); } catch (e) { fail(res, e); }
  });
  r.post("/api/admin/advertisers/:id/credit", async (req, res) => {
    try {
      const ok = (await q("SELECT 1 FROM advertisers WHERE advertiser_id=$1", [req.params.id])).length; if (!ok) return res.status(404).json({ error: "no such advertiser" });
      res.json(await credit(req.params.id, Number(req.body?.amount_atomic), "admin_credit", { note: req.body?.note ?? "manual test credit (no funds moved)" }));
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
        r2 = await fetch(url, init);
      } else {
        const raw = process.env.PAYER_PRIVATE_KEY;
        if (!raw) return res.status(503).json({ error: "PAYER_PRIVATE_KEY not configured on the server" });
        const { createWalletClient, http, publicActions } = await import("viem");
        const { privateKeyToAccount } = await import("viem/accounts");
        const { baseSepolia } = await import("viem/chains");
        const { wrapFetchWithPayment } = await import("x402-fetch");
        const account = privateKeyToAccount((raw.startsWith("0x") ? raw : "0x" + raw) as `0x${string}`);
        const wallet = createWalletClient({ account, chain: baseSepolia, transport: http("https://sepolia.base.org") }).extend(publicActions);
        if (wallet.chain.id !== 84532) return res.status(500).json({ error: "refusing: not Base Sepolia" });
        const selector = (reqs: any[]) => {
          const x = reqs.find(x => x.scheme === "exact" && x.network === "base-sepolia" && x.asset?.toLowerCase() === USDC.toLowerCase() && BigInt(x.maxAmountRequired) <= 10_000n);
          if (!x) throw new Error("no acceptable testnet requirement (≤0.01 USDC)"); return x;
        };
        r2 = await wrapFetchWithPayment(fetch, wallet as any, 10_000n, selector as any)(url, init);
      }
      const body: any = await r2.json().catch(() => ({}));
      const row = body.request_id ? (await q(`SELECT payment_amount_atomic::text amount_atomic, payment_status, settle_tx, payer, payment_mode FROM requests WHERE request_id=$1`, [body.request_id]))[0] : null;
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
  return r;
}
