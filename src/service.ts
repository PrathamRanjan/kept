import { getDb } from "./db.js";
import { config } from "./config.js";
import { getBrain } from "./brain/index.js";
import type { DraftPlan, ReasonCategory, ShopStats } from "./brain/types.js";
import * as exec from "./executor.js";
import { cancelJob, enqueue } from "./jobs.js";
import { encrypt } from "./lib/crypto.js";
import { newId, requestKey, slugify } from "./lib/ids.js";
import { PayPalClient, paypalFor, forgetPayPalClient } from "./paypal/index.js";
import { describeRules, Rules, validateRules } from "./policy/rules.js";
import { discountedPrice, eligibleOffers, EligibleOffer, money } from "./policy/eligibility.js";
import {
  currentPolicy, intervalMs, intervalWords, KeptError, logEvent, Merchant, merchantById, offerById, openOfferFor, Plan, planById, plansFor,
  Subscriber, subscriberById, subscriberByRef, subscribersFor, toOffer, updateSubscriber,
} from "./store.js";
import { gate, GateDenied, guardSettings, HeldForApproval, type MoneyMove } from "./guard/dryrun.js";
import { register as registerProvenance } from "./guard/provenance.js";
import { appendAudit } from "./guard/audit.js";
import { quarantine } from "./ai/grounding.js";
import { startRun, type Actor as TraceActor, type Run } from "./trace.js";
import { notifyParty } from "./channels/index.js";
import type { Jurisdiction } from "./policy/compliance.js";

export interface Actor {
  kind: "agent" | "web" | "owner" | "system";
  agentId?: string;
}

const actorLabel = (a: Actor) => (a.kind === "agent" ? `agent ${a.agentId ?? "unknown"}` : a.kind);
const TERMINAL = ["CANCELLED", "EXPIRED"];
/** Kill-switch and autonomy scope of an actor: "agent:<id>", "web" (the subscriber), "owner", "system". */
const scopeOf = (a: Actor) => (a.kind === "agent" ? `agent:${a.agentId ?? "anonymous-agent"}` : a.kind);
const traceActor = (a: Actor): TraceActor => (a.kind === "agent" ? "agent" : a.kind === "web" ? "subscriber" : a.kind === "owner" ? "owner" : "system");
/** A person's own click (web or owner) is customer-initiated; an agent or the worker is not. */
const byHand = (a: Actor) => a.kind === "web" || a.kind === "owner";

/**
 * Every money move runs inside a trace run (roadmap B.2). The run ends "held" when the gate held it for the owner,
 * "failed" on any other error, "done" otherwise. A run passed in from outside is reused, so one agent request
 * that triggers several moves shows as one run.
 */
async function withRun<T>(input: { actor: Actor; merchantId: string | null; subject: string; entity?: string; entityId?: string; run?: Run | null }, fn: (run: Run) => Promise<T>): Promise<T> {
  if (input.run) return fn(input.run);
  const run = await startRun({ actor: traceActor(input.actor), agentId: input.actor.agentId ?? null, merchantId: input.merchantId, subject: input.subject, entity: input.entity, entityId: input.entityId });
  try {
    const out = await fn(run);
    await run.end("done");
    // Callers that return a plain object get the run id attached so API/MCP responses can link the trace.
    if (out && typeof out === "object" && !Array.isArray(out) && !("runId" in (out as object))) (out as any).runId = run.id;
    return out;
  } catch (e) {
    await run.end(e instanceof HeldForApproval ? "held" : "failed");
    throw e;
  }
}

/** Maps gate exceptions to the KeptError the API, web and MCP layers already understand. */
function gated<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof HeldForApproval) throw new KeptError(`Held for the owner: ${e.message}`, "held", 409, { approvalId: e.approvalId });
    if (e instanceof GateDenied) throw new KeptError(`Refused before PayPal: ${e.message}`, e.code, 409);
    throw e;
  });
}

async function moveFor(m: Merchant, s: Subscriber, actor: Actor, action: MoneyMove["action"], extra: Partial<MoneyMove> = {}): Promise<MoneyMove> {
  const p = await currentPolicy(await getDb(), m.id);
  return { action, merchantId: m.id, agentScope: scopeOf(actor), entity: "subscriber", entityId: s.id, paypalSubscriptionId: s.paypal_subscription_id, merchant: m, rules: p?.rules ?? null, jurisdiction: ((s as any).jurisdiction as Jurisdiction | null) ?? p?.rules.jurisdiction ?? null, customerInitiated: byHand(actor), ...extra };
}

/* ----------------------------------------------------------------------------------------------
 * Merchants, plans and rules
 * -------------------------------------------------------------------------------------------- */

