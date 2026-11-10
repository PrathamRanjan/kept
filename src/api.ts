import { Router, Request, Response, NextFunction } from "express";
import { config } from "./config.js";
import { getDb } from "./db.js";
import { describeRules } from "./policy/rules.js";
import { money } from "./policy/eligibility.js";
import * as svc from "./service.js";
import { currentPolicy, intervalWords, KeptError, listMerchants, listPublicMerchants, Merchant, merchantBySlug, merchantByToken, plansFor } from "./store.js";

type Handler = (req: Request, res: Response) => Promise<unknown>;

const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res)
    .then((out) => {
      if (!res.headersSent) res.json(out);
    })
    .catch(next);

const idem = (req: Request) => (req.header("idempotency-key") || undefined)?.slice(0, 80);
const actorOf = (req: Request) => ({ kind: req.header("x-agent-id") ? ("agent" as const) : ("web" as const), agentId: req.header("x-agent-id")?.slice(0, 80) });

async function shop(req: Request): Promise<Merchant> {
  const m = await merchantBySlug(await getDb(), req.params.slug);
  if (!m) throw new KeptError("Shop not found.", "not_found", 404);
  return m;
}

async function owner(req: Request): Promise<Merchant> {
  const token = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  const m = token ? await merchantByToken(await getDb(), token) : null;
  if (!m) throw new KeptError("Owner token required (Authorization: Bearer <token>).", "unauthorized", 401);
  return m;
}

async function plansJson(m: Merchant) {
  return (await plansFor(await getDb(), m.id)).filter((p) => p.kind !== "promo").map((p) => ({ plan_id: p.id, name: p.name, description: p.description, price: money(p.price), currency: m.currency, billing: intervalWords(p), interval_unit: p.interval_unit, interval_count: p.interval_count, lighter_plan: p.kind === "lite" }));
}

export function apiRouter(): Router {
  const r = Router();

  r.get("/shops", h(async () => {
    const all = await listPublicMerchants(await getDb());
    return { shops: await Promise.all(all.map(async (m) => ({ shop: m.slug, name: m.name, tagline: m.tagline, currency: m.currency, page: `${config.appUrl}/s/${m.slug}`, mcp_url: `${config.appUrl}/s/${m.slug}/mcp`, plans: await plansJson(m) }))) };
  }));

  r.get("/shops/:slug", h(async (req) => {
    const m = await shop(req);
    const p = await currentPolicy(await getDb(), m.id);
    return { shop: m.slug, name: m.name, tagline: m.tagline, currency: m.currency, plans: await plansJson(m), policies: p ? describeRules(p.rules) : ["Cancelling always works in one step."] };
  }));

  r.get("/shops/:slug/plans", h(async (req) => ({ plans: await plansJson(await shop(req)) })));

  r.post("/shops/:slug/subscriptions", h(async (req, res) => {
    const m = await shop(req);
    const { plan_id, subscriber_name, subscriber_email } = req.body ?? {};
    if (typeof plan_id !== "string") throw new KeptError("plan_id is required.", "invalid_request", 422);
    const out = await svc.startSubscription(m, plan_id, { name: subscriber_name, email: subscriber_email }, actorOf(req), idem(req));
    res.status(201);
    return { subscription_ref: out.ref, paypal_subscription_id: out.paypalSubscriptionId, status: "APPROVAL_PENDING", approval_url: out.approvalUrl };
  }));

  r.get("/subscriptions/:ref", h(async (req) => {
    if (req.query.refresh !== "false") await svc.syncSubscription(req.params.ref, "api").catch(() => undefined);
    return svc.subscriptionView(req.params.ref);
  }));

  r.post("/subscriptions/:ref/skip", h(async (req) => {
    const out = await svc.skipNext(req.params.ref, actorOf(req), idem(req));
    return { status: out.sub.status, resumes_at: out.resumeAt.toISOString() };
  }));

  r.post("/subscriptions/:ref/pause", h(async (req) => {
    const cycles = Number(req.body?.cycles ?? 1);
    const out = await svc.pause(req.params.ref, cycles, actorOf(req), idem(req));
    return { status: out.sub.status, resumes_at: out.resumeAt.toISOString() };
  }));

  r.post("/subscriptions/:ref/resume", h(async (req) => ({ status: (await svc.resume(req.params.ref, actorOf(req), idem(req))).status })));

  r.post("/subscriptions/:ref/switch", h(async (req) => {
    if (typeof req.body?.plan_id !== "string") throw new KeptError("plan_id is required.", "invalid_request", 422);
    const out = await svc.switchPlan(req.params.ref, req.body.plan_id, actorOf(req), idem(req));
    return { status: out.sub.status, plan: out.plan.name, applied: out.confirmed, approval_url: out.approvalUrl };
  }));

  r.post("/subscriptions/:ref/cancel", h(async (req) => {
    const out = await svc.requestCancel(req.params.ref, { reason: req.body?.reason, hearOffer: req.body?.hear_offer === true }, actorOf(req), idem(req));
    return { status: out.status, subscription_status: out.subscription.status, offer: out.offer, note: out.note, run_id: (out as any).runId };
  }));

  r.post("/offers/:id/respond", h(async (req) => {
    if (typeof req.body?.accept !== "boolean") throw new KeptError("accept (true or false) is required.", "invalid_request", 422);
    const out = await svc.respondToOffer(req.params.id, req.body.accept, actorOf(req), idem(req));
    return { status: out.status, subscription: await svc.subscriptionView(out.subscription.ref) };
  }));

  r.post("/subscriptions/:ref/payment-fixed", h(async (req) => {
    const out = await svc.paymentFixed(req.params.ref, actorOf(req), idem(req));
    return { collected: out.captured, note: out.note };
  }));

  r.post("/subscriptions/:ref/invoice", h(async (req) => {
    const out = await svc.invoiceOutstanding(req.params.ref, actorOf(req), idem(req));
    return { invoice_id: out.invoiceId, status: out.status, note: out.note, run_id: (out as any).runId };
  }));

  // Owner endpoints (Bearer owner token)
  r.get("/owner/stats", h(async (req) => svc.computeStats(await owner(req))));
  r.get("/owner/subscribers", h(async (req) => {
    const m = await owner(req);
    return { subscribers: (await (await getDb()).query("SELECT ref, status, subscriber_name, subscriber_email, channel, plan_id, next_billing_time, outstanding, is_sample FROM subscribers WHERE merchant_id = $1 ORDER BY created_at DESC", [m.id])).rows };
  }));
  r.get("/owner/events", h(async (req) => {
    const m = await owner(req);
    return { events: (await (await getDb()).query("SELECT id, created_at, source, type, summary, is_sample FROM event_log WHERE merchant_id = $1 ORDER BY id DESC LIMIT 100", [m.id])).rows };
  }));
  r.get("/owner/calendar", h(async (req) => ({ events: await svc.calendarEvents(await owner(req)) })));
  r.post("/owner/ask", h(async (req) => ({ answer: await svc.askOwner(await owner(req), String(req.body?.question ?? "")) })));
  r.post("/owner/reconcile", h(async (req) => svc.reconcileMerchant((await owner(req)).id)));

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof KeptError) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error("[kept api]", err);
    return res.status(500).json({ error: "internal_error", message: "Something went wrong." });
  });
  return r;
}
