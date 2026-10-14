// stdio transport for the Botiny MCP server: newline-delimited JSON-RPC on stdin/stdout, forwarded to the HTTP endpoint.
// Env: BOTINY_MCP_URL (default https://<PUBLIC_BASE_URL>/mcp or http://localhost:8402/mcp), BOTINY_CREDIT_KEY (bck_...; never logged).
// e.g. claude/cursor config: { "command": "npx", "args": ["tsx", "src/mcp-stdio.ts"], "env": { "BOTINY_CREDIT_KEY": "bck_..." } }
import { createInterface } from "node:readline";
const url = process.env.BOTINY_MCP_URL ?? ((process.env.PUBLIC_BASE_URL ?? "http://localhost:8402").replace(/\/$/, "") + "/mcp");
const key = process.env.BOTINY_CREDIT_KEY;
const rl = createInterface({ input: process.stdin });
let chain = Promise.resolve();
rl.on("line", line => { if (!line.trim()) return; chain = chain.then(() => forward(line)); });
async function forward(line: string) {
  let id: any = null; try { id = JSON.parse(line)?.id ?? null; } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "ngrok-skip-browser-warning": "1", ...(key ? { authorization: "Bearer " + key } : {}) }, body: line });
    if (r.status === 202) return;
    const t = await r.text();
    try { out(JSON.parse(t)); } catch { if (id !== null) out({ jsonrpc: "2.0", id, error: { code: -32603, message: `HTTP ${r.status}` } }); }
  } catch (e: any) { if (id !== null) out({ jsonrpc: "2.0", id, error: { code: -32603, message: "botiny unreachable: " + String(e?.message ?? e).slice(0, 200) } }); }
}
function out(o: any) { process.stdout.write(JSON.stringify(o) + "\n"); }
