// Ops check: replay EVERY logged request (incl. unsettled ones, which the public route no longer re-ranks). Prints counts only.
import { pool } from "../src/db";
import { replayRequest } from "../src/replay";
(async () => {
const ids = (await pool.query("SELECT request_id FROM requests ORDER BY received_at")).rows.map(r => r.request_id);
let m = 0; const bad: string[] = [];
for (const id of ids) { const r = await replayRequest(id).catch(() => null); if (r?.match) m++; else bad.push(id); }
console.log(JSON.stringify({ total: ids.length, match: m, mismatch: bad }));
await pool.end();

})();
