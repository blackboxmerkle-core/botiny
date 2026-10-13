// Human portal API: SIWE (EIP-4361) sign-in + short-lived sessions, advertiser wallet<->API-key link, bot-owner
// monitoring scoped to the signed-in wallet(s), listing suggestions (public submit + admin review -> crawler queue),
// advertiser campaign views (campaign = listing bid + incentive offer; no campaign table). Read-only w.r.t. ranking:
// nothing here writes rank/hash inputs except via the existing setBid/setIncentive/insertListing paths.
import express from "express";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { getAddress, isAddress, verifyMessage } from "viem";
import { parseSiweMessage, validateSiweMessage } from "viem/siwe";
import { pool } from "./db";
import { sha256 } from "./canonical";
import { CHAINS } from "./chains";
import { audit } from "./wallets";
import { advertiserByKey, balanceOf, setBid, setIncentive } from "./market";
import { currentSettings } from "./settings";
import { activeBans, clientIp } from "./bans";
import { assertPublicHost } from "../../crawler/src/suggest";

const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
const err = (status: number, message: string, code?: string) => Object.assign(new Error(message), { status, code });
const fail = (res: express.Response, e: any) => { res.locals.error = String(e?.message ?? e); res.status(e?.status ?? 500).json({ error: String(e?.message ?? e), ...(e?.code ? { code: e.code } : {}) }); };
const h = (fn: (req: express.Request, res: express.Response) => Promise<any>) => async (req: express.Request, res: express.Response) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

export const NONCE_TTL_MS = 5 * 60_000, SESSION_TTL_MS = 60 * 60_000;
export const COOKIE = "botiny_session";
export const ROLES = ["bot_owner", "advertiser"] as const;
const TESTNET_IDS = new Set(CHAINS.filter(c => c.testnet && c.enabled).map(c => c.chainId));   // mainnet hard-disabled
export const SIWE_STATEMENT = "Sign in to Botiny (testnet). This request will not trigger a blockchain transaction or cost any gas.";

// ---------- rate limiting (in-process fixed window) ----------
const buckets = new Map<string, { n: number; reset: number }>();
export const _resetRateLimits = () => buckets.clear();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  if (++b.n > max) throw Object.assign(err(429, "rate limited", "rate_limited"), { retryAfter: Math.ceil((b.reset - now) / 1000) });
}
const limited = (res: express.Response, e: any) => { if (e?.retryAfter) res.set("Retry-After", String(e.retryAfter)); fail(res, e); };

// ---------- SIWE ----------
function siweDomains(req: express.Request) {
  const d = new Set<string>();
  // SIWE_DOMAIN (comma list, e.g. "botiny.si,app.botiny.si") pins the accepted EIP-4361 domain(s); else the PUBLIC_BASE_URL host.
  const pinned = (process.env.SIWE_DOMAIN ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (pinned.length) return new Set(pinned);
  const pub = process.env.PUBLIC_BASE_URL; if (pub) try { d.add(new URL(pub).host); } catch {}
  for (const x of (process.env.SIWE_EXTRA_DOMAINS ?? "").split(",").map(s => s.trim()).filter(Boolean)) d.add(x);
  if (!d.size && req.get("host")) d.add(String(req.get("host")));    // dev/test only: no configured public origin
  return d;
}
/** 128 bits from crypto.randomBytes, hex (EIP-4361: alphanumeric, >= 8 chars). Independent per call. */
export const newNonceValue = () => randomBytes(16).toString("hex");
async function newNonce() {
  // NOT viem's generateSiweNonce(): it is uid(96), a 256-byte Math.random() hex buffer read through a window that slides
  // by ONE char per call, so consecutive nonces overlap by 95 chars (predictable). Independent 128-bit CSPRNG value instead.
  const nonce = newNonceValue(), exp = new Date(Date.now() + NONCE_TTL_MS);
  await q("INSERT INTO siwe_nonces(nonce, expires_at) VALUES ($1,$2)", [nonce, exp]);
  if (Math.random() < 0.05) await q("DELETE FROM siwe_nonces WHERE expires_at < now() - interval '1 day'");
  return { nonce, expires_at: exp.toISOString() };
}
/** Verify an EIP-4361 message + EOA signature; consumes the nonce exactly once. Returns lowercase address + parsed fields. */
export async function verifySiwe(req: express.Request, message: unknown, signature: unknown, usedBy: string) {
  if (typeof message !== "string" || message.length > 4000) throw err(400, "message (EIP-4361 string) required", "bad_message");
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) throw err(400, "signature (0x hex) required", "bad_signature");
  let m: ReturnType<typeof parseSiweMessage>;
  try { m = parseSiweMessage(message); } catch { throw err(400, "unparseable SIWE message", "bad_message"); }
  if (!m.address || !m.domain || !m.nonce || !m.uri || m.version !== "1" || !m.chainId || !m.issuedAt) throw err(400, "SIWE message missing required fields", "bad_message");
  const domains = siweDomains(req);
  if (!domains.has(m.domain)) throw err(401, `domain mismatch (expected ${[...domains].join(" | ")})`, "domain_mismatch");
  try { if (!domains.has(new URL(m.uri).host)) throw 0; } catch { throw err(401, "uri must be on the signing domain", "uri_mismatch"); }
  if (!TESTNET_IDS.has(m.chainId)) throw err(400, `chain_id ${m.chainId} not allowed (testnets only; mainnet disabled)`, "chain_not_allowed");
  if (+m.issuedAt > Date.now() + 5 * 60_000) throw err(401, "issued-at is in the future", "bad_message");
  if (!validateSiweMessage({ message: m, time: new Date() })) throw err(401, "message expired or not yet valid", "message_expired");
  let ok = false;
  try { ok = await verifyMessage({ address: m.address, message, signature: signature as `0x${string}` }); } catch { ok = false; }
  if (!ok) throw err(401, "signature does not match address", "bad_signature");
  const n = await q("UPDATE siwe_nonces SET used_at=now(), used_by=$2 WHERE nonce=$1 AND used_at IS NULL AND expires_at > now() RETURNING nonce", [m.nonce, usedBy]);
  if (!n.length) throw err(401, "nonce unknown, expired or already used", "nonce_expired");
  return { address: getAddress(m.address).toLowerCase(), chain_id: m.chainId, resources: m.resources ?? [], m };
}

