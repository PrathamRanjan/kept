/**
 * Spec A3: the judge page and the pages that need no sign-in. Everything here is read at request time from the
 * app's configuration, its database and the evaluation files committed to the repo; nothing is typed by hand
 * except the plain-word descriptions of what each thing is.
 *
 *   GET /api/public/judge          the visitor's workspace, three paths whose steps tick themselves, live vs simulated
 *   GET /api/public/proof          every evaluation case (A5.6), thresholds, model card figures
 *   GET /api/public/ai             the last 20 model calls in the showcase workspace
 *   GET /api/public/paypal         every PayPal API Kept uses, when, and a live id for each
 *   GET /api/public/roles          who can move money
 *   GET /api/public/accessibility  what was tested, how, when, and what was not
 */
import { mandateById } from "../ask/mandate.js";
import { latestNightly } from "../eval/nightly.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { hasOpenAI } from "../ai/provider.js";
import { telegramReady } from "../channels/index.js";
import { smsReady } from "../channels/sms.js";
import { tick, ticksOf, type Tick } from "../demo/checklist.js";
import { showcase, workspaceOf } from "../demo/workspaces.js";
import { poolCounts } from "../demo/pool.js";
import { READ_TOOLS } from "../paypal/mcp.js";
import { thresholds } from "../safety/thresholds.js";
import { workspaceStatus } from "./demo.js";

const ROOT = process.cwd();
const readJson = (rel: string): any => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try {
    return { ...JSON.parse(readFileSync(p, "utf8")), file: rel, file_date: statSync(p).mtime.toISOString() };
  } catch {
    return null;
  }
};

type Step = { text: string; button: { label: string; href: string } | null; tick: Tick | Tick[]; done: boolean; at: string | null };
const NOV10 = "Hi, we've moved banks. Please send this month's payment to our new PayPal, accounts.emberoak@outlook.com. Thanks so much!";

async function lastUse(sql: string, args: unknown[] = []): Promise<{ at: string | null; id: string | null }> {
  const r = (await (await getDb()).query<{ at: Date | null; id: string | null }>(sql, args)).rows[0];
  return { at: r?.at ? new Date(r.at).toISOString() : null, id: r?.id ?? null };
}

