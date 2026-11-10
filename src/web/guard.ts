/**
 * Owner guard console (roadmap B.6, K2, K3): plain-words policy with backtest and what-if sliders, earned autonomy,
 * held approvals with passkey countersign, kill switches with a visible banner, the hash-chained audit log, and
 * the compliance scorecard by jurisdiction.
 */
import { nextOf } from "./safetyui.js";
import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { recentAudit, verifyChain } from "../guard/audit.js";
import { adoptSuggestions, backtest, history, suggestAutonomy } from "../guard/backtest.js";
import { decideApproval, guardSettings, pendingApprovals, saveGuardSettings } from "../guard/dryrun.js";
import { isKilled, listKills, setKill } from "../guard/kill.js";
import { finishRegistration, hasPasskey, newChallenge, PASSKEY_JS, verifyAssertion } from "../guard/passkey.js";
import { JURISDICTIONS, scoreAll, scoreCompliance, type Jurisdiction } from "../policy/compliance.js";
import { describeRules, validateRules, type Rules } from "../policy/rules.js";
import * as svc from "../service.js";
import { currentPolicy, KeptError, type Merchant, merchantById, plansFor } from "../store.js";
import { sign, unsign } from "../lib/crypto.js";
import { fairness } from "../eval/fairness.js";
import { esc, fmtMoney, html, layout, raw, type Raw } from "./html.js";

const COOKIE = "kept_owner";
type Page = (req: Request, res: Response) => Promise<unknown>;
const page = (fn: Page) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
const json = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).then((out) => { if (!res.headersSent) res.json(out); }).catch((e) => res.status(e instanceof KeptError ? e.status : 400).json({ error: e instanceof KeptError ? e.code : "error", message: (e as Error).message }));

export async function ownerOf(req: Request): Promise<Merchant | null> {
  const id = unsign(req.cookies?.[COOKIE]);
  if (id) return merchantById(await getDb(), id);
  const token = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (token) return (await getDb()).query<Merchant>("SELECT * FROM merchants WHERE owner_token = $1", [token]).then((r) => r.rows[0] ?? null);
  return null;
}
export { sign as signOwner };

