/**
 * Foundation routes (roadmap B.2, B.4, B.5, B.8, B.10, K5): traces, the eval explorer, channels and webhooks, the
 * PWA, the owner's money desk (Transaction Search, balances, invoices, collections), the
 * evidence page and judge mode.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Request, type Response, type NextFunction } from "express";
import { isAdmin } from "./admin.js";
import { aiUsageSummary, hasOpenAI, providerLabel } from "../ai/provider.js";
import { recentMessages, telegramReady, telegramUpdate, twilioInbound, whatsappReady, whatsappUpdate } from "../channels/index.js";
import { history } from "../guard/backtest.js";
import { randomBytes } from "node:crypto";
import { icon } from "./icons.js";
import { messageFlag } from "./safetyui.js";
import { pushReady, subscribe } from "../channels/push.js";
import { smsLinks, smsReady, startSmsLink, stopSms, twilioSignatureValid, verifySmsLink } from "../channels/sms.js";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { adversarialRows, renderAdversarialReport, runAdversarial } from "../eval/adversarial.js";
import { renderReasonReport, runReasonEval } from "../eval/reasons.js";
import { evalRows, summarise, toCsv } from "../eval/store.js";
import { fairness } from "../eval/fairness.js";
import { verifyChain } from "../guard/audit.js";
import { newId } from "../lib/ids.js";
import { paypalFor } from "../paypal/index.js";
import * as svc from "../service.js";
import { currentPolicy, KeptError, type Merchant, merchantBySlug, plansFor, subscriberByRef, subscribersFor } from "../store.js";
import { loadRun, recentRuns, renderTrace, runsFor } from "../trace.js";
import { esc, fmtDate, fmtMoney, html, layout, raw, type Raw } from "./html.js";
import { killBanner, ownerOf } from "./guard.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
type Page = (req: Request, res: Response) => Promise<unknown>;
const page = (fn: Page) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const json = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).then((out) => { if (!res.headersSent) res.json(out); }).catch((e) => res.status(e instanceof KeptError ? e.status : 400).json({ error: e instanceof KeptError ? e.code : "error", message: (e as Error).message }));
const nav = (m: Merchant) => ({ name: m.name, slug: m.slug });
async function requireOwner(req: Request, res: Response): Promise<Merchant | null> {
  const m = await ownerOf(req);
  if (!m) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  return m;
}
const back = (res: Response, url: string, msg: string, isErr = false) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${isErr ? "err" : "ok"}=${encodeURIComponent(msg)}`);
function flash(req: Request): Raw {
  const msg = typeof req.query.ok === "string" ? req.query.ok : typeof req.query.err === "string" ? req.query.err : "";
  return msg ? html`<div class="banner ${req.query.err ? "bad" : "good"}">${msg}</div>` : raw("");
}
const errMsg = (e: unknown) => (e instanceof KeptError ? e.message : (e as Error).message);

export function foundationRouter(): Router {
  const r = Router();

  /* ---------------- traces (B.2) ---------------- */
  r.get("/trace/:id", page(async (req, res) => {
    const t = await loadRun(req.params.id);
    if (!t) return res.status(404).send("No such run");
    const owner = await ownerOf(req);
    // A subscriber may see the runs on their own subscription via the manage page; the owner sees everything on their shop.
    const ref = typeof req.query.ref === "string" ? await subscriberByRef(await getDb(), req.query.ref) : null;
    const allowed = (owner && t.run.merchant_id === owner.id) || (ref && t.run.entity === "subscriber" && t.run.entity_id === ref.id) || (config.demoMode && !owner && !ref);
    if (!allowed) return res.status(403).send("This run belongs to another shop");
    res.send(layout({ title: `Run ${t.run.id} · Kept`, nav: "dashboard", owner: owner ? nav(owner) : null }, html`
      <h1>Agent run</h1><p class="muted">${t.run.subject} · ${t.run.actor}${t.run.agent_id ? ` (${t.run.agent_id})` : ""} · <span class="pill ${t.run.status === "done" ? "good" : t.run.status === "held" ? "held" : "bad"}">${t.run.status}</span> · started ${fmtDate(t.run.started_at, true)}</p>
      <div class="card">${renderTrace(t.steps)}</div>
      <p class="small muted">Every step is a row in agent_trace: actor, tool, redacted arguments, the rule hit, the gate's decision, PayPal request and debug ids, duration. <a href="/api/v1/runs/${t.run.id}">JSON</a></p>
    `));
  }));
  r.get("/dashboard/traces", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const runs = await recentRuns(m.id, 100);
    res.send(layout({ title: `${m.name} · Agent runs`, nav: "dashboard", owner: nav(m) }, html`
      <h1>Agent runs</h1><p class="muted">Every run on this shop: agents, subscribers, the owner, the scheduler. Click one for its trace.</p>${await killBanner(m.id)}
      <div class="card"><table class="evalgrid"><tr><th>Started</th><th>Actor</th><th>Subject</th><th>Steps</th><th>PayPal calls</th><th>Blocked</th><th>Status</th></tr>
      ${runs.map((x) => html`<tr><td>${fmtDate(x.started_at, true)}</td><td>${x.actor}${x.agent_id ? html`<br><small class="muted">${x.agent_id}</small>` : ""}</td><td><a href="/trace/${x.id}">${x.subject}</a></td><td>${x.steps}</td><td>${x.paypal_calls}</td><td>${Number(x.blocked) ? html`<span class="pill warn">${x.blocked}</span>` : "0"}</td><td><span class="pill ${x.status === "done" ? "good" : x.status === "held" ? "held" : "bad"}">${x.status}</span></td></tr>`)}
      </table>${runs.length ? "" : html`<div class="empty">No runs yet.</div>`}</div>
    `));
  }));

  /* ---------------- eval explorer (B.4, B.5) ---------------- */
  r.get("/dashboard/eval", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const suite = typeof req.query.suite === "string" ? req.query.suite : "reasons";
    const arm = typeof req.query.arm === "string" ? req.query.arm : undefined;
    const outcome = typeof req.query.outcome === "string" ? (req.query.outcome as "correct" | "wrong") : undefined;
    const trap = typeof req.query.trap === "string" ? req.query.trap : undefined;
    const sums = await summarise(suite);
    const rows = await evalRows(suite, { arm, outcome, trap });
    const usage = await aiUsageSummary();
    const q = (patch: Record<string, string | undefined>) => "/dashboard/eval?" + new URLSearchParams(Object.entries({ suite, arm, outcome, trap, ...patch }).filter(([, v]) => v) as [string, string][]).toString();
    const chip = (label: string, patch: Record<string, string | undefined>, on: boolean) => html`<a class="${on ? "on" : ""}" href="${q(patch)}">${label}</a>`;
    res.send(layout({ title: `${m.name} · Evals`, nav: "dashboard", owner: nav(m) }, html`
      <h1>Evals</h1><p class="muted">Three arms per task (rules, model plus code, oracle), traps, and the dollars a naive policy would have moved. Brain: ${providerLabel()}.</p>${flash(req)}
      <div class="card"><div class="row"><form method="post" action="/dashboard/eval/run" class="inline"><input type="hidden" name="suite" value="reasons"><button class="btn primary" type="submit">Run reason classification (held-out)</button></form><form method="post" action="/dashboard/eval/run" class="inline"><input type="hidden" name="suite" value="adversarial"><button class="btn" type="submit">Run adversarial harness</button></form><a class="btn" href="/dashboard/eval.csv?suite=${suite}">CSV</a><a class="btn" href="/dashboard/eval/${suite}.md">Markdown report</a></div>
        <p class="small muted">Model calls so far: ${usage.ok}/${usage.calls} ok, estimated $${usage.cost_usd.toFixed(4)}${usage.by_purpose.map((p) => ` · ${p.purpose} ${p.calls} (p50 ${p.p50_ms} ms${p.replayed ? `, ${p.replayed} replayed` : ""})`).join("")}</p></div>
      <div class="card"><div class="chips">${chip("reasons", { suite: "reasons", arm: undefined, outcome: undefined, trap: undefined }, suite === "reasons")}${chip("adversarial", { suite: "adversarial", arm: undefined, outcome: undefined, trap: undefined }, suite === "adversarial")}</div>
        ${sums.length ? html`<table><tr><th>Arm</th><th>Cases</th><th>Correct</th><th>Traps</th><th>Traps caught</th><th>$ naive wrongly moved</th><th>$ Kept wrongly moved</th><th>Cost (est.)</th><th>p50</th><th>p95</th></tr>${sums.map((a) => html`<tr><td>${a.arm}</td><td>${a.cases}</td><td>${a.correct}</td><td>${a.traps}</td><td>${a.traps_caught}</td><td>${a.naive_usd.toFixed(2)}</td><td>${a.ours_usd.toFixed(2)}</td><td>$${a.cost_usd.toFixed(4)}</td><td>${a.p50_ms} ms</td><td>${a.p95_ms} ms</td></tr>`)}</table>` : html`<div class="empty">No results yet for ${suite}. Run it above.</div>`}
      </div>
      <div class="card"><h2>Explorer</h2>
        <div class="chips">Arm: ${chip("all", { arm: undefined }, !arm)}${[...new Set(rows.concat(await evalRows(suite)).map((x: any) => x.arm))].map((a) => chip(String(a), { arm: String(a) }, arm === a))}</div>
        <div class="chips">Outcome: ${chip("all", { outcome: undefined }, !outcome)}${chip("correct", { outcome: "correct" }, outcome === "correct")}${chip("wrong", { outcome: "wrong" }, outcome === "wrong")}</div>
        <div class="chips">Traps: ${chip("all", { trap: undefined }, !trap)}${chip("traps only", { trap: "trap" }, trap === "trap")}${chip("plain", { trap: "plain" }, trap === "plain")}${["money_words", "injection", "mixed"].map((t) => chip(t, { trap: t }, trap === t))}</div>
        <div class="table-wrap"><table class="evalgrid"><tr><th>Case</th><th>Arm</th><th>Input</th><th>Expected</th><th>Actual</th><th>OK</th><th>Trap</th><th>$ naive</th><th>$ Kept</th><th>ms</th></tr>
        ${rows.slice(0, 300).map((x: any) => html`<tr><td>${x.case_id}</td><td>${x.arm}</td><td class="small">${x.detail?.text ?? x.detail?.title ?? ""}</td><td>${String(x.expected)}</td><td>${String(x.actual)}</td><td>${x.correct ? html`<span class="pill good">yes</span>` : html`<span class="pill bad">no</span>`}</td><td>${x.detail?.trap_kind ?? (x.trap ? "trap" : "")}</td><td>${(Number(x.naive_paid_cents) / 100).toFixed(2)}</td><td>${(Number(x.ours_paid_cents) / 100).toFixed(2)}</td><td>${x.latency_ms}</td></tr>`)}
        </table></div>${rows.length ? "" : html`<div class="empty">Nothing matches.</div>`}
      </div>
    `));
  }));
  r.post("/dashboard/eval/run", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    // A run spends model money and rewrites the published eval files, so it is for the site admin.
    if (!isAdmin(req)) return back(res, "/dashboard/eval", "Running the evals is for the site admin (it spends model credit and rewrites the published results). The latest results are below.", true);
    const suite = String(req.body.suite ?? "reasons");
    try {
      mkdirSync(join(root, "eval"), { recursive: true });
      if (suite === "adversarial") {
        const db = await getDb();
        const subs = (await subscribersFor(db, m.id)).filter((s) => !s.is_sample && s.paypal_subscription_id && s.status === "ACTIVE");
        if (!subs.length) throw new KeptError("The harness needs one live, active subscription on this shop.", "no_subject", 409);
        const policy = await currentPolicy(db, m.id);
        const out = await runAdversarial(m, subs[0], subs[1] ?? null, policy?.rules ?? null);
        writeFileSync(join(root, "eval", "adversarial.md"), renderAdversarialReport(out));
        return back(res, "/dashboard/eval?suite=adversarial", `${out.passed}/${out.cases} hostile moves stopped where they should be.`);
      }
      const out = await runReasonEval({ split: "heldout" });
      writeFileSync(join(root, "eval", "results.md"), renderReasonReport(out));
      back(res, "/dashboard/eval?suite=reasons", `Ran ${out.cases} held-out cases across ${out.summary.length} arms${hasOpenAI() ? "" : " (no model key, so no model arm)"}.`);
    } catch (e) {
      back(res, `/dashboard/eval?suite=${suite}`, errMsg(e), true);
    }
  }));
  r.get("/dashboard/eval.csv", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const suite = typeof req.query.suite === "string" ? req.query.suite : "reasons";
    res.type("text/csv").set("Content-Disposition", `attachment; filename="kept-eval-${suite}.csv"`).send(toCsv(await evalRows(suite)));
  }));
  r.get("/dashboard/eval/:suite.md", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const file = req.params.suite === "adversarial" ? "adversarial.md" : "results.md";
    try {
      res.type("text/markdown").send(readFileSync(join(root, "eval", file), "utf8"));
    } catch {
      res.status(404).type("text/plain").send("Not run yet.");
    }
  }));

  /* ---------------- money desk (K5) ---------------- */
  r.get("/dashboard/money", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const db = await getDb();
    const subs = await subscribersFor(db, m.id);
    const invoices = (await db.query<any>("SELECT i.*, s.ref, s.subscriber_name FROM invoices i JOIN subscribers s ON s.id = i.subscriber_id WHERE i.merchant_id = $1 ORDER BY i.created_at DESC LIMIT 50", [m.id])).rows;
    let txns: Awaited<ReturnType<typeof svc.transactionsFor>> | null = null;
    let txnErr = "";
    if (req.query.lookup === "1") {
      try {
        txns = await svc.transactionsFor(m, 31);
      } catch (e) {
        txnErr = errMsg(e);
      }
    }
    const failing = subs.filter((s) => s.kept_state === "payment_failed" && !s.is_sample);
    res.send(layout({ title: `${m.name} · Money`, nav: "dashboard", owner: nav(m) }, html`
      <h1>Money desk</h1><p class="muted">Transaction Search and balances (read-only), and collecting or invoicing failed renewals. Every figure comes from PayPal.</p>${flash(req)}${await killBanner(m.id)}
      <div class="card"><h2>Failed renewals</h2><p class="sub">Collect the outstanding balance (capture) or send an invoice instead. Above your threshold either one waits for your approval on the guard page.</p>
        ${failing.length ? failing.map((s) => html`<div class="event-row"><span>${s.subscriber_name ?? s.subscriber_email ?? s.ref}</span><span>outstanding ${fmtMoney(s.outstanding, m.currency)}</span><span class="row"><form method="post" action="/dashboard/money/sub/${s.ref}/collect" class="inline"><button class="btn small primary" type="submit">Collect now</button></form><form method="post" action="/dashboard/money/sub/${s.ref}/invoice" class="inline"><button class="btn small" type="submit">Send an invoice</button></form></span></div>`) : html`<p class="muted">No failed renewals right now. This desk fills when PayPal reports a failed renewal.</p>`}
      </div>
      <div class="grid g2">
        <div class="card"><h2>Invoices (Invoicing v2)</h2>${invoices.length ? html`<table><tr><th>Invoice</th><th>Subscriber</th><th>Amount</th><th>Status</th><th>Trace</th></tr>${invoices.map((i: any) => html`<tr><td><code class="small">${i.paypal_invoice_id}</code></td><td>${i.subscriber_name ?? i.ref}</td><td>${fmtMoney(Number(i.amount), i.currency)}</td><td><span class="pill ${i.status === "PAID" ? "good" : ""}">${i.status}</span></td><td>${i.run_id ? html`<a href="/trace/${i.run_id}">run</a>` : ""}</td></tr>`)}</table>` : html`<p class="muted">No invoices yet.</p>`}
          <form method="post" action="/dashboard/money/invoices/check" class="inline" style="margin-top:8px"><button class="btn small" type="submit">Re-read invoice status from PayPal</button></form></div>
        <div class="card"><h2>Transaction Search and balances</h2><p class="sub">Read-only, through the merchant's own credentials. The owner's agent gets the same through the read-only MCP tool search_transactions.</p>
          <a class="btn" href="/dashboard/money?lookup=1">Look up the last 31 days</a>
          ${txnErr ? html`<p class="banner bad">${txnErr}</p>` : ""}
          ${txns ? html`<p class="small muted">${txns.from.slice(0, 10)} to ${txns.to.slice(0, 10)} · ${txns.transactions.length} transactions on this shop's subscriptions${txns.otherShopsHidden ? ` (${txns.otherShopsHidden} from other shops on the shared sandbox account hidden)` : ""}${txns.balances.length ? ` · balance of ${txns.balancesScope}: ${txns.balances.map((b) => `${b.total} ${b.currency}${Number(b.withheld) ? ` (withheld ${b.withheld})` : ""}`).join(", ")}` : ""}</p><div class="table-wrap"><table class="evalgrid"><tr><th>Date</th><th>Id</th><th>Amount</th><th>Status</th><th>Payer</th></tr>${txns.transactions.slice(0, 50).map((t) => html`<tr><td>${t.transaction_initiation_date.slice(0, 10)}</td><td><code class="small">${t.transaction_id}</code></td><td>${t.transaction_amount.value} ${t.transaction_amount.currency_code}</td><td>${t.transaction_status}</td><td>${t.payer_email ?? ""}</td></tr>`)}</table></div><a class="small" href="/dashboard/money/transactions.json">JSON</a>` : ""}
        </div>
      </div>
    `));
  }));
  r.post("/dashboard/money/sub/:ref/collect", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const out = await svc.paymentFixed(req.params.ref, { kind: "owner" }, `owner-collect-${req.params.ref}-${new Date().toISOString().slice(0, 13)}`);
      back(res, "/dashboard/money", out.captured ? `Collected ${out.captured} ${m.currency}.` : out.note);
    } catch (e) {
      back(res, "/dashboard/money", errMsg(e), true);
    }
  }));
  r.post("/dashboard/money/sub/:ref/invoice", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const out = await svc.invoiceOutstanding(req.params.ref, { kind: "owner" }, `owner-invoice-${req.params.ref}-${new Date().toISOString().slice(0, 13)}`);
      back(res, "/dashboard/money", `${out.note} (${out.invoiceId}, ${out.status})`);
    } catch (e) {
      back(res, "/dashboard/money", errMsg(e), true);
    }
  }));
  r.post("/dashboard/money/invoices/check", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const out = await svc.checkInvoices();
    back(res, "/dashboard/money", `Checked ${out.checked} invoices; ${out.paid} paid.`);
  }));
  r.get("/dashboard/money/transactions.json", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner required", "unauthorized", 401);
    return svc.transactionsFor(m, 31);
  }));
  /* ---------------- channels and webhooks (B.8) ---------------- */
  r.get("/dashboard/channels", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const msgs = await recentMessages(80);
    const tg = Number((await (await getDb()).query<any>("SELECT count(*)::int AS n FROM party_links WHERE channel = 'telegram' AND party = 'owner' AND party_id = $1", [m.id])).rows[0]?.n ?? 0) > 0;
    const phones = await smsLinks("owner", m.id);
    const codeSent = typeof req.query.code === "string" ? req.query.code : "";
    res.send(layout({ title: "Messages", nav: "dashboard", owner: nav(m) }, html`
      <div class="page-head"><div><h1>Messages and alerts</h1><p>What reaches you and your members on their phones: renewal reminders with Skip and Keep buttons, and approvals for you.</p></div></div>${flash(req)}
      ${telegramReady() ? html`<section class="card" id="phone"><h2>Approvals on your phone</h2><p class="sub">Held offers and large collections arrive on Telegram with Approve and Decline buttons.</p>
        <div class="row">${tg ? html`<span class="pill good">Telegram connected</span>` : html`<span class="pill">Telegram not connected</span>`}<form method="post" action="/connect/telegram" class="inline" target="_blank"><button class="btn primary" type="submit">${raw(icon("message"))}${tg ? "Connect another chat" : "Connect Telegram"}</button></form><button class="btn" type="button" id="push-sub">${raw(icon("zap"))}Turn on notifications in this browser</button></div>
        <p class="small muted">Telegram opens with a one-time code that lasts 15 minutes: press Start and you're done. Members connect from their own member page.${telegramReady() ? "" : " The bot token isn't set on this server, so Telegram messages are logged below as not sent."}${pushReady() ? "" : " Browser notifications need VAPID keys on the server."}</p></section>` : html`<section class="card" id="phone"><h2>Approvals on your phone</h2><p class="sub">Held offers and large collections can reach this browser as notifications.</p><div class="row"><button class="btn primary" type="button" id="push-sub">${raw(icon("zap"))}Turn on notifications in this browser</button></div><p class="small muted">Telegram is off: Kept has no bot of its own yet.${pushReady() ? "" : " Browser notifications need VAPID keys on the server."}</p></section>`}
      <section class="card" id="sms"><h2>Texts (SMS)</h2><p class="sub">The same approvals by text message, each with a link to approve or decline. Sent from Kept's Twilio number.</p>
        ${!smsReady() ? html`<p class="small muted">Texts aren't set up on this server (no Twilio keys).</p>` : phones.length ? html`<div class="row"><span class="pill good">Texts on: ${phones.join(", ")}</span><form method="post" action="/dashboard/channels/sms/stop" class="inline"><button class="btn" type="submit">Stop texts</button></form></div>` : codeSent ? html`<form method="post" action="/dashboard/channels/sms/verify" class="row"><label>Code sent to ${codeSent} <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required style="width:8rem"></label><button class="btn primary" type="submit">Confirm</button></form>` : html`<form method="post" action="/dashboard/channels/sms/start" class="row"><label>Mobile number <input name="phone" type="tel" autocomplete="tel" placeholder="+65 8123 4567" required></label><label class="small"><input type="checkbox" name="consent" value="1" required> Text me about held offers and collections. Reply STOP to opt out.</label><button class="btn primary" type="submit">Send code</button></form>`}
      </section>
      <div class="grid g2">
        <div class="card"><h2>All recent messages</h2>${msgs.slice(0, 30).map((x: any) => html`<div class="small" style="padding:0.3rem 0;border-bottom:1px solid var(--ui-border)"><span class="muted">${fmtDate(x.created_at, true)}</span> ${x.channel} · ${x.direction === "in" ? "received" : "sent"} · ${String(x.body).slice(0, 90)} <span class="pill">${x.status}</span></div>`)}</div>
      </div>
      <script src="/static/pwa.js"></script>
    `));
  }));
  /** One tap: a 15-minute one-time code, then straight into Telegram; the shared bot routes "kept-<code>" here. */
  const tgCode = async (party: "owner" | "subscriber", partyId: string) => {
    const code = randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
    await (await getDb()).query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`tglink:${code}`, JSON.stringify({ party, party_id: partyId, exp: Date.now() + 15 * 60_000 })]);
    return `https://t.me/${config.channels.telegramBot}?start=kept-${code}`;
  };
  r.post("/connect/telegram", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    if (!telegramReady()) return res.status(404).send("Telegram is off for Kept: it has no bot of its own yet.");
    res.redirect(303, await tgCode("owner", m.id));
  }));
  r.post("/manage/:ref/connect/telegram", page(async (req, res) => {
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s || s.is_sample) return res.status(404).send("Subscription not found");
    if (!telegramReady()) return res.status(404).send("Telegram is off for Kept: it has no bot of its own yet.");
    res.redirect(303, await tgCode("subscriber", s.id));
  }));
  r.post("/webhooks/telegram", json(async (req, res) => {
    if (config.channels.telegramSecret && req.header("x-telegram-bot-api-secret-token") !== config.channels.telegramSecret) {
      res.status(401);
      return { ok: false };
    }
    await telegramUpdate(req.body);
    return { ok: true };
  }));
  /* ---------------- SMS (Twilio) ---------------- */
  r.post("/dashboard/channels/sms/start", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const out = await startSmsLink("owner", m.id, String(req.body?.phone ?? ""), req.body?.consent === "1");
      res.redirect(303, `/dashboard/channels?code=${encodeURIComponent(out.to)}#sms`);
    } catch (e) {
      back(res, "/dashboard/channels", errMsg(e), true);
    }
  }));
  r.post("/dashboard/channels/sms/verify", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const out = await verifySmsLink("owner", m.id, String(req.body?.code ?? ""));
      back(res, "/dashboard/channels", `Texts are on for ${out.phone}.`);
    } catch (e) {
      back(res, "/dashboard/channels", errMsg(e), true);
    }
  }));
  r.post("/dashboard/channels/sms/stop", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    await stopSms("owner", m.id);
    back(res, "/dashboard/channels", "Texts are off.");
  }));
  r.post("/webhooks/twilio", async (req, res) => {
    const params = Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)]));
    if (!twilioSignatureValid(`${config.appUrl}/webhooks/twilio`, params, req.header("x-twilio-signature"))) return res.status(403).type("text/plain").send("bad signature");
    try {
      await twilioInbound(params);
    } catch (e) {
      console.error("twilio inbound", e);
    }
    // Any reply is queued and sent through the API, so the TwiML answer stays empty.
    res.type("text/xml").send("<Response></Response>");
  });
  r.get("/webhooks/whatsapp", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === config.channels.whatsappVerifyToken) return res.type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    return res.status(403).send("verify token mismatch");
  });
  r.post("/webhooks/whatsapp", json(async (req) => {
    await whatsappUpdate(req.body);
    return { ok: true };
  }));

  /* ---------------- PWA (B.8) ---------------- */
  r.get("/manifest.webmanifest", (_req, res) => {
    res.type("application/manifest+json").json({ name: "Kept", short_name: "Kept", start_url: "/", display: "standalone", background_color: "#f7f5f0", theme_color: "#1f5c47", icons: [{ src: "/static/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] });
  });
  r.get("/sw.js", (_req, res) => res.type("application/javascript").set("Service-Worker-Allowed", "/").send(readFileSync(join(root, "public", "sw.js"), "utf8")));
  r.get("/push/public-key", (_req, res) => res.json({ key: config.channels.vapidPublic || null }));
  r.post("/push/subscribe", json(async (req) => {
    const owner = await ownerOf(req);
    const ref = typeof req.query.ref === "string" ? await subscriberByRef(await getDb(), req.query.ref) : null;
    if (!owner && !ref) throw new KeptError("Sign in or open your manage page first.", "unauthorized", 401);
    if (!req.body?.endpoint) throw new KeptError("Not a push subscription", "invalid", 400);
    await subscribe(owner ? "owner" : "subscriber", owner ? owner.id : ref!.id, req.body);
    return { ok: true, sending: pushReady() };
  }));

  /* ---------------- evidence (what is real) ---------------- */
  r.get("/dashboard/evidence", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const usage = await aiUsageSummary();
    const chain = await verifyChain();
    const fair = await fairness(m.id);
    const dbe = await getDb();
    const linked = (await dbe.query<any>("SELECT channel, count(*)::int AS n FROM party_links WHERE channel IN ('telegram','whatsapp','sms') AND ((party = 'owner' AND party_id = $1) OR (party = 'subscriber' AND party_id IN (SELECT id FROM subscribers WHERE merchant_id = $1))) GROUP BY channel", [m.id])).rows;
    const nLinked = (c: string) => Number(linked.find((x: any) => x.channel === c)?.n ?? 0);
    const rows: [string, string, string][] = [
      ["Subscriptions: create, revise, suspend, activate, cancel, capture outstanding, transactions", "real (sandbox)", "every write behind the gate with a trace step and PayPal-Request-Id"],
      ["Invoicing v2 create and send", "real (sandbox)", "only when a renewal genuinely fails on PayPal and the owner chooses to invoice"],
      ["Transaction Search and balances", "real (sandbox, read-only)", "money desk and the owner's MCP tool"],
      ["Webhooks", "real (sandbox), signature-verified", "unsigned or invalid events are refused"],
      ["Failed renewals", "real only", "shown only when PayPal reports a failed payment by verified webhook or read-back; no test switch exists"],
      ["Log in with PayPal", config.paypal.loginEnabled ? "on" : "off (PAYPAL_LOGIN_ENABLED)", "needs Log in with PayPal enabled on the sandbox app"],
      ["Model brain", hasOpenAI() ? "live (OpenAI)" : "rules only", providerLabel()],
      ["Telegram", telegramReady() ? `bot connected · ${nLinked("telegram")} chats linked` : "off: Kept has no bot of its own (KEPT_TELEGRAM is not on)", "renewal reminders and owner approvals with buttons"],
      ["WhatsApp", whatsappReady() ? `connected · ${nLinked("whatsapp")} linked` : "not configured (no WhatsApp Cloud API token)", "same messages as Telegram when configured"],
      ["SMS (Twilio)", smsReady() ? `configured · ${nLinked("sms")} numbers linked` : "not configured", "renewal reminders, payment notices and owner approvals by text, with a link; numbers are confirmed by a texted code"],
      ["Web push", pushReady() ? "configured (VAPID)" : "not configured", "to browsers that turn on notifications"],
      ["Passkey countersign", "real WebAuthn, attestation not verified", "ES256/RS256 with Node crypto"],
      ["Backtest history", `real · ${(await history(m.id)).length} requests`, "this shop's own cancellation requests from the last 90 days"],
      ["Fairness scorecard", "measured", `${fair.cancels} cancels, ${fair.offers_made} offers, from this shop's event log`],
    ];
    res.send(layout({ title: `${m.name} · Evidence`, nav: "dashboard", owner: nav(m) }, html`
      <h1>Evidence: what is real</h1><p class="muted">Labelled honestly, row by row.</p>
      <div class="card"><table><tr><th>Capability</th><th>Status</th><th>Note</th></tr>${rows.map(([a, b, c]) => html`<tr><td>${a}</td><td><span class="pill ${/^real|live|on$/.test(b) ? "good" : /not sent|off|rules|not wired/.test(b) ? "warn" : ""}">${b}</span></td><td class="small">${c}</td></tr>`)}</table></div>
      <div class="grid g2"><div class="card"><h2>Model usage</h2><p>${usage.ok}/${usage.calls} calls ok, estimated $${usage.cost_usd.toFixed(4)}.</p>${usage.by_purpose.map((p) => html`<div class="small">${p.purpose}: ${p.calls} calls, p50 ${p.p50_ms} ms, $${p.cost_usd.toFixed(4)}${p.replayed ? `, ${p.replayed} replayed` : ""}</div>`)}</div>
      <div class="card"><h2>Audit chain</h2><p>${chain.ok ? html`<span class="pill good">verified</span>` : html`<span class="pill bad">broken</span>`} ${chain.rows} rows.</p><p><a href="/dashboard/eval">Evals</a> · <a href="/dashboard/traces">Agent runs</a> · <a href="/dashboard/compliance">Compliance</a> · <a href="/dashboard/guard">Guard</a></p></div></div>
    `));
  }));

  /* ---------------- judge mode (B.10) ---------------- */
  r.get("/judge", page(async (req, res) => {
    const db = await getDb();
    const m = (await db.query<Merchant>("SELECT * FROM merchants WHERE slug = $1", [process.env.KEPT_DEMO_SHOP || "ember-oak-coffee-club"])).rows[0] ?? (await db.query<Merchant>("SELECT * FROM merchants ORDER BY created_at LIMIT 1")).rows[0] ?? null;
    let sid = typeof req.cookies?.kept_judge === "string" ? req.cookies.kept_judge : "";
    const existing = sid ? (await db.query("SELECT * FROM judge_sessions WHERE id = $1", [sid])).rows[0] : null;
    if (!existing) {
      sid = newId("judge");
      await db.query("INSERT INTO judge_sessions (id, merchant_id) VALUES ($1,$2)", [sid, m?.id ?? null]);
      res.cookie("kept_judge", sid, { httpOnly: true, sameSite: "lax", maxAge: 2 * 3600_000 });
    }
    const beat = Math.max(0, Math.min(5, Number(req.query.beat ?? (existing as any)?.beat ?? 0)));
    await db.query("UPDATE judge_sessions SET beat = $2, last_seen = now() WHERE id = $1", [sid, beat]);
    const beats = [
      ["An agent cancels a coffee subscription for its human", `Claude Desktop (or any MCP client) calls cancel_subscription with hear_offer=true on ${config.appUrl}/s/${m?.slug ?? "<shop>"}/mcp. One honest offer comes back; the agent relays it.`],
      ["The human declines; the cancel is honoured in one call", "respond_to_offer(accept=false) cancels at PayPal and reads back CANCELLED. No second offer, no survey, no hurdle."],
      ["The trace", `Every step: reason classified (model or rules), eligibility in code, the gate's decision with the rule it hit, PayPal request id. <a href="/dashboard/traces">Agent runs</a>.`],
      ["The owner's dashboard: fairness scorecard, backtest, compliance", `<a href="/dashboard/guard">Guard</a> shows the measured one-call cancel rate, the 90-day backtest of real requests with what-if sliders, earned autonomy. <a href="/dashboard/compliance">Compliance</a> scores the policy per jurisdiction.`],
      ["A rule the law forbids is refused with the citation", `On <a href="/onboard/rules">Rules</a> type "three offers before cancel": refused, citing ROSCA §8403(3) and Cal. §17602(d). Type "customers must call to cancel": refused, citing CA, CO and NY.`],
      ["Evidence and evals", `<a href="/dashboard/evidence">What is real</a>, <a href="/dashboard/eval">three-arm reason eval with the dollars column</a>, adversarial harness: 26 hostile moves, none reach PayPal.`],
    ];
    res.send(layout({ title: "Kept · Judge mode", nav: "home" }, html`
      <h1>Judge mode</h1><p class="muted">Isolated session ${sid.slice(0, 12)} · beat ${beat + 1} of ${beats.length}. ${config.demoMode ? html`Sign in as the demo owner from <a href="/login">Owner sign-in</a> to open the dashboard links.` : ""}</p>
      <div class="card beats">${beats.map(([t, d], i) => html`<div class="beat" style="${i === beat ? "background:var(--accent-soft);border-radius:8px;padding:10px" : ""}"><div><b>${t}</b><div class="small">${raw(d)}</div></div></div>`)}
        <div class="row" style="margin-top:10px"><a class="btn" href="/judge?beat=${Math.max(0, beat - 1)}">Back</a><a class="btn primary" href="/judge?beat=${Math.min(beats.length - 1, beat + 1)}">Next</a><a class="btn" href="/judge/reset">Reset session</a></div></div>
      <p class="small muted">Each visitor gets a private copy of the demo shop (<a href="/demo">start or open yours</a>); nobody else sees what you do in it, and it is removed 48 hours after your last visit.</p>
    `));
  }));
  r.get("/judge/reset", page(async (req, res) => {
    const sid = typeof req.cookies?.kept_judge === "string" ? req.cookies.kept_judge : "";
    if (sid) await (await getDb()).query("DELETE FROM judge_sessions WHERE id = $1", [sid]);
    res.clearCookie("kept_judge");
    res.redirect("/judge");
  }));

  return r;
}

/** JSON API for runs (owner key or cookie). */
export function runsApi(): Router {
  const r = Router();
  r.get("/runs", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner key required", "unauthorized", 401);
    return { runs: await recentRuns(m.id, Number(req.query.limit ?? 50)) };
  }));
  r.get("/runs/:id", json(async (req) => {
    const m = await ownerOf(req);
    const t = await loadRun(req.params.id);
    if (!t) throw new KeptError("No such run", "not_found", 404);
    if (!m || t.run.merchant_id !== m.id) throw new KeptError("Owner key required for this run", "unauthorized", 401);
    return t;
  }));
  r.get("/subscriptions/:ref/runs", json(async (req) => {
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s) throw new KeptError("No subscription with that reference.", "not_found", 404);
    return { runs: await runsFor("subscriber", s.id, 20) };
  }));
  return r;
}

export const _deps = { esc, plansFor, merchantBySlug };
