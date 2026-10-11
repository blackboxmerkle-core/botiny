// All economics and thresholds live here. Nothing below is hardcoded elsewhere.
// Amounts are atomic USDC (6 decimals): $0.01 = 10_000, $0.001 = 1_000.
export const FEE_PRESETS = { low: 1_000, standard: 10_000 };

export const DEFAULTS = Object.freeze({
  feeAtomic: FEE_PRESETS.standard,
  // curation (Incentive model v3 §2)
  setSize: 10,                 // k
  maxSlotsPerCluster: 2,       // m (C3)
  lineItemCapMult: 0.25,       // σ,κ ≤ 0.25f (C1)
  clusterCapMult: 0.5,         // α (C2)
  setCapMult: 4,               // τ (C6)
  minRelevance: 0.5,           // θ (C4)
  minDistinctClusters: 3,      // N_rel (C4)
  // tokens / clicks (Click spec §1,§3)
  tokenPayValidityMs: 7 * 86_400_000,
  minClickDelayMs: 2_000,
  maxPaidClicksPerToken: 1,
  userListingWindowMs: 86_400_000,
  maxPaidClicksPerUserPerListingWindow: 1,
  maxPaidClicksPerUserPerDay: 5,
  maxPaidClicksPerSet: 2,      // c_max
  burstWindowMs: 10_000,       // "very fast click bursts from one key"
  burstMaxClicks: 3,
  // show vesting (chat)
  chatShowClickWindowMs: 86_400_000,
  // bot-level caps
  botRateWindowMs: 7 * 86_400_000,
  botRatePercentile: 0.95,
  botRateMinBots: 5,           // below this many bots, fall back to botRateFallbackCap
  botRateFallbackCap: 0.8,     // π_cap (A)
  botRateMinSets: 20,          // don't judge a bot on fewer sets
  // ledger
  holdbackMs: 14 * 86_400_000,
  takeRate: 0.15,              // informational; charged to provider at escrow time
  // privacy
  saltRotationMs: 86_400_000,
  rawIpRetentionMs: 86_400_000,
  datacenterCidrs: [],         // fill from a cloud ASN list at deploy time
  shortCodeLength: 12,
  // settlement
  settleGraceMs: 3_600_000,    // wait after a line's last chance to accrue before refunding its escrow
  // bot-side request binding
  sigMaxSkewMs: 300_000,
  allowUnsignedBotRequests: false, // legacy X-Bot-Wallet-only binding; such proofs are marked binding='header'
});

/** Build config from defaults + overrides + optional env (CS_FEE=low|standard|<atomic>). */
export function makeConfig(overrides = {}, env = {}) {
  const c = { ...DEFAULTS };
  if (env.CS_FEE) c.feeAtomic = FEE_PRESETS[env.CS_FEE] ?? Number(env.CS_FEE);
  for (const [k, v] of Object.entries(env)) {
    const m = /^CS_CFG_(.+)$/.exec(k);
    if (m && m[1] in c && typeof c[m[1]] === 'number') c[m[1]] = Number(v);
    if (m && m[1] in c && typeof c[m[1]] === 'boolean') c[m[1]] = v === '1' || v === 'true';
  }
  Object.assign(c, overrides);
  if (!Number.isInteger(c.feeAtomic) || c.feeAtomic <= 0) throw new Error('feeAtomic must be a positive integer');
  return Object.freeze(c);
}