export async function createMerchant(input: {
  name: string;
  tagline?: string;
  currency?: string;
  ownerEmail?: string | null;
  payerId?: string | null;
  credentials?: { clientId: string; clientSecret: string; env: "sandbox" | "live" } | null;
}): Promise<Merchant> {
  const db = await getDb();
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new KeptError("Give your shop a name.", "invalid_name");
  const currency = (input.currency || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new KeptError("Currency must be a 3-letter code such as USD.", "invalid_currency");
  if (input.credentials) {
    try {
      await new PayPalClient(input.credentials).verifyCredentials();
    } catch (e) {
      throw new KeptError(`Those PayPal credentials didn't work: ${(e as Error).message}`, "bad_credentials");
    }
  }
  let slug = slugify(name);
  for (let i = 2; (await db.query("SELECT 1 FROM merchants WHERE slug = $1", [slug])).rows.length; i++) slug = `${slugify(name)}-${i}`;
  const m: Merchant = {
    id: newId("mer"),
    slug,
    name,
    tagline: (input.tagline ?? "").slice(0, 140),
    currency,
    owner_email: input.ownerEmail ?? null,
    paypal_payer_id: input.payerId ?? null,
    paypal_env: input.credentials?.env ?? config.paypal.env,
    paypal_credentials: input.credentials ? encrypt(JSON.stringify({ clientId: input.credentials.clientId, clientSecret: input.credentials.clientSecret })) : null,
    paypal_product_id: null,
    owner_token: newId("own", 24),
    created_at: new Date(),
  };
  await db.query(
    "INSERT INTO merchants (id, slug, name, tagline, currency, owner_email, paypal_payer_id, paypal_env, paypal_credentials, owner_token) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [m.id, m.slug, m.name, m.tagline, m.currency, m.owner_email, m.paypal_payer_id, m.paypal_env, m.paypal_credentials, m.owner_token],
  );
  forgetPayPalClient(m.id);
  await logEvent(db, { merchantId: m.id, source: "owner", type: "merchant.created", summary: `Shop "${name}" created` });
  return m;
}

export async function previewPlans(text: string, currency: string) {
  const d = await getBrain().draftPlans(text, currency);
  return { ...d, brain: getBrain().lastVia() };
}

async function ensureProduct(m: Merchant): Promise<string> {
  if (m.paypal_product_id) return m.paypal_product_id;
  const db = await getDb();
  const out = await paypalFor(m).createProduct({ name: m.name, description: m.tagline || `${m.name} subscriptions` }, requestKey("product", m.id));
  await db.query("UPDATE merchants SET paypal_product_id = $2 WHERE id = $1", [m.id, out.id]);
  await logEvent(db, { merchantId: m.id, source: "executor", type: "paypal.product.created", summary: `PayPal catalog product ${out.id} created`, paypal: out });
  m.paypal_product_id = out.id;
  return out.id;
}

async function createPayPalPlan(m: Merchant, p: { name: string; description: string; price: number; intervalUnit: string; intervalCount: number; kind: Plan["kind"]; basePlanId?: string | null; discountPercent?: number | null }): Promise<Plan> {
  const db = await getDb();
  const productId = await ensureProduct(m);
  const id = newId("pln");
  const out = await paypalFor(m).createPlan(
    { productId, name: p.name, description: p.description, price: money(p.price), currency: m.currency, intervalUnit: p.intervalUnit as any, intervalCount: p.intervalCount },
    requestKey("plan", m.id, p.name, money(p.price), p.intervalUnit, p.intervalCount, p.basePlanId ?? "", p.discountPercent ?? ""),
  );
  await db.query(
    "INSERT INTO plans (id, merchant_id, paypal_plan_id, name, description, kind, base_plan_id, discount_percent, price, interval_unit, interval_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (paypal_plan_id) DO NOTHING",
    [id, m.id, out.id, p.name, p.description, p.kind, p.basePlanId ?? null, p.discountPercent ?? null, money(p.price), p.intervalUnit, p.intervalCount],
  );
  await logEvent(db, { merchantId: m.id, source: "executor", type: "paypal.plan.created", summary: `PayPal plan ${out.id} created for ${p.name} (${money(p.price)} ${m.currency})`, paypal: out });
  return (await planById(db, id)) ?? (await db.query("SELECT * FROM plans WHERE paypal_plan_id = $1", [out.id])).rows.map((r: any) => ({ ...r, price: Number(r.price) }))[0];
}

export async function createPlans(merchantId: string, drafts: DraftPlan[]): Promise<Plan[]> {
  const db = await getDb();
  const m = await merchantById(db, merchantId);
  if (!m) throw new KeptError("Shop not found.", "not_found", 404);
  if (!drafts.length) throw new KeptError("Add at least one plan.", "no_plans");
  if (drafts.length > 6) throw new KeptError("At most 6 plans per shop.", "too_many_plans");
  const out: Plan[] = [];
  for (const d of drafts) {
    if (!(d.price >= 1 && d.price <= 10000)) throw new KeptError(`Price for ${d.name} must be between 1 and 10,000.`, "invalid_price");
    out.push(await createPayPalPlan(m, { ...d, kind: d.kind }));
  }
  // Existing discount rules need promo plans for any new base plan.
  const policy = await currentPolicy(db, m.id);
  if (policy?.rules.discount.enabled) await ensurePromoPlans(m, policy.rules);
  return out;
}

/**
 * Policy replay: before approving new rules, run them against the shop's real past cancellation requests and show
 * which customers would have been offered something different (or nothing). Cancelling stays one step either way.
 */
export async function replayRules(merchantId: string, draftRules: unknown) {
  const db = await getDb();
  const check = validateRules(draftRules);
  if (!check.ok) return { cases: 0, changed: 0, rows: [] as { name: string; reason: string; before: string; after: string; changed: boolean }[] };
  const current = await currentPolicy(db, merchantId);
  const plans = await plansFor(db, merchantId, true);
  const brain = getBrain();
  const past = (await db.query<any>("SELECT f.*, s.status AS s_status, s.plan_id, s.home_plan_id, s.started_at, s.subscriber_name FROM feedback f JOIN subscribers s ON s.id = f.subscriber_id WHERE f.merchant_id = $1 ORDER BY f.created_at DESC LIMIT 50", [merchantId])).rows;
  // What a real request saw at that moment: its skips and its last accepted offer before then (the cooldown).
  const history = new Map<string, { skips: Date[]; lastAccepted: Date | null }>();
  for (const f of past) {
    const at = new Date(f.created_at);
    const skips = (await skipsFor(f.subscriber_id)).filter((d: Date) => new Date(d).getTime() < at.getTime());
    const last = (await db.query<{ decided_at: Date }>("SELECT decided_at FROM offers WHERE subscriber_id = $1 AND status = 'accepted' AND decided_at < $2 ORDER BY decided_at DESC LIMIT 1", [f.subscriber_id, at])).rows[0]?.decided_at ?? null;
    history.set(f.id, { skips, lastAccepted: last ? new Date(last) : null });
  }
  const pick = (rules: any, f: any) => {
    if (!rules) return "no offer (no rules)";
    const h = history.get(f.id)!;
    const eligible = eligibleOffers({ rules, subscriber: { status: f.s_status === "CANCELLED" ? "ACTIVE" : f.s_status, plan_id: f.plan_id, home_plan_id: f.home_plan_id, started_at: f.started_at }, plans, skipsAt: h.skips, lastOfferAcceptedAt: h.lastAccepted, now: new Date(f.created_at) });
    const c = brain.pickOffer(eligible, f.category);
    return eligible.find((o) => o.key === c.key)?.label ?? "no offer";
  };
  const rows = past.map((f) => {
    const before = pick(current?.rules ?? null, f);
    const after = pick(check.rules, f);
    return { name: f.subscriber_name ?? "Subscriber", reason: f.text, before, after, changed: before !== after };
  });
  return { cases: rows.length, changed: rows.filter((r) => r.changed).length, rows };
}

export async function previewRules(text: string) {
  const draft = await getBrain().draftRules(text);
  const check = validateRules(draft.value);
  return { ...draft, brain: getBrain().lastVia(), valid: check.ok, errors: check.errors, description: check.ok ? describeRules(check.rules!) : [] };
}

async function ensurePromoPlans(m: Merchant, rules: Rules) {
  const db = await getDb();
  const plans = await plansFor(db, m.id, true);
  for (const base of plans.filter((p) => p.kind !== "promo" && p.active)) {
    const exists = plans.find((p) => p.kind === "promo" && p.base_plan_id === base.id && p.discount_percent === rules.discount.percent);
    if (exists) continue;
    await createPayPalPlan(m, {
      name: `${base.name} (${rules.discount.percent}% off)`,
      description: `${base.name} at ${rules.discount.percent}% off, retention offer`,
      price: discountedPrice(base.price, rules.discount.percent),
      intervalUnit: base.interval_unit,
      intervalCount: base.interval_count,
      kind: "promo",
      basePlanId: base.id,
      discountPercent: rules.discount.percent,
    });
  }
}

export async function approveRules(merchantId: string, rules: unknown, sourceText: string, notes: string[] = []) {
  const db = await getDb();
  const m = await merchantById(db, merchantId);
  if (!m) throw new KeptError("Shop not found.", "not_found", 404);
  const check = validateRules(rules);
  if (!check.ok) throw new KeptError(`These rules can't be approved: ${check.errors.join(" ")}`, "invalid_rules", 422, check.errors);
  const prev = await currentPolicy(db, m.id);
  const version = (prev?.version ?? 0) + 1;
  if (check.rules!.discount.enabled) await ensurePromoPlans(m, check.rules!);
  await db.query("INSERT INTO policies (id, merchant_id, version, rules, source_text, notes, approved_at) VALUES ($1,$2,$3,$4,$5,$6, now())", [
    newId("pol"), m.id, version, JSON.stringify(check.rules), sourceText.slice(0, 4000), JSON.stringify(notes),
  ]);
  await logEvent(db, { merchantId: m.id, source: "owner", type: "policy.approved", summary: `Retention rules v${version} approved`, payload: check.rules });
  await appendAudit("policy.approved", "merchant", m.id, { version, rules: check.rules });
  return { version, rules: check.rules!, description: describeRules(check.rules!) };
}

/* ----------------------------------------------------------------------------------------------
 * Subscriptions
 * -------------------------------------------------------------------------------------------- */

async function load(ref: string) {
  const db = await getDb();
  const s = await subscriberByRef(db, ref);
  if (!s) throw new KeptError("No subscription with that reference.", "not_found", 404);
  const m = (await merchantById(db, s.merchant_id))!;
  return { db, s, m };
}

function assertLive(s: Subscriber) {
  if (s.is_sample) throw new KeptError("This is a labelled sample subscriber; it has no PayPal subscription to change.", "sample_row", 409);
}

export async function startSubscription(m: Merchant, planId: string, who: { name?: string | null; email?: string | null }, actor: Actor, key = newId("k")) {
  const db = await getDb();
  const plan = await planById(db, planId);
  if (!plan || plan.merchant_id !== m.id || !plan.active || plan.kind === "promo") throw new KeptError("That plan isn't available. Call list_plans for current plans.", "invalid_plan", 404);
  if (who.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who.email)) throw new KeptError("That email address doesn't look right.", "invalid_email");
  // An agent retrying with the same key gets the subscription it already started, never a second one.
  const prior = (await db.query<any>("SELECT * FROM subscribers WHERE merchant_id = $1 AND start_key = $2", [m.id, key])).rows[0];
  if (prior) {
    if (prior.plan_id !== plan.id) throw new KeptError("That key was already used to start a different subscription.", "key_reused", 409);
    return { ref: prior.ref, subscriberId: prior.id, paypalSubscriptionId: prior.paypal_subscription_id, approvalUrl: prior.approval_url, plan };
  }
  const s: Partial<Subscriber> = {
    id: newId("sub"),
    ref: newId("ref", 20),
    merchant_id: m.id,
    plan_id: plan.id,
    home_plan_id: plan.id,
    status: "CREATED",
    subscriber_name: who.name?.slice(0, 80) ?? null,
    subscriber_email: who.email?.slice(0, 120) ?? null,
    channel: actor.kind === "agent" ? "agent" : "web",
    agent_id: actor.agentId ?? null,
  };
  await db.query(
    "INSERT INTO subscribers (id, ref, merchant_id, plan_id, home_plan_id, status, subscriber_name, subscriber_email, channel, agent_id, start_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [s.id, s.ref, s.merchant_id, s.plan_id, s.home_plan_id, s.status, s.subscriber_name, s.subscriber_email, s.channel, s.agent_id, key],
  );
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "subscription.requested", summary: `${actorLabel(actor)} started a subscription to ${plan.name}` });
  const sub = (await subscriberById(db, s.id!))!;
  return withRun({ actor, merchantId: m.id, subject: `start subscription to ${plan.name}`, entity: "subscriber", entityId: sub.id }, async (run) => {
    await updateSubscriber(db, sub.id, { run_id: run.id } as any);
    await run.step({ actor: "code", tool: "plan.validate", args: { planId: plan.id }, result: { price: money(plan.price), currency: m.currency }, gate: "n/a" });
    await gated(() => gate({ action: "subscribe", merchantId: m.id, agentScope: scopeOf(actor), entity: "subscriber", entityId: sub.id, merchant: m, customerInitiated: byHand(actor) }, run));
    const out = await run.timed({ actor: "paypal", tool: "subscriptions.create", args: { planId: plan.paypal_plan_id }, pp_request_id: requestKey("create-sub", sub.id, key) }, () => exec.createSubscription(db, m, sub, plan, key), (r) => ({ paypalId: r.paypalId, approval: Boolean(r.approveUrl) }));
    return { ref: sub.ref, subscriberId: sub.id, paypalSubscriptionId: out.paypalId, approvalUrl: out.approveUrl, plan, runId: run.id };
  });
}

