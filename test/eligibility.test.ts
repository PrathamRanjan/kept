import { describe, expect, it } from "vitest";
import { eligibleOffers, PlanLite } from "../src/policy/eligibility.js";
import { DEFAULT_RULES, Rules } from "../src/policy/rules.js";

const plans: PlanLite[] = [
  { id: "reg", name: "Signature", kind: "regular", price: 24, base_plan_id: null, discount_percent: null, interval_unit: "MONTH", interval_count: 1, active: true },
  { id: "lite", name: "Lite", kind: "lite", price: 12, base_plan_id: null, discount_percent: null, interval_unit: "MONTH", interval_count: 1, active: true },
  { id: "promo", name: "Signature (15% off)", kind: "promo", price: 20.4, base_plan_id: "reg", discount_percent: 15, interval_unit: "MONTH", interval_count: 1, active: true },
];
const rules: Rules = { ...DEFAULT_RULES, skip: { enabled: true, maxPerPeriod: 1, periodDays: 90 }, pause: { enabled: true, maxCycles: 2 }, switchToLite: { enabled: true }, discount: { enabled: true, percent: 15, cycles: 3 }, maxDiscountPercent: 15, minTenureDaysForDiscount: 60 };
const base = { rules, plans, skipsAt: [], lastOfferAcceptedAt: null, subscriber: { status: "ACTIVE", plan_id: "reg", home_plan_id: "reg", started_at: new Date(Date.now() - 100 * 864e5) } };

describe("eligible offers", () => {
  it("lists every permitted option", () => {
    expect(eligibleOffers(base).map((o) => o.type).sort()).toEqual(["discount", "pause", "skip", "switch_plan"]);
  });
  it("respects tenure for discounts", () => {
    const o = eligibleOffers({ ...base, subscriber: { ...base.subscriber, started_at: new Date() } });
    expect(o.some((x) => x.type === "discount")).toBe(false);
  });
  it("respects the skip allowance", () => {
    const o = eligibleOffers({ ...base, skipsAt: [new Date(Date.now() - 10 * 864e5)] });
    expect(o.some((x) => x.type === "skip")).toBe(false);
  });
  it("respects the cooldown", () => {
    expect(eligibleOffers({ ...base, lastOfferAcceptedAt: new Date(Date.now() - 864e5) })).toEqual([]);
  });
  it("never stacks on a discount and offers nothing to cancelled subscriptions", () => {
    expect(eligibleOffers({ ...base, subscriber: { ...base.subscriber, plan_id: "promo" } })).toEqual([]);
    expect(eligibleOffers({ ...base, subscriber: { ...base.subscriber, status: "CANCELLED" } })).toEqual([]);
  });
  it("does not offer the lighter plan to someone already on it", () => {
    const o = eligibleOffers({ ...base, subscriber: { ...base.subscriber, plan_id: "lite", home_plan_id: "lite" } });
    expect(o.some((x) => x.type === "switch_plan")).toBe(false);
  });
});
