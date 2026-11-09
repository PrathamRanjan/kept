/**
 * Scam and fraud protection (SAFETY_ACCESSIBILITY_SPEC §4, §6 Kept row). For the owner: check a message (rules on the
 * server, the fine-tuned text model in this browser), see inbound messages with their scan, see the holds the safety
 * layer created and why, and switch protected mode on. For a subscriber: a check page from their own manage link,
 * because the classic bait is a fake "your payment failed, pay here" message.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { getDb } from "../db.js";
import { assessMessage, protectedMode, safetyHolds, setProtectedMode } from "../safety/index.js";
import { TACTIC_WORDS, TACTICS } from "../safety/rules.js";
import { KeptError, merchantById, subscriberByRef, type Merchant } from "../store.js";
import { ownerOf } from "./guard.js";
import { fmtDate, html, layout, raw, type Raw } from "./html.js";

type Page = (req: Request, res: Response) => Promise<unknown>;
const page = (fn: Page) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const back = (res: Response, url: string, msg: string, isErr = false) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${isErr ? "err" : "ok"}=${encodeURIComponent(msg)}`);
function flash(req: Request): Raw {
  const msg = typeof req.query.ok === "string" ? req.query.ok : typeof req.query.err === "string" ? req.query.err : "";
  return msg ? html`<div class="banner ${req.query.err ? "bad" : "good"}">${msg}</div>` : raw("");
}
async function requireOwner(req: Request, res: Response): Promise<Merchant | null> {
  const m = await ownerOf(req);
  if (!m) {
    if (req.accepts("html")) res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    else res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return m;
}

/** The message the demo button pastes: the fake failed-payment text aimed at a subscriber. */
export const DEMO_FAKE_FAILED = "Kept Billing: your Morning Roast subscription payment failed and your membership will be cancelled within 24 hours. Pay here to keep it: http://kept-billing-renew.co/pay and re-enter your card details. Reply with the code PayPal texts you to confirm.";

const SCRIPTS = raw(`<script src="https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/ort.min.js"></script><script type="module" src="/static/safety.js"></script>`);

const checkCard = (intro: string, demo: string) => html`<div class="card" id="check"><h2>Check a message</h2><p class="small muted">${intro} The model scores it on this device; the words never leave your browser for the score.</p>
<form id="scan-form" class="stack"><label for="scan-text" class="sr">Message to check</label><textarea id="scan-text" name="text" rows="6" placeholder="Paste the message here" style="width:100%"></textarea>
<div class="row"><button class="btn primary" type="submit" id="scan-btn">Check this message</button><button class="btn" type="button" id="scan-demo">Paste the demo scam</button><span class="small muted" id="scan-status" aria-live="polite"></span></div></form>
<div id="scan-result" aria-live="polite"></div>${raw(`<script type="application/json" id="demo-bec">${JSON.stringify({ text: demo }).replace(/</g, "\\u003c")}</script>`)}</div>`;

const modelCard = (back: string) => html`<h1>How the scam check was tested</h1>
<p class="muted">Numbers come from frozen test sets the model never trained on. Everything synthetic is marked. Full card in the repository at <span class="mono">guard-lab/MODEL_CARD.md</span>. <a href="${back}">Back</a>.</p>
<div class="card"><h2>Text model (runs in your browser, 23 MB)</h2><table><thead><tr><th>Test set</th><th>Messages</th><th>AUC</th><th>Caught at 1% genuine held</th><th>What it is</th></tr></thead><tbody>
<tr><td>ScamShield SMS test</td><td>8,188</td><td>0.988</td><td>75%</td><td>real Singapore SMS, in-distribution</td></tr>
<tr><td>ScamShield eval sets</td><td>1,574</td><td>0.979</td><td>67%</td><td>real and hand-written</td></tr>
<tr><td>Singlish genuine</td><td>600</td><td>—</td><td>1.0% held</td><td>real everyday messages: the false-alarm check</td></tr>
<tr><td>Business templates</td><td>200</td><td>0.85</td><td>11%</td><td>author-written, held-out templates</td></tr>
<tr><td>Business email (BEC) seed</td><td>200</td><td>0.58</td><td>25%</td><td>hand-written; the model is weak here, which is why the fake failed-payment message is also a rule</td></tr>
</tbody></table><p class="small muted">Browser and Python agree on the hold decision for 197 of 200 messages; the three differ because int8 arithmetic differs between runtimes.</p></div>
<div class="card"><h2>Payment-risk model</h2><p>LightGBM, 300 trees, monotone: a scam signal can only raise the score. <b>Trained on synthetic data</b>; there is no real payment-fraud data in this project. Its score is a ranking signal shown with the rule reasons, never a fraud rate.</p></div>
<div class="card"><h2>Tactics the model names</h2><ul>${TACTICS.map((t) => html`<li><b>${t.replace(/_/g, " ")}</b>: ${TACTIC_WORDS[t]}</li>`)}</ul></div>`;

async function scanBody(req: Request, res: Response) {
  const text = String(req.body?.text ?? "").slice(0, 4000);
  if (!text.trim()) return res.status(400).json({ error: "bad_request", message: "Paste a message first." });
  res.json(assessMessage(text));
}

