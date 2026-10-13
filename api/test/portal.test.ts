import { tosHashOf, DEFAULT_TOS } from "../src/tos";
const TOSH = tosHashOf(DEFAULT_TOS.bot);
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
process.env.DASHBOARD_PASSWORD = "test-pass";
delete process.env.PUBLIC_BASE_URL;
import { createApp } from "../src/app";
import { pool } from "../src/db";
import { resetTestDb } from "../src/seed";
import { _resetRateLimits, _setClaimChecker, claimChallenge, validateSuggestionUrl } from "../src/portal";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ensureSources } from "../../crawler/src/sources";
import { runJob } from "../../crawler/src/jobs";
import { _setResolver } from "../../crawler/src/suggest";

const owner = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
const AUTH = { authorization: "Basic " + Buffer.from("admin:test-pass").toString("base64") };
const H = { "content-type": "application/json", ...AUTH };
let base = "", host = "", server: any, n = 0, advKey = "", LID = "";
before(async () => { await resetTestDb(); await ensureSources(); server = createApp().listen(0); const port = (server.address() as AddressInfo).port; base = `http://127.0.0.1:${port}`; host = `127.0.0.1:${port}`; });
after(async () => { server.close(); await pool.end(); });
const J = async (r: Response) => { const t = await r.text(); let b: any = {}; try { b = JSON.parse(t); } catch { b = { text: t }; } return { ...b, body_status: b.status, status: r.status, headers: r.headers }; };
const get = (p: string, tok?: string) => fetch(base + p, { headers: tok ? { authorization: "Bearer " + tok } : {} }).then(J);
const post = (p: string, body: any, tok?: string, extra: any = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: "Bearer " + tok } : {}), ...extra }, body: JSON.stringify(body) }).then(J);
const admin = (p: string, body?: any) => fetch(base + "/dashboard" + p, { method: body ? "POST" : "GET", headers: H, body: body ? JSON.stringify(body) : undefined }).then(J);
async function siwe(acct: any, o: { roles?: string[]; chainId?: number; domain?: string; resources?: string[]; nonce?: string } = {}) {
  const nonce = o.nonce ?? (await get("/v1/auth/siwe/nonce")).nonce;
  const message = createSiweMessage({ domain: o.domain ?? host, address: acct.address, statement: "Sign in to Botiny (testnet).", uri: `http://${o.domain ?? host}`, version: "1",
    chainId: o.chainId ?? 84532, nonce, issuedAt: new Date(), resources: o.resources ?? (o.roles ?? ["bot_owner"]).map(r => `botiny:role:${r}`) });
  return { message, signature: await acct.signMessage({ message }), nonce };
}
const signIn = async (acct: any, roles?: string[], extra: any = {}) => post("/v1/auth/siwe/verify", { ...(await siwe(acct, { roles })), ...extra });
const rec = (payer: string, bot: string | null) => fetch(base + "/v1/recommend", { method: "POST", headers: { "content-type": "application/json", "X-TOS-ACCEPT": TOSH,
  "X-PAYMENT": `mock:pp${Date.now()}${n++}:${payer}`, ...(bot ? { "X-Bot-Id": bot } : {}) }, body: JSON.stringify({ query: "vector database MCP server", k: 5 }) }).then(J);

