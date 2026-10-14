// MCP server for Botiny search (streamable HTTP transport, stateless JSON responses) mounted at POST /mcp.
// Auth: Authorization: Bearer bck_... (prepaid search-credit key). botiny_search runs the SAME transaction as a credit-paid
// POST /v1/recommend (executeSearch), so every MCP search is logged with its response hash, impressions and credit debit,
// and replays through /v1/requests/:id/replay. Testnet only.
import express from "express";
import { randomUUID } from "node:crypto";
import { pool } from "./db";
import { creditAccountByKey, creditBalance, creditSummary } from "./credits";
import { currentSettings } from "./settings";
import { normalizeInput } from "./rank";
import { activeBans, clientIp } from "./bans";
import { rateLimit } from "./portal";

export const MCP_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_TOOLS = [
  { name: "botiny_search", title: "Search Botiny",
    description: "Ranked bot-service recommendations (x402 APIs, MCP servers, agents). Debits one query from your prepaid credit balance; results labelled Sponsored are paid placements. Returns request_id + response_hash (verifiable via GET /v1/requests/{id}/replay).",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "what the bot needs" }, k: { type: "integer", minimum: 1, maximum: 20, default: 5 } }, required: ["query"], additionalProperties: false } },
  { name: "botiny_listing", title: "Listing details", description: "Full details of one catalogue listing by listing_id (no credit debit).",
    inputSchema: { type: "object", properties: { listing_id: { type: "string" } }, required: ["listing_id"], additionalProperties: false } },
  { name: "botiny_credit_balance", title: "Credit balance", description: "Your prepaid search-credit balance, queries remaining and recent usage (no credit debit).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
const topupHint = async (base: string) => { const { settings: S } = await currentSettings();
  return { topup: base + "/v1/credits/topup", pricing: base + "/v1/credits/pricing", pack_price_atomic: S.credit_pack_price_atomic, queries_per_pack: Math.floor(S.credit_pack_credit_atomic / S.query_price_atomic), query_price_atomic: S.query_price_atomic }; };
const toolError = (data: any) => ({ isError: true, content: [{ type: "text", text: `${data.error}: ${data.message}` }], structuredContent: data });
const toolOk = (data: any) => ({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });

export function mcpHandler(base: (req: express.Request) => string): express.RequestHandler {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const origin = req.get("origin");   // streamable-HTTP DNS-rebinding guard: browsers may only call from our own origin
    if (origin) { let ok = false; try { ok = new URL(origin).host === (req.get("x-forwarded-host") ?? req.get("host")) || new URL(origin).host === new URL(base(req)).host; } catch {}
      if (!ok) return res.status(403).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "cross-origin MCP request refused" } }); }
    const msgs = Array.isArray(req.body) ? req.body : [req.body];
    if (!msgs.length || msgs.some(m => !m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string" && !("result" in m || "error" in m)))
      return res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC request" } });
    const out: any[] = [];
    for (const m of msgs) {
      if (m.id === undefined || m.id === null) continue;   // notifications / client responses: acknowledged, no reply
      try { out.push({ jsonrpc: "2.0", id: m.id, result: await dispatch(req, base(req), m.method, m.params ?? {}) }); }
      catch (e: any) { out.push({ jsonrpc: "2.0", id: m.id, error: { code: e?.rpc ?? -32603, message: e?.rpc ? String(e.message) : "internal error" } }); if (!e?.rpc) console.error("mcp", m.method, e?.stack ?? e); }
    }
    if (!out.length) return res.status(202).end();
    res.json(Array.isArray(req.body) ? out : out[0]);
  };
}
const rpcErr = (code: number, message: string) => Object.assign(new Error(message), { rpc: code });

async function dispatch(req: express.Request, base: string, method: string, params: any): Promise<any> {
  switch (method) {
    case "initialize": return { protocolVersion: MCP_PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : MCP_PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: "botiny-search", title: "Botiny search (testnet)", version: "1.0.0" },
      instructions: "Authenticate with your prepaid search-credit key: Authorization: Bearer bck_... Buy credits via x402 at POST /v1/credits/topup (testnet USDC)." };
    case "ping": return {};
    case "tools/list": return { tools: MCP_TOOLS };
    case "tools/call": return callTool(req, base, String(params?.name ?? ""), params?.arguments ?? {});
    default: throw rpcErr(-32601, `method not found: ${method}`);
  }
}

