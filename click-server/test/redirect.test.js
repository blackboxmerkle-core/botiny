import test from 'node:test'; import assert from 'node:assert/strict';
import { setup, issue } from './helpers.js';
import { makeHandler } from '../src/worker.js';
import { exportPublicJwk } from '../src/token.js';
import { canonicalMessage } from '../src/binding.js';

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
  const res = await h(new Request(`https://bsrc.test/${code}`, { headers: { 'user-agent': 'Mozilla/5.0', 'cf-connecting-ip': '81.2.3.4' } }), { trustCf: true }, ctx);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://p0.example/l0'); assert.match(loc.searchParams.get('bs_click'), /^ck_/);
  assert.equal(res.headers.get('set-cookie'), null); assert.equal(res.headers.get('cache-control'), 'no-store');
  await Promise.all(waits);
  assert.equal(queued.length, 1); assert.equal(queued[0].token, r0.harvest_token); assert.equal(queued[0].ip, '81.2.3.4');
});
test('cf-connecting-ip ignored unless trustCf; falls back to env.clientIp', async () => {
  const { h, queued, set } = await env();
  const code = set.results[0].short_url.split('/').pop();
  await h(new Request(`https://bsrc.test/${code}`, { headers: { 'cf-connecting-ip': '6.6.6.6' } }), { clientIp: '81.2.3.9' }, ctx);
  await Promise.all(waits);
  assert.equal(queued.at(-1).ip, '81.2.3.9');
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
const W = '0x00000000000000000000000000000000000000b0';
// Fake EIP-191 verifier for unit tests (the API uses viem's real verifyMessage).
const fakeSig = (m, a) => 'sig:' + Buffer.from(a.toLowerCase() + m).toString('base64');
const verifyMessage = async ({ address, message, signature }) => signature === fakeSig(message, address);

async function proofEnv(cfgOver = {}) {
  const s = await setup(cfgOver); s.engine.verifyMessage = verifyMessage;
  const h = makeHandler(s.engine, { enqueue: () => {} });
  const set = await issue(s.engine, { now: Date.now(), bot: W });
  return { ...s, h, set };
}
const postProof = async (h, body, { wallet = W, sign = true, ts = Math.floor(Date.now() / 1000), sigOverride } = {}) => {
  const raw = JSON.stringify(body); const headers = { 'content-type': 'application/json', 'x-bot-wallet': wallet };
  if (sign) {
    const msg = await canonicalMessage({ method: 'POST', path: '/v1/proofs', wallet, timestamp: String(ts), body: raw });
    headers['x-bot-signature'] = sigOverride ?? fakeSig(msg, wallet); headers['x-bot-timestamp'] = String(ts);
  }
  return h(new Request('https://bsrc.test/v1/proofs', { method: 'POST', headers, body: raw }), {}, ctx);
};

test('POST /v1/proofs: signed binding to paying wallet, dedupe, channel validation', async () => {
  const { h, set } = await proofEnv(); const t = set.results[0].harvest_token;
  const ok = await postProof(h, { token: t, channel: 'web', artefact: 'https://blog.example/post' });
  assert.equal(ok.status, 201); const j = await ok.json(); assert.match(j.proof_id, /^pf_/); assert.equal(j.binding, 'signature');
  assert.equal((await postProof(h, { token: t, channel: 'web', artefact: 'https://blog.example/2' })).status, 409);
  const other = '0x00000000000000000000000000000000000000c1';
  assert.equal((await postProof(h, { token: t, channel: 'x', artefact: '123' }, { wallet: other })).status, 403);   // validly signed by another wallet
  assert.equal((await postProof(h, { token: t, channel: 'farcaster', artefact: 'x' })).status, 400);
  assert.equal((await postProof(h, { token: 'hv_bad.sig', channel: 'x', artefact: 'x' })).status, 400);
});
test('signed requests: bad signature, stale timestamp, replay, tampered body rejected', async () => {
  const { h, set } = await proofEnv(); const t = set.results[0].harvest_token;
  assert.equal((await postProof(h, { token: t, channel: 'x', artefact: '1' }, { sigOverride: 'sig:nope' })).status, 401);
  assert.equal((await postProof(h, { token: t, channel: 'x', artefact: '1' }, { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  // replay the exact same signed request
  const raw = JSON.stringify({ token: t, channel: 'bot', artefact: 'r' }); const ts = String(Math.floor(Date.now() / 1000));
  const msg = await canonicalMessage({ method: 'POST', path: '/v1/proofs', wallet: W, timestamp: ts, body: raw });
  const mk = (b = raw) => h(new Request('https://bsrc.test/v1/proofs', { method: 'POST', headers: { 'x-bot-wallet': W, 'x-bot-signature': fakeSig(msg, W), 'x-bot-timestamp': ts }, body: b }), {}, ctx);
  assert.equal((await mk()).status, 201);
  assert.equal(((await (await mk()).json()).error), 'replayed_signature');
  // tampered body (signature covers body hash)
  const raw2 = JSON.stringify({ token: t, channel: 'onchain', artefact: 'r' });
  assert.equal((await mk(raw2)).status, 401);
});
test('legacy unsigned header binding: allowed and marked, or refused when disabled', async () => {
  const a = await proofEnv(); const t = a.set.results[0].harvest_token;
  const r = await postProof(a.h, { token: t, channel: 'web', artefact: 'u' }, { sign: false });
  assert.equal(r.status, 201); assert.equal((await r.json()).binding, 'header');
  const b = await proofEnv({ allowUnsignedBotRequests: false });
  const r2 = await postProof(b.h, { token: b.set.results[0].harvest_token, channel: 'web', artefact: 'u' }, { sign: false });
  assert.equal(r2.status, 401); assert.equal((await r2.json()).error, 'signature_required');
  assert.equal((await postProof(b.h, { token: b.set.results[0].harvest_token, channel: 'web', artefact: 'u' }, { wallet: 'bob', sign: false })).status, 401);
});