test("SIWE: nonce, verify, session, logout; nonce single-use; domain/chain/signature checks", async () => {
  const nn = await get("/v1/auth/siwe/nonce");
  assert.equal(nn.status, 200); assert.ok(nn.nonce.length >= 8); assert.ok(Date.parse(nn.expires_at) > Date.now()); assert.equal(nn.chain_id, 84532);
  const s = await siwe(owner);
  const v = await post("/v1/auth/siwe/verify", s);
  assert.equal(v.status, 200); assert.equal(v.address, owner.address.toLowerCase()); assert.deepEqual(v.roles, ["bot_owner"]); assert.match(v.session_token, /^bts_/);
  const ck = v.headers.get("set-cookie")!; assert.match(ck, /botiny_session=bts_/); assert.match(ck, /HttpOnly/); assert.match(ck, /SameSite=Strict/);
  assert.equal((await post("/v1/auth/siwe/verify", s)).error, "nonce_expired", "nonce replay rejected");
  const sess = await get("/v1/auth/session", v.session_token); assert.equal(sess.address, owner.address.toLowerCase()); assert.deepEqual(sess.roles, ["bot_owner"]);
  // cookie auth works for GET; cookie writes need X-Botiny-Client
  const cookie = ck.split(";")[0];
  assert.equal((await fetch(base + "/v1/auth/session", { headers: { cookie } }).then(J)).status, 200);
  assert.equal((await fetch(base + "/v1/auth/logout", { method: "POST", headers: { cookie } }).then(J)).error, "csrf");
  assert.equal((await fetch(base + "/v1/suggestions", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ url: "https://csrf.example.com/x", type: "other", name: "csrf" }) }).then(J)).error, "csrf", "optional-session write is CSRF-guarded too");
  assert.equal((await post("/v1/auth/siwe/verify", await siwe(owner, { domain: "evil.example.com" }))).error, "domain_mismatch");
  assert.equal((await post("/v1/auth/siwe/verify", await siwe(owner, { chainId: 8453 }))).error, "chain_not_allowed", "mainnet refused");
  const bad = await siwe(owner); assert.equal((await post("/v1/auth/siwe/verify", { message: bad.message, signature: await other.signMessage({ message: bad.message }) })).error, "bad_signature");
  const expired = await siwe(owner); await pool.query("UPDATE siwe_nonces SET expires_at=now()-interval '1 second' WHERE nonce=$1", [expired.nonce]);
  assert.equal((await post("/v1/auth/siwe/verify", expired)).error, "nonce_expired");
  assert.equal((await post("/v1/auth/logout", {}, v.session_token)).ok, true);
  assert.equal((await get("/v1/auth/session", v.session_token)).status, 401, "revoked");
  assert.equal((await get("/v1/auth/session", "bts_" + "x".repeat(40))).status, 401);
});

test("advertiser wallet <-> API key link: invalid / linked elsewhere / role gating; session works as advertiser auth", async () => {
  _resetRateLimits();
  advKey = (await admin("/api/admin/advertisers", { advertiser_id: "adv:portal", name: "Portal Adv" })).api_key;
  LID = (await fetch(base + "/v1/listings", { method: "POST", headers: H, body: JSON.stringify({ provider_id: "adv:portal", name: "Portal vector database MCP", description: "MCP server exposing a vector database", address: "https://portal-adv.example.com/mcp", kind: "mcp" }) }).then(J)).listing_id;
  const a = await signIn(owner, ["bot_owner", "advertiser"]);
  assert.deepEqual(a.roles, ["bot_owner"]); assert.equal(a.advertiser.link_required, true);
  assert.equal((await get("/v1/advertisers/me", a.session_token)).status, 401, "no advertiser role yet");
  assert.equal((await post("/v1/advertisers/me/link-key", { api_key: "adv_nope" }, a.session_token)).error, "api_key_invalid");
  const l = await post("/v1/advertisers/me/link-key", { api_key: advKey }, a.session_token);
  assert.equal(l.status, 200); assert.equal(l.advertiser_id, "adv:portal"); assert.ok(l.roles.includes("advertiser"));
  assert.equal((await get("/v1/advertisers/me", a.session_token)).advertiser_id, "adv:portal");
  const b = await signIn(other, ["advertiser"], { api_key: advKey });
  assert.equal(b.advertiser.error, "api_key_linked_elsewhere"); assert.ok(!b.roles.includes("advertiser"));
  assert.equal((await get("/v1/advertisers/me", b.session_token)).status, 401);
  const a2 = await signIn(owner, ["advertiser"]); assert.deepEqual(a2.roles, ["advertiser"], "linked wallet gets advertiser role on next sign-in");
  assert.equal((await get("/v1/advertisers/me", "bts_bogus_token_value_xxxxxxxxxxxxxxx")).status, 401);
  assert.equal((await get("/v1/advertisers/me", advKey)).advertiser_id, "adv:portal", "API key still works");
});

