// Shared SSRF-safe outbound HTTP(S) for the api and the crawler. Every outbound fetch to a user- or crawl-supplied
// URL goes through safeFetch():
//  - http/https only, no credentials in the URL;
//  - DNS is resolved here, and EVERY returned address must be public (loopback, private, link-local, CGNAT,
//    cloud metadata, multicast, reserved and the IPv6 equivalents incl. v4-mapped / NAT64 / 6to4 are refused);
//  - the socket connects to the vetted IP (custom `lookup` pins it, so a second DNS answer can't swap it: no rebinding);
//    TLS still verifies the certificate for the original hostname (SNI = hostname);
//  - redirects are followed manually, re-validated on every hop, with a hop limit;
//  - total time and response size are capped.
// 198.18.0.0/15 (RFC 2544 benchmarking) is BLOCKED by default. This box's DNS answers every name with 198.18.0.1
// (fake-IP egress proxy), so the box sets SAFE_FETCH_ALLOW_CIDRS=198.18.0.0/15 in api/.env; never set it in production.
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const V4: [string, number][] = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]];
const V6: [string, number][] = [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]];
const BLOCK = new BlockList();
for (const [a, b] of V4) BLOCK.addSubnet(a, b, "ipv4");
for (const [a, b] of V6) BLOCK.addSubnet(a, b, "ipv6");
// Metadata endpoints not covered above (e.g. AWS IPv6 IMDS fd00:ec2::254 is in fc00::/7; GCP/Azure/AWS v4 are 169.254.169.254).

// ---- allow-list (SAFE_FETCH_ALLOW_CIDRS) -------------------------------------------------------------------------
// Only these blocked ranges may ever be re-enabled. An entry is accepted only if it does NOT overlap any other blocked
// range (so 126.0.0.0/7 -> overlaps 127/8, 169.0.0.0/8 -> overlaps 169.254/16, ::/0 -> overlaps everything: all refused).
// Honoured only when NODE_ENV is development|test or BOTINY_BOX_DEV=1. PRODUCTION MUST NOT SET IT.
export const RE_ENABLEABLE: [string, number][] = [["198.18.0.0", 15]];
const v4n = (a: string) => a.split(".").reduce((x, o) => (x << 8n) + BigInt(Number(o)), 0n);
function v6n(a: string) {
  let s = a.toLowerCase();
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const n = v4n(m[1]); s = s.slice(0, -m[1].length) + (n >> 16n).toString(16) + ":" + (n & 0xffffn).toString(16); }
  const [h, t] = s.includes("::") ? s.split("::") : [s, null];
  const hp = h ? h.split(":") : [], tp = t ? t.split(":") : [];
  const parts = t === null ? hp : [...hp, ...Array(8 - hp.length - tp.length).fill("0"), ...tp];
  return parts.reduce((x, g) => (x << 16n) + BigInt(parseInt(g || "0", 16)), 0n);
}
type Range = { fam: 4 | 6; lo: bigint; hi: bigint };
export function cidrRange(cidr: string): Range | null {
  const [a, b] = cidr.trim().split("/"); const fam = isIP(a); if (!fam) return null;
  const bits = fam === 4 ? 32 : 128, len = b == null ? bits : Number(b);
  if (!Number.isInteger(len) || len < 0 || len > bits || (b != null && !/^\d+$/.test(b))) return null;
  const n = fam === 4 ? v4n(a) : v6n(a), host = (1n << BigInt(bits - len)) - 1n, lo = n & ~host & ((1n << BigInt(bits)) - 1n);
  return { fam: fam as 4 | 6, lo, hi: lo | host };
}
const overlaps = (x: Range, y: Range) => x.fam === y.fam && x.lo <= y.hi && y.lo <= x.hi;
// IPv6 view of IPv4 blocks too (v4-mapped ::ffff:0:0/96 is refused outright, so mapping a v6 entry onto it is an overlap)
const BLOCKED_RANGES: { r: Range; cidr: string; ok: boolean }[] = [
  ...V4.map(([a, b]) => ({ r: cidrRange(`${a}/${b}`)!, cidr: `${a}/${b}`, ok: RE_ENABLEABLE.some(([x, y]) => x === a && y === b) })),
  ...V6.map(([a, b]) => ({ r: cidrRange(`${a}/${b}`)!, cidr: `${a}/${b}`, ok: false })),
  { r: cidrRange("::ffff:0:0/96")!, cidr: "::ffff:0:0/96", ok: false },
];
/** Validate one allow-list entry: null if acceptable, else the reason it is refused. */
export function allowEntryError(cidr: string): string | null {
  const r = cidrRange(cidr); if (!r) return "not a valid CIDR";
  const hit = BLOCKED_RANGES.find(b => !b.ok && overlaps(r, b.r));
  if (hit) return `overlaps blocked range ${hit.cidr}`;
  if (!BLOCKED_RANGES.some(b => b.ok && r.lo >= b.r.lo && r.hi <= b.r.hi && r.fam === b.r.fam)) return "not inside a re-enableable range (" + RE_ENABLEABLE.map(([a, b]) => `${a}/${b}`).join(", ") + ")";
  return null;
}
export const allowListActive = (env = process.env) => !!env.SAFE_FETCH_ALLOW_CIDRS?.trim() && (env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.BOTINY_BOX_DEV === "1");
let cached: { key: string; list: BlockList } | null = null;
function allowList() {
  const raw = process.env.SAFE_FETCH_ALLOW_CIDRS ?? "";
  const key = raw + "|" + allowListActive();
  if (cached?.key === key) return cached.list;
  const l = new BlockList();
  if (raw.trim() && !allowListActive()) console.error("[safe-fetch] SAFE_FETCH_ALLOW_CIDRS is set but IGNORED (needs NODE_ENV=development|test or BOTINY_BOX_DEV=1). Production must not set it.");
  else if (raw.trim()) {
    const ok: string[] = [];
    for (const c of raw.split(",").map(s => s.trim()).filter(Boolean)) {
      const e = allowEntryError(c);
      if (e) { console.error(`[safe-fetch] REJECTED allow-list entry ${c}: ${e}`); continue; }
      const [a, b] = c.split("/"); const fam = isIP(a) === 6 ? "ipv6" : "ipv4"; l.addSubnet(a, Number(b ?? (fam === "ipv6" ? 128 : 32)), fam); ok.push(c);
    }
    if (ok.length) console.warn(`\n[safe-fetch] !!! WARNING: SSRF allow-list ACTIVE (${ok.join(", ")}) — dev/box only (BOTINY_BOX_DEV/NODE_ENV). PRODUCTION MUST NOT SET SAFE_FETCH_ALLOW_CIDRS. !!!\n`);
  }
  cached = { key, list: l };
  return l;
}
/** Startup hook: evaluate (and loudly log) the allow-list once at process start. */
export const announceAllowList = () => { allowList(); return allowListActive(); };