/** Called when PayPal sends the subscriber back, and by the worker/webhooks: reads PayPal and settles Kept's state. */
export async function syncSubscription(ref: string, source = "system") {
  const { db, s, m } = await load(ref);
  if (s.is_sample) return s;
  const before = s.status;
  const { sub } = await exec.readBack(db, m, s);
  if (before !== "ACTIVE" && sub.status === "ACTIVE" && !s.started_at) {
    await logEvent(db, { merchantId: m.id, subscriberId: s.id, source, type: "subscription.activated", summary: `Subscription active (${sub.subscriber_email ?? "subscriber"})` });
  }
  if (sub.kept_state?.startsWith("switch_pending:") || sub.kept_state?.startsWith("switch_scheduled:")) {
    const target = sub.kept_state.split(":")[1];
    if (sub.plan_id === target) {
      await updateSubscriber(db, s.id, { kept_state: null, approval_url: null });
      // A discount the subscriber has now approved at PayPal: start its period and count it as kept.
      const o = (await db.query<any>("SELECT * FROM offers WHERE subscriber_id = $1 AND status = 'accepted' AND consent_pending = true ORDER BY decided_at DESC LIMIT 1", [s.id])).rows[0];
      if (o) {
        const terms = typeof o.terms === "string" ? JSON.parse(o.terms) : o.terms;
        const home = await planById(db, sub.home_plan_id ?? "");
        if (home) await startPromo(m, (await subscriberById(db, s.id))!, home, terms.cycles ?? 1);
        await db.query("UPDATE offers SET consent_pending = false WHERE id = $1", [o.id]);
        await db.query("UPDATE feedback SET outcome = 'kept' WHERE subscriber_id = $1 AND outcome = 'awaiting_consent'", [s.id]);
        await logEvent(db, { merchantId: m.id, subscriberId: s.id, source, type: "offer.confirmed", summary: "PayPal confirms the discount plan; the discount period starts now" });
      }
    }
  }
  await recordPayments(m, sub);
  return (await subscriberById(db, s.id))!;
}

async function recordPayments(m: Merchant, s: Subscriber) {
  if (!s.paypal_subscription_id || s.is_sample) return;
  const db = await getDb();
  try {
    const start = new Date(Date.now() - 400 * 864e5).toISOString();
    const txns = await paypalFor(m).listSubscriptionTransactions(s.paypal_subscription_id, start, new Date().toISOString());
    for (const t of txns) {
      const gross = t.amount_with_breakdown?.gross_amount;
      if (!gross) continue;
      await db.query(
        "INSERT INTO payments (id, merchant_id, subscriber_id, amount, currency, status, paid_at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'paypal') ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status",
        [t.id, m.id, s.id, gross.value, gross.currency_code, t.status, new Date(t.time)],
      );
    }
  } catch {
    /* transactions can lag right after approval; the daily reconcile retries */
  }
}

async function rulesFor(m: Merchant): Promise<{ rules: Rules; version: number } | null> {
  const p = await currentPolicy(await getDb(), m.id);
  return p ? { rules: p.rules, version: p.version } : null;
}

async function skipsFor(subscriberId: string): Promise<Date[]> {
  const db = await getDb();
  const r = await db.query<{ created_at: Date }>("SELECT created_at FROM event_log WHERE subscriber_id = $1 AND type = 'skip.scheduled' ORDER BY id DESC", [subscriberId]);
  return r.rows.map((x) => new Date(x.created_at));
}

function resumeTime(s: Subscriber, plan: Plan, cycles: number): Date {
  const iv = intervalMs(plan);
  const next = s.next_billing_time && s.next_billing_time.getTime() > Date.now() ? s.next_billing_time.getTime() : Date.now() + iv;
  // Stay suspended through `cycles` billing dates, then resume one hour after the last skipped date.
  return new Date(next + (cycles - 1) * iv + 3600_000);
}

async function suspendFor(m: Merchant, s: Subscriber, cycles: number, reason: string, actor: Actor, key: string, eventType: string, run: Run | null = null) {
  const db = await getDb();
  const plan = (await planById(db, s.plan_id!))!;
  let sub = s;
  if (s.status === "ACTIVE") {
    const action = eventType.startsWith("skip") ? "skip" : "pause";
    await gated(async () => gate(await moveFor(m, s, actor, action, { offer: { type: action, cycles } }), run));
    sub = run ? await run.timed({ actor: "paypal", tool: "subscriptions.suspend", args: { reason }, pp_request_id: requestKey("suspend", s.id, key) }, () => exec.suspend(db, m, s, reason, key), (r) => ({ status: r.status })) : await exec.suspend(db, m, s, reason, key);
  } else if (s.status !== "SUSPENDED") throw new KeptError(`A ${s.status.toLowerCase()} subscription can't be paused.`, "invalid_state", 409);
  const resumeAt = resumeTime(s, plan, cycles);
  await updateSubscriber(db, s.id, { resume_at: resumeAt });
  await enqueue(db, "reactivate", { subscriberId: s.id }, resumeAt, `reactivate:${s.id}`);
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: eventType, summary: `${actorLabel(actor)}: ${reason}; resumes ${resumeAt.toISOString().slice(0, 16).replace("T", " ")} UTC`, payload: { cycles, resumeAt } });
  return { sub: (await subscriberById(db, s.id))!, resumeAt };
}

export async function skipNext(ref: string, actor: Actor, key = newId("k")) {
  const { m, s } = await load(ref);
  assertLive(s);
  const p = await rulesFor(m);
  if (!p?.rules.skip.enabled) throw new KeptError(`${m.name} doesn't offer skips.`, "not_allowed", 403);
  if (s.status !== "ACTIVE") throw new KeptError("Only an active subscription can skip a renewal.", "invalid_state", 409);
  const used = (await skipsFor(s.id)).filter((d) => Date.now() - d.getTime() < p.rules.skip.periodDays * 864e5).length;
  if (used >= p.rules.skip.maxPerPeriod) throw new KeptError(`Skip limit reached: ${p.rules.skip.maxPerPeriod} per ${p.rules.skip.periodDays} days.`, "limit_reached", 403);
  return withRun({ actor, merchantId: m.id, subject: "skip next renewal", entity: "subscriber", entityId: s.id }, (run) => suspendFor(m, s, 1, "Skip next renewal", actor, key, "skip.scheduled", run));
}

export async function pause(ref: string, cycles: number, actor: Actor, key = newId("k")) {
  const { m, s } = await load(ref);
  assertLive(s);
  const p = await rulesFor(m);
  if (!p?.rules.pause.enabled) throw new KeptError(`${m.name} doesn't offer pauses.`, "not_allowed", 403);
  if (!(cycles >= 1 && cycles <= p.rules.pause.maxCycles)) throw new KeptError(`Pauses can be 1 to ${p.rules.pause.maxCycles} cycles.`, "invalid_cycles", 422);
  return withRun({ actor, merchantId: m.id, subject: `pause ${cycles} cycle(s)`, entity: "subscriber", entityId: s.id }, (run) => suspendFor(m, s, cycles, `Pause for ${cycles} cycle${cycles > 1 ? "s" : ""}`, actor, key, "pause.scheduled", run));
}

export async function resume(ref: string, actor: Actor, key = newId("k")) {
  const { db, m, s } = await load(ref);
  assertLive(s);
  if (s.status !== "SUSPENDED") throw new KeptError("Only a paused subscription can be resumed.", "invalid_state", 409);
  return withRun({ actor, merchantId: m.id, subject: "resume", entity: "subscriber", entityId: s.id }, async (run) => {
    await gated(async () => gate(await moveFor(m, s, actor, "resume"), run));
    const sub = await run.timed({ actor: "paypal", tool: "subscriptions.activate", pp_request_id: requestKey("activate", s.id, key) }, () => exec.activate(db, m, s, `Resumed by ${actorLabel(actor)}`, key), (r) => ({ status: r.status }));
    await updateSubscriber(db, s.id, { resume_at: null });
    await cancelJob(db, `reactivate:${s.id}`);
    await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "subscription.resumed", summary: `${actorLabel(actor)} resumed the subscription` });
    return (await subscriberById(db, sub.id))!;
  });
}

export async function switchPlan(ref: string, planId: string, actor: Actor, key = newId("k"), parentRun: Run | null = null) {
  const { db, m, s } = await load(ref);
  assertLive(s);
  const target = await planById(db, planId);
  if (!target || target.merchant_id !== m.id || !target.active || target.kind === "promo") throw new KeptError("That plan isn't available to switch to.", "invalid_plan", 404);
  if (target.id === s.plan_id) throw new KeptError("Already on that plan.", "no_change", 409);
  if (!["ACTIVE", "SUSPENDED"].includes(s.status)) throw new KeptError(`A ${s.status.toLowerCase()} subscription can't change plan.`, "invalid_state", 409);
  return withRun({ actor, merchantId: m.id, subject: `switch to ${target.name}`, entity: "subscriber", entityId: s.id, run: parentRun }, async (run) => {
    await gated(async () => gate(await moveFor(m, s, actor, "switch"), run));
    const out = await run.timed({ actor: "paypal", tool: "subscriptions.revise", args: { toPlan: target.paypal_plan_id }, pp_request_id: requestKey("revise", s.id, target.id, key) }, () => exec.revise(db, m, s, target, key), (r) => ({ confirmed: r.confirmed, consent: Boolean(r.approveUrl) }));
    await updateSubscriber(db, s.id, { home_plan_id: target.id, promo_until: null });
    await cancelJob(db, `revert:${s.id}`);
    await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "plan.switched", summary: `${actorLabel(actor)} switched to ${target.name}${out.approveUrl ? " (waiting for subscriber approval on PayPal)" : ""}` });
    return { sub: (await subscriberById(db, s.id))!, approvalUrl: out.approveUrl, confirmed: out.confirmed, plan: target };
  });
}