async function callTool(req: express.Request, base: string, name: string, args: any) {
  if (!MCP_TOOLS.some(t => t.name === name)) throw rpcErr(-32602, `unknown tool: ${name}`);
  const ck = /^Bearer (bck_\S+)$/.exec(req.get("authorization") ?? "");
  if (!ck) return toolError({ error: "credit_key_required", message: `send Authorization: Bearer <search-credit key>; buy one via x402 at ${base}/v1/credits/topup`, ...(await topupHint(base)) });
  const acct = await creditAccountByKey(ck[1]);
  if (!acct) return toolError({ error: "credit_key_invalid", message: `unknown or revoked key; top up (rotate_key=1 issues a new key) at ${base}/v1/credits/topup`, ...(await topupHint(base)) });
  const ban = (await activeBans()).find((b: any) => b.kind === "wallet" && b.value === acct.wallet);
  if (ban) return toolError({ error: "banned", message: `wallet banned: ${ban.reason}` });
  const { version: settings_version, settings } = await currentSettings();
  if (name === "botiny_credit_balance") { const s = await creditSummary(acct.wallet, settings.query_price_atomic); return toolOk({ ...s, ledger: s.ledger.slice(0, 10) }); }
  if (name === "botiny_listing") {
    if (typeof args?.listing_id !== "string" || !/^[A-Za-z0-9_:.-]{1,80}$/.test(args.listing_id)) return toolError({ error: "validation", message: "listing_id required" });
    const l = (await pool.query(`SELECT l.listing_id, l.seq::int AS catalogue_seq, l.supersedes, l.name, l.description, l.address, l.kind, l.tags, l.source_url, l.created_at,
        (SELECT n.listing_id FROM listings n WHERE n.supersedes=l.listing_id) AS superseded_by FROM listings l WHERE l.listing_id=$1`, [args.listing_id])).rows[0];
    return l ? toolOk(l) : toolError({ error: "not_found", message: `no listing ${args.listing_id}` });
  }
  // botiny_search
  const inp = normalizeInput(args);
  if (typeof inp === "string") return toolError({ error: "validation", message: inp });
  const peer = String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const exempt = process.env.RL_EXEMPT_LOOPBACK !== "0" && /^(127\.|::1$)/.test(peer) && req.get("x-forwarded-for") == null;
  if (!exempt) try { rateLimit(`recommend:wallet:${acct.wallet}`, Number(process.env.RL_RECOMMEND_WALLET ?? 300), 60_000); } catch (e: any) { return toolError({ error: "rate_limited", message: `retry after ${e?.retryAfter ?? 60}s` }); }
  const price = BigInt(settings.query_price_atomic);
  const insufficient = async () => toolError({ error: "insufficient_credit", message: `credit balance ${await creditBalance(pool, acct.wallet)} < ${price} atomic per query; top up at ${base}/v1/credits/topup (or pay per query via x402 at ${base}/v1/recommend)`,
    balance_atomic: await creditBalance(pool, acct.wallet), required_atomic: Number(price), ...(await topupHint(base)) });
  if ((await creditBalance(pool, acct.wallet)) < Number(price)) return insufficient();
  const { executeSearch, creditPay, botId } = await import("./app");
  const request_id = "req_" + randomUUID();
  const { pay, tos } = await creditPay(acct.wallet, price, request_id);
  try {
    const r = await executeSearch({ request_id, inp, settings_version, settings, pay, tos, credit: { wallet: acct.wallet }, price, bot_id: botId(req) ?? "mcp", channel: "mcp",
      client_req: { ip: clientIp(req), ua: req.get("user-agent") ?? "", acceptLanguage: req.get("accept-language") ?? "" } });
    return toolOk({ request_id, response_hash: r.out.hash, response: r.out.body, click_links: r.click_links,
      payment: { method: "credits", debited_atomic: Number(price), credit_balance_atomic: r.creditAfter, queries_remaining: Math.floor(r.creditAfter! / Number(price)) },
      verify: `${base}/v1/requests/${request_id}/replay` });
  } catch (e: any) { if (e?.insufficientCredit) return insufficient(); throw e; }
}
