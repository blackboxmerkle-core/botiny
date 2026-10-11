// In-memory store with the same shape as db/schema.sql. Used by tests and local dev.
// A Postgres/D1 store implements the same methods.
export class MemoryStore {
  constructor() {
    this.harvestTokens = new Map(); // token -> row
    this.shortLinks = new Map();    // code -> {code, token, dest_url, exp}
    this.publishers = [];
    this.clicks = [];               // click rows
    this.proofs = [];
    this.incentiveLedger = [];      // append-only
    this.botKeys = new Map();       // bot_wallet -> Set(endUserKey) seen on its API calls
    this.clusterKeys = new Map();   // cluster_id -> Set(endUserKey) of provider-linked wallets
    this.clusterWallets = new Map();// cluster_id -> Set(wallet)
    this.strikes = [];
    this.seq = 0;
  }
  nextSeq() { return ++this.seq; }
  putToken(row) { this.harvestTokens.set(row.token, row); }
  getToken(token) { return this.harvestTokens.get(token); }
  putShortLink(row) { if (this.shortLinks.has(row.code)) throw new Error('code collision'); this.shortLinks.set(row.code, row); }
  getShortLink(code) { return this.shortLinks.get(code); }
  tokensForSet(set_id) { return [...this.harvestTokens.values()].filter(t => t.set_id === set_id); }
  tokensForBotSince(wallet, since) { return [...this.harvestTokens.values()].filter(t => t.bot_wallet === wallet && t.issued_at >= since); }
  allTokensSince(since) { return [...this.harvestTokens.values()].filter(t => t.issued_at >= since); }
  insertClick(row) { this.clicks.push(row); return row; }
  paidClicks(pred) { return this.clicks.filter(c => c.paid && !c.clawed_back && pred(c)); }
  clicksByKeySince(key, since) { return this.clicks.filter(c => c.end_user_key === key && c.ts >= since); }
  noteBotApiKey(wallet, key) { (this.botKeys.get(wallet) ?? this.botKeys.set(wallet, new Set()).get(wallet)).add(key); }
  noteClusterKey(cluster, key) { (this.clusterKeys.get(cluster) ?? this.clusterKeys.set(cluster, new Set()).get(cluster)).add(key); }
  linkClusterWallet(cluster, wallet) { (this.clusterWallets.get(cluster) ?? this.clusterWallets.set(cluster, new Set()).get(cluster)).add(wallet.toLowerCase()); }
  isSelf(wallet, cluster, key) {
    if (this.botKeys.get(wallet)?.has(key)) return true;
    if (this.clusterKeys.get(cluster)?.has(key)) return true;
    for (const w of this.clusterWallets.get(cluster) ?? []) if (this.botKeys.get(w)?.has(key)) return true;
    return false;
  }
  addStrike(row) { this.strikes.push(row); }
  appendLedger(row) { const r = { seq: this.nextSeq(), ...row }; this.incentiveLedger.push(r); return r; }
  ledger() { return this.incentiveLedger; }
  insertProof(row) {
    if (this.proofs.some(p => p.token === row.token && p.channel === row.channel)) return null;
    this.proofs.push(row); return row;
  }
  getProof(id) { return this.proofs.find(p => p.proof_id === id); }
}