/* ----------------------------------------------------------------------------------------------
 * Cancel, with one optional offer. Cancelling is never blocked.
 * -------------------------------------------------------------------------------------------- */

async function doCancel(m: Merchant, s: Subscriber, reason: string, actor: Actor, key: string, category: ReasonCategory | null, run: Run | null = null) {
  const db = await getDb();
  // The gate never holds or denies a cancel for rules, autonomy or an agent kill switch; only the global kill, and
  // then cancelDurably marks it pending and retries. Cancelling is the subscriber's right.
  await gate(await moveFor(m, s, actor, "cancel"), run);
  const sub = run
    ? await run.timed({ actor: "paypal", tool: "subscriptions.cancel", args: { reason: reason.slice(0, 80) }, pp_request_id: requestKey("cancel", s.id, key) }, () => exec.cancel(db, m, s, reason ? `Subscriber: ${reason}` : `Cancelled by ${actorLabel(actor)}`, key), (r) => ({ status: r.status }))
    : await exec.cancel(db, m, s, reason ? `Subscriber: ${reason}` : `Cancelled by ${actorLabel(actor)}`, key);
  await updateSubscriber(db, s.id, { resume_at: null, kept_state: null });
  await cancelJob(db, `reactivate:${s.id}`);
  await cancelJob(db, `revert:${s.id}`);
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "subscription.cancelled", summary: `${actorLabel(actor)} cancelled${category ? ` (reason: ${category})` : ""}; done in one step`, payload: { reason } });
  return sub;
}

/**
 * A cancellation is a durable command: it is reported done only when PayPal reads back CANCELLED. If PayPal fails
 * or doesn't confirm, the subscriber shows "cancellation pending" and a job retries with the same key until it does.
 */
async function cancelDurably(m: Merchant, s: Subscriber, reason: string, actor: Actor, key: string, category: ReasonCategory | null, run: Run | null = null) {
  const db = await getDb();
  try {
    const sub = await doCancel(m, s, reason, actor, key, category, run);
    if ((s as any).cancel_requested_at) await updateSubscriber(db, s.id, { cancel_requested_at: null } as any);
    return { status: "cancelled" as const, subscription: sub, note: "Cancelled. No further charges." };
  } catch (e) {
    await updateSubscriber(db, s.id, { kept_state: "cancel_pending", cancel_requested_at: new Date() } as any);
    await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "system", type: "cancel.pending", summary: `Cancellation requested by ${actorLabel(actor)}; PayPal has not confirmed it (${(e as Error).message.slice(0, 120)}). Kept retries until PayPal shows it cancelled.` });
    await enqueue(db, "retry_cancel", { subscriberId: s.id, key, reason, category, actor: actor.kind, attempt: 1 }, new Date(Date.now() + 60_000), `cancel:${s.id}`);
    return { status: "cancel_pending" as const, subscription: s, note: "Cancellation requested. PayPal hasn't confirmed it yet; Kept keeps retrying and you won't be told it's done until PayPal confirms." };
  }
}

/**
 * Job: retry a pending cancellation with its original key until PayPal confirms it. It never gives up: failures
 * back off (capped at 30 minutes) and, after five, the owner is alerted. The intent lives in its own column, so a
 * failed read or any other state change can't erase it.
 */
export async function retryCancel(p: { subscriberId: string; key: string; reason: string; category: ReasonCategory | null; attempt?: number }) {
  const db = await getDb();
  const s = await subscriberById(db, p.subscriberId);
  if (!s || !(s as any).cancel_requested_at) return;
  const m = (await merchantById(db, s.merchant_id))!;
  const attempt = p.attempt ?? 1;
  try {
    const { sub, pp } = await exec.readBack(db, m, s);
    if (pp && sub.status === "CANCELLED") {
      await updateSubscriber(db, s.id, { kept_state: null, resume_at: null, cancel_requested_at: null } as any);
      await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "system", type: "subscription.cancelled", summary: "PayPal confirms the pending cancellation" });
      return;
    }
    if (!pp) throw new Error("PayPal could not be read");
    await doCancel(m, sub, p.reason, { kind: "system" }, p.key, p.category);
    await updateSubscriber(db, s.id, { kept_state: null, cancel_requested_at: null } as any);
  } catch (e) {
    const delay = Math.min(30 * 60_000, 60_000 * 2 ** Math.min(attempt, 5));
    await updateSubscriber(db, s.id, { kept_state: "cancel_pending" } as any);
    await enqueue(db, "retry_cancel", { ...p, attempt: attempt + 1 }, new Date(Date.now() + delay), `cancel:${s.id}`);
    if (attempt === 5) await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "system", type: "cancel.stuck", summary: `Owner alert: PayPal has not confirmed this cancellation after 5 tries (${(e as Error).message.slice(0, 120)}). Kept keeps retrying; check the subscription in PayPal.` });
  }
}

export async function requestCancel(ref: string, opts: { reason?: string; hearOffer?: boolean }, actor: Actor, key = newId("k")) {
  const { db, m, s } = await load(ref);
  assertLive(s);
  if (TERMINAL.includes(s.status)) return { status: "cancelled" as const, subscription: s, offer: null, note: "Already cancelled." };
  return withRun({ actor, merchantId: m.id, subject: opts.hearOffer ? "cancel (willing to hear one offer)" : "cancel", entity: "subscriber", entityId: s.id }, async (run) => {
    if (s.status === "APPROVAL_PENDING" || s.status === "CREATED") {
      if (s.paypal_subscription_id) {
        const out = await cancelDurably(m, s, opts.reason ?? "", actor, key, null, run);
        if (out.status === "cancel_pending") return { ...out, offer: null };
      }
      await updateSubscriber(db, s.id, { status: "CANCELLED", cancelled_at: new Date() });
      return { status: "cancelled" as const, subscription: { ...s, status: "CANCELLED" }, offer: null, note: "The unapproved subscription was withdrawn." };
    }
    const brain = getBrain();
    const rawReason = (opts.reason ?? "").slice(0, 500);
    // The reason is outside text: registered with its provenance, and any instruction-shaped lines are quarantined
    // (shown to the owner, never used by the offer step or sent to a model).
    const { clean, quarantined } = quarantine(rawReason);
    if (rawReason) await registerProvenance(actor.kind === "agent" ? `agent ${actor.agentId}` : "subscriber", actor.kind === "agent" ? "agent" : "message", rawReason, "subscriber", s.id, db);
    if (quarantined.length) await run.step({ actor: "guard", tool: "quarantine", args: { lines: quarantined }, gate: "n/a", result: { note: "instruction-shaped text kept out of the offer step and the model" } });
    const reason = clean;
    const category = await brain.classifyReason(reason);
    await run.step({ actor: brain.lastVia() === "rules" ? "code" : "model", tool: "classify_reason", args: { reason: reason.slice(0, 120) }, result: { category, via: brain.lastVia() }, gate: "n/a" });
    if (rawReason) {
      await db.query("INSERT INTO feedback (id, merchant_id, subscriber_id, text, category) VALUES ($1,$2,$3,$4,$5)", [newId("fb"), m.id, s.id, rawReason, category]);
    }
    const existing = await openOfferFor(db, s.id);
    if (existing && opts.hearOffer) return { status: "offer_open" as const, subscription: s, offer: offerView(existing), note: "An offer is already open; respond to it, or decline to cancel now." };
    if (existing) {
      // A direct cancellation overrides an open offer: the offer closes and the cancel goes ahead.
      await db.query("UPDATE offers SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'open'", [existing.id]);
      await cancelJob(db, `offer:${existing.id}`);
      await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "offer.declined", summary: `${actorLabel(actor)} asked to cancel directly; the open offer was closed` });
    }

    if (opts.hearOffer) {
      // Anything that goes wrong while preparing an offer falls through to the cancel. Cancelling is never blocked.
      try {
        const policy = await rulesFor(m);
        if (policy) {
          const plans = await plansFor(db, m.id, true);
          const lastAccepted = (await db.query<{ decided_at: Date }>("SELECT decided_at FROM offers WHERE subscriber_id = $1 AND status = 'accepted' ORDER BY decided_at DESC LIMIT 1", [s.id])).rows[0]?.decided_at ?? null;
          const eligible = eligibleOffers({
            rules: policy.rules,
            subscriber: { status: s.status, plan_id: s.plan_id, home_plan_id: s.home_plan_id, started_at: s.started_at },
            plans,
            skipsAt: await skipsFor(s.id),
            lastOfferAcceptedAt: lastAccepted ? new Date(lastAccepted) : null,
            maxPauseCycles: (await guardSettings(m.id)).auto_pause_max_cycles,
          });
          const choice = brain.pickOffer(eligible, category);
          const chosen = eligible.find((o) => o.key === choice.key);
          await run.step({ actor: "code", tool: "eligibility", args: { category }, result: { eligible: eligible.map((o) => o.key), chosen: chosen?.key ?? null, rationale: choice.rationale }, policy: `rules v${policy.version}`, gate: "n/a" });
          if (chosen) {
            // The offer step is a money move: rules, autonomy and the compliance scorecard are checked in code first.
            try {
              await gate(await moveFor(m, s, actor, "offer", { entity: "subscriber", entityId: s.id, offer: { type: chosen.type, percent: chosen.terms.percent, cycles: chosen.terms.cycles }, cents: Math.round(chosen.perCycleValue * 100), customerInitiated: false }), run);
              const offer = await createOffer(m, s, chosen, category, policy.version, policy.rules.offerExpiryMinutes, choice.rationale, run.id);
              return { status: "offer_open" as const, subscription: s, offer: offerView(offer), note: "Accept with respond_to_offer(accept=true). Decline, or let it expire, and the subscription is cancelled straight away." };
            } catch (e) {
              if (e instanceof HeldForApproval) await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "guard", type: "offer.held", summary: `No offer made: ${e.message} The owner can approve it on the guard page to raise autonomy.`, payload: { approvalId: e.approvalId, key: chosen.key } });
              else if (e instanceof GateDenied) await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "guard", type: "offer.blocked", summary: `No offer made: ${e.message}`, payload: { key: chosen.key } });
              else throw e;
            }
          } else {
            await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "brain", type: "offer.none", summary: `No offer made: ${choice.rationale}` });
          }
        }
      } catch (e) {
        await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "system", type: "offer.error", summary: `Offer step failed, cancelling anyway: ${(e as Error).message}` });
      }
    }
    const out = await cancelDurably(m, s, reason, actor, key, rawReason ? category : null, run);
    if (out.status === "cancelled") await db.query("UPDATE feedback SET outcome = 'cancelled' WHERE subscriber_id = $1 AND outcome IS NULL", [s.id]);
    return { ...out, offer: null };
  });
}

