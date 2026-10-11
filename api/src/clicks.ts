// Wires click-server issuance into /v1/recommend. Issuance runs INSIDE the recommend transaction:
// harvest_tokens + short_links rows and balance_ledger 'incentive_escrow' debits commit or roll back
// together with requests/impressions.
//
// Replay design: click tokens / short links are kept OUT of the hashed `response` and returned as a
// sibling `click_links`. Tokens contain iat, a random nonce and an Ed25519 signature from a key that
// will be rotated; making them deterministic would mean deriving nonces from secrets and freezing keys,
// and would couple ranking proof to payout plumbing. Incentives never change rank (Incentive model C5),
// so the ranked response stays the replayable artefact; the issued links are auditable separately via
// harvest_tokens.request_id + requests.click_kid/click_config + balance_ledger escrow rows.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import type { Settings } from "./settings";

const CS = join(__dirname, "..", "..", "click-server", "src");
const load = (f: string) => import(pathToFileURL(join(CS, f)).href);

type Keys = { kid: string; privateKey: CryptoKey; publicKey: CryptoKey } | null;
let keysP: Promise<Keys> | null = null;
/** Signing key: CLICK_SIGNING_KEY_JWK (Ed25519 private JWK, from the deploy secret store) + CLICK_KID.
 *  Without it, mock/test mode uses an ephemeral key; otherwise incentives are disabled (no links). */
export function clickKeys(): Promise<Keys> {
  return keysP ??= (async () => {
    const raw = process.env.CLICK_SIGNING_KEY_JWK;
    if (raw) {
      const jwk = JSON.parse(raw);
      const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
      const publicKey = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, true, ["verify"]);
      return { kid: process.env.CLICK_KID ?? "k1", privateKey, publicKey };
    }
    if (process.env.PAYMENT_MODE !== "mock" && process.env.CLICK_EPHEMERAL_KEY !== "1") return null;
    const { generateKeyPair } = await load("token.js");
    const kp = await generateKeyPair();
    return { kid: "ephemeral-" + Date.now(), privateKey: kp.privateKey, publicKey: kp.publicKey };
  })();
}
export function _resetClickKeys() { keysP = null; }

export async function clickConfig(settings: Settings) {
  const { makeConfig } = await load("config.js");
  // Fee f = the pinned query price. θ defaults to the ranker's own threshold (results already passed it);
  // override with CS_CFG_minRelevance (0..1 on the score_ppm/1e6 scale).
  return makeConfig({ feeAtomic: settings.query_price_atomic, minRelevance: settings.relevance_threshold_ppm / 1e6 }, process.env);
}

/** PG writer for issued rows (the click-server MemoryStore is used as the issuance buffer). */
async function persist(client: PoolClient, store: any, request_id: string) {
  for (const t of store.harvestTokens.values())
    await client.query(`INSERT INTO harvest_tokens(token,kid,result_id,set_id,request_id,rank,listing_id,provider_id,cluster_id,bot_wallet,channel,dest_url,dest_url_hash,show_atomic,click_atomic,issued_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,to_timestamp($16/1000.0),to_timestamp($17/1000.0))`,
      [t.token, t.kid, t.result_id, t.set_id, request_id, t.rank, t.listing_id, t.provider_id, t.cluster_id, t.bot_wallet, t.channel, t.dest_url, t.dest_url_hash, t.show_atomic, t.click_atomic, t.issued_at, t.expires_at]);
  for (const l of store.shortLinks.values())
    await client.query("INSERT INTO short_links(code,token,dest_url,exp) VALUES ($1,$2,$3,to_timestamp($4/1000.0))", [l.code, l.token, l.dest_url, l.exp]);
}

const CHANNELS = new Set(["chat", "web", "x", "onchain", "bot"]);

/**
 * Issue signed per-result links for a ranked response, escrow provider funds, and persist — all on `client`
 * (caller holds MARKET_LOCK inside the recommend transaction). Returns provider ids debited (for the
 * never-negative assertion) and the click_links to return beside the hashed response.
 */
