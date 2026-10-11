// In-memory store. All methods are async so the engine runs unchanged on the Postgres store
// (src/pg-store.js). Shape mirrors db/schema.sql.
export class MemoryStore {
  constructor() {
    this.harvestTokens = new Map(); this.shortLinks = new Map(); this.clicks = []; this.proofs = [];
    this.incentiveLedger = []; this.refunded = new Set();
    this.botKeys = new Map(); this.clusterKeys = new Map(); this.clusterWallets = new Map(); this.strikes = []; this.seq = 0;
  }
  async putToken(row) { this.harvestTokens.set(row.token, row); }
  async getToken(token) { return this.harvestTokens.get(token); }
  async putShortLink(row) { if (this.shortLinks.has(row.code)) throw new Error('code collision'); this.shortLinks.set(row.code, row); }
  async getShortLink(code) { return this.shortLinks.get(code); }
  async tokensForSet(set_id) { return [...this.harvestTokens.values()].filter(t => t.set_id === set_id); }
  /** [{bot_wallet, sets, clicked}] over tokens issued since `since` (paid, not clawed-back clicks). */
  async botRateRows(since) {
    const m = new Map();
    for (const t of this.harvestTokens.values()) if (t.issued_at >= since)
      (m.get(t.bot_wallet) ?? m.set(t.bot_wallet, { sets: new Set(), clicked: new Set() }).get(t.bot_wallet)).sets.add(t.set_id);
    for (const c of this.clicks) if (c.paid && !c.clawed_back && c.ts >= since) m.get(c.bot_wallet)?.clicked.add(c.set_id);
    return [...m].map(([bot_wallet, r]) => ({ bot_wallet, sets: r.sets.size, clicked: r.clicked.size }));
  }
  async insertClick(row) { this.clicks.push(row); return row; }
  async getClick(id) { return this.clicks.find(c => c.click_id === id); }
  async markClickClawed(id) { const c = await this.getClick(id); if (c) c.clawed_back = true; }
  #paid(pred) { return this.clicks.filter(c => c.paid && !c.clawed_back && pred(c)); }
  async countPaidToken(token) { return this.#paid(c => c.token === token).length; }
  async countPaidUserListing(key, listing, since) { return this.#paid(c => c.end_user_key === key && c.listing_id === listing && c.ts > since).length; }
  async countPaidUser(key, since) { return this.#paid(c => c.end_user_key === key && c.ts >= since).length; }
  async countPaidSet(set_id) { return this.#paid(c => c.set_id === set_id).length; }
  async paidClicksInSet(set_id) { return this.#paid(c => c.set_id === set_id); }
  async countClicksByKeySince(key, since) { return this.clicks.filter(c => c.end_user_key === key && c.ts >= since).length; }
  async purgeRawIps(before) { for (const c of this.clicks) if (c.ts < before) c.raw_ip = null; }
  async noteBotApiKey(wallet, key) { (this.botKeys.get(wallet) ?? this.botKeys.set(wallet, new Set()).get(wallet)).add(key); }
  async noteClusterKey(cluster, key) { (this.clusterKeys.get(cluster) ?? this.clusterKeys.set(cluster, new Set()).get(cluster)).add(key); }
  async linkClusterWallet(cluster, wallet) { (this.clusterWallets.get(cluster) ?? this.clusterWallets.set(cluster, new Set()).get(cluster)).add(wallet.toLowerCase()); }
  async isSelf(wallet, cluster, key) {
    if (this.botKeys.get(wallet)?.has(key)) return true;
    if (this.clusterKeys.get(cluster)?.has(key)) return true;
    for (const w of this.clusterWallets.get(cluster) ?? []) if (this.botKeys.get(w)?.has(key)) return true;
    return false;
  }
  async addStrike(row) { this.strikes.push(row); }
  async appendLedger(row) { const r = { seq: ++this.seq, ...row }; this.incentiveLedger.push(r); return r; }
  /** events ordered by seq; filter {entry_id?, bot_wallet?} */
  async ledgerEvents(f = {}) { return this.incentiveLedger.filter(r => (!f.entry_id || r.entry_id === f.entry_id) && (!f.bot_wallet || r.bot_wallet === f.bot_wallet)); }
  async useSignature(hash) { this.usedSigs ??= new Set(); if (this.usedSigs.has(hash)) return false; this.usedSigs.add(hash); return true; }
  async isRefunded(entry_id) { return this.refunded.has(entry_id); }
  async insertProof(row) {
    if (this.proofs.some(p => p.token === row.token && p.channel === row.channel)) return null;
    this.proofs.push(row); return row;
  }
  async getProof(id) { return this.proofs.find(p => p.proof_id === id); }
}
