/**
 * JSON endpoints for the React front end (web/). Every handler reuses the service layer the server-rendered
 * pages, MCP and REST already use: no business logic lives here. Owner endpoints use the same signed cookie
 * as /dashboard; member endpoints are keyed by the subscription ref, exactly like /manage/:ref.
 */
import { voiceSession } from "../ai/voice.js";
import { NoModelError } from "../ai/provider.js";
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { sign, unsign } from "../lib/crypto.js";
import { describeRules } from "../policy/rules.js";
import { billingIn, describeRulesIn, msg, normLang, NO_RULES_PROMISE, type Lang } from "../i18n.js";
import { money } from "../policy/eligibility.js";
import * as svc from "../service.js";
import { currentPolicy, intervalWords, KeptError, listMerchants, Merchant, merchantById, merchantBySlug, openOfferFor, plansFor, subscriberByRef, subscribersFor, toOffer, type Plan } from "../store.js";
import { decideApproval, guardSettings, pendingApprovals } from "../guard/dryrun.js";
import { isShowcase, workspaceOf } from "../demo/workspaces.js";
import { ensureWorkspace } from "./demo.js";
import { isKilled } from "../guard/kill.js";
import { loadRun, runsFor, recentRuns } from "../trace.js";
import { hasOpenAI, providerLabel } from "../ai/provider.js";
import { telegramReady } from "../channels/index.js";
import { smsLinks, smsPending, smsReady, startSmsLink, stopSms, verifySmsLink } from "../channels/sms.js";
import { cycleCard } from "./cycles.js";
import { askOwnerAgent } from "../ask/agent-ask.js";
import { runAssistant } from "../ask/assistant.js";
import { spendAllowance } from "../demo/allowance.js";
import { tick } from "../demo/checklist.js";

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