export async function issueClickLinks(client: PoolClient, a: {
  request_id: string; bot_wallet: string; channel?: string | null; market_seq: number; settings: Settings;
  results: { rank: number; listing_id: string; address: string; score_ppm: number }[]; providers: string[];
}) {
  const keys = await clickKeys();
  if (!keys || !a.results.length) return { click_links: [] as any[], debited: [] as string[], config: null, kid: null };
  const channel = a.channel && CHANNELS.has(a.channel) ? a.channel : "chat";
  const cfg = await clickConfig(a.settings);
  const { MemoryStore } = await load("memory-store.js");
  const { ClickEngine } = await load("engine.js");
  const { buildResultSet } = await load("curation.js");
  const ids = a.results.map(r => r.listing_id);
  // offers pinned at market_seq (same snapshot as ranking); only funded advertisers can offer
  const offers = new Map<string, { s: number; c: number }>((await client.query(
    `SELECT DISTINCT ON (listing_id) listing_id, show_atomic, click_atomic FROM incentive_offers WHERE seq <= $1 AND listing_id = ANY($2) ORDER BY listing_id, seq DESC`,
    [a.market_seq, ids])).rows.map(r => [r.listing_id, { s: Number(r.show_atomic), c: Number(r.click_atomic) }]));
  // live balance AFTER this request's impression debits (same tx, under MARKET_LOCK)
  const bal = new Map<string, number>((await client.query(
    `SELECT advertiser_id, COALESCE(SUM(delta_atomic),0)::text b FROM balance_ledger WHERE advertiser_id = ANY($1) GROUP BY 1`, [[...new Set(a.providers)]])).rows
    .map(r => [r.advertiser_id, Number(r.b)]));
  let ranked = a.results.map((r, i) => {
    const o = offers.get(r.listing_id); const funded = bal.has(a.providers[i]);
    return { listing_id: r.listing_id, response_rank: r.rank, cluster_id: a.providers[i], provider_id: a.providers[i], relevance: r.score_ppm / 1e6, dest_url: r.address,
      show_offer_atomic: funded && o ? o.s : 0, click_offer_atomic: funded && o ? o.c : 0 };
  });
  // Never-negative: a provider whose balance can't cover its capped total in this set carries no incentive here.
  const pre = buildResultSet(ranked, cfg).items as any[];
  const need = new Map<string, number>();
  for (const it of pre) need.set(it.cluster_id, (need.get(it.cluster_id) ?? 0) + it.show_atomic + it.click_atomic);
  const unaffordable = new Set([...need].filter(([p, n]) => n > 0 && (bal.get(p) ?? 0) < n).map(([p]) => p));
  ranked = ranked.map(r => unaffordable.has(r.cluster_id) ? { ...r, show_offer_atomic: 0, click_offer_atomic: 0 } : r);

  const store = new MemoryStore();
  const engine = new ClickEngine({ store, cfg, signingKey: keys.privateKey, kid: keys.kid, verifyKeys: { [keys.kid]: keys.publicKey },
    keySecret: "", shortBase: (process.env.CLICK_SHORT_BASE ?? "https://bsrc.link").replace(/\/$/, "") });
  // Curation keeps relevance order (C5); results the curator drops (C3/C4/θ) simply carry no link.
  const set = await engine.issueSet({ set_id: a.request_id, request_id: a.request_id, bot_wallet: a.bot_wallet, channel, ranked });
  await persist(client, store, a.request_id);
  const perProvider = new Map<string, number>();
  for (const t of store.harvestTokens.values()) perProvider.set(t.provider_id, (perProvider.get(t.provider_id) ?? 0) + t.show_atomic + t.click_atomic);
  const debited: string[] = [];
  for (const [p, amt] of perProvider) if (amt > 0) {
    await client.query(`INSERT INTO balance_ledger(advertiser_id,delta_atomic,kind,request_id,note) VALUES ($1,$2,'incentive_escrow',$3,$4)`,
      [p, -amt, a.request_id, `click-server escrow, channel ${channel}`]);
    debited.push(p);
  }
  const config = { fee_atomic: cfg.feeAtomic, line_item_cap_mult: cfg.lineItemCapMult, cluster_cap_mult: cfg.clusterCapMult, set_cap_mult: cfg.setCapMult,
    max_slots_per_cluster: cfg.maxSlotsPerCluster, min_relevance: cfg.minRelevance, min_distinct_clusters: cfg.minDistinctClusters, channel };
  const click_links = set.results.map((r: any) => ({ rank: r.rank, listing_id: r.listing_id,
    short_url: r.short_url, track_url: r.track_url, harvest_token: r.harvest_token,
    show_incentive_atomic: r.show_incentive_atomic, click_incentive_atomic: r.click_incentive_atomic, disclosure: r.disclosure }));
  return { click_links, debited, config, kid: keys.kid, escrow_atomic: set.escrow_atomic };
}