test("campaigns: list with pacing.ts fields, dry-run draft, insufficient balance, launch, detail/stats", async () => {
  _resetRateLimits();
  const tok = (await signIn(owner, ["advertiser"])).session_token;
  assert.equal((await get("/v1/pricing/impression-base")).fixed_cpi_atomic, 100);
  const tos = await get("/v1/tos/advertiser/latest"); assert.equal(tos.kind, "advertiser"); assert.match(tos.sha256, /^0x/);
  assert.deepEqual((await get("/v1/advertisers/me/campaigns", tok)).campaigns, [], "no bid/offer => no campaign");
  assert.equal((await get("/v1/advertisers/me/campaigns?all=1", tok)).campaigns[0].state, "none");
  const body = { listing_id: LID, bid_atomic: 200, incentive: { budget_atomic: 50_000, show_atomic: 10, click_atomic: 100 } };
  const d = await post("/v1/advertisers/me/campaigns", { ...body, dry_run: true }, tok);
  assert.equal(d.state, "draft"); assert.equal(d.summary.impression_cost_atomic, 300); assert.equal(d.summary.max_clicks, 454);
  assert.equal(d.status, 200, "over-balance preview still 200"); assert.equal(d.summary.balance_before_atomic, 0); assert.equal(d.summary.balance_after_atomic, 0, "never negative");
  assert.equal(d.summary.sufficient_balance, false); assert.equal(d.summary.shortfall_atomic, 50_000); assert.equal(d.summary.would_fail, "insufficient_balance");
  for (const bad of [{ bid_atomic: -1 }, { bid_atomic: 1.5 }, { bid_atomic: 999999 }, { incentive: { budget_atomic: -5 } }, { incentive: { click_atomic: "x" } }]) {
    const r = await post("/v1/advertisers/me/campaigns", { listing_id: LID, dry_run: true, ...bad }, tok); assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.error, "validation", JSON.stringify(r));
  }
  for (const bad of [{ bid_atomic: -1 }, { bid_atomic: "abc" }]) { const r = await fetch(`${base}/v1/advertisers/me/listings/${LID}/bid`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(bad) }).then(J); assert.equal(r.status, 400); assert.equal(r.error, "validation"); }
  const bi = await fetch(`${base}/v1/advertisers/me/listings/${LID}/incentive`, { method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify({ budget_atomic: 0 }) }).then(J); assert.equal(bi.error, "validation");
  const tu = await post("/v1/advertisers/me/topup?amount_atomic=5", {}, tok); assert.equal(tu.status, 400); assert.equal(tu.error, "validation");
  assert.equal((await post("/v1/advertisers/me/campaigns", body, tok)).error, "insufficient_balance");
  await admin("/api/admin/advertisers/adv:portal/credit", { amount_atomic: 100_000 });
  assert.equal((await post("/v1/advertisers/me/campaigns", { ...body, listing_id: "lst_nope" }, tok)).status, 404);
  assert.equal((await post("/v1/advertisers/me/campaigns", { ...body, bid_atomic: -1 }, tok)).status, 400);
  const okd = await post("/v1/advertisers/me/campaigns", { ...body, dry_run: true }, tok); assert.equal(okd.summary.sufficient_balance, true); assert.equal(okd.summary.shortfall_atomic, 0); assert.equal(okd.summary.would_fail, null); assert.equal(okd.summary.balance_after_atomic, 50_000);
  const c = await post("/v1/advertisers/me/campaigns", body, tok);
  assert.equal(c.status, 201); assert.equal(c.state, "launched"); assert.equal(c.campaign.bid_atomic, 200); assert.equal(c.campaign.state, "active");
  const list = await get("/v1/advertisers/me/campaigns", tok);
  assert.equal(list.campaigns.length, 1);
  const p = list.campaigns[0].pacing;
  for (const k of ["status", "t_ppm", "lag_ppm", "boost_ppm", "budget_atomic", "consumed", "remaining", "pool", "offer_seq", "expires_ms"]) assert.ok(k in p, k);
  assert.ok(["on_track", "behind", "at_risk", "expired", "no_budget", "inactive"].includes(p.status));
  assert.equal(list.kpis.balance_atomic, 100_000);
  const me = await get("/v1/advertisers/me", tok); assert.equal(me.balance_atomic, 100_000); assert.equal(typeof me.spend_atomic, "number"); assert.equal(me.balance, "100000", "deprecated string kept");
  assert.ok(me.ledger.every((l: any) => typeof l.delta_atomic === "number"));
  const st = await get(`/v1/advertisers/me/listings/${LID}/stats?range=7d`, tok);
  assert.equal(st.status, 200); assert.equal(st.pacing.budget_atomic, 50_000); assert.ok(st.pacing_card); assert.ok(st.accounting);
  assert.equal((await get(`/v1/advertisers/me/campaigns/${LID}`, advKey)).listing_id, LID);
  assert.equal((await get(`/v1/advertisers/me/listings/${LID}/stats?range=1y`, tok)).status, 400);
  const otherAdv = (await admin("/api/admin/advertisers", { advertiser_id: "adv:other", name: "O" })).api_key;
  assert.equal((await get(`/v1/advertisers/me/listings/${LID}/stats`, otherAdv)).status, 403);
});

