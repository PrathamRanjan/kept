/**
 * Creates the demo shop on the real PayPal sandbox (product, plans, discount plans, rules). It adds no members:
 * every member is a real sandbox subscription made on the shop page. Safe to re-run: it reuses the shop.
 *   npm run seed            (uses PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from .env)
 */
import { getDb } from "../src/db.js";
import * as svc from "../src/service.js";
import { merchantBySlug, plansFor, currentPolicy } from "../src/store.js";

const SLUG = "ember-oak-coffee-club";

const PLANS = `Signature bag, 340g fresh roast, $24 monthly
Half bag (Lite), 170g, $12 monthly
Daily demo bag $1 daily`;

const RULES = "One skip per quarter. Pause up to 2 months. Let people switch to the Lite plan. At most 15% off for 3 months, only for subscribers of 2 months or more. One offer per year.";

async function main() {
  const db = await getDb();
  let m = await merchantBySlug(db, SLUG);
  if (!m) {
    console.log("Creating demo shop on the PayPal sandbox…");
    m = await svc.createMerchant({ name: "Ember & Oak Coffee Club", tagline: "Small-batch beans, roasted to order and delivered every month", currency: process.env.KEPT_DEMO_CURRENCY || "USD", ownerEmail: "owner@ember-oak.example" });
  }
  if (!(await plansFor(db, m.id)).length) {
    const draft = await svc.previewPlans(PLANS, m.currency);
    const plans = await svc.createPlans(m.id, draft.value);
    console.log(`Created ${plans.length} PayPal plans: ${plans.map((p) => `${p.name} → ${p.paypal_plan_id}`).join(", ")}`);
  }
  if (!(await currentPolicy(db, m.id))) {
    const p = await svc.previewRules(RULES);
    const out = await svc.approveRules(m.id, p.value, RULES, p.understood);
    console.log(`Approved rules v${out.version}`);
  }

  console.log(`\nDemo shop: /s/${m.slug} (owner key is in the database; it is not printed)\n`);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