// ---------- sessions ----------
export interface Session { address: string; roles: string[]; chain_id: number; expires_at: string; token_hash: string; via: "cookie" | "bearer" }
function readCookie(req: express.Request, name: string) {
  for (const p of String(req.headers.cookie ?? "").split(";")) { const [k, ...v] = p.trim().split("="); if (k === name) return decodeURIComponent(v.join("=")); }
  return null;
}
export async function sessionOf(req: express.Request): Promise<Session | null> {
  const bm = /^Bearer (bts_[A-Za-z0-9_-]{20,})$/.exec(req.get("authorization") ?? "");
  const tok = bm?.[1] ?? readCookie(req, COOKIE); if (!tok || !tok.startsWith("bts_")) return null;
  const r = (await q("SELECT address, roles, chain_id, expires_at FROM portal_sessions WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()", [sha256(tok)]))[0];
  return r ? { address: r.address, roles: r.roles, chain_id: r.chain_id, expires_at: new Date(r.expires_at).toISOString(), token_hash: sha256(tok), via: bm ? "bearer" : "cookie" } : null;
}
/** Session middleware. Cookie-authenticated state-changing calls need X-Botiny-Client (CSRF: forces a CORS preflight). */
export function requireSession(role?: string): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const s = await sessionOf(req);
      if (!s) return res.status(401).json({ error: "sign-in required (SIWE session)", code: "no_session" });
      if (s.via === "cookie" && req.method !== "GET" && !req.get("X-Botiny-Client")) return res.status(403).json({ error: "X-Botiny-Client header required for cookie-authenticated writes", code: "csrf" });
      if (role && !s.roles.includes(role)) return res.status(403).json({ error: `role ${role} required`, code: "role_required" });
      res.locals.session = s; next();
    } catch (e) { fail(res, e); }
  };
}
export async function advertiserOfWallet(address: string): Promise<string | null> {
  return (await q("SELECT advertiser_id FROM advertiser_wallets WHERE address=$1", [address]))[0]?.advertiser_id ?? null;
}
/** Advertiser id for a session token (Bearer bts_... or cookie) with the advertiser role; null otherwise. */
export async function sessionAdvertiser(req: express.Request) {
  const s = await sessionOf(req); if (!s || !s.roles.includes("advertiser")) return null;
  if (s.via === "cookie" && req.method !== "GET" && !req.get("X-Botiny-Client")) return null;
  return advertiserOfWallet(s.address);
}
async function linkKey(address: string, apiKey: unknown) {
  if (typeof apiKey !== "string" || !apiKey) throw err(400, "api_key required", "api_key_invalid");
  const a = await advertiserByKey(apiKey); if (!a) throw err(401, "API key invalid", "api_key_invalid");
  const byAdv = (await q("SELECT address FROM advertiser_wallets WHERE advertiser_id=$1", [a.advertiser_id]))[0];
  if (byAdv && byAdv.address !== address) throw err(409, "API key already linked to another wallet", "api_key_linked_elsewhere");
  const byW = await advertiserOfWallet(address);
  if (byW && byW !== a.advertiser_id) throw err(409, "this wallet is already linked to a different advertiser", "wallet_linked_elsewhere");
  if (!byAdv) { await q("INSERT INTO advertiser_wallets(address, advertiser_id) VALUES ($1,$2)", [address, a.advertiser_id]); await audit("wallet:" + address, "advertiser_wallet_link", { advertiser_id: a.advertiser_id, address }); }
  return a.advertiser_id as string;
}
async function ownedWallets(address: string) {
  return [address, ...(await q("SELECT wallet FROM bot_owner_wallets WHERE owner_address=$1 ORDER BY linked_at", [address])).map(r => r.wallet)];
}
function cookieFor(req: express.Request, token: string, maxAgeMs: number) {
  const secure = (process.env.PUBLIC_BASE_URL ?? "").startsWith("https://") || req.secure;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
}

