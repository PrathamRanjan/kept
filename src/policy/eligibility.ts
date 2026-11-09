import { Rules } from "./rules.js";

export type OfferType = "pause" | "skip" | "switch_plan" | "discount";

export interface PlanLite {
  id: string;
  name: string;
  kind: "regular" | "lite" | "promo";
  price: number;
  base_plan_id: string | null;
  discount_percent: number | null;
  interval_unit: string;
  interval_count: number;
  active: boolean;
}

export interface EligibilityInput {
  rules: Rules;
  subscriber: {
    status: string;
    plan_id: string | null;
    home_plan_id: string | null;
    started_at: Date | null;
  };
  plans: PlanLite[];
  /** Times this subscriber skipped a renewal, newest first. */
  skipsAt: Date[];
  /** When this subscriber last accepted any retention offer. */
  lastOfferAcceptedAt: Date | null;
  /** The owner's autonomy limit for pauses the offer step may give without asking (guard settings). */
  maxPauseCycles?: number;
  now?: Date;
}

export interface EligibleOffer {
  key: string;
  type: OfferType;
  terms: { cycles?: number; toPlanId?: string; toPlanName?: string; percent?: number; newPrice?: number };
  /** Revenue per billing cycle this offer keeps if accepted (0 for a pause or a skip). */
  perCycleValue: number;
  /** Revenue Kept expects to keep over the next 3 cycles compared with an immediate cancel. */
  keptValue3: number;
  label: string;
}

/**
 * Deterministic: which offers the merchant's rules allow for this subscriber right now.
 * The brain may only choose among these. An empty list means "cancel without an offer".
 */
export function eligibleOffers(input: EligibilityInput): EligibleOffer[] {
  const now = input.now ?? new Date();
  const { rules, subscriber, plans } = input;
  if (!["ACTIVE", "SUSPENDED"].includes(subscriber.status)) return [];
  if (input.lastOfferAcceptedAt && now.getTime() - input.lastOfferAcceptedAt.getTime() < rules.offerCooldownDays * 864e5) return [];

  const current = plans.find((p) => p.id === subscriber.plan_id);
  if (!current) return [];
  const home = plans.find((p) => p.id === (subscriber.home_plan_id ?? current.base_plan_id ?? current.id)) ?? current;
  // A subscriber already on a promo or paused gets no stacked offers.
  if (current.kind === "promo") return [];

  const out: EligibleOffer[] = [];
  const price = current.price;

  // Offer the longest pause the rules allow that the owner also lets Kept give on its own; a longer one would
  // only be held for approval while the subscriber waits, and the cancel would go ahead with no offer at all.
  const pauseCycles = Math.min(rules.pause.maxCycles, input.maxPauseCycles ?? rules.pause.maxCycles);
  if (rules.pause.enabled && subscriber.status === "ACTIVE" && pauseCycles >= 1) {
    const cycles = pauseCycles;
    out.push({
      key: `pause_${cycles}`,
      type: "pause",
      terms: { cycles },
      perCycleValue: 0,
      keptValue3: price * Math.max(0, 3 - cycles),
      label: `Pause for ${cycles} billing cycle${cycles > 1 ? "s" : ""}, then continue as before`,
    });
  }

  if (rules.skip.enabled && subscriber.status === "ACTIVE") {
    const since = now.getTime() - rules.skip.periodDays * 864e5;
    const used = input.skipsAt.filter((d) => d.getTime() >= since).length;
    if (used < rules.skip.maxPerPeriod) {
      out.push({ key: "skip_1", type: "skip", terms: { cycles: 1 }, perCycleValue: 0, keptValue3: price * 2, label: "Skip the next renewal only" });
    }
  }

  if (rules.switchToLite.enabled) {
    const lite = plans
      .filter((p) => p.active && p.kind === "lite" && p.price < price && p.interval_unit === current.interval_unit && p.interval_count === current.interval_count)
      .sort((a, b) => b.price - a.price)[0];
    if (lite && lite.id !== current.id) {
      out.push({
        key: `switch_${lite.id}`,
        type: "switch_plan",
        terms: { toPlanId: lite.id, toPlanName: lite.name, newPrice: lite.price },
        perCycleValue: lite.price,
        keptValue3: lite.price * 3,
        label: `Switch to ${lite.name} at ${lite.price.toFixed(2)} per cycle`,
      });
    }
  }

  if (rules.discount.enabled) {
    const tenureDays = subscriber.started_at ? (now.getTime() - subscriber.started_at.getTime()) / 864e5 : 0;
    const promo = plans.find((p) => p.active && p.kind === "promo" && p.base_plan_id === home.id && p.discount_percent === rules.discount.percent);
    if (promo && tenureDays >= rules.minTenureDaysForDiscount && rules.discount.percent <= rules.maxDiscountPercent) {
      const cycles = rules.discount.cycles;
      out.push({
        key: `discount_${rules.discount.percent}_${cycles}`,
        type: "discount",
        terms: { toPlanId: promo.id, toPlanName: promo.name, percent: rules.discount.percent, cycles, newPrice: promo.price },
        perCycleValue: promo.price,
        keptValue3: promo.price * Math.min(3, cycles) + home.price * Math.max(0, 3 - cycles),
        label: `${rules.discount.percent}% off for ${cycles} cycle${cycles > 1 ? "s" : ""} (${promo.price.toFixed(2)}), then back to ${home.price.toFixed(2)}`,
      });
    }
  }

  return out;
}

/** Money helpers: always 2 decimals as a string for PayPal. */
export function money(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function discountedPrice(price: number, percent: number): number {
  return Math.round(price * (100 - percent)) / 100;
}
