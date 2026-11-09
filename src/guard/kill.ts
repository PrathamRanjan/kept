/** Kill switches (roadmap B.6, Kept): global and per agent. Checked by the guard before any money move. */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { appendAudit } from "./audit.js";

export async function isKilled(scope: string, q?: Queryable): Promise<{ engaged: boolean; reason: string | null; scope: string } | null> {
  const db = q ?? (await getDb());
  const rows = (await db.query<{ scope: string; engaged: boolean; reason: string | null }>("SELECT scope, engaged, reason FROM kill_switches WHERE scope IN ('global', $1) AND engaged", [scope])).rows;
  const hit = rows.find((r) => r.scope === "global") ?? rows[0];
  return hit ?? null;
}

export async function setKill(scope: string, engaged: boolean, reason: string | null, by: string) {
  const db = await getDb();
  await db.query("INSERT INTO kill_switches (scope, engaged, reason, at) VALUES ($1,$2,$3,now()) ON CONFLICT (scope) DO UPDATE SET engaged = EXCLUDED.engaged, reason = EXCLUDED.reason, at = now()", [scope, engaged, reason]);
  await appendAudit(engaged ? "kill.engaged" : "kill.released", "kill_switch", scope, { reason, by });
}

export async function listKills() {
  const db = await getDb();
  return (await db.query("SELECT * FROM kill_switches ORDER BY scope")).rows as { scope: string; engaged: boolean; reason: string | null; at: Date }[];
}
