import { signToken, verifyToken } from './token.js';
import { base62Code, sha256Hex } from './b64.js';
import { buildResultSet } from './curation.js';
import { classifyRequest, endUserKey, truncateIp, saltPeriod } from './classify.js';
import { accrue, clawback, entryState } from './ledger.js';

/**
 * ClickEngine wires tokens, curation, scoring and the incentive ledger together.
 * deps: {store, cfg, signingKey, kid, verifyKeys: {kid: CryptoKey}, keySecret, shortBase}
 */
export class ClickEngine {
  constructor(deps) { Object.assign(this, deps); }

  /** Called by the API after ranking (POST /v1/search|/v1/recommend). */
  async issueSet({ set_id, request_id, bot_wallet, channel = 'chat', ranked, now = Date.now() }) {
    const { cfg, store } = this;
    const { incentivised, items } = buildResultSet(ranked, cfg);
    const results = []; let escrow = 0;
    for (const it of items) {
      const result_id = `${set_id}:${it.rank}`;
      const { token, payload } = await signToken(this.signingKey, this.kid, {
        result_id, set_id, request_id, rank: it.rank, listing_id: it.listing_id, provider_id: it.provider_id ?? it.cluster_id,
        cluster_id: it.cluster_id, bot_wallet, dest_url: it.dest_url, show_atomic: it.show_atomic, click_atomic: it.click_atomic, channel,
      }, { now, validityMs: cfg.tokenPayValidityMs });
      store.putToken({ token, ...payload, dest_url: it.dest_url, issued_at: now, expires_at: payload.exp });
      let code;
      for (let i = 0; i < 5; i++) { code = base62Code(cfg.shortCodeLength); try { store.putShortLink({ code, token, dest_url: it.dest_url, exp: payload.exp }); break; } catch { code = null; } }
      escrow += it.show_atomic + it.click_atomic;
      results.push({ listing_id: it.listing_id, rank: it.rank, harvest_token: token, short_url: `${this.shortBase}/${code}`,
        track_url: `${this.shortBase}/r/${token}`, show_incentive_atomic: it.show_atomic, click_incentive_atomic: it.click_atomic, disclosure: it.disclosure });
    }
    return { set_id, incentivised, escrow_atomic: escrow, results };
  }

  /** Record that a bot's API call came from this client (for self-click detection). */
  async noteBotApiCall(bot_wallet, req, now = Date.now()) {
    this.store.noteBotApiKey(bot_wallet, await endUserKey(req, this.keySecret, now, this.cfg));
  }

  async resolve(codeOrToken) {
    let token = codeOrToken, link = null;
    if (!codeOrToken.startsWith('hv_')) { link = this.store.getShortLink(codeOrToken); if (!link) return null; token = link.token; }
    const v = await verifyToken(this.verifyKeys, token);
    if (!v.ok) return null;
    const row = this.store.getToken(token);
    if (!row) return null;                                   // only redirect to targets we stored at issue
    if (await sha256Hex(row.dest_url) !== v.payload.dest_url_hash) return null;
    return { token, row, payload: v.payload };
  }

  /** Bot set-click rate for one bot vs network p95 cap over the window. */
  botRateStatus(bot_wallet, now) {
    const { cfg, store } = this; const since = now - cfg.botRateWindowMs;
    const rates = new Map();
    for (const t of store.allTokensSince(since)) {
      const r = rates.get(t.bot_wallet) ?? rates.set(t.bot_wallet, { sets: new Set(), clicked: new Set() }).get(t.bot_wallet);
      r.sets.add(t.set_id);
    }
    for (const c of store.paidClicks(c => c.ts >= since)) rates.get(c.bot_wallet)?.clicked.add(c.set_id);
    const eligible = [...rates.entries()].filter(([, r]) => r.sets.size >= cfg.botRateMinSets).map(([w, r]) => [w, r.clicked.size / r.sets.size]);
    let cap = cfg.botRateFallbackCap;
    const others = eligible.filter(e => e[0] !== bot_wallet);   // percentile of the rest of the network
    if (others.length >= cfg.botRateMinBots) {
      const sorted = others.map(e => e[1]).sort((a, b) => a - b);
      cap = sorted[Math.min(sorted.length - 1, Math.ceil(cfg.botRatePercentile * sorted.length) - 1)];
    }
    const mine = eligible.find(e => e[0] === bot_wallet);
    return { cap, rate: mine?.[1] ?? null, above: mine ? mine[1] > cap : false };
  }

