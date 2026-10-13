import { getAddress, isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { pool } from "./db";
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
export const DEFAULT_PAY_TO = process.env.PAY_TO_ADDRESS || "0x0e66433540a91D9683E939c8Ac17BC084571D050";
export const GRACE_SEC = Number(process.env.PAYTO_GRACE_SEC ?? 600);   // previous payTo still accepted this long after a change

export async function audit(actor: string, action: string, details: any) { await q("INSERT INTO admin_audit(actor,action,details) VALUES ($1,$2,$3)", [actor, action, details]); }
export async function ensureWallet() {
  await q(`INSERT INTO wallet_settings(pay_to,changed_by,note) SELECT $1,'system','initial (PAY_TO_ADDRESS)' WHERE NOT EXISTS (SELECT 1 FROM wallet_settings)`, [getAddress(DEFAULT_PAY_TO)]);
}
let cache: { at: number; v: any } | null = null;
export const _resetWalletCache = () => { cache = null; };
/** payTo in force + the previous one if it was replaced less than GRACE_SEC ago. */
export async function payToState(): Promise<{ version: number; pay_to: string; since: string; previous: { pay_to: string; until: string } | null }> {
  if (cache && Date.now() - cache.at < 3000) return cache.v;
  const rows = await q("SELECT version, pay_to, created_at FROM wallet_settings ORDER BY version DESC LIMIT 2");
  if (!rows.length) { await ensureWallet(); return payToState(); }
  const [cur, prev] = rows;
  const graceUntil = new Date(new Date(cur.created_at).getTime() + GRACE_SEC * 1000);
  const v = { version: cur.version, pay_to: cur.pay_to, since: cur.created_at, previous: prev && graceUntil > new Date() && prev.pay_to !== cur.pay_to ? { pay_to: prev.pay_to, until: graceUntil.toISOString() } : null };
  cache = { at: Date.now(), v }; return v;
}
export async function acceptablePayTos(): Promise<string[]> { const s = await payToState(); return [s.pay_to, ...(s.previous ? [s.previous.pay_to] : [])]; }

/** Strict EIP-55: must be checksummed exactly (all-lowercase / all-uppercase rejected) and re-typed identically. */
export function validatePayTo(address: string, confirm: string): string | null {
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return "address must be 0x + 40 hex chars";
  if (!isAddress(address, { strict: true }) || getAddress(address) !== address) return `EIP-55 checksum invalid (expected ${getAddress(address)})`;
  if (/^0x0{40}$/i.test(address)) return "zero address not allowed";
  if (confirm !== address) return "confirmation does not match (re-type the exact checksummed address)";
  return null;
}
export async function setPayTo(address: string, confirm: string, actor: string, note: string | null) {
  const err = validatePayTo(address, confirm);
  if (err) throw Object.assign(new Error(err), { status: 400, code: "validation" });
  const old = await payToState();
  if (old.pay_to === address) throw Object.assign(new Error("address unchanged"), { status: 409 });
  const r = (await q("INSERT INTO wallet_settings(pay_to,changed_by,note) VALUES ($1,$2,$3) RETURNING *", [address, actor, note]))[0];
  await audit(actor, "payto_change", { from: old.pay_to, to: address, version: r.version, note, grace_sec: GRACE_SEC });
  _resetWalletCache();
  return { version: r.version, pay_to: address, previous: old.pay_to, grace_sec: GRACE_SEC };
}

// ---- relayer key rotation: key goes to .env (0600) + process.env; only the ADDRESS is ever returned ----
const ENV_FILE = () => process.env.ENV_FILE ?? ".env";
function upsertEnv(lines: Record<string, string>) {
  const f = ENV_FILE();
  let txt = existsSync(f) ? readFileSync(f, "utf8") : "";
  for (const [k, v] of Object.entries(lines)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    txt = re.test(txt) ? txt.replace(re, `${k}=${v}`) : txt + (txt.endsWith("\n") || !txt ? "" : "\n") + `${k}=${v}\n`;
  }
  writeFileSync(f, txt, { mode: 0o600 }); chmodSync(f, 0o600);
}
export async function rotateRelayer(input: { generate?: boolean; private_key?: string; confirm?: string }, actor: string) {
  if (input.confirm !== "ROTATE") throw Object.assign(new Error('type ROTATE to confirm'), { status: 400, code: "validation" });
  let key: `0x${string}`;
  if (input.generate) key = generatePrivateKey();
  else {
    const k = String(input.private_key ?? "").trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) throw Object.assign(new Error("private_key must be 32-byte hex"), { status: 400, code: "validation" });
    key = (k.startsWith("0x") ? k : "0x" + k) as `0x${string}`;
  }
  const address = privateKeyToAccount(key).address;
  if ((await import("./facilitator")).isPayerAddress(address)) throw Object.assign(new Error("relayer must not be the payer wallet"), { status: 400, code: "validation" });
  const old = process.env.RELAYER_ADDRESS ?? (process.env.RELAYER_PRIVATE_KEY ? privateKeyToAccount(process.env.RELAYER_PRIVATE_KEY as `0x${string}`).address : null);
  upsertEnv({ RELAYER_PRIVATE_KEY: key, RELAYER_ADDRESS: address });
  process.env.RELAYER_PRIVATE_KEY = key; process.env.RELAYER_ADDRESS = address;
  (await import("./relayer"))._resetGasCache();
  await audit(actor, "relayer_rotate", { from: old, to: address, method: input.generate ? "generated" : "imported" });
  return { address, previous: old };
}
export const actorOf = (auth?: string) => { try { return Buffer.from(String(auth).replace(/^Basic /, ""), "base64").toString().split(":")[0] || "admin"; } catch { return "admin"; } };