async function createOffer(m: Merchant, s: Subscriber, o: EligibleOffer, category: ReasonCategory, version: number, expiryMinutes: number, rationale: string, runId: string | null = null) {
  const db = await getDb();
  const message = await getBrain().wordOffer(o, { merchantName: m.name, currency: m.currency, category, subscriberName: s.subscriber_name });
  const id = newId("ofr");
  const expires = new Date(Date.now() + expiryMinutes * 60_000);
  await db.query(
    "INSERT INTO offers (id, subscriber_id, merchant_id, policy_version, type, terms, message, reason_category, status, monthly_value, expires_at, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11)",
    [id, s.id, m.id, version, o.type, JSON.stringify({ ...o.terms, key: o.key, label: o.label, keptValue3: o.keptValue3, wordedBy: getBrain().lastVia() }), message, category, money(o.keptValue3), expires, runId],
  );
  await enqueue(db, "expire_offer", { offerId: id }, expires, `offer:${id}`);
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "brain", type: "offer.made", summary: `Offer made: ${o.label}. ${rationale}`, payload: { offerId: id, key: o.key } });
  return (await offerById(db, id))!;
}

export function offerView(o: ReturnType<typeof toOffer>) {
  return {
    offer_id: o.id,
    type: o.type,
    label: o.terms.label,
    message: o.message,
    terms: { cycles: o.terms.cycles, percent: o.terms.percent, new_price: o.terms.newPrice, to_plan: o.terms.toPlanName },
    expires_at: new Date(o.expires_at).toISOString(),
    status: o.status,
    if_declined: "The subscription is cancelled immediately.",
  };
}

export async function respondToOffer(offerId: string, accept: boolean, actor: Actor, key = newId("k")) {
  const db = await getDb();
  const o = await offerById(db, offerId);
  if (!o) throw new KeptError("No offer with that id.", "not_found", 404);
  const s = (await subscriberById(db, o.subscriber_id))!;
  const m = (await merchantById(db, o.merchant_id))!;
  if (o.status !== "open") throw new KeptError(`This offer is already ${o.status}.`, "offer_closed", 409, { status: o.status });
  if (new Date(o.expires_at).getTime() < Date.now()) {
    await expireOffer(o.id);
    throw new KeptError("This offer expired, so the subscription was cancelled as requested.", "offer_expired", 410);
  }
  await cancelJob(db, `offer:${o.id}`);
  return withRun({ actor, merchantId: m.id, subject: accept ? `accept offer ${o.terms.label}` : "decline offer", entity: "offer", entityId: o.id }, async (run) => {
    if (!accept) {
      await db.query("UPDATE offers SET status = 'declined', decided_at = now() WHERE id = $1", [o.id]);
      await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "offer.declined", summary: `${actorLabel(actor)} declined the offer` });
      const out = await cancelDurably(m, s, "", actor, key, (o.reason_category as ReasonCategory) ?? null, run);
      if (out.status === "cancelled") await db.query("UPDATE feedback SET outcome = 'cancelled' WHERE subscriber_id = $1 AND outcome IS NULL", [s.id]);
      return { status: out.status, subscription: out.subscription };
    }
    let result;
    try {
      result = await applyOffer(m, s, o, actor, key, run);
    } catch (e) {
      // The offer is still open: its expiry (and so the cancellation the subscriber asked for) must still happen.
      await enqueue(db, "expire_offer", { offerId: o.id }, new Date(o.expires_at), `offer:${o.id}`);
      throw e;
    }
    await db.query("UPDATE offers SET status = 'accepted', decided_at = now() WHERE id = $1", [o.id]);
    await db.query("UPDATE feedback SET outcome = $2 WHERE subscriber_id = $1 AND outcome IS NULL", [s.id, result.approvalUrl || (result as any).pending ? "awaiting_consent" : "kept"]);
    await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "offer.accepted", summary: `${actorLabel(actor)} accepted: ${o.terms.label}`, payload: { keptValue3: o.monthly_value } });
    await appendAudit("offer.accepted", "offer", o.id, { subscriberId: s.id, type: o.type, terms: o.terms, by: actorLabel(actor) });
    return { status: "kept" as const, subscription: (await subscriberById(db, s.id))!, ...result };
  });
}

/** Starts the discount period from the next charge after PayPal confirms the promo plan, and schedules the revert. */
async function startPromo(m: Merchant, s: Subscriber, home: Plan, cycles: number) {
  const db = await getDb();
  const next = s.next_billing_time && s.next_billing_time.getTime() > Date.now() ? s.next_billing_time.getTime() : Date.now() + intervalMs(home);
  const until = new Date(next + (cycles - 1) * intervalMs(home) + 3600_000);
  await updateSubscriber(db, s.id, { promo_until: until, home_plan_id: home.id });
  await enqueue(db, "revert_promo", { subscriberId: s.id }, until, `revert:${s.id}`);
  return until;
}

async function applyOffer(m: Merchant, s: Subscriber, o: ReturnType<typeof toOffer>, actor: Actor, key: string, run: Run) {
  const db = await getDb();
  // Accepting an offer is the subscriber's own decision, so these moves are customer-initiated: no autonomy hold.
  const asHand: Actor = actor.kind === "agent" ? { kind: "web" } : actor;
  switch (o.type) {
    case "pause":
      return { resumeAt: (await suspendFor(m, s, o.terms.cycles ?? 1, `Pause for ${o.terms.cycles} cycle(s) (offer)`, asHand, key, "pause.scheduled", run)).resumeAt };
    case "skip":
      return { resumeAt: (await suspendFor(m, s, 1, "Skip next renewal (offer)", asHand, key, "skip.scheduled", run)).resumeAt };
    case "switch_plan": {
      const out = await switchPlan(s.ref, o.terms.toPlanId, asHand, key, run);
      return { approvalUrl: out.approvalUrl };
    }
    case "discount": {
      const promo = await planById(db, o.terms.toPlanId);
      if (!promo) throw new KeptError("The discount plan is missing.", "plan_missing", 500);
      const home = (await planById(db, s.home_plan_id ?? s.plan_id!))!;
      await gated(async () => gate(await moveFor(m, s, asHand, "switch", { offer: { type: "discount", percent: o.terms.percent, cycles: o.terms.cycles } }), run));
      const out = await run.timed({ actor: "paypal", tool: "subscriptions.revise", args: { toPlan: promo.paypal_plan_id, discount: o.terms.percent }, pp_request_id: requestKey("revise", s.id, promo.id, key) }, () => exec.revise(db, m, s, promo, key), (r) => ({ confirmed: r.confirmed, consent: Boolean(r.approveUrl) }));
      await updateSubscriber(db, s.id, { home_plan_id: home.id });
      if (out.approveUrl) {
        // PayPal needs the subscriber's consent: the discount period starts only once PayPal shows the promo plan.
        await db.query("UPDATE offers SET consent_pending = true WHERE id = $1", [o.id]);
        return { approvalUrl: out.approveUrl, promoUntil: null };
      }
      const now = (await subscriberById(db, s.id))!;
      if (now.plan_id !== promo.id) {
        // Scheduled, not yet in effect: count it (and start its period) only once PayPal shows the promo plan.
        await db.query("UPDATE offers SET consent_pending = true WHERE id = $1", [o.id]);
        await updateSubscriber(db, s.id, { kept_state: `switch_pending:${promo.id}` });
        return { approvalUrl: null, promoUntil: null, pending: true };
      }
      return { approvalUrl: null, promoUntil: await startPromo(m, now, home, o.terms.cycles ?? 1) };
    }
  }
  throw new KeptError("Unknown offer type.", "bad_offer", 500);
}

