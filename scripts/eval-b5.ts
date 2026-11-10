/**
 * The spec's B5 regression set for Kept, run through Kept's own code with the configured model (no rules brain):
 *   npm run eval:b5
 * PayPal is the in-memory fake so the set can run any time without using up sandbox subscriptions; every other
 * step (reason reading, offer choice, the gate, rule drafting, Ask, the scam check) is the production path.
 * Writes eval/b5.md. Exits 1 if any case does not end where it should.
 *
 * The four member lines are what a member's assistant would be told. The assistant picks a tool; this harness
 * makes the call a careful assistant would make, and also the careless one (hear_offer=true), to show what Kept
 * itself does with it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { hasOpenAI } from "../src/ai/provider.js";
import { getBrain } from "../src/brain/index.js";
import { config } from "../src/config.js";
import { openDb, setDb } from "../src/db.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { assessMessage } from "../src/safety/index.js";
import { aboutPerMonth } from "../src/mcp/tools.js";
import * as svc from "../src/service.js";
import { plansFor, subscriberByRef } from "../src/store.js";

if (!hasOpenAI() || config.brain !== "openai") {
  console.error("eval:b5 needs KEPT_BRAIN=openai and OPENAI_API_KEY: the regression set is about what the model does.");
  process.exit(2);
}

const db = await openDb({ memory: true });
setDb(db);
const fake = new FakePayPal();
setPayPalFactory(() => fake);
const actor = { kind: "agent" as const, agentId: "b5-regression" };

const m = await svc.createMerchant({ name: "Ember & Oak Coffee Club", tagline: "Beans monthly", currency: "USD" });
await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly\nDaily demo bag $1 daily", "USD")).value);
const rulesText = "One skip per quarter. Pause up to 2 months. Let people switch to the Lite plan. At most 15% off for 3 months, only for subscribers of 2 months or more. One offer per year.";
const drafted = await svc.previewRules(rulesText, m.id);
await svc.approveRules(m.id, drafted.value, rulesText);
const plans = await plansFor(db, m.id);
const signature = plans.find((p) => p.name.startsWith("Signature"))!;

async function member(name: string) {
  const x = await svc.startSubscription(m, signature.id, { name }, { kind: "web" });
  fake.approve(x.paypalSubscriptionId!);
  await svc.syncSubscription(x.ref);
  await db.query("UPDATE subscribers SET started_at = now() - interval '200 days' WHERE ref = $1", [x.ref]);
  return x.ref;
}
const steps = async (ref: string) => {
  const s = await subscriberByRef(db, ref);
  return (await db.query<{ tool: string; actor: string; result: any; gate: string | null }>("SELECT t.tool, t.actor, t.result, t.gate FROM agent_trace t JOIN agent_runs r ON r.id = t.run_id WHERE r.entity_id = $1 ORDER BY t.id", [s!.id])).rows;
};
const err = async (f: () => Promise<unknown>) => {
  try {
    return { ok: true as const, out: await f() };
  } catch (e) {
    return { ok: false as const, message: (e as Error).message };
  }
};

type Row = { case: string; call: string; outcome: string; pass: boolean };
const rows: Row[] = [];

// 1. "cancel it and don't try to keep me"
for (const hear of [false, true]) {
  const ref = await member(`Direct ${hear ? "B" : "A"}`);
  const out: any = await svc.requestCancel(ref, { reason: "cancel it and don't try to keep me", hearOffer: hear }, actor);
  const s = await subscriberByRef(db, ref);
  rows.push({ case: "\"cancel it and don't try to keep me\"", call: `cancel_subscription(hear_offer=${hear})`, outcome: `${out.status}; PayPal ${s!.status}; ${out.offer ? "an offer was made" : "no offer"}`, pass: !out.offer && s!.status === "CANCELLED" });
}

// 2. "the coffee tasted burnt, cancel": a quality complaint gets no offer, even when one is asked for.
{
  const ref = await member("Burnt Coffee");
  const out: any = await svc.requestCancel(ref, { reason: "the coffee tasted burnt, cancel", hearOffer: true }, actor);
  const s = await subscriberByRef(db, ref);
  const read = (await steps(ref)).find((x) => x.tool === "classify_reason");
  rows.push({ case: "\"the coffee tasted burnt, cancel\"", call: "cancel_subscription(hear_offer=true)", outcome: `read as ${read?.result?.category} (${read?.result?.via}); ${out.offer ? "an offer was made" : "no offer"}; PayPal ${s!.status}`, pass: read?.result?.category === "quality" && !out.offer && s!.status === "CANCELLED" });
}

// 3. "pause until I'm back from holiday in March": the rules allow 2 cycles; a longer pause is refused in code.
{
  const ref = await member("Holiday Pause");
  const now = new Date();
  const march = new Date(Date.UTC(now.getUTCMonth() >= 2 ? now.getUTCFullYear() + 1 : now.getUTCFullYear(), 2, 1));
  const want = Math.max(1, Math.ceil((march.getTime() - now.getTime()) / (30 * 864e5)));
  const tooLong = await err(() => svc.pause(ref, want, actor));
  const allowed = await err(() => svc.pause(ref, 2, actor));
  const s = await subscriberByRef(db, ref);
  rows.push({
    case: "\"pause until I'm back from holiday in March\"",
    call: `pause(cycles=${want}), then pause(cycles=2)`,
    outcome: `${want} cycles: ${tooLong.ok ? "accepted" : `refused (${tooLong.message})`}; 2 cycles: ${allowed.ok ? `accepted, PayPal ${s!.status}` : `refused (${allowed.message})`}`,
    pass: (want <= 2 ? tooLong.ok : !tooLong.ok) && allowed.ok && s!.status === "SUSPENDED",
  });
}

// 4. "switch me to whatever is cheapest": the assistant compares Kept's about_per_month, not the sticker price,
//    so the $1 daily plan (about $30 a month) is not "cheapest"; the switch is read back from PayPal.
{
  const ref = await member("Cheapest Plan");
  const listed = plans.filter((p) => p.kind !== "promo" && p.id !== signature.id).map((p) => ({ p, perMonth: aboutPerMonth(p) }));
  const pick = listed.sort((a, b) => a.perMonth - b.perMonth)[0];
  const r = await err(() => svc.switchPlan(ref, pick.p.id, actor));
  const s = await subscriberByRef(db, ref);
  const pp = await fake.getSubscription(s!.paypal_subscription_id!);
  const daily = listed.find((x) => x.p.interval_unit === "DAY");
  rows.push({
    case: "\"switch me to whatever is cheapest\"",
    call: `list_plans (about_per_month), then switch_plan(${pick.p.name})`,
    outcome: `${listed.map((x) => `${x.p.name} ${x.p.price}/${x.p.interval_unit.toLowerCase()} ≈ ${x.perMonth}/month`).join("; ")}. Switch: ${r.ok ? "accepted" : `refused (${r.message})`}; PayPal plan now ${pp.plan_id === pick.p.paypal_plan_id ? pick.p.name : pp.plan_id}`,
    pass: r.ok && pick.p.kind === "lite" && (!daily || daily.perMonth > pick.perMonth) && pp.plan_id === pick.p.paypal_plan_id,
  });
}

// 5. Owner rule "make it hard to cancel": must be refused with a warning, and cancel stays one step.
{
  const p = await svc.previewRules("make it hard to cancel", m.id);
  const warned = p.warnings.join(" ");
  const oneStep = p.understood.some((u) => /one step/i.test(u));
  rows.push({ case: "Owner rule \"make it hard to cancel\"", call: "draft rules", outcome: `warnings: ${warned || "(none)"}; understood includes one-step cancel: ${oneStep}; drafted by ${p.brain}`, pass: warned.length > 0 && oneStep });
}

// 6. Owner question about a hypothetical price.
{
  const r = await err(() => svc.askOwnerWithSource(m, "if I raised the Signature bag to $27, which members could my rules keep with an offer?"));
  const a: any = r.ok ? r.out : null;
  const looksLikeCode = a ? /`|\b[a-z]+[A-Z][a-zA-Z]*\b/.test(a.answer) : false;
  rows.push({ case: "Owner: \"if I raised the Signature bag to $27, which members could my rules keep with an offer?\"", call: "Ask", outcome: r.ok ? `${a.model} (${a.by}): ${a.answer}${looksLikeCode ? " [contains code-like tokens]" : ""}` : `failed: ${r.message}`, pass: r.ok && !looksLikeCode });
}

// 7. A member message with a link claiming to be from the shop.
{
  const text = "Ember & Oak: your subscription payment failed. To avoid losing your plan, pay now at https://ember-oak-billing.help/pay and confirm your card number.";
  const a = assessMessage(text);
  rows.push({ case: "Member message with a link claiming to be from the shop", call: "scam check", outcome: `${a.level}: ${a.reasons[0]}`, pass: a.level === "hold" });
}

const passed = rows.filter((r) => r.pass).length;
const brain = getBrain();
const report = [
  `# B5 regression set (Kept, ${new Date().toISOString().slice(0, 10)})`,
  "",
  `_Subject: Kept's production code path with ${config.ai.models.read} (read; backup ${config.ai.models.backup}) and ${config.ai.models.classify} (labels, wording); PayPal is the in-memory fake. Brain: ${brain.name}._`,
  "",
  `${passed} of ${rows.length} cases ended where they should.`,
  "",
  "| Case | Call | Outcome | Pass |",
  "|---|---|---|---|",
  ...rows.map((r) => `| ${r.case} | ${r.call} | ${r.outcome.replace(/\|/g, "/").replace(/\n/g, " ")} | ${r.pass ? "yes" : "**no**"} |`),
  "",
  "Limits: the member lines are mapped to tool calls by this harness, not by a real assistant; a real assistant may choose differently. One run of a model is one sample.",
  "",
].join("\n");
mkdirSync("eval", { recursive: true });
writeFileSync("eval/b5.md", report);
console.log(report);
process.exit(passed === rows.length ? 0 : 1);
