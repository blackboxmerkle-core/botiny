import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://bot:bot@localhost:5432/botrec" });
export async function migrate() {
  await pool.query(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
}
export async function migrateAll() { await migrate(); await migrateCrawlerSchema(); const { ensureSettings } = await import("./settings"); await ensureSettings(); }
/** Crawler tables live in the same database; the dashboard reads them, so apply the crawler schema too (idempotent). */
export async function migrateCrawlerSchema() {
  const p = join(__dirname, "..", "..", "crawler", "db", "schema.sql");
  const { existsSync } = await import("node:fs");
  if (existsSync(p)) await pool.query(readFileSync(p, "utf8"));
}
