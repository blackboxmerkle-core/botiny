import type { PoolClient } from "pg";
import { pool } from "./db";
import { embed, toPgVector, EMBEDDING_MODEL } from "./embed";
import { sha256 } from "./canonical";
export interface ListingInput {
  provider_id: string; name: string; description: string; address: string;
  kind?: string; tags?: string[]; source_url?: string | null; cpi_micro_usdc?: number; supersedes?: string | null;
  licence_class?: string | null; crawl_item_id?: string | null;
}
export function validateListing(b: any): string | null {
  for (const f of ["provider_id", "name", "description", "address"]) if (typeof b?.[f] !== "string" || !b[f].trim()) return `${f} required`;
  if (b.name.length > 120 || b.description.length > 500) return "name<=120, description<=500 chars";
  if (!/^(https?|mcp|wss?):\/\//.test(b.address)) return "address must be a URL";
  if (b.cpi_micro_usdc !== undefined && !(Number.isSafeInteger(b.cpi_micro_usdc) && b.cpi_micro_usdc >= 0)) return "cpi_micro_usdc must be a non-negative integer";
  return null;
}
export async function insertListing(b: ListingInput, client?: { query: PoolClient["query"] }): Promise<{ listing_id: string; catalogue_seq: number }> {
  if (!client) { const { withMarketLock } = await import("./market"); return withMarketLock(c => insertListing(b, c)); }
  const text = `${b.name}. ${b.description} ${(b.tags ?? []).join(" ")}`;
  const listing_id = "lst_" + sha256(`${b.provider_id}|${b.name}|${b.address}|${Date.now()}|${Math.random()}`).slice(0, 16);
  const r = await client.query(
    `INSERT INTO listings(listing_id,supersedes,provider_id,name,description,address,kind,tags,source_url,cpi_micro_usdc,embedding_model,embedding,licence_class,crawl_item_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING seq, listing_id`,
    [listing_id, b.supersedes ?? null, b.provider_id, b.name.trim(), b.description.trim(), b.address.trim(), b.kind ?? "service",
     b.tags ?? [], b.source_url ?? null, b.cpi_micro_usdc ?? 0, EMBEDDING_MODEL, toPgVector(embed(text)), b.licence_class ?? null, b.crawl_item_id ?? null]);
  return { listing_id: r.rows[0].listing_id as string, catalogue_seq: Number(r.rows[0].seq) };
}