// ---------- suggestions ----------
export const SUGGESTION_TYPES = ["x402_api", "mcp_server", "agent", "repo", "other"] as const;
export const SUGGESTION_STATES = ["submitted", "queued", "crawling", "needs_review", "indexed", "rejected", "duplicate"] as const;
const OPEN_STATES = ["submitted", "queued", "crawling", "needs_review"];
const BLOCKED_HOST = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|onion|invalid|test|example|arpa)$/i;
/** Syntactic URL validation (SSRF-safe at submit time; the crawler re-checks DNS before fetching). Returns normalised URL or throws 400. */
export function validateSuggestionUrl(raw: unknown): { url: string; norm: string; host: string } {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) throw err(400, "url required (<=2048 chars)", "invalid_url");
  let u: URL; try { u = new URL(raw.trim()); } catch { throw err(400, "url is not a valid absolute URL", "invalid_url"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw err(400, "url must be http(s)", "invalid_url");
  if (u.username || u.password) throw err(400, "url must not contain credentials", "invalid_url");
  if (u.port && !["80", "443"].includes(u.port)) throw err(400, "url port must be 80/443", "invalid_url");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) throw err(400, "IP-address URLs are not accepted; use a hostname", "invalid_url");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host)) throw err(400, "url hostname must be a public DNS name", "invalid_url");
  if (BLOCKED_HOST.test(host) && process.env.SUGGEST_ALLOW_TEST_HOSTS !== "1") throw err(400, "url hostname is not public", "invalid_url");
  u.hash = "";
  const norm = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "") || ""}`;
  return { url: u.toString(), norm, host };
}
function validateSuggestion(b: any) {
  const { url, norm, host } = validateSuggestionUrl(b?.url);
  if (!SUGGESTION_TYPES.includes(b?.type)) throw err(400, `type must be one of ${SUGGESTION_TYPES.join("|")}`, "invalid_type");
  if (typeof b?.name !== "string" || !b.name.trim() || b.name.trim().length > 80) throw err(400, "name required (<=80 chars)", "invalid_name");
  if (b.description != null && (typeof b.description !== "string" || b.description.length > 500)) throw err(400, "description <=500 chars", "invalid_description");
  if (b.contact != null && b.contact !== "" && (typeof b.contact !== "string" || !(/^[^\s@]{1,64}@[^\s@]+\.[a-z]{2,}$/i.test(b.contact) || /^@[A-Za-z0-9_]{1,15}$/.test(b.contact)))) throw err(400, "contact must be an email or @handle", "invalid_contact");
  if (b.claim_wallet != null && b.claim_wallet !== "" && !isAddress(String(b.claim_wallet), { strict: false })) throw err(400, "claim_wallet must be an EVM address", "invalid_claim_wallet");
  return { url, norm, host, type: b.type as string, name: b.name.trim(), description: b.description?.trim() || null, contact: b.contact || null,
    claim_wallet: b.claim_wallet ? String(b.claim_wallet).toLowerCase() : null };
}
export function claimChallenge(s: any) {
  return `Botiny ownership claim\nsuggestion: ${s.suggestion_id}\nurl: ${s.url}\nwallet: ${s.claim_wallet}\ntoken: ${s.claim?.token}`;
}
async function queuePosition(jobId: number | null) {
  if (!jobId) return null;
  return (await q("SELECT count(*)::int n FROM crawl_jobs WHERE status='queued' AND job_id <= $1", [jobId]))[0].n;
}
async function suggestionView(s: any, owner: boolean) {
  const detail: any = { ...(s.detail ?? {}) };
  if (s.state === "queued") detail.position = await queuePosition(s.crawl_job_id);
  const pub = { id: s.suggestion_id, url: s.url, type: s.type, name: s.name, state: s.state, detail, reason: s.reason ?? null,
    duplicate_of: s.duplicate_of ?? null, listing_id: s.listing_id ?? null, submitted_at: s.created_at, updated_at: s.updated_at };
  if (!owner) return pub;
  return { ...pub, description: s.description, contact: s.contact, claim_wallet: s.claim_wallet, crawl_item_id: s.crawl_item_id,
    claim: s.claim ? { status: s.claim.status, method: s.claim.method ?? null, challenge: s.claim_wallet ? claimChallenge(s) : null, token: s.claim.token,
      instructions: { dns_txt: `_botiny.<host> TXT "botiny-claim=${s.claim.token}"`, well_known: `https://<host>/.well-known/botiny.json {"claims":[{"wallet":"${s.claim_wallet}","token":"${s.claim.token}"}]}`, repo_file: `botiny.json at the repo root (same JSON)` },
      error: s.claim.error ?? null, checked_at: s.claim.checked_at ?? null } : null };
}
export async function createSuggestion(body: any, submitter: string | null, ip: string) {
  const v = validateSuggestion(body);
  const claim_wallet = v.claim_wallet ?? (body?.claim_wallet === undefined && submitter ? submitter : null);
  const id = "sug_" + randomUUID().replace(/-/g, "").slice(0, 20);
  // duplicate detection: existing (non-superseded) listing at the same URL, or an open suggestion for it
  const dupItem = (await q(`SELECT i.published_listing_id FROM crawl_item_keys k JOIN crawl_items i USING (item_id) WHERE k.key=$1 AND i.published_listing_id IS NOT NULL LIMIT 1`, ["url:" + v.norm]))[0];
  const dupListing = dupItem?.published_listing_id ?? (await q(`SELECT l.listing_id FROM listings l WHERE rtrim(l.address,'/') IN ($1,$2) AND NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id) ORDER BY seq LIMIT 1`, [v.norm, v.url.replace(/\/$/, "")]))[0]?.listing_id;
  const dupSug = dupListing ? null : (await q(`SELECT suggestion_id FROM listing_suggestions WHERE url_norm=$1 AND state = ANY($2) ORDER BY created_at LIMIT 1`, [v.norm, OPEN_STATES]))[0]?.suggestion_id;
  const state = dupListing || dupSug ? "duplicate" : "submitted";
  const detail = dupListing ? { note: "already in the catalogue" } : dupSug ? { note: "already suggested; being processed" } : { note: "awaiting review" };
  const claim = claim_wallet ? { status: "unclaimed", token: randomBytes(16).toString("hex") } : null;
  const r = (await q(`INSERT INTO listing_suggestions(suggestion_id,url,url_norm,type,name,description,contact,claim_wallet,submitter_address,submitter_ip_hash,state,detail,duplicate_of,claim)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [id, v.url, v.norm, v.type, v.name, v.description, v.contact, claim_wallet, submitter, sha256("ip:" + ip).slice(0, 32), state, detail, dupListing ?? dupSug ?? null, claim]))[0];
  return r;
}
type ClaimChecker = (method: string, s: any, host: string) => Promise<{ ok: boolean; error?: string }>;
let claimChecker: ClaimChecker = defaultClaimCheck;
export const _setClaimChecker = (f: ClaimChecker | null) => { claimChecker = f ?? defaultClaimCheck; };
async function defaultClaimCheck(method: string, s: any, host: string) {
  const token = s.claim.token, wallet = s.claim_wallet;
  
  await assertPublicHost(host);
  const has = (j: any) => Array.isArray(j?.claims) && j.claims.some((c: any) => String(c?.token) === token && String(c?.wallet).toLowerCase() === wallet);
  const getJson = async (u: string) => { const r = await fetch(u, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { "user-agent": "botiny-claim-check/1" } }); if (!r.ok) throw new Error(`HTTP ${r.status} at ${u}`); return JSON.parse((await r.text()).slice(0, 65536)); };
  if (method === "dns_txt") {
    const { resolveTxt } = await import("node:dns/promises");
    const recs = (await resolveTxt(`_botiny.${host}`).catch(() => [])).map(x => x.join(""));
    return recs.includes(`botiny-claim=${token}`) ? { ok: true } : { ok: false, error: `TXT botiny-claim=${token} not found at _botiny.${host}` };
  }
  if (method === "well_known") return has(await getJson(`https://${host}/.well-known/botiny.json`)) ? { ok: true } : { ok: false, error: "token/wallet not found in /.well-known/botiny.json" };
  if (method === "repo_file") {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/.exec(s.url); if (!m) return { ok: false, error: "repo_file supports github.com repositories" };
    return has(await getJson(`https://raw.githubusercontent.com/${m[1]}/${m[2].replace(/\.git$/, "")}/HEAD/botiny.json`)) ? { ok: true } : { ok: false, error: "token/wallet not found in botiny.json at repo root" };
  }
  return { ok: false, error: "unknown method" };
}

/** Admin review: accept (-> queued crawler job), reject, publish (needs_review -> indexed), duplicate. */
export async function reviewSuggestion(id: string, action: string, body: any, actor: string) {
  const s = (await q("SELECT * FROM listing_suggestions WHERE suggestion_id=$1", [id]))[0];
  if (!s) throw err(404, "suggestion not found");
  const set = async (sql: string, p: any[]) => (await q(`UPDATE listing_suggestions SET ${sql}, updated_at=now(), reviewed_by=$2, reviewed_at=now() WHERE suggestion_id=$1 RETURNING *`, [id, actor, ...p]))[0];
  let out: any;
  if (action === "accept") {
    if (!["submitted", "needs_review"].includes(s.state)) throw err(409, `cannot accept a suggestion in state ${s.state}`);
    const job = (await q("INSERT INTO crawl_jobs(kind, payload) VALUES ('suggestion',$1) RETURNING job_id", [{ suggestion_id: id, requested_by: actor }]))[0];
    out = await set("state='queued', crawl_job_id=$3, detail=$4, reason=NULL", [job.job_id, { note: "queued for crawl" }]);
  } else if (action === "reject") {
    const reason = String(body?.reason ?? "").trim(); if (reason.length < 3) throw err(400, "reason required");
    if (!OPEN_STATES.includes(s.state)) throw err(409, `cannot reject a suggestion in state ${s.state}`);
    if (s.crawl_job_id) await q("UPDATE crawl_jobs SET status='cancelled', finished_at=now() WHERE job_id=$1 AND status IN ('queued','paused')", [s.crawl_job_id]);
    out = await set("state='rejected', reason=$3", [reason.slice(0, 300)]);
  } else if (action === "publish") {
    if (s.state !== "needs_review" || !s.crawl_item_id) throw err(409, "only needs_review suggestions with a crawled item can be published");
    const { publish } = await import("../../crawler/src/publish");
    await publish({ itemIds: [s.crawl_item_id], minQuality: 0 });
    const lid = (await q("SELECT published_listing_id FROM crawl_items WHERE item_id=$1", [s.crawl_item_id]))[0]?.published_listing_id;
    if (!lid) throw err(409, "item could not be published (needs an http(s) primary URL)");
    out = await set("state='indexed', listing_id=$3, detail=$4", [lid, { note: "published by admin review" }]);
  } else if (action === "duplicate") {
    const d = String(body?.duplicate_of ?? ""); if (!/^(lst|sug)_[A-Za-z0-9]+$/.test(d)) throw err(400, "duplicate_of (listing or suggestion id) required");
    if (!OPEN_STATES.includes(s.state)) throw err(409, `cannot mark state ${s.state} as duplicate`);
    out = await set("state='duplicate', duplicate_of=$3", [d]);
  } else throw err(404, "unknown action (accept|reject|publish|duplicate)");
  await audit(actor, "suggestion_" + action, { suggestion_id: id, from: s.state, to: out.state, reason: out.reason ?? undefined });
  return out;
}

export function suggestionsAdminRouter() {
  const r = express.Router();
  r.get("/api/suggestions", h(async (req, res) => {
    const st = typeof req.query.state === "string" && req.query.state ? req.query.state : null;
    res.json({ counts: await q("SELECT state, count(*)::int n FROM listing_suggestions GROUP BY 1"),
      suggestions: await q(`SELECT s.*, (SELECT scores FROM crawl_items i WHERE i.item_id=s.crawl_item_id) scores FROM listing_suggestions s ${st ? "WHERE state=$1" : ""} ORDER BY created_at DESC LIMIT 300`, st ? [st] : []) });
  }));
  r.post("/api/suggestions/:id/:action", h(async (req, res) => res.json({ suggestion: await reviewSuggestion(String(req.params.id), String(req.params.action), req.body, "dashboard") })));
  return r;
}

// ---------- bot-owner monitoring ----------
const RANGES: Record<string, { ms: number; bucket: "hour" | "day" }> = { "24h": { ms: 86_400_000, bucket: "hour" }, "7d": { ms: 7 * 86_400_000, bucket: "day" }, "30d": { ms: 30 * 86_400_000, bucket: "day" } };
const NONE = "_none";   // path token for requests without X-Bot-Id
const botFilter = (bot: string, idx: number) => bot === NONE ? "r.bot_id IS NULL" : `r.bot_id = $${idx}`;
const CLICK_CLASS = `CASE WHEN c.paid AND NOT c.clawed_back THEN 'paid' WHEN c.class IN ('bot','preview','self') THEN 'bot' WHEN c.class='tracked' THEN 'tracked' ELSE 'human' END`;
async function banState(bot: string | null, wallets: string[]) {
  const bans = (await activeBans()).filter((b: any) => (b.kind === "bot" && bot && b.value === bot) || (b.kind === "wallet" && wallets.includes(b.value)));
  if (!bans.length) return { status: "not banned" };
  const b = bans[0];
  return { status: "banned", ban_id: b.ban_id, kind: b.kind, reason: b.reason, expires_at: b.expires_at, appeal: bot ? `/v1/bots/${encodeURIComponent(bot)}/appeal` : `/v1/bots/${NONE}/appeal` };
}
async function earningsFor(wallets: string[]) {
  const { earnings } = await import("./clicks");
  const per = [] as any[]; const tot: any = { pending: 0, vesting: 0, vested: 0, clawed_back: 0, paid: 0 };
  for (const w of wallets) {
    const e: any = await earnings(w).catch(() => ({ bot_wallet: w, held: 0, review: 0, vested: 0, clawed_back: 0, paid: 0 }));
    const m = { wallet: w, pending: e.review ?? 0, vesting: e.held ?? 0, vested: e.vested ?? 0, clawed_back: e.clawed_back ?? 0, paid: e.paid ?? 0 };
    per.push(m); for (const k of Object.keys(tot)) tot[k] += m[k as keyof typeof m] as number;
  }
  return { totals: tot, wallets: per, states: { pending: "awaiting click-server verification (review hold)", vesting: "held 14 days", vested: "released", clawed_back: "returned to the advertiser's pool" } };
}
async function assertOwnsBot(bot: string, wallets: string[]) {
  if (bot === NONE) return;   // unnamed-bot group: always 200 (zero stats / empty list when the wallet has none)
  const ok = (await q(`SELECT 1 FROM requests r WHERE lower(r.payer) = ANY($1) AND ${botFilter(bot, 2)} LIMIT 1`, bot === NONE ? [wallets] : [wallets, bot])).length;
  if (!ok) throw err(404, "no such bot for the signed-in wallet(s)");
}
function encCursor(t: Date, id: string) { return Buffer.from(`${new Date(t).toISOString()}|${id}`).toString("base64url"); }
function decCursor(c: unknown) { if (typeof c !== "string" || !c) return null; const [t, id] = Buffer.from(c, "base64url").toString().split("|"); return t && id && !isNaN(+new Date(t)) ? { t, id } : null; }

export function portalRouter() {
  const r = express.Router();
  // --- auth ---
  r.get("/v1/auth/siwe/nonce", h(async (req, res) => {
    try { rateLimit("nonce:" + clientIp(req), 30, 60_000); } catch (e) { return limited(res, e); }
    const n = await newNonce(); const domain = [...siweDomains(req)][0];
    res.json({ ...n, domain, uri: process.env.SIWE_DOMAIN ? `https://${domain}` : process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") || `${req.protocol}://${domain}`, chain_id: 84532, version: "1", statement: SIWE_STATEMENT,
      resources: ROLES.map(x => `botiny:role:${x}`), allowed_chain_ids: [...TESTNET_IDS] });
  }));
  r.post("/v1/auth/siwe/verify", h(async (req, res) => {
    try { rateLimit("verify:" + clientIp(req), 20, 60_000); } catch (e) { return limited(res, e); }
    const v = await verifySiwe(req, req.body?.message, req.body?.signature, "signin");
    const asked = v.resources.map((x: string) => /^botiny:role:(bot_owner|advertiser)$/.exec(x)?.[1]).filter(Boolean) as string[];
    const want = asked.length ? [...new Set(asked)] : ["bot_owner"];
    let advertiser_id = await advertiserOfWallet(v.address), link_error: any = null;
    if (req.body?.api_key != null) { try { advertiser_id = await linkKey(v.address, req.body.api_key); } catch (e: any) { link_error = { error: e.code ?? "advertiser_link_failed", message: e.message }; } }
    const roles = want.filter(x => x !== "advertiser" || advertiser_id);
    if (!roles.length) roles.push("bot_owner");
    const token = "bts_" + randomBytes(32).toString("base64url"), exp = new Date(Date.now() + SESSION_TTL_MS);
    await q("INSERT INTO portal_sessions(token_hash,address,roles,chain_id,expires_at) VALUES ($1,$2,$3,$4,$5)", [sha256(token), v.address, roles, v.chain_id, exp]);
    res.set("Set-Cookie", cookieFor(req, token, SESSION_TTL_MS)).set("Cache-Control", "no-store");
    res.json({ address: v.address, roles, chain_id: v.chain_id, expires_at: exp.toISOString(), session_token: token, advertiser_id,
      advertiser: want.includes("advertiser") ? { linked: !!advertiser_id, ...(link_error ?? {}), ...(advertiser_id ? {} : { link_required: true }) } : undefined });
  }));
  r.get("/v1/auth/session", requireSession(), h(async (_req, res) => {
    const s: Session = res.locals.session;
    res.json({ address: s.address, roles: s.roles, chain_id: s.chain_id, expires_at: s.expires_at, advertiser_id: await advertiserOfWallet(s.address), linked_wallets: (await ownedWallets(s.address)).slice(1) });
  }));
  r.post("/v1/auth/logout", requireSession(), h(async (req, res) => {
    await q("UPDATE portal_sessions SET revoked_at=now() WHERE token_hash=$1", [res.locals.session.token_hash]);
    res.set("Set-Cookie", cookieFor(req, "", 0)).json({ ok: true });
  }));
  r.post("/v1/advertisers/me/link-key", requireSession(), h(async (req, res) => {
    const s: Session = res.locals.session;
    try { rateLimit("linkkey:" + s.address, 10, 10 * 60_000); } catch (e) { return limited(res, e); }
    const adv = await linkKey(s.address, req.body?.api_key);
    const roles = [...new Set([...s.roles, "advertiser"])];
    await q("UPDATE portal_sessions SET roles=$2 WHERE token_hash=$1", [s.token_hash, roles]);
    res.json({ address: s.address, advertiser_id: adv, roles, linked: true });
  }));

  // --- suggestions ---
  r.post("/v1/suggestions", h(async (req, res) => {
    const s = await sessionOf(req), ip = clientIp(req);
    if (s?.via === "cookie" && !req.get("X-Botiny-Client")) throw err(403, "X-Botiny-Client header required for cookie-authenticated writes", "csrf");
    try { rateLimit("sug-ip:" + ip, Number(process.env.SUGGEST_RATE_IP ?? 5), 10 * 60_000); if (s) rateLimit("sug-addr:" + s.address, 20, 60 * 60_000); } catch (e) { return limited(res, e); }
    const row = await createSuggestion(req.body, s?.address ?? null, ip);
    res.status(201).json(await suggestionView(row, true));
  }));
  r.get("/v1/suggestions", requireSession(), h(async (req, res) => {
    const s: Session = res.locals.session; const p: any[] = [s.address]; let w = "submitter_address=$1";
    if (typeof req.query.state === "string" && req.query.state) { if (!SUGGESTION_STATES.includes(req.query.state as any)) throw err(400, "unknown state"); p.push(req.query.state); w += ` AND state=$${p.length}`; }
    const cur = decCursor(req.query.cursor); if (cur) { p.push(cur.t, cur.id); w += ` AND (created_at, suggestion_id) < ($${p.length - 1}::timestamptz, $${p.length})`; }
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    const rows = await q(`SELECT * FROM listing_suggestions WHERE ${w} ORDER BY created_at DESC, suggestion_id DESC LIMIT ${limit}`, p);
    res.json({ suggestions: await Promise.all(rows.map(x => suggestionView(x, true))), next_cursor: rows.length === limit ? encCursor(rows[rows.length - 1].created_at, rows[rows.length - 1].suggestion_id) : null });
  }));
  r.get("/v1/suggestions/:id", h(async (req, res) => {
    const row = (await q("SELECT * FROM listing_suggestions WHERE suggestion_id=$1", [req.params.id]))[0];
    if (!row) return res.status(404).json({ error: "not found" });
    const s = await sessionOf(req);
    res.json(await suggestionView(row, !!s && (s.address === row.submitter_address || s.address === row.claim_wallet)));
  }));
  r.post("/v1/suggestions/:id/claim", requireSession(), h(async (req, res) => {
    const sess: Session = res.locals.session;
    try { rateLimit("claim:" + sess.address, 10, 10 * 60_000); } catch (e) { return limited(res, e); }
    const s = (await q("SELECT * FROM listing_suggestions WHERE suggestion_id=$1", [req.params.id]))[0];
    if (!s) return res.status(404).json({ error: "not found" });
    if (!s.claim_wallet || !s.claim) throw err(409, "suggestion has no claim_wallet", "no_claim_wallet");
    if (sess.address !== s.claim_wallet) throw err(403, "sign in with the claim_wallet to claim", "wrong_wallet");
    const method = String(req.body?.method ?? ""); if (!["dns_txt", "well_known", "repo_file"].includes(method)) throw err(400, "method must be dns_txt|well_known|repo_file");
    let sigOk = false; try { sigOk = await verifyMessage({ address: s.claim_wallet, message: claimChallenge(s), signature: req.body?.signature }); } catch {}
    if (!sigOk) throw err(401, "signature over the claim challenge does not match claim_wallet", "bad_signature");
    const host = new URL(s.url).hostname;
    const chk = await claimChecker(method, s, host).catch((e: any) => ({ ok: false, error: String(e?.message ?? e).slice(0, 200) }));
    const claim = { ...s.claim, method, status: chk.ok ? "verified" : "failed", error: chk.ok ? null : chk.error, checked_at: new Date().toISOString() };
    await q("UPDATE listing_suggestions SET claim=$2, updated_at=now() WHERE suggestion_id=$1", [s.suggestion_id, claim]);
    res.status(chk.ok ? 200 : 422).json({ id: s.suggestion_id, claim: { method, status: claim.status, error: claim.error, checked_at: claim.checked_at } });
  }));

  // --- bot owner ---
  r.get("/v1/bots/me", requireSession(), h(async (_req, res) => {
    const s: Session = res.locals.session; const W = await ownedWallets(s.address);
    const bots = await q(`SELECT r.bot_id, array_agg(DISTINCT lower(r.payer)) paying_wallets, array_agg(DISTINCT r.payment_network) FILTER (WHERE r.payment_network IS NOT NULL) chains,
        count(*) FILTER (WHERE r.received_at > now() - interval '30 days')::int queries_30d,
        COALESCE(sum(r.payment_amount_atomic) FILTER (WHERE r.received_at > now() - interval '30 days' AND r.payment_status='settled'),0)::text spend_30d_atomic,
        count(*)::int queries_total, max(r.received_at) last_seen
      FROM requests r WHERE lower(r.payer) = ANY($1) GROUP BY 1 ORDER BY max(r.received_at) DESC`, [W]);
    const earned = new Map((await q(`SELECT r.bot_id, COALESCE(sum(i.delta_atomic) FILTER (WHERE i.kind IN ('accrue_held','review_hold')),0)::text e
      FROM incentive_ledger i JOIN harvest_tokens hv USING (token) JOIN requests r ON r.request_id=hv.request_id WHERE lower(r.payer)=ANY($1) GROUP BY 1`, [W])).map(x => [x.bot_id, Number(x.e)]));
    const daily = await q(`SELECT to_char(date_trunc('day', received_at),'YYYY-MM-DD') AS day, count(*)::int queries
      FROM requests WHERE lower(payer)=ANY($1) AND received_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [W]);
    const out: any[] = [];
    for (const b of bots) out.push({ bot_id: b.bot_id, path_id: b.bot_id ?? NONE, ...b, spend_30d_atomic: Number(b.spend_30d_atomic), incentives_earned_atomic: earned.get(b.bot_id) ?? 0, ban: await banState(b.bot_id, b.paying_wallets) });
    const sum = (k: string) => out.reduce((a, x: any) => a + Number(x[k] ?? 0), 0);
    res.json({ address: s.address, wallets: W, asset: "USDC (testnet, 6 decimals)", bots: out,
      totals: { queries_30d: sum("queries_30d"), spend_30d_atomic: sum("spend_30d_atomic"), incentives_earned_atomic: sum("incentives_earned_atomic") }, daily });
  }));
  r.post("/v1/bots/me/wallets", requireSession(), h(async (req, res) => {
    const s: Session = res.locals.session;
    const v = await verifySiwe(req, req.body?.siwe_message, req.body?.signature, "link:" + s.address);
    if (!v.resources.includes(`botiny:link:${s.address}`)) throw err(400, `SIWE resources must include botiny:link:${s.address}`, "link_resource_missing");
    if (v.address === s.address) throw err(400, "that is the signed-in wallet");
    const cur = (await q("SELECT owner_address FROM bot_owner_wallets WHERE wallet=$1", [v.address]))[0];
    if (cur && cur.owner_address !== s.address) throw err(409, "wallet already linked to another owner", "wallet_linked_elsewhere");
    if (!cur) await q("INSERT INTO bot_owner_wallets(wallet, owner_address) VALUES ($1,$2)", [v.address, s.address]);
    res.status(cur ? 200 : 201).json({ owner: s.address, wallet: v.address, wallets: await ownedWallets(s.address) });
  }));
  r.get("/v1/bots/me/:bot_id/stats", requireSession(), h(async (req, res) => {
    const s: Session = res.locals.session, W = await ownedWallets(s.address), bot = String(req.params.bot_id);
    const range = String(req.query.range ?? "30d"); const R = RANGES[range]; if (!R) throw err(400, "range must be 24h|7d|30d");
    await assertOwnsBot(bot, W);
    const p = bot === NONE ? [W, R.ms] : [W, R.ms, bot], bf = botFilter(bot, 3);
    const base = `FROM requests r WHERE lower(r.payer)=ANY($1) AND ${bf} AND r.received_at > now() - ($2::bigint * interval '1 millisecond')`;
    const fmt = R.bucket === "hour" ? "YYYY-MM-DD\"T\"HH24:00Z" : "YYYY-MM-DD";
    const series = await q(`SELECT to_char(date_trunc('${R.bucket}', r.received_at AT TIME ZONE 'UTC'),'${fmt}') t, count(*)::int queries,
        COALESCE(sum(r.payment_amount_atomic) FILTER (WHERE r.payment_status='settled'),0)::text spend_atomic ${base} GROUP BY 1 ORDER BY 1`, p);
    const chains = await q(`SELECT r.payment_network network, r.payment_chain_id chain_id, count(*)::int queries, COALESCE(sum(r.payment_amount_atomic) FILTER (WHERE r.payment_status='settled'),0)::text spend_atomic ${base} GROUP BY 1,2 ORDER BY 3 DESC`, p);
    const mix = (await q(`SELECT count(*) FILTER (WHERE NOT i.sponsored AND COALESCE(hv.show_atomic+hv.click_atomic,0)=0)::int organic, count(*) FILTER (WHERE i.sponsored AND COALESCE(hv.show_atomic+hv.click_atomic,0)=0)::int promoted,
        count(*) FILTER (WHERE COALESCE(hv.show_atomic+hv.click_atomic,0)>0)::int incentive
      FROM impressions i JOIN requests r USING (request_id) LEFT JOIN harvest_tokens hv ON hv.request_id=i.request_id AND hv.rank=i.rank
      WHERE lower(r.payer)=ANY($1) AND ${bf} AND r.received_at > now() - ($2::bigint * interval '1 millisecond')`, p))[0];
    const byRank = await q(`WITH t AS (SELECT hv.token, hv.rank FROM harvest_tokens hv JOIN requests r ON r.request_id=hv.request_id
          WHERE lower(r.payer)=ANY($1) AND ${bf} AND r.received_at > now() - ($2::bigint * interval '1 millisecond') AND hv.rank BETWEEN 1 AND 10),
        c AS (SELECT c.token, ${CLICK_CLASS} cls FROM clicks c WHERE c.token IN (SELECT token FROM t))
      SELECT t.rank, count(DISTINCT t.token)::int links, count(c.cls) FILTER (WHERE c.cls='human')::int human, count(c.cls) FILTER (WHERE c.cls='bot')::int bot,
        count(c.cls) FILTER (WHERE c.cls='tracked')::int tracked, count(c.cls) FILTER (WHERE c.cls='paid')::int paid,
        count(DISTINCT t.token) FILTER (WHERE c.cls IN ('human','paid'))::int clicked_links
      FROM t LEFT JOIN c USING (token) GROUP BY 1 ORDER BY 1`, p);
    const ranks = Array.from({ length: 10 }, (_, i) => { const x = byRank.find(y => y.rank === i + 1) ?? { links: 0, human: 0, bot: 0, tracked: 0, paid: 0, clicked_links: 0 };
      return { rank: i + 1, links: x.links, clicks: { human: x.human, bot: x.bot, tracked: x.tracked, paid: x.paid }, ctr_pct: x.links ? Math.round(10000 * x.clicked_links / x.links) / 100 : 0 }; });
    const tot = ranks.reduce((a, x) => ({ links: a.links + x.links, clicks: a.clicks + x.clicks.human + x.clicks.paid + x.clicks.bot + x.clicks.tracked }), { links: 0, clicks: 0 });
    const wallets = (await q(`SELECT DISTINCT lower(r.payer) w ${base}`, p)).map(x => x.w);
    const ban = await banState(bot === NONE ? null : bot, wallets);
    res.json({ bot_id: bot === NONE ? null : bot, range, bucket: R.bucket, series: series.map(x => ({ ...x, spend_atomic: Number(x.spend_atomic) })),
      queries: series.reduce((a, x) => a + x.queries, 0), chains: chains.map(x => ({ ...x, spend_atomic: Number(x.spend_atomic) })), results_mix: mix,
      clicks: { links: tot.links, total: tot.clicks, ctr_pct: tot.links ? Math.round(10000 * ranks.reduce((a, x) => a + x.ctr_pct * x.links / 100, 0) / tot.links) / 100 : 0, by_rank: ranks },
      earnings: { ...(await earningsFor(wallets)), frozen: ban.status === "banned" }, ban });
  }));
  r.get("/v1/bots/me/:bot_id/requests", requireSession(), h(async (req, res) => {
    const s: Session = res.locals.session, W = await ownedWallets(s.address), bot = String(req.params.bot_id);
    await assertOwnsBot(bot, W);
    const p: any[] = bot === NONE ? [W] : [W, bot]; let w = `lower(r.payer)=ANY($1) AND ${botFilter(bot, 2)}`;
    if (typeof req.query.q === "string" && req.query.q.trim()) { p.push(req.query.q.trim()); w += ` AND (r.request_id=$${p.length} OR (r.request_canonical::json->>'query') ILIKE '%'||$${p.length}||'%')`; }
    const cur = decCursor(req.query.cursor); if (cur) { p.push(cur.t, cur.id); w += ` AND (r.received_at, r.request_id) < ($${p.length - 1}::timestamptz, $${p.length})`; }
    const csv = req.query.format === "csv";
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), csv ? 5000 : 200);
    const rows = await q(`SELECT r.request_id, r.received_at, (r.request_canonical::json->>'query') query, (r.request_canonical::json->>'k')::int k, r.response_hash,
        r.payment_mode, r.payment_network, r.payment_chain_id, r.payment_amount_atomic::text amount_atomic, r.payment_status, r.settle_tx, r.tos_version,
        (SELECT count(*) FILTER (WHERE NOT i.sponsored AND COALESCE(hv.show_atomic+hv.click_atomic,0)=0)::int FROM impressions i LEFT JOIN harvest_tokens hv ON hv.request_id=i.request_id AND hv.rank=i.rank WHERE i.request_id=r.request_id) organic,
        (SELECT count(*) FILTER (WHERE i.sponsored AND COALESCE(hv.show_atomic+hv.click_atomic,0)=0)::int FROM impressions i LEFT JOIN harvest_tokens hv ON hv.request_id=i.request_id AND hv.rank=i.rank WHERE i.request_id=r.request_id) promoted,
        (SELECT count(*) FILTER (WHERE COALESCE(hv.show_atomic+hv.click_atomic,0)>0)::int FROM impressions i LEFT JOIN harvest_tokens hv ON hv.request_id=i.request_id AND hv.rank=i.rank WHERE i.request_id=r.request_id) incentive
      FROM requests r WHERE ${w} ORDER BY r.received_at DESC, r.request_id DESC LIMIT ${limit}`, p);
    const items = rows.map(x => ({ request_id: x.request_id, received_at: x.received_at, query: x.query, k: x.k, results: { organic: x.organic, promoted: x.promoted, incentive: x.incentive },
      response_hash: x.response_hash, payment: { mode: x.payment_mode, network: x.payment_network, chain_id: x.payment_chain_id, amount_atomic: Number(x.amount_atomic ?? 0), status: x.payment_status, tx: x.settle_tx },
      tos_version: x.tos_version, detail_url: `/v1/requests/${x.request_id}`, replay_url: `/v1/requests/${x.request_id}/replay` }));
    const next = rows.length === limit ? encCursor(rows[rows.length - 1].received_at, rows[rows.length - 1].request_id) : null;
    if (csv) {
      const esc = (v: any) => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
      const lines = ["request_id,received_at,query,k,organic,promoted,incentive,response_hash,network,amount_atomic,tx,tos_version",
        ...items.map(i => [i.request_id, new Date(i.received_at).toISOString(), i.query, i.k, i.results.organic, i.results.promoted, i.results.incentive, i.response_hash,
          (i.payment as any).network, (i.payment as any).amount_atomic ?? 0, (i.payment as any).tx, i.tos_version].map(esc).join(","))];
      if (next) res.set("X-Next-Cursor", next);
      return res.type("text/csv").set("Content-Disposition", `attachment; filename="requests-${bot.replace(/\W/g, "_")}.csv"`).send(lines.join("\n") + "\n");
    }
    res.json({ bot_id: bot === NONE ? null : bot, requests: items, next_cursor: next });
  }));
  r.post("/v1/bots/:bot_id/appeal", requireSession(), h(async (req, res) => {
    const s: Session = res.locals.session, W = await ownedWallets(s.address), bot = String(req.params.bot_id);
    const msg = String(req.body?.message ?? "").trim(); if (msg.length < 10 || msg.length > 2000) throw err(400, "message 10..2000 chars");
    await assertOwnsBot(bot, W);
    const wallets = (await q(`SELECT DISTINCT lower(r.payer) w FROM requests r WHERE lower(r.payer)=ANY($1) AND ${botFilter(bot, 2)}`, bot === NONE ? [W] : [W, bot])).map(x => x.w);
    const ban: any = await banState(bot === NONE ? null : bot, wallets);
    if (ban.status !== "banned") throw err(409, "bot is not banned", "not_banned");
    try {
      const a = (await q("INSERT INTO bot_appeals(bot_id, ban_id, address, message) VALUES ($1,$2,$3,$4) RETURNING *", [bot, ban.ban_id, s.address, msg]))[0];
      await audit("wallet:" + s.address, "ban_appeal", { appeal_id: a.appeal_id, ban_id: ban.ban_id, bot_id: bot });
      res.status(201).json({ appeal_id: a.appeal_id, ban_id: ban.ban_id, status: a.status, created_at: a.created_at });
    } catch (e: any) { if (e?.code === "23505") throw err(409, "an appeal for this ban is already open", "appeal_open"); throw e; }
  }));

  // --- public pricing / ToS ---
  r.get("/v1/pricing/impression-base", h(async (_req, res) => {
    const { version, settings } = await currentSettings();
    res.json({ fixed_cpi_atomic: settings.fixed_cpi_atomic, max_bid_atomic: settings.max_bid_atomic, promoted_slots: settings.promoted_slots, settings_version: version,
      impression_cost: "fixed_cpi_atomic + bid_atomic", asset: "USDC (testnet)", decimals: 6 });
  }));
  r.get("/v1/tos/advertiser/latest", h(async (req, res) => {
    const { tosInfo } = await import("./tos");
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "") ?? `${req.protocol}://${req.get("host")}`;
    res.json(await tosInfo("advertiser", base));
  }));
  return r;
}

// ---------- advertiser campaigns (campaign = listing bid + incentive offer) ----------
async function campaignRows(adv: string, only?: string) {
  const { pacingAt } = await import("./pacing");
  const { settings } = await currentSettings();
  const M = Number((await q("SELECT last_value::text v FROM market_seq"))[0].v);
  const listings = await q(`SELECT l.listing_id, l.name, l.kind, l.address,
      COALESCE((SELECT bid_atomic FROM listing_bid_events e WHERE e.listing_id=l.listing_id ORDER BY seq DESC LIMIT 1),0)::int bid_atomic,
      COALESCE((SELECT paused FROM listing_bid_events e WHERE e.listing_id=l.listing_id ORDER BY seq DESC LIMIT 1),false) paused,
      (SELECT row_to_json(o) FROM (SELECT show_atomic::int, click_atomic::int, budget_atomic::bigint::text budget_atomic, expires_at, created_at FROM incentive_offers o WHERE o.listing_id=l.listing_id ORDER BY seq DESC LIMIT 1) o) offer,
      (SELECT count(*)::int FROM impressions i WHERE i.listing_id=l.listing_id AND i.created_at > now()-interval '30 days') impressions_30d,
      (SELECT count(*)::int FROM impressions i WHERE i.listing_id=l.listing_id AND i.sponsored AND i.created_at > now()-interval '30 days') sponsored_30d,
      (SELECT COALESCE(-sum(delta_atomic),0)::text FROM balance_ledger b WHERE b.listing_id=l.listing_id AND b.kind='impression_debit' AND b.created_at > now()-interval '30 days') spend_30d,
      (SELECT count(*)::int FROM clicks c WHERE c.listing_id=l.listing_id AND c.at > now()-interval '30 days') clicks_30d
    FROM listings l WHERE l.provider_id=$1 AND NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id) ${only ? "AND l.listing_id=$2" : ""} ORDER BY l.seq`, only ? [adv, only] : [adv]);
  const pac = await pacingAt(pool, M, Date.now(), listings.map(l => l.listing_id));
  const balance = await balanceOf(pool, adv);
  const rows = listings.map(l => {
    const p = pac.get(l.listing_id) ?? null, cost = settings.fixed_cpi_atomic + l.bid_atomic;
    const has = l.bid_atomic > 0 || !!l.offer;
    const state = !has ? "none" : p?.status === "expired" && l.bid_atomic === 0 ? "expired" : l.paused ? "paused" : balance < cost ? "paused_no_balance" : "active";
    return { campaign_id: l.listing_id, listing_id: l.listing_id, name: l.name, kind: l.kind, address: l.address, state,
      bid_atomic: l.bid_atomic, paused: l.paused, impression_cost_atomic: cost, base_price_atomic: settings.fixed_cpi_atomic,
      incentive: l.offer ? { show_atomic: l.offer.show_atomic, click_atomic: l.offer.click_atomic, budget_atomic: l.offer.budget_atomic == null ? null : Number(l.offer.budget_atomic), expires_at: l.offer.expires_at } : null,
      pacing: p,   // exactly src/pacing.ts Pacing (status, t_ppm, lag_ppm, boost_ppm [additive ppm], budget_atomic, consumed, remaining, pool, ...)
      consumed_pct: p?.budget_atomic ? Math.round(p.consumed * 10000 / p.budget_atomic) / 100 : null,
      impressions_30d: l.impressions_30d, sponsored_impressions_30d: l.sponsored_30d, spend_30d_atomic: Number(l.spend_30d), clicks_30d: l.clicks_30d };
  });
  return { balance, rows, market_seq: M };
}
export async function listCampaigns(adv: string, all = false) {
  const { balance, rows, market_seq } = await campaignRows(adv);
  const shown = all ? rows : rows.filter(r => r.state !== "none");
  return { advertiser_id: adv, market_seq, asset: "USDC (testnet, 6 decimals)",
    kpis: { balance_atomic: balance, in_pools_atomic: rows.reduce((a, r) => a + Math.max(r.pacing?.pool ?? 0, 0), 0), spend_30d_atomic: rows.reduce((a, r) => a + r.spend_30d_atomic, 0), clicks_30d: rows.reduce((a, r) => a + r.clicks_30d, 0) },
    policy: "No refunds: unearned or clawed-back incentive lines return to the listing's pool; pool balance at expiry is platform revenue.",
    pacing_rule: (await import("./pacing")).PACING_RULE, campaigns: shown };
}
export async function listingStats(adv: string, lid: string, range: string) {
  const R = RANGES[range]; if (!R) throw err(400, "range must be 24h|7d|30d");
  const { balance, rows } = await campaignRows(adv, lid);
  const c = rows[0];
  if (!c) { const o = (await q("SELECT provider_id FROM listings WHERE listing_id=$1", [lid]))[0]; throw o ? err(403, "not your listing") : err(404, "listing not found"); }
  const fmt = R.bucket === "hour" ? "YYYY-MM-DD\"T\"HH24:00Z" : "YYYY-MM-DD";
  const tb = (col: string) => `to_char(date_trunc('${R.bucket}', ${col} AT TIME ZONE 'UTC'),'${fmt}')`;
  const ev = await q(`SELECT t, k, sum(n)::text n FROM (
      SELECT ${tb("created_at")} t, 'impressions' k, 1 n FROM impressions WHERE listing_id=$1 AND created_at > now() - ($2::bigint * interval '1 millisecond')
      UNION ALL SELECT ${tb("created_at")}, 'sponsored', 1 FROM impressions WHERE listing_id=$1 AND sponsored AND created_at > now() - ($2::bigint * interval '1 millisecond')
      UNION ALL SELECT ${tb("created_at")}, 'impression_spend_atomic', -delta_atomic FROM balance_ledger WHERE listing_id=$1 AND kind='impression_debit' AND created_at > now() - ($2::bigint * interval '1 millisecond')
      UNION ALL SELECT ${tb("at")}, 'clicks', 1 FROM clicks WHERE listing_id=$1 AND at > now() - ($2::bigint * interval '1 millisecond')
      UNION ALL SELECT ${tb("issued_at")}, 'incentive_spend_atomic', show_atomic+click_atomic FROM harvest_tokens WHERE listing_id=$1 AND show_atomic+click_atomic>0 AND issued_at > now() - ($2::bigint * interval '1 millisecond')
    ) x GROUP BY 1,2 ORDER BY 1`, [lid, R.ms]);
  const m = new Map<string, any>();
  for (const e of ev) { const r = m.get(e.t) ?? { t: e.t, impressions: 0, sponsored: 0, impression_spend_atomic: 0, clicks: 0, incentive_spend_atomic: 0 }; r[e.k] = Number(e.n); m.set(e.t, r); }
  const p = c.pacing;
  let card: any = null;
  if (p) {
    const now = Date.now(), elapsedD = Math.max((Math.min(now, p.expires_ms) - p.start_ms) / 86_400_000, 1 / 24), totalD = (p.expires_ms - p.start_ms) / 86_400_000;
    const cur = p.consumed / elapsedD, target = p.budget_atomic != null ? p.budget_atomic / totalD : null;
    const projected = p.budget_atomic != null && cur > 0 && p.remaining != null ? new Date(now + (p.remaining / cur) * 86_400_000).toISOString() : null;
    card = { status: p.status, consumed_pct: c.consumed_pct, time_elapsed_pct: Math.round(p.t_ppm / 100) / 100, current_rate_atomic_per_day: Math.round(cur), target_rate_atomic_per_day: target == null ? null : Math.round(target),
      projected_empty_at: projected, expires_at: new Date(p.expires_ms).toISOString(), thresholds: (await import("./pacing")).PACING_RULE };
  }
  const { incentiveReport } = await import("./pacing");
  const o = (await incentiveReport(pool, adv)).offers.find((x: any) => x.listing_id === lid) ?? null;
  const acct = o ? { funded_atomic: o.funded_atomic, pool_draw_atomic: o.pool_draw_atomic, issued_atomic: o.issued_atomic, earned_atomic: o.earned_atomic, vested_atomic: o.vested_atomic,
    pending_or_vesting_atomic: Math.max(o.earned_atomic - o.vested_atomic - o.clawed_back_atomic, 0), clawed_back_atomic: o.clawed_back_atomic, returned_to_pool_atomic: o.returned_to_pool_atomic,
    pool_atomic: o.pool_atomic, expired_to_platform_atomic: o.expired_to_platform_atomic } : null;
  const totals = [...m.values()].reduce((a, r) => ({ impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, impression_spend_atomic: a.impression_spend_atomic + r.impression_spend_atomic }), { impressions: 0, clicks: 0, impression_spend_atomic: 0 });
  return { listing_id: lid, range, bucket: R.bucket, advertiser_balance_atomic: balance, campaign: c,
    kpis: { ...totals, ctr_pct: totals.impressions ? Math.round(10000 * totals.clicks / totals.impressions) / 100 : 0, pool_atomic: p?.pool ?? 0, consumed_pct: c.consumed_pct },
    series: [...m.values()], pacing: p, pacing_card: card, accounting: acct };
}
/** Launch/preview a campaign = set bid and (optionally) incentive offer through the existing append-only paths. */
export async function createCampaign(adv: string, b: any) {
  const lid = String(b?.listing_id ?? ""); if (!lid) throw err(400, "listing_id required");
  const own = (await q("SELECT provider_id FROM listings l WHERE listing_id=$1 AND NOT EXISTS (SELECT 1 FROM listings n WHERE n.supersedes=l.listing_id)", [lid]))[0];
  if (!own) throw err(404, "listing not found (or superseded)"); if (own.provider_id !== adv) throw err(403, "not your listing (claimed listings only)");
  const { settings } = await currentSettings();
  const bid = b.bid_atomic ?? 0;
  if (!Number.isSafeInteger(bid) || bid < 0 || bid > settings.max_bid_atomic) throw err(400, `bid_atomic must be integer 0..${settings.max_bid_atomic}`, "validation");
  const inc = b.incentive ?? null;
  if (inc != null && typeof inc !== "object") throw err(400, "incentive must be an object", "validation");
  const days = inc?.expires_at ? Math.max((+new Date(inc.expires_at) - Date.now()) / 86_400_000, 0) : 30;
  const budget = inc?.budget_atomic ?? null, cost = settings.fixed_cpi_atomic + bid, balance = await balanceOf(pool, adv);
  const summary = { impression_cost_atomic: cost, base_price_atomic: settings.fixed_cpi_atomic, bid_atomic: bid, pool_atomic: budget, expires_in_days: Math.round(days * 100) / 100,
    daily_pacing_target_atomic: budget != null && days > 0 ? Math.round(budget / days) : null,
    max_clicks: budget != null && inc?.click_atomic ? Math.floor(budget / (inc.click_atomic + (inc.show_atomic ?? 0))) : null,
    balance_before_atomic: balance, balance_after_atomic: balance - (budget ?? 0), rules: ["promoted results are labelled and count toward the 2-of-10 provider cap", "no refunds"] };
  if (b.dry_run) return { status: 200, body: { state: "draft", listing_id: lid, summary } };
  if (balance < cost || (budget != null && balance < budget)) throw Object.assign(err(409, "insufficient balance; top up first", "insufficient_balance"), { summary });
  const bidRes = await setBid(lid, { bid_atomic: bid, paused: false }, "advertiser:" + adv, adv);
  const incRes = inc ? await setIncentive(lid, { show_atomic: inc.show_atomic, click_atomic: inc.click_atomic, budget_atomic: inc.budget_atomic, expires_at: inc.expires_at }, "advertiser:" + adv, adv) : null;
  const { rows } = await campaignRows(adv, lid);
  return { status: 201, body: { state: "launched", bid: bidRes, incentive: incRes, summary, campaign: rows[0] } };
}