export async function expireOffer(offerId: string) {
  const db = await getDb();
  const o = await offerById(db, offerId);
  if (!o || o.status !== "open") return;
  await db.query("UPDATE offers SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'open'", [o.id]);
  const s = (await subscriberById(db, o.subscriber_id))!;
  const m = (await merchantById(db, o.merchant_id))!;
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "system", type: "offer.expired", summary: "Offer expired with no answer; cancelling as originally requested" });
  if (!TERMINAL.includes(s.status)) await cancelDurably(m, s, "", { kind: "system" }, `expire-${o.id}`, (o.reason_category as ReasonCategory) ?? null);
}

/* ----------------------------------------------------------------------------------------------
 * Scheduled work
 * -------------------------------------------------------------------------------------------- */

export async function reactivate(subscriberId: string) {
  const db = await getDb();
  const s = await subscriberById(db, subscriberId);
  if (!s || s.is_sample) return;
  const m = (await merchantById(db, s.merchant_id))!;
  const { sub } = await exec.readBack(db, m, s);
  if (sub.status !== "SUSPENDED") {
    await updateSubscriber(db, s.id, { resume_at: null });
    return;
  }
  await withRun({ actor: { kind: "system" }, merchantId: m.id, subject: "scheduled resume", entity: "subscriber", entityId: s.id }, async (run) => {
    await gate(await moveFor(m, sub, { kind: "system" }, "resume"), run);
    await run.timed({ actor: "paypal", tool: "subscriptions.activate", pp_request_id: requestKey("activate", s.id, `resume-${s.id}-${s.resume_at?.toISOString()}`) }, () => exec.activate(db, m, sub, "Scheduled resume after skip or pause", `resume-${s.id}-${s.resume_at?.toISOString()}`), (r) => ({ status: r.status }));
  });
  await updateSubscriber(db, s.id, { resume_at: null });
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "scheduler", type: "subscription.resumed", summary: "Resumed on schedule" });
}

export async function revertPromo(subscriberId: string) {
  const db = await getDb();
  const s = await subscriberById(db, subscriberId);
  if (!s || s.is_sample || TERMINAL.includes(s.status)) return;
  const m = (await merchantById(db, s.merchant_id))!;
  const home = await planById(db, s.home_plan_id ?? "");
  const current = await planById(db, s.plan_id ?? "");
  if (!home || !current || current.kind !== "promo") return;
  await withRun({ actor: { kind: "system" }, merchantId: m.id, subject: "discount period over", entity: "subscriber", entityId: s.id }, async (run) => {
    await gate(await moveFor(m, s, { kind: "system" }, "switch"), run);
    await run.timed({ actor: "paypal", tool: "subscriptions.revise", args: { toPlan: home.paypal_plan_id }, pp_request_id: requestKey("revise", s.id, home.id, `revert-${s.id}-${s.promo_until?.toISOString()}`) }, () => exec.revise(db, m, s, home, `revert-${s.id}-${s.promo_until?.toISOString()}`), (r) => ({ confirmed: r.confirmed }));
  });
  await updateSubscriber(db, s.id, { promo_until: null });
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "scheduler", type: "promo.ended", summary: `Discount period over; back to ${home.name}` });
}

export async function handlePaymentFailed(subscriberId: string, source: string) {
  const db = await getDb();
  const s = await subscriberById(db, subscriberId);
  if (!s) return;
  const m = (await merchantById(db, s.merchant_id))!;
  let sub = s;
  if (!s.is_sample) sub = (await exec.readBack(db, m, s)).sub;
  const plan = await planById(db, sub.plan_id ?? "");
  const amount = sub.outstanding > 0 ? sub.outstanding : plan?.price ?? 0;
  const msg = await getBrain().explainPaymentFailure({ merchantName: m.name, amount, currency: m.currency, attempts: Math.max(1, sub.failed_payments), manageUrl: `${config.appUrl}/manage/${sub.ref}` });
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source, type: "payment.failed", summary: `Renewal of ${amount.toFixed(2)} ${m.currency} failed; subscriber told how to fix it`, payload: { message: msg, wordedBy: getBrain().lastVia() } });
  await notifyParty("subscriber", s.id, msg, [{ id: `fixed:${s.ref}`, label: "I fixed it" }, { id: `cancel:${s.ref}`, label: "Cancel instead" }], "subscriber", s.id, db);
  await updateSubscriber(db, s.id, { kept_state: "payment_failed" });
  await enqueue(db, "payment_followup", { subscriberId: s.id }, new Date(Date.now() + 24 * 3600_000), `followup:${s.id}`);
  return msg;
}

export async function paymentFixed(ref: string, actor: Actor, key = newId("k")) {
  const { db, m, s } = await load(ref);
  if (s.kept_state !== "payment_failed" && !(s.outstanding > 0)) return { sub: s, captured: null, note: "Nothing is owed on this subscription." };
  let out: { sub: Subscriber; captured: string | null; note: string };
  if (s.is_sample) out = { sub: s, captured: s.outstanding.toFixed(2), note: "Sample row: marked as collected." };
  else {
    out = await withRun({ actor, merchantId: m.id, subject: "collect outstanding balance", entity: "subscriber", entityId: s.id }, async (run) => {
      // The amount is PayPal's own outstanding balance (read back inside the gate and again by the executor).
      const { sub: fresh } = await exec.readBack(db, m, s);
      const cents = Math.round(fresh.outstanding * 100);
      if (cents <= 0) return { sub: fresh, captured: null, note: "PayPal shows nothing outstanding on this subscription." };
      await gated(async () => gate(await moveFor(m, fresh, actor, "capture", { cents, trustedCents: [cents] }), run));
      return run.timed({ actor: "paypal", tool: "subscriptions.capture", args: { amount: fresh.outstanding.toFixed(2) }, pp_request_id: requestKey("capture", s.id, fresh.outstanding.toFixed(2), key) }, () => exec.captureOutstanding(db, m, fresh, key), (r) => ({ captured: r.captured }));
    });
  }
  await updateSubscriber(db, s.id, { kept_state: null, outstanding: 0, failed_payments: 0 });
  await cancelJob(db, `followup:${s.id}`);
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "payment.recovered", summary: out.captured ? `Collected ${out.captured} ${m.currency} after payment method fix` : out.note });
  return out;
}

/**
 * After a failed renewal the subscriber can say when they'll sort it out. Reminders stay quiet until then; if the
 * date passes with the renewal still unpaid, one follow-up goes out. A promise is not a payment and changes no money.
 */
export async function promisePayment(ref: string, dateIso: string, actor: Actor) {
  const { db, m, s } = await load(ref);
  if (s.kept_state !== "payment_failed") throw new KeptError("Nothing is overdue on this subscription.", "nothing_due", 409);
  const until = new Date(`${dateIso}T23:59:00Z`);
  const days = (until.getTime() - Date.now()) / 864e5;
  if (Number.isNaN(until.getTime()) || days < 0 || days > 14) throw new KeptError("Pick a date within the next 14 days.", "bad_date", 400);
  await db.query("UPDATE subscribers SET promise_until = $2 WHERE id = $1", [s.id, until]);
  await enqueue(db, "payment_followup", { subscriberId: s.id }, until, `followup:${s.id}`);
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "payment.promised", summary: `${actorLabel(actor)} will fix the payment by ${dateIso}; reminders paused until then` });
  return { until };
}

export async function paymentFollowup(subscriberId: string) {
  const db = await getDb();
  const s = await subscriberById(db, subscriberId);
  if (!s || s.kept_state !== "payment_failed" || TERMINAL.includes(s.status)) return;
  const m = (await merchantById(db, s.merchant_id))!;
  const promised = (await db.query<{ promise_until: Date | null }>("SELECT promise_until FROM subscribers WHERE id = $1", [s.id])).rows[0]?.promise_until;
  if (promised && new Date(promised).getTime() > Date.now()) {
    await enqueue(db, "payment_followup", { subscriberId: s.id }, new Date(promised), `followup:${s.id}`);
    return; // quiet period: the subscriber said when they'll fix it
  }
  const sub = s.is_sample ? s : (await exec.readBack(db, m, s)).sub;
  if (!s.is_sample && sub.outstanding <= 0 && sub.failed_payments === 0) {
    await updateSubscriber(db, s.id, { kept_state: null });
    await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "scheduler", type: "payment.recovered", summary: "PayPal collected the renewal on its own retry" });
    return;
  }
  if (promised) await db.query("UPDATE subscribers SET promise_until = NULL WHERE id = $1", [s.id]);
  await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "scheduler", type: "payment.reminder", summary: promised ? "The promised date passed with the renewal still unpaid: one follow-up sent" : "Reminder sent: renewal still unpaid" });
}

