/**
 * Hash-chained audit log (roadmap B.6, Kept). Every consequential record (policy adopted, money moved, approval
 * decided, kill switch, contest) appends a row whose hash covers the previous hash. /audit/verify replays the
 * chain and the badge turns red if any row was edited.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";

const GENESIS = "0".repeat(64);

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`)
    .join(",")}}`;
}

export function rowHash(prev: string, kind: string, entity: string, entityId: string, payload: unknown): string {
  return createHash("sha256").update(prev).update("|").update(kind).update("|").update(entity).update("|").update(entityId).update("|").update(canonical(payload)).digest("hex");
}

/** `merchantId` is stored beside the row (outside the hash) so each shop sees only its own entries. */
export async function appendAudit(kind: string, entity: string, entityId: string, payload: unknown, q?: Queryable, merchantId?: string | null): Promise<{ seq: number; hash: string }> {
  const db = q ?? (await getDb());
  const last = (await db.query<{ hash: string }>("SELECT hash FROM audit_chain ORDER BY seq DESC LIMIT 1")).rows[0];
  const prev = last?.hash ?? GENESIS;
  const hash = rowHash(prev, kind, entity, entityId, payload);
  const r = await db.query<{ seq: number }>("INSERT INTO audit_chain (kind, entity, entity_id, payload, prev_hash, hash, merchant_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING seq", [kind, entity, entityId, JSON.stringify(payload), prev, hash, merchantId ?? (entity === "merchant" ? entityId : (payload as any)?.merchantId ?? null)]);
  return { seq: Number(r.rows[0].seq), hash };
}

export async function verifyChain(q?: Queryable): Promise<{ ok: boolean; rows: number; broken_at: number | null; head: string }> {
  const db = q ?? (await getDb());
  const rows = (await db.query<{ seq: number; kind: string; entity: string; entity_id: string; payload: unknown; prev_hash: string; hash: string }>("SELECT * FROM audit_chain ORDER BY seq")).rows;
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, rows: rows.length, broken_at: Number(r.seq), head: prev };
    const h = rowHash(prev, r.kind, r.entity, r.entity_id, r.payload);
    if (h !== r.hash) return { ok: false, rows: rows.length, broken_at: Number(r.seq), head: prev };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length, broken_at: null, head: prev };
}

/** A shop's own audit rows (the chain itself is verified whole, across shops). */
export async function recentAudit(limit = 100, merchantId?: string) {
  const db = await getDb();
  if (merchantId) return (await db.query("SELECT * FROM audit_chain WHERE merchant_id = $2 ORDER BY seq DESC LIMIT $1", [limit, merchantId])).rows as any[];
  return (await db.query("SELECT * FROM audit_chain ORDER BY seq DESC LIMIT $1", [limit])).rows as any[];
}
