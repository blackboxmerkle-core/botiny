import test from 'node:test'; import assert from 'node:assert/strict';
import { setup, issue } from './helpers.js';
import { makeHandler } from '../src/worker.js';
import { exportPublicJwk } from '../src/token.js';

async function env() {
  const s = await setup(); const queued = [];
  const h = makeHandler(s.engine, { enqueue: ev => queued.push(ev), jwks: [await exportPublicJwk(s.kp.publicKey, 'k1')] });
  const set = await issue(s.engine, { now: Date.now() });
  return { ...s, h, queued, set };
}
const waits = []; const ctx = { waitUntil: p => waits.push(p) };

test('GET /:code -> 302 to stored dest, async enqueue, no cookies', async () => {
  const { h, queued, set } = await env();
  const r0 = set.results[0]; const code = r0.short_url.split('/').pop();
  assert.match(code, /^[0-9A-Za-z]{12}$/);
  const res = await h(new Request(`https://bsrc.test/${code}`, { headers: { 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': '81.2.3.4' } }), {}, ctx);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://p0.example/l0'); assert.match(loc.searchParams.get('bs_click'), /^ck_/);
  assert.equal(res.headers.get('set-cookie'), null); assert.equal(res.headers.get('cache-control'), 'no-store');
  await Promise.all(waits);
  assert.equal(queued.length, 1); assert.equal(queued[0].token, r0.harvest_token); assert.equal(queued[0].ip, '81.2.3.4');
});
test('GET /r/:token works; tampered/unknown -> 404, no open redirect', async () => {
  const { h, set } = await env();
  const t = set.results[1].harvest_token;
  assert.equal((await h(new Request(`https://bsrc.test/r/${t}`), {}, ctx)).status, 302);
  assert.equal((await h(new Request(`https://bsrc.test/r/${t.slice(0, -3)}AAA`), {}, ctx)).status, 404);
  assert.equal((await h(new Request(`https://bsrc.test/r/${t}?to=https://evil.example`), {}, ctx)).headers.get('location').startsWith('https://p1.example/'), true);
  assert.equal((await h(new Request('https://bsrc.test/ZZZZZZZZZZZZ'), {}, ctx)).status, 404);
});
test('preview page for unfurlers, JWKS endpoint', async () => {
  const { h, set } = await env();
  const code = set.results[0].short_url.split('/').pop();
  const res = await h(new Request(`https://bsrc.test/${code}/preview`), {}, ctx);
  assert.equal(res.status, 200); assert.match(await res.text(), /Incentivised listing/);
  const j = await (await h(new Request('https://bsrc.test/.well-known/botsource-keys'), {}, ctx)).json();
  assert.equal(j.keys[0].kid, 'k1'); assert.equal(j.keys[0].d, undefined);
});
test('POST /v1/proofs: wallet binding, dedupe, channel validation', async () => {
  const { h, set } = await env(); const t = set.results[0].harvest_token;
  const post = (body, wallet = '0xBOT') => h(new Request('https://bsrc.test/v1/proofs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-wallet': wallet }, body: JSON.stringify(body) }), {}, ctx);
  const ok = await post({ token: t, channel: 'web', artefact: 'https://blog.example/post' });
  assert.equal(ok.status, 201); assert.match((await ok.json()).proof_id, /^pf_/);
  assert.equal((await post({ token: t, channel: 'web', artefact: 'https://blog.example/2' })).status, 409);
  assert.equal((await post({ token: t, channel: 'x', artefact: '123' }, '0xother')).status, 403);
  assert.equal((await post({ token: t, channel: 'farcaster', artefact: 'x' })).status, 400);
  assert.equal((await post({ token: 'hv_bad.sig', channel: 'x', artefact: 'x' })).status, 400);
});
