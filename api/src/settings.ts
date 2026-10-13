import { pool } from "./db";
type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
export interface Settings {
  query_price_atomic: number;          // price a bot pays per /v1/recommend (USDC atomic, 6dp)
  fixed_cpi_atomic: number;            // fixed platform fee per PROMOTED impression
  relevance_threshold_ppm: number;     // listings below this cosine score (x1e6) never appear
  promoted_slots: number;              // max sponsored results per response (placed first)
  bid_weight_ppm_per_atomic: number;   // promo_score = relevance_ppm + bid_weight * bid_atomic
  max_bid_atomic: number;              // advertiser bid cap
}
export const DEFAULT_SETTINGS: Settings = {
  query_price_atomic: 1000, fixed_cpi_atomic: 100, relevance_threshold_ppm: 150000,
  promoted_slots: 2, bid_weight_ppm_per_atomic: 200, max_bid_atomic: 5000,
};
const LIMITS: Record<keyof Settings, [number, number]> = {
  query_price_atomic: [1, 10000], fixed_cpi_atomic: [0, 10000], relevance_threshold_ppm: [0, 1000000],
  promoted_slots: [0, 5], bid_weight_ppm_per_atomic: [0, 100000], max_bid_atomic: [0, 100000],
};
export function validateSettings(s: any): string | null {
  for (const k of Object.keys(LIMITS) as (keyof Settings)[]) {
    const v = s?.[k]; const [lo, hi] = LIMITS[k];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) return `${k} must be integer in [${lo}, ${hi}]`;
  }
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
