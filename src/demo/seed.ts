/**
 * Labelled sample history for a demo workspace (spec A1.3). Forty members would be too slow and too costly to
 * create on PayPal for every visitor, so they are rows with `is_sample = true`: every list shows a "Sample" chip,
 * the buttons on a sample member are view-only, and no "confirmed by PayPal" figure counts them.
 *
 * Every date is relative to `now` (the workspace's creation time); nothing in this file names a calendar date,
 * and nothing seeded has a deadline that can pass on its own (sample offers are already decided, the one open
 * item is a held approval, which never expires by itself).
 */
import type { Queryable } from "../db.js";
import { newId } from "../lib/ids.js";
import { plansFor, type Merchant } from "../store.js";

export const SEED_VERSION = 1;

const NAMES = ["Maya Chen", "Arjun Rao", "Siti Rahman", "Tom Becker", "Lena Novak", "Kofi Mensah", "Hana Sato", "Diego Ruiz", "Priya Nair", "Ollie Park", "Ama Owusu", "Felix Wong", "Nora Lind", "Ravi Iyer", "Chloe Martin", "Wei Lim", "Sara Haddad", "Ben Carter", "Yuki Tan", "Leo Rossi", "Isla Grant", "Omar Aziz", "Mei Ho", "Jonas Berg", "Zara Ali", "Kai Muller", "Anya Ivanova", "Sam Ortiz", "Elif Kaya", "Noah Brooks", "Ines Duarte", "Luca Bianchi", "Freya Holm", "Tariq Saleh", "June Park", "Aditi Shah", "Mateo Silva", "Rosa Lopez", "Hugo Laurent", "Esme Doyle"];

/** Reason text and the category Kept's classifier gives it. */
const REASONS: [string, string][] = [
  ["too much coffee piling up", "too_much"],
  ["money is tight this month", "price"],
  ["travelling for six weeks", "away"],
  ["the last bag tasted a bit stale", "quality"],
  ["switching to a cheaper local roaster", "competitor"],
  ["cutting down on caffeine", "no_need"],
  ["too expensive for me right now", "price"],
  ["still have two bags unopened", "too_much"],
  ["moving house next month", "away"],
  ["my card expired", "payment"],
];

const AGENTS = ["claude-desktop", "chatgpt-agent", "household-assistant"];

export interface SeedResult {
  members: number;
  payments: number;
  offers: number;
  reasons: number;
  heldApprovals: number;
}

