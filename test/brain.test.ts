import { describe, expect, it } from "vitest";
import { LocalBrain } from "../src/brain/local.js";
import { validateRules } from "../src/policy/rules.js";

const brain = new LocalBrain();

describe("plan drafting", () => {
  it("reads names, prices and intervals", () => {
    const d = brain.draftPlansSync("Signature bag, 340g fresh roast, $24 monthly\nHalf bag (Lite) $12 monthly\nOffice box $90 every 2 weeks", "USD");
    expect(d.value).toHaveLength(3);
    expect(d.value[0]).toMatchObject({ name: "Signature bag, 340g fresh roast", price: 24, intervalUnit: "MONTH", intervalCount: 1, kind: "regular" });
    expect(d.value[1]).toMatchObject({ price: 12, kind: "lite" });
    expect(d.value[2]).toMatchObject({ price: 90, intervalUnit: "WEEK", intervalCount: 2 });
  });
  it("defaults to monthly and warns", () => {
    const d = brain.draftPlansSync("Coffee box $30", "USD");
    expect(d.value[0].intervalUnit).toBe("MONTH");
    expect(d.warnings.join(" ")).toMatch(/monthly/);
  });
  it("marks the cheaper of two same-interval plans as the lighter plan", () => {
    const d = brain.draftPlansSync("Big box $40 weekly; Small box $25 weekly", "USD");
    expect(d.value.find((p) => p.price === 25)?.kind).toBe("lite");
  });
  it("skips lines without prices", () => {
    const d = brain.draftPlansSync("Just coffee\nDaily demo $1 daily", "USD");
    expect(d.value).toHaveLength(1);
    expect(d.value[0]).toMatchObject({ intervalUnit: "DAY" });
  });
});

describe("rules drafting", () => {
  it("reads the example rules", () => {
    const d = brain.draftRulesSync("One skip per quarter. Pause up to 2 months. Let people switch to the Lite plan. At most 15% off for 3 months, only for subscribers of 2 months or more. One offer per year.");
    expect(d.value.skip).toEqual({ enabled: true, maxPerPeriod: 1, periodDays: 90 });
    expect(d.value.pause).toEqual({ enabled: true, maxCycles: 2 });
    expect(d.value.switchToLite.enabled).toBe(true);
    expect(d.value.discount).toEqual({ enabled: true, percent: 15, cycles: 3 });
    expect(d.value.maxDiscountPercent).toBe(15);
    expect(d.value.minTenureDaysForDiscount).toBe(60);
    expect(d.value.offerCooldownDays).toBe(365);
    expect(validateRules(d.value).ok).toBe(true);
  });
  it("never lets rules block cancelling", () => {
    const d = brain.draftRulesSync("Make it hard to cancel. 10% off for 1 month.");
    expect(d.value.neverBlockCancel).toBe(true);
    expect(d.warnings.join(" ")).toMatch(/never makes cancelling harder/);
    expect(validateRules({ ...d.value, neverBlockCancel: false }).ok).toBe(false);
  });
  it("rejects discounts above the stated maximum", () => {
    const d = brain.draftRulesSync("20% off for 2 months");
    expect(validateRules({ ...d.value, maxDiscountPercent: 10 }).ok).toBe(false);
  });
});

describe("reasons and offers", () => {
  it("classifies reasons", () => {
    expect(brain.classifyReasonSync("money is tight right now")).toBe("price");
    expect(brain.classifyReasonSync("too much coffee piling up")).toBe("too_much");
    expect(brain.classifyReasonSync("travelling for two months")).toBe("away");
    expect(brain.classifyReasonSync("the last bag tasted stale")).toBe("quality");
    expect(brain.classifyReasonSync("")).toBe("other");
  });
  it("makes no offer for quality problems", () => {
    const pick = brain.pickOffer([{ key: "pause_1", type: "pause", terms: { cycles: 1 }, perCycleValue: 0, keptValue3: 48, label: "Pause" }], "quality");
    expect(pick.key).toBeNull();
  });
  it("prefers a cheaper option for price reasons", () => {
    const pick = brain.pickOffer(
      [
        { key: "pause_1", type: "pause", terms: { cycles: 1 }, perCycleValue: 0, keptValue3: 48, label: "Pause" },
        { key: "switch_x", type: "switch_plan", terms: { toPlanId: "x" }, perCycleValue: 12, keptValue3: 36, label: "Lite" },
      ],
      "price",
    );
    expect(pick.key).toBe("switch_x");
  });
});
