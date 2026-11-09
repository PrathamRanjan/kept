import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, setDb, type Db } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { plansFor } from "../src/store.js";
import { eligibleOffers } from "../src/policy/eligibility.js";

// Findings from the 10 Nov audit (docs/AUDIT.md). Each reproduces what the fresh-data sandbox run showed.
const web = { kind: "web" as const };
let db: Db;
let fake: FakePayPal;

beforeEach(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
});
afterEach(async () => {
  await db.close();
});

async function shop(rules: string) {
  const m = await svc.createMerchant({ name: "Rise Sourdough Club", currency: "USD" });
  await svc.createPlans(m.id, (await svc.previewPlans("Baker box $18.25 monthly\nStarter kit (Lite) $7.50 monthly", "USD")).value);
  await svc.approveRules(m.id, (await svc.previewRules(rules)).value, rules);
  return m;
}

describe("audit fixes", () => {
  it("AU-1: a pause rule longer than the owner's autonomy still yields an offer, clamped to the autonomy limit", async () => {
    const m = await shop("Pause up to 3 months. One offer every 6 months.");
    const plan = (await plansFor(db, m.id)).find((p) => p.name === "Baker box")!;
    const x = await svc.startSubscription(m, plan.id, { name: "Imogen Fairweather", email: "imogen.f@example.net" }, web);
    fake.approve(x.paypalSubscriptionId);
    await svc.syncSubscription(x.ref);
    const out = await svc.requestCancel(x.ref, { reason: "a bit pricey for me right now", hearOffer: true }, web);
    expect(out.status).toBe("offer_open");
    expect(out.offer?.terms.cycles).toBe(2); // default autonomy is 2 cycles; the rules allow 3
  });

  it("AU-1: eligibility honours maxPauseCycles and drops the pause when autonomy is zero", () => {
    const base: any = {
      rules: { skip: { enabled: false, maxPerPeriod: 0, periodDays: 90 }, pause: { enabled: true, maxCycles: 3 }, switchToLite: { enabled: false }, discount: { enabled: false, percent: 0, cycles: 0 }, maxDiscountPercent: 0, minTenureDaysForDiscount: 0, offerCooldownDays: 180 },
      subscriber: { status: "ACTIVE", plan_id: "p", home_plan_id: "p", started_at: new Date() },
      plans: [{ id: "p", name: "Box", kind: "regular", price: 18.25, base_plan_id: null, discount_percent: null, interval_unit: "MONTH", interval_count: 1, active: true }],
      skipsAt: [],
      lastOfferAcceptedAt: null,
    };
    expect(eligibleOffers(base)[0].terms.cycles).toBe(3);
    expect(eligibleOffers({ ...base, maxPauseCycles: 2 })[0].terms.cycles).toBe(2);
    expect(eligibleOffers({ ...base, maxPauseCycles: 0 })).toEqual([]);
  });
});
