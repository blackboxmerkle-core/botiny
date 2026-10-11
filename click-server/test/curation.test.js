import test from 'node:test'; import assert from 'node:assert/strict';
import { buildResultSet } from '../src/curation.js';
import { makeConfig, FEE_PRESETS } from '../src/config.js';
import { ranked } from './helpers.js';
const sum = items => items.reduce((s, i) => s + i.show_atomic + i.click_atomic, 0);

for (const [name, fee] of Object.entries(FEE_PRESETS)) {
  test(`line item cap 0.25f (fee ${name})`, () => {
    const cfg = makeConfig({ feeAtomic: fee });
    const { items } = buildResultSet(ranked({ show: fee * 10, click: fee * 10 }), cfg);
    for (const i of items) { assert.ok(i.show_atomic <= 0.25 * fee); assert.ok(i.click_atomic <= 0.25 * fee); }
  });
  test(`cluster cap 0.5f and 2 slots (fee ${name})`, () => {
    const cfg = makeConfig({ feeAtomic: fee });
    const r = [...ranked({ clusters: 1, perCluster: 6 }), ...ranked({ clusters: 4, rel: 0.8 }).map(x => ({ ...x, cluster_id: 'X' + x.cluster_id }))]
      .map(x => ({ ...x, show_offer_atomic: fee, click_offer_atomic: fee }));
    const { items } = buildResultSet(r, cfg);
    const c0 = items.filter(i => i.cluster_id === 'C0');
    assert.equal(c0.length, 2);
    assert.ok(sum(c0) <= 0.5 * fee, `${sum(c0)}`);
    for (const cl of new Set(items.map(i => i.cluster_id))) assert.ok(sum(items.filter(i => i.cluster_id === cl)) <= 0.5 * fee);
  });
  test(`whole set cap 4f (fee ${name})`, () => {
    const cfg = makeConfig({ feeAtomic: fee, setCapMult: 1 });       // tighten τ so it binds
    const { items } = buildResultSet(ranked({ clusters: 10, show: fee, click: fee }), cfg);
    assert.ok(sum(items) <= 1 * fee);
    const def = buildResultSet(ranked({ clusters: 10, show: fee, click: fee }), makeConfig({ feeAtomic: fee }));
    assert.ok(sum(def.items) <= 4 * fee);
  });
}
test('set size k and relevance floor; too few clusters -> no incentives', () => {
  const cfg = makeConfig();
  assert.equal(buildResultSet(ranked({ clusters: 20 }), cfg).items.length, 10);
  assert.equal(buildResultSet(ranked({ clusters: 5, rel: 0.4 }), cfg).items.length, 0);
  const few = buildResultSet(ranked({ clusters: 2 }), cfg);
  assert.equal(few.incentivised, false); assert.equal(sum(few.items), 0); assert.equal(few.items[0].disclosure, null);
});
test('rank order is relevance-only (incentive does not reorder)', () => {
  const r = ranked({ clusters: 5 }); r[4].show_offer_atomic = 1e9;
  assert.deepEqual(buildResultSet(r, makeConfig()).items.map(i => i.listing_id), r.map(x => x.listing_id));
});
test('thresholds are config, env override works', () => {
  assert.equal(makeConfig({}, { CS_FEE: 'low' }).feeAtomic, 1000);
  assert.equal(makeConfig({}, { CS_CFG_maxPaidClicksPerSet: '3' }).maxPaidClicksPerSet, 3);
  assert.throws(() => makeConfig({ feeAtomic: 0 }));
});
