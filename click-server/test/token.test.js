import test from 'node:test'; import assert from 'node:assert/strict';
import { generateKeyPair, signToken, verifyToken, exportPublicJwk, importPublicJwk } from '../src/token.js';
const F = { result_id: 's:1', set_id: 's', listing_id: 'L', cluster_id: 'C', bot_wallet: '0xb', dest_url: 'https://x.example/', show_atomic: 1, click_atomic: 2 };

test('sign + verify roundtrip, payload bound, dest hashed', async () => {
  const kp = await generateKeyPair();
  const { token, payload } = await signToken(kp.privateKey, 'k', F, { now: 1000, validityMs: 5000 });
  assert.match(token, /^hv_[\w-]+\.[\w-]+$/);
  const v = await verifyToken({ k: kp.publicKey }, token, { now: 2000 });
  assert.equal(v.ok, true); assert.equal(v.expired, false);
  assert.equal(v.payload.listing_id, 'L'); assert.equal(v.payload.exp, 6000); assert.equal(payload.dest_url, undefined);
  assert.equal(v.payload.dest_url_hash.length, 64);
});
test('expired token still verifies but flagged expired', async () => {
  const kp = await generateKeyPair();
  const { token } = await signToken(kp.privateKey, 'k', F, { now: 0, validityMs: 10 });
  const v = await verifyToken({ k: kp.publicKey }, token, { now: 11 });
  assert.equal(v.ok, true); assert.equal(v.expired, true);
});
test('tampered payload, wrong key, unknown kid, garbage rejected', async () => {
  const kp = await generateKeyPair(); const other = await generateKeyPair();
  const { token } = await signToken(kp.privateKey, 'k', F, { now: 0, validityMs: 10 });
  const [body, sig] = token.slice(3).split('.');
  const p = JSON.parse(Buffer.from(body, 'base64url')); p.click_atomic = 999999;
  const forged = 'hv_' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.' + sig;
  assert.equal((await verifyToken({ k: kp.publicKey }, forged)).reason, 'bad_signature');
  assert.equal((await verifyToken({ k: other.publicKey }, token)).reason, 'bad_signature');
  assert.equal((await verifyToken({ z: kp.publicKey }, token)).reason, 'unknown_kid');
  assert.equal((await verifyToken({ k: kp.publicKey }, 'hv_abc')).reason, 'format');
  assert.equal((await verifyToken({ k: kp.publicKey }, token + '.x')).reason, 'format');
});
test('JWKS export/import verifies', async () => {
  const kp = await generateKeyPair();
  const jwk = await exportPublicJwk(kp.publicKey, 'k'); assert.equal(jwk.d, undefined);
  const { token } = await signToken(kp.privateKey, 'k', F, { now: 0, validityMs: 10 });
  assert.equal((await verifyToken({ k: await importPublicJwk(jwk) }, token, { now: 1 })).ok, true);
});
