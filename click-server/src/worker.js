// Edge handler, Cloudflare Workers-compatible: export default { fetch(request, env, ctx) }.
// Redirect is sent immediately; click logging goes through ctx.waitUntil -> queue (env.enqueue).
import { base62Code } from './b64.js';

const SEC = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains', 'X-Content-Type-Options': 'nosniff' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...SEC, 'content-type': 'application/json' } });
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function makeHandler(engine, { enqueue, jwks = [] }) {
  return async function fetch(request, env = {}, ctx = { waitUntil: p => p }) {
    const url = new URL(request.url); const p = url.pathname;
    if (p === '/' ) return new Response('Bot Source short links. Privacy: no cookies, no JS; truncated, salted-hash request data used for fraud prevention. See /privacy.', { headers: SEC });
    if (p === '/.well-known/botsource-keys') return json(200, { keys: jwks });
    if (p === '/v1/proofs' && request.method === 'POST') {
      let body, rawBody; try { rawBody = await request.text(); body = JSON.parse(rawBody); } catch { return json(400, { error: 'bad_json' }); }
      const r = await engine.submitProof({ body, rawBody, headers: Object.fromEntries(request.headers) });
      return json(r.status, r.body ?? { error: r.error });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(405, { error: 'method' });
    let m = /^\/r\/(hv_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(p);
    let preview = false, id;
    if (m) id = m[1];
    else if ((m = /^\/([0-9A-Za-z]{10,12})(\/preview)?$/.exec(p))) { id = m[1]; preview = !!m[2]; }
    else return json(404, { error: 'not_found' });
    const hit = await engine.resolve(id);
    if (!hit) return json(404, { error: 'unknown_link' });
    const dest = hit.row.dest_url;
    if (preview) return new Response(`<!doctype html><meta property="og:url" content="${esc(dest)}"><meta property="og:title" content="Incentivised listing"><title>Incentivised listing</title><a href="${esc(dest)}">${esc(dest)}</a> <a href="/privacy">Privacy</a>`, { headers: { ...SEC, 'content-type': 'text/html; charset=utf-8' } });
    const click_id = `ck_${base62Code(16)}`;
    const h = Object.fromEntries(request.headers);
    const ev = { click_id, token: hit.token, ts: Date.now(), method: request.method,
      ip: h['cf-connecting-ip'] ?? env.clientIp ?? null, ua: h['user-agent'] ?? '', headers: h,
      cfBotScore: request.cf?.botManagement?.score };
    ctx.waitUntil(Promise.resolve().then(() => enqueue(ev)).catch(() => {}));
    const loc = new URL(dest); loc.searchParams.set('bs_click', click_id);
    return new Response(null, { status: 302, headers: { ...SEC, Location: loc.toString() } });
  };
}
