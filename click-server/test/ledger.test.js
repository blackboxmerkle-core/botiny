import test from 'node:test'; import assert from 'node:assert/strict';
import { setup, issue, click, T0, ranked } from './helpers.js';
import { entries, releaseDue, balances, clearReview, clawback } from '../src/ledger.js';
const DAY = 86_400_000;

test('chat: shows pay only once set has a verified click; show+click stack', async () => {
  const { engine, store } = await setup(); const s = await issue(engine);
  await click(engine, s.results[0].harvest_token, { ua: 'WhatsApp/2.23' });         // preview only
  assert.equal(store.ledger().length, 0);
  await click(engine, s.results[0].harvest_token);
  const es = entries(store);
  assert.equal(es.filter(e => e.first.line === 'show').length, 5);
  assert.equal(es.filter(e => e.first.line === 'click').length, 1);
  const t0 = s.results[0].harvest_token;
  assert.ok(es.some(e => e.entry_id === `${t0}:show`) && es.some(e => e.entry_id === `${t0}:click`));
  assert.ok(es.every(e => e.state === 'held'));
});
test('chat: click after 24h window does not unlock shows; non-chat never unlocks shows by click', async () => {
  const { engine, store } = await setup(); const s = await issue(engine);
  await click(engine, s.results[0].harvest_token, { ts: T0 + 25 * 3_600_000 });
  assert.deepEqual(entries(store).map(e => e.first.line), ['click']);
  const w = await issue(engine, { channel: 'web' }); await click(engine, w.results[0].harvest_token);
  assert.equal(entries(store).filter(e => e.first.set_id === w.set_id && e.first.line === 'show').length, 0);
});
test('ledger amounts respect caps; ledger separate from impressions', async () => {
  const { engine, store, cfg } = await setup(); const s = await issue(engine, { r: ranked({ clusters: 10, show: 1e6, click: 1e6 }) });
  for (const r of s.results) { assert.ok(r.show_incentive_atomic <= 0.25 * cfg.feeAtomic); }
  await click(engine, s.results[0].harvest_token); await click(engine, s.results[1].harvest_token);
  const total = store.ledger().reduce((a, r) => a + r.delta_atomic, 0);
  assert.ok(total <= cfg.setCapMult * cfg.feeAtomic); assert.ok(total <= s.escrow_atomic);
});
test('14-day holdback then vest; clawback only within holdback', async () => {
  const { engine, store } = await setup(); const s = await issue(engine);
  const c = await click(engine, s.results[0].harvest_token);
  assert.equal(releaseDue(store, T0 + 13 * DAY).length, 0);
  assert.equal(balances(store, '0xbot').vested, 0);
  const rel = releaseDue(store, T0 + 14 * DAY + 60_000);
  assert.equal(rel.length, 6); assert.equal(balances(store, '0xbot').held, 0);
  assert.throws(() => engine.clawbackClick(c.click_id, T0 + 15 * DAY, 'late'), /already vested/);
});
test('clawback of gating click reverses its click + the chat shows it unlocked', async () => {
  const { engine, store } = await setup(); const s = await issue(engine);
  const c = await click(engine, s.results[0].harvest_token);
  const out = engine.clawbackClick(c.click_id, T0 + 3 * DAY, 'provider_report');
  assert.equal(out.length, 6);
  const b = balances(store, '0xbot'); assert.equal(b.held, 0); assert.ok(b.clawed_back > 0);
  assert.equal(releaseDue(store, T0 + 30 * DAY).length, 0);
  assert.ok(store.ledger().filter(r => r.kind === 'clawback').every(r => r.delta_atomic < 0));
});
test('clawback keeps shows when another verified click in the set survives', async () => {
  const { engine, store } = await setup(); const s = await issue(engine);
  const a = await click(engine, s.results[0].harvest_token); await click(engine, s.results[1].harvest_token);
  assert.equal(engine.clawbackClick(a.click_id, T0 + DAY, 'fraud').length, 1);
  assert.equal(entries(store).filter(e => e.first.line === 'show' && e.state === 'held').length, 5);
});
test('clawbackBot claws every unvested line', async () => {
  const { engine, store } = await setup(); const s = await issue(engine); await click(engine, s.results[0].harvest_token);
  assert.equal(engine.clawbackBot('0xbot', T0 + DAY, 'farm').length, 6);
  assert.throws(() => clawback(store, 'nope', T0, 'x'));
});
test('bot above network p95 set-click rate is held for review, not vested', async () => {
  const { engine, store, cfg } = await setup({ botRateMinSets: 4, botRateMinBots: 5, maxPaidClicksPerUserPerDay: 1000, burstMaxClicks: 1000 });
  // 6 normal bots: 4 sets each, 1 clicked (25%)
  for (let b = 0; b < 6; b++) for (let i = 0; i < 4; i++) {
    const s = await issue(engine, { bot: `0xn${b}` }); if (i === 0) await click(engine, s.results[0].harvest_token);
  }
  // farmer: 4 sets, clicks every one
  const sets = []; for (let i = 0; i < 4; i++) sets.push(await issue(engine, { bot: '0xfarm' }));
  for (const s of sets) await click(engine, s.results[0].harvest_token);
  const st = engine.botRateStatus('0xfarm', T0 + 60_000); assert.equal(st.above, true); assert.equal(st.cap, 0.25);
  const farm = entries(store).filter(e => e.first.bot_wallet === '0xfarm');
  assert.ok(farm.some(e => e.state === 'review'));
  releaseDue(store, T0 + 30 * DAY);
  const review = farm.filter(e => e.state === 'review');
  assert.ok(entries(store).filter(e => e.first.bot_wallet === '0xfarm' && e.state === 'review').length === review.length);
  clearReview(store, review[0].entry_id, T0 + 30 * DAY, cfg);
  assert.equal(releaseDue(store, T0 + 30 * DAY + cfg.holdbackMs).length, 1);
});
test('fallback π_cap used when too few bots for a percentile', async () => {
  const { engine } = await setup({ botRateMinSets: 2 });
  for (let i = 0; i < 2; i++) { const s = await issue(engine, { bot: '0xsolo' }); await click(engine, s.results[0].harvest_token); }
  const st = engine.botRateStatus('0xsolo', T0 + 60_000); assert.equal(st.cap, 0.8); assert.equal(st.above, true);
});