/** Inserts the sample history into one shop. Safe to call once per workspace; `clearSamples` undoes it. */
export async function seedSamples(q: Queryable, m: Merchant, now = new Date()): Promise<SeedResult> {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
  const t = now.getTime();
  const day = 864e5;
  const ago = (days: number) => new Date(t - days * day);
  const plans = await plansFor(q, m.id, true);
  const reg = plans.find((p) => p.kind === "regular" && p.interval_unit === "MONTH") ?? plans.find((p) => p.kind === "regular");
  const lite = plans.find((p) => p.kind === "lite") ?? reg;
  const promo = plans.find((p) => p.kind === "promo" && p.base_plan_id === reg?.id);
  if (!reg || !lite) throw new Error("The shop has no regular plan to seed sample members on.");
  const out: SeedResult = { members: 0, payments: 0, offers: 0, reasons: 0, heldApprovals: 0 };
  let heldFor: { id: string; name: string } | null = null;

  for (const name of NAMES) {
    const id = newId("sub");
    const startedDays = 20 + Math.floor(rand() * 300);
    const roll = rand();
    let status = "ACTIVE";
    let plan = rand() < 0.7 ? reg : lite;
    let resume: Date | null = null;
    let promoUntil: Date | null = null;
    let keptState: string | null = null;
    let outstanding = 0;
    let event = "subscription.activated";
    if (roll < 0.12) {
      status = "SUSPENDED";
      resume = new Date(t + (5 + Math.floor(rand() * 40)) * day);
      event = "pause.scheduled";
    } else if (roll < 0.24) {
      status = "CANCELLED";
      event = "subscription.cancelled";
    } else if (roll < 0.3 && promo) {
      plan = promo;
      promoUntil = new Date(t + (20 + Math.floor(rand() * 60)) * day);
      event = "offer.accepted";
    } else if (roll < 0.35) {
      keptState = "payment_failed";
      outstanding = plan.price;
      event = "payment.failed";
    } else if (roll < 0.42) {
      event = "skip.scheduled";
    }
    const next = status === "ACTIVE" ? new Date(t + (1 + Math.floor(rand() * 29)) * day + Math.floor(rand() * 20) * 3600_000) : null;
    const channel = rand() < 0.45 ? "agent" : "web";
    const agent = channel === "agent" ? pick(AGENTS) : null;
    const cancelledAt = status === "CANCELLED" ? ago(1 + Math.floor(rand() * 25)) : null;
    await q.query(
      `INSERT INTO subscribers (id, merchant_id, plan_id, home_plan_id, ref, status, kept_state, subscriber_name, subscriber_email, channel, agent_id, next_billing_time, outstanding, failed_payments, resume_at, promo_until, is_sample, started_at, cancelled_at, last_payment_amount, last_payment_time, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17,$18,$19,$20,$17)`,
      [id, m.id, plan.id, plan.kind === "promo" ? reg.id : plan.id, newId("ref", 20), status, keptState, name, `${name.toLowerCase().replace(" ", ".")}@example.com`, channel, agent, next, outstanding, outstanding ? 1 : 0, resume, promoUntil, ago(startedDays), cancelledAt, plan.price, ago(1 + Math.floor(rand() * 27))],
    );
    out.members++;
    const cycles = Math.min(6, Math.floor(startedDays / 30));
    for (let k = 0; k < cycles; k++) {
      await q.query("INSERT INTO payments (id, merchant_id, subscriber_id, amount, currency, status, paid_at, source, is_sample) VALUES ($1,$2,$3,$4,$5,'COMPLETED',$6,'sample',true)", [newId("pay"), m.id, id, plan.price.toFixed(2), m.currency, ago(k * 30 + 1 + Math.floor(rand() * 27))]);
      out.payments++;
    }
    const talked = status === "CANCELLED" || promoUntil || (status === "SUSPENDED" && rand() < 0.6) || (status === "ACTIVE" && rand() < 0.1);
    if (talked) {
      const [text, cat] = pick(REASONS);
      const when = ago(1 + Math.floor(rand() * 40));
      await q.query("INSERT INTO feedback (id, merchant_id, subscriber_id, text, category, outcome, is_sample, created_at) VALUES ($1,$2,$3,$4,$5,$6,true,$7)", [newId("fb"), m.id, id, text, cat, status === "CANCELLED" ? "cancelled" : "kept", when]);
      out.reasons++;
      // Quality complaints never get an offer (Kept's rule); everyone else who heard one decided already.
      if ((status !== "ACTIVE" || promoUntil) && cat !== "quality") {
        const type = promoUntil ? "discount" : status === "SUSPENDED" ? "pause" : pick(["pause", "switch_plan", "skip"]);
        const ostatus = status === "CANCELLED" ? pick(["declined", "expired", "declined"]) : "accepted";
        const value = type === "discount" ? (promo?.price ?? 0) * 3 : type === "switch_plan" ? lite.price * 3 : reg.price * 2;
        const label = type === "discount" ? "15% off for 3 cycles" : type === "pause" ? "Pause for 1 billing cycle" : type === "skip" ? "Skip the next renewal only" : `Switch to ${lite.name}`;
        await q.query(
          "INSERT INTO offers (id, subscriber_id, merchant_id, policy_version, type, terms, message, reason_category, status, monthly_value, expires_at, decided_at, created_at, is_sample) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$10,$10,true)",
          [newId("ofr"), id, m.id, type, JSON.stringify({ label }), `Sample offer: ${label}`, cat, ostatus, ostatus === "accepted" ? value.toFixed(2) : "0", when],
        );
        out.offers++;
      }
    }
    if (!heldFor && status === "ACTIVE" && !keptState && !promoUntil) heldFor = { id, name };
    const via = channel === "agent" ? `agent ${agent}` : "web";
    await q.query("INSERT INTO event_log (merchant_id, subscriber_id, source, type, summary, is_sample, created_at) VALUES ($1,$2,$3,$4,$5,true,$6)", [m.id, id, channel, event, `Sample (${via}): ${name} ${event.replace(".", " ")}`, cancelledAt ?? ago(1 + Math.floor(rand() * 30))]);
  }

  // One thing that needs the owner now: a discount above the owner's limit, held for approval.
  if (heldFor) {
    const payload = { action: "offer", merchantId: m.id, agentScope: "subscriber", entity: "subscriber", entityId: heldFor.id, cents: Math.round(reg.price * 25), offer: { type: "discount", percent: 25, cycles: 3 }, reason: "25% off is above the 15% the offer step may give without you", is_sample: true, sample_name: heldFor.name };
    await q.query("INSERT INTO approvals (id, merchant_id, action, payload_hash, payload, status, created_at) VALUES ($1,$2,'offer',$3,$4,'pending',$5)", [newId("apr"), m.id, `sample-${heldFor.id}`, JSON.stringify(payload), ago(0.05)]);
    out.heldApprovals++;
  }
  return out;
}

/** Removes a shop's sample rows (used before the nightly showcase rebuild). Real rows are not touched. */
export async function clearSamples(q: Queryable, merchantId: string) {
  const samples = "SELECT id FROM subscribers WHERE merchant_id = $1 AND is_sample";
  await q.query(`DELETE FROM offers WHERE merchant_id = $1 AND (is_sample OR subscriber_id IN (${samples}))`, [merchantId]);
  await q.query(`DELETE FROM feedback WHERE merchant_id = $1 AND (is_sample OR subscriber_id IN (${samples}))`, [merchantId]);
  await q.query(`DELETE FROM payments WHERE merchant_id = $1 AND (is_sample OR subscriber_id IN (${samples}))`, [merchantId]);
  await q.query(`DELETE FROM event_log WHERE merchant_id = $1 AND (is_sample OR subscriber_id IN (${samples}))`, [merchantId]);
  await q.query("DELETE FROM approvals WHERE merchant_id = $1 AND payload_hash LIKE 'sample-%'", [merchantId]);
  await q.query(`DELETE FROM subscribers WHERE merchant_id = $1 AND is_sample`, [merchantId]);
}
