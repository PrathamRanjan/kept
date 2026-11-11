/**
 * Spec K3: the owner's Ask reads a list of facts in plain words, not the raw statistics object. Field names
 * like `sampleRows` never reach the model, so they cannot come back in an answer; code then checks the answer
 * anyway (see `codeLikeTokens`).
 *
 * Every number here is computed by code from the shop's own rows. Sample members (labelled demo history) are
 * always named as such and kept apart from what PayPal confirms.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import type { ShopStats } from "../brain/types.js";
import { guardSettings } from "../guard/dryrun.js";
import { eligibleOffers } from "../policy/eligibility.js";
import { describeRules } from "../policy/rules.js";
import { currentPolicy, intervalWords, plansFor, subscribersFor, type Merchant } from "../store.js";

const REASON_LABEL: Record<string, string> = {
  price: "cost",
  too_much: "too much product",
  away: "away or moving",
  quality: "quality",
  competitor: "switching to another seller",
  no_need: "no longer needed",
  payment: "payment trouble",
  other: "other or no reason",
};
const PER_MONTH: Record<string, number> = { DAY: 365.25 / 12, WEEK: 365.25 / 12 / 7, MONTH: 1, YEAR: 1 / 12 };

type Stats = ShopStats & { collected30: number; offersExpired: number; sampleRows: number; live: { active: number; suspended: number; mrr: number; revenueKept3: number; offersMade: number; offersAccepted: number; cancelsHonoured: number; agentShare: number; reasonsTotal: number } };

export async function shopFacts(m: Merchant, stats: Stats, q?: Queryable): Promise<string[]> {
  const db = q ?? (await getDb());
  const cur = (n: number) => `${n.toFixed(2)} ${m.currency}`;
  const subs = await subscribersFor(db, m.id);
  const plans = await plansFor(db, m.id, true);
  const policy = await currentPolicy(db, m.id);
  const real = subs.filter((s) => !s.is_sample);
  const sample = subs.filter((s) => s.is_sample);
  const n = (list: typeof subs, st: string) => list.filter((s) => s.status === st).length;
  const out: string[] = [];

  out.push(`Shop: ${m.name}. Prices are in ${m.currency}.`);
  out.push(`Real members (each a PayPal subscription): ${n(real, "ACTIVE")} active, ${n(real, "SUSPENDED")} paused, ${n(real, "CANCELLED")} cancelled.`);
  if (sample.length) out.push(`Sample members (labelled demo history with no PayPal subscription; never part of any PayPal-confirmed figure): ${n(sample, "ACTIVE")} active, ${n(sample, "SUSPENDED")} paused, ${n(sample, "CANCELLED")} cancelled.`);
  out.push(`Monthly recurring revenue from real active members: ${cur(stats.live.mrr)}.${sample.length ? ` Including sample members it would be ${cur(stats.mrr)}; the difference is not real money.` : ""}`);
  out.push(`Collected in the last 30 days, as reported by PayPal: ${cur(stats.collected30)}.`);
  out.push(`Retention offers to real members: ${stats.live.offersMade} made, ${stats.live.offersAccepted} accepted; revenue those accepted offers keep over three billing cycles: ${cur(stats.live.revenueKept3)}.${sample.length ? ` Sample history adds ${stats.offersMade - stats.live.offersMade} offers made and ${stats.offersAccepted - stats.live.offersAccepted} accepted.` : ""}`);
  out.push(`Cancellations Kept has carried out for real members: ${stats.live.cancelsHonoured}. Every cancel request is carried out; none is blocked.`);
  out.push(`Share of real member actions made by members' AI assistants: ${stats.live.agentShare}%.`);
  if (stats.reasons.length) {
    const fb = (await db.query<{ category: string; is_sample: boolean; c: number }>("SELECT category, is_sample, count(*)::int AS c FROM feedback WHERE merchant_id = $1 GROUP BY category, is_sample", [m.id])).rows;
    const line = (s: boolean) =>
      fb
        .filter((r) => r.is_sample === s)
        .sort((a, b) => b.c - a.c)
        .map((r) => `${REASON_LABEL[r.category] ?? r.category} ${r.c}`)
        .join(", ");
    const realLine = line(false);
    const sampleLine = line(true);
    out.push(`Reasons real members gave when cancelling or pausing: ${realLine || "none yet"}.`);
    if (sampleLine) out.push(`Reasons in the sample history: ${sampleLine}.`);
  }
  const failing = real.filter((s) => s.kept_state === "payment_failed");
  out.push(failing.length ? `Real members with a failed payment: ${failing.map((s) => `${s.subscriber_name ?? "a member"} owes ${cur(Number(s.outstanding))}`).join("; ")}.` : "No real member has a failed payment.");
  out.push(`Active members (real and sample) renewing in the next 7 days: ${stats.upcomingRenewals7d}.`);

  for (const p of plans.filter((x) => x.active !== false && x.kind !== "promo")) {
    const perMonth = (Number(p.price) * (PER_MONTH[p.interval_unit] ?? 1)) / Math.max(1, p.interval_count || 1);
    const on = subs.filter((s) => s.plan_id === p.id && s.status === "ACTIVE");
    out.push(`Plan "${p.name}": ${cur(Number(p.price))} ${intervalWords(p)} (about ${cur(perMonth)} a month); active on it: ${on.filter((s) => !s.is_sample).length} real, ${on.filter((s) => s.is_sample).length} sample.`);
  }

  if (!policy) {
    out.push("The shop has no retention rules yet, so no member can be made an offer.");
    return out;
  }
  out.push(`The shop's retention rules: ${describeRules(policy.rules).join(" ")}`);
  // Who the rules allow an offer to right now, computed by the same code the cancel flow uses.
  const settings = await guardSettings(m.id, db);
  const accepted = (await db.query<{ subscriber_id: string; at: Date }>("SELECT subscriber_id, max(decided_at) AS at FROM offers WHERE merchant_id = $1 AND status = 'accepted' GROUP BY subscriber_id", [m.id])).rows;
  const skips = (await db.query<{ subscriber_id: string; at: Date }>("SELECT subscriber_id, created_at AS at FROM event_log WHERE merchant_id = $1 AND type = 'skip.scheduled'", [m.id])).rows;
  const eligible = { real: [] as string[], sample: 0, byType: new Map<string, number>() };
  for (const s of subs.filter((x) => x.status === "ACTIVE" || x.status === "SUSPENDED")) {
    const last = accepted.find((a) => a.subscriber_id === s.id)?.at;
    const offers = eligibleOffers({
      rules: policy.rules,
      subscriber: { status: s.status, plan_id: s.plan_id, home_plan_id: s.home_plan_id, started_at: s.started_at },
      plans,
      skipsAt: skips.filter((k) => k.subscriber_id === s.id).map((k) => new Date(k.at)),
      lastOfferAcceptedAt: last ? new Date(last) : null,
      maxPauseCycles: settings.auto_pause_max_cycles,
    });
    if (!offers.length) continue;
    if (s.is_sample) eligible.sample++;
    else eligible.real.push(s.subscriber_name ?? "a member");
    for (const o of offers) eligible.byType.set(o.label, (eligible.byType.get(o.label) ?? 0) + 1);
  }
  out.push(`Members the rules allow an offer to today, if they asked to cancel: ${eligible.real.length} real${eligible.real.length ? ` (${eligible.real.slice(0, 10).join(", ")})` : ""} and ${eligible.sample} sample.`);
  if (eligible.byType.size) out.push(`Offers those members could be shown: ${[...eligible.byType.entries()].map(([k, v]) => `${k} for ${v}`).join("; ")}.`);
  out.push("Which offers a member may get depends on their tenure, the offer cooldown, their plan and their status, not on the plan's price; a price change alters what a discount is worth, not who is offered one. Kept has not modelled how members would react to a price change.");
  return out;
}

/** Backticks, camelCase and snake_case words: signs that code leaked into an answer meant for a person. */
const ALLOWED = new Set(["iPhone", "iPad", "eBay", "macOS", "iOS", "PayPal", "YouTube", "WhatsApp"]);
export function codeLikeTokens(text: string): string[] {
  const hits: string[] = [];
  if (text.includes("`")) hits.push("`");
  for (const w of text.match(/\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) ?? []) if (!ALLOWED.has(w)) hits.push(w);
  for (const w of text.match(/\b[a-z0-9]+_[a-z0-9_]+\b/g) ?? []) hits.push(w);
  return hits;
}
