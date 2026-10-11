import pg from "pg";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://bot:bot@localhost:5432/botrec" });
export async function migrate() {
  await pool.query(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
  await migrateClickSchema();
  await runMigrations();
}
/** Click-server tables (harvest_tokens, short_links, clicks, proofs, publishers, incentive_ledger), idempotent. */
export async function migrateClickSchema() {
  const p = join(__dirname, "..", "..", "click-server", "db", "schema.sql");
  if (existsSync(p)) await pool.query(readFileSync(p, "utf8"));
}
/** Numbered, idempotent SQL files in db/migrations, applied in order under an advisory lock, recorded once. */
export async function runMigrations() {
  const dir = join(__dirname, "..", "db", "migrations");
  if (!existsSync(dir)) return;
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(424243)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    for (const f of readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) {
      if ((await c.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f])).rows.length) continue;
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
export async function migrateAll() { await migrate(); await migrateCrawlerSchema(); const { ensureSettings } = await import("./settings"); await ensureSettings(); const { ensureTos } = await import("./tos"); await ensureTos(); const { ensureWallet } = await import("./wallets"); await ensureWallet(); }
/** Crawler tables live in the same database; the dashboard reads them, so apply the crawler schema too (idempotent). */
export async function migrateCrawlerSchema() {
  const p = join(__dirname, "..", "..", "crawler", "db", "schema.sql");
  const { existsSync } = await import("node:fs");
  if (existsSync(p)) await pool.query(readFileSync(p, "utf8"));
}
