/**
 * Spec A5.6 fairness set for /proof:
 *   npm run eval:fairness
 * An in-memory shop on the fake PayPal (so it can run any time), with members of short and long tenure on both
 * plans, each cancelling with a different reason. Checks, in code: a quality complaint is never offered anything;
 * a discount only reaches members the owner's rule allows (2 months or more); a member who says no to the offer is
 * cancelled on the next call; a member who asks for no offer is cancelled in one call. Then reads the shop's own
 * fairness figures (src/eval/fairness.ts) from its event log. Writes eval/fairness.json.
 * The reason labels come from whichever brain is configured, and the file says which.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getBrain } from "../src/brain/index.js";
import { config } from "../src/config.js";
import { openDb, setDb } from "../src/db.js";
import { fairness } from "../src/eval/fairness.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import * as svc from "../src/service.js";
import { plansFor, subscriberByRef } from "../src/store.js";

const db = await openDb({ memory: true });
setDb(db);
const fake = new FakePayPal();
setPayPalFactory(() => fake);
const actor = { kind: "agent" as const, agentId: "fairness-set" };

const m = await svc.createMerchant({ name: "Fairness Roasters", tagline: "Beans", currency: "USD" });
await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
const rulesText = "One skip per quarter. Pause up to 2 months. Let people switch to the Lite plan. At most 15% off for 3 months, only for subscribers of 2 months or more. One offer per year.";
await svc.approveRules(m.id, (await svc.previewRules(rulesText, m.id)).value, rulesText);
const plans = await plansFor(db, m.id);

const REASONS = [
  { reason: "it's too expensive for me right now", quality: false },
  { reason: "the coffee tasted burnt and stale", quality: true },
  { reason: "I'm moving abroad next month", quality: false },
  { reason: "the beans arrived damaged twice", quality: true },
];
type Case = { id: string; input: string; expected: string; actual: string; pass: boolean; note?: string };
const cases: Case[] = [];
const byGroup: Record<string, { members: number; offers: number; discounts: number }> = {};
let n = 0;

for (const plan of plans.filter((p) => p.kind !== "promo")) {
  for (const days of [20, 200]) {
    for (const r of REASONS) {
      n++;
      const x = await svc.startSubscription(m, plan.id, { name: `Member ${n}` }, { kind: "web" });
      fake.approve(x.paypalSubscriptionId!);
      await svc.syncSubscription(x.ref);
      await db.query("UPDATE subscribers SET started_at = now() - ($2 || ' days')::interval WHERE ref = $1", [x.ref, String(days)]);
      const out: any = await svc.requestCancel(x.ref, { reason: r.reason, hearOffer: true }, actor);
      const offer = out.offer;
      const discount = offer && /discount|percent|off/i.test(`${offer.type} ${JSON.stringify(offer.terms)}`);
      const group = `${plan.name.split(" (")[0]}, ${days < 60 ? "under 2 months" : "over 6 months"}`;
      const g = (byGroup[group] ??= { members: 0, offers: 0, discounts: 0 });
      g.members++;
      if (offer) g.offers++;
      if (discount) g.discounts++;
      // Declining must end in a cancel on that one call.
      let after = (await subscriberByRef(db, x.ref))!.status;
      if (offer) {
        await svc.respondToOffer(offer.offer_id ?? offer.id, false, actor);
        after = (await subscriberByRef(db, x.ref))!.status;
      }
      const expected = r.quality ? "no offer; cancelled" : days < 60 ? "no discount (rule: 2 months or more); cancelled when declined" : "an offer may be made; cancelled when declined";
      const ok = (r.quality ? !offer : days < 60 ? !discount : true) && after === "CANCELLED";
      cases.push({ id: `f${n}`, input: `${group}: "${r.reason}"`, expected, actual: `${offer ? `offered ${offer.type}${discount ? " (a discount)" : ""}, declined` : "no offer"}; PayPal ${after}`, pass: ok });
    }
  }
}

// One call, no offer asked for.
{
  const x = await svc.startSubscription(m, plans[0].id, { name: "Direct" }, { kind: "web" });
  fake.approve(x.paypalSubscriptionId!);
  await svc.syncSubscription(x.ref);
  const out: any = await svc.requestCancel(x.ref, { reason: "just cancel please", hearOffer: false }, actor);
  const s = (await subscriberByRef(db, x.ref))!;
  cases.push({ id: "f-direct", input: "Member asks to cancel and not hear an offer", expected: "cancelled in one call, no offer", actual: `${out.offer ? "an offer was made" : "no offer"}; PayPal ${s.status}`, pass: !out.offer && s.status === "CANCELLED" });
}

const f = await fairness(m.id);
const qualityOffered = cases.filter((c) => /burnt|damaged/.test(c.input) && /offered/.test(c.actual)).length;
cases.push({ id: "f-quality", input: "Quality complaints that were offered anything", expected: "0", actual: String(qualityOffered), pass: qualityOffered === 0 });
cases.push({ id: "f-one-call", input: "Share of cancels PayPal confirmed on the first call", expected: "100%", actual: `${f.one_call_cancel_rate}% of ${f.cancels}`, pass: f.one_call_cancel_rate === 100 });

const brain = getBrain();
const passed = cases.filter((c) => c.pass).length;
mkdirSync("eval", { recursive: true });
writeFileSync("eval/fairness.json", JSON.stringify({
  suite: "fairness",
  title: "Cancel-flow fairness: who gets offers, and does no mean no",
  about: `${n} members (both plans, short and long tenure, four reasons each) cancel; every offer is declined. Offers by group: ${Object.entries(byGroup).map(([k, v]) => `${k}: ${v.offers} of ${v.members} offered, ${v.discounts} discounts`).join("; ")}. Shop figures: ${f.offers_made} offers made, ${f.offers_accepted} accepted, median ${f.median_seconds_to_cancel ?? "n/a"} s from request to cancel.`,
  model: config.brain === "openai" ? config.ai.models.classify : null,
  runner: `${config.brain === "openai" ? "real model labels" : "rules labels: no model key"}, in-memory PayPal`,
  run_at: new Date().toISOString(),
  groups: byGroup,
  figures: f,
  cases,
  not_measured: ["Real members at scale: this is a built shop, not production traffic.", "Whether members feel pressured: only what code can count."],
}, null, 1));
console.log(`${passed} of ${cases.length} fairness cases passed (${brain.name}).`);
process.exit(passed === cases.length ? 0 : 1);
