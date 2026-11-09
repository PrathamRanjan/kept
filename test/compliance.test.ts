import { describe, expect, it } from "vitest";
import { LocalBrain } from "../src/brain/local.js";
import { FORBIDDEN_PHRASES, JURISDICTIONS, RULES, scoreAll, scoreCompliance } from "../src/policy/compliance.js";
import { DEFAULT_RULES, RulesSchema } from "../src/policy/rules.js";

const brain = new LocalBrain();
const base = RulesSchema.parse({ ...DEFAULT_RULES, discount: { enabled: true, percent: 15, cycles: 3 }, maxDiscountPercent: 15 });

describe("compliance scorecard", () => {
  it("passes the default policy everywhere it is enforced", () => {
    for (const j of JURISDICTIONS) {
      const c = scoreCompliance(base, j.id);
      expect(c.failed, j.id).toBe(0);
      if (j.kind === "enforced") expect(c.total, j.id).toBeGreaterThan(0);
    }
  });
  it("every rule has a check, a source and a jurisdiction", () => {
    for (const r of RULES) {
      expect(r.source.length, r.id).toBeGreaterThan(5);
      expect(JURISDICTIONS.some((j) => j.id === r.jurisdiction), r.id).toBe(true);
      const out = r.check(base, { disclosure: { price: true, interval: true, cancelTerms: true }, hasAnnualPlans: true });
      expect(["pass", "fail", "info"]).toContain(out.status);
      expect(out.evidence.length).toBeGreaterThan(5);
    }
  });
  it("fails ROSCA-1 when a hand-edited policy blocks cancels or asks for more offers", () => {
    const bad = { ...base, neverBlockCancel: false } as any;
    expect(scoreCompliance(bad, "US_FEDERAL").rules.find((r) => r.id === "ROSCA-1")!.status).toBe("fail");
    const two = { ...base, offersBeforeCancel: 2 } as any;
    expect(scoreCompliance(two, "US_CA").rules.find((r) => r.id === "ROSCA-1")!.status).toBe("fail");
  });
  it("fails disclosure when a plan lacks price or interval", () => {
    const c = scoreCompliance(base, "US_FEDERAL", { disclosure: { price: true, interval: false, cancelTerms: true }, hasAnnualPlans: false });
    expect(c.rules.find((r) => r.id === "ROSCA-2")!.status).toBe("fail");
  });
  it("reminder rules bite only with annual plans", () => {
    const noReminder = { ...base, renewalReminderDays: 0 } as any;
    const annual = scoreCompliance(noReminder, "US_NY", { disclosure: { price: true, interval: true, cancelTerms: true }, hasAnnualPlans: true });
    expect(annual.rules.find((r) => r.id === "NY-1")!.status).toBe("fail");
    const monthly = scoreCompliance(noReminder, "US_NY", { disclosure: { price: true, interval: true, cancelTerms: true }, hasAnnualPlans: false });
    expect(monthly.rules.find((r) => r.id === "NY-1")!.status).not.toBe("fail");
  });
  it("scores every jurisdiction at once", () => {
    expect(scoreAll(base).map((c) => c.jurisdiction)).toEqual(JURISDICTIONS.map((j) => j.id));
  });
});

describe("forbidden phrases in plain-words rules", () => {
  const cases: [string, string][] = [
    ["Make three offers before letting anyone cancel", "KEPT-OFFER"],
    ["Customers must call us to cancel", "CA-1"],
    ["Make it hard to cancel", "ROSCA-1"],
    ["Hide the cancel button", "ROSCA-2"],
    ["No renewal reminders", "NY-1"],
  ];
  for (const [text, id] of cases) {
    it(`refuses "${text}" citing ${id}`, () => {
      expect(FORBIDDEN_PHRASES.some((f) => f.re.test(text) && f.ruleId === id)).toBe(true);
      const d = brain.draftRulesSync(`${text}. 10% off for 1 month.`);
      expect(d.warnings.join("\n")).toMatch(new RegExp(`\\[${id}\\]`));
      // The drafted rules stay legal regardless of what was asked.
      expect(d.value.neverBlockCancel).toBe(true);
      expect(d.value.offersBeforeCancel).toBe(1);
      expect(scoreCompliance(d.value, "US_CA").failed).toBe(0);
    });
  }
  it("leaves ordinary rules alone", () => {
    const d = brain.draftRulesSync("One skip per quarter. Remind people 10 days before renewal. One offer per year.");
    expect(d.warnings.filter((w) => /^\[/.test(w))).toEqual([]);
    expect(d.value.renewalReminderDays).toBe(10);
  });
});
