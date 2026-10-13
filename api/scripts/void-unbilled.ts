// One-off / ops: compensate every settle_failed request still marked billed (idempotent). See src/compensate.ts.
import { voidAllUnbilled } from "../src/compensate";
import { pool } from "../src/db";
voidAllUnbilled().then(r => { console.log(JSON.stringify(r)); return pool.end(); }).catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
