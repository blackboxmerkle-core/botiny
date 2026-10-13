import { signToken, verifyToken } from './token.js';
import { b64u, base62Code, sha256Hex } from './b64.js';
import { buildResultSet } from './curation.js';
import { classifyRequest, endUserKey, truncateIp, saltPeriod } from './classify.js';
import { accrue, clawback, entryState, entries } from './ledger.js';
import { verifySignedRequest } from './binding.js';

/**
 * ClickEngine wires tokens, curation, scoring and the incentive ledger together. Store-agnostic
 * (MemoryStore or PgStore; all store calls are awaited).
 * deps: {store, cfg, signingKey, kid, verifyKeys: {kid: CryptoKey}, keySecret, shortBase, verifyMessage?}
 */
export class ClickEngine {
  constructor(deps) { Object.assign(this, deps); }

  /** Called by the API after ranking (POST /v1/recommend). ranked items may carry response_rank. */
  /** trackAll: also issue zero-incentive, tracking-only links for ranked rows curation dropped (every result gets a link).
   *  incentives=false: all amounts 0 (incentives disabled / no stable signing key / payer not a wallet). */
  async issueSet({ set_id, request_id, bot_wallet, channel = 'chat', ranked, now = Date.now(), trackAll = false, incentives = true }) {
    const { cfg, store } = this;
    const built = buildResultSet(ranked, cfg);
    const incentivised = incentives && built.incentivised;
    let items = built.items.map(it => incentives ? { ...it, tracked_only: false } : { ...it, show_atomic: 0, click_atomic: 0, disclosure: null, tracked_only: true });
    if (trackAll) {
      const key = r => `${r.listing_id}#${r.response_rank ?? r.rank}`;
      const inSet = new Map(items.map(it => [key(it), it]));
      items = ranked.map((r, i) => inSet.get(key({ ...r, rank: r.response_rank ?? i + 1 }))
        ?? { ...r, rank: i + 1, show_atomic: 0, click_atomic: 0, disclosure: null, tracked_only: true });
    }
    const results = []; let escrow = 0;
    for (const it of items) {
      const rank = it.response_rank ?? it.rank;   // caller's rank if supplied (curation may drop rows)
      const result_id = `${set_id}:${rank}`;
      const { token, payload } = await signToken(this.signingKey, this.kid, {
        result_id, set_id, request_id, rank, listing_id: it.listing_id, provider_id: it.provider_id ?? it.cluster_id,
        cluster_id: it.cluster_id, bot_wallet, dest_url: it.dest_url, show_atomic: it.show_atomic, click_atomic: it.click_atomic, channel,
        ...(it.tracked_only ? { tracked_only: true } : {}),
      }, { now, validityMs: cfg.tokenPayValidityMs });
      await store.putToken({ token, ...payload, tracked_only: !!it.tracked_only, dest_url: it.dest_url, issued_at: now, expires_at: payload.exp });
      let code = null;
      for (let i = 0; i < 5 && !code; i++) { const c = base62Code(cfg.shortCodeLength); try { await store.putShortLink({ code: c, token, dest_url: it.dest_url, exp: payload.exp }); code = c; } catch { /* collision, retry */ } }
      escrow += it.show_atomic + it.click_atomic;
      results.push({ listing_id: it.listing_id, rank, harvest_token: token, short_url: `${this.shortBase}/${code}`,
        track_url: `${this.shortBase}/r/${token}`, show_incentive_atomic: it.show_atomic, click_incentive_atomic: it.click_atomic, disclosure: it.disclosure, tracked_only: !!it.tracked_only });
    }
    return { set_id, incentivised, escrow_atomic: escrow, results };
  }

  /** Record that a bot's API call came from this client (for self-click detection). */
  async noteBotApiCall(bot_wallet, req, now = Date.now()) {
    await this.store.noteBotApiKey(bot_wallet, await endUserKey(req, this.keySecret, now, this.cfg), now);
  }

  async resolve(codeOrToken) {
    let token = codeOrToken;
    if (!codeOrToken.startsWith('hv_')) { const link = await this.store.getShortLink(codeOrToken); if (!link) return null; token = link.token; }
    let v = await verifyToken(this.verifyKeys, token);
    const row = await this.store.getToken(token);
    if (!row) return null;                                   // only redirect to targets we stored at issue
    // Tracking-only links (zero incentive, never paid) signed by a key that is no longer loaded (e.g. ephemeral
    // key from a previous process): the stored row is the authority for the redirect; nothing is payable.
    if (!v.ok && v.reason === 'unknown_kid' && row.tracked_only && row.show_atomic === 0 && row.click_atomic === 0) {
      const [body] = token.slice(3).split('.');
      try { v = { ok: true, payload: JSON.parse(new TextDecoder().decode(b64u.dec(body))) }; } catch { return null; }
    }
    if (!v.ok) return null;                                   // only redirect to targets we stored at issue
    if (await sha256Hex(row.dest_url) !== v.payload.dest_url_hash) return null;
    return { token, row, payload: v.payload };
  }

