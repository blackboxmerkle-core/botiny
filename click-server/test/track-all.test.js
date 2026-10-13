import test from 'node:test'; import assert from 'node:assert/strict';
import { setup, click, T0, ranked, BROWSER } from './helpers.js';
import { entries } from '../src/ledger.js';
import { generateKeyPair } from '../src/token.js';
import { ClickEngine } from '../src/engine.js';

const issueAll = (engine, o = {}) => engine.issueSet({ set_id: o.set_id ?? 'SA' + Math.random(), request_id: 'RA', bot_wallet: '0xbot', channel: o.channel ?? 'chat',
  ranked: o.r, now: T0, trackAll: true, incentives: o.incentives ?? true });

test('trackAll: every ranked row gets a unique link; curation-dropped rows are zero-incentive tracking-only', async () => {
  const { engine, cfg } = await setup();
  const r = ranked({ clusters: 3, perCluster: 4 }).map((x, i) => ({ ...x, response_rank: i + 1 }));  // C3 drops rows
  const s = await issueAll(engine, { r });
  assert.equal(s.results.length, r.length);
  assert.deepEqual(s.results.map(x => x.rank), r.map(x => x.response_rank));
  assert.equal(new Set(s.results.map(x => x.short_url)).size, r.length);
  assert.equal(new Set(s.results.map(x => x.harvest_token)).size, r.length);
  const tr = s.results.filter(x => x.tracked_only);
  assert.ok(tr.length > 0 && tr.length === r.length - Math.min(cfg.setSize, 3 * cfg.maxSlotsPerCluster));
  for (const x of tr) { assert.equal(x.show_incentive_atomic, 0); assert.equal(x.click_incentive_atomic, 0); assert.equal(x.disclosure, null); }
  assert.equal(s.escrow_atomic, s.results.reduce((a, x) => a + x.show_incentive_atomic + x.click_incentive_atomic, 0));
});
test('trackAll: zero-relevance / no-offer rows still tracked; incentives=false zeroes everything', async () => {
  const { engine } = await setup();
  const r = ranked({ clusters: 5, rel: 0.01 });          // below θ: curation keeps none
  const s = await issueAll(engine, { r });
  assert.equal(s.results.length, 5); assert.ok(s.results.every(x => x.tracked_only));
  const s2 = await issueAll(engine, { r: ranked(), incentives: false });
  assert.equal(s2.incentivised, false); assert.equal(s2.escrow_atomic, 0);
  assert.ok(s2.results.every(x => x.tracked_only && x.show_incentive_atomic === 0 && x.click_incentive_atomic === 0));
});
test('tracking-only click: recorded as tracked, never paid, no ledger, no show unlock, no strike', async () => {
  const { engine, store } = await setup();
  const r = ranked({ clusters: 3, perCluster: 4 }).map((x, i) => ({ ...x, response_rank: i + 1 }));
  const s = await issueAll(engine, { r });
  const t = s.results.find(x => x.tracked_only).harvest_token;
  const c = await click(engine, t);
  assert.equal(c.class, 'tracked'); assert.equal(c.paid, false);
  assert.equal((await entries(store, { bot_wallet: '0xbot' })).length, 0);
  assert.equal((await click(engine, t, { ua: 'curl/8.0' })).class, 'bot');
  await engine.noteBotApiCall('0xbot', { ip: '90.9.9.1', ua: BROWSER.ua, acceptLanguage: 'en-GB' }, T0);
  assert.equal((await click(engine, t, { ip: '90.9.9.2' })).class, 'self'); assert.equal(store.strikes.length, 0);
  // incentivised row in the same set still pays normally
  const paid = s.results.find(x => !x.tracked_only && x.click_incentive_atomic > 0);
  assert.equal((await click(engine, paid.harvest_token)).class, 'paid_candidate');
});
test('resolve: tracking-only rows survive signing-key loss; incentivised ones do not', async () => {
  const { engine, store, cfg } = await setup();
  const s = await issueAll(engine, { r: ranked({ clusters: 3, perCluster: 4 }).map((x, i) => ({ ...x, response_rank: i + 1 })) });
  const kp2 = await generateKeyPair();
  const e2 = new ClickEngine({ store, cfg, signingKey: kp2.privateKey, kid: 'k2', verifyKeys: { k2: kp2.publicKey }, keySecret: 'x', shortBase: 'https://bsrc.test' });
  const tr = s.results.find(x => x.tracked_only), inc = s.results.find(x => !x.tracked_only && x.click_incentive_atomic > 0);
  assert.ok(await e2.resolve(tr.short_url.split('/').pop()));
  assert.equal(await e2.resolve(inc.short_url.split('/').pop()), null);
});
test('zero-amount in-set link with no show gate is tracked (never consumes paid caps); with a chat show gate it still unlocks', async () => {
  const { engine, store } = await setup();
  const s = await issueAll(engine, { r: ranked({ show: 0, click: 0 }) });
  assert.ok(s.results.every(x => !x.tracked_only));
  for (const x of s.results) { const c = await click(engine, x.harvest_token); assert.equal(c.class, 'tracked'); assert.equal(c.paid, false); }
  const r2 = ranked().map((x, i) => i === 0 ? { ...x, show_offer_atomic: 0, click_offer_atomic: 0 } : { ...x, click_offer_atomic: 0 });
  const s2 = await issueAll(engine, { r: r2 });
  const c = await click(engine, s2.results[0].harvest_token);
  assert.equal(c.class, 'paid_candidate');
  assert.ok((await entries(store, { bot_wallet: '0xbot' })).some(e => e.line === 'show' || String(e.entry_id).endsWith(':show')));
});
