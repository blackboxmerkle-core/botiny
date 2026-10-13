import pg from "pg";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
/** Inside `node --test` (NODE_TEST_CONTEXT is set) only a database whose name ends in _test is allowed, and there is no live fallback. */
export function dbNameOf(url: string) { try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")); } catch { return ""; } }
export function assertTestDbUrl(url: string | undefined) {
  if (!url || !dbNameOf(url).endsWith("_test")) throw new Error(`refusing to run tests against non-_test database ${url ? dbNameOf(url) || "(unparseable)" : "(DATABASE_URL unset)"}`);
}
if (process.env.NODE_TEST_CONTEXT) assertTestDbUrl(process.env.DATABASE_URL);
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://bot:bot@localhost:5432/botrec" });
if (process.env.NODE_TEST_CONTEXT) pool.on("connect", c => { c.query("SELECT current_database() d").then(r => { if (!String(r.rows[0].d).endsWith("_test")) { console.error("connected to non-_test db in tests; exiting"); process.exit(1); } }).catch(() => {}); });
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
/** Ordered migration files. Identity is the FULL filename (never the numeric prefix), and two files sharing a prefix are refused so order is never ambiguous. */
export function migrationFiles(names: string[]) {
  const files = names.filter(f => /^\d{4}_[\w.-]+\.sql$/.test(f)).sort();
  const seen = new Map<string, string>();
  for (const f of files) { const p = f.slice(0, 4); if (seen.has(p)) throw new Error(`duplicate migration prefix ${p}: ${seen.get(p)} and ${f}`); seen.set(p, f); }
  return files;
}
export async function runMigrations() {
  const dir = join(__dirname, "..", "db", "migrations");
  if (!existsSync(dir)) return;
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(424243)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const files = migrationFiles(readdirSync(dir));
    const applied = (await c.query("SELECT name FROM schema_migrations")).rows.map(r => r.name as string);
    const foreign = applied.filter(n => !files.includes(n));
    if (foreign.length) console.warn(`schema_migrations lists migrations not in this checkout (another branch/tool?): ${foreign.join(", ")}`);
    for (const f of files) {
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
