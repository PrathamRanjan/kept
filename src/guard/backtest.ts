/**
 * Policy backtest and earned autonomy (roadmap K3, B.6). Replays the shop's real cancellation requests from the last 90 days through
 * a candidate policy and the owner's autonomy limits: how many would have got an offer automatically (run), how
 * many would have been held for the owner (wait), how many got nothing (deny), and the money kept versus held.
 * What-if sliders change the discount percent and pause length before the owner adopts anything. Earned autonomy
 * suggests limits from the owner's own approvals and never past anything they declined.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { plansFor, type Plan } from "../store.js";
import { LocalBrain } from "../brain/local.js";
import type { ReasonCategory } from "../brain/types.js";
import { eligibleOffers, type PlanLite } from "../policy/eligibility.js";
import { scoreCompliance } from "../policy/compliance.js";
import type { Rules } from "../policy/rules.js";
import { guardSettings, saveGuardSettings, type GuardSettings } from "./dryrun.js";

export interface HistoryRow {
  id: string;
  at: Date;
  subscriber: string;
  plan_price: number;
  tenure_days: number;
  reason: string;
  category: ReasonCategory;
  heard_offer: boolean;
  accepted_type: string | null;
  owner_would_approve: boolean;
}

const picker = new LocalBrain();

/**
 * The shop's real cancellation requests in the last 90 days, from its own records: every live (non-sample)
 * member who asked to cancel or asked to hear an offer, with their reason, whether they heard an offer, and
 * what they accepted. Nothing is invented; a new shop simply has an empty history.
 */
export async function history(merchantId: string, q?: Queryable): Promise<HistoryRow[]> {
  const db = q ?? (await getDb());
  const rows = (
    await db.query<any>(
      `SELECT s.id, s.subscriber_name, s.started_at, s.cancelled_at, p.price,
         (SELECT f.text FROM feedback f WHERE f.subscriber_id = s.id ORDER BY f.created_at LIMIT 1) AS reason,
         (SELECT f.category FROM feedback f WHERE f.subscriber_id = s.id ORDER BY f.created_at LIMIT 1) AS fb_category,
         (SELECT min(e.created_at) FROM event_log e WHERE e.subscriber_id = s.id AND e.type IN ('offer.made','offer.none','offer.held','offer.blocked','cancel.pending','subscription.cancelled')) AS asked_at,
         (SELECT count(*) FROM event_log e WHERE e.subscriber_id = s.id AND e.type IN ('offer.made','offer.none','offer.held','offer.blocked')) AS heard,
         (SELECT o.reason_category FROM offers o WHERE o.subscriber_id = s.id ORDER BY o.created_at LIMIT 1) AS offer_category,
         (SELECT o.type FROM offers o WHERE o.subscriber_id = s.id AND o.status = 'accepted' ORDER BY o.created_at LIMIT 1) AS accepted_type
       FROM subscribers s LEFT JOIN plans p ON p.id = COALESCE(s.home_plan_id, s.plan_id)
       WHERE s.merchant_id = $1 AND NOT s.is_sample`,
      [merchantId],
    )
  ).rows;
  const since = Date.now() - 90 * 864e5;
  return rows
    .filter((r) => r.asked_at && new Date(r.asked_at).getTime() >= since)
    .map((r) => ({
      id: r.id,
      at: new Date(r.asked_at),
      subscriber: r.subscriber_name ?? "Member",
      plan_price: Number(r.price ?? 0),
      tenure_days: Math.max(0, Math.floor((new Date(r.asked_at).getTime() - new Date(r.started_at ?? r.asked_at).getTime()) / 864e5)),
      reason: r.reason ?? "",
      category: (r.fb_category ?? r.offer_category ?? "other") as ReasonCategory,
      heard_offer: Number(r.heard) > 0,
      accepted_type: r.accepted_type ?? null,
      owner_would_approve: true,
    }))
    .sort((x, y) => x.at.getTime() - y.at.getTime());
}

export interface BacktestRow {
  at: string;
  subscriber: string;
  reason: string;
  category: ReasonCategory;
  outcome: "run" | "wait" | "deny";
  offer: string | null;
  kept_usd: number;
  note: string;
}
export interface Backtest {
  cases: number;
  run: number;
  wait: number;
  deny: number;
  kept_auto_usd: number;
  held_usd: number;
  cancels_without_offer: number;
  compliance_blocked: number;
  rows: BacktestRow[];
  settings: GuardSettings;
}