export function safetyRouter(): Router {
  const r = Router();

  r.get("/dashboard/safety", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const db = await getDb();
    const inbound = (await db.query<any>("SELECT * FROM channel_messages WHERE direction = 'in' ORDER BY created_at DESC LIMIT 20")).rows;
    const holds = await safetyHolds(m.id, db);
    const prot = await protectedMode(m.id, db);
    res.send(layout({ title: "Scam and fraud protection", nav: "dashboard", owner: { name: m.name, slug: m.slug }, scripts: SCRIPTS }, html`<h1>Scam and fraud protection</h1>${flash(req)}
<p class="muted">Rules in code, a scam text model that runs in your browser, and a payment-risk model. Strictest wins; none of them can move money. Anything held waits for you on <a href="/dashboard/guard">Guard</a>. <a href="/dashboard/safety/model-card">How it was tested</a>.</p>
<div class="grid g2">
<div class="card" id="how"><h2>How your subscribers are protected</h2><ul>
<li><b>No "pay here" links, ever.</b> Kept never sends one. A failed payment shows on the subscriber's own page, reached from their bookmark or your site. Every manage page says so, with a check tool for messages they receive.</li>
<li><b>Refunds go back where the money came from.</b> A subscriber asking for a refund to a different account pauses an agent's refund until a person replies.</li>
<li><b>Protected mode</b> holds every capture, invoice, refund and offer made by an agent or the worker, and tells a trusted contact.</li></ul></div>
<div class="card" id="protected"><h2>Protected mode <span class="pill ${prot.on ? "active" : "cancelled"}">${prot.on ? "on" : "off"}</span></h2><p class="small muted">Holds are explained calmly with no timers, and a trusted contact is told about every hold.</p>
<form method="post" action="/dashboard/safety/protected" class="stack"><label for="pc1">Trusted contact (Telegram chat id, optional)</label><input id="pc1" name="contact1" value="${prot.contacts[0] ?? ""}" placeholder="telegram:123456789"><label for="pc2">Second contact</label><input id="pc2" name="contact2" value="${prot.contacts[1] ?? ""}"><button class="btn primary" type="submit" name="on" value="${prot.on ? "0" : "1"}">${prot.on ? "Turn protected mode off" : "Turn protected mode on"}</button></form></div></div>
${checkCard("Paste a text, email or chat message a subscriber forwarded.", DEMO_FAKE_FAILED)}
<div class="card" id="inbound"><h2>Messages received</h2>${inbound.length ? html`<ul class="feed">${inbound.map((x) => { const a = assessMessage(x.body); return html`<li>${a.level !== "clear" ? html`<div class="banner ${a.level === "hold" ? "bad" : "warn"}" role="alert"><b>Scam check:</b> ${a.reasons[0]}</div>` : ""}<span class="small muted">${x.channel} · ${x.address} · ${fmtDate(x.created_at, true)}</span><br>${x.body}</li>`; })}</ul>` : html`<p class="muted">No inbound messages yet.</p>`}</div>
<div class="card" id="holds"><h2>Holds the safety layer created</h2>${holds.length ? html`<ul class="feed">${holds.map((h) => html`<li><b>${h.action} ${h.payload.cents ? `$${(Number(h.payload.cents) / 100).toFixed(2)}` : ""}</b> <span class="pill ${h.status}">${h.status}</span>${h.payload.safety_reasons?.length ? html`<details class="small"><summary>Why we paused this</summary><ul>${h.payload.safety_reasons.map((x: string) => html`<li>${x}</li>`)}</ul></details>` : ""}</li>`)}</ul>` : html`<p class="muted">None yet.</p>`}</div>
<div class="card" id="a11y"><h2>Accessibility</h2><p class="small muted">Text size, contrast, a clearer font, read-aloud, voice input, plain words, bigger buttons and more time: open <button class="btn small" type="button" data-a11y-open>Display and help</button> on any page. Choices stay on this device.</p></div>`));
  }));

  r.get("/dashboard/safety/model-card", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    res.send(layout({ title: "How the scam check was tested", nav: "dashboard", owner: { name: m.name, slug: m.slug } }, modelCard("/dashboard/safety")));
  }));

  r.post("/dashboard/safety/scan", page(scanBody));

  r.post("/dashboard/safety/protected", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const on = String(req.body.on) === "1";
    await setProtectedMode(m.id, on, [String(req.body.contact1 ?? "").trim(), String(req.body.contact2 ?? "").trim()]);
    back(res, "/dashboard/safety#protected", on ? "Protected mode is on." : "Protected mode is off.");
  }));

  // Subscriber side: reached only from their own manage link.
  r.get("/manage/:ref/check", page(async (req, res) => {
    const db = await getDb();
    const s = await subscriberByRef(db, req.params.ref);
    if (!s) throw new KeptError("Subscription not found", "not_found", 404);
    const m = (await merchantById(db, s.merchant_id))!;
    res.send(layout({ title: "Is this message really from us?", nav: "manage", scripts: SCRIPTS }, html`<h1>Is this message really from ${m.name}?</h1>
<p data-simple="If a payment fails, it shows on your subscription page. We never send a link to pay. Paste the message below to check it.">If a payment ever fails, it shows on <a href="/manage/${s.ref}">your subscription page</a>, and only there. ${m.name} and Kept never send a "pay here" link by text or email. Paste any message you are unsure about and it is checked here, on your device.</p>
${checkCard("Paste the text or email you received.", DEMO_FAKE_FAILED)}
<p class="small muted"><a href="/manage/${s.ref}">Back to your subscription</a></p>`));
  }));
  r.post("/manage/:ref/check/scan", page(scanBody));

  return r;
}
