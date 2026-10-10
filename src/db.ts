import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://bot:bot@localhost:5432/botrec" });
export async function migrate() {
  await pool.query(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
}
