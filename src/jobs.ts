import type { Db, Queryable } from "./db.js";

export type JobType = "process_webhook" | "reactivate" | "revert_promo" | "expire_offer" | "payment_followup" | "reconcile" | "sync_subscription" | "retry_cancel" | "send_channel_message" | "send_push" | "renewal_reminders" | "invoice_check";

export async function enqueue(q: Queryable, type: JobType, payload: Record<string, unknown>, runAt: Date = new Date(), dedupeKey?: string) {
  if (dedupeKey) {
    await q.query(
      `INSERT INTO jobs (type, payload, run_at, dedupe_key) VALUES ($1,$2,$3,$4)
       ON CONFLICT (dedupe_key) DO UPDATE SET payload = EXCLUDED.payload, run_at = EXCLUDED.run_at, status = 'pending', attempts = 0, last_error = NULL, updated_at = now()`,
      [type, JSON.stringify(payload), runAt, dedupeKey],
    );
  } else {
    await q.query("INSERT INTO jobs (type, payload, run_at) VALUES ($1,$2,$3)", [type, JSON.stringify(payload), runAt]);
  }
}

export async function cancelJob(q: Queryable, dedupeKey: string) {
  await q.query("UPDATE jobs SET status = 'cancelled', updated_at = now() WHERE dedupe_key = $1 AND status = 'pending'", [dedupeKey]);
}

export type Handler = (payload: any) => Promise<void>;

/** Runs due jobs one by one. Failed jobs retry with backoff, up to 5 attempts. */
export async function runDueJobs(db: Db, handlers: Record<JobType, Handler>, limit = 20, now: Date = new Date()): Promise<number> {
  const due = (
    await db.query<{ id: number; type: JobType; payload: any; attempts: number }>(
      "SELECT id, type, payload, attempts FROM jobs WHERE status = 'pending' AND run_at <= $1 ORDER BY run_at, id LIMIT $2",
      [now, limit],
    )
  ).rows;
  let ran = 0;
  for (const job of due) {
    const claimed = await db.query("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id", [job.id]);
    if (!claimed.rows.length) continue;
    try {
      const h = handlers[job.type];
      if (!h) throw new Error(`No handler for job type ${job.type}`);
      await h(typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload);
      // Only if still running: a handler may have rescheduled its own job (same dedupe key), which must stand.
      await db.query("UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1 AND status = 'running'", [job.id]);
    } catch (e) {
      const attempts = job.attempts + 1;
      const final = attempts >= 5;
      await db.query("UPDATE jobs SET status = $2, last_error = $3, run_at = $4, updated_at = now() WHERE id = $1 AND status = 'running'", [
        job.id,
        final ? "failed" : "pending",
        String((e as Error).message ?? e).slice(0, 500),
        new Date(Date.now() + 30_000 * 2 ** attempts),
      ]);
    }
    ran++;
  }
  return ran;
}
