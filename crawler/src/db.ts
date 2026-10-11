import { readFileSync } from "node:fs";
import { join } from "node:path";
export { pool } from "../../api/src/db";
import { pool } from "../../api/src/db";
export async function migrateCrawler() {
  const { migrateAll } = await import("../../api/src/db");
  await migrateAll();                                    // api schema (listings etc.) first
  await pool.query(readFileSync(join(__dirname, "..", "db", "schema.sql"), "utf8"));
  const { ensureSources } = await import("./sources");
  await ensureSources();
}
export const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
