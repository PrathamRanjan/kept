/**
 * Playwright's server: the real app on an in-memory database, with the project's FakePayPal standing in for
 * PayPal so browser tests are repeatable and never touch the sandbox. Test-only; never deployed.
 */
import { openDb, setDb } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { createApp } from "../src/app.js";
import { plansFor } from "../src/store.js";
import { ensureShowcase } from "../src/demo/workspaces.js";

const port = Number(process.env.PORT || 4199);
const db = await openDb({ memory: true });
setDb(db);
const fake = new FakePayPal();
setPayPalFactory(() => fake);

const m = await svc.createMerchant({ name: "Ember & Oak Coffee Club", tagline: "Small-batch beans, roasted to order", currency: "USD" });
const drafts = (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value;
await svc.createPlans(m.id, drafts);
const rules = await svc.previewRules("One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.");
await svc.approveRules(m.id, rules.value, "e2e rules");

const plans = (await plansFor(db, m.id)).filter((p) => p.kind === "regular");
for (const name of ["Ada Lovelace", "Grace Hopper"]) {
  const out = await svc.startSubscription(m, plans[0].id, { name, email: `${name.split(" ")[0].toLowerCase()}@example.com` }, { kind: "web" });
  fake.approve(out.paypalSubscriptionId);
  await svc.syncSubscription(out.ref);
}

// A separate showcase shop so /demo/start works; the test shop above stays writable for /__e2e/member.
const show = await svc.createMerchant({ name: "Ember & Oak Showcase", tagline: "Beans monthly", currency: "USD" });
await svc.createPlans(show.id, drafts);
await svc.approveRules(show.id, rules.value, "e2e rules");
process.env.KEPT_DEMO_SHOP = show.slug;
await ensureShowcase(db);
const app = createApp();
// Test-only: a fresh, active member (approved on the fake PayPal) so each browser test starts clean.
let n = 0;
app.post("/__e2e/member", async (_req, res) => {
  const out = await svc.startSubscription(m, plans[0].id, { name: `Test Member ${++n}`, email: `t${n}@example.com` }, { kind: "web" });
  fake.approve(out.paypalSubscriptionId);
  await svc.syncSubscription(out.ref);
  res.json({ ref: out.ref });
});
app.listen(port, () => console.log(`[e2e] listening on ${port}, shop ${m.slug}`));
