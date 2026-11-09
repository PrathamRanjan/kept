/**
 * The cycle card: one stamp per billing cycle, built only from what Kept knows (PayPal payments read back,
 * skip and pause events, the resume date, the discount end, the cancel date and the plan's interval).
 * Nothing here is invented: an upcoming stamp is a projection from PayPal's next billing time and is labelled so.
 */
import type { Queryable } from "../db.js";
import { intervalMs, type Plan, type Subscriber } from "../store.js";

export type StampKind = "paid" | "discount" | "skipped" | "paused" | "failed" | "upcoming";
export interface Stamp {
  kind: StampKind;
  date: string;
  amount: string | null;
  /** True for the first upcoming stamp. */
  next?: boolean;
  /** Scheduled skips and pauses that haven't happened yet. */
  scheduled?: boolean;
}
export interface CycleCard {
  stamps: Stamp[];
  end: { kind: "cancelled" | "cancel_pending"; date: string | null } | null;
  every: string;
}

const SLOTS = 8;

export async function cycleCard(q: Queryable, s: Subscriber, plans: Plan[]): Promise<CycleCard> {
  const plan = plans.find((p) => p.id === s.plan_id) ?? null;
  const home = plans.find((p) => p.id === (s.home_plan_id ?? s.plan_id)) ?? plan;
  const every = plan ? (plan.interval_count === 1 ? plan.interval_unit.toLowerCase() : `${plan.interval_count} ${plan.interval_unit.toLowerCase()}s`) : "cycle";
  if (!plan) return { stamps: [], end: null, every };
  const iv = intervalMs(plan);
  const now = Date.now();

  const pays = (await q.query<{ amount: string; paid_at: Date; status: string }>("SELECT amount, paid_at, status FROM payments WHERE subscriber_id = $1 ORDER BY paid_at", [s.id])).rows;
  const events = (await q.query<{ type: string; payload: any; created_at: Date }>("SELECT type, payload, created_at FROM event_log WHERE subscriber_id = $1 AND type IN ('skip.scheduled','pause.scheduled') ORDER BY id", [s.id])).rows;

  const past: Stamp[] = [];
  const homePrice = home?.price ?? plan.price;
  for (const p of pays) {
    if (!/^completed$/i.test(p.status)) continue;
    const amt = Number(p.amount);
    past.push({ kind: amt + 0.005 < homePrice ? "discount" : "paid", date: new Date(p.paid_at).toISOString(), amount: amt.toFixed(2) });
  }
  for (const e of events) {
    const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload ?? {};
    const cycles = Math.max(1, Math.min(12, Number(payload.cycles ?? 1)));
    const resumeAt = payload.resumeAt ? new Date(payload.resumeAt).getTime() : new Date(e.created_at).getTime() + cycles * iv;
    for (let k = cycles; k >= 1; k--) {
      const t = resumeAt - 3600_000 - (k - 1) * iv;
      past.push({ kind: e.type.startsWith("skip") ? "skipped" : "paused", date: new Date(t).toISOString(), amount: null, scheduled: t > now || undefined });
    }
  }
  if (s.kept_state === "payment_failed") {
    const t = s.next_billing_time && s.next_billing_time.getTime() < now ? s.next_billing_time.getTime() : now;
    past.push({ kind: "failed", date: new Date(t).toISOString(), amount: Number(s.outstanding ?? plan.price).toFixed(2) });
  }
  past.sort((a, b) => a.date.localeCompare(b.date));

  const upcoming: Stamp[] = [];
  const ended = s.status === "CANCELLED" || Boolean(s.cancel_requested_at);
  if (!ended && (s.status === "ACTIVE" || s.status === "SUSPENDED")) {
    let t: number | null = null;
    if (s.status === "ACTIVE" && s.next_billing_time) t = s.next_billing_time.getTime();
    else if (s.status === "SUSPENDED" && s.resume_at) t = s.resume_at.getTime() - 3600_000 + iv;
    const lastScheduled = past.filter((x) => x.scheduled).map((x) => new Date(x.date).getTime()).sort().pop();
    if (t !== null && lastScheduled && t <= lastScheduled) t = lastScheduled + iv;
    const want = Math.max(2, SLOTS - Math.min(past.length, SLOTS - 2));
    for (let i = 0; t !== null && i < want; i++, t += iv) {
      const promo = s.promo_until && t < s.promo_until.getTime();
      upcoming.push({ kind: "upcoming", date: new Date(t).toISOString(), amount: (promo ? plan.price : homePrice).toFixed(2), next: i === 0 || undefined });
    }
  }
  const room = SLOTS - upcoming.length;
  const stamps = [...past.slice(Math.max(0, past.length - room)), ...upcoming];
  const end = s.status === "CANCELLED"
    ? { kind: "cancelled" as const, date: s.cancelled_at ? s.cancelled_at.toISOString() : null }
    : s.cancel_requested_at
      ? { kind: "cancel_pending" as const, date: new Date(s.cancel_requested_at).toISOString() }
      : null;
  return { stamps, end, every };
}
