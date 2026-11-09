/**
 * Creates the demo shop on the real PayPal sandbox (product, plans, discount plans, rules) and adds
 * clearly labelled sample subscribers so the dashboard isn't empty. Safe to re-run: it reuses the shop.
 *   npm run seed            (uses PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from .env)
 *   npm run seed -- --reset-samples
 */
import { getDb } from "../src/db.js";
import { newId } from "../src/lib/ids.js";
import * as svc from "../src/service.js";
import { merchantBySlug, plansFor, currentPolicy } from "../src/store.js";

const SLUG = "ember-oak-coffee-club";

const PLANS = `Signature bag, 340g fresh roast, $24 monthly
Half bag (Lite), 170g, $12 monthly
Daily demo bag $1 daily`;

const RULES = "One skip per quarter. Pause up to 2 months. Let people switch to the Lite plan. At most 15% off for 3 months, only for subscribers of 2 months or more. One offer per year.";

const NAMES = ["Maya Chen", "Arjun Rao", "Siti Rahman", "Tom Becker", "Lena Novak", "Kofi Mensah", "Hana Sato", "Diego Ruiz", "Priya Nair", "Ollie Park", "Ama Owusu", "Felix Wong", "Nora Lind", "Ravi Iyer", "Chloe Martin", "Wei Lim", "Sara Haddad", "Ben Carter", "Yuki Tan", "Leo Rossi", "Isla Grant", "Omar Aziz", "Mei Ho", "Jonas Berg", "Zara Ali", "Kai Muller", "Anya Ivanova", "Sam Ortiz", "Elif Kaya", "Noah Brooks"];

const REASONS: [string, string][] = [
  ["too much coffee piling up", "too_much"], ["money is tight this month", "price"], ["travelling for six weeks", "away"],
  ["the last bag tasted a bit stale", "quality"], ["switching to a cheaper local roaster", "competitor"], ["cutting down on caffeine", "no_need"],
  ["too expensive for me right now", "price"], ["still have two bags unopened", "too_much"], ["moving house", "away"], ["", "other"],
];