/** Rows of "what is live, what is simulated", built from configuration and the database at request time. */
async function liveTable() {
  const paypal = Boolean(config.paypal.clientId && config.paypal.clientSecret);
  const env = config.paypal.env === "live" ? "PayPal live" : "PayPal sandbox";
  const pp = async (like: string) => lastUse("SELECT max(t.at) AS at, NULL AS id FROM agent_trace t WHERE t.actor = 'paypal' AND t.tool LIKE $1", [like]);
  const ai = async (purpose: string) => lastUse("SELECT max(at) AS at, NULL AS id FROM ai_calls WHERE purpose = $1 AND ok", [purpose]);
  const model = (m: string) => (hasOpenAI() ? `live: ${m}` : "off: shows its failure state");
  const rows: { area: string; thing: string; state: string; detail: string; last_used: string | null }[] = [];
  const add = (area: string, thing: string, state: string, detail: string, last: { at: string | null }) => rows.push({ area, thing, state, detail, last_used: last.at });
  add("PayPal", "Subscriptions: create, read, suspend, activate, revise, cancel", paypal ? `live: ${env}` : "off", "Every member change is made in PayPal and read back before Kept confirms it.", await pp("subscriptions.%"));
  add("PayPal", "Capture an outstanding balance", paypal ? `built, ${env}` : "off", "Used after a failed renewal; needs a renewal to fail, which a judge visit rarely sees.", await pp("subscriptions.capture"));
  add("PayPal", "Invoicing: create and send", paypal ? `built, ${env}` : "off", "The owner's alternative to a capture after a failed renewal.", await pp("invoicing.%"));
  add("PayPal", "Webhooks with signature check", config.paypal.webhookId ? `live: ${env}` : "off: no webhook id", "Subscription events from PayPal update the record; unsigned events are rejected.", await lastUse("SELECT max(received_at) AS at, NULL AS id FROM webhook_events WHERE verified AND NOT simulated"));
  add("PayPal", `PayPal's hosted MCP server (${READ_TOOLS.join(", ")})`, paypal ? `live: ${env}, read only` : "off", "The owner's Ask confirms a real member's subscription with PayPal itself.", await lastUse("SELECT max(at) AS at, NULL AS id FROM agent_trace WHERE tool = 'agent.tool.paypal_subscription'"));
  add("PayPal", "Saved demo wallet (Vault payment token)", config.paypal.demoVaultToken ? `set: ${env}` : "not set", "Shared by the hackathon apps for buyer-present demo payments.", { at: null });
  add("AI", "Owner Ask: agent loop with read tools", model(config.ai.models.agent), "Cites a fact per sentence; code checks each citation.", await ai("agent_ask"));
  add("AI", "Member's assistant: agent loop with the member's own tools", model(config.ai.models.agent), "Calls Kept's public MCP tools for one member; code reads PayPal back after each change.", await ai("agent_assistant"));
  add("AI", "Scam check: eleven yes/no questions (Decisions)", model(config.ai.models.decide), "One of three readers; strictest wins; never a false all-clear.", await ai("decide_scam_check"));
  add("AI", "Cancel reason label", model(config.ai.models.classify), "Labels the member's words; code decides whether any offer applies.", await ai("classify_reason"));
  add("AI", "Offer wording", model(config.ai.models.classify), "Words the offer code already chose; numbers are checked against the offer.", await ai("word_offer"));
  add("AI", "Rule and plan drafting from the owner's words", model(config.ai.models.read), "The owner approves every draft; code refuses rules the law forbids.", await ai("draft_rules"));
  add("AI", "Scam check on the device (MiniLM, 23 MB)", "live: runs in the visitor's browser", "Nothing pasted leaves the device for this score.", { at: null });
  add("AI", "Payment-risk model (LightGBM)", "live, trained on synthetic data", "A ranking signal shown with rule reasons, never a fraud rate.", { at: null });
  add("Messages", "Telegram", telegramReady() ? "live" : "off: Kept has no bot of its own yet", "Reminders with Skip and Keep buttons.", { at: null });
  add("Messages", "SMS (Twilio)", smsReady() ? "live, after the member confirms a code" : "off", "A text before each payment, with a link back to the member page.", await lastUse("SELECT max(created_at) AS at, NULL AS id FROM channel_messages WHERE channel = 'sms' AND direction = 'out' AND status = 'sent'"));
  add("Messages", "Web push", config.channels.vapidPublic ? "live" : "off: no push keys", "Payment reminders in the browser.", { at: null });
  add("Messages", "WhatsApp", config.channels.whatsappToken ? "live" : "off: no WhatsApp number", "Not set up.", { at: null });
  add("Phone", "Voice line", "not built", "A phone line on gpt-live-1 is in the plan, not in the app.", { at: null });
  add("Demo data", "Sample members", "simulated, labelled", "About 40 sample members per workspace, chipped as samples and never counted in a PayPal-confirmed figure.", { at: null });
  const pc = await poolCounts();
  add("Demo data", "Real sandbox subscriptions from the approval pool", pc.ready + pc.claimed > 0 ? "live: PayPal sandbox" : "empty", `${pc.ready} ready, ${pc.claimed} in visitors' shops, ${pc.awaiting} waiting for the sandbox buyer's approval.`, { at: null });
  return rows;
}

function paths(ref: string | null, real: boolean, ticks: Record<string, string>) {
  const st = (text: string, button: Step["button"], t: Tick | Tick[]): Step => {
    const keys = Array.isArray(t) ? t : [t];
    const at = keys.map((k) => ticks[k]).find(Boolean) ?? null;
    return { text, button, tick: t, done: Boolean(at), at };
  };
  const member = ref ? `/manage/${ref}` : null;
  const q = (s: string) => encodeURIComponent(s);
  return [
    {
      id: "assistant",
      title: "Be the member's assistant",
      minutes: 2,
      paypalLogin: false,
      needs: real ? null : "a real member in your shop (the pool is empty, so this path can only read)",
      steps: [
        st("Open your real member's page.", member ? { label: "Open the member page", href: member } : null, "member_opened"),
        st("Ask the assistant what is on the subscription.", member ? { label: "Ask: What's my next payment?", href: `${member}?assistant=${q("What's my next payment?")}#assistant` } : null, "assistant_read"),
        st("Ask it to pause for a month. It calls Kept's MCP tool; the rail shows the call and the rule that allowed it.", member ? { label: "Ask: Pause my coffee for a month", href: `${member}?assistant=${q("Pause my coffee for a month")}#assistant` } : null, "assistant_acted"),
        st("Code reads PayPal back after the change. Then ask it to resume.", member ? { label: "Ask: Resume it", href: `${member}?assistant=${q("Resume it please")}#assistant` } : null, "assistant_readback"),
      ],
    },
    {
      id: "cancel",
      title: "Cancel in one step yourself",
      minutes: 1,
      paypalLogin: false,
      needs: real ? null : "a real member in your shop",
      steps: [
        st("Open your real member's page.", member ? { label: "Open the member page", href: member } : null, "member_opened"),
        st('Tick "show me one offer" and press Cancel. Code decides whether any offer applies; the model only words it.', member ? { label: "Go to Cancel", href: `${member}#cancel` } : null, ["offer_shown", "cancel_answered"]),
        st("Take the offer, or say no and it cancels on PayPal at once. Saying no uses up this demo subscription; the next visitor gets another from the pool.", member ? { label: "Go to Cancel", href: `${member}#cancel` } : null, "cancel_answered"),
      ],
    },
    {
      id: "owner",
      title: "Run the shop",
      minutes: 2,
      paypalLogin: false,
      needs: null,
      steps: [
        st("Ask the AI why people are cancelling. Watch its tool calls in the AI work panel.", { label: "Ask: Why are people cancelling?", href: `/dashboard?ask=${q("Why are people cancelling, and does PayPal agree for real members?")}#ask` }, "owner_asked"),
        st("Write a rule the law forbids. It is refused with the citation.", { label: "Try: three retention offers before cancel", href: `/dashboard/guard?text=${q("Show three retention offers before cancel. One skip per quarter.")}` }, "rule_refused"),
        st("Check the 10 Nov scam message. Three readers; it is held.", { label: "Check the 10 Nov message", href: `/dashboard/safety?text=${q(NOV10)}#check` }, "scam_checked"),
        st("Open the evaluation results, every case listed.", { label: "Open /proof", href: "/proof" }, "proof_opened"),
      ],
    },
  ];
}