export async function reconcileMerchant(merchantId: string) {
  const db = await getDb();
  const m = await merchantById(db, merchantId);
  if (!m) return { checked: 0, changed: 0 };
  const subs = (await subscribersFor(db, m.id)).filter((s) => !s.is_sample && s.paypal_subscription_id && !TERMINAL.includes(s.status));
  let changed = 0;
  for (const s of subs) {
    const after = await syncSubscription(s.ref, "reconcile");
    if (after.status !== s.status || after.plan_id !== s.plan_id) changed++;
  }
  await logEvent(db, { merchantId: m.id, source: "scheduler", type: "reconcile.done", summary: `Reconciled ${subs.length} subscriptions with PayPal; ${changed} changed` });
  return { checked: subs.length, changed };
}

/* ----------------------------------------------------------------------------------------------
 * Views and stats
 * -------------------------------------------------------------------------------------------- */

export async function subscriptionView(ref: string) {
  const { db, s, m } = await load(ref);
  const plan = s.plan_id ? await planById(db, s.plan_id) : null;
  const home = s.home_plan_id ? await planById(db, s.home_plan_id) : null;
  const offer = await openOfferFor(db, s.id);
  const policy = await rulesFor(m);
  const notice = s.kept_state === "payment_failed"
    ? (await db.query<{ payload: any }>("SELECT payload FROM event_log WHERE subscriber_id = $1 AND type = 'payment.failed' ORDER BY id DESC LIMIT 1", [s.id])).rows[0]?.payload?.message ?? null
    : null;
  const actions: string[] = [];
  if (s.status === "ACTIVE") {
    if (policy?.rules.skip.enabled) actions.push("skip_next");
    if (policy?.rules.pause.enabled) actions.push("pause");
    actions.push("switch_plan", "cancel_subscription");
  } else if (s.status === "SUSPENDED") actions.push("resume", "switch_plan", "cancel_subscription");
  else if (s.status === "APPROVAL_PENDING") actions.push("cancel_subscription");
  if (offer) actions.push("respond_to_offer");
  if (s.kept_state === "payment_failed") actions.push("payment_fixed");
  if (s.is_sample) actions.length = 0; // labelled demo rows are view-only
  // A cancellation PayPal hasn't confirmed yet is still the subscriber's decision: nothing else is offered
  // (a skip or switch now would act on a subscription they asked to end). Kept keeps retrying the cancel.
  if (s.cancel_requested_at && s.status !== "CANCELLED") actions.length = 0;
  return {
    subscription_ref: s.ref,
    shop: m.name,
    status: s.status,
    plan: plan ? { plan_id: plan.id, name: plan.name, price: money(plan.price), currency: m.currency, billing: intervalWords(plan), is_discount: plan.kind === "promo" } : null,
    returns_to_plan: plan?.kind === "promo" && home ? home.name : undefined,
    discount_until: s.promo_until?.toISOString(),
    next_billing_time: s.next_billing_time?.toISOString() ?? null,
    resumes_at: s.resume_at?.toISOString() ?? null,
    outstanding_balance: money(s.outstanding),
    approval_url: s.status === "APPROVAL_PENDING" || s.kept_state?.startsWith("switch_pending") ? s.approval_url : undefined,
    open_offer: offer ? offerView(offer) : null,
    notice,
    manage_url: `${config.appUrl}/manage/${s.ref}`,
    available_actions: actions,
    is_sample: s.is_sample || undefined,
  };
}

export async function computeStats(m: Merchant): Promise<ShopStats & { collected30: number; offersExpired: number; reasonsTotal: number; sampleRows: number; live: { active: number; suspended: number; mrr: number } }> {
  const db = await getDb();
  const subs = await subscribersFor(db, m.id);
  const plans = await plansFor(db, m.id, true);
  const price = (id: string | null) => plans.find((p) => p.id === id);
  const monthly = (s: Subscriber) => {
    const p = price(s.plan_id);
    if (!p) return 0;
    const perMonth = p.interval_unit === "DAY" ? 30 / p.interval_count : p.interval_unit === "WEEK" ? 4.345 / p.interval_count : p.interval_unit === "YEAR" ? 1 / (12 * p.interval_count) : 1 / p.interval_count;
    return p.price * perMonth;
  };
  const active = subs.filter((s) => s.status === "ACTIVE");
  const offers = (await db.query("SELECT * FROM offers WHERE merchant_id = $1", [m.id])).rows.map(toOffer);
  // An accepted discount still waiting for the subscriber's PayPal approval is not counted as kept.
  const accepted = offers.filter((o) => o.status === "accepted" && !(o as any).consent_pending);
  const fb = (await db.query<{ category: ReasonCategory; text: string }>("SELECT category, text FROM feedback WHERE merchant_id = $1 ORDER BY created_at DESC", [m.id])).rows;
  const reasonMap = new Map<ReasonCategory, { count: number; examples: string[] }>();
  for (const f of fb) {
    const r = reasonMap.get(f.category) ?? { count: 0, examples: [] };
    r.count++;
    if (r.examples.length < 2) r.examples.push(f.text.slice(0, 90));
    reasonMap.set(f.category, r);
  }
  const actions = (await db.query<{ source: string; c: string }>("SELECT source, count(*) AS c FROM event_log WHERE merchant_id = $1 AND source IN ('agent','web') GROUP BY source", [m.id])).rows;
  const agentN = Number(actions.find((a) => a.source === "agent")?.c ?? 0);
  const webN = Number(actions.find((a) => a.source === "web")?.c ?? 0);
  const cancels = (await db.query<{ c: string }>("SELECT count(*) AS c FROM event_log WHERE merchant_id = $1 AND type = 'subscription.cancelled'", [m.id])).rows[0];
  const collected = (await db.query<{ t: string }>("SELECT coalesce(sum(amount),0) AS t FROM payments WHERE merchant_id = $1 AND paid_at > now() - interval '30 days' AND status IN ('COMPLETED','completed')", [m.id])).rows[0];
  const in7 = Date.now() + 7 * 864e5;
  return {
    merchantName: m.name,
    currency: m.currency,
    active: active.length,
    suspended: subs.filter((s) => s.status === "SUSPENDED").length,
    cancelled: subs.filter((s) => s.status === "CANCELLED").length,
    mrr: Math.round(active.reduce((a, s) => a + monthly(s), 0) * 100) / 100,
    revenueKept3: Math.round(accepted.reduce((a, o) => a + o.monthly_value, 0) * 100) / 100,
    offersMade: offers.length,
    offersAccepted: accepted.length,
    offersExpired: offers.filter((o) => o.status === "expired").length,
    cancelsHonoured: Number(cancels?.c ?? 0),
    agentShare: agentN + webN ? Math.round((100 * agentN) / (agentN + webN)) : 0,
    reasons: [...reasonMap.entries()].map(([category, v]) => ({ category, ...v })),
    reasonsTotal: fb.length,
    failing: subs.filter((s) => s.kept_state === "payment_failed").map((s) => ({ name: s.subscriber_name ?? s.subscriber_email ?? s.ref, outstanding: s.outstanding })),
    upcomingRenewals7d: active.filter((s) => s.next_billing_time && s.next_billing_time.getTime() < in7).length,
    collected30: Number(collected?.t ?? 0),
    sampleRows: subs.filter((s) => s.is_sample).length,
    // The same headline numbers without labelled sample rows: what PayPal actually bills.
    live: {
      active: active.filter((s) => !s.is_sample).length,
      suspended: subs.filter((s) => s.status === "SUSPENDED" && !s.is_sample).length,
      mrr: Math.round(active.filter((s) => !s.is_sample).reduce((a, s) => a + monthly(s), 0) * 100) / 100,
    },
  };
}

export async function askOwner(m: Merchant, question: string) {
  const stats = await computeStats(m);
  return getBrain().answer(question.slice(0, 500), stats);
}

/* ----------------------------------------------------------------------------------------------
 * Invoicing v2 (roadmap K5): an invoice for the outstanding balance after a failed renewal, as the owner's
 * alternative to capturing it. Gated like a capture; PayPal emails the invoice.
 * -------------------------------------------------------------------------------------------- */

