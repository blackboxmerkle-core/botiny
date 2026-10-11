// Postgres-backed store (same async interface as MemoryStore). Dependency-free: pass any
// `query(sql, params) -> {rows}` (a pg Pool/Client). Times are epoch ms at the interface,
// TIMESTAMPTZ in the DB. Scoring should run in a transaction holding a scoring lock (see API).
const ms = v => v == null ? null : (v instanceof Date ? v.getTime() : new Date(v).getTime());
const ts = v => v == null ? null : new Date(v).toISOString();
const tokenRow = r => r && ({ ...r, show_atomic: Number(r.show_atomic), click_atomic: Number(r.click_atomic), rank: Number(r.rank),
  iat: ms(r.issued_at), exp: ms(r.expires_at), issued_at: ms(r.issued_at), expires_at: ms(r.expires_at) });
const clickRow = r => r && ({ ...r, ts: ms(r.at) });
const ledgerRow = r => ({ ...r, seq: Number(r.seq), delta_atomic: Number(r.delta_atomic), release_after: ms(r.release_after), created_at: ms(r.created_at) });

export class PgStore {
  constructor(db) { this.db = db; }
  q(sql, p) { return this.db.query(sql, p); }
  async putToken(t) {
    await this.q(`INSERT INTO harvest_tokens(token,kid,result_id,set_id,request_id,rank,listing_id,provider_id,cluster_id,bot_wallet,channel,dest_url,dest_url_hash,show_atomic,click_atomic,issued_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [t.token, t.kid, t.result_id, t.set_id, t.request_id ?? null, t.rank, t.listing_id, t.provider_id, t.cluster_id, t.bot_wallet, t.channel, t.dest_url, t.dest_url_hash, t.show_atomic, t.click_atomic, ts(t.issued_at), ts(t.expires_at)]);
  }
  async getToken(token) { return tokenRow((await this.q('SELECT * FROM harvest_tokens WHERE token=$1', [token])).rows[0]); }
  async putShortLink(l) {
    const r = await this.q('INSERT INTO short_links(code,token,dest_url,exp) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING RETURNING code', [l.code, l.token, l.dest_url, ts(l.exp)]);
    if (!r.rows.length) throw new Error('code collision');
  }
  async getShortLink(code) { return (await this.q('SELECT * FROM short_links WHERE code=$1', [code])).rows[0]; }
  async tokensForSet(set_id) { return (await this.q('SELECT * FROM harvest_tokens WHERE set_id=$1 ORDER BY rank', [set_id])).rows.map(tokenRow); }
  async botRateRows(since) {
    return (await this.q(`SELECT h.bot_wallet, COUNT(DISTINCT h.set_id)::int sets,
        COUNT(DISTINCT c.set_id)::int clicked
      FROM harvest_tokens h LEFT JOIN clicks c ON c.token=h.token AND c.paid AND NOT c.clawed_back AND c.at >= $1
      WHERE h.issued_at >= $1 GROUP BY 1`, [ts(since)])).rows;
  }
  async insertClick(c) {
    await this.q(`INSERT INTO clicks(click_id,token,set_id,listing_id,bot_wallet,at,end_user_key,ip_trunc,raw_ip,ua,class,reasons,paid,clawed_back)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false)`,
      [c.click_id, c.token, c.set_id, c.listing_id, c.bot_wallet, ts(c.ts), c.end_user_key, c.ip_trunc, c.raw_ip || null, c.ua, c.class, c.reasons, c.paid]);
    return c;
  }
  async getClick(id) { return clickRow((await this.q('SELECT * FROM clicks WHERE click_id=$1', [id])).rows[0]); }
  async markClickClawed(id) { await this.q('UPDATE clicks SET clawed_back=true WHERE click_id=$1', [id]); }
  async #n(where, p) { return (await this.q(`SELECT count(*)::int n FROM clicks WHERE paid AND NOT clawed_back AND ${where}`, p)).rows[0].n; }
  countPaidToken(token) { return this.#n('token=$1', [token]); }
  countPaidUserListing(key, listing, since) { return this.#n('end_user_key=$1 AND listing_id=$2 AND at > $3', [key, listing, ts(since)]); }
  countPaidUser(key, since) { return this.#n('end_user_key=$1 AND at >= $2', [key, ts(since)]); }
  countPaidSet(set_id) { return this.#n('set_id=$1', [set_id]); }
  async paidClicksInSet(set_id) { return (await this.q('SELECT * FROM clicks WHERE paid AND NOT clawed_back AND set_id=$1', [set_id])).rows.map(clickRow); }
  async countClicksByKeySince(key, since) { return (await this.q('SELECT count(*)::int n FROM clicks WHERE end_user_key=$1 AND at >= $2', [key, ts(since)])).rows[0].n; }
  async purgeRawIps(before) { await this.q('UPDATE clicks SET raw_ip=NULL WHERE raw_ip IS NOT NULL AND at < $1', [ts(before)]); }
  async noteBotApiKey(wallet, key, now = Date.now()) {
    await this.q('INSERT INTO bot_api_keys(bot_wallet,end_user_key,at) VALUES ($1,$2,$3) ON CONFLICT (bot_wallet,end_user_key) DO UPDATE SET at=EXCLUDED.at', [wallet.toLowerCase(), key, ts(now)]);
  }
  async noteClusterKey(cluster, key) { await this.q('INSERT INTO cluster_keys VALUES ($1,$2) ON CONFLICT DO NOTHING', [cluster, key]); }
  async linkClusterWallet(cluster, wallet) { await this.q('INSERT INTO cluster_wallets VALUES ($1,$2) ON CONFLICT DO NOTHING', [cluster, wallet.toLowerCase()]); }
  async isSelf(wallet, cluster, key) {
    return (await this.q(`SELECT EXISTS (SELECT 1 FROM bot_api_keys WHERE bot_wallet=lower($1) AND end_user_key=$3)
      OR EXISTS (SELECT 1 FROM cluster_keys WHERE cluster_id=$2 AND end_user_key=$3)
      OR EXISTS (SELECT 1 FROM cluster_wallets w JOIN bot_api_keys b ON b.bot_wallet=w.wallet WHERE w.cluster_id=$2 AND b.end_user_key=$3) AS s`, [wallet, cluster, key])).rows[0].s;
  }
  async addStrike(s) { await this.q('INSERT INTO click_strikes(bot_wallet,reason,click_id,at) VALUES ($1,$2,$3,$4)', [s.bot_wallet, s.reason, s.click_id, ts(s.ts)]); }
  async appendLedger(r) {
    const row = (await this.q(`INSERT INTO incentive_ledger(entry_id,line,token,set_id,provider_id,cluster_id,bot_wallet,click_id,proof_id,delta_atomic,kind,release_after,reason,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [r.entry_id, r.line, r.token, r.set_id, r.provider_id, r.cluster_id, r.bot_wallet, r.click_id, r.proof_id, r.delta_atomic, r.kind, ts(r.release_after), r.reason, ts(r.created_at)])).rows[0];
    return ledgerRow(row);
  }
  async ledgerEvents(f = {}) {
    const w = []; const p = [];
    if (f.entry_id) { p.push(f.entry_id); w.push(`entry_id=$${p.length}`); }
    if (f.bot_wallet) { p.push(f.bot_wallet); w.push(`bot_wallet=$${p.length}`); }
    return (await this.q(`SELECT * FROM incentive_ledger ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY seq`, p)).rows.map(ledgerRow);
  }
  async isRefunded(entry_id) { return (await this.q('SELECT 1 FROM escrow_refunds WHERE entry_id=$1', [entry_id])).rows.length > 0; }
  async useSignature(hash, expiresAt) {
    await this.q('DELETE FROM used_signatures WHERE expires_at < now()');
    return (await this.q('INSERT INTO used_signatures VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [hash, ts(expiresAt)])).rows.length > 0;
  }
  async insertProof(p) {
    const r = await this.q(`INSERT INTO proofs(proof_id,token,channel,artefact,publisher_id,tier,status,checks,created_at,binding,bot_wallet)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (token,channel) DO NOTHING RETURNING proof_id`,
      [p.proof_id, p.token, p.channel, p.artefact, p.publisher_id, p.tier, p.status, JSON.stringify(p.checks), ts(p.created_at), p.binding, p.bot_wallet]);
    return r.rows.length ? p : null;
  }
  async getProof(id) { return (await this.q('SELECT * FROM proofs WHERE proof_id=$1', [id])).rows[0]; }
}
