/**
 * Runs the adversarial agent harness and writes eval/adversarial.md.
 *   npm run eval:adversarial          against the first shop's live ACTIVE subscription in the configured database
 *   npm run eval:adversarial -- --fake  against the fake PayPal with an in-memory shop (no sandbox needed; labelled in the report)
 * Falls back to --fake when no live ACTIVE subscription exists.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { getDb, openDb, setDb } from "../src/db.js";
import { renderAdversarialReport, runAdversarial } from "../src/eval/adversarial.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import * as svc from "../src/service.js";
import { currentPolicy, plansFor, subscriberByRef, type Merchant, type Subscriber } from "../src/store.js";

const wantFake = process.argv.includes("--fake");
let m: Merchant | undefined;
let subs: Subscriber[] = [];
let mode = "live sandbox subscription";
if (!wantFake) {
  const db = await getDb();
  m = (await db.query<Merchant>("SELECT * FROM merchants ORDER BY created_at LIMIT 1")).rows[0];
  if (m) subs = (await db.query<Subscriber>("SELECT * FROM subscribers WHERE merchant_id = $1 AND is_sample = false AND paypal_subscription_id IS NOT NULL AND status = 'ACTIVE' ORDER BY created_at DESC", [m.id])).rows;
}
if (!m || !subs.length) {
  mode = "fake PayPal, in-memory shop";
  console.error(`No live ACTIVE subscription: running against the ${mode}.`);
  const db = await openDb({ memory: true });
  setDb(db);
  const fake = new FakePayPal();
  setPayPalFactory(() => fake);
  m = await svc.createMerchant({ name: "Harness Roasters", tagline: "Beans", currency: "USD" });
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  const rules = "One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.";
  await svc.approveRules(m.id, (await svc.previewRules(rules)).value, rules);
  const plan = (await plansFor(db, m.id)).find((p) => p.kind === "regular")!;
  for (const name of ["Ada", "Ben"]) {
    const x = await svc.startSubscription(m, plan.id, { name }, { kind: "web" });
    fake.approve(x.paypalSubscriptionId);
    await svc.syncSubscription(x.ref);
    subs.push((await subscriberByRef(db, x.ref))!);
  }
}
const db = await getDb();
const policy = await currentPolicy(db, m.id);
const r = await runAdversarial(m, subs[0], subs[1] ?? null, policy?.rules ?? null);
const md = renderAdversarialReport(r).replace(/\n/, `\n\n_Subject: ${mode}._\n`);
mkdirSync("eval", { recursive: true });
writeFileSync("eval/adversarial.md", md);
writeFileSync("eval/adversarial.json", JSON.stringify({
  suite: "adversarial",
  title: "Hostile agent moves against the money gate",
  about: `Subject: ${mode}. Each case is a move a hostile or confused agent might try; the gate must refuse, hold or dry-run it. No PayPal write may happen.`,
  model: null,
  runner: "code only: the gate and the service, no model",
  run_at: new Date().toISOString(),
  cases: r.results.map((x) => ({ id: x.id, input: x.title, expected: "refused, held or dry-run", actual: `${x.outcome}${x.reason ? `: ${x.reason}` : ""}`, pass: x.ok })),
  not_measured: ["Attacks through prompt injection in members' messages are covered by the scam and reason sets, not here."],
}, null, 1));
console.log(md);
process.exit(r.passed === r.cases ? 0 : 1);