test("bot-owner monitoring is scoped to the signed-in wallet (+ linked wallets); replay MATCH; appeal", async () => {
  _resetRateLimits();
  for (let i = 0; i < 3; i++) assert.equal((await rec(owner.address, "portal-bot")).status, 200);
  assert.equal((await rec(owner.address, null)).status, 200);
  assert.equal((await rec(other.address, "other-bot")).status, 200);
  const tok = (await signIn(owner)).session_token;
  const me = await get("/v1/bots/me", tok);
  assert.deepEqual(me.bots.map((b: any) => b.bot_id).sort(), [null, "portal-bot"].sort());
  const pb = me.bots.find((b: any) => b.bot_id === "portal-bot");
  assert.equal(pb.queries_30d, 3); assert.equal(pb.ban.status, "not banned"); assert.deepEqual(pb.paying_wallets, [owner.address.toLowerCase()]);
  const st = await get("/v1/bots/me/portal-bot/stats?range=24h", tok);
  assert.equal(st.queries, 3); assert.equal(st.clicks.by_rank.length, 10); assert.ok("organic" in st.results_mix); assert.equal(st.bucket, "hour");
  assert.equal((await get("/v1/bots/me/_none/stats", tok)).queries, 1);
  assert.equal((await get("/v1/bots/me/other-bot/stats", tok)).status, 404, "other wallet's bot not visible");
  const rq = await get("/v1/bots/me/portal-bot/requests?limit=2", tok);
  assert.equal(rq.requests.length, 2); assert.ok(rq.next_cursor);
  const rq2 = await get(`/v1/bots/me/portal-bot/requests?limit=2&cursor=${rq.next_cursor}`, tok); assert.equal(rq2.requests.length, 1); assert.equal(rq2.next_cursor, null);
  const csv = await fetch(base + "/v1/bots/me/portal-bot/requests?format=csv", { headers: { authorization: "Bearer " + tok } });
  assert.match(csv.headers.get("content-type")!, /text\/csv/); assert.equal((await csv.text()).trim().split("\n").length, 4);
  for (const r of [...rq.requests, ...rq2.requests]) { const rp = await get(r.replay_url); assert.equal(rp.match, true, "replay MATCH " + r.request_id); assert.equal(rp.logged_hash, r.response_hash); }
  // link a second paying wallet (SIWE signed by that wallet, resource botiny:link:<owner>)
  const noRes = await siwe(other); assert.equal((await post("/v1/bots/me/wallets", { siwe_message: noRes.message, signature: noRes.signature }, tok)).error, "link_resource_missing");
  const ln = await siwe(other, { resources: [`botiny:link:${owner.address.toLowerCase()}`] });
  assert.equal((await post("/v1/bots/me/wallets", { siwe_message: ln.message, signature: ln.signature }, tok)).status, 201);
  assert.ok((await get("/v1/bots/me", tok)).bots.some((b: any) => b.bot_id === "other-bot"));
  const s3 = (await signIn(stranger)).session_token;
  const ln2 = await siwe(other, { resources: [`botiny:link:${stranger.address.toLowerCase()}`] });
  assert.equal((await post("/v1/bots/me/wallets", { siwe_message: ln2.message, signature: ln2.signature }, s3)).error, "wallet_linked_elsewhere");
  assert.deepEqual((await get("/v1/bots/me", s3)).bots, []);
  const ns = await get("/v1/bots/me/_none/stats?range=7d", s3); assert.equal(ns.status, 200); assert.equal(ns.queries, 0); assert.deepEqual(ns.series, []); assert.equal(ns.clicks.links, 0); assert.equal(ns.bot_id, null);
  const nr = await get("/v1/bots/me/_none/requests", s3); assert.equal(nr.status, 200); assert.deepEqual(nr.requests, []); assert.equal(nr.next_cursor, null);
  assert.equal((await get("/v1/bots/me/nobot/stats", s3)).status, 404, "named bots still 404 when not yours");
  const meJ = JSON.stringify(await get("/v1/bots/me", tok)) + JSON.stringify(await get("/v1/bots/me/portal-bot/stats", tok)) + JSON.stringify(await get("/v1/bots/me/portal-bot/requests", tok));
  assert.ok(!/taster/.test(meJ), "no free-taster fields");
  const e = await get("/v1/bots/me/earnings", tok); assert.equal(e.wallets.length, 2);
  assert.equal((await get("/v1/bots/me/earnings")).status, 401, "unsigned, no session: still 401");
  // appeal
  assert.equal((await post("/v1/bots/portal-bot/appeal", { message: "please review my bot" }, tok)).error, "not_banned");
  assert.equal((await admin("/api/admin/bans", { kind: "bot", value: "portal-bot", reason: "test ban" })).status < 300, true);
  assert.equal((await get("/v1/bots/me", tok)).bots.find((b: any) => b.bot_id === "portal-bot").ban.status, "banned");
  assert.equal((await get("/v1/bots/me/portal-bot/stats", tok)).earnings.frozen, true);
  assert.equal((await post("/v1/bots/portal-bot/appeal", { message: "please review my bot" }, tok)).status, 201);
  assert.equal((await post("/v1/bots/portal-bot/appeal", { message: "please review my bot" }, tok)).error, "appeal_open");
  assert.equal((await post("/v1/bots/portal-bot/appeal", { message: "please review my bot" }, s3)).status, 404);
});

