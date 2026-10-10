import type { RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
/** HTTP basic auth (user DASHBOARD_USER||admin, pass DASHBOARD_PASSWORD). Fails closed if no password configured. */
export function basicAuth(): RequestHandler {
  return (req, res, next) => {
    const user = process.env.DASHBOARD_USER || "admin", pass = process.env.DASHBOARD_PASSWORD;
    const deny = () => res.set("WWW-Authenticate", 'Basic realm="bot-rec-market"').status(401).json({ error: "auth required" });
    if (!pass) return deny();
    const m = /^Basic (.+)$/.exec(req.get("authorization") ?? ""); if (!m) return deny();
    const got = Buffer.from(m[1], "base64"), want = Buffer.from(`${user}:${pass}`);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return deny();
    next();
  };
}
