import { makeConfig } from '../src/config.js';
import { MemoryStore } from '../src/memory-store.js';
import { ClickEngine } from '../src/engine.js';
import { generateKeyPair } from '../src/token.js';

export const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
export const BROWSER = { ua: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36',
  headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate', 'accept-language': 'en-GB' } };

export async function setup(overrides = {}) {
  const cfg = makeConfig(overrides);
  const kp = await generateKeyPair();
  const store = new MemoryStore();
  const engine = new ClickEngine({ store, cfg, signingKey: kp.privateKey, kid: 'k1', verifyKeys: { k1: kp.publicKey }, keySecret: 'test-secret', shortBase: 'https://bsrc.test' });
  return { cfg, store, engine, kp };
}
let n = 0;
/** n clusters × perCluster listings, each offering show/click (atomic). */
export function ranked({ clusters = 5, perCluster = 1, show = 2500, click = 2500, rel = 0.9 } = {}) {
  const out = [];
  for (let c = 0; c < clusters; c++) for (let j = 0; j < perCluster; j++)
    out.push({ listing_id: `L${c}_${j}`, cluster_id: `C${c}`, provider_id: `P${c}`, relevance: rel - (out.length * 0.001), dest_url: `https://p${c}.example/l${j}`, show_offer_atomic: show, click_offer_atomic: click });
  return out;
}
export async function issue(engine, opts = {}) {
  const { now = T0, channel = 'chat', bot = '0xbot', r = ranked() } = opts;
  return engine.issueSet({ set_id: opts.set_id ?? `S${++n}`, request_id: `R${n}`, bot_wallet: bot, channel, ranked: r, now });
}
let ip = 1;
export const freshIp = () => `81.${(ip >> 8) & 255}.${ip++ & 255}.7`;
export function click(engine, token, { ts = T0 + 60_000, ip = freshIp(), ua = BROWSER.ua, headers = BROWSER.headers, method = 'GET' } = {}) {
  return engine.scoreClick({ click_id: `ck${Math.random().toString(36).slice(2)}`, token, ts, ip, ua, headers, method });
}