export function publicRouter(): Router {
  const r = Router();
  const j = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
    fn(req, res)
      .then((out) => res.set("cache-control", "no-store").json(out))
      .catch((e) => res.status(500).json({ error: "error", message: (e as Error).message.slice(0, 200) }));

  r.get("/api/public/judge", j(async (req) => {
    const ws = await workspaceOf(req);
    const status = ws ? await workspaceStatus(ws, req) : null;
    const ticks = ws ? ticksOf(ws.checklist) : {};
    const real = status ? status.memberIsSample === false : false;
    const ps = paths(status?.memberRef ?? null, real, ticks);
    return {
      live: config.appUrl,
      workspace: status ? { id: status.workspace.id, shop: status.shop, counts: status.counts, pool: status.pool, memberRef: status.memberRef, memberIsSample: status.memberIsSample, joinUrl: status.joinUrl, joinQr: status.joinQr, expiresAt: status.workspace.expiresAt, idleHours: status.workspace.idleHours } : null,
      accounts: [
        process.env.JUDGE_BUYER_EMAIL
          ? { label: "PayPal sandbox buyer (for subscribing yourself on PayPal's page)", email: process.env.JUDGE_BUYER_EMAIL, password: process.env.JUDGE_BUYER_PASSWORD ?? null, note: "A sandbox test account: no real money." }
          : { label: "PayPal sandbox buyer", email: null, password: null, note: "No judge buyer account is set up yet. None of the three paths needs a PayPal login." },
      ],
      paths: ps,
      done: ps.map((p) => ({ id: p.id, done: p.steps.every((s) => s.done) })),
      liveTable: await liveTable(),
      pages: [
        { href: "/proof", label: "Proof: every evaluation case" },
        { href: "/ai", label: "AI: the last 20 model calls" },
        { href: "/paypal", label: "PayPal: every API and a live id" },
        { href: "/who-can-move-money", label: "Who can move money" },
        { href: "/accessibility", label: "Accessibility: what was tested" },
        { href: "/agents", label: "Connect your own AI assistant (MCP)" },
      ],
      lookAt: [
        "The member's assistant calling Kept's MCP tools, each call on the rail with PayPal's read-back.",
        "The scam check: three readers, strictest wins, never a green for a message that asks you to pay somewhere.",
        "Fair retention in code: one offer only if asked, no bribe for a quality complaint, rules the law forbids refused with the citation.",
        "Accessibility: every page works with a keyboard, at 200% text and by voice (push-to-talk on the Ask and assistant boxes). See /accessibility for what was tested.",
      ],
    };
  }));

  r.get("/api/public/proof", j(async (req) => {
    const ws = await workspaceOf(req);
    if (ws) await tick(ws.tenant_id, "proof_opened");
    const th = await thresholds();
    return {
      suites: [readJson("eval/scam/results.json"), readJson("eval/b5.json"), readJson("eval/reasons.json"), readJson("eval/adversarial.json"), readJson("eval/fairness.json")].filter(Boolean),
      thresholds: Object.values(th),
      nightly: await latestNightly(),
      modelCard: {
        text: [
          { set: "ScamShield SMS test", n: 8188, auc: 0.988, caught_at_1pct: "75%", what: "real Singapore SMS, in-distribution" },
          { set: "ScamShield eval sets", n: 1574, auc: 0.979, caught_at_1pct: "67%", what: "real and hand-written" },
          { set: "Singlish genuine", n: 600, auc: null, caught_at_1pct: "1.0% held", what: "real everyday messages: the false-alarm check" },
          { set: "Business templates", n: 200, auc: 0.85, caught_at_1pct: "11%", what: "author-written, held-out templates" },
          { set: "Business email (BEC) seed", n: 200, auc: 0.58, caught_at_1pct: "25%", what: "hand-written; the model is weak here" },
        ],
        source: "guard-lab/MODEL_CARD.md (copied figures; the on-device model has not been retrained since)",
        risk: "The payment-risk model is trained on synthetic data; there is no real payment-fraud data in this project.",
      },
      notMeasured: [
        "Real members' messages: Kept has none to test the scam check on.",
        "The on-device model's catch rate on business messages has not improved yet (spec A6.4 retraining is not done).",
        "Cancel-flow fairness with real members at scale: the fairness figures come from the demo shops' own event logs.",
      ],
    };
  }));

  r.get("/api/public/ai", j(async () => {
    const db = await getDb();
    const sc = await showcase(db);
    const rows = (await db.query<any>(
      `SELECT c.id, c.purpose, c.model, c.via, c.ok, c.error, c.tokens_in, c.tokens_out, c.cost_usd, c.latency_ms, c.input_summary, c.output, c.at
         FROM ai_calls c WHERE c.merchant_id = $1 OR c.run_id IN (SELECT id FROM agent_runs WHERE merchant_id = $1) ORDER BY c.id DESC LIMIT 20`,
      [sc.id],
    )).rows;
    const tot = (await db.query<{ purpose: string; n: number; ok: number; p50: number; cost: number }>(
      "SELECT purpose, count(*)::int AS n, count(*) FILTER (WHERE ok)::int AS ok, coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p50, coalesce(sum(cost_usd), 0)::float AS cost FROM ai_calls WHERE at > now() - interval '7 days' GROUP BY purpose ORDER BY n DESC",
    )).rows;
    const steps = async (runId: string | null) => (runId ? (await db.query<{ tool: string; result: any; duration_ms: number | null }>("SELECT tool, result, duration_ms FROM agent_trace WHERE run_id = $1 ORDER BY step", [runId])).rows : []);
    const calls = [];
    for (const c of rows) {
      const out = typeof c.output === "string" ? JSON.parse(c.output) : c.output;
      calls.push({
        id: Number(c.id),
        at: new Date(c.at).toISOString(),
        purpose: c.purpose,
        model: c.model,
        ok: c.ok,
        error: c.error ? String(c.error).slice(0, 160) : null,
        input: c.input_summary,
        tools: out?.steps?.map((s: any) => `${s.name}: ${s.summary}`) ?? (await steps(null)),
        output: out?.answers ? Object.fromEntries(Object.entries(out.answers).map(([k, v]: any) => [k, v?.probability ?? (v?.refused ? "not decided" : null)])) : out?.steps ? null : out,
        latency_ms: c.latency_ms,
        cost_usd: Number(c.cost_usd),
      });
    }
    return { shop: sc.name, calls, last7days: tot, note: calls.length ? null : "No model calls in the showcase shop yet; the daily showcase run (04:30 UTC) adds some each day." };
  }));

  r.get("/api/public/paypal", j(async () => {
    const db = await getDb();
    const sc = await showcase(db);
    const latest = async (tool: string) =>
      (await db.query<{ at: Date; result: any; pp: string | null; mine: boolean }>(
        `SELECT t.at, t.result, t.pp_debug_id AS pp, (r.merchant_id = $2) AS mine FROM agent_trace t JOIN agent_runs r ON r.id = t.run_id WHERE t.tool = $1 ORDER BY (r.merchant_id = $2) DESC, t.id DESC LIMIT 1`,
        [tool, sc.id],
      )).rows[0];
    const idOf = (res: any) => {
      const v = typeof res === "string" ? JSON.parse(res) : res;
      return v?.id ?? v?.subscriptionId ?? v?.paypal_subscription_id ?? v?.status ?? null;
    };
    const apis = [
      ["subscriptions.create", "Subscriptions: create", "A new member subscribes; PayPal returns the approval link."],
      ["subscriptions.suspend", "Subscriptions: suspend", "A member pauses or skips."],
      ["subscriptions.activate", "Subscriptions: activate", "A member resumes, or a pause ends."],
      ["subscriptions.revise", "Subscriptions: revise", "A member switches plan or takes a discount offer."],
      ["subscriptions.cancel", "Subscriptions: cancel", "A member, or their assistant, cancels."],
      ["subscriptions.capture", "Subscriptions: capture", "The owner collects an outstanding balance after a failed renewal."],
      ["invoicing.create", "Invoicing: create", "The owner invoices an outstanding balance instead."],
      ["invoicing.send", "Invoicing: send", "PayPal emails that invoice."],
      ["agent.tool.paypal_subscription", "PayPal MCP server: show_subscription_details", "The owner's Ask confirms a real member with PayPal itself."],
    ];
    const out = [];
    for (const [tool, name, when] of apis) {
      const row = await latest(tool);
      out.push({ api: name, when, last: row ? new Date(row.at).toISOString() : null, id: row ? idOf(row.result) : null, from: row ? (row.mine ? "showcase shop" : "a visitor's demo shop") : null });
    }
    const sub = (await db.query<{ id: string; at: Date }>("SELECT paypal_subscription_id AS id, updated_at AS at FROM subscribers WHERE paypal_subscription_id IS NOT NULL AND NOT is_sample ORDER BY updated_at DESC LIMIT 1")).rows[0];
    out.unshift({ api: "Subscriptions: read (after every change)", when: "Every change is read back from PayPal before Kept confirms it.", last: sub ? new Date(sub.at).toISOString() : null, id: sub?.id ?? null, from: sub ? "the most recently read real subscription" : null });
    const wh = (await db.query<{ event_type: string; resource_id: string | null; at: Date }>("SELECT event_type, resource_id, received_at AS at FROM webhook_events WHERE verified AND NOT simulated ORDER BY received_at DESC LIMIT 1")).rows[0];
    out.push({ api: "Webhooks (signature verified)", when: "PayPal tells Kept about renewals, failures and cancels made elsewhere.", last: wh ? new Date(wh.at).toISOString() : null, id: wh ? `${wh.event_type} ${wh.resource_id ?? ""}`.trim() : null, from: wh ? "PayPal" : null });
    return { env: config.paypal.env, apis: out };
  }));

  // Spec B5 (10): anyone can check a mandate is genuine. The member's reference is never part of the record.
  r.get("/api/public/mandate/:id", j(async (req, res) => {
    const m = await mandateById(String(req.params.id));
    if (!m) return { found: false };
    const uses = (await (await getDb()).query<{ type: string; summary: string; created_at: Date }>("SELECT type, summary, created_at FROM event_log WHERE payload->>'mandate' = $1 ORDER BY id", [m.mandate.id])).rows;
    return { found: true, ...m, uses: uses.map((u) => ({ type: u.type, summary: u.summary, at: new Date(u.created_at).toISOString() })) };
  }));

  r.get("/api/public/roles", j(async () => ({
    roles: [
      { who: "The owner", can: ["Approve or decline a held capture, invoice or offer", "Write retention rules in plain words (code refuses rules the law forbids)", "Turn protected mode on", "Collect or invoice an outstanding balance"], cannot: ["Block or delay a member's cancel", "Make more than one offer per cancel", "Change a member's plan without the member"] },
      { who: "A member", can: ["Skip, pause, resume, switch or cancel their own subscription in one step", "Take or refuse one offer, only if they asked to hear one"], cannot: ["Touch another member's subscription"] },
      { who: "A member's AI assistant (any MCP client)", can: ["The same changes as the member, on that member's subscription, through the same rules and gate", "Start a subscription, which the member must approve on PayPal's own page"], cannot: ["Approve a payment", "Act above the owner's limits without the owner"] },
      { who: "Kept's models", can: ["Read through read-only tools", "Label a cancel reason, word an offer code chose, draft rules and plans for the owner to approve, answer the owner's questions"], cannot: ["Call PayPal", "Choose an offer or a price", "Produce any money or PayPal id field (checked at call time and by a test)"] },
      { who: "The worker (background jobs)", can: ["Retry a cancel PayPal has not confirmed", "Send reminders"], cannot: ["Capture or invoice above the owner's limit without the owner"] },
      { who: "Staff", can: [], cannot: ["Kept has no staff role; there is one owner per shop"] },
    ],
  })));

  r.get("/api/public/accessibility", j(async () => readJson("docs/accessibility.json") ?? { checks: [], notTested: ["No accessibility record has been published yet."] }));

  return r;
}