/**
 * The shop's real PayPal plans. A what-if discount percent the shop has no promo plan for yet gets the price that
 * plan would have (the regular price less that percent), so the owner can see the effect before adopting it.
 */
function plansForBacktest(real: Plan[], rules: Rules, homeId: string | undefined): PlanLite[] {
  const lite: PlanLite[] = real.map((p) => ({ id: p.id, name: p.name, kind: p.kind, price: Number(p.price), base_plan_id: p.base_plan_id, discount_percent: p.discount_percent, interval_unit: p.interval_unit, interval_count: p.interval_count, active: p.active }));
  const home = lite.find((p) => p.id === homeId) ?? lite.find((p) => p.kind === "regular");
  if (home && rules.discount.enabled && !lite.some((p) => p.kind === "promo" && p.base_plan_id === home.id && p.discount_percent === rules.discount.percent)) {
    lite.push({ id: `whatif-${home.id}`, name: `${home.name} (${rules.discount.percent}% off)`, kind: "promo", price: Math.round(home.price * (100 - rules.discount.percent)) / 100, base_plan_id: home.id, discount_percent: rules.discount.percent, interval_unit: home.interval_unit, interval_count: home.interval_count, active: true });
  }
  return lite;
}

export async function backtest(merchantId: string, rules: Rules, overrides: Partial<GuardSettings> = {}, q?: Queryable): Promise<Backtest> {
  const db = q ?? (await getDb());
  const rows = await history(merchantId, db);
  const real = await plansFor(db, merchantId, true);
  const homeOf = new Map((await db.query<any>("SELECT id, COALESCE(home_plan_id, plan_id) AS home FROM subscribers WHERE merchant_id = $1", [merchantId])).rows.map((r: any) => [r.id, r.home as string]));
  const settings = { ...(await guardSettings(merchantId, db)), ...overrides };
  const compliance = scoreCompliance(rules, rules.jurisdiction ?? "US_FEDERAL");
  const blocked = compliance.rules.filter((r) => r.status === "fail");
  const out: Backtest = { cases: rows.length, run: 0, wait: 0, deny: 0, kept_auto_usd: 0, held_usd: 0, cancels_without_offer: 0, compliance_blocked: 0, rows: [], settings };
  for (const h of rows) {
    const home = homeOf.get(h.id);
    const plans = plansForBacktest(real, rules, home);
    const homeId = plans.find((p) => p.id === home)?.id ?? plans.find((p) => p.kind === "regular")?.id ?? "";
    const row: BacktestRow = { at: h.at.toISOString().slice(0, 10), subscriber: h.subscriber, reason: h.reason, category: h.category, outcome: "deny", offer: null, kept_usd: 0, note: "" };
    if (!h.heard_offer) {
      row.note = "did not ask to hear an offer: cancelled in one step";
      out.cancels_without_offer++;
      out.deny++;
      out.rows.push(row);
      continue;
    }
    if (blocked.length) {
      row.note = `compliance rule ${blocked[0].id} fails: no offer may be made`;
      out.compliance_blocked++;
      out.deny++;
      out.rows.push(row);
      continue;
    }
    const eligible = eligibleOffers({ rules, subscriber: { status: "ACTIVE", plan_id: homeId, home_plan_id: homeId, started_at: new Date(h.at.getTime() - h.tenure_days * 864e5) }, plans, skipsAt: [], lastOfferAcceptedAt: null, now: h.at });
    const choice = picker.pickOffer(eligible, h.category);
    const chosen = eligible.find((o) => o.key === choice.key);
    if (!chosen) {
      row.note = choice.rationale;
      out.deny++;
      out.rows.push(row);
      continue;
    }
    row.offer = chosen.label;
    const needsOwner = (chosen.type === "discount" && (chosen.terms.percent ?? 0) > settings.auto_discount_max_pct) || (chosen.type === "pause" && (chosen.terms.cycles ?? 0) > settings.auto_pause_max_cycles);
    // Kept value: the history says whether this subscriber accepted an offer of this type.
    const accepted = h.accepted_type === chosen.type;
    const kept = accepted ? chosen.keptValue3 : 0;
    if (needsOwner) {
      row.outcome = "wait";
      row.kept_usd = kept;
      row.note = `above autonomy (${chosen.type === "discount" ? `${chosen.terms.percent}% > ${settings.auto_discount_max_pct}%` : `${chosen.terms.cycles} cycles > ${settings.auto_pause_max_cycles}`}): no offer unless the owner approves`;
      out.wait++;
      out.held_usd += kept;
    } else {
      row.outcome = "run";
      row.kept_usd = kept;
      row.note = accepted ? "offered automatically and accepted" : "offered automatically; declined, cancel honoured";
      out.run++;
      out.kept_auto_usd += kept;
    }
    out.rows.push(row);
  }
  out.kept_auto_usd = Math.round(out.kept_auto_usd * 100) / 100;
  out.held_usd = Math.round(out.held_usd * 100) / 100;
  return out;
}