export class BlockedAddressError extends Error { code = "blocked_address"; review = true; constructor(m: string) { super(m); } }

/** Canonical form: v4-mapped (::ffff:a.b.c.d, also hex form) -> a.b.c.d so the IPv4 rules apply. */
export function canonicalIp(raw: string) {
  let a = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (m) return m[1];
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (h) { const x = parseInt(h[1], 16), y = parseInt(h[2], 16); return `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`; }
  return a;
}
export function isPublicIp(raw: string) {
  const a = canonicalIp(raw); const fam = isIP(a);
  if (!fam) return false;
  // v4-mapped forms are canonicalised to IPv4 above; any other ::ffff: form is refused. (A ::ffff:0:0/96 BlockList
  // rule must NOT be used: node's BlockList matches every IPv4 address against it.)
  if (fam === 6 && /^::ffff:/.test(a)) return false;
  const f = fam === 6 ? "ipv6" : "ipv4";
  if (!BLOCK.check(a, f)) return true;
  if (testAllow.has(a) && process.env.NODE_TEST_CONTEXT) return true;   // test-only escape for local fixture servers
  return allowList().check(a, f);
}

const testAllow = new Set<string>();
/** Tests only (no effect outside `node --test`): allow exact fixture addresses such as 127.0.0.1. */
export const _safeFetchAllowForTests = (ips: string[]) => { testAllow.clear(); for (const i of ips) testAllow.add(i); };
type Resolver = (host: string) => Promise<string[]>;
const sysResolver: Resolver = async h => (await dnsLookup(h, { all: true, verbatim: true })).map(x => x.address);
let resolver: Resolver = sysResolver;
export const _setSafeFetchResolver = (r: Resolver | null) => { resolver = r ?? sysResolver; };

/** Resolve a hostname and return ONE vetted public address (all answers must be public). */
export async function resolvePublic(host: string): Promise<{ address: string; family: 4 | 6 }> {
  const h = host.replace(/^\[|\]$/g, "");
  if (!h || h.toLowerCase() === "localhost" || h.toLowerCase().endsWith(".localhost")) throw new BlockedAddressError(`host ${host} is not allowed`);
  let addrs: string[];
  if (isIP(h)) addrs = [h];
  else { try { addrs = await resolver(h); } catch { throw new BlockedAddressError(`host ${host} does not resolve`); } }
  if (!addrs.length) throw new BlockedAddressError(`host ${host} does not resolve`);
  for (const a of addrs) if (!isPublicIp(a)) throw new BlockedAddressError(`host ${host} resolves to a non-public address`);
  const a = canonicalIp(addrs[0]);
  return { address: a, family: isIP(a) === 6 ? 6 : 4 };
}