let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

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

  const reset = process.argv.includes("--reset-samples");
  const existing = (await db.query<{ c: string }>("SELECT count(*) AS c FROM subscribers WHERE merchant_id = $1 AND is_sample", [m.id])).rows[0];
  if (Number(existing.c) && !reset) {
    console.log(`Sample rows already present (${existing.c}); pass --reset-samples to recreate.`);
  } else {
    if (reset) {
      for (const t of ["offers", "feedback", "payments"]) await db.query(`DELETE FROM ${t} WHERE subscriber_id IN (SELECT id FROM subscribers WHERE merchant_id = $1 AND is_sample)`, [m.id]);
      await db.query("DELETE FROM event_log WHERE merchant_id = $1 AND is_sample", [m.id]);
      await db.query("DELETE FROM subscribers WHERE merchant_id = $1 AND is_sample", [m.id]);
    }
    const plans = await plansFor(db, m.id, true);
    const reg = plans.find((p) => p.kind === "regular" && p.interval_unit === "MONTH")!;
    const lite = plans.find((p) => p.kind === "lite")!;
    const promo = plans.find((p) => p.kind === "promo" && p.base_plan_id === reg.id);
    const now = Date.now();
    const day = 864e5;
    let i = 0;
    for (const name of NAMES) {
      i++;
      const id = newId("sub");
      const started = new Date(now - (20 + Math.floor(rand() * 300)) * day);
      const roll = rand();
      let status = "ACTIVE";
      let plan = rand() < 0.7 ? reg : lite;
      let resume: Date | null = null;
      let promoUntil: Date | null = null;
      let keptState: string | null = null;
      let outstanding = 0;
      if (roll < 0.12) { status = "SUSPENDED"; resume = new Date(now + (5 + Math.floor(rand() * 40)) * day); }
      else if (roll < 0.22) { status = "CANCELLED"; }
      else if (roll < 0.28 && promo) { plan = promo; promoUntil = new Date(now + (20 + Math.floor(rand() * 60)) * day); }
      else if (roll < 0.33) { keptState = "payment_failed"; outstanding = plan.price; }
      const next = status === "ACTIVE" ? new Date(now + (1 + Math.floor(rand() * 29)) * day + Math.floor(rand() * 20) * 3600_000) : null;
      const channel = rand() < 0.45 ? "agent" : "web";
      await db.query(
        `INSERT INTO subscribers (id, merchant_id, plan_id, home_plan_id, ref, status, kept_state, subscriber_name, subscriber_email, channel, agent_id, next_billing_time, outstanding, failed_payments, resume_at, promo_until, is_sample, started_at, cancelled_at, last_payment_amount, last_payment_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,$18,$19,$20)`,
        [id, m.id, plan.id, plan.kind === "promo" ? reg.id : plan.id, newId("ref", 20), status, keptState, name, name.toLowerCase().replace(" ", ".") + "@example.com", channel, channel === "agent" ? pick(["claude-desktop", "chatgpt-agent", "household-assistant"]) : null, next, outstanding, outstanding ? 1 : 0, resume, promoUntil, started, status === "CANCELLED" ? new Date(now - Math.floor(rand() * 25) * day) : null, plan.price, new Date(now - Math.floor(rand() * 28) * day)],
      );
      // a few months of payments
      const months = Math.min(6, Math.floor((now - started.getTime()) / (30 * day)));
      for (let k = 0; k < months; k++) {
        await db.query("INSERT INTO payments (id, merchant_id, subscriber_id, amount, currency, status, paid_at, source, is_sample) VALUES ($1,$2,$3,$4,$5,'COMPLETED',$6,'sample',true)", [newId("pay"), m.id, id, plan.price.toFixed(2), m.currency, new Date(now - (k * 30 + Math.floor(rand() * 28)) * day)]);
      }
      // cancellation conversations
      if (status === "CANCELLED" || promoUntil || (status === "SUSPENDED" && rand() < 0.6) || (status === "ACTIVE" && rand() < 0.1)) {
        const [text, cat] = pick(REASONS);
        const outcome = status === "CANCELLED" ? "cancelled" : "kept";
        if (text) await db.query("INSERT INTO feedback (id, merchant_id, subscriber_id, text, category, outcome, is_sample, created_at) VALUES ($1,$2,$3,$4,$5,$6,true,$7)", [newId("fb"), m.id, id, text, cat, outcome, new Date(now - Math.floor(rand() * 40) * day)]);
        if (status !== "ACTIVE" || promoUntil) {
          const type = promoUntil ? "discount" : status === "SUSPENDED" ? "pause" : pick(["pause", "switch_plan", "skip"]);
          const ostatus = status === "CANCELLED" ? pick(["declined", "expired", "declined"]) : "accepted";
          const value = type === "discount" ? (promo?.price ?? 0) * 3 : type === "switch_plan" ? lite.price * 3 : reg.price * 2;
          const label = type === "discount" ? "15% off for 3 cycles" : type === "pause" ? "Pause for 1 billing cycle" : type === "skip" ? "Skip the next renewal only" : `Switch to ${lite.name}`;
          await db.query(
            "INSERT INTO offers (id, subscriber_id, merchant_id, policy_version, type, terms, message, reason_category, status, monthly_value, expires_at, decided_at, created_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$10,$10)",
            [newId("ofr"), id, m.id, type, JSON.stringify({ label }), `Sample offer: ${label}`, cat, ostatus, ostatus === "accepted" ? value.toFixed(2) : "0", new Date(now - Math.floor(rand() * 40) * day)],
          );
        }
      }
      const evType = status === "CANCELLED" ? "subscription.cancelled" : status === "SUSPENDED" ? "pause.scheduled" : "subscription.activated";
      await db.query("INSERT INTO event_log (merchant_id, subscriber_id, source, type, summary, is_sample, created_at) VALUES ($1,$2,$3,$4,$5,true,$6)", [m.id, id, channel, evType, `${channel === "agent" ? "agent" : "web"}: ${name} ${evType.split(".")[1]}`, new Date(now - Math.floor(rand() * 30) * day)]);
    }
    console.log(`Added ${NAMES.length} labelled sample subscribers.`);
  }
  console.log(`\nDemo shop: /s/${m.slug}\nOwner key: ${m.owner_token}\n`);
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
