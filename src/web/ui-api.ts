/**
 * JSON endpoints for the React front end (web/). Every handler reuses the service layer the server-rendered
 * pages, MCP and REST already use: no business logic lives here. Owner endpoints use the same signed cookie
 * as /dashboard; member endpoints are keyed by the subscription ref, exactly like /manage/:ref.
 */
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { sign, unsign } from "../lib/crypto.js";
import { describeRules } from "../policy/rules.js";
import { money } from "../policy/eligibility.js";
import * as svc from "../service.js";
import { currentPolicy, intervalWords, KeptError, listMerchants, Merchant, merchantById, merchantBySlug, openOfferFor, plansFor, subscriberByRef, subscribersFor, toOffer, type Plan } from "../store.js";
import { decideApproval, guardSettings, pendingApprovals } from "../guard/dryrun.js";
import { isKilled } from "../guard/kill.js";
import { loadRun, runsFor, recentRuns } from "../trace.js";
import { hasOpenAI, providerLabel } from "../ai/provider.js";
import { telegramReady } from "../channels/index.js";
import { cycleCard } from "./cycles.js";

const COOKIE = "kept_owner";
const DEMO_SLUG = () => process.env.KEPT_DEMO_SHOP || "ember-oak-coffee-club";

type H = (req: Request, res: Response) => Promise<unknown>;
const j = (fn: H) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res)
    .then((out) => {
      if (!res.headersSent) res.json(out ?? { ok: true });
    })
    .catch((e) => {
      if (e instanceof KeptError) return res.status(e.status).json({ error: e.code, message: e.message });
      if (/No such approval/.test(String((e as Error)?.message))) return res.status(404).json({ error: "not_found", message: "That approval no longer exists." });
      if (/passkey/.test(String((e as Error)?.message))) return res.status(409).json({ error: "passkey_required", message: (e as Error).message });
      next(e);
    });