/** Validate a URL syntactically (scheme, no userinfo) and its host (DNS -> public only). */
export async function assertSafeUrl(url: string | URL) {
  const u = typeof url === "string" ? new URL(url) : url;
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedAddressError(`scheme ${u.protocol} not allowed`);
  if (u.username || u.password) throw new BlockedAddressError("credentials in URL not allowed");
  return resolvePublic(u.hostname);
}

export interface SafeResponse { status: number; ok: boolean; url: string; headers: Record<string, string>; body: Buffer; truncated: boolean; text(): string; json(): any; redirects: number }
export interface SafeFetchOpts { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; followRedirects?: boolean; truncate?: boolean }

const REDIRECT = new Set([301, 302, 303, 307, 308]);
/** Headers kept on a cross-host redirect; Authorization, Cookie, Proxy-Authorization and all custom headers are dropped. */
export const SAFE_ACROSS_HOSTS = new Set(["user-agent", "accept", "accept-language", "accept-encoding"]);
/** SSRF-safe fetch: see file header. Throws BlockedAddressError for disallowed targets (any hop). */
export async function safeFetch(url: string, o: SafeFetchOpts = {}): Promise<SafeResponse> {
  const deadline = Date.now() + (o.timeoutMs ?? 10_000), maxBytes = o.maxBytes ?? 1_000_000, maxHops = o.maxRedirects ?? 5;
  let cur = new URL(url), method = (o.method ?? "GET").toUpperCase(), body = o.body, hops = 0, headers: Record<string, string> = { ...(o.headers ?? {}) };
  for (;;) {
    const { address, family } = await assertSafeUrl(cur);
    const left = deadline - Date.now(); if (left <= 0) throw Object.assign(new Error("timeout"), { code: "timeout" });
    const r = await once(cur, address, family, method, headers, body, left, maxBytes, o.truncate ?? false);
    if (REDIRECT.has(r.status) && r.headers.location && (o.followRedirects ?? true)) {
      if (++hops > maxHops) throw Object.assign(new Error(`too many redirects (> ${maxHops})`), { code: "too_many_redirects" });
      const next = new URL(r.headers.location, cur);
      // cross-origin hop: drop credentials and every caller-supplied header except a small safe set
      if (next.host !== cur.host || next.protocol !== cur.protocol) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => SAFE_ACROSS_HOSTS.has(k.toLowerCase())));
      cur = next;
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) { method = "GET"; body = undefined; headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type")); }
      continue;
    }
    return { ...r, url: cur.toString(), redirects: hops };
  }
}

function once(u: URL, address: string, family: 4 | 6, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number, maxBytes: number, truncate: boolean) {
  return new Promise<Omit<SafeResponse, "url" | "redirects">>((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ""), port: u.port || undefined, path: u.pathname + u.search, method,
      headers: { ...headers, ...(body != null ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
      servername: isIP(u.hostname.replace(/^\[|\]$/g, "")) ? undefined : u.hostname,   // SNI + cert check use the hostname
      lookup: (_h: string, opts: any, cb: any) => opts?.all ? cb(null, [{ address, family }]) : cb(null, address, family),  // pinned to the vetted IP
      agent: false, timeout: timeoutMs,
    }, res => {
      const chunks: Buffer[] = []; let n = 0, truncated = false;
      res.on("data", (c: Buffer) => {
        n += c.length;
        if (n > maxBytes) { truncated = true; if (!truncate) { req.destroy(); return reject(Object.assign(new Error(`response larger than ${maxBytes} bytes`), { code: "too_large" })); }
          chunks.push(c.subarray(0, c.length - (n - maxBytes))); res.destroy(); return finish(); }
        chunks.push(c);
      });
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); const b = Buffer.concat(chunks); const hs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v != null) hs[k] = Array.isArray(v) ? v.join(", ") : String(v);
        resolve({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, headers: hs, body: b, truncated, text: () => b.toString("utf8"), json: () => JSON.parse(b.toString("utf8")) }); };
      res.on("end", finish); res.on("error", e => { if (!done) reject(e); });
    });
    const t = setTimeout(() => { req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })); }, timeoutMs);
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "timeout" })));
    req.on("error", e => { clearTimeout(t); reject(e); });
    if (body != null) req.write(body);
    req.end();
  });
}
