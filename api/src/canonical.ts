import { createHash } from "node:crypto";
/** Canonical JSON: recursively sorted keys, no whitespace, integers only (floats rejected). */
export function canonicalize(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error(`non-integer number in canonical JSON: ${v}`);
    return String(v);
  }
  if (typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).filter(k => o[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ":" + canonicalize(o[k])).join(",") + "}";
  }
  throw new Error("unsupported type " + typeof v);
}
export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
