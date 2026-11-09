import { z } from "zod";

/**
 * A merchant's retention rules. The brain drafts these from plain words; this schema and
 * `validateRules` decide whether they are allowed; the owner approves the exact version.
 */
export const RulesSchema = z.object({
  skip: z.object({
    enabled: z.boolean(),
    maxPerPeriod: z.number().int().min(1).max(12),
    periodDays: z.number().int().min(7).max(366),
  }),
  pause: z.object({
    enabled: z.boolean(),
    maxCycles: z.number().int().min(1).max(6),
  }),
  switchToLite: z.object({ enabled: z.boolean() }),
  discount: z.object({
    enabled: z.boolean(),
    percent: z.number().int().min(1).max(50),
    cycles: z.number().int().min(1).max(12),
  }),
  maxDiscountPercent: z.number().int().min(0).max(50),
  minTenureDaysForDiscount: z.number().int().min(0).max(730),
  offerCooldownDays: z.number().int().min(0).max(730),
  offerExpiryMinutes: z.number().int().min(5).max(10080),
  /** Not configurable. Kept never makes cancelling conditional on hearing or accepting an offer. */
  neverBlockCancel: z.literal(true),
  /** Not configurable either: one optional offer, never a sequence (compliance rule KEPT-OFFER). */
  offersBeforeCancel: z.literal(1).default(1),
  /** Days before a renewal to remind the subscriber (0 = no reminder). Annual plans need one in most US states. */
  renewalReminderDays: z.number().int().min(0).max(60).default(7),
  /** The jurisdiction the owner's policy is scored against on the compliance page. */
  jurisdiction: z.enum(["US_FEDERAL", "US_CA", "US_CO", "US_NY", "EU", "UK"]).default("US_FEDERAL"),
});

export type Rules = z.infer<typeof RulesSchema>;

export const DEFAULT_RULES: Rules = {
  skip: { enabled: false, maxPerPeriod: 1, periodDays: 90 },
  pause: { enabled: false, maxCycles: 1 },
  switchToLite: { enabled: false },
  discount: { enabled: false, percent: 10, cycles: 1 },
  maxDiscountPercent: 0,
  minTenureDaysForDiscount: 0,
  offerCooldownDays: 180,
  offerExpiryMinutes: 60,
  neverBlockCancel: true,
  offersBeforeCancel: 1,
  renewalReminderDays: 7,
  jurisdiction: "US_FEDERAL",
};

export interface RulesCheck {
  ok: boolean;
  rules?: Rules;
  errors: string[];
}

export function validateRules(input: unknown): RulesCheck {
  const parsed = RulesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "rules"}: ${i.message}`) };
  }
  const r = parsed.data;
  const errors: string[] = [];
  if (r.discount.enabled && r.discount.percent > r.maxDiscountPercent) {
    errors.push(`Discount of ${r.discount.percent}% is above the ${r.maxDiscountPercent}% maximum you set.`);
  }
  if (r.discount.enabled && r.maxDiscountPercent === 0) errors.push("A discount is enabled but the maximum discount is 0%.");
  return errors.length ? { ok: false, errors } : { ok: true, rules: r, errors: [] };
}

/** Plain-English lines describing approved rules, shown to owners and returned to agents. */
export function describeRules(r: Rules): string[] {
  const out: string[] = [];
  if (r.skip.enabled) out.push(`Skip up to ${r.skip.maxPerPeriod} renewal${r.skip.maxPerPeriod > 1 ? "s" : ""} every ${r.skip.periodDays} days.`);
  if (r.pause.enabled) out.push(`Pause for up to ${r.pause.maxCycles} billing cycle${r.pause.maxCycles > 1 ? "s" : ""}.`);
  if (r.switchToLite.enabled) out.push("Switch to the lighter plan at any time.");
  if (r.discount.enabled) {
    out.push(`A ${r.discount.percent}% discount for ${r.discount.cycles} cycle${r.discount.cycles > 1 ? "s" : ""}` + (r.minTenureDaysForDiscount ? ` for subscribers of at least ${r.minTenureDaysForDiscount} days.` : "."));
  }
  out.push(`At most one retention offer per subscriber every ${r.offerCooldownDays} days; offers expire after ${r.offerExpiryMinutes} minutes.`);
  if ((r.renewalReminderDays ?? 0) > 0) out.push(`A renewal reminder ${r.renewalReminderDays} days before each charge, with one-tap skip where skips are allowed.`);
  out.push("Cancelling always works in one step. Hearing an offer is optional and never required.");
  return out;
}