test("suggestion URL validation", () => {
  for (const u of ["ftp://x.com/a", "http://localhost/a", "http://127.0.0.1/a", "http://[::1]/", "https://user:pw@x.com/", "https://x.com:8080/", "https://intranet/", "https://foo.internal/x", "javascript:alert(1)", "", "https://a." + "b".repeat(300) + ".com"])
    assert.throws(() => validateSuggestionUrl(u), u);
  assert.equal(validateSuggestionUrl("https://API.Example.com/v1/#frag").norm, "https://api.example.com/v1");
});

test("suggestions: submit / duplicate / rate limit / mine / admin accept -> crawler queue -> indexed|needs_review; reject; claim", async () => {
  _resetRateLimits();
  const tok = (await signIn(owner)).session_token;
  assert.equal((await post("/v1/suggestions", { url: "http://10.0.0.1/x", type: "other", name: "n" })).error, "validation");
  assert.equal((await post("/v1/suggestions", { url: "https://ok.example.com", type: "nope", name: "n" })).error, "validation");
  assert.equal((await post("/v1/suggestions", { url: "https://ok.example.com", type: "other", name: "x".repeat(81) })).error, "validation");
  _resetRateLimits();
  const s1 = await post("/v1/suggestions", { url: "https://weather-x402.example.com/api", type: "x402_api", name: "Weather x402", description: "Paid weather forecasts via x402", contact: "@weatherbot" }, tok);
  assert.equal(s1.status, 201); assert.equal(s1.state, "submitted"); assert.equal(s1.claim_wallet, owner.address.toLowerCase()); assert.ok(s1.claim.challenge);
  const dup = await post("/v1/suggestions", { url: "https://weather-x402.example.com/api/", type: "x402_api", name: "Weather again" }, tok);
  assert.equal(dup.state, "duplicate"); assert.equal(dup.duplicate_of, s1.id);
  const dupL = await post("/v1/suggestions", { url: "https://portal-adv.example.com/mcp", type: "mcp_server", name: "Already listed" }, tok);
  assert.equal(dupL.state, "duplicate"); assert.equal(dupL.duplicate_of, LID);
  const anon = await post("/v1/suggestions", { url: "https://lowq.example.com/thing", type: "other", name: "Low quality thing" });
  assert.equal(anon.status, 201);
  const mine = await get("/v1/suggestions", tok); assert.equal(mine.suggestions.length, 3);
  assert.equal((await get("/v1/suggestions?state=duplicate", tok)).suggestions.length, 2);
  const pub = await get(`/v1/suggestions/${s1.id}`); assert.equal(pub.state, "submitted"); assert.equal(pub.contact, undefined, "public view hides contact");
  // rate limit (5 / 10 min / IP)
  const rl = await post("/v1/suggestions", { url: "https://rl.example.com/x", type: "other", name: "rl" });
  assert.equal(rl.status, 201);
  const lim = await post("/v1/suggestions", { url: "https://rl2.example.com/x", type: "other", name: "rl" });
  assert.equal(lim.status, 429); assert.ok(lim.headers.get("retry-after"));
  // admin review -> crawler queue
  assert.equal((await fetch(base + "/dashboard/api/suggestions")).status, 401);
  const acc = await admin(`/api/suggestions/${s1.id}/accept`, {});
  assert.equal(acc.suggestion.state, "queued");
  assert.equal((await get(`/v1/suggestions/${s1.id}`, tok)).detail.position, 1);
  assert.equal((await admin(`/api/suggestions/${s1.id}/accept`, {})).status, 409);
  const job = (await pool.query("SELECT * FROM crawl_jobs WHERE job_id=$1", [acc.suggestion.crawl_job_id])).rows[0];
  assert.equal(job.kind, "suggestion"); assert.equal(job.status, "queued");
  _setResolver(async () => ["10.1.2.3"]);   // private address => needs_review, never fetched
  await runJob(job);
  let g = await get(`/v1/suggestions/${s1.id}`, tok); assert.equal(g.state, "needs_review"); assert.match(g.detail.needed, /non-public/);
  _setResolver(async () => ["93.184.215.14"]);
  await pool.query("UPDATE listing_suggestions SET state='queued' WHERE suggestion_id=$1", [s1.id]);
  process.env.CRAWL_PUBLISH_MIN_QUALITY = "1";
  const before = (await pool.query("SELECT max(seq)::int m FROM listings")).rows[0].m;
  const r = await runJob(job);
  g = await get(`/v1/suggestions/${s1.id}`, tok);
  assert.equal(g.state, "indexed", JSON.stringify(g)); assert.match(g.listing_id, /^lst_/);
  assert.ok((await pool.query("SELECT max(seq)::int m FROM listings")).rows[0].m > before, "appended as a new listing row");
  process.env.CRAWL_PUBLISH_MIN_QUALITY = "99";
  const a2 = await admin(`/api/suggestions/${anon.id}/accept`, {});
  await runJob((await pool.query("SELECT * FROM crawl_jobs WHERE job_id=$1", [a2.suggestion.crawl_job_id])).rows[0]);
  assert.equal((await get(`/v1/suggestions/${anon.id}`)).state, "needs_review");
  const pb = await admin(`/api/suggestions/${anon.id}/publish`, {}); assert.equal(pb.suggestion.state, "indexed");
  delete process.env.CRAWL_PUBLISH_MIN_QUALITY; _setResolver(null);
  assert.equal((await admin(`/api/suggestions/${rl.id}/reject`, {})).status, 400, "reason required");
  assert.equal((await admin(`/api/suggestions/${rl.id}/reject`, { reason: "not a bot service" })).suggestion.state, "rejected");
  assert.equal((await get(`/v1/suggestions/${rl.id}`)).reason, "not a bot service");
  const list = await admin("/api/suggestions?state=indexed"); assert.equal(list.suggestions.length, 2);
  // every request made so far still replays MATCH after new listings were published
  for (const { request_id } of (await pool.query("SELECT request_id FROM requests")).rows) assert.equal((await get(`/v1/requests/${request_id}/replay`)).match, true);
  // ownership claim: signature over the challenge + a proof method (checker injected; no network in tests)
  const row = (await pool.query("SELECT * FROM listing_suggestions WHERE suggestion_id=$1", [s1.id])).rows[0];
  assert.equal((await post(`/v1/suggestions/${s1.id}/claim`, { method: "well_known", signature: await other.signMessage({ message: claimChallenge(row) }) }, tok)).error, "bad_signature");
  _setClaimChecker(async (m, s) => ({ ok: m === "well_known" && !!s.claim.token }));
  const cl = await post(`/v1/suggestions/${s1.id}/claim`, { method: "well_known", signature: await owner.signMessage({ message: claimChallenge(row) }) }, tok);
  assert.equal(cl.status, 200); assert.equal(cl.claim.status, "verified");
  const cf = await post(`/v1/suggestions/${s1.id}/claim`, { method: "dns_txt", signature: await owner.signMessage({ message: claimChallenge(row) }) }, tok);
  assert.equal(cf.status, 422); assert.equal(cf.claim.status, "failed");
  _setClaimChecker(null);
  const s3 = (await signIn(stranger)).session_token;
  assert.equal((await post(`/v1/suggestions/${s1.id}/claim`, { method: "dns_txt", signature: "0x00" }, s3)).error, "wrong_wallet");
});

