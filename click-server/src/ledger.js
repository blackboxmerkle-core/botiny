// incentive_ledger: SEPARATE from the API's balance_ledger (which debits providers per impression).
// Append-only. Each line item (token × show|click) is one "entry"; its state is its latest event.
//   accrue_held    -> held until release_after (holdback)
//   review_hold    -> held with no release date (bot above network p95 / CTR anomaly)
//   review_cleared -> back to held, new release_after
//   release        -> vested (payable)
//   clawback       -> reversed (only allowed before release)
export const ENTRY_STATES = { accrue_held: 'held', review_hold: 'review', review_cleared: 'held', release: 'vested', clawback: 'clawed_back' };

export function entryState(store, entry_id) {
  const evs = store.ledger().filter(r => r.entry_id === entry_id);
  if (!evs.length) return null;
  const last = evs[evs.length - 1];
  return { entry_id, state: ENTRY_STATES[last.kind], last, first: evs[0], release_after: [...evs].reverse().find(e => e.release_after != null)?.release_after ?? null };
}
export function entries(store) {
  const ids = [...new Set(store.ledger().map(r => r.entry_id))];
  return ids.map(id => entryState(store, id));
}

export function accrue(store, { line, tok, click_id = null, amount, now, review, cfg, reason }) {
  const entry_id = `${tok.token}:${line}`;
  if (entryState(store, entry_id)) return null;   // one accrual per line item, ever
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
    delta_atomic: kind === 'clawback' ? -f.delta_atomic : 0, kind, release_after: null, created_at: now, ...extra });
}

/** Vest every held entry whose holdback has elapsed. */
export function releaseDue(store, now) {
  const out = [];
  for (const st of entries(store)) if (st.state === 'held' && st.release_after != null && st.release_after <= now) out.push(follow(store, st, 'release', now));
  return out;
}
export function clearReview(store, entry_id, now, cfg) {
  const st = entryState(store, entry_id);
  if (st?.state !== 'review') throw new Error('not in review');
  return follow(store, st, 'review_cleared', now, { release_after: now + cfg.holdbackMs });
}
/** Clawback within holdback only. Returns the row, or throws if already vested. */
export function clawback(store, entry_id, now, reason) {
  const st = entryState(store, entry_id);
  if (!st) throw new Error('no such entry');
  if (st.state === 'vested') throw new Error('already vested; outside holdback');
  if (st.state === 'clawed_back') return null;
  return follow(store, st, 'clawback', now, { reason });
}
export function balances(store, bot_wallet) {
  const b = { held: 0, review: 0, vested: 0, clawed_back: 0 };
  for (const st of entries(store)) if (!bot_wallet || st.first.bot_wallet === bot_wallet) b[st.state] += st.first.delta_atomic;
  return b;
}