async function requireOwner(req: Request, res: Response): Promise<Merchant | null> {
  const m = await ownerOf(req);
  if (!m) {
    if (req.accepts("html")) res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    else res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return m;
}
const nav = (m: Merchant) => ({ name: m.name, slug: m.slug });
const back = (res: Response, url: string, msg: string, isErr = false) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${isErr ? "err" : "ok"}=${encodeURIComponent(msg)}`);
function flash(req: Request): Raw {
  const msg = typeof req.query.ok === "string" ? req.query.ok : typeof req.query.err === "string" ? req.query.err : "";
  return msg ? html`<div class="banner ${req.query.err ? "bad" : "good"}">${msg}</div>` : raw("");
}
const errMsg = (e: unknown) => (e instanceof KeptError ? e.message : (e as Error).message);

/** The red banner every owner page shows while a kill switch is engaged. */
export async function killBanner(merchantId: string): Promise<Raw> {
  const kills = (await listKills()).filter((k) => k.engaged && (k.scope === "global" || k.scope === `merchant:${merchantId}` || k.scope === "agents" || k.scope.startsWith("agent:")));
  if (!kills.length) return raw("");
  return html`<div class="banner kill">Kill switch engaged: ${kills.map((k) => `${k.scope}${k.reason ? ` (${k.reason})` : ""}`).join(", ")}. Agents cannot move money in that scope; cancels still go through. <a href="/dashboard/guard">Release</a></div>`;
}

export function guardRouter(): Router {
  const r = Router();
  const sub = html``;
  void sub;

  r.get("/dashboard/guard", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const db = await getDb();
    const policy = await currentPolicy(db, m.id);
    const plans = await plansFor(db, m.id, true);
    const settings = await guardSettings(m.id, db);
    const candidateText = typeof req.query.text === "string" ? req.query.text : policy?.source_text ?? "";
    const pct = typeof req.query.pct === "string" ? Number(req.query.pct) : settings.auto_discount_max_pct;
    const cycles = typeof req.query.cycles === "string" ? Number(req.query.cycles) : settings.auto_pause_max_cycles;
    let candidate: Rules | null = policy?.rules ?? null;
    let draftNotes: string[] = [];
    if (typeof req.query.text === "string" && req.query.text.trim()) {
      const p = await svc.previewRules(req.query.text);
      candidate = p.valid ? (validateRules(p.value).rules as Rules) : null;
      draftNotes = [...p.understood, ...p.warnings.map((w) => `Not used: ${w}`), `Drafted by: ${p.brain}`];
    }
    const bt = candidate ? await backtest(m.id, candidate, { auto_discount_max_pct: pct, auto_pause_max_cycles: cycles }, db) : null;
    const suggestions = await suggestAutonomy(m.id, db);
    const approvals = await pendingApprovals(m.id);
    const kills = await listKills();
    const chain = await verifyChain(db);
    const pk = await hasPasskey(m.id, db);
    const fair = await fairness(m.id);
    const hist = await history(m.id, db);
    res.send(layout({ title: `${m.name} · Guard`, nav: "dashboard", owner: nav(m), head: raw(`<script>${PASSKEY_JS}</script>`), scripts: raw(`<script src="/static/guard.js"></script>`) }, html`
      <h1>Approvals and limits</h1><p class="muted">What the agents and the offer step may do on their own, tested against the last 90 days before you adopt it. Cancelling is never part of this: it always works in one step.</p>
      ${flash(req)}${await killBanner(m.id)}

      <div class="card"><h2>Fairness scorecard</h2><p class="sub">Measured from this shop's own event log.</p>
        <div class="score">
          <div class="tile"><div class="label">One-call cancel rate</div><div class="big">${fair.one_call_cancel_rate}%</div><div class="hint">${fair.cancels} cancels, each one step</div></div>
          <div class="tile"><div class="label">Offers made → accepted</div><div class="big">${fair.offers_made} → ${fair.offers_accepted}</div><div class="hint">${fair.offers_declined_or_expired} declined or expired, all cancelled at once; never more than one offer</div></div>
          <div class="tile"><div class="label">Time to cancel (median)</div><div class="big">${fair.median_seconds_to_cancel === null ? "—" : `${fair.median_seconds_to_cancel}s`}</div><div class="hint">p95 ${fair.p95_seconds_to_cancel ?? "—"}s, from request to PayPal's confirmation</div></div>
          <div class="tile"><div class="label">Offers held or blocked</div><div class="big">${fair.held_offers + fair.compliance_blocked_offers}</div><div class="hint">${fair.held_offers} above autonomy, ${fair.compliance_blocked_offers} by a compliance rule</div></div>
        </div></div>

      <div class="card"><h2>Policy in plain words, backtested</h2>
        <form method="get" action="/dashboard/guard">
          <textarea name="text" rows="3" style="width:100%" placeholder="One skip per quarter. Pause up to 2 months. At most 15% off for 3 months. Remind people 7 days before a renewal. My customers are in California.">${candidateText}</textarea>
          <div class="slider"><label for="bt-slider">Discount the offer step may give without you</label><input id="bt-slider" type="range" name="pct" min="0" max="50" value="${pct}"><output id="bt-out">${pct}%</output></div>
          <div class="slider"><label>Pause length it may give without you</label><input type="range" name="cycles" min="0" max="6" value="${cycles}"><output>${cycles} cycles</output></div>
          <button class="btn primary" type="submit">Draft and backtest</button>
        </form>
        ${draftNotes.length ? html`<ul class="small">${draftNotes.map((d) => html`<li>${d}</li>`)}</ul>` : ""}
        ${candidate ? html`<ul>${describeRules(candidate).map((d) => html`<li>${d}</li>`)}</ul>` : html`<p class="muted">No valid policy to test yet.</p>`}
        ${bt ? html`
          <div class="score">
            <div class="tile"><div class="label">Would run on its own</div><div class="big">${bt.run}</div><div class="hint">kept about ${fmtMoney(bt.kept_auto_usd, m.currency)} over 3 cycles</div></div>
            <div class="tile"><div class="label">Would wait for you</div><div class="big">${bt.wait}</div><div class="hint">${fmtMoney(bt.held_usd, m.currency)} not offered unless you approve</div></div>
            <div class="tile"><div class="label">No offer</div><div class="big">${bt.deny}</div><div class="hint">${bt.cancels_without_offer} never asked; ${bt.compliance_blocked} blocked by a compliance rule</div></div>
            <div class="tile"><div class="label">Real requests replayed</div><div class="big">${bt.cases}</div><div class="hint">this shop's last 90 days</div></div>
          </div>
          <details><summary>Every case</summary><div class="table-wrap"><table class="evalgrid"><tr><th>Date</th><th>Subscriber</th><th>Reason</th><th>Outcome</th><th>Offer</th><th>Kept</th><th>Why</th></tr>${bt.rows.map((x) => html`<tr><td>${x.at}</td><td>${x.subscriber}</td><td>${x.reason || "—"} <small class="muted">${x.category}</small></td><td><span class="pill ${x.outcome}">${x.outcome}</span></td><td>${x.offer ?? "—"}</td><td>${x.kept_usd ? fmtMoney(x.kept_usd, m.currency) : "—"}</td><td class="small">${x.note}</td></tr>`)}</table></div></details>
          ${candidate && typeof req.query.text === "string" ? html`<form method="post" action="/dashboard/guard/adopt" class="row" style="margin-top:10px"><input type="hidden" name="text" value="${req.query.text}"><input type="hidden" name="pct" value="${pct}"><input type="hidden" name="cycles" value="${cycles}"><button class="btn primary" type="submit">Adopt these rules and limits</button></form>` : html`<form method="post" action="/dashboard/guard/limits" class="row" style="margin-top:10px"><input type="hidden" name="pct" value="${pct}"><input type="hidden" name="cycles" value="${cycles}"><button class="btn" type="submit">Save these autonomy limits</button></form>`}
        ` : ""}
      </div>

      <div class="grid g2">
        <div class="card"><h2>Earned autonomy</h2><p class="sub">Limits your own decisions support: never past anything you declined.</p>
          <p>Now: discounts up to <b>${settings.auto_discount_max_pct}%</b> and pauses up to <b>${settings.auto_pause_max_cycles} cycles</b> without you; collections above <b>${fmtMoney(settings.approve_capture_above_cents / 100, m.currency)}</b> wait for you.</p>
          ${suggestions.length ? html`<form method="post" action="/dashboard/guard/suggestions">${suggestions.map((s) => html`<label class="check"><input type="checkbox" name="field" value="${s.field}" checked> <span>${s.field.replace(/_/g, " ")}: ${s.current} → <b>${s.suggested}</b><br><small class="muted">${s.basis}</small></span></label>`)}<button class="btn primary" type="submit" style="margin-top:8px">Adopt with one click</button></form>` : html`<p class="muted">No suggestion yet: approve or decline a few held offers (below, or on your phone) and Kept will propose the limit they support.</p>`}
        </div>
        <div class="card"><h2>Waiting for you</h2><p class="sub">Held offers and collections. ${pk ? `Above ${fmtMoney(config.guard.countersignAboveCents / 100, m.currency)} your passkey signs the exact payload.` : "Register a passkey to countersign large approvals."}</p>
          ${approvals.filter((a) => a.status === "pending").length ? approvals.filter((a) => a.status === "pending").map((a) => html`<div class="event-row"><span><span class="pill held">${a.action}</span></span><span>${a.payload.offer ? `${a.payload.offer.type} ${a.payload.offer.percent ? `${a.payload.offer.percent}%` : ""}${a.payload.offer.cycles ? `${a.payload.offer.cycles} cycles` : ""}` : fmtMoney((a.payload.cents ?? 0) / 100, m.currency)}<br><small class="muted">${a.payload.reason ?? ""} · hash ${String(a.payload_hash).slice(0, 12)}</small></span><span class="row">
            ${Number(a.payload.cents ?? 0) >= config.guard.countersignAboveCents && pk ? html`<button class="btn small primary" type="button" data-countersign="${a.id}">Approve with passkey</button>` : html`<form method="post" action="/dashboard/guard/approvals/${a.id}/approve" class="inline"><button class="btn small primary" type="submit">Approve</button></form>`}
            <form method="post" action="/dashboard/guard/approvals/${a.id}/decline" class="inline"><button class="btn small" type="submit">Decline</button></form></span></div>`) : html`<p class="muted">Nothing is waiting.</p>`}
          <details><summary class="small">Decided (${approvals.filter((a) => a.status !== "pending").length})</summary>${approvals.filter((a) => a.status !== "pending").slice(0, 20).map((a) => html`<div class="small">${a.status} · ${a.action} · ${a.method ?? ""} · ${String(a.payload_hash).slice(0, 10)}</div>`)}</details>
          <p style="margin-top:8px"><button class="btn small" type="button" id="pk-register">${pk ? "Add another passkey" : "Register a passkey"}</button> <span class="small muted">WebAuthn; attestation is not verified (said plainly, hackathon scope).</span></p>
        </div>
      </div>

      <div class="grid g2">
        <div class="card"><h2>Kill switches</h2><p class="sub">Stop agents, this shop or everything. A cancel is never blocked by the agent or shop switch.</p>
          <form method="post" action="/dashboard/guard/kill" class="row"><select name="scope"><option value="agents">All agents</option><option value="merchant:${m.id}">This shop</option><option value="global">Everything (global)</option></select><input type="text" name="reason" placeholder="Why (shown on the banner)"><input type="hidden" name="engaged" value="true"><button class="btn" type="submit">Engage</button></form>
          <form method="post" action="/dashboard/guard/kill" class="row" style="margin-top:6px"><input type="text" name="scope" placeholder="agent:<id> to stop one agent" style="flex:1"><input type="hidden" name="engaged" value="true"><button class="btn small" type="submit">Stop that agent</button></form>
          ${kills.filter((k) => k.engaged).length ? html`<ul>${kills.filter((k) => k.engaged).map((k) => html`<li><span class="pill bad">${k.scope}</span> ${k.reason ?? ""} <form method="post" action="/dashboard/guard/kill" class="inline"><input type="hidden" name="scope" value="${k.scope}"><input type="hidden" name="engaged" value="false"><button class="btn small" type="submit">Release</button></form></li>`)}</ul>` : html`<p class="muted">None engaged.</p>`}
        </div>
        <div class="card"><h2>Audit chain</h2><p class="sub">Every policy, approval, kill switch and money decision, hash-chained.</p>
          <p>${chain.ok ? html`<span class="pill good">chain verified</span>` : html`<span class="pill bad">chain broken at ${chain.broken_at}</span>`} ${chain.rows} rows · head <code class="small">${chain.head.slice(0, 16)}…</code> · <a href="/dashboard/guard/audit.json">verify endpoint</a></p>
          ${(await recentAudit(12)).map((a: any) => html`<div class="small"><span class="muted">${new Date(a.at).toISOString().slice(0, 16).replace("T", " ")}</span> ${a.kind} <code>${String(a.hash).slice(0, 10)}</code></div>`)}
        </div>
      </div>

      <div class="card"><h2>History (${hist.length} real cancellation requests)</h2><p class="sub">What the backtest replays: every member of this shop who asked to cancel in the last 90 days. ${hist.length ? "" : "None yet; the backtest fills in as members use the shop."}</p>
        <details><summary>Show</summary><div class="table-wrap"><table class="evalgrid"><tr><th>Date</th><th>Reason</th><th>Category</th><th>Heard an offer</th><th>Accepted</th></tr>${hist.map((h) => html`<tr><td>${h.at.toISOString().slice(0, 10)}</td><td>${h.reason || "—"}</td><td>${h.category}</td><td>${h.heard_offer ? "yes" : "no"}</td><td>${h.accepted_type ?? "—"}</td></tr>`)}</table></div></details>
      </div>
    `));
  }));

  r.post("/dashboard/guard/adopt", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const p = await svc.previewRules(String(req.body.text ?? ""));
      if (!p.valid) throw new KeptError(`These rules can't be approved: ${p.errors.join(" ")}`, "invalid_rules", 422);
      const out = await svc.approveRules(m.id, p.value, String(req.body.text ?? ""), p.understood);
      await saveGuardSettings(m.id, { auto_discount_max_pct: Number(req.body.pct), auto_pause_max_cycles: Number(req.body.cycles) }, "owner");
      back(res, "/dashboard/guard", `Rules v${out.version} adopted with autonomy ${req.body.pct}% / ${req.body.cycles} cycles.`);
    } catch (e) {
      back(res, "/dashboard/guard", errMsg(e), true);
    }
  }));
  r.post("/dashboard/guard/limits", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    await saveGuardSettings(m.id, { auto_discount_max_pct: Number(req.body.pct), auto_pause_max_cycles: Number(req.body.cycles), approve_capture_above_cents: req.body.capture_cents !== undefined ? Number(req.body.capture_cents) : undefined }, "owner");
    back(res, "/dashboard/guard", "Autonomy limits saved.");
  }));
  r.post("/dashboard/guard/suggestions", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const fields = ([] as string[]).concat(req.body.field ?? []) as any[];
    const s = await adoptSuggestions(m.id, fields, "owner");
    back(res, "/dashboard/guard", `Autonomy now ${s.auto_discount_max_pct}% / ${s.auto_pause_max_cycles} cycles / ${(s.approve_capture_above_cents / 100).toFixed(2)}.`);
  }));
  r.post("/dashboard/guard/approvals/:id/:choice(approve|decline)", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const out = await decideApproval(req.params.id, m.id, req.params.choice === "approve", "click", "owner");
      back(res, nextOf(req.body?.next, "/dashboard/guard"), out.replayed ? `Already ${out.status}.` : out.status === "approved" ? "Approved. Kept will go ahead." : out.status === "declined" ? "Declined. Nothing moves." : `${out.status}.`);
    } catch (e) {
      back(res, nextOf(req.body?.next, "/dashboard/guard"), errMsg(e), true);
    }
  }));
  r.post("/dashboard/guard/kill", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const scope = String(req.body.scope ?? "").trim().slice(0, 120);
    if (!scope) return back(res, "/dashboard/guard", "Say which scope.", true);
    if (scope.startsWith("merchant:") && scope !== `merchant:${m.id}`) return back(res, "/dashboard/guard", "You can only stop your own shop.", true);
    await setKill(scope, String(req.body.engaged) === "true", String(req.body.reason ?? "").slice(0, 200) || null, `owner ${m.slug}`);
    back(res, "/dashboard/guard", String(req.body.engaged) === "true" ? `Kill switch engaged on ${scope}.` : `Released ${scope}.`);
  }));
  r.get("/dashboard/guard/audit.json", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner required", "unauthorized", 401);
    return { ...(await verifyChain()), recent: await recentAudit(50) };
  }));
  r.get("/dashboard/guard/kills.json", json(async () => ({ kills: await listKills(), global: await isKilled("global") })));

  // Passkeys: registration and countersign over the approval's payload hash.
  r.post("/dashboard/guard/passkey/register/start", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner required", "unauthorized", 401);
    const c = newChallenge(m.id, null);
    return { id: c.id, challenge: c.challenge, rpName: "Kept", userId: Buffer.from(m.id).toString("base64url"), userName: m.owner_email ?? m.slug };
  }));
  r.post("/dashboard/guard/passkey/register/finish", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner required", "unauthorized", 401);
    return finishRegistration(m.id, String(req.body.chalId), req.body);
  }));
  r.post("/dashboard/guard/passkey/sign/start", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner required", "unauthorized", 401);
    const a = (await getDb()).query<any>("SELECT payload_hash FROM approvals WHERE id = $1 AND merchant_id = $2", [String(req.body.approvalId), m.id]).then((r) => r.rows[0]);
    const row = await a;
    if (!row) throw new KeptError("No such approval", "not_found", 404);
    const c = newChallenge(m.id, row.payload_hash);
    return { id: c.id, challenge: c.challenge, payload_hash: row.payload_hash };
  }));
  r.post("/dashboard/guard/passkey/sign/finish", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner required", "unauthorized", 401);
    const row = (await (await getDb()).query<any>("SELECT payload_hash FROM approvals WHERE id = $1 AND merchant_id = $2", [String(req.body.approvalId), m.id])).rows[0];
    if (!row) throw new KeptError("No such approval", "not_found", 404);
    const ok = await verifyAssertion(m.id, String(req.body.chalId), row.payload_hash, req.body);
    if (!ok) throw new KeptError("Passkey assertion failed", "passkey_failed", 400);
    const out = await decideApproval(String(req.body.approvalId), m.id, true, "passkey", "owner passkey");
    return { ...out, payload_hash: row.payload_hash };
  }));

  /* ---------------- compliance scorecard (K2) ---------------- */
  r.get("/dashboard/compliance", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const db = await getDb();
    const policy = await currentPolicy(db, m.id);
    const plans = await plansFor(db, m.id, true);
    const ctx = { disclosure: { price: true, interval: true, cancelTerms: true }, hasAnnualPlans: plans.some((p) => p.interval_unit === "YEAR" || (p.interval_unit === "MONTH" && p.interval_count >= 12)) };
    const rules = policy?.rules ?? null;
    const cards = rules ? scoreAll(rules, ctx) : [];
    const sel = (typeof req.query.j === "string" ? req.query.j : rules?.jurisdiction ?? "US_FEDERAL") as Jurisdiction;
    const focus = rules ? scoreCompliance(rules, sel, ctx) : null;
    res.send(layout({ title: `${m.name} · Compliance`, nav: "dashboard", owner: nav(m) }, html`
      <h1>Compliance scorecard</h1><p class="muted">Your approved rules (v${policy?.version ?? 0}) scored against each jurisdiction's negative-option rules. A failing rule for the buyer's jurisdiction blocks the offer step in code; the cancel always goes through. Paraphrased for a product scorecard, not legal advice; sources and [verify] marks in <code>docs/compliance.md</code>.</p>
      ${flash(req)}
      ${!rules ? html`<div class="banner info">No rules approved yet. The scorecard scores an approved policy.</div>` : ""}
      <div class="score">${cards.map((c) => html`<a class="tile" href="/dashboard/compliance?j=${c.jurisdiction}" style="text-decoration:none;color:inherit"><div class="label">${JURISDICTIONS.find((j) => j.id === c.jurisdiction)?.name}</div><div class="big">${c.total ? `${c.passed}/${c.total}` : "info"}</div><div class="hint">${c.failed ? html`<span class="pill fail">${c.failed} failing</span>` : c.total ? html`<span class="pill pass">all pass</span>` : html`<span class="pill info">informational</span>`}</div></a>`)}</div>
      ${focus ? html`<div class="card"><h2>${JURISDICTIONS.find((j) => j.id === sel)?.name}</h2><p class="sub">${JURISDICTIONS.find((j) => j.id === sel)?.note}</p>
        ${focus.rules.map((x) => html`<div class="rule-row"><span class="pill ${x.status}">${x.status}</span><div><b>${x.id} · ${x.title}</b><div class="small">${x.requirement}</div><div class="small muted">Kept: ${x.evidence}</div></div><small class="muted">${x.source}</small></div>`)}
      </div>` : ""}
      <div class="card"><h2>What this blocks</h2><ul class="small"><li>Rules that ask for more than one offer, a phone call to cancel, a blocked cancel, or hidden terms are refused at drafting time with the rule cited (try it on the <a href="/onboard/rules">rules page</a>).</li><li>If an approved policy fails a rule for the subscriber's jurisdiction (for example no renewal reminder on an annual plan in New York), the offer step is skipped and the cancel is honoured; the event log says which rule.</li><li>Annual plans: reminders are checked against each state's window; monthly plans pass the reminder rules automatically.</li></ul></div>
    `));
  }));
  r.get("/dashboard/compliance.json", json(async (req) => {
    const m = await ownerOf(req);
    if (!m) throw new KeptError("Owner required", "unauthorized", 401);
    const policy = await currentPolicy(await getDb(), m.id);
    return { version: policy?.version ?? 0, scorecards: policy ? scoreAll(policy.rules) : [] };
  }));

  return r;
}

export const guardDeps = { esc };
