import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDbUrl, migrationFiles, dbNameOf } from "../src/db";
test("test DB guard refuses live/unset/non-_test databases", () => {
  assert.throws(() => assertTestDbUrl(undefined));
  assert.throws(() => assertTestDbUrl("postgres://bot:bot@localhost:5432/botrec"));
  assert.throws(() => assertTestDbUrl("postgres://bot:bot@localhost:5432/botrec_test_x"));
  assert.doesNotThrow(() => assertTestDbUrl("postgres://bot:bot@localhost:5432/botrec_test?sslmode=disable"));
  assert.equal(dbNameOf(process.env.DATABASE_URL!), "botrec_test");
});
test("migration runner: full-name identity, sorted, duplicate prefixes refused", () => {
  assert.deepEqual(migrationFiles(["0002_b.sql", "0001_a.sql", "README.md", "0010_c.sql"]), ["0001_a.sql", "0002_b.sql", "0010_c.sql"]);
  assert.throws(() => migrationFiles(["0004_track_all_results.sql", "0004_click_attestation.sql"]), /duplicate migration prefix 0004/);
});
