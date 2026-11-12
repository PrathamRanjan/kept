/**
 * Spec A3.1: judge-page steps tick themselves when the server records the matching event. A tick is written into
 * the visitor workspace's `checklist.ticks` (key -> ISO time), first time only. Only visitor workspaces tick; the
 * showcase and real shops never do. A failed tick never breaks the action that caused it.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";

export const TICKS = [
  "member_opened",
  "assistant_read",
  "assistant_acted",
  "assistant_readback",
  "offer_shown",
  "cancel_answered",
  "scam_checked",
  "owner_asked",
  "rule_refused",
  "proof_opened",
  "approval_decided",
  "member_changed",
  "agents_opened",
  "paypal_opened",
] as const;
export type Tick = (typeof TICKS)[number];

export async function tick(merchantId: string | null | undefined, key: Tick, q?: Queryable): Promise<void> {
  if (!merchantId) return;
  try {
    const db = q ?? (await getDb());
    await db.query(
      // "ticks" keeps the first time (the judge page's paths); "last" keeps the latest time (the guided journey).
      `UPDATE workspaces SET checklist = jsonb_set(
          jsonb_set(coalesce(checklist, '{}'::jsonb), '{ticks}',
            CASE WHEN coalesce(checklist->'ticks', '{}'::jsonb) ? $2 THEN checklist->'ticks'
                 ELSE coalesce(checklist->'ticks', '{}'::jsonb) || jsonb_build_object($2::text, to_jsonb(now()::text)) END),
          '{last}', coalesce(checklist->'last', '{}'::jsonb) || jsonb_build_object($2::text, to_jsonb(now())))
        WHERE tenant_id = $1 AND kind = 'visitor'`,
      [merchantId, key],
    );
  } catch {
    /* ticks are a convenience for the judge page; never block the action */
  }
}

/** The latest time each tick happened (ISO strings). */
export function lastTicksOf(checklist: unknown): Record<string, string> {
  const t = (checklist as any)?.last;
  return t && typeof t === "object" ? t : {};
}

export function ticksOf(checklist: unknown): Record<string, string> {
  const t = (checklist as any)?.ticks;
  return t && typeof t === "object" ? t : {};
}
