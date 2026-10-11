// Signed per-result tokens: 'hv_' + b64url(JSON payload) + '.' + b64url(Ed25519 sig).
// Uses WebCrypto only, so the same code runs in Node 20+ and Cloudflare Workers.
import { b64u, sha256Hex } from './b64.js';

export const TOKEN_VERSION = 1;

export async function generateKeyPair() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
}
export async function exportPublicJwk(publicKey, kid) {
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  return { ...jwk, kid, use: 'sig', alg: 'EdDSA' };
}
export async function importPublicJwk(jwk) {
  return crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: 'Ed25519' }, true, ['verify']);
}

/** fields: {result_id,set_id,request_id,rank,listing_id,provider_id,cluster_id,bot_wallet,dest_url,show_atomic,click_atomic,channel} */
export async function signToken(privateKey, kid, fields, { now = Date.now(), validityMs }) {
  const { dest_url, ...rest } = fields;
  const payload = {
    v: TOKEN_VERSION, kid, ...rest,
    dest_url_hash: await sha256Hex(dest_url),
    iat: now, exp: now + validityMs,
    nonce: b64u.enc(crypto.getRandomValues(new Uint8Array(9))),
  };
  const body = b64u.enc(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(body));
  return { token: `hv_${body}.${b64u.enc(new Uint8Array(sig))}`, payload };
}

/** Returns {ok, payload, expired, reason}. Signature validity and expiry are separate:
 *  an expired-but-valid token still redirects (unpaid). */
export async function verifyToken(keysByKid, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token.startsWith('hv_')) return { ok: false, reason: 'format' };
  const [body, sig, extra] = token.slice(3).split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'format' };
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(b64u.dec(body))); } catch { return { ok: false, reason: 'format' }; }
  if (payload.v !== TOKEN_VERSION) return { ok: false, reason: 'version' };
  const key = keysByKid[payload.kid];
  if (!key) return { ok: false, reason: 'unknown_kid' };
  let good = false;
  try { good = await crypto.subtle.verify({ name: 'Ed25519' }, key, b64u.dec(sig), new TextEncoder().encode(body)); } catch { good = false; }
  if (!good) return { ok: false, reason: 'bad_signature' };
  return { ok: true, payload, expired: now > payload.exp };
}