async function ownerOf(req: Request): Promise<Merchant | null> {
  const id = unsign(req.cookies?.[COOKIE]);
  return id ? merchantById(await getDb(), id) : null;
}
async function needOwner(req: Request): Promise<Merchant> {
  const m = await ownerOf(req);
  if (!m) throw new KeptError("Sign in as the shop owner first.", "unauthorized", 401);
  return m;
}
function setOwner(res: Response, m: Merchant) {
  res.cookie(COOKIE, sign(m.id), { httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https"), maxAge: 30 * 864e5 });
}

const planJson = (p: Plan, currency: string) => ({ id: p.id, name: p.name, description: p.description, price: money(p.price), currency, billing: intervalWords(p), kind: p.kind, paypal_plan_id: p.paypal_plan_id });

/** Who did a trace step, in the three words the UI uses for its trust strip. */
function actorWord(actor: string): "AI" | "Rule" | "PayPal" | "Person" | "Agent" {
  if (actor === "model") return "AI";
  if (actor === "paypal") return "PayPal";
  if (actor === "code" || actor === "guard" || actor === "worker" || actor === "scheduler") return "Rule";
  if (actor === "agent") return "Agent";
  return "Person";
}
function stepWords(s: any): string {
  const r = s.result ?? {};
  switch (s.tool) {
    case "classify_reason": return `Read the reason as "${String(r.category ?? "other").replace(/_/g, " ")}"${r.via === "rules" ? " (rules, no model)" : ""}`;
    case "eligibility": return r.chosen ? `Rules allow: ${(r.eligible ?? []).join(", ").replace(/_/g, " ")}. Chose ${String(r.chosen).replace(/_/g, " ")}.` : "No offer the rules allow fits, so no offer.";
    case "quarantine": return "Kept instruction-like text out of the offer step";
    default:
      if (String(s.tool).startsWith("gate.")) return `${s.gate === "allowed" ? "Allowed" : s.gate === "held" ? "Held for the owner" : s.gate === "denied" ? "Refused" : String(s.gate)}: ${r.reason ?? String(s.tool).slice(5)}`;
      if (String(s.tool).startsWith("subscriptions.")) return `PayPal ${String(s.tool).slice(14).replace(/_/g, " ")}${r.status ? ` → ${r.status}` : ""}`;
      return String(s.tool).replace(/[._]/g, " ");
  }
}
async function timelineFor(entityId: string, limit = 8) {
  const runs = await runsFor("subscriber", entityId, limit);
  const out = [];
  for (const r of runs) {
    const t = await loadRun(r.id);
    out.push({
      id: r.id,
      subject: r.subject,
      actor: r.actor,
      agent_id: r.agent_id,
      status: r.status,
      at: r.started_at,
      steps: (t?.steps ?? []).map((s: any) => ({ n: s.step, who: actorWord(s.actor), tool: s.tool, gate: s.gate, text: stepWords(s), policy: s.policy, ms: s.duration_ms, pp_request_id: s.pp_request_id, pp_debug_id: s.pp_debug_id, at: s.at })),
    });
  }
  return out;
}

function undoFor(action: string, payload: any): string {
  if (payload.offer?.type === "discount") return "The member can cancel at any time. The discount ends on its own after its cycles; you can't take it back once they accept.";
  if (payload.offer?.type === "pause" || payload.offer?.type === "skip") return "The member can resume early from their page; nothing is charged while paused.";
  if (payload.offer?.type === "switch_plan") return "The member can switch back from their page.";
  if (action === "capture") return "If it was wrong, refund it in PayPal; Kept shows the capture id in the timeline.";
  if (action === "invoice") return "Cancel the invoice in PayPal before it's paid.";
  return "Decline now and nothing moves.";
}

export function uiApi(): Router {
  const r = Router();

  r.get("/ui/session", j(async (req) => {
    const m = await ownerOf(req);
    const db = await getDb();
    const demo = await merchantBySlug(db, DEMO_SLUG());
    // The member Judge Mode shows: the newest live (non-sample) member of the demo shop, else a labelled sample.
    const member = demo ? (await db.query<{ ref: string }>("SELECT ref FROM subscribers WHERE merchant_id = $1 AND status IN ('ACTIVE','SUSPENDED') ORDER BY is_sample, created_at DESC LIMIT 1", [demo.id])).rows[0] : undefined;
    return { owner: m ? { name: m.name, slug: m.slug } : null, demoMode: config.demoMode, demoShop: DEMO_SLUG(), demoMemberRef: member?.ref ?? null, ai: hasOpenAI() ? "model" : "rules", paypalEnv: config.paypal.env };
  }));

  r.post("/ui/demo/owner", j(async (_req, res) => {
    if (!config.demoMode) throw new KeptError("Demo mode is off.", "not_allowed", 403);
    const db = await getDb();
    const m = (await merchantBySlug(db, DEMO_SLUG())) ?? (await listMerchants(db))[0];
    if (!m) throw new KeptError("No demo shop yet. Run npm run seed.", "not_found", 404);
    setOwner(res, m);
    return { ok: true, owner: { name: m.name, slug: m.slug } };
  }));

  /** The landing page's live preview: the demo shop's real plans and approved rules. */
  r.get("/ui/preview", j(async () => {
    const db = await getDb();
    const m = await merchantBySlug(db, DEMO_SLUG());
    if (!m) return { shop: null };
    const plans = (await plansFor(db, m.id)).filter((p) => p.kind !== "promo");
    const policy = await currentPolicy(db, m.id);
    const subs = (await subscribersFor(db, m.id)).filter((s) => s.status === "ACTIVE");
    const all = await plansFor(db, m.id, true);
    const example = subs.find((s) => !s.is_sample && s.next_billing_time) ?? subs.find((s) => s.promo_until) ?? subs[0];
    return {
      shop: { name: m.name, slug: m.slug, tagline: m.tagline, currency: m.currency },
      plans: plans.map((p) => planJson(p, m.currency)),
      promise: policy ? describeRules(policy.rules) : ["Cancelling always works in one step."],
      example: example ? { name: example.subscriber_name, sample: example.is_sample, card: await cycleCard(db, example, all), plan: all.find((p) => p.id === example.plan_id)?.name ?? null } : null,
    };
  }));

  /* ---------------- shop page ---------------- */
  r.get("/ui/shop/:slug", j(async (req) => {
    const db = await getDb();
    const m = await merchantBySlug(db, req.params.slug);
    if (!m) throw new KeptError("Shop not found.", "not_found", 404);
    const plans = (await plansFor(db, m.id)).filter((p) => p.kind !== "promo");
    const policy = await currentPolicy(db, m.id);
    return {
      shop: { name: m.name, slug: m.slug, tagline: m.tagline, currency: m.currency },
      plans: plans.map((p) => planJson(p, m.currency)),
      promise: policy ? describeRules(policy.rules) : ["Cancelling always works in one step."],
      mcp: `${config.appUrl}/s/${m.slug}/mcp`,
      llms: `/s/${m.slug}/llms.txt`,
      paypalClientId: m.paypal_credentials ? null : config.paypal.clientId || null,
    };
  }));

  r.post("/ui/shop/:slug/subscribe", j(async (req) => {
    const m = await merchantBySlug(await getDb(), req.params.slug);
    if (!m) throw new KeptError("Shop not found.", "not_found", 404);
    const name = String(req.body?.name ?? "").trim().slice(0, 80) || null;
    const email = String(req.body?.email ?? "").trim().slice(0, 120) || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new KeptError("That email doesn't look right.", "invalid_email", 422);
    const out = await svc.startSubscription(m, String(req.body?.plan_id ?? ""), { name, email }, { kind: "web" }, String(req.body?.key ?? "").slice(0, 80) || undefined);
    return { ref: out.ref, approval_url: out.approvalUrl, paypal_subscription_id: out.paypalSubscriptionId };
  }));

  /* ---------------- member page ---------------- */
  r.get("/ui/manage/:ref", j(async (req) => {
    const db = await getDb();
    const s = await subscriberByRef(db, req.params.ref);
    if (!s) throw new KeptError("We couldn't find that subscription. Check the link in your PayPal receipt or ask the shop.", "not_found", 404);
    const m = (await merchantById(db, s.merchant_id))!;
    const v = await svc.subscriptionView(s.ref);
    const all = await plansFor(db, m.id, true);
    const policy = await currentPolicy(db, m.id);
    const offer = await openOfferFor(db, s.id);
    const tg = Number((await db.query<any>("SELECT count(*)::int AS n FROM party_links WHERE channel = 'telegram' AND party = 'subscriber' AND party_id = $1", [s.id])).rows[0]?.n ?? 0) > 0;
    return {
      view: v,
      member: { name: s.subscriber_name, first: (s.subscriber_name ?? "").split(" ")[0] || null, channel: s.channel, agent_id: s.agent_id, sample: s.is_sample, started_at: s.started_at, cancel_requested_at: s.cancel_requested_at ?? null, kept_state: s.kept_state },
      shop: { name: m.name, slug: m.slug, currency: m.currency },
      switchTo: all.filter((p) => p.active && p.kind !== "promo" && p.id !== s.plan_id).map((p) => planJson(p, m.currency)),
      pauseMax: policy?.rules.pause.enabled ? policy.rules.pause.maxCycles : 0,
      promise: policy ? describeRules(policy.rules) : ["Cancelling always works in one step."],
      offer: offer ? { id: offer.id, message: offer.message, label: toOffer(offer).terms?.label ?? null, type: offer.type, terms: offer.terms, expires_at: offer.expires_at } : null,
      telegram: { linked: tg, ready: telegramReady() },
      card: await cycleCard(db, s, all),
      timeline: await timelineFor(s.id),
      mcp: `${config.appUrl}/s/${m.slug}/mcp`,
    };
  }));

  const act = (path: string, fn: (ref: string, b: any) => Promise<Record<string, unknown>>) =>
    r.post(`/ui/manage/:ref/${path}`, j(async (req) => ({ ok: true, ...(await fn(req.params.ref, req.body ?? {})) })));
  const web = { kind: "web" as const };
  const key = (b: any) => (typeof b.key === "string" && b.key ? b.key.slice(0, 80) : undefined);
  act("skip", async (ref, b) => { const out = await svc.skipNext(ref, web, key(b)); return { message: "Next delivery skipped.", resumeAt: out.resumeAt }; });
  act("pause", async (ref, b) => { const out = await svc.pause(ref, Number(b.cycles ?? 1), web, key(b)); return { message: "Paused.", resumeAt: out.resumeAt }; });
  act("resume", async (ref, b) => { await svc.resume(ref, web, key(b)); return { message: "Resumed. Your next payment is back on." }; });
  act("switch", async (ref, b) => {
    const out = await svc.switchPlan(ref, String(b.plan_id ?? ""), web, key(b));
    return out.approvalUrl ? { message: "PayPal needs you to approve the new price.", approvalUrl: out.approvalUrl } : { message: out.confirmed ? `Switched to ${out.plan.name}.` : `Switch to ${out.plan.name} accepted; it starts from your next payment.` };
  });
  act("cancel", async (ref, b) => {
    const hear = b.hear_offer === true || b.hear_offer === "1";
    const out = await svc.requestCancel(ref, { reason: b.reason ? String(b.reason) : undefined, hearOffer: hear }, web, key(b));
    if (out.status === "offer_open") return { status: out.status, message: "Here is one offer. Take it, or cancel now." };
    if (out.status === "cancel_pending") return { status: out.status, message: (out as any).note ?? "Cancellation requested. PayPal hasn't confirmed yet; Kept keeps retrying." };
    return { status: "cancelled", message: hear ? "No offer applies to you right now, so we cancelled as you asked. You won't be charged again." : "Cancelled. You won't be charged again." };
  });
  act("payment-fixed", async (ref, b) => ({ message: (await svc.paymentFixed(ref, web, key(b))).note }));
  act("promise", async (ref, b) => {
    await svc.promisePayment(ref, String(b.date ?? ""), web);
    return { message: `No reminders until ${String(b.date)}. A promise doesn't move any money.` };
  });

  r.post("/ui/offer/:id/:choice(accept|decline)", j(async (req) => {
    const out = await svc.respondToOffer(req.params.id, req.params.choice === "accept", web);
    return { ok: true, status: out.status, message: out.status === "kept" ? "Done. Thanks for staying." : out.status === "cancel_pending" ? "Cancellation requested. PayPal hasn't confirmed yet; we keep retrying." : "Cancelled. You won't be charged again.", approvalUrl: (out as any).approvalUrl ?? null };
  }));

  /* ---------------- owner ---------------- */
  r.get("/ui/owner/today", j(async (req) => {
    const m = await needOwner(req);
    const db = await getDb();
    const [stats, subs, all, policy, settings] = await Promise.all([svc.computeStats(m), subscribersFor(db, m.id), plansFor(db, m.id, true), currentPolicy(db, m.id), guardSettings(m.id)]);
    const name = (id: string | null) => all.find((p) => p.id === id)?.name ?? null;
    const approvals = (await pendingApprovals(m.id)).filter((a: any) => a.status === "pending").slice(0, 10);
    const offers = (await db.query("SELECT o.*, s.subscriber_name, s.ref, s.is_sample FROM offers o JOIN subscribers s ON s.id = o.subscriber_id WHERE o.merchant_id = $1 ORDER BY o.created_at DESC LIMIT 12", [m.id])).rows.map((o: any) => ({ id: o.id, member: o.subscriber_name, ref: o.ref, sample: o.is_sample, label: toOffer(o).terms?.label ?? o.type, type: o.type, status: o.status, reason: o.reason_category, expires_at: o.expires_at, created_at: o.created_at }));
    const events = (await db.query("SELECT id, created_at, source, type, summary, is_sample FROM event_log WHERE merchant_id = $1 ORDER BY id DESC LIMIT 30", [m.id])).rows;
    const members = [];
    for (const s of subs.slice(0, 120)) {
      members.push({
        ref: s.ref, name: s.subscriber_name ?? s.subscriber_email ?? s.ref.slice(0, 12), email: s.subscriber_email, sample: s.is_sample, channel: s.channel, agent_id: s.agent_id,
        status: s.status, kept_state: s.kept_state, plan: name(s.plan_id), price: all.find((p) => p.id === s.plan_id)?.price ?? null,
        next_billing_time: s.next_billing_time, resume_at: s.resume_at, promo_until: s.promo_until, outstanding: s.outstanding, started_at: s.started_at, paypal_subscription_id: s.paypal_subscription_id,
        card: await cycleCard(db, s, all),
      });
    }
    const webhookOk = Boolean(m.paypal_webhook_id || (!m.paypal_credentials && config.paypal.webhookId));
    return {
      shop: { name: m.name, slug: m.slug, currency: m.currency, paypal_env: m.paypal_env, product: m.paypal_product_id },
      stats,
      killed: Boolean((await isKilled("global"))?.engaged || (await isKilled(`merchant:${m.id}`))?.engaged),
      autonomy: settings,
      approvals: approvals.map((a: any) => {
        const p = a.payload ?? {};
        const who = p.entityId ? subs.find((x) => x.id === p.entityId) : undefined;
        const cents = Number(p.cents ?? 0);
        return {
          id: a.id, action: a.action, created_at: a.created_at,
          member: who ? { name: who.subscriber_name ?? who.subscriber_email ?? "A member", ref: who.ref, sample: who.is_sample } : null,
          amount: cents ? (cents / 100).toFixed(2) : null,
          offer: p.offer ?? null,
          why: [p.reason, ...(p.safety_reasons ?? [])].filter(Boolean),
          scam: Boolean(p.safety_reasons?.length),
          needsPasskey: cents >= config.guard.countersignAboveCents,
          undo: undoFor(a.action, p),
        };
      }),
      failed: subs.filter((x) => x.kept_state === "payment_failed" && x.status !== "CANCELLED").slice(0, 8).map((x) => ({ ref: x.ref, name: x.subscriber_name ?? x.subscriber_email ?? "A member", sample: x.is_sample, outstanding: Number(x.outstanding ?? 0).toFixed(2) })),
      openOffers: offers.filter((o) => o.status === "open"),
      offers,
      members,
      events,
      rules: policy ? { version: policy.version, lines: describeRules(policy.rules), source: policy.source_text } : null,
      plans: all.filter((p) => p.active).map((p) => planJson(p, m.currency)),
      connections: { buyerMcp: `${config.appUrl}/s/${m.slug}/mcp`, ownerMcp: `${config.appUrl}/owner/mcp`, webhookOk, ai: providerLabel(), telegram: telegramReady() },
      demoMode: config.demoMode,
    };
  }));

  r.post("/ui/owner/ask", j(async (req) => {
    const m = await needOwner(req);
    const q = String(req.body?.question ?? "").trim().slice(0, 500);
    if (!q) throw new KeptError("Ask a question first.", "empty", 422);
    return { answer: await svc.askOwner(m, q) };
  }));

  r.post("/ui/owner/approvals/:id/:choice(approve|decline)", j(async (req) => {
    const m = await needOwner(req);
    const out = await decideApproval(req.params.id, m.id, req.params.choice === "approve", "click", "owner");
    return { ok: true, status: out.status, message: out.replayed ? `Already ${out.status}.` : out.status === "approved" ? "Approved. Kept will go ahead the next time this move comes up." : "Declined. Nothing moves." };
  }));

  r.post("/ui/owner/reconcile", j(async (req) => {
    const m = await needOwner(req);
    const out = await svc.reconcileMerchant(m.id);
    return { ok: true, message: `Checked ${out.checked} live subscriptions with PayPal; ${out.changed} changed.` };
  }));

  r.post("/ui/owner/member/:ref/sync", j(async (req) => {
    const m = await needOwner(req);
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s || s.merchant_id !== m.id) throw new KeptError("Not your member.", "forbidden", 403);
    const after = await svc.syncSubscription(s.ref, "owner");
    return { ok: true, message: `PayPal shows ${after.status.toLowerCase()}.` };
  }));

  r.post("/ui/owner/member/:ref/simulate-failure", j(async (req) => {
    const m = await needOwner(req);
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s || s.merchant_id !== m.id) throw new KeptError("Not your member.", "forbidden", 403);
    await svc.simulateFailedPayment(s.ref);
    return { ok: true, message: "Simulated a failed renewal (no PayPal call). Their page now shows how to fix it." };
  }));

  r.get("/ui/owner/member/:ref", j(async (req) => {
    const m = await needOwner(req);
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s || s.merchant_id !== m.id) throw new KeptError("Not your member.", "forbidden", 403);
    return { timeline: await timelineFor(s.id, 12) };
  }));

  r.get("/ui/owner/runs", j(async (req) => {
    const m = await needOwner(req);
    return { runs: await recentRuns(m.id, 30) };
  }));

  return r;
}
