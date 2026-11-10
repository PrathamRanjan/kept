/**
 * Per-workspace daily allowance on model calls a visitor can trigger (owner Ask, rule and plan drafting), so one
 * visitor cannot spend the shared OpenAI credit. Shops that are not visitor workspaces have no allowance.
 * A member's cancel is never gated by this.
 */
import { getDb } from "../db.js";
import { KeptError } from "../store.js";

export const MODEL_CALLS_PER_DAY = Number(process.env.KEPT_WS_MODEL_CALLS_PER_DAY || 60);

export async function spendAllowance(merchantId: string | null | undefined, kind = "model", limit = MODEL_CALLS_PER_DAY): Promise<void> {
  if (!merchantId) return;
  const db = await getDb();
  const ws = (await db.query<{ id: string }>("SELECT id FROM workspaces WHERE tenant_id = $1 AND kind = 'visitor'", [merchantId])).rows[0];
  if (!ws) return;
  const day = new Date().toISOString().slice(0, 10);
  const n = Number((await db.query<{ n: number }>("INSERT INTO usage_counters (scope, day, kind, n) VALUES ($1,$2,$3,1) ON CONFLICT (scope, day, kind) DO UPDATE SET n = usage_counters.n + 1 RETURNING n", [ws.id, day, kind])).rows[0]?.n ?? 0);
  if (n > limit) throw new KeptError(`Your demo shop has used today's ${limit} model calls. The allowance starts again at midnight UTC; everything else keeps working.`, "allowance_used", 429);
}
