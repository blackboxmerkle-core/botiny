import test from 'node:test'; import assert from 'node:assert/strict';
import { setup, issue, click, T0, BROWSER, freshIp, ranked } from './helpers.js';
import { entries } from '../src/ledger.js';

test('first valid click is paid; same token again is unpaid duplicate', async () => {
  const { engine } = await setup(); const s = await issue(engine);
  const t = s.results[0].harvest_token;
  assert.equal((await click(engine, t)).class, 'paid_candidate');
  const again = await click(engine, t, { ts: T0 + 120_000 });
  assert.deepEqual([again.class, again.reasons], ['unpaid_duplicate', ['token_already_paid']]);
});
test('preview fetchers, HEAD, range, crawlers, headless, datacentre, missing headers', async () => {
  const { engine } = await setup({ datacenterCidrs: ['34.0.0.0/8'] });
  const s = await issue(engine); const t = s.results[0].harvest_token;
  for (const ua of ['Slackbot-LinkExpanding 1.0', 'WhatsApp/2.23', 'facebookexternalhit/1.1', 'Twitterbot/1.0', 'TelegramBot', 'Discordbot/2.0', 'LinkedInBot/1.0'])
    assert.equal((await click(engine, t, { ua })).class, 'preview', ua);
  assert.equal((await click(engine, t, { method: 'HEAD' })).class, 'preview');
  assert.equal((await click(engine, t, { headers: { ...BROWSER.headers, range: 'bytes=0-1' } })).class, 'preview');
  for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'Mozilla/5.0 ChatGPT-User/1.0', 'PerplexityBot', 'ClaudeBot/1.0', 'curl/8.0'])
    assert.equal((await click(engine, t, { ua })).class, 'bot', ua);
  assert.deepEqual((await click(engine, t, { ua: 'Mozilla/5.0 HeadlessChrome/120' })).class, 'bot');
  assert.ok((await click(engine, t, { ip: '34.1.2.3' })).reasons.includes('datacenter_ip'));
  assert.ok((await click(engine, t, { headers: { accept: '*/*' } })).reasons.includes('odd_accept'));
  assert.ok((await click(engine, t, { headers: { accept: 'text/html' } })).reasons.includes('missing_sec_fetch'));
  assert.equal((await click(engine, t)).class, 'paid_candidate');    // a real click still pays afterwards
});
test('timing: <2s after issue and after expiry are unpaid', async () => {
  const { engine } = await setup(); const s = await issue(engine);
  assert.deepEqual((await click(engine, s.results[0].harvest_token, { ts: T0 + 1000 })).reasons, ['too_fast_after_issue']);
  assert.equal((await click(engine, s.results[1].harvest_token, { ts: T0 + 8 * 86_400_000 })).class, 'unpaid_expired');
});
test('self-click: key seen on bot API calls or provider cluster', async () => {
  const { engine, store } = await setup(); const s = await issue(engine);
  await engine.noteBotApiCall('0xbot', { ip: '90.1.1.1', ua: BROWSER.ua, acceptLanguage: 'en-GB' }, T0);
  const c = await click(engine, s.results[0].harvest_token, { ip: '90.1.1.200' });  // same /24
  assert.equal(c.class, 'self'); assert.equal(store.strikes.length, 1);
  await store.linkClusterWallet('C1', '0xprov'); await engine.noteBotApiCall('0xprov', { ip: '91.1.1.1', ua: BROWSER.ua, acceptLanguage: 'en-GB' }, T0);
  assert.equal((await click(engine, s.results[1].harvest_token, { ip: '91.1.1.9' })).class, 'self');
});
test('dedupe: 1 per (user, listing) per 24h across tokens', async () => {
  const { engine } = await setup(); const a = await issue(engine); const b = await issue(engine);
  const ip = freshIp();
  assert.equal((await click(engine, a.results[0].harvest_token, { ip })).paid, true);
  assert.deepEqual((await click(engine, b.results[0].harvest_token, { ip, ts: T0 + 3_600_000 })).reasons, ['user_listing_24h']);
  assert.equal((await click(engine, b.results[0].harvest_token, { ip, ts: T0 + 86_400_000 + 120_000 })).class, 'paid_candidate');
});
test('dedupe: max 5 paid per user per day network-wide', async () => {
  const { engine } = await setup(); const ip = freshIp(); let paid = 0, last;
  for (let i = 0; i < 7; i++) { const s = await issue(engine, { r: ranked({ clusters: 10 }) }); last = await click(engine, s.results[i].harvest_token, { ip, ts: T0 + 60_000 + i * 60_000 }); paid += last.paid; }
  assert.equal(paid, 5); assert.deepEqual(last.reasons, ['user_daily_cap']);
});
test('burst from one key is discarded', async () => {
  const { engine } = await setup({ maxPaidClicksPerUserPerDay: 100 }); const ip = freshIp(); const out = [];
  for (let i = 0; i < 5; i++) { const s = await issue(engine); out.push(await click(engine, s.results[i].harvest_token, { ip, ts: T0 + 60_000 + i * 500 })); }
  assert.deepEqual(out.map(c => c.class), ['paid_candidate', 'paid_candidate', 'paid_candidate', 'bot', 'bot']);
});
test('max 2 paid clicks per set', async () => {
  const { engine } = await setup(); const s = await issue(engine);
  const r = []; for (const x of s.results.slice(0, 4)) r.push(await click(engine, x.harvest_token));
  assert.deepEqual(r.map(c => c.paid), [true, true, false, false]); assert.deepEqual(r[2].reasons, ['set_click_cap']);
});
test('raw IP purged after retention', async () => {
  const { engine, store } = await setup(); const s = await issue(engine);
  await click(engine, s.results[0].harvest_token);
  await engine.purgeRawIps(T0 + 2 * 86_400_000); assert.equal(store.clicks[0].raw_ip, null); assert.ok(store.clicks[0].ip_trunc.endsWith('/24'));
});
test('cookie-free key: no device storage, daily-rotated salted hash', async () => {
  const { engine, store } = await setup(); const s = await issue(engine); const ip = freshIp();
  await click(engine, s.results[0].harvest_token, { ip });
  await click(engine, s.results[1].harvest_token, { ip, ts: T0 + 86_400_000 + 1 });
  assert.notEqual(store.clicks[0].end_user_key, store.clicks[1].end_user_key);
  assert.ok(!store.clicks[0].end_user_key.includes(ip));
});