  /**
   * Queue consumer: classify + dedupe + ledger. ev = {click_id, token, ts, method, ip, ua, headers, cfBotScore}
   * Returns the stored click row.
   */
  async scoreClick(ev) {
    const { cfg, store } = this; const now = ev.ts;
    const tok = store.getToken(ev.token);
    const key = await endUserKey({ ip: ev.ip, ua: ev.ua, acceptLanguage: ev.headers?.['accept-language'] }, this.keySecret, now, cfg);
    const base = { click_id: ev.click_id, token: ev.token, set_id: tok.set_id, listing_id: tok.listing_id, bot_wallet: tok.bot_wallet,
      ts: now, end_user_key: key, ip_trunc: truncateIp(ev.ip), ua: ev.ua ?? '', raw_ip: ev.ip, paid: false, clawed_back: false };
    const done = (cls, reasons) => store.insertClick({ ...base, class: cls, reasons });

    const c = classifyRequest({ method: ev.method, ip: ev.ip, ua: ev.ua, headers: ev.headers ?? {}, cfBotScore: ev.cfBotScore }, cfg);
    if (c.cls === 'preview') return done('preview', c.reasons);
    if (c.cls === 'bot') return done('bot', c.reasons);
    if (now > tok.expires_at) return done('unpaid_expired', ['expired']);
    if (now - tok.issued_at < cfg.minClickDelayMs) return done('bot', ['too_fast_after_issue']);
    if (store.isSelf(tok.bot_wallet, tok.cluster_id, key)) {
      store.addStrike({ bot_wallet: tok.bot_wallet, reason: 'self_click', ts: now, click_id: ev.click_id });
      return done('self', ['self_click']);
    }
    if (store.clicksByKeySince(key, now - cfg.burstWindowMs).length >= cfg.burstMaxClicks) return done('bot', ['burst']);

    const dayStart = saltPeriod(now, cfg) * cfg.saltRotationMs;
    if (store.paidClicks(p => p.token === ev.token).length >= cfg.maxPaidClicksPerToken) return done('unpaid_duplicate', ['token_already_paid']);
    if (store.paidClicks(p => p.end_user_key === key && p.listing_id === tok.listing_id && p.ts > now - cfg.userListingWindowMs).length >= cfg.maxPaidClicksPerUserPerListingWindow)
      return done('unpaid_duplicate', ['user_listing_24h']);
    if (store.paidClicks(p => p.end_user_key === key && p.ts >= dayStart).length >= cfg.maxPaidClicksPerUserPerDay) return done('unpaid_duplicate', ['user_daily_cap']);
    if (store.paidClicks(p => p.set_id === tok.set_id).length >= cfg.maxPaidClicksPerSet) return done('unpaid_duplicate', ['set_click_cap']);

    const row = store.insertClick({ ...base, class: 'paid_candidate', reasons: [], paid: true });
    const rs = this.botRateStatus(tok.bot_wallet, now);
    const review = rs.above; const reason = review ? `bot_rate ${rs.rate.toFixed(3)} > p${cfg.botRatePercentile * 100} ${rs.cap.toFixed(3)}` : null;
    if (tok.click_atomic > 0) accrue(store, { line: 'click', tok, click_id: ev.click_id, amount: tok.click_atomic, now, review, cfg, reason });
    // Chat: show incentives of the whole set unlock on the first verified click within the window.
    if (tok.channel === 'chat') {
      for (const t of store.tokensForSet(tok.set_id)) {
        if (t.show_atomic > 0 && now - t.issued_at <= cfg.chatShowClickWindowMs)
          accrue(store, { line: 'show', tok: t, click_id: ev.click_id, amount: t.show_atomic, now, review, cfg, reason });
      }
    }
    return row;
  }

  /** Clawback a fraudulent click (provider report / review) during holdback. Also claws back
   *  chat show lines it unlocked unless another surviving paid click in the set still qualifies. */
  clawbackClick(click_id, now, reason) {
    const { store, cfg } = this;
    const click = store.clicks.find(c => c.click_id === click_id);
    if (!click?.paid) throw new Error('not a paid click');
    const out = [];
    const r = clawback(store, `${click.token}:click`, now, reason); if (r) out.push(r);
    click.clawed_back = true;
    const survivor = store.paidClicks(p => p.set_id === click.set_id)
      .find(p => store.tokensForSet(click.set_id).some(t => p.ts - t.issued_at <= cfg.chatShowClickWindowMs));
    if (!survivor) for (const t of store.tokensForSet(click.set_id)) {
      const st = entryState(store, `${t.token}:show`);
      if (st && st.state !== 'clawed_back' && st.state !== 'vested') out.push(clawback(store, st.entry_id, now, `gate_click_clawed:${reason}`));
    }
    return out;
  }

  /** Clawback every unvested line of a bot (e.g. click-farm finding). */
  clawbackBot(bot_wallet, now, reason) {
    const ids = [...new Set(this.store.ledger().filter(r => r.bot_wallet === bot_wallet).map(r => r.entry_id))];
    return ids.map(id => entryState(this.store, id)).filter(s => s.state === 'held' || s.state === 'review').map(s => clawback(this.store, s.entry_id, now, reason));
  }

  /** Data minimisation: drop raw IPs older than retention. */
  purgeRawIps(now) {
    for (const c of this.store.clicks) if (c.raw_ip && now - c.ts > this.cfg.rawIpRetentionMs) c.raw_ip = null;
  }

  /** POST /v1/proofs. caller_wallet comes from the authenticated request (MVP: header; phase 2 RFC 9421). */
  async submitProof({ token, channel, artefact, caller_wallet, publisher_id = null, now = Date.now() }) {
    const allowed = ['web', 'x', 'onchain', 'bot', 'chat'];
    if (!allowed.includes(channel)) return { status: 400, error: 'unsupported_channel' };
    if (typeof artefact !== 'string' || !artefact || artefact.length > 2048) return { status: 400, error: 'bad_artefact' };
    const v = await verifyToken(this.verifyKeys, token, { now });
    if (!v.ok) return { status: 400, error: `token_${v.reason}` };
    if (v.expired) return { status: 410, error: 'token_expired' };
    if (!caller_wallet || caller_wallet.toLowerCase() !== String(v.payload.bot_wallet).toLowerCase()) return { status: 403, error: 'wallet_mismatch' };
    const proof = { proof_id: `pf_${base62Code(16)}`, token, channel, artefact, publisher_id,
      tier: channel === 'chat' ? 2 : 1, status: 'pending', checks: [], created_at: now };
    if (!this.store.insertProof(proof)) return { status: 409, error: 'duplicate_proof' };
    return { status: 201, body: { proof_id: proof.proof_id, status: 'pending' } };
  }
}
