export const b64u = {
  enc(bytes) { return Buffer.from(bytes).toString('base64url'); },
  dec(s) { return new Uint8Array(Buffer.from(s, 'base64url')); },
};
const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function base62Code(len) {
  const out = []; const buf = new Uint8Array(len * 2);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) { if (b < 248 && out.length < len) out.push(B62[b % 62]); }
  }
  return out.join('');
}
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('hex');
}