test("SIWE nonces are independent 128-bit CSPRNG values (regression: viem generateSiweNonce sliding window)", async () => {
  const { generateSiweNonce } = await import("viem/siwe");
  const v1 = generateSiweNonce(), v2 = generateSiweNonce();
  assert.equal(v1.slice(1), v2.slice(0, -1), "root cause reproduced: viem uid() slides one char per call");
  const { newNonceValue } = await import("../src/portal");
  const ns = Array.from({ length: 2000 }, newNonceValue);
  assert.equal(new Set(ns).size, ns.length);
  for (const n of ns) assert.match(n, /^[0-9a-f]{32}$/);
  for (let i = 1; i < ns.length; i++) { assert.notEqual(ns[i].slice(0, -1), ns[i - 1].slice(1)); assert.notEqual(ns[i].slice(0, 16), ns[i - 1].slice(16)); }
  // via the endpoint too, and check shared-prefix/overlap is no better than chance
  _resetRateLimits();
  const api = []; for (let i = 0; i < 20; i++) api.push((await get("/v1/auth/siwe/nonce")).nonce);
  for (const n of api) assert.match(n, /^[0-9a-f]{32}$/);
  for (let i = 1; i < api.length; i++) for (let k = 4; k < 32; k++) assert.notEqual(api[i].slice(0, k), api[i - 1].slice(32 - k), `overlap ${k}`);
  // other tokens: session tokens and claim tokens independent too
  _resetRateLimits();
  const toks = [] as string[]; for (let i = 0; i < 5; i++) toks.push((await signIn(stranger)).session_token);
  for (const t of toks) assert.match(t, /^bts_[A-Za-z0-9_-]{43}$/);
  for (let i = 1; i < toks.length; i++) assert.notEqual(toks[i].slice(4, 20), toks[i - 1].slice(5, 21));
  const claims = (await pool.query("SELECT claim->>'token' t FROM listing_suggestions WHERE claim IS NOT NULL")).rows.map(r => r.t);
  assert.ok(claims.length >= 2); for (const c of claims) assert.match(c, /^[0-9a-f]{32}$/);
});

