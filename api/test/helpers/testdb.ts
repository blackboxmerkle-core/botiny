// Import FIRST in tests: never let a test run against the live database by accident.
process.env.DATABASE_URL ??= "postgres://bot:bot@localhost:5432/botrec_test";
process.env.PAYMENT_MODE ??= "mock";
if (!/\/[A-Za-z0-9_]+_test(\?|$)/.test(process.env.DATABASE_URL)) throw new Error(`refusing to run tests against ${process.env.DATABASE_URL}`);
