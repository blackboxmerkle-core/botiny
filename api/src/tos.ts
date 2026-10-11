import { createHash } from "node:crypto";
import { keccak256, concat, toBytes, isHex } from "viem";
import { pool } from "./db";
import { canonicalize } from "./canonical";
/** Terms of Service, versioned and append-only. Acceptance is bound into the EIP-3009 payment nonce:
 *    nonce = keccak256( tosHash(bytes32) || requestHash(bytes32) || salt(bytes32) )
 *    requestHash = keccak256( utf8( canonicalJSON({ route, params }) ) )
 *  The bot sends X-TOS-ACCEPT: <tosHash> and X-TOS-SALT: <salt>; the on-chain authorization therefore proves acceptance. */
export type TosKind = "bot" | "advertiser";
const DRAFT = (who: string, extra: string) => `DRAFT — PLACEHOLDER TERMS — NOT LEGAL ADVICE — NOT FINAL
bot-rec-market ${who} Terms of Service (testnet prototype)

This is draft placeholder text for a testnet prototype. It has not been reviewed by a lawyer and is not legal advice.

1. Testnet only. Payments are made in test USDC on EVM test networks and have no monetary value.
2. Service. ${extra}
3. Acceptance. You accept these terms by binding their SHA-256 hash into your payment authorization
   (EIP-3009 nonce = keccak256(tosHash || requestHash || salt)) and sending X-TOS-ACCEPT / X-TOS-SALT headers.
4. Logging. Requests, responses (by hash), payments and acceptance proofs are logged and may be audited and replayed.
5. No warranty. The service is provided "as is", without warranties of any kind. Results may be sponsored and are labelled as such.
6. Changes. Terms may change; each change creates a new version and a new hash. Only the current version is accepted.
`;
export const DEFAULT_TOS: Record<TosKind, string> = {
  bot: DRAFT("Bot (API consumer)", "Ranked service recommendations are returned for each paid query. Sponsored results are labelled."),
  advertiser: DRAFT("Advertiser", "Top-ups credit a prepaid balance that is debited per promoted impression; balances are non-refundable on testnet."),
};
export const tosHashOf = (body: string) => "0x" + createHash("sha256").update(body, "utf8").digest("hex");
const q = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows;
export async function ensureTos() {
  for (const k of Object.keys(DEFAULT_TOS) as TosKind[])
    await q(`INSERT INTO tos_versions(kind,version,body,sha256,note) SELECT $1,1,$2,$3,'initial draft' WHERE NOT EXISTS (SELECT 1 FROM tos_versions WHERE kind=$1)`, [k, DEFAULT_TOS[k], tosHashOf(DEFAULT_TOS[k])]);
}
export async function currentTos(kind: TosKind) {
  return (await q("SELECT kind, version, body, sha256, note, created_at FROM tos_versions WHERE kind=$1 ORDER BY version DESC LIMIT 1", [kind]))[0];
}
export async function tosVersion(kind: TosKind, version: number) { return (await q("SELECT * FROM tos_versions WHERE kind=$1 AND version=$2", [kind, version]))[0]; }
export async function tosHistory(kind: TosKind) { return q("SELECT kind, version, sha256, note, created_at, length(body) AS chars FROM tos_versions WHERE kind=$1 ORDER BY version DESC", [kind]); }
export async function saveTos(kind: TosKind, body: string, note: string | null) {
  if (typeof body !== "string" || body.trim().length < 50 || body.length > 50_000) throw Object.assign(new Error("body must be 50..50000 chars"), { status: 400 });
  if (!/DRAFT/.test(body)) throw Object.assign(new Error("testnet ToS must stay clearly marked DRAFT"), { status: 400 });
  const r = await q(`INSERT INTO tos_versions(kind,version,body,sha256,note)
      SELECT $1, COALESCE(MAX(version),0)+1, $2, $3, $4 FROM tos_versions WHERE kind=$1 RETURNING kind, version, sha256, created_at`, [kind, body, tosHashOf(body), note]);
  return r[0];
}
export const tosUrl = (base: string, kind: TosKind, v: number) => kind === "bot" ? `${base}/v1/terms/${v}` : `${base}/v1/terms/advertiser/${v}`;
export async function tosInfo(kind: TosKind, base: string) {
  const t = await currentTos(kind);
  return { kind, version: t.version, url: tosUrl(base, kind, t.version), sha256: t.sha256,
    accept: { headers: ["X-TOS-ACCEPT: <sha256>", "X-TOS-SALT: <0x 32-byte hex>"], nonce: "keccak256(tosHash || requestHash || salt)", requestHash: "keccak256(utf8(canonicalJSON({route, params})))" } };
}
export const requestHashOf = (route: string, params: unknown) => keccak256(toBytes(canonicalize({ route, params })));
export const boundNonce = (tosHash: string, reqHash: string, salt: string) => keccak256(concat([tosHash as `0x${string}`, reqHash as `0x${string}`, salt as `0x${string}`]));
const B32 = (s: any) => typeof s === "string" && isHex(s) && s.length === 66;

export type TosResult = { ok: true; tos_version: number; tos_hash: string; proof: any } | { ok: false; reason: string };
/** Check ToS acceptance. `authNonce` is the EIP-3009 nonce from the payment (null in mock mode). */
export async function checkTos(kind: TosKind, headers: { accept?: string; salt?: string }, route: string, params: unknown, authNonce: string | null): Promise<TosResult> {
  const cur = await currentTos(kind);
  const acc = headers.accept?.trim().toLowerCase();
  if (!acc) return { ok: false, reason: "tos_missing: send X-TOS-ACCEPT with the current ToS sha256" };
  if (acc !== cur.sha256) {
    const old = (await q("SELECT version FROM tos_versions WHERE kind=$1 AND sha256=$2", [kind, acc]))[0];
    return { ok: false, reason: old ? `tos_stale: version ${old.version} accepted, current is ${cur.version}` : "tos_mismatch: X-TOS-ACCEPT does not match any ToS version" };
  }
  const request_hash = requestHashOf(route, params);
  if (authNonce == null) return { ok: true, tos_version: cur.version, tos_hash: cur.sha256, proof: { method: "header-only (mock payment mode)", request_hash } };
  const salt = headers.salt?.trim().toLowerCase();
  if (!B32(salt)) return { ok: false, reason: "tos_unbound: X-TOS-SALT (0x + 32 bytes) required" };
  const expected = boundNonce(cur.sha256, request_hash, salt!);
  if (expected.toLowerCase() !== String(authNonce).toLowerCase()) return { ok: false, reason: "tos_unbound: authorization nonce != keccak256(tosHash || requestHash || salt)" };
  return { ok: true, tos_version: cur.version, tos_hash: cur.sha256, proof: { method: "eip3009-nonce", salt, request_hash, nonce: expected, formula: "keccak256(tosHash||requestHash||salt)" } };
}
