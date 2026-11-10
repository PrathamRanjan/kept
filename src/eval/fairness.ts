/**
 * Fairness scorecard (roadmap K6), measured from the shop's own event log for its real (non-sample) members:
 * one-call cancel rate, offers made versus accepted, time from cancel request to PayPal's confirmed cancel.
 */
import { getDb } from "../db.js";

export interface Fairness {
  cancels: number;
  one_call_cancel_rate: number;
  offers_made: number;
  offers_accepted: number;
  offers_declined_or_expired: number;
  median_seconds_to_cancel: number | null;
  p95_seconds_to_cancel: number | null;
  compliance_blocked_offers: number;
  held_offers: number;
}

export async function fairness(merchantId: string): Promise<Fairness> {
  const db = await getDb();
  const cancels = (await db.query<any>("SELECT subscriber_id, created_at FROM event_log WHERE merchant_id = $1 AND type = 'subscription.cancelled' AND subscriber_id IN (SELECT id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample) ORDER BY id", [merchantId])).rows;
  const requests = (await db.query<any>("SELECT subscriber_id, min(created_at) AS at FROM event_log WHERE merchant_id = $1 AND type IN ('offer.made','offer.none','offer.held','offer.blocked','cancel.pending','subscription.cancelled') AND subscriber_id IN (SELECT id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample) GROUP BY subscriber_id", [merchantId])).rows;
  const firstReq = new Map<string, number>(requests.map((r: any) => [r.subscriber_id, new Date(r.at).getTime()]));
  const durations = cancels.map((c: any) => (new Date(c.created_at).getTime() - (firstReq.get(c.subscriber_id) ?? new Date(c.created_at).getTime())) / 1000).sort((a: number, b: number) => a - b);
  const offers = (await db.query<{ status: string; c: string }>("SELECT status, count(*) AS c FROM offers WHERE merchant_id = $1 AND subscriber_id IN (SELECT id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample) GROUP BY status", [merchantId])).rows;
  const n = (st: string) => Number(offers.find((o) => o.status === st)?.c ?? 0);
  const pending = Number((await db.query<{ c: string }>("SELECT count(*) AS c FROM event_log WHERE merchant_id = $1 AND type = 'cancel.pending' AND subscriber_id IN (SELECT id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample)", [merchantId])).rows[0].c);
  const blocked = Number((await db.query<{ c: string }>("SELECT count(*) AS c FROM event_log WHERE merchant_id = $1 AND type = 'offer.blocked' AND subscriber_id IN (SELECT id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample)", [merchantId])).rows[0].c);
  const held = Number((await db.query<{ c: string }>("SELECT count(*) AS c FROM event_log WHERE merchant_id = $1 AND type = 'offer.held' AND subscriber_id IN (SELECT id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample)", [merchantId])).rows[0].c);
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
  return {
    cancels: cancels.length,
    // A cancel that PayPal did not confirm on the first call shows as cancel.pending first; every other cancel was one call.
    one_call_cancel_rate: cancels.length ? pct(Math.max(0, cancels.length - pending), cancels.length) : 100,
    offers_made: n("open") + n("accepted") + n("declined") + n("expired"),
    offers_accepted: n("accepted"),
    offers_declined_or_expired: n("declined") + n("expired"),
    median_seconds_to_cancel: durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : null,
    p95_seconds_to_cancel: durations.length ? Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]) : null,
    compliance_blocked_offers: blocked,
    held_offers: held,
  };
}
