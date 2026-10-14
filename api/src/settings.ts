import { pool } from "./db";
type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
export interface Settings {
  query_price_atomic: number;          // price a bot pays per /v1/recommend (USDC atomic, 6dp)
  fixed_cpi_atomic: number;            // fixed platform fee per PROMOTED impression
  relevance_threshold_ppm: number;     // listings below this cosine score (x1e6) never appear
  promoted_slots: number;              // max sponsored results per response (placed first)
  bid_weight_ppm_per_atomic: number;   // promo_score = relevance_ppm + bid_weight * bid_atomic
  max_bid_atomic: number;              // advertiser bid cap
  credit_pack_price_atomic: number;    // x402 price of one search-credit top-up (default 1 test USDC)
  credit_pack_credit_atomic: number;   // credit granted per top-up; each credit search debits query_price_atomic (default 1000 queries)
  sponsored_floor_ppm: number;         // promo-v4: sponsored candidates need score >= this (>= relevance_threshold_ppm)
  sponsored_slots_max: number;         // promo-v4: max sponsored results (1..2)
  relevance_band_ppm: number;
  feed_basic_price_atomic: number;     // data feed: x402 price of one month of the basic tier
  feed_basic_quota: number;            // requests per month (basic)
  feed_basic_max_page: number;         // max items per page (basic)
  feed_pro_price_atomic: number;
  feed_pro_quota: number;
  feed_pro_max_page: number;          // promo-v4: sponsored ordered by floor(score/band) desc, then bid, then pacing boost
}
export const DEFAULT_SETTINGS: Settings = {
  query_price_atomic: 1000, fixed_cpi_atomic: 100, relevance_threshold_ppm: 150000,
  promoted_slots: 2, bid_weight_ppm_per_atomic: 200, max_bid_atomic: 5000,
  credit_pack_price_atomic: 1_000_000, credit_pack_credit_atomic: 1_000_000, sponsored_floor_ppm: 250000, sponsored_slots_max: 1, relevance_band_ppm: 50000,
  feed_basic_price_atomic: 500_000, feed_basic_quota: 2000, feed_basic_max_page: 200, feed_pro_price_atomic: 2_000_000, feed_pro_quota: 20000, feed_pro_max_page: 1000,
};
const LIMITS: Record<keyof Settings, [number, number]> = {
  query_price_atomic: [1, 10000], fixed_cpi_atomic: [0, 10000], relevance_threshold_ppm: [0, 1000000],
  promoted_slots: [0, 5], bid_weight_ppm_per_atomic: [0, 100000], max_bid_atomic: [0, 100000],
  credit_pack_price_atomic: [1000, 10_000_000], credit_pack_credit_atomic: [1000, 100_000_000], sponsored_floor_ppm: [0, 1000000], sponsored_slots_max: [0, 2], relevance_band_ppm: [1, 1000000],
  feed_basic_price_atomic: [1000, 10_000_000], feed_basic_quota: [1, 10_000_000], feed_basic_max_page: [1, 1000], feed_pro_price_atomic: [1000, 10_000_000], feed_pro_quota: [1, 10_000_000], feed_pro_max_page: [1, 1000],
};
export function validateSettings(s: any): string | null {
  for (const k of Object.keys(LIMITS) as (keyof Settings)[]) {
    const v = s?.[k]; const [lo, hi] = LIMITS[k];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) return `${k} must be integer in [${lo}, ${hi}]`;
  }
  if (s.sponsored_floor_ppm < s.relevance_threshold_ppm) return "sponsored_floor_ppm must be >= relevance_threshold_ppm";
  return null;
}
export async function ensureSettings() {
  const n = (await pool.query("SELECT count(*)::int n FROM settings_versions")).rows[0].n;
  if (!n) await pool.query("INSERT INTO settings_versions(settings, note) VALUES ($1, 'defaults')", [DEFAULT_SETTINGS]);
}
export async function currentSettings(db: Q = pool): Promise<{ version: number; settings: Settings }> {
  const r = (await db.query("SELECT version, settings FROM settings_versions ORDER BY version DESC LIMIT 1")).rows[0];
  if (!r) return { version: 0, settings: DEFAULT_SETTINGS };
  return { version: r.version, settings: { ...DEFAULT_SETTINGS, ...r.settings } };
}
export async function settingsAt(db: Q, version: number): Promise<Settings> {
  const r = (await db.query("SELECT settings FROM settings_versions WHERE version=$1", [version])).rows[0];
  if (!r) throw new Error(`settings version ${version} not found`);
  return { ...DEFAULT_SETTINGS, ...r.settings };
}
export async function saveSettings(patch: Partial<Settings>, note: string | null, by = "admin") {
  const cur = await currentSettings();
  const next = { ...cur.settings, ...patch };
  const err = validateSettings(next); if (err) throw Object.assign(new Error(err), { status: 400, code: "validation" });
  const r = await pool.query("INSERT INTO settings_versions(settings, note, changed_by) VALUES ($1,$2,$3) RETURNING version", [next, note, by]);
  return { version: r.rows[0].version as number, settings: next };
}
