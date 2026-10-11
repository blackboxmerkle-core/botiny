// incentive_ledger: SEPARATE from the API's balance_ledger (which debits providers per impression).
// Append-only. Each line item (token × show|click) is one "entry"; its state is its latest event.
//   accrue_held    -> held until release_after (holdback)
//   review_hold    -> held with no release date (bot above network p95 / CTR anomaly)
//   review_cleared -> back to held, new release_after
//   release        -> vested (payable to the bot wallet)
//   clawback       -> reversed (only before release); escrow goes back to the provider
export const ENTRY_STATES = { accrue_held: 'held', review_hold: 'review', review_cleared: 'held', release: 'vested', clawback: 'clawed_back', payout: 'paid' };

function fold(evs) {
  const by = new Map();
  for (const e of evs) (by.get(e.entry_id) ?? by.set(e.entry_id, []).get(e.entry_id)).push(e);
  return [...by.values()].map(es => {
    const last = es[es.length - 1];
    return { entry_id: es[0].entry_id, state: ENTRY_STATES[last.kind], last, first: es[0],
      release_after: [...es].reverse().find(e => e.release_after != null)?.release_after ?? null };
  });
}
export async function entryState(store, entry_id) { return fold(await store.ledgerEvents({ entry_id }))[0] ?? null; }
export async function entries(store, f = {}) { return fold(await store.ledgerEvents(f)); }

export async function accrue(store, { line, tok, click_id = null, amount, now, review, cfg, reason }) {
  const entry_id = `${tok.token}:${line}`;
  if (await entryState(store, entry_id)) return null;   // one accrual per line item, ever
  if (await store.isRefunded(entry_id)) return null;    // escrow already returned to the provider
  return store.appendLedger({
    entry_id, line, token: tok.token, set_id: tok.set_id, provider_id: tok.provider_id, cluster_id: tok.cluster_id,
    bot_wallet: tok.bot_wallet, click_id, proof_id: null, delta_atomic: amount,
    kind: review ? 'review_hold' : 'accrue_held', release_after: review ? null : now + cfg.holdbackMs, reason: reason ?? null, created_at: now,
  });
}

function follow(store, st, kind, now, extra = {}) {
  const f = st.first;
  return store.appendLedger({ entry_id: f.entry_id, line: f.line, token: f.token, set_id: f.set_id, provider_id: f.provider_id,
    cluster_id: f.cluster_id, bot_wallet: f.bot_wallet, click_id: f.click_id, proof_id: f.proof_id,
    delta_atomic: kind === 'clawback' ? -f.delta_atomic : 0, kind, release_after: null, reason: null, created_at: now, ...extra });
}

/** Vest every held entry whose holdback has elapsed. Idempotent. */
export async function releaseDue(store, now) {
  const out = [];
  for (const st of await entries(store)) if (st.state === 'held' && st.release_after != null && st.release_after <= now) out.push(await follow(store, st, 'release', now));
  return out;
}
export async function clearReview(store, entry_id, now, cfg) {
  const st = await entryState(store, entry_id);
  if (st?.state !== 'review') throw new Error('not in review');
  return follow(store, st, 'review_cleared', now, { release_after: now + cfg.holdbackMs });
}
/** Clawback within holdback only. Returns the row, null if already clawed back; throws if vested. */
export async function clawback(store, entry_id, now, reason) {
  const st = await entryState(store, entry_id);
  if (!st) throw new Error('no such entry');
  if (st.state === 'vested' || st.state === 'paid') throw new Error('already vested; outside holdback');
  if (st.state === 'clawed_back') return null;
  return follow(store, st, 'clawback', now, { reason });
}
export async function balances(store, bot_wallet) {
  const b = { held: 0, review: 0, vested: 0, clawed_back: 0, paid: 0 };
  for (const st of await entries(store, bot_wallet ? { bot_wallet } : {})) b[st.state] += st.first.delta_atomic;
  return b;
}