const planJson = (p: Plan, currency: string, lang: Lang = "en") => ({ id: p.id, name: p.name, description: p.description, price: money(p.price), currency, billing: lang === "en" ? intervalWords(p) : billingIn(p, lang), kind: p.kind, paypal_plan_id: p.paypal_plan_id });
/** The member's language: the web app sends it on every call (x-kept-lang); ?lang= also works. */
export const langOf = (req: Request): Lang => normLang(req.get("x-kept-lang") ?? (typeof req.query.lang === "string" ? req.query.lang : ""));
const promiseIn = (policy: { rules: any } | null, lang: Lang) => (policy ? describeRulesIn(policy.rules, lang, () => describeRules(policy.rules)) : [NO_RULES_PROMISE[lang]]);

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
    case "classify_reason":
      if (r.via === "unread") return "Couldn't read the reason (the model did not answer), so no offer was made";
      return `Read the reason as "${String(r.category ?? "other").replace(/_/g, " ")}"${r.via === "code" || r.via === "rules" ? " (code: nothing to read)" : r.via === "backup" ? " (backup model)" : ""}`;
    case "word_offer": return r.by === "code" ? "Wrote the offer with Kept's own template (the model did not answer)" : `Worded the offer${r.by === "backup" ? " (backup model)" : ""}`;
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
    // The visitor's own private workspace, when they have one; otherwise the read-only showcase.
    const ws = await workspaceOf(req);
    const shop = ws ? await merchantById(db, ws.tenant_id) : await merchantBySlug(db, DEMO_SLUG());
    // The member Judge Mode shows: the newest real member of the visitor's shop, else a labelled sample.
    const member = ws && shop ? (await db.query<{ ref: string; is_sample: boolean }>("SELECT ref, is_sample FROM subscribers WHERE merchant_id = $1 AND status IN ('ACTIVE','SUSPENDED') ORDER BY is_sample, created_at DESC LIMIT 1", [shop.id])).rows[0] : undefined;
    return {
      owner: m ? { name: m.name, slug: m.slug } : null,
      demoMode: config.demoMode,
      demoShop: shop?.slug ?? DEMO_SLUG(),
      demoMemberRef: member?.ref ?? null,
      demoMemberIsSample: member?.is_sample ?? null,
      workspace: ws ? { id: ws.id, expiresAt: ws.expires_at, mine: m?.id === ws.tenant_id } : null,
      ai: hasOpenAI() ? "model" : "rules",
      paypalEnv: config.paypal.env,
    };
  }));

  /** "Continue as the owner": the visitor's own private copy of the demo shop, created on first use. */
  r.post("/ui/demo/owner", j(async (req, res) => {
    if (!config.demoMode) throw new KeptError("Demo mode is off.", "not_allowed", 403);
    const out = await ensureWorkspace(req, res);
    return { ok: true, created: out.created, owner: { name: out.merchant.name, slug: out.merchant.slug } };
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
    const lang = langOf(req);
    return {
      shop: { name: m.name, slug: m.slug, tagline: m.tagline, currency: m.currency },
      // The showcase is read-only: a visitor subscribes in their own private copy (/demo).
      showcase: await isShowcase(m.id, db),
      plans: plans.map((p) => planJson(p, m.currency, lang)),
      promise: promiseIn(policy, lang),
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
    const out = await svc.startSubscription(m, String(req.body?.plan_id ?? ""), { name, email, lang: langOf(req) }, { kind: "web" }, String(req.body?.key ?? "").slice(0, 80) || undefined);
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
    const lang = langOf(req);
    const tg = Number((await db.query<any>("SELECT count(*)::int AS n FROM party_links WHERE channel = 'telegram' AND party = 'subscriber' AND party_id = $1", [s.id])).rows[0]?.n ?? 0) > 0;
    if (!s.is_sample) await tick(m.id, "member_opened", db);
    return {
      view: v,
      member: { name: s.subscriber_name, first: (s.subscriber_name ?? "").split(" ")[0] || null, channel: s.channel, agent_id: s.agent_id, sample: s.is_sample, started_at: s.started_at, cancel_requested_at: s.cancel_requested_at ?? null, kept_state: s.kept_state, lang: (s as any).lang ?? null },
      shop: { name: m.name, slug: m.slug, currency: m.currency },
      switchTo: all.filter((p) => p.active && p.kind !== "promo" && p.id !== s.plan_id).map((p) => planJson(p, m.currency, lang)),
      pauseMax: policy?.rules.pause.enabled ? policy.rules.pause.maxCycles : 0,
      promise: promiseIn(policy, lang),
      billing: (() => { const cur = all.find((p) => p.id === s.plan_id); return cur ? (lang === "en" ? intervalWords(cur) : billingIn(cur, lang)) : null; })(),
      interval: (() => { const cur = all.find((p) => p.id === s.plan_id); return cur ? { unit: cur.interval_unit, count: cur.interval_count } : null; })(),
      offer: offer ? { id: offer.id, message: offer.message, label: toOffer(offer).terms?.label ?? null, type: offer.type, terms: offer.terms, expires_at: offer.expires_at, worded_by: (toOffer(offer).terms as any)?.wordedBy === "code" ? "code" : "model" } : null,
      telegram: { linked: tg, ready: telegramReady() },
      sms: { ready: smsReady(), linked: await smsLinks("subscriber", s.id), pending: await smsPending("subscriber", s.id) },
      card: await cycleCard(db, s, all),
      timeline: await timelineFor(s.id),
      mcp: `${config.appUrl}/s/${m.slug}/mcp`,
    };
  }));

  // Spec A7: push-to-talk. A two-minute secret for a gpt-live-1 dictation session, for a member page or an owner.
  r.post("/ui/voice/session", j(async (req, res) => {
    const ref = typeof req.body?.ref === "string" ? req.body.ref : null;
    const s = ref ? await subscriberByRef(await getDb(), ref) : null;
    const owner = s ? null : await ownerOf(req);
    const merchantId = s?.merchant_id ?? owner?.id ?? null;
    if (!merchantId) throw new KeptError("Open a member page or your shop first.", "forbidden", 403);
    await spendAllowance(merchantId, "voice", 40);
    res.setHeader("cache-control", "no-store");
    try {
      return await voiceSession(merchantId, langOf(req));
    } catch (e) {
      if (e instanceof NoModelError) throw new KeptError("Voice isn't available right now. Typing works as usual.", "voice_unavailable", 503);
      throw e;
    }
  }));

  // Spec B5 differentiator 1: the member's own AI assistant, streamed step by step.
  r.post("/ui/manage/:ref/assistant/stream", async (req, res) => {
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s) return res.status(404).json({ error: "not_found", message: "Subscription not found" });
    const msg = String(req.body?.message ?? "").trim().slice(0, 400);
    if (!msg) return res.status(422).json({ error: "empty", message: "Type what you want the assistant to do." });
    res.status(200).set({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      (res as any).flush?.();
    };
    try {
      await spendAllowance(s.merchant_id);
      const r = await runAssistant(s.ref, msg, (st) => send("step", st), langOf(req));
      send("answer", { answer: r.answer, sentences: r.sentences, facts: r.facts, model: r.model, runId: r.runId, readBack: r.readBack, toolCalls: r.toolCalls, mandate: r.mandate, ms: r.ms });
    } catch (e) {
      send("failed", { error: e instanceof KeptError ? e.code : "internal_error", message: e instanceof KeptError ? e.message : "The assistant hit a problem and stopped. Check the steps above for anything it changed." });
    }
    res.end();
  });

  /* Texts: the number is linked only once the code Kept texts it comes back. */
  const member = async (ref: string) => {
    const s = await subscriberByRef(await getDb(), ref);
    if (!s || s.is_sample) throw new KeptError("Subscription not found", "not_found", 404);
    return s;
  };
  r.post("/ui/manage/:ref/sms/start", j(async (req) => ({ ok: true, ...(await startSmsLink("subscriber", (await member(req.params.ref)).id, String(req.body?.phone ?? ""), req.body?.consent === true)) })));
  r.post("/ui/manage/:ref/sms/verify", j(async (req) => {
    const out = await verifySmsLink("subscriber", (await member(req.params.ref)).id, String(req.body?.code ?? ""));
    return { ok: true, message: `Texts are on for ${out.phone}.` };
  }));
  r.post("/ui/manage/:ref/sms/stop", j(async (req) => {
    await stopSms("subscriber", (await member(req.params.ref)).id);
    return { ok: true, message: "Texts are off." };
  }));

  // The member's language is remembered from the page they act on, so offers and reminders use it too.
  const rememberLang = async (req: Request) => {
    if (!req.get("x-kept-lang")) return;
    await (await getDb()).query("UPDATE subscribers SET lang = $1 WHERE ref = $2 AND lang IS DISTINCT FROM $1", [langOf(req), req.params.ref]);
  };
  const act = (path: string, fn: (ref: string, b: any, lang: Lang) => Promise<Record<string, unknown>>) =>
    r.post(`/ui/manage/:ref/${path}`, j(async (req) => {
      await rememberLang(req);
      const out = await fn(req.params.ref, req.body ?? {}, langOf(req));
      // The guided journey notices a member's own change (a convenience; never blocks the change).
      if (["skip", "pause", "resume", "switch"].includes(path)) await tick((await subscriberByRef(await getDb(), req.params.ref))?.merchant_id, "member_changed");
      return { ok: true, ...out };
    }));
  r.post("/ui/manage/:ref/lang", j(async (req) => {
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s) throw new KeptError("Subscription not found", "not_found", 404);
    const lang = normLang(req.body?.lang);
    await (await getDb()).query("UPDATE subscribers SET lang = $1 WHERE id = $2", [lang, s.id]);
    return { ok: true, lang };
  }));
  const web = { kind: "web" as const };
  const key = (b: any) => (typeof b.key === "string" && b.key ? b.key.slice(0, 80) : undefined);
  act("skip", async (ref, b, lang) => { const out = await svc.skipNext(ref, web, key(b)); return { message: msg("skipped", lang), resumeAt: out.resumeAt }; });
  act("pause", async (ref, b, lang) => { const out = await svc.pause(ref, Number(b.cycles ?? 1), web, key(b)); return { message: msg("paused", lang), resumeAt: out.resumeAt }; });
  act("resume", async (ref, b, lang) => { await svc.resume(ref, web, key(b)); return { message: msg("resumed", lang) }; });
  act("switch", async (ref, b, lang) => {
    const out = await svc.switchPlan(ref, String(b.plan_id ?? ""), web, key(b));
    return out.approvalUrl ? { message: msg("switch_approve", lang), approvalUrl: out.approvalUrl } : { message: msg(out.confirmed ? "switched" : "switch_next", lang, { plan: out.plan.name }) };
  });
  act("cancel", async (ref, b, lang) => {
    const hear = b.hear_offer === true || b.hear_offer === "1";
    const out = await svc.requestCancel(ref, { reason: b.reason ? String(b.reason) : undefined, hearOffer: hear }, web, key(b));
    const mid = (await subscriberByRef(await getDb(), ref))?.merchant_id;
    await tick(mid, out.status === "offer_open" ? "offer_shown" : "cancel_answered");
    if (out.status === "offer_open") return { status: out.status, message: msg("offer_open", lang) };
    if (out.status === "cancel_pending") return { status: out.status, message: lang === "en" ? (out as any).note ?? msg("cancel_pending", lang) : msg("cancel_pending", lang) };
    return { status: "cancelled", message: msg(hear ? "cancelled_no_offer" : "cancelled", lang) };
  });
  act("payment-fixed", async (ref, b) => ({ message: (await svc.paymentFixed(ref, web, key(b))).note }));
  act("promise", async (ref, b, lang) => {
    await svc.promisePayment(ref, String(b.date ?? ""), web);
    return { message: msg("promise", lang, { date: String(b.date) }) };
  });

  // Kept per-app item 1: the talk between the member's assistant and the shop's agent. Proposes only.
  act("negotiate", async (ref, b, lang) => {
    const s0 = await subscriberByRef(await getDb(), ref);
    if (s0) await spendAllowance(s0.merchant_id);
    const out = await svc.negotiateCancel(ref, String(b.words ?? ""), lang, web);
    return out;
  });

  r.post("/ui/offer/:id/:choice(accept|decline)", j(async (req) => {
    const out = await svc.respondToOffer(req.params.id, req.params.choice === "accept", web);
    await tick((await (await getDb()).query<{ merchant_id: string }>("SELECT merchant_id FROM offers WHERE id = $1", [req.params.id])).rows[0]?.merchant_id, "cancel_answered");
    const lang = langOf(req);
    return { ok: true, status: out.status, message: msg(out.status === "kept" ? "kept" : out.status === "cancel_pending" ? "cancel_pending_short" : "cancelled", lang), approvalUrl: (out as any).approvalUrl ?? null };
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
      connections: { widget: `<script src="${config.appUrl}/widget.js" data-shop="${m.slug}" async></script>`, buyerMcp: `${config.appUrl}/s/${m.slug}/mcp`, ownerMcp: `${config.appUrl}/owner/mcp`, webhookOk, ai: providerLabel(), telegram: telegramReady() },
      demoMode: config.demoMode,
    };
  }));

  // The signed-in owner's own key, for the read-only owner MCP. Fetched on demand, never part of a page payload.
  r.post("/ui/owner/key", j(async (req, res) => {
    const m = await needOwner(req);
    res.setHeader("cache-control", "no-store");
    return { ownerMcp: `${config.appUrl}/owner/mcp`, key: m.owner_token, header: "Authorization: Bearer <key>" };
  }));

  r.post("/ui/owner/ask", j(async (req) => {
    const m = await needOwner(req);
    const q = String(req.body?.question ?? "").trim().slice(0, 500);
    if (!q) throw new KeptError("Ask a question first.", "empty", 422);
    await spendAllowance(m.id);
    const r = await askOwnerAgent(m, q);
    await tick(m.id, "owner_asked");
    return { answer: r.answer, sentences: r.sentences, facts: r.facts, steps: r.steps, by: r.by, model: r.model, runId: r.runId, toolCalls: r.toolCalls, ms: r.ms };
  }));

  // Spec A5.3: the same Ask, streamed. Each tool call reaches the browser as it happens (the AI work rail).
  r.post("/ui/owner/ask/stream", async (req, res, next) => {
    let m: Merchant;
    try {
      m = await needOwner(req);
    } catch (e) {
      return e instanceof KeptError ? res.status(e.status).json({ error: e.code, message: e.message }) : next(e);
    }
    const q = String(req.body?.question ?? "").trim().slice(0, 500);
    if (!q) return res.status(422).json({ error: "empty", message: "Ask a question first." });
    res.status(200).set({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
    res.flushHeaders?.();
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      (res as any).flush?.();
    };
    try {
      await spendAllowance(m.id);
      const r = await askOwnerAgent(m, q, (s) => send("step", s));
      await tick(m.id, "owner_asked");
      send("answer", { answer: r.answer, sentences: r.sentences, facts: r.facts, by: r.by, model: r.model, runId: r.runId, toolCalls: r.toolCalls, ms: r.ms });
    } catch (e) {
      send("failed", { error: e instanceof KeptError ? e.code : "internal_error", message: e instanceof KeptError ? e.message : "Something went wrong answering that. Nothing was changed." });
    }
    res.end();
  });

  r.post("/ui/owner/approvals/:id/:choice(approve|decline)", j(async (req) => {
    const m = await needOwner(req);
    const out = await decideApproval(req.params.id, m.id, req.params.choice === "approve", "click", "owner");
    await tick(m.id, "approval_decided");
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
