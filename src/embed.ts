/** Deterministic local embedding: signed hashed bag-of-words (FNV-1a), L2-normalised, rounded to 6dp. */
export const EMBEDDING_MODEL = "hbow-fnv1a-256-v1";
export const DIMS = 256;
const STOP = new Set("a an the and or of for to in on with by is are be at from that this it as i me my we our you your".split(" "));
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export function tokenize(text: string): string[] {
  return (text.normalize("NFKC").toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => !STOP.has(t));
}
export function embed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  const toks = tokenize(text);
  const feats = [...toks, ...toks.slice(1).map((t, i) => toks[i] + "_" + t)]; // unigrams + bigrams
  for (const f of feats) {
    const h = fnv1a(f);
    v[h % DIMS] += (h >>> 31) ? -1 : 1;
  }
  let n = 0; for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => Math.round((x / n) * 1e6) / 1e6);
}
export const toPgVector = (v: number[]) => "[" + v.join(",") + "]";
export const fromPgVector = (s: string) => s.slice(1, -1).split(",").map(Number);
