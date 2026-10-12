// Incentive consumption pacing + advertiser incentive report.
// Policy: escrowed incentives are never refunded. Unearned/clawed-back lines return to the listing's pool and are
// re-distributed before the offer expires; the pool balance at expiry is platform revenue. Pacing pushes exposure
// (inside the promoted slots, only for results already above the relevance threshold) toward offers that are
// behind their linear consumption schedule. All inputs are pinned by (market_seq, pacing_at_ms) => replayable.
type Q = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
export const DEFAULT_OFFER_DAYS = 30;
export const PACING = { boost_num: 1n, boost_den: 2n, boost_cap_ppm: 200_000n, behind_ppm: 100_000n, at_risk_ppm: 300_000n, late_left_ppm: 200_000n, late_remaining_ppm: 500_000n };
export const PACING_RULE = "pacing=lag_ppm(linear budget schedule),boost=min(lag/2,0.2)";
export type PacingStatus = "on_track" | "behind" | "at_risk" | "expired" | "no_budget" | "inactive";
export interface Pacing { listing_id: string; provider_id: string; offer_seq: number; show_atomic: number; click_atomic: number; budget_atomic: number | null;
  start_ms: number; expires_ms: number; funded: number; pool_draw: number; returned: number; expired_revenue: number; consumed: number; pool: number;
  remaining: number | null; t_ppm: number; lag_ppm: number; boost_ppm: number; status: PacingStatus }

const ms = (col: string) => `(EXTRACT(EPOCH FROM ${col})*1000)::bigint::text`;
/** Pacing for every listing that has an offer, as of market_seq M and time nowMs. Deterministic. */
export async function pacingAt(db: Q, M: number, nowMs: number, ids?: string[]): Promise<Map<string, Pacing>> {
  const p: any[] = [M]; if (ids) p.push(ids);
  const offers = (await db.query(`
    SELECT DISTINCT ON (o.listing_id) o.listing_id, o.seq, o.show_atomic::text s, o.click_atomic::text c, o.budget_atomic::text b, l.provider_id,
           ${ms("o.expires_at")} AS exp, ${ms("f.first_at")} AS start
      FROM incentive_offers o JOIN listings l USING (listing_id)
      JOIN (SELECT listing_id, MIN(created_at) first_at FROM incentive_offers WHERE seq <= $1 GROUP BY 1) f USING (listing_id)
     WHERE o.seq <= $1 ${ids ? "AND o.listing_id = ANY($2)" : ""} ORDER BY o.listing_id, o.seq DESC`, p)).rows;
  if (!offers.length) return new Map();
  const led = new Map<string, Record<string, bigint>>();
  for (const r of (await db.query(`SELECT listing_id, kind, SUM(amount_atomic)::text a FROM incentive_pool_ledger WHERE seq <= $1 AND listing_id = ANY($2) GROUP BY 1,2`,
    [M, offers.map(o => o.listing_id)])).rows) { const m = led.get(r.listing_id) ?? {}; m[r.kind] = BigInt(r.a); led.set(r.listing_id, m); }
  const out = new Map<string, Pacing>();
  const now = BigInt(nowMs);
  for (const o of offers) {
    const L = led.get(o.listing_id) ?? {}; const g = (k: string) => L[k] ?? 0n;
    const funded = g("funded"), draw = g("pool_draw"), returned = g("returned_unearned") + g("returned_clawback"), rev = g("expired_revenue");
    const consumed = funded + draw - returned, pool = returned - draw - rev;
    const start = BigInt(o.start), exp = o.exp ? BigInt(o.exp) : start + BigInt(DEFAULT_OFFER_DAYS * 86_400_000);
    const B = o.b == null ? null : BigInt(o.b);
    let t = exp > start ? ((now - start) * 1_000_000n) / (exp - start) : 1_000_000n; if (t < 0n) t = 0n; if (t > 1_000_000n) t = 1_000_000n;
    let lag = 0n, boost = 0n, status: PacingStatus;
    const active = BigInt(o.s) + BigInt(o.c) > 0n;
    if (now >= exp) status = "expired";
    else if (!active) status = "inactive";
    else if (B == null) status = "no_budget";
    else {
      const expected = (B * t) / 1_000_000n;
      lag = expected > consumed ? ((expected - consumed) * 1_000_000n) / B : 0n;
      const remainingPpm = consumed >= B ? 0n : ((B - consumed) * 1_000_000n) / B;
      status = lag >= PACING.at_risk_ppm || (1_000_000n - t <= PACING.late_left_ppm && remainingPpm >= PACING.late_remaining_ppm) ? "at_risk" : lag >= PACING.behind_ppm ? "behind" : "on_track";
      boost = (lag * PACING.boost_num) / PACING.boost_den; if (boost > PACING.boost_cap_ppm) boost = PACING.boost_cap_ppm;
    }
    out.set(o.listing_id, { listing_id: o.listing_id, provider_id: o.provider_id, offer_seq: Number(o.seq), show_atomic: Number(o.s), click_atomic: Number(o.c),
      budget_atomic: B == null ? null : Number(B), start_ms: Number(start), expires_ms: Number(exp), funded: Number(funded), pool_draw: Number(draw), returned: Number(returned),
      expired_revenue: Number(rev), consumed: Number(consumed), pool: Number(pool), remaining: B == null ? null : Number(B > consumed ? B - consumed : 0n),
      t_ppm: Number(t), lag_ppm: Number(lag), boost_ppm: Number(boost), status });
  }
  return out;
}