  /** Bot set-click rate vs the p95 of the REST of the network over the window. */
  async botRateStatus(bot_wallet, now) {
    const { cfg } = this;
    const rows = (await this.store.botRateRows(now - cfg.botRateWindowMs)).filter(r => r.sets >= cfg.botRateMinSets);
    const rate = r => r.clicked / r.sets;
    const others = rows.filter(r => r.bot_wallet !== bot_wallet);
    let cap = cfg.botRateFallbackCap;
    if (others.length >= cfg.botRateMinBots) {
      const sorted = others.map(rate).sort((a, b) => a - b);
      cap = sorted[Math.min(sorted.length - 1, Math.ceil(cfg.botRatePercentile * sorted.length) - 1)];
    }
    const mine = rows.find(r => r.bot_wallet === bot_wallet);
    return { cap, rate: mine ? rate(mine) : null, above: mine ? rate(mine) > cap : false };
  }

  /** Queue consumer: classify + dedupe + ledger. ev = {click_id, token, ts, method, ip, ua, headers, cfBotScore} */
  async scoreClick(ev) {
    const { cfg, store } = this; const now = ev.ts;
    const tok = await store.getToken(ev.token);
    if (!tok) throw new Error('unknown token');
    const key = await endUserKey({ ip: ev.ip, ua: ev.ua, acceptLanguage: ev.headers?.['accept-language'] }, this.keySecret, now, cfg);
    const base = { click_id: ev.click_id, token: ev.token, set_id: tok.set_id, listing_id: tok.listing_id, bot_wallet: tok.bot_wallet,
      ts: now, end_user_key: key, ip_trunc: truncateIp(ev.ip), ua: ev.ua ?? '', raw_ip: ev.ip ?? null, paid: false, clawed_back: false };
    const done = (cls, reasons) => store.insertClick({ ...base, class: cls, reasons });

    const c = classifyRequest({ method: ev.method, ip: ev.ip, ua: ev.ua, headers: ev.headers ?? {}, cfBotScore: ev.cfBotScore }, cfg);
    if (c.cls === 'preview') return done('preview', c.reasons);
    if (c.cls === 'bot') return done('bot', c.reasons);
    if (now > tok.expires_at) return done('unpaid_expired', ['expired']);
    if (now - tok.issued_at < cfg.minClickDelayMs) return done('bot', ['too_fast_after_issue']);
    // Tracking-only link (no offer, outside the incentive set): usage analytics only. Never paid, never unlocks shows,
    // no fraud strikes (nothing to gain), but still classified so analytics can exclude bots / self / bursts.
    // A zero-amount link inside the set is treated the same unless it can gate chat show incentives of its set.
    const gatesShows = tok.channel === 'chat' && (await store.tokensForSet(tok.set_id)).some(t => t.show_atomic > 0);
    if (tok.tracked_only || (tok.show_atomic + tok.click_atomic === 0 && !gatesShows)) {
      if (await store.isSelf(tok.bot_wallet, tok.cluster_id, key)) return done('self', ['self_click', 'no_incentive']);
      if ((await store.countClicksByKeySince(key, now - cfg.burstWindowMs)) >= cfg.burstMaxClicks) return done('bot', ['burst']);
      return done('tracked', []);
    }
    if (await store.isSelf(tok.bot_wallet, tok.cluster_id, key)) {
      await store.addStrike({ bot_wallet: tok.bot_wallet, reason: 'self_click', ts: now, click_id: ev.click_id });
      return done('self', ['self_click']);
    }
    if ((await store.countClicksByKeySince(key, now - cfg.burstWindowMs)) >= cfg.burstMaxClicks) return done('bot', ['burst']);

    const dayStart = saltPeriod(now, cfg) * cfg.saltRotationMs;
    if ((await store.countPaidToken(ev.token)) >= cfg.maxPaidClicksPerToken) return done('unpaid_duplicate', ['token_already_paid']);
    if ((await store.countPaidUserListing(key, tok.listing_id, now - cfg.userListingWindowMs)) >= cfg.maxPaidClicksPerUserPerListingWindow)
      return done('unpaid_duplicate', ['user_listing_24h']);
    if ((await store.countPaidUser(key, dayStart)) >= cfg.maxPaidClicksPerUserPerDay) return done('unpaid_duplicate', ['user_daily_cap']);
    if ((await store.countPaidSet(tok.set_id)) >= cfg.maxPaidClicksPerSet) return done('unpaid_duplicate', ['set_click_cap']);

    const row = await store.insertClick({ ...base, class: 'paid_candidate', reasons: [], paid: true });
    const rs = await this.botRateStatus(tok.bot_wallet, now);
    const review = rs.above; const reason = review ? `bot_rate ${rs.rate.toFixed(3)} > p${cfg.botRatePercentile * 100} ${rs.cap.toFixed(3)}` : null;
    if (tok.click_atomic > 0) await accrue(store, { line: 'click', tok, click_id: ev.click_id, amount: tok.click_atomic, now, review, cfg, reason });
    // Chat: show incentives of the whole set unlock on the first verified click within the window.
    if (tok.channel === 'chat') {
      for (const t of await store.tokensForSet(tok.set_id)) {
        if (t.show_atomic > 0 && now - t.issued_at <= cfg.chatShowClickWindowMs)
          await accrue(store, { line: 'show', tok: t, click_id: ev.click_id, amount: t.show_atomic, now, review, cfg, reason });
      }
    }
    return row;
  }

