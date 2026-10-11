import { BlockList, isIP } from "node:net";
import { getAddress, isAddress } from "viem";
import type express from "express";
import { pool } from "./db";
import { audit } from "./wallets";
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
/** Bans: bot id (self-declared X-Bot-Id: weak), payer wallet and IP/CIDR (strong). Enforced BEFORE the 402/payment step. */
export type BanKind = "bot" | "wallet" | "ip";
export function normalizeBan(kind: string, value: string): string {
  const v = String(value ?? "").trim();
  if (kind === "bot") { if (!/^[A-Za-z0-9._:-]{1,64}$/.test(v)) throw Object.assign(new Error("bot id: 1-64 of [A-Za-z0-9._:-]"), { status: 400 }); return v; }
  if (kind === "wallet") { if (!isAddress(v, { strict: false })) throw Object.assign(new Error("invalid wallet address"), { status: 400 }); return getAddress(v).toLowerCase(); }
  if (kind === "ip") {
    const [ip, bits] = v.split("/"); const fam = isIP(ip);
    if (!fam || (bits !== undefined && !(Number.isInteger(+bits) && +bits >= 0 && +bits <= (fam === 4 ? 32 : 128)))) throw Object.assign(new Error("invalid IP or CIDR"), { status: 400 });
    return v;
  }
  throw Object.assign(new Error("kind must be bot|wallet|ip"), { status: 400 });
}
export async function addBan(b: { kind: BanKind; value: string; reason: string; expires_at?: string | null }, actor: string) {
  if (!b.reason || String(b.reason).trim().length < 3) throw Object.assign(new Error("reason required"), { status: 400 });
  const value = normalizeBan(b.kind, b.value);
  const exp = b.expires_at ? new Date(b.expires_at) : null;
  if (exp && (isNaN(+exp) || exp <= new Date())) throw Object.assign(new Error("expires_at must be a future time"), { status: 400 });
  const r = (await q(`INSERT INTO bans(kind,value,reason,expires_at,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [b.kind, value, String(b.reason).slice(0, 300), exp, actor]))[0];
  await q("INSERT INTO ban_events(ban_id,event,details) VALUES ($1,'created',$2)", [r.ban_id, { actor, kind: b.kind, value, reason: r.reason, expires_at: exp }]);
  await audit(actor, "ban_create", { ban_id: r.ban_id, kind: b.kind, value, reason: r.reason, expires_at: exp });
  return r;
}
export async function revokeBan(id: number, actor: string) {
  const r = (await q("UPDATE bans SET revoked_at=now(), revoked_by=$2 WHERE ban_id=$1 AND revoked_at IS NULL RETURNING *", [id, actor]))[0];
  if (!r) throw Object.assign(new Error("no active ban with that id"), { status: 404 });
  await q("INSERT INTO ban_events(ban_id,event,details) VALUES ($1,'revoked',$2)", [id, { actor }]);
  await audit(actor, "ban_revoke", { ban_id: id, kind: r.kind, value: r.value });
  return r;
}
export const activeBans = () => q("SELECT * FROM bans WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())");
export function clientIp(req: express.Request) {
  // LAST X-Forwarded-For entry = the hop appended by our proxy (ngrok); earlier entries are client-controlled.
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",").map(x => x.trim()).filter(Boolean).pop() ?? "";
  const ip = (xf || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return ip;
}
/** Payer wallet from an X-PAYMENT header without verifying it (mock: "mock:<n>:<0xpayer>"; x402: authorization.from). */
export function payerFromHeader(h?: string): string | null {
  if (!h) return null;
  const m = /^mock:[^:]+:(0x[0-9a-fA-F]{40})$/.exec(h); if (m) return m[1].toLowerCase();
  try { const p = JSON.parse(Buffer.from(h, "base64").toString("utf8")); const f = p?.payload?.authorization?.from; return isAddress(f ?? "", { strict: false }) ? String(f).toLowerCase() : null; } catch { return null; }
}
export async function findBan(req: express.Request) {
  const bans = await activeBans(); if (!bans.length) return null;
  const bot = req.get("X-Bot-Id") ?? null, ip = clientIp(req), wallet = payerFromHeader(req.get("X-PAYMENT"));
  for (const b of bans) {
    if (b.kind === "wallet" && wallet && b.value === wallet) return { ban: b, matched: wallet };
    if (b.kind === "ip" && ip && isIP(ip)) {
      const bl = new BlockList(); const [a, bits] = b.value.split("/"); const fam = isIP(a) === 6 ? "ipv6" : "ipv4";
      if (fam !== (isIP(ip) === 6 ? "ipv6" : "ipv4")) continue;
      if (bits !== undefined) bl.addSubnet(a, Number(bits), fam); else bl.addAddress(a, fam);
      if (bl.check(ip, fam)) return { ban: b, matched: ip };
    }
    if (b.kind === "bot" && bot && b.value === bot) return { ban: b, matched: bot };
  }
  return null;
}
/** Middleware: 403 with reason before any 402 / payment verification / settlement. */
export function banGuard(): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const hit = await findBan(req);
      if (!hit) return next();
      await q("UPDATE bans SET blocked_count=blocked_count+1, last_blocked_at=now() WHERE ban_id=$1", [hit.ban.ban_id]);
      await q("INSERT INTO ban_events(ban_id,event,details) VALUES ($1,'blocked',$2)", [hit.ban.ban_id, { route: req.path, matched: hit.matched, bot: req.get("X-Bot-Id") ?? null, ip: clientIp(req) }]);
      res.locals.error = `banned (${hit.ban.kind})`;
      res.status(403).json({ error: "forbidden: banned", ban: { id: hit.ban.ban_id, kind: hit.ban.kind, reason: hit.ban.reason, expires_at: hit.ban.expires_at } });
    } catch (e) { next(e); }
  };
}
