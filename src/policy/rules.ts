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
  /** Spec B5 (7): on cancel, refund the unused part of the current cycle, up to this amount. Code computes it. */
  refundUnused: z.object({ enabled: z.boolean(), maxAmount: z.number().min(0).max(500) }).default({ enabled: false, maxAmount: 0 }),
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
  refundUnused: { enabled: false, maxAmount: 0 },
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
  if (r.refundUnused?.enabled && r.refundUnused.maxAmount > 0) out.push(`If you cancel, the unused part of the current cycle is refunded, up to ${r.refundUnused.maxAmount.toFixed(2)}.`);
  if (r.discount.enabled) {
    out.push(`A ${r.discount.percent}% discount for ${r.discount.cycles} cycle${r.discount.cycles > 1 ? "s" : ""}` + (r.minTenureDaysForDiscount ? ` for subscribers of at least ${r.minTenureDaysForDiscount} days.` : "."));
  }
  out.push(`At most one retention offer per subscriber every ${r.offerCooldownDays} days; offers expire after ${r.offerExpiryMinutes} minutes.`);
  if ((r.renewalReminderDays ?? 0) > 0) out.push(`A renewal reminder ${r.renewalReminderDays} days before each charge, with one-tap skip where skips are allowed.`);
  out.push("Cancelling always works in one step. Hearing an offer is optional and never required.");
  return out;
}

/**
 * Spec B5 "what this loosens": computed by code, never by the model. Every way the new rules give members more
 * than the approved ones (more skips, longer pauses, bigger or longer discounts, discounts sooner, offers more
 * often, longer to decide, a shorter renewal reminder). With no approved rules yet, everything enabled loosens.
 */
/**
 * The most the owner allows back on cancel, read by code from the owner's own words ("refund the unused part of the
 * month, up to $10"). A model may say a refund rule is present; it never supplies the amount (spec 0.2).
 */
export function refundCapFrom(text: string): number | null {
  const m = text.toLowerCase().match(/refund\w*\s+(?:the\s+)?(?:unused|rest|remaining)[^.]*?up to\s*\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Math.min(500, Number(m[1])) : null;
}

export function loosens(before: Rules | null, after: Rules): string[] {
  const b = before ?? DEFAULT_RULES;
  const out: string[] = [];
  const cycles = (n: number) => `${n} cycle${n === 1 ? "" : "s"}`;
  if (after.skip.enabled && !b.skip.enabled) out.push(`Skips are allowed now (up to ${after.skip.maxPerPeriod} every ${after.skip.periodDays} days).`);
  else if (after.skip.enabled && after.skip.maxPerPeriod / after.skip.periodDays > b.skip.maxPerPeriod / b.skip.periodDays) out.push(`More skips: ${b.skip.maxPerPeriod} every ${b.skip.periodDays} days becomes ${after.skip.maxPerPeriod} every ${after.skip.periodDays} days.`);
  if (after.pause.enabled && !b.pause.enabled) out.push(`Pauses are allowed now (up to ${cycles(after.pause.maxCycles)}).`);
  else if (after.pause.enabled && after.pause.maxCycles > b.pause.maxCycles) out.push(`Longer pauses: up to ${cycles(b.pause.maxCycles)} becomes up to ${cycles(after.pause.maxCycles)}.`);
  if (after.switchToLite.enabled && !b.switchToLite.enabled) out.push("Members may switch to the lighter plan now.");
  if (after.discount.enabled && !b.discount.enabled) out.push(`A discount offer is allowed now: ${after.discount.percent}% off for ${cycles(after.discount.cycles)}.`);
  else if (after.discount.enabled) {
    if (after.discount.percent > b.discount.percent) out.push(`Bigger discount: ${b.discount.percent}% becomes ${after.discount.percent}%.`);
    if (after.discount.cycles > b.discount.cycles) out.push(`Longer discount: ${cycles(b.discount.cycles)} becomes ${cycles(after.discount.cycles)}.`);
  }
  if (after.maxDiscountPercent > b.maxDiscountPercent) out.push(`The discount ceiling rises from ${b.maxDiscountPercent}% to ${after.maxDiscountPercent}%.`);
  if (after.discount.enabled && after.minTenureDaysForDiscount < b.minTenureDaysForDiscount) out.push(`Discounts reach newer members: ${b.minTenureDaysForDiscount} days of membership becomes ${after.minTenureDaysForDiscount}.`);
  if (after.offerCooldownDays < b.offerCooldownDays) out.push(`Offers can come more often: one every ${b.offerCooldownDays} days becomes one every ${after.offerCooldownDays} days.`);
  if (after.offerExpiryMinutes > b.offerExpiryMinutes) out.push(`Members get longer to decide on an offer: ${b.offerExpiryMinutes} minutes becomes ${after.offerExpiryMinutes}.`);
  const rb = b.refundUnused ?? { enabled: false, maxAmount: 0 };
  const ra = after.refundUnused ?? { enabled: false, maxAmount: 0 };
  if (ra.enabled && !rb.enabled) out.push(`Members who cancel get the unused part of their cycle back, up to ${ra.maxAmount.toFixed(2)}.`);
  else if (ra.enabled && ra.maxAmount > rb.maxAmount) out.push(`The refund on cancel can be bigger: up to ${rb.maxAmount.toFixed(2)} becomes up to ${ra.maxAmount.toFixed(2)}.`);
  if (after.renewalReminderDays < b.renewalReminderDays) out.push(`Renewal reminders come later: ${b.renewalReminderDays} days before becomes ${after.renewalReminderDays}${after.renewalReminderDays === 0 ? " (no reminder)" : ""}.`);
  return out;
}