export async function invoiceOutstanding(ref: string, actor: Actor, key = newId("k")) {
  const { db, m, s } = await load(ref);
  assertLive(s);
  if (!s.paypal_subscription_id) throw new KeptError("This subscription has not been approved on PayPal yet.", "not_approved", 409);
  return withRun({ actor, merchantId: m.id, subject: "invoice outstanding balance", entity: "subscriber", entityId: s.id }, async (run) => {
    const { sub: fresh } = await exec.readBack(db, m, s);
    const cents = Math.round(fresh.outstanding * 100);
    if (cents <= 0) throw new KeptError("PayPal shows nothing outstanding on this subscription.", "nothing_due", 409);
    const open = (await db.query<any>("SELECT * FROM invoices WHERE subscriber_id = $1 AND status IN ('DRAFT','SENT','SCHEDULED') ORDER BY created_at DESC LIMIT 1", [s.id])).rows[0];
    if (open) return { invoiceId: open.paypal_invoice_id as string, amount: Number(open.amount), status: open.status as string, note: "An invoice for this balance is already out." };
    await gated(async () => gate(await moveFor(m, fresh, actor, "invoice", { cents, trustedCents: [cents] }), run));
    const pp = paypalFor(m);
    const inv = await run.timed({ actor: "paypal", tool: "invoicing.create", args: { amount: fresh.outstanding.toFixed(2) }, pp_request_id: requestKey("invoice", s.id, fresh.outstanding.toFixed(2), key) }, () =>
      pp.createInvoice({ recipientEmail: fresh.subscriber_email, recipientName: fresh.subscriber_name, merchantName: m.name, merchantEmail: m.owner_email, amount: fresh.outstanding.toFixed(2), currency: m.currency, note: `Outstanding renewal for your ${m.name} subscription. Pay here, or update your PayPal payment method and the subscription continues.`, reference: s.ref }, requestKey("invoice", s.id, fresh.outstanding.toFixed(2), key)), (r) => ({ id: r.id, status: r.status }));
    const sent = await run.timed({ actor: "paypal", tool: "invoicing.send", args: { invoiceId: inv.id }, pp_request_id: requestKey("invoice-send", inv.id, key) }, () => pp.sendInvoice(inv.id, requestKey("invoice-send", inv.id, key)));
    await db.query("INSERT INTO invoices (id, merchant_id, subscriber_id, paypal_invoice_id, amount, currency, status, run_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [newId("inv"), m.id, s.id, inv.id, fresh.outstanding.toFixed(2), m.currency, sent.status, run.id]);
    await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: actor.kind, type: "invoice.sent", summary: `Invoice ${inv.id} for ${fresh.outstanding.toFixed(2)} ${m.currency} sent to the subscriber (PayPal Invoicing)`, paypal: inv });
    await appendAudit("invoice.sent", "subscriber", s.id, { invoiceId: inv.id, amount: fresh.outstanding.toFixed(2), by: actorLabel(actor) });
    return { invoiceId: inv.id, amount: fresh.outstanding, status: sent.status, note: "Invoice sent. When PayPal shows it paid, the outstanding balance is cleared." };
  });
}

/** Job: read back open invoices; a paid one clears the subscriber's failed-payment state. */
export async function checkInvoices() {
  const db = await getDb();
  const open = (await db.query<any>("SELECT i.*, s.ref FROM invoices i JOIN subscribers s ON s.id = i.subscriber_id WHERE i.status IN ('DRAFT','SENT','SCHEDULED') LIMIT 50")).rows;
  let paid = 0;
  for (const i of open) {
    const m = await merchantById(db, i.merchant_id);
    if (!m) continue;
    try {
      const inv = await paypalFor(m).getInvoice(i.paypal_invoice_id);
      if (inv.status !== i.status) await db.query("UPDATE invoices SET status = $2 WHERE id = $1", [i.id, inv.status]);
      if (inv.status === "PAID" || inv.status === "MARKED_AS_PAID") {
        paid++;
        await updateSubscriber(db, i.subscriber_id, { kept_state: null, outstanding: 0, failed_payments: 0 });
        await cancelJob(db, `followup:${i.subscriber_id}`);
        await logEvent(db, { merchantId: m.id, subscriberId: i.subscriber_id, source: "scheduler", type: "payment.recovered", summary: `Invoice ${i.paypal_invoice_id} paid; outstanding balance cleared` });
      }
    } catch {
      /* read again next time */
    }
  }
  return { checked: open.length, paid };
}

/** Owner lookup through Transaction Search (read-only). */
export async function transactionsFor(m: Merchant, days = 31) {
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(31, Math.max(1, days)) * 864e5);
  const [txns, balances] = await Promise.all([paypalFor(m).searchTransactions(start.toISOString(), end.toISOString()), paypalFor(m).listBalances().catch(() => [])]);
  return { from: start.toISOString(), to: end.toISOString(), transactions: txns, balances };
}

/* ----------------------------------------------------------------------------------------------
 * Renewal reminders over the subscriber's channel (roadmap K6), with one-tap skip where the rules allow it.
 * -------------------------------------------------------------------------------------------- */

export async function sendRenewalReminders(now = new Date()) {
  const db = await getDb();
  let sent = 0;
  for (const m of await (await import("./store.js")).listMerchants(db)) {
    const p = await currentPolicy(db, m.id);
    const days = p?.rules.renewalReminderDays ?? 0;
    if (!days) continue;
    const until = new Date(now.getTime() + days * 864e5);
    const subs = (await db.query<any>("SELECT * FROM subscribers WHERE merchant_id = $1 AND status = 'ACTIVE' AND next_billing_time IS NOT NULL AND next_billing_time <= $2 AND next_billing_time > $3", [m.id, until, now])).rows;
    for (const s of subs) {
      const dedupe = `reminder:${s.id}:${new Date(s.next_billing_time).toISOString().slice(0, 10)}`;
      const already = (await db.query("SELECT 1 FROM event_log WHERE subscriber_id = $1 AND type = 'renewal.reminder' AND payload->>'dedupe' = $2", [s.id, dedupe])).rows.length;
      if (already) continue;
      const plan = await planById(db, s.plan_id);
      const buttons = [{ id: `keep:${s.ref}`, label: "Keep it" }];
      if (p?.rules.skip.enabled) buttons.push({ id: `skip:${s.ref}`, label: "Skip this one" });
      buttons.push({ id: `cancel:${s.ref}`, label: "Cancel" });
      const body = `${m.name}: your ${plan?.name ?? "subscription"} renews on ${new Date(s.next_billing_time).toISOString().slice(0, 10)}${plan ? ` for ${money(plan.price)} ${m.currency}` : ""}. Nothing to do to keep it. Manage: ${config.appUrl}/manage/${s.ref}`;
      await notifyParty("subscriber", s.id, body, buttons, "subscriber", s.id, db);
      await logEvent(db, { merchantId: m.id, subscriberId: s.id, source: "scheduler", type: "renewal.reminder", summary: `Renewal reminder sent ${days} days before the charge`, payload: { dedupe, buttons: buttons.map((b) => b.id) }, sample: s.is_sample });
      sent++;
    }
  }
  return { sent };
}

export interface CalendarEvent {
  id: string;
  allDay?: boolean;
  name: string;
  startDate: string;
  endDate: string;
  resourceId: string;
  subscriberRef: string;
  sample: boolean;
}

export async function calendarEvents(m: Merchant): Promise<CalendarEvent[]> {
  const db = await getDb();
  const subs = await subscribersFor(db, m.id);
  const plans = await plansFor(db, m.id, true);
  const out: CalendarEvent[] = [];
  const label = (s: Subscriber) => s.subscriber_name ?? s.subscriber_email ?? s.ref.slice(0, 10);
  for (const s of subs) {
    const p = plans.find((x) => x.id === s.plan_id);
    if (s.status === "ACTIVE" && s.next_billing_time) {
      const d = new Date(s.next_billing_time);
      out.push({ id: `renew-${s.id}`, name: `${label(s)} renews${p ? ` (${p.name} ${money(p.price)})` : ""}`, startDate: d.toISOString(), endDate: new Date(d.getTime() + 3600_000).toISOString(), resourceId: s.kept_state === "payment_failed" ? "failed" : p?.kind === "promo" ? "discount" : "renewal", subscriberRef: s.ref, sample: s.is_sample });
    }
    if (s.status === "SUSPENDED" && s.resume_at) {
      const start = new Date(Math.max(Date.now(), new Date(s.updated_at).getTime()));
      out.push({ id: `pause-${s.id}`, name: `${label(s)} paused`, allDay: true, startDate: start.toISOString().slice(0, 10), endDate: new Date(s.resume_at).toISOString().slice(0, 10), resourceId: "pause", subscriberRef: s.ref, sample: s.is_sample });
      out.push({ id: `resume-${s.id}`, name: `${label(s)} resumes`, startDate: new Date(s.resume_at).toISOString(), endDate: new Date(new Date(s.resume_at).getTime() + 3600_000).toISOString(), resourceId: "resume", subscriberRef: s.ref, sample: s.is_sample });
    }
    if (s.promo_until && s.status !== "CANCELLED") {
      out.push({ id: `promo-${s.id}`, name: `${label(s)}: discount ends`, startDate: new Date(s.promo_until).toISOString(), endDate: new Date(new Date(s.promo_until).getTime() + 3600_000).toISOString(), resourceId: "discount", subscriberRef: s.ref, sample: s.is_sample });
    }
  }
  const retries = (await db.query<{ subscriber_id: string; run_at: Date }>("SELECT payload->>'subscriberId' AS subscriber_id, run_at FROM jobs WHERE type = 'payment_followup' AND status = 'pending'")).rows;
  for (const r of retries) {
    const s = subs.find((x) => x.id === r.subscriber_id);
    if (!s) continue;
    out.push({ id: `retry-${s.id}`, name: `${label(s)}: payment follow-up`, startDate: new Date(r.run_at).toISOString(), endDate: new Date(new Date(r.run_at).getTime() + 3600_000).toISOString(), resourceId: "failed", subscriberRef: s.ref, sample: s.is_sample });
  }
  return out;
}

