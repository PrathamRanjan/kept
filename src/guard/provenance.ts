/**
 * Provenance firewall (roadmap B.6, Kept). Text from outside the system is registered with its trust level. A money
 * argument that appears only in untrusted text and is not confirmed by PayPal state holds the call.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";

export type Trust = "system" | "paypal" | "owner" | "agent" | "document" | "message" | "web";
export const UNTRUSTED: Trust[] = ["agent", "document", "message", "web"];

export async function register(source: string, trust: Trust, text: string, entity?: string, entityId?: string, q?: Queryable): Promise<string> {
  const db = q ?? (await getDb());
  const id = newId("prov");
  await db.query("INSERT INTO provenance (id, source, trust, text, entity, entity_id) VALUES ($1,$2,$3,$4,$5,$6)", [id, source, trust, text.slice(0, 20000), entity ?? null, entityId ?? null]);
  return id;
}

/**
 * Checks whether a numeric money argument is supported by anything trusted. `trustedValues` are amounts the
 * caller derived from PayPal or from code (prices, authorizations). If the value only appears in untrusted
 * text registered for this entity, the move must hold.
 */
export async function moneyArgumentOk(entity: string, entityId: string, cents: number, trustedValues: number[], q?: Queryable): Promise<{ ok: boolean; reason: string }> {
  if (trustedValues.includes(cents)) return { ok: true, reason: "amount derived from PayPal state or code" };
  const db = q ?? (await getDb());
  const rows = (await db.query<{ source: string; trust: Trust; text: string }>("SELECT source, trust, text FROM provenance WHERE entity = $1 AND entity_id = $2", [entity, entityId])).rows;
  const dollars = (cents / 100).toFixed(2);
  const inUntrusted = rows.filter((r) => UNTRUSTED.includes(r.trust) && (r.text.includes(dollars) || r.text.includes(String(cents))));
  if (inUntrusted.length) return { ok: false, reason: `amount ${dollars} appears only in untrusted ${inUntrusted[0].trust} text (${inUntrusted[0].source}) and PayPal does not confirm it` };
  return { ok: false, reason: `amount ${dollars} is not derived from PayPal state or code` };
}
