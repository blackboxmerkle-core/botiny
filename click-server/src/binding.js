// Wallet-bound signed requests (EIP-191 personal_sign) for bot-side calls: proofs, earnings.
// The bot signs a canonical message with the SAME wallet that paid x402 for the result set
// (token.bot_wallet). Signature verification is injected (viem's verifyMessage in the API) so this
// module stays dependency-free and Workers-compatible.
import { sha256Hex } from './b64.js';

export const SIG_HEADERS = { wallet: 'x-bot-wallet', signature: 'x-bot-signature', timestamp: 'x-bot-timestamp' };

export async function canonicalMessage({ method, path, wallet, timestamp, body }) {
  return ['BotSource signed request v1', `method: ${method.toUpperCase()}`, `path: ${path}`,
    `wallet: ${String(wallet).toLowerCase()}`, `timestamp: ${timestamp}`, `body-sha256: ${await sha256Hex(body ?? '')}`].join('\n');
}

/**
 * Returns {ok, wallet, binding:'signature'|'header', error?}.
 * - Signature present: must verify, timestamp within cfg.sigMaxSkewMs, not replayed (store.useSignature).
 * - No signature: allowed only if cfg.allowUnsignedBotRequests (legacy header binding, marked 'header').
 */
export async function verifySignedRequest({ method, path, headers, body, now = Date.now(), cfg, verifyMessage, store }) {
  const h = k => headers[k] ?? headers[k.toLowerCase()] ?? null;
  const wallet = h(SIG_HEADERS.wallet); const signature = h(SIG_HEADERS.signature); const ts = h(SIG_HEADERS.timestamp);
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) return { ok: false, error: 'wallet_required' };
  if (!signature) {
    if (cfg.allowUnsignedBotRequests) return { ok: true, wallet: wallet.toLowerCase(), binding: 'header' };
    return { ok: false, error: 'signature_required' };
  }
  const t = Number(ts);
  if (!Number.isSafeInteger(t) || Math.abs(now - t * 1000) > cfg.sigMaxSkewMs) return { ok: false, error: 'stale_timestamp' };
  if (!verifyMessage) return { ok: false, error: 'no_verifier' };
  const message = await canonicalMessage({ method, path, wallet, timestamp: ts, body });
  let good = false;
  try { good = await verifyMessage({ address: wallet, message, signature }); } catch { good = false; }
  if (!good) return { ok: false, error: 'bad_signature' };
  if (store?.useSignature && !(await store.useSignature(await sha256Hex(signature), now + 2 * cfg.sigMaxSkewMs))) return { ok: false, error: 'replayed_signature' };
  return { ok: true, wallet: wallet.toLowerCase(), binding: 'signature' };
}