  /** Clawback a fraudulent click during holdback; also chat shows it unlocked unless another surviving paid click qualifies. */
  async clawbackClick(click_id, now, reason) {
    const { store, cfg } = this;
    const click = await store.getClick(click_id);
    if (!click?.paid) throw new Error('not a paid click');
    const out = [];
    const st = await entryState(store, `${click.token}:click`);
    if (st) { const r = await clawback(store, st.entry_id, now, reason); if (r) out.push(r); }
    await store.markClickClawed(click_id);
    const setTokens = await store.tokensForSet(click.set_id);
    const survivor = (await store.paidClicksInSet(click.set_id)).find(p => setTokens.some(t => p.ts - t.issued_at <= cfg.chatShowClickWindowMs));
    if (!survivor) for (const t of setTokens) {
      const s = await entryState(store, `${t.token}:show`);
      if (s && (s.state === 'held' || s.state === 'review')) out.push(await clawback(store, s.entry_id, now, `gate_click_clawed:${reason}`));
    }
    return out;
  }

  /** Clawback every unvested line of a bot (e.g. click-farm finding). */
  async clawbackBot(bot_wallet, now, reason) {
    const out = [];
    for (const s of await entries(store_(this), { bot_wallet })) if (s.state === 'held' || s.state === 'review') out.push(await clawback(this.store, s.entry_id, now, reason));
    return out;
  }

  /** Data minimisation: drop raw IPs older than retention. */
  async purgeRawIps(now) { await this.store.purgeRawIps(now - this.cfg.rawIpRetentionMs); }

  /**
   * POST /v1/proofs. Binding: the request must come from token.bot_wallet (the x402 payer). With a valid
   * EIP-191 signed request it is bound 'signature'; legacy header-only requests are bound 'header'
   * (only if cfg.allowUnsignedBotRequests) and are never sufficient for payout.
   */
  async submitProof({ body, rawBody, headers = {}, method = 'POST', path = '/v1/proofs', now = Date.now() }) {
    const auth = await verifySignedRequest({ method, path, headers, body: rawBody ?? JSON.stringify(body ?? {}), now, cfg: this.cfg, verifyMessage: this.verifyMessage, store: this.store });
    if (!auth.ok) return { status: 401, error: auth.error };
    const { token, channel, artefact, publisher_id = null } = body ?? {};
    const allowed = ['web', 'x', 'onchain', 'bot', 'chat'];
    if (!allowed.includes(channel)) return { status: 400, error: 'unsupported_channel' };
    if (typeof artefact !== 'string' || !artefact || artefact.length > 2048) return { status: 400, error: 'bad_artefact' };
    const v = await verifyToken(this.verifyKeys, token, { now });
    if (!v.ok) return { status: 400, error: `token_${v.reason}` };
    if (v.expired) return { status: 410, error: 'token_expired' };
    if (auth.wallet !== String(v.payload.bot_wallet).toLowerCase()) return { status: 403, error: 'wallet_mismatch' };
    const proof = { proof_id: `pf_${base62Code(16)}`, token, channel, artefact, publisher_id, binding: auth.binding, bot_wallet: auth.wallet,
      tier: channel === 'chat' ? 2 : 1, status: 'pending', checks: [], created_at: now };
    if (!(await this.store.insertProof(proof))) return { status: 409, error: 'duplicate_proof' };
    return { status: 201, body: { proof_id: proof.proof_id, status: 'pending', binding: auth.binding } };
  }
}
const store_ = e => e.store;