/** Advertiser incentive report (all advertisers when adv is null). Live (current market_seq, now). */
export async function incentiveReport(db: Q, adv: string | null, nowMs = Date.now()) {
  const M = Number((await db.query("SELECT last_value::text v FROM market_seq")).rows[0].v);
  const pac = await pacingAt(db, M, nowMs);
  const rows = [...pac.values()].filter(p => !adv || p.provider_id === adv);
  const ids = rows.map(r => r.listing_id);
  const agg = async (sql: string) => new Map<string, any>((await db.query(sql, [ids])).rows.map(r => [r.listing_id, r]));
  const issued = await agg(`SELECT listing_id, COUNT(*)::int tokens, SUM(show_atomic+click_atomic)::text amt FROM harvest_tokens WHERE listing_id = ANY($1) AND show_atomic+click_atomic > 0 GROUP BY 1`);
  const clicks = await agg(`SELECT listing_id, COUNT(*) FILTER (WHERE paid)::int paid, COUNT(*)::int total FROM clicks WHERE listing_id = ANY($1) GROUP BY 1`);
  const led = await agg(`SELECT h.listing_id,
      COALESCE(SUM(i.delta_atomic) FILTER (WHERE i.kind IN ('accrue_held','review_hold')),0)::text earned,
      COALESCE(SUM(i.delta_atomic) FILTER (WHERE i.kind='release'),0)::text vested,
      COALESCE(-SUM(i.delta_atomic) FILTER (WHERE i.kind='clawback'),0)::text clawed
    FROM incentive_ledger i JOIN harvest_tokens h USING (token) WHERE h.listing_id = ANY($1) GROUP BY 1`);
  const legacy = await agg(`SELECT h.listing_id, SUM(r.amount_atomic)::text amt FROM escrow_refunds r JOIN harvest_tokens h USING (token) WHERE h.listing_id = ANY($1) GROUP BY 1`);
  const names = await agg(`SELECT listing_id, name FROM listings WHERE listing_id = ANY($1)`);
  const offers = rows.map(p => {
    const iss = Number(issued.get(p.listing_id)?.amt ?? 0), L = led.get(p.listing_id);
    return { listing_id: p.listing_id, name: names.get(p.listing_id)?.name ?? null, advertiser_id: p.provider_id, offer_seq: p.offer_seq,
      show_atomic: p.show_atomic, click_atomic: p.click_atomic, budget_atomic: p.budget_atomic,
      funded_atomic: p.funded, pool_draw_atomic: p.pool_draw, issued_atomic: iss, issued_tokens: issued.get(p.listing_id)?.tokens ?? 0,
      clicks: clicks.get(p.listing_id)?.total ?? 0, paid_clicks: clicks.get(p.listing_id)?.paid ?? 0,
      earned_atomic: Number(L?.earned ?? 0), vested_atomic: Number(L?.vested ?? 0), clawed_back_atomic: Number(L?.clawed ?? 0),
      returned_to_pool_atomic: p.returned, pool_atomic: p.pool, expired_to_platform_atomic: p.expired_revenue,
      legacy_refunded_atomic: Number(legacy.get(p.listing_id)?.amt ?? 0),
      consumed_atomic: p.consumed, consumed_pct: p.budget_atomic ? Math.round((p.consumed * 10000) / p.budget_atomic) / 100 : null,
      remaining_atomic: p.remaining, starts_at: new Date(p.start_ms).toISOString(), expires_at: new Date(p.expires_ms).toISOString(),
      pacing: { status: p.status, lag_ppm: p.lag_ppm, boost_ppm: p.boost_ppm, time_elapsed_ppm: p.t_ppm } };
  });
  const timeline = (await db.query(`
    WITH ev AS (
      SELECT date_trunc('day', issued_at) d, listing_id, 'issued' k, (show_atomic+click_atomic)::bigint a FROM harvest_tokens WHERE listing_id = ANY($1) AND show_atomic+click_atomic>0
      UNION ALL SELECT date_trunc('day', i.created_at), h.listing_id, 'earned', i.delta_atomic FROM incentive_ledger i JOIN harvest_tokens h USING (token) WHERE h.listing_id = ANY($1) AND i.kind IN ('accrue_held','review_hold')
      UNION ALL SELECT date_trunc('day', i.created_at), h.listing_id, 'vested', i.delta_atomic FROM incentive_ledger i JOIN harvest_tokens h USING (token) WHERE h.listing_id = ANY($1) AND i.kind='release'
      UNION ALL SELECT date_trunc('day', i.created_at), h.listing_id, 'clawed_back', -i.delta_atomic FROM incentive_ledger i JOIN harvest_tokens h USING (token) WHERE h.listing_id = ANY($1) AND i.kind='clawback'
      UNION ALL SELECT date_trunc('day', created_at), listing_id, kind, amount_atomic FROM incentive_pool_ledger WHERE listing_id = ANY($1))
    SELECT to_char(d,'YYYY-MM-DD') AS day, k, SUM(a)::text a FROM ev GROUP BY 1,2 ORDER BY 1,2`, [ids])).rows;
  const days = new Map<string, any>();
  for (const t of timeline) { const r = days.get(t.day) ?? { day: t.day }; r[t.k] = Number(t.a); days.set(t.day, r); }
  const sum = (k: string) => offers.reduce((s, o: any) => s + (o[k] ?? 0), 0);
  return { advertiser_id: adv, generated_at: new Date(nowMs).toISOString(), market_seq: M,
    policy: "Escrowed incentives are not refunded. Unearned or clawed-back lines return to the offer's pool and are re-distributed before expiry; pool balance at expiry is platform revenue.",
    totals: { budget_atomic: sum("budget_atomic"), funded_atomic: sum("funded_atomic"), issued_atomic: sum("issued_atomic"), earned_atomic: sum("earned_atomic"), vested_atomic: sum("vested_atomic"),
      clawed_back_atomic: sum("clawed_back_atomic"), pool_atomic: sum("pool_atomic"), expired_to_platform_atomic: sum("expired_to_platform_atomic"), consumed_atomic: sum("consumed_atomic") },
    offers, timeline: [...days.values()] };
}
export function reportCsv(r: Awaited<ReturnType<typeof incentiveReport>>) {
  const cols = ["listing_id", "name", "advertiser_id", "budget_atomic", "funded_atomic", "issued_atomic", "issued_tokens", "clicks", "paid_clicks", "earned_atomic", "vested_atomic",
    "clawed_back_atomic", "returned_to_pool_atomic", "pool_atomic", "expired_to_platform_atomic", "consumed_atomic", "consumed_pct", "remaining_atomic", "expires_at", "pacing_status"];
  const esc = (v: any) => v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = [cols.join(","), ...r.offers.map((o: any) => cols.map(c => esc(c === "pacing_status" ? o.pacing.status : o[c])).join(","))];
  lines.push("", "day,issued,earned,vested,clawed_back,funded,pool_draw,returned_unearned,returned_clawback,expired_revenue");
  for (const d of r.timeline) lines.push([d.day, d.issued, d.earned, d.vested, d.clawed_back, d.funded, d.pool_draw, d.returned_unearned, d.returned_clawback, d.expired_revenue].map(v => v ?? 0).join(","));
  return lines.join("\n") + "\n";
}