test("error shape: {error: code, message} everywhere", async () => {
  const a = await get("/v1/advertisers/me"); assert.equal(a.status, 401); assert.equal(a.error, "advertiser_auth_required"); assert.match(a.message, /API key.*linked to an advertiser/);
  const e = await get("/v1/bots/me/earnings"); assert.equal(e.error, "wallet_required"); assert.ok(e.message);
  const n = await get("/v1/requests/req_nope"); assert.equal(n.status, 404); assert.equal(n.error, "not_found"); assert.ok(n.message);
  const r = await get("/v1/nope"); assert.equal(r.status, 404); assert.equal(r.error, "not_found");
  const s = await get("/v1/auth/session"); assert.equal(s.error, "no_session"); assert.ok(s.message);
  const bj = await fetch(base + "/v1/suggestions", { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" }).then(J); assert.equal(bj.status, 400); assert.equal(bj.error, "invalid_json");
  const v = await post("/v1/suggestions", { url: "ftp://x.com", type: "other", name: "x" }); assert.equal(v.error, "validation"); assert.match(v.message, /http/);
});

test("portal front end served same-origin at /portal (static allow-list, no CORS)", async () => {
  const idx = await fetch(base + "/portal/"); assert.equal(idx.status, 200); assert.match(idx.headers.get("content-type")!, /html/);
  const si = await fetch(base + "/portal/signin.html"); assert.equal(si.status, 200); assert.equal(si.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(base + "/portal/assets/app.js")).status, 200);
  assert.match((await fetch(base + "/portal/assets/config.js").then(r => r.text())), /apiBase: ""/);
  for (const p of ["/portal/serve.py", "/portal/README.md", "/portal/test_fixtures.py", "/portal/..%2f..%2fbot-rec-market%2fapi%2f.env", "/portal/assets/../serve.py"]) assert.equal((await fetch(base + p)).status, 404, p);
  const pre = await fetch(base + "/v1/auth/session", { method: "OPTIONS", headers: { origin: "https://evil.example.com", "access-control-request-method": "GET" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), null, "CORS stays off");
});

test("advertiser wallet unlink: DELETE /v1/advertisers/me/link (key or session, CSRF, audit), relink; admin unlink", async () => {
  _resetRateLimits();
  const k = (await admin("/api/admin/advertisers", { advertiser_id: "adv:unlink", name: "U" })).api_key;
  const w = privateKeyToAccount(generatePrivateKey());
  const s1 = await signIn(w, ["advertiser"], { api_key: k }); assert.ok(s1.roles.includes("advertiser"));
  const ck = (await fetch(base + "/v1/auth/session", { headers: { authorization: "Bearer " + s1.session_token } })).headers; void ck;
  // cookie DELETE without X-Botiny-Client => csrf
  const v = await post("/v1/auth/siwe/verify", await siwe(w, { roles: ["advertiser"] }));
  const cookie = v.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await fetch(base + "/v1/advertisers/me/link", { method: "DELETE", headers: { cookie } }).then(J)).error, "csrf");
  assert.equal((await fetch(base + "/v1/advertisers/me/link", { method: "DELETE" }).then(J)).error, "advertiser_auth_required");
  const u = await fetch(base + "/v1/advertisers/me/link", { method: "DELETE", headers: { cookie, "X-Botiny-Client": "portal" } }).then(J);
  assert.equal(u.status, 200); assert.equal(u.address, w.address.toLowerCase()); assert.equal(u.unlinked, true);
  assert.equal((await get("/v1/advertisers/me", s1.session_token)).error, "advertiser_auth_required", "role stripped from live sessions");
  assert.ok(!(await get("/v1/auth/session", s1.session_token)).roles.includes("advertiser"));
  assert.equal((await fetch(base + "/v1/advertisers/me/link", { method: "DELETE", headers: { authorization: "Bearer " + k } }).then(J)).error, "not_linked");
  // relink with a different wallet, then unlink by API key, then admin unlink
  const w2 = privateKeyToAccount(generatePrivateKey());
  const s2 = await signIn(w2, ["advertiser"], { api_key: k }); assert.ok(s2.roles.includes("advertiser"), "relink after unlink");
  assert.equal((await fetch(base + "/v1/advertisers/me/link", { method: "DELETE", headers: { authorization: "Bearer " + k } }).then(J)).status, 200);
  const s3 = await signIn(w, ["advertiser"], { api_key: k }); assert.ok(s3.roles.includes("advertiser"), "original wallet can relink");
  const st = await admin("/api/admin/state"); assert.equal(st.advertisers.find((a: any) => a.advertiser_id === "adv:unlink").linked_wallet, w.address.toLowerCase());
  assert.equal((await admin("/api/admin/advertisers/adv:unlink/unlink", {})).unlinked, true);
  assert.equal((await admin("/api/admin/advertisers/adv:unlink/unlink", {})).status, 404);
  const aud = (await pool.query("SELECT actor, action FROM admin_audit WHERE action='advertiser_wallet_unlink' ORDER BY id")).rows;
  assert.equal(aud.length, 3); assert.match(aud[0].actor, /advertiser-session/); assert.match(aud[1].actor, /advertiser-key/);
});