export interface Suggestion {
  field: keyof GuardSettings;
  current: number;
  suggested: number;
  basis: string;
}

/** Limits the owner's own decisions support: the largest approved value never declined, per field. */
export async function suggestAutonomy(merchantId: string, q?: Queryable): Promise<Suggestion[]> {
  const db = q ?? (await getDb());
  const cur = await guardSettings(merchantId, db);
  const decided = (await db.query<any>("SELECT action, status, payload FROM approvals WHERE merchant_id = $1 AND status IN ('approved','declined')", [merchantId])).rows.map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
  const hist = await history(merchantId, db);
  const out: Suggestion[] = [];
  const approvedPct = decided.filter((d) => d.status === "approved" && d.payload.offer?.type === "discount").map((d) => Number(d.payload.offer.percent));
  const declinedPct = decided.filter((d) => d.status === "declined" && d.payload.offer?.type === "discount").map((d) => Number(d.payload.offer.percent));
  const histPct = hist.filter((h) => h.accepted_type === "discount" && h.owner_would_approve).length;
  const ceiling = declinedPct.length ? Math.min(...declinedPct) - 1 : 50;
  if (approvedPct.length) {
    const s = Math.min(Math.max(...approvedPct), ceiling);
    if (s > cur.auto_discount_max_pct) out.push({ field: "auto_discount_max_pct", current: cur.auto_discount_max_pct, suggested: s, basis: `you approved ${approvedPct.length} discount${approvedPct.length > 1 ? "s" : ""} up to ${Math.max(...approvedPct)}%${declinedPct.length ? ` and declined one at ${Math.min(...declinedPct)}%` : ""}` });
  } else if (histPct >= 3 && cur.auto_discount_max_pct < 15) {
    out.push({ field: "auto_discount_max_pct", current: cur.auto_discount_max_pct, suggested: 15, basis: `${histPct} discounts in your real cancellation requests were ones you would have approved; no approvals of your own yet, so the suggestion is modest` });
  }
  const approvedCycles = decided.filter((d) => d.status === "approved" && d.payload.offer?.type === "pause").map((d) => Number(d.payload.offer.cycles));
  const declinedCycles = decided.filter((d) => d.status === "declined" && d.payload.offer?.type === "pause").map((d) => Number(d.payload.offer.cycles));
  if (approvedCycles.length) {
    const s = Math.min(Math.max(...approvedCycles), declinedCycles.length ? Math.min(...declinedCycles) - 1 : 6);
    if (s > cur.auto_pause_max_cycles) out.push({ field: "auto_pause_max_cycles", current: cur.auto_pause_max_cycles, suggested: s, basis: `you approved pauses up to ${Math.max(...approvedCycles)} cycles` });
  }
  const approvedCents = decided.filter((d) => d.status === "approved" && ["capture", "invoice"].includes(d.action)).map((d) => Number(d.payload.cents));
  const declinedCents = decided.filter((d) => d.status === "declined" && ["capture", "invoice"].includes(d.action)).map((d) => Number(d.payload.cents));
  if (approvedCents.length) {
    const s = Math.min(Math.max(...approvedCents), declinedCents.length ? Math.min(...declinedCents) - 1 : 1_000_000);
    if (s > cur.approve_capture_above_cents) out.push({ field: "approve_capture_above_cents", current: cur.approve_capture_above_cents, suggested: s, basis: `you approved collections up to ${(Math.max(...approvedCents) / 100).toFixed(2)}` });
  }
  return out;
}

export async function adoptSuggestions(merchantId: string, fields: (keyof GuardSettings)[], by: string) {
  const sugg = await suggestAutonomy(merchantId);
  const patch: Partial<GuardSettings> = {};
  for (const s of sugg) if (fields.includes(s.field)) patch[s.field] = s.suggested;
  if (!Object.keys(patch).length) return guardSettings(merchantId);
  return saveGuardSettings(merchantId, patch, by);
}
