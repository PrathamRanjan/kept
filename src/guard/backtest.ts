/**
 * Policy backtest and earned autonomy (roadmap K3, B.6). Replays 90 days of seeded cancellation requests through
 * a candidate policy and the owner's autonomy limits: how many would have got an offer automatically (run), how
 * many would have been held for the owner (wait), how many got nothing (deny), and the money kept versus held.
 * What-if sliders change the discount percent and pause length before the owner adopts anything. Earned autonomy
 * suggests limits from the owner's own approvals and never past anything they declined.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";
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

/** Deterministic 90-day sample: 36 cancellation requests with a labelled reason and what happened. */
export async function seedHistory(merchantId: string, planPrice: number, q?: Queryable) {
  const db = q ?? (await getDb());
  const n = Number((await db.query<{ c: string }>("SELECT count(*) AS c FROM subscription_history WHERE merchant_id = $1", [merchantId])).rows[0].c);
  if (n) return n;
  const reasons: [string, ReasonCategory, string | null, boolean][] = [
    ["too much coffee piling up", "too_much", "skip", true], ["money is tight this month", "price", "discount", true], ["travelling for six weeks", "away", "pause", true],
    ["the last bag tasted stale", "quality", null, true], ["switching to a cheaper roaster", "competitor", "discount", false], ["cutting down on caffeine", "no_need", null, true],
    ["too expensive right now", "price", "switch_plan", true], ["still have two bags unopened", "too_much", "skip", true], ["moving house next month", "away", "pause", true],
    ["", "other", null, true], ["card got declined twice", "payment", null, true], ["grinder broke, taking a break", "no_need", "pause", true],
    ["found a local subscription for less", "competitor", null, false], ["we drink less in summer", "too_much", "skip", true], ["budget cuts at home", "price", "discount", true],
    ["beans arrived late twice", "quality", null, true], ["going abroad for work", "away", "pause", true], ["just don't need it", "no_need", null, true],
  ];
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const now = Date.now();
  for (let i = 0; i < 36; i++) {
    const [reason, category, accepted, approve] = reasons[i % reasons.length];
    const at = new Date(now - Math.floor(rand() * 90) * 864e5 - Math.floor(rand() * 86400) * 1000);
    const heard = rand() < 0.65;
    await db.query("INSERT INTO subscription_history (id, merchant_id, at, subscriber, plan_price, tenure_days, reason, category, heard_offer, accepted_type, owner_would_approve) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      newId("hist"), merchantId, at, `Subscriber ${i + 1}`, (planPrice * (rand() < 0.3 ? 0.5 : 1)).toFixed(2), Math.floor(rand() * 400), reason, category, heard, heard ? accepted : null, approve,
    ]);
  }
  return 36;
}

export async function history(merchantId: string, q?: Queryable): Promise<HistoryRow[]> {
  const db = q ?? (await getDb());
  return (await db.query<any>("SELECT * FROM subscription_history WHERE merchant_id = $1 ORDER BY at", [merchantId])).rows.map((r) => ({ ...r, at: new Date(r.at), plan_price: Number(r.plan_price), tenure_days: Number(r.tenure_days) }));
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

/** Plans the backtest assumes: the shop's real plans if given, else a regular, a lite and a promo at the rule's percent. */
function syntheticPlans(rules: Rules, price: number): PlanLite[] {
  const promoPrice = Math.round(price * (100 - rules.discount.percent)) / 100;
  return [
    { id: "regular", name: "Regular", kind: "regular", price, base_plan_id: null, discount_percent: null, interval_unit: "MONTH", interval_count: 1, active: true },
    { id: "lite", name: "Lite", kind: "lite", price: Math.round(price * 50) / 100, base_plan_id: null, discount_percent: null, interval_unit: "MONTH", interval_count: 1, active: true },
    { id: "promo", name: `Regular (${rules.discount.percent}% off)`, kind: "promo", price: promoPrice, base_plan_id: "regular", discount_percent: rules.discount.percent, interval_unit: "MONTH", interval_count: 1, active: true },
  ];
}

export async function backtest(merchantId: string, rules: Rules, overrides: Partial<GuardSettings> = {}, q?: Queryable): Promise<Backtest> {
  const db = q ?? (await getDb());
  const rows = await history(merchantId, db);
  const settings = { ...(await guardSettings(merchantId, db)), ...overrides };
  const compliance = scoreCompliance(rules, rules.jurisdiction ?? "US_FEDERAL");
  const blocked = compliance.rules.filter((r) => r.status === "fail");
  const out: Backtest = { cases: rows.length, run: 0, wait: 0, deny: 0, kept_auto_usd: 0, held_usd: 0, cancels_without_offer: 0, compliance_blocked: 0, rows: [], settings };
  for (const h of rows) {
    const plans = syntheticPlans(rules, h.plan_price);
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
    const eligible = eligibleOffers({ rules, subscriber: { status: "ACTIVE", plan_id: "regular", home_plan_id: "regular", started_at: new Date(h.at.getTime() - h.tenure_days * 864e5) }, plans, skipsAt: [], lastOfferAcceptedAt: null, now: h.at });
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
    out.push({ field: "auto_discount_max_pct", current: cur.auto_discount_max_pct, suggested: 15, basis: `${histPct} discounts in the sample history were ones you would have approved; no approvals of your own yet, so the suggestion is modest` });
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
