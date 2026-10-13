import type { RequestHandler } from "express";
import { timingSafeEqual, createHash } from "node:crypto";

// Admin auth (dashboard + /v1/admin/*): HTTP Basic over ngrok TLS, hardened (security audit item 8):
//  - fails closed when DASHBOARD_PASSWORD is missing or weak (< 16 chars or < 3 character classes);
//  - per-IP lockout: ADMIN_LOCK_FAILS (10) failures within 15 min => 429 for 15 min; plus a global failure budget
//    (ADMIN_GLOBAL_FAILS, 200/hour) => new attempts get 429 until the window resets (successful logins still pass);
//  - CSRF: Basic credentials are replayed by browsers automatically, so state-changing requests (non GET/HEAD) from a
//    browser must be same-origin (Sec-Fetch-Site / Origin) and carry X-Botiny-Client (the same rule as portal cookie
//    sessions). Non-browser clients (curl, scripts) send no Sec-Fetch-* / Origin and are unaffected;
//  - no-store / anti-framing headers on every admin response.
const fails = new Map<string, { n: number; reset: number; lockedUntil: number }>();
let global = { n: 0, reset: 0 };
const WIN = 15 * 60_000;
export const _resetAdminLockout = () => { fails.clear(); global = { n: 0, reset: 0 }; };
export function passwordStrong(p: string | undefined) {
  if (!p || p.length < 16) return false;
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length >= 3;
}
let warned = false;
export function basicAuth(): RequestHandler {
  return (req, res, next) => {
    res.set("Cache-Control", "no-store").set("X-Frame-Options", "DENY").set("Content-Security-Policy", "frame-ancestors 'none'").set("X-Content-Type-Options", "nosniff").set("Referrer-Policy", "same-origin");
    const user = process.env.DASHBOARD_USER || "admin", pass = process.env.DASHBOARD_PASSWORD;
    const deny = () => res.set("WWW-Authenticate", 'Basic realm="bot-rec-market"').status(401).json({ error: "auth required" });
    if (!passwordStrong(pass)) { if (!warned) { console.error("admin auth disabled: DASHBOARD_PASSWORD missing or weak (need >= 16 chars, 3 classes)"); warned = true; } return deny(); }
    const ip = String(req.ip ?? req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const now = Date.now(); let f = fails.get(ip);
    if (f && f.reset <= now && f.lockedUntil <= now) { fails.delete(ip); f = undefined; }
    if (f && f.lockedUntil > now) { res.set("Retry-After", String(Math.ceil((f.lockedUntil - now) / 1000))); return res.status(429).json({ error: "rate_limited", message: "too many failed admin logins from this address; try again later" }); }
    const m = /^Basic (.+)$/.exec(req.get("authorization") ?? "");
    const got = Buffer.from(m?.[1] ?? "", "base64"), want = Buffer.from(`${user}:${pass}`);
    // compare digests so length differences don't short-circuit timing
    const ok = !!m && timingSafeEqual(createHash("sha256").update(got).digest(), createHash("sha256").update(want).digest()) && got.length === want.length;
    if (!ok) {
      if (!m) return deny();   // no credentials offered: the browser prompt, not a failure
      if (global.reset <= now) global = { n: 0, reset: now + 60 * 60_000 };
      if (++global.n > Number(process.env.ADMIN_GLOBAL_FAILS ?? 200)) { res.set("Retry-After", String(Math.ceil((global.reset - now) / 1000))); return res.status(429).json({ error: "rate_limited", message: "admin login temporarily locked" }); }
      f ??= { n: 0, reset: now + WIN, lockedUntil: 0 }; f.n++;
      if (f.n >= Number(process.env.ADMIN_LOCK_FAILS ?? 10)) { f.lockedUntil = now + WIN; console.warn(`admin lockout for ${ip} after ${f.n} failures`); }
      fails.set(ip, f);
      return deny();
    }
    fails.delete(ip);
    if (req.method !== "GET" && req.method !== "HEAD") {
      const site = req.get("sec-fetch-site"), origin = req.get("origin");
      const host = req.get("x-forwarded-host") ?? req.get("host") ?? "";
      const crossSite = (site && site !== "same-origin" && site !== "none") || (origin && origin !== "null" && (() => { try { return new URL(origin).host !== host; } catch { return true; } })()) || origin === "null";
      const browser = !!(site || origin);   // Sec-Fetch-Mode alone is sent by Node/undici fetch too, so it is not a browser signal
      if (crossSite || (browser && !req.get("X-Botiny-Client"))) return res.status(403).json({ error: "csrf", message: "cross-site or header-less browser write refused: send X-Botiny-Client from the same origin" });
    }
    next();
  };
}
