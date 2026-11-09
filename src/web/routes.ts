import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killBanner } from "./guard.js";
import { Router, Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { sign, unsign } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { describeRules } from "../policy/rules.js";
import { money } from "../policy/eligibility.js";
import { paypalFor } from "../paypal/index.js";
import { armedFaults, armFault, FAULTABLE } from "../paypal/faults.js";
import { WEBHOOK_EVENTS } from "../paypal/client.js";
import * as svc from "../service.js";
import { currentPolicy, intervalWords, KeptError, listMerchants, Merchant, merchantById, merchantBySlug, merchantByToken, openOfferFor, plansFor, subscriberByRef, subscribersFor, toOffer } from "../store.js";
import { esc, fmtDate, fmtMoney, html, layout, raw, Raw } from "./html.js";
import type { DraftPlan } from "../brain/types.js";

const COOKIE = "kept_owner";

type Page = (req: Request, res: Response) => Promise<unknown>;
const page = (fn: Page) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

async function ownerOf(req: Request): Promise<Merchant | null> {
  const id = unsign(req.cookies?.[COOKIE]);
  return id ? merchantById(await getDb(), id) : null;
}

function setOwner(res: Response, m: Merchant) {
  res.cookie(COOKIE, sign(m.id), { httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https"), maxAge: 30 * 864e5 });
}

async function requireOwner(req: Request, res: Response): Promise<Merchant | null> {
  const m = await ownerOf(req);
  if (!m) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    return null;
  }
  return m;
}

const ownerNav = (m: Merchant | null) => (m ? { name: m.name, slug: m.slug } : null);

function flash(req: Request): Raw {
  const msg = typeof req.query.ok === "string" ? req.query.ok : typeof req.query.err === "string" ? req.query.err : "";
  if (!msg) return raw("");
  return html`<div class="banner ${req.query.err ? "bad" : "good"}">${msg}</div>`;
}

const back = (res: Response, url: string, msg: string, isErr = false) => res.redirect(`${url}${url.includes("?") ? "&" : "?"}${isErr ? "err" : "ok"}=${encodeURIComponent(msg)}`);

function errMsg(e: unknown) {
  return e instanceof KeptError ? e.message : `Something went wrong: ${(e as Error).message}`;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function webRouter(): Router {
  const r = Router();

  /* ------------------------------------------------------------------ landing */
  r.get("/", page(async (req, res) => {
    const m = await ownerOf(req);
    const shops = await listMerchants(await getDb());
    res.send(layout({ title: "Kept: subscriptions for the agent era", nav: "home", owner: ownerNav(m) }, html`
      <section class="hero">
        <p class="pill agent">PayPal Subscriptions + AI agents</p>
        <h1>Let your customers' AI agents manage their subscriptions, and keep them fairly.</h1>
        <p class="lead">Kept gives a small subscription business an agent endpoint for its PayPal subscriptions. Agents can subscribe, skip, pause, switch or cancel in one call. Before a cancel, your own agent can make one fair offer within rules you write. Cancelling is never blocked.</p>
        <div class="row" style="margin-top:18px">
          ${config.demoMode ? html`<form method="post" action="/login/demo" class="inline"><button class="btn primary" type="submit">Open the demo shop dashboard</button></form>` : ""}
          <a class="btn" href="/onboard">Set up your shop</a>
          <a class="btn" href="/agents">Connect an AI agent</a>
        </div>
      </section>
      <section class="card" style="margin-top:24px">
        <h2>The whole subscription life, end to end</h2>
        <p class="sub">Every step ends in a real PayPal state change that Kept reads back before it tells anyone.</p>
        <div class="flow">
          <div><b>1. Set up</b>Describe plans and retention rules in plain words. Kept creates the PayPal plans.</div>
          <div><b>2. Subscribe</b>A buyer's agent finds the shop over MCP. The human approves on PayPal's own page.</div>
          <div><b>3. Change</b>Skip, pause, resume or switch plan in one call, within your rules.</div>
          <div><b>4. Cancel fairly</b>One call cancels. Optionally one offer first; declining cancels at once.</div>
          <div><b>5. Recover &amp; reconcile</b>Failed renewals are chased and collected. Webhooks are verified and every change is reconciled with PayPal.</div>
        </div>
      </section>
      <section class="grid g2" style="margin-top:16px">
        <div class="card"><h2>For shop owners</h2><ul class="steps">
          <li>Connect your PayPal app (sandbox works out of the box).</li>
          <li>Type your plans: "Signature bag $24 monthly; Half bag $12 monthly".</li>
          <li>Type your rules: "one skip per quarter; pause up to 2 months; at most 15% off for 3 months".</li>
          <li>Share your shop page and agent endpoint.</li></ul></div>
        <div class="card"><h2>For AI agents</h2><p>One MCP endpoint lists every shop: <code>${config.appUrl}/mcp</code>. Each shop also has its own endpoint. Tools: <code>find_shops</code>, <code>list_plans</code>, <code>start_subscription</code>, <code>get_subscription</code>, <code>skip_next</code>, <code>pause</code>, <code>resume</code>, <code>switch_plan</code>, <code>cancel_subscription</code>, <code>respond_to_offer</code>, <code>payment_fixed</code>.</p><a href="/agents">Agent setup guide →</a></div>
      </section>
      ${shops.length ? html`<section class="card" style="margin-top:16px"><h2>Shops on this Kept</h2><div class="table-wrap"><table><tr><th>Shop</th><th>Page</th><th>Agent endpoint</th></tr>${shops.map((s) => html`<tr><td>${s.name}<br><small>${s.tagline}</small></td><td><a href="/s/${s.slug}">/s/${s.slug}</a></td><td><code>/s/${s.slug}/mcp</code></td></tr>`)}</table></div></section>` : ""}
    `));
  }));

  /* ------------------------------------------------------------------ auth */
  r.get("/login", page(async (req, res) => {
    const lipp = config.paypal.clientId && process.env.KEPT_LIPP_ENABLED === "true";
    res.send(layout({ title: "Owner sign-in · Kept", nav: "login" }, html`
      <div class="grid g2">
        <div class="card"><h2>Sign in</h2><p class="sub">Shop owners sign in to see their dashboard.</p>
          ${lipp ? html`<p><a class="btn primary" href="/auth/paypal">Log in with PayPal</a></p>` : ""}
          <form method="post" action="/login/token"><input type="hidden" name="next" value="${String(req.query.next ?? "/dashboard")}"><div class="field"><label for="token">Owner key</label><input id="token" name="token" type="password" autocomplete="off" placeholder="own_..."><div class="help">Shown once when you created your shop, and in your dashboard settings.</div></div><button class="btn" type="submit">Sign in with owner key</button></form>
        </div>
        ${config.demoMode ? html`<div class="card"><h2>Demo shop</h2><p class="sub">Open the demo coffee club's dashboard. Its PayPal plans are real sandbox plans; sample subscribers are labelled.</p><form method="post" action="/login/demo"><button class="btn primary" type="submit">Open demo dashboard</button></form></div>` : ""}
      </div>${flash(req)}`));
  }));

  r.post("/login/token", page(async (req, res) => {
    const m = await merchantByToken(await getDb(), String(req.body.token ?? "").trim());
    if (!m) return back(res, "/login", "That owner key didn't match a shop.", true);
    setOwner(res, m);
    const next = String(req.body.next ?? "/dashboard");
    res.redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
  }));

  r.post("/login/demo", page(async (_req, res) => {
    if (!config.demoMode) return res.status(403).send("Demo mode is off.");
    const db = await getDb();
    const slug = process.env.KEPT_DEMO_SHOP || "ember-oak-coffee-club";
    const m = (await merchantBySlug(db, slug)) ?? (await listMerchants(db))[0];
    if (!m) return back(res, "/onboard", "No demo shop yet. Run npm run seed, or set up a shop.", true);
    setOwner(res, m);
    res.redirect("/dashboard");
  }));

  r.post("/logout", (_req, res) => {
    res.clearCookie(COOKIE);
    res.redirect("/");
  });

  // Log in with PayPal (OpenID Connect). Needs "Log in with PayPal" enabled on the PayPal app with this return URL.
  r.get("/auth/paypal", (_req, res) => {
    const base = config.paypal.env === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
    const q = new URLSearchParams({ flowEntry: "static", client_id: config.paypal.clientId, scope: "openid email profile", redirect_uri: `${config.appUrl}/auth/paypal/callback`, response_type: "code" });
    res.redirect(`${base}/connect?${q}`);
  });

  r.get("/auth/paypal/callback", page(async (req, res) => {
    const code = String(req.query.code ?? "");
    if (!code) return back(res, "/login", "PayPal sign-in was cancelled.", true);
    const pp = paypalFor(null);
    const tok = await pp.exchangeAuthCode(code);
    const info = await pp.getUserInfo(tok.access_token);
    const db = await getDb();
    const m = (await db.query<Merchant>("SELECT * FROM merchants WHERE paypal_payer_id = $1 OR (owner_email IS NOT NULL AND owner_email = $2) ORDER BY created_at LIMIT 1", [info.payer_id ?? "", info.email ?? ""])).rows[0];
    if (!m) return back(res, "/onboard", "You signed in with PayPal, but no Kept shop belongs to that account yet. Set one up.", true);
    setOwner(res, m);
    res.redirect("/dashboard");
  }));

  /* ------------------------------------------------------------------ onboarding */
  r.get("/onboard", page(async (req, res) => {
    const m = await ownerOf(req);
    const envReady = Boolean(config.paypal.clientId && config.paypal.clientSecret);
    res.send(layout({ title: "Set up your shop · Kept", nav: "onboard", owner: ownerNav(m) }, html`
      <h1>Set up your shop</h1><p class="muted">Step 1 of 3: your shop and your PayPal app.</p>${flash(req)}
      <form method="post" action="/onboard/shop" class="card">
        <div class="grid g2">
          <div class="field"><label for="name">Shop name</label><input id="name" name="name" type="text" required maxlength="80" placeholder="Ember &amp; Oak Coffee Club"></div>
          <div class="field"><label for="currency">Currency</label><select id="currency" name="currency"><option>USD</option><option>SGD</option><option>AUD</option><option>EUR</option><option>GBP</option></select><div class="help">Plans bill in this currency.</div></div>
        </div>
        <div class="field"><label for="tagline">One line about what you sell</label><input id="tagline" name="tagline" type="text" maxlength="140" placeholder="Fresh-roasted beans delivered every month"></div>
        <div class="field"><label for="email">Your email (optional)</label><input id="email" name="email" type="email" placeholder="you@example.com"><div class="help">Used to match your PayPal sign-in later.</div></div>
        <h3 style="margin-top:8px">PayPal</h3>
        ${envReady ? html`<label class="check"><input type="radio" name="pp" value="env" checked> Use this Kept server's PayPal sandbox app</label>` : ""}
        <label class="check"><input type="radio" name="pp" value="own" ${envReady ? "" : "checked"}> Connect my own PayPal REST app</label>
        <div class="grid g3" style="margin-top:8px">
          <div class="field"><label for="cid">Client ID</label><input id="cid" name="client_id" type="text" autocomplete="off"></div>
          <div class="field"><label for="sec">Secret</label><input id="sec" name="client_secret" type="password" autocomplete="off"></div>
          <div class="field"><label for="env">Environment</label><select id="env" name="env"><option value="sandbox">Sandbox</option><option value="live">Live</option></select></div>
        </div>
        <p class="muted" style="font-size:.86rem">Your secret is encrypted at rest and only the executor uses it. Your PayPal app needs Subscriptions enabled.</p>
        <button class="btn primary" type="submit">Create shop</button>
      </form>`));
  }));

  r.post("/onboard/shop", page(async (req, res) => {
    try {
      const own = req.body.pp === "own";
      const m = await svc.createMerchant({
        name: String(req.body.name ?? ""),
        tagline: String(req.body.tagline ?? ""),
        currency: String(req.body.currency ?? "USD"),
        ownerEmail: req.body.email ? String(req.body.email) : null,
        credentials: own ? { clientId: String(req.body.client_id ?? "").trim(), clientSecret: String(req.body.client_secret ?? "").trim(), env: req.body.env === "live" ? "live" : "sandbox" } : null,
      });
      setOwner(res, m);
      // The owner key is shown once on the next page via a short-lived signed cookie, never in a URL.
      res.cookie("kept_newkey", sign(m.owner_token), { httpOnly: true, sameSite: "lax", secure: config.appUrl.startsWith("https"), maxAge: 10 * 60_000 });
      res.redirect(`/onboard/plans?ok=${encodeURIComponent("Shop created.")}`);
    } catch (e) {
      back(res, "/onboard", errMsg(e), true);
    }
  }));

  r.get("/onboard/plans", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const existing = await plansFor(await getDb(), m.id);
    const newKey = unsign(req.cookies?.kept_newkey);
    if (newKey) res.clearCookie("kept_newkey");
    res.send(layout({ title: "Plans · Kept", nav: "onboard", owner: ownerNav(m) }, html`
      <h1>Your plans</h1><p class="muted">Step 2 of 3: describe your plans in plain words, one per line.</p>${flash(req)}
      ${newKey === m.owner_token ? html`<div class="banner warn"><b>Save your owner key now.</b> It signs you in and lets your own agent read your shop. It's also under Connections on your dashboard.<div class="codebox" style="margin-top:8px">${newKey}</div></div>` : ""}
      ${existing.length ? html`<div class="card"><h2>Current plans</h2><table><tr><th>Plan</th><th>Price</th><th>Kind</th><th>PayPal plan</th></tr>${existing.map((p) => html`<tr><td>${p.name}</td><td>${fmtMoney(p.price, m.currency)} ${intervalWords(p)}</td><td>${p.kind}</td><td><code>${p.paypal_plan_id}</code></td></tr>`)}</table><p style="margin-top:12px"><a class="btn" href="/onboard/rules">Continue to rules →</a></p></div>` : ""}
      <form method="post" action="/onboard/plans/preview" class="card">
        <div class="field"><label for="plans">Plans</label><textarea id="plans" name="text" required placeholder="Signature bag, 340g, $24 monthly&#10;Half bag (Lite) $12 monthly">${existing.length ? "" : "Signature bag, 340g fresh roast, $24 monthly\nHalf bag (Lite) $12 monthly"}</textarea><div class="help">Write a name, a price and how often it bills. Kept reads it and shows you exactly what it will create before anything goes to PayPal.</div></div>
        <button class="btn primary" type="submit">Preview plans</button>
      </form>`));
  }));

  r.post("/onboard/plans/preview", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const draft = await svc.previewPlans(String(req.body.text ?? ""), m.currency);
    res.send(layout({ title: "Check plans · Kept", nav: "onboard", owner: ownerNav(m) }, html`
      <h1>Check your plans</h1><p class="muted">Edit anything below, then create them on PayPal.</p>
      ${draft.warnings.length ? html`<div class="banner warn">${draft.warnings.map((w) => html`<div>${w}</div>`)}</div>` : ""}
      <div class="card"><h3>What Kept understood</h3><ul>${draft.understood.map((u) => html`<li>${u}</li>`)}</ul></div>
      <form method="post" action="/onboard/plans/create" class="card">
        <table><tr><th>Name</th><th>Price (${m.currency})</th><th>Every</th><th>Unit</th><th>Kind</th></tr>
        ${draft.value.map((p, i) => html`<tr>
          <td><input type="text" name="name_${i}" value="${p.name}" required></td>
          <td><input type="number" name="price_${i}" value="${p.price.toFixed(2)}" step="0.01" min="1" required></td>
          <td><input type="number" name="count_${i}" value="${p.intervalCount}" min="1" max="12"></td>
          <td><select name="unit_${i}">${["DAY", "WEEK", "MONTH", "YEAR"].map((u) => html`<option ${u === p.intervalUnit ? "selected" : ""}>${u}</option>`)}</select></td>
          <td><select name="kind_${i}"><option value="regular" ${p.kind === "regular" ? "selected" : ""}>regular</option><option value="lite" ${p.kind === "lite" ? "selected" : ""}>lighter plan</option></select></td>
          <input type="hidden" name="desc_${i}" value="${p.description}"></tr>`)}
        </table>
        <input type="hidden" name="n" value="${draft.value.length}">
        <p class="muted" style="margin-top:10px">Tip: a DAY plan renews daily in the sandbox, handy for showing a real renewal during a demo.</p>
        <div class="row"><button class="btn primary" type="submit" ${draft.value.length ? "" : "disabled"}>Create ${draft.value.length} plan${draft.value.length === 1 ? "" : "s"} on PayPal</button><a class="btn" href="/onboard/plans">Start over</a></div>
      </form>`));
  }));

  r.post("/onboard/plans/create", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const n = Math.min(6, Number(req.body.n ?? 0));
    const drafts: DraftPlan[] = [];
    for (let i = 0; i < n; i++) {
      drafts.push({
        name: String(req.body[`name_${i}`] ?? "").slice(0, 60),
        description: String(req.body[`desc_${i}`] ?? "").slice(0, 120),
        price: Number(req.body[`price_${i}`]),
        intervalCount: Math.max(1, Math.min(12, Number(req.body[`count_${i}`] ?? 1))),
        intervalUnit: (["DAY", "WEEK", "MONTH", "YEAR"].includes(req.body[`unit_${i}`]) ? req.body[`unit_${i}`] : "MONTH") as any,
        kind: req.body[`kind_${i}`] === "lite" ? "lite" : "regular",
      });
    }
    try {
      const plans = await svc.createPlans(m.id, drafts);
      back(res, "/onboard/rules", `Created ${plans.length} PayPal plan${plans.length === 1 ? "" : "s"}.`);
    } catch (e) {
      back(res, "/onboard/plans", errMsg(e), true);
    }
  }));

  r.get("/onboard/rules", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const policy = await currentPolicy(await getDb(), m.id);
    res.send(layout({ title: "Retention rules · Kept", nav: "onboard", owner: ownerNav(m) }, html`
      <h1>Retention rules</h1><p class="muted">Step 3 of 3: what you're willing to offer someone who wants to leave. Kept's agent can only choose among these, and cancelling always works in one step.</p>${flash(req)}
      ${policy ? html`<div class="card"><h2>Approved rules (v${policy.version})</h2><ul>${describeRules(policy.rules).map((d) => html`<li>${d}</li>`)}</ul><p class="muted">Written as: "${policy.source_text}"</p></div>` : ""}
      <form method="post" action="/onboard/rules/preview" class="card">
        <div class="field"><label for="rules">Your rules, in plain words</label><textarea id="rules" name="text" required>${policy?.source_text || "One skip per quarter. Pause up to 2 months. Let people switch to the Lite plan. At most 15% off for 3 months, only for subscribers of 2 months or more. One offer per year."}</textarea></div>
        <button class="btn primary" type="submit">Preview rules</button>
      </form>`));
  }));

  r.post("/onboard/rules/preview", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const text = String(req.body.text ?? "");
    const p = await svc.previewRules(text);
    const replay = p.valid ? await svc.replayRules(m.id, p.value) : null;
    res.send(layout({ title: "Check rules · Kept", nav: "onboard", owner: ownerNav(m) }, html`
      <h1>Check your rules</h1>
      ${replay && replay.cases ? html`<div class="card"><h3>Replay on your last ${replay.cases} cancellation request${replay.cases === 1 ? "" : "s"}</h3><p>${replay.changed} would get a different offer under these rules. Cancelling stays one step for everyone.</p>${replay.changed ? html`<table><tr><th>Subscriber</th><th>Reason</th><th>Today</th><th>With these rules</th></tr>${replay.rows.filter((r) => r.changed).map((r) => html`<tr><td>${r.name}</td><td>${r.reason}</td><td>${r.before}</td><td><b>${r.after}</b></td></tr>`)}</table>` : ""}<p class="muted small">Uses each request's own date and plan; a new discount plan only exists after approval, so new discounts may show as "no offer" here.</p></div>` : ""}
      ${p.warnings.length ? html`<div class="banner warn">${p.warnings.map((w) => html`<div>${w}</div>`)}</div>` : ""}
      ${p.errors.length ? html`<div class="banner bad">${p.errors.map((w) => html`<div>${w}</div>`)}</div>` : ""}
      <div class="grid g2">
        <div class="card"><h3>What Kept understood</h3><ul>${p.understood.map((u) => html`<li>${u}</li>`)}</ul></div>
        <div class="card"><h3>What subscribers and agents will be told</h3><ul>${p.description.map((u) => html`<li>${u}</li>`)}</ul></div>
      </div>
      <div class="card"><h3>Exact rules to approve</h3><div class="codebox">${JSON.stringify(p.value, null, 2)}</div>
        <form method="post" action="/onboard/rules/approve" style="margin-top:12px">
          <input type="hidden" name="rules" value="${JSON.stringify(p.value)}"><input type="hidden" name="text" value="${text}"><input type="hidden" name="notes" value="${JSON.stringify(p.understood)}">
          <div class="row"><button class="btn primary" type="submit" ${p.valid ? "" : "disabled"}>Approve these rules</button><a class="btn" href="/onboard/rules">Edit</a></div>
          <p class="muted" style="margin-top:8px">If there's a discount, Kept creates the matching discounted PayPal plans when you approve.</p>
        </form></div>`));
  }));

  r.post("/onboard/rules/approve", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const out = await svc.approveRules(m.id, JSON.parse(String(req.body.rules ?? "{}")), String(req.body.text ?? ""), JSON.parse(String(req.body.notes ?? "[]")));
      back(res, "/onboard/done", `Rules v${out.version} approved.`);
    } catch (e) {
      back(res, "/onboard/rules", errMsg(e), true);
    }
  }));

  r.get("/onboard/done", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    res.send(layout({ title: "Ready · Kept", nav: "onboard", owner: ownerNav(m) }, html`
      <h1>${m.name} is ready</h1>${flash(req)}
      <div class="grid g2">
        <div class="card"><h2>Share with people</h2><p>Your shop page: <a href="/s/${m.slug}">${config.appUrl}/s/${m.slug}</a></p></div>
        <div class="card"><h2>Share with AI agents</h2><p>Your agent endpoint (MCP):</p><div class="codebox">${config.appUrl}/s/${m.slug}/mcp</div><p style="margin-top:8px"><a href="/agents">How agents connect →</a></p></div>
      </div>
      <p style="margin-top:16px"><a class="btn primary" href="/dashboard">Go to your dashboard</a></p>`));
  }));

  /* ------------------------------------------------------------------ dashboard */
  r.get("/dashboard", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const db = await getDb();
    const [stats, subs, plans, policy] = await Promise.all([svc.computeStats(m), subscribersFor(db, m.id), plansFor(db, m.id, true), currentPolicy(db, m.id)]);
    const offers = (await db.query("SELECT o.*, s.subscriber_name, s.subscriber_email, s.is_sample FROM offers o JOIN subscribers s ON s.id = o.subscriber_id WHERE o.merchant_id = $1 ORDER BY o.created_at DESC LIMIT 12", [m.id])).rows;
    const events = (await db.query("SELECT * FROM event_log WHERE merchant_id = $1 ORDER BY id DESC LIMIT 40", [m.id])).rows;
    const planName = (id: string | null) => plans.find((p) => p.id === id)?.name ?? "—";
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const answer = q ? await svc.askOwner(m, q) : "";
    const reasonTotal = stats.reasons.reduce((a, r) => a + r.count, 0);
    const label: Record<string, string> = { price: "Cost", too_much: "Too much product", away: "Away / travelling", quality: "Quality", competitor: "Switching elsewhere", no_need: "No longer needed", payment: "Payment problems", other: "Other / none given" };
    const webhookOk = Boolean(m.paypal_webhook_id || (!m.paypal_credentials && config.paypal.webhookId));
    res.send(layout({
      title: `${m.name} · Kept dashboard`, nav: "dashboard", owner: ownerNav(m),
      head: raw(`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@bryntum/calendar-trial@7.3.8/calendar.css"><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@bryntum/calendar-trial@7.3.8/svalbard-light.css" id="bryntum-theme">`),
      scripts: raw(`<script type="module" src="/static/calendar.js"></script>`),
    }, html`
      ${await killBanner(m.id)}<div class="spread"><div><h1>${m.name}</h1><p class="muted">${m.tagline}</p></div>
        <div class="row"><form method="post" action="/dashboard/reconcile" class="inline"><button class="btn" type="submit">Reconcile with PayPal now</button></form><a class="btn" href="/s/${m.slug}">Open shop page</a></div></div>
      ${flash(req)}
      ${stats.sampleRows ? html`<div class="banner info">${stats.sampleRows} subscribers are labelled sample rows so the dashboard isn't empty. Everything else is live on the PayPal sandbox.</div>` : ""}
      <div class="kpis">
        <div class="kpi"><div class="label">Active</div><div class="value">${stats.active}</div><div class="hint">${stats.suspended} paused</div></div>
        <div class="kpi"><div class="label">MRR</div><div class="value">${fmtMoney(stats.mrr, m.currency)}</div><div class="hint">monthly equivalent</div></div>
        <div class="kpi"><div class="label">Revenue kept</div><div class="value">${fmtMoney(stats.revenueKept3, m.currency)}</div><div class="hint">next 3 cycles, from accepted offers</div></div>
        <div class="kpi"><div class="label">Offers accepted</div><div class="value">${stats.offersAccepted}/${stats.offersMade}</div><div class="hint">${stats.offersExpired} expired → cancelled</div></div>
        <div class="kpi"><div class="label">Cancels honoured</div><div class="value">${stats.cancelsHonoured}</div><div class="hint">all in one step</div></div>
        <div class="kpi"><div class="label">From AI agents</div><div class="value">${stats.agentShare}%</div><div class="hint">of subscriber actions</div></div>
        <div class="kpi"><div class="label">Collected, 30 days</div><div class="value">${fmtMoney(stats.collected30, m.currency)}</div><div class="hint">${stats.sampleRows ? "PayPal transactions + sample rows" : "from PayPal transactions"}</div></div>
      </div>

      <div class="card" style="margin-top:16px"><h2>Ask about your shop</h2>
        <form method="get" action="/dashboard" class="row"><input type="text" name="q" value="${q}" placeholder="Why are people cancelling? Who has a failed payment? How much did offers keep?" style="flex:1;min-width:240px"><button class="btn primary" type="submit">Ask</button></form>
        ${answer ? html`<div class="answer">${answer}</div>` : ""}
      </div>

      <div class="card"><div class="spread"><div><h2>Renewal calendar</h2><p class="sub">Renewals, skips and pauses with their resume dates, discount end dates and payment follow-ups.</p></div>
        <div class="legend"><span><i style="background:#2d5a9e"></i>Renewal</span><span><i style="background:#9a5b00"></i>Pause</span><span><i style="background:#23704f"></i>Resume</span><span><i style="background:#7a4fb5"></i>Discount</span><span><i style="background:#a3322a"></i>Payment issue</span></div></div>
        <div id="calendar" data-src="/dashboard/calendar.json"></div>
        <noscript><p class="muted">The calendar needs JavaScript.</p></noscript>
      </div>

      <div class="card"><h2>Subscribers</h2><p class="sub">${subs.length} total. Click a reference to open the subscriber's own manage page.</p>
        <div class="table-wrap"><table><tr><th>Subscriber</th><th>Plan</th><th>Status</th><th>Channel</th><th>Next billing</th><th></th></tr>
        ${subs.slice(0, 60).map((s) => html`<tr>
          <td>${s.subscriber_name ?? s.subscriber_email ?? "—"}<br><small><a href="/manage/${s.ref}">${s.ref.slice(0, 14)}…</a></small> ${s.is_sample ? html`<span class="pill sample">sample</span>` : ""}</td>
          <td>${planName(s.plan_id)}${s.promo_until ? html`<br><small>discount until ${fmtDate(s.promo_until)}</small>` : ""}</td>
          <td><span class="pill ${s.status}">${s.status}</span>${s.kept_state === "payment_failed" ? html` <span class="pill bad">payment failed</span>` : ""}${s.kept_state === "unconfirmed" ? html` <span class="pill warn">re-checking</span>` : ""}${s.resume_at ? html`<br><small>resumes ${fmtDate(s.resume_at, true)}</small>` : ""}</td>
          <td><span class="pill ${s.channel === "agent" ? "agent" : ""}">${s.channel}</span></td>
          <td>${fmtDate(s.next_billing_time)}</td>
          <td class="row">${!s.is_sample && s.paypal_subscription_id ? html`<form method="post" action="/dashboard/sub/${s.ref}/sync" class="inline"><button class="btn small" type="submit">Re-read PayPal</button></form>` : ""}
            ${config.demoMode && s.status === "ACTIVE" && s.kept_state !== "payment_failed" ? html`<form method="post" action="/dashboard/sub/${s.ref}/simulate-failure" class="inline"><button class="btn small" type="submit" title="Demo only: records a failed renewal without touching PayPal">Simulate failed renewal</button></form>` : ""}</td>
        </tr>`)}
        </table></div>${subs.length ? "" : html`<div class="empty">No subscribers yet. Share your shop page or agent endpoint.</div>`}
      </div>

      <div class="grid g2">
        <div class="card"><h2>Why people cancel</h2><p class="sub">${reasonTotal} reasons given.</p>
          ${stats.reasons.length ? [...stats.reasons].sort((a, b) => b.count - a.count).map((r) => html`<div style="margin-bottom:10px"><div class="spread"><span>${label[r.category] ?? r.category}</span><small>${r.count}</small></div><div class="bar"><span style="width:${Math.round((100 * r.count) / Math.max(1, reasonTotal))}%"></span></div>${r.examples[0] ? html`<small>"${r.examples[0]}"</small>` : ""}</div>`) : html`<div class="empty">No reasons recorded yet.</div>`}
        </div>
        <div class="card"><h2>Recent offers</h2>
          ${offers.length ? html`<table><tr><th>Subscriber</th><th>Offer</th><th>Outcome</th></tr>${offers.map((o: any) => { const x = toOffer(o); return html`<tr><td>${o.subscriber_name ?? o.subscriber_email ?? "—"} ${o.is_sample ? html`<span class="pill sample">sample</span>` : ""}</td><td>${x.terms.label}<br><small>reason: ${x.reason_category}</small></td><td><span class="pill ${x.status}">${x.status}</span></td></tr>`; })}</table>` : html`<div class="empty">No offers yet.</div>`}
        </div>
      </div>

      <div class="card"><h2>Activity</h2><p class="sub">Every agent request, offer, PayPal call and webhook, newest first.</p>
        ${events.map((e: any) => html`<div class="event-row"><span class="muted">${fmtDate(e.created_at, true)}</span><span><span class="pill ${e.source === "agent" ? "agent" : e.source === "executor" ? "info" : e.source === "webhook" ? "good" : ""}">${e.source}</span></span><span>${e.summary} ${e.is_sample ? html`<span class="pill sample">sample</span>` : ""}</span></div>`)}
      </div>

      <div class="grid g2">
        <div class="card"><h2>Rules (v${policy?.version ?? 0})</h2>${policy ? html`<ul>${describeRules(policy.rules).map((d) => html`<li>${d}</li>`)}</ul>` : html`<p class="muted">No rules approved yet: cancels go through with no offer.</p>`}<a class="btn" href="/onboard/rules">Edit rules</a></div>
        <div class="card"><h2>Plans</h2><table><tr><th>Plan</th><th>Price</th><th>PayPal</th></tr>${plans.map((p) => html`<tr><td>${p.name} ${p.kind !== "regular" ? html`<span class="pill">${p.kind}</span>` : ""}</td><td>${fmtMoney(p.price, m.currency)} ${intervalWords(p)}</td><td><code>${p.paypal_plan_id}</code></td></tr>`)}</table><p style="margin-top:10px"><a class="btn" href="/onboard/plans">Add plans</a></p></div>
      </div>

      <div class="card"><h2>Connections</h2>
        <div class="grid g2">
          <div><h3>Buyer agents</h3><div class="codebox">${config.appUrl}/s/${m.slug}/mcp</div><h3 style="margin-top:12px">Your own agent (read-only)</h3><div class="codebox">${config.appUrl}/owner/mcp\nAuthorization: Bearer &lt;owner key&gt;</div>
            <details style="margin-top:8px"><summary>Show owner key</summary><div class="codebox">${m.owner_token}</div></details></div>
          <div><h3>PayPal webhooks</h3>${webhookOk ? html`<p><span class="pill good">configured</span> Events are signature-verified with PayPal before Kept acts on them.</p>` : html`<p><span class="pill warn">not registered</span> Kept still reconciles by reading PayPal, but webhooks make changes instant. Webhooks need a public HTTPS URL (for example on Render).</p>`}
            <form method="post" action="/dashboard/webhook" class="inline"><button class="btn" type="submit" ${config.appUrl.startsWith("https://") ? "" : "disabled"}>Register webhook for ${config.appUrl}</button></form>
            ${config.demoMode ? html`<form method="post" action="/dashboard/fault" class="inline" style="margin-left:6px"><input type="hidden" name="method" value="cancelSubscription"><button class="btn" type="submit" title="Demo only: the next PayPal cancel call fails once with a 503">Failure lab: fail the next PayPal cancel</button></form>${armedFaults().length ? html`<span class="muted small"> Armed: ${armedFaults().join(", ")}</span>` : ""}` : ""}
            <p class="muted" style="margin-top:8px">PayPal environment: ${m.paypal_env}. Product: <code>${m.paypal_product_id ?? "not created yet"}</code></p></div>
        </div>
      </div>
    `));
  }));

  r.get("/dashboard/calendar.json", page(async (req, res) => {
    const m = await ownerOf(req);
    if (!m) return res.status(401).json({ error: "unauthorized" });
    res.json({
      resources: [
        { id: "renewal", name: "Renewals", eventColor: "blue" },
        { id: "pause", name: "Paused", eventColor: "orange" },
        { id: "resume", name: "Resumes", eventColor: "green" },
        { id: "discount", name: "Discounts", eventColor: "purple" },
        { id: "failed", name: "Payment issues", eventColor: "red" },
      ],
      events: await svc.calendarEvents(m),
    });
  }));

  r.post("/dashboard/reconcile", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const out = await svc.reconcileMerchant(m.id);
      back(res, "/dashboard", `Reconciled ${out.checked} live subscriptions with PayPal; ${out.changed} changed.`);
    } catch (e) {
      back(res, "/dashboard", errMsg(e), true);
    }
  }));

  r.post("/dashboard/sub/:ref/sync", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s || s.merchant_id !== m.id) return back(res, "/dashboard", "Not your subscriber.", true);
    try {
      const after = await svc.syncSubscription(s.ref, "owner");
      back(res, "/dashboard", `PayPal shows ${after.status}.`);
    } catch (e) {
      back(res, "/dashboard", errMsg(e), true);
    }
  }));

  r.post("/dashboard/fault", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    if (!config.demoMode) return res.status(403).send("Demo mode is off.");
    const method = String(req.body.method ?? "");
    if (!(FAULTABLE as readonly string[]).includes(method)) return back(res, "/dashboard", "Unknown fault.", true);
    armFault(method as (typeof FAULTABLE)[number]);
    back(res, "/dashboard", `Armed: the next PayPal ${method} call fails once with a 503. Kept keeps the request and retries until PayPal confirms.`);
  }));

  r.post("/dashboard/sub/:ref/simulate-failure", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s || s.merchant_id !== m.id) return back(res, "/dashboard", "Not your subscriber.", true);
    try {
      await svc.simulateFailedPayment(s.ref);
      back(res, "/dashboard", "Simulated a failed renewal (no PayPal call). The subscriber's page now shows how to fix it.");
    } catch (e) {
      back(res, "/dashboard", errMsg(e), true);
    }
  }));

  r.post("/dashboard/webhook", page(async (req, res) => {
    const m = await requireOwner(req, res);
    if (!m) return;
    try {
      const pp = paypalFor(m);
      const url = `${config.appUrl}/webhooks/paypal`;
      const existing = (await pp.listWebhooks()).find((w) => w.url === url);
      const id = existing?.id ?? (await pp.createWebhook(url, WEBHOOK_EVENTS)).id;
      await (await getDb()).query("UPDATE merchants SET paypal_webhook_id = $2 WHERE id = $1", [m.id, id]);
      back(res, "/dashboard", `Webhook ${id} registered for ${url}.`);
    } catch (e) {
      back(res, "/dashboard", errMsg(e), true);
    }
  }));

  /* ------------------------------------------------------------------ public shop page */
  r.get("/s/:slug", page(async (req, res) => {
    const db = await getDb();
    const m = await merchantBySlug(db, req.params.slug);
    if (!m) return res.status(404).send(layout({ title: "Not found" }, html`<h1>Shop not found</h1>`));
    const plans = (await plansFor(db, m.id)).filter((p) => p.kind !== "promo");
    const policy = await currentPolicy(db, m.id);
    const clientId = m.paypal_credentials ? null : config.paypal.clientId; // the JS SDK button needs the app's client id
    const ld = {
      "@context": "https://schema.org",
      "@type": "Store",
      name: m.name,
      description: m.tagline,
      url: `${config.appUrl}/s/${m.slug}`,
      makesOffer: plans.map((p) => ({
        "@type": "Offer",
        name: p.name,
        description: p.description,
        priceCurrency: m.currency,
        price: money(p.price),
        priceSpecification: { "@type": "UnitPriceSpecification", price: money(p.price), priceCurrency: m.currency, billingDuration: p.interval_count, unitCode: { DAY: "DAY", WEEK: "WEE", MONTH: "MON", YEAR: "ANN" }[p.interval_unit] },
      })),
      potentialAction: { "@type": "Action", name: "Subscribe via MCP", target: `${config.appUrl}/s/${m.slug}/mcp` },
    };
    res.send(layout({
      title: `${m.name} · subscribe`, nav: "shop", owner: ownerNav(await ownerOf(req)), description: m.tagline,
      head: raw(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script><link rel="alternate" type="text/plain" href="/s/${esc(m.slug)}/llms.txt" title="llms.txt">`),
      scripts: clientId ? raw(`<script src="https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&vault=true&intent=subscription&currency=${encodeURIComponent(m.currency)}" data-sdk-integration-source="button-factory"></script><script src="/static/shop.js"></script>`) : undefined,
    }, html`
      <section class="hero"><h1>${m.name}</h1><p class="lead">${m.tagline}</p></section>
      ${flash(req)}
      <div class="grid ${plans.length >= 3 ? "g3" : "g2"}">
        ${plans.map((p) => html`<div class="card plan"><h2>${p.name}</h2><div class="price">${fmtMoney(p.price, m.currency)} <small class="muted">${intervalWords(p)}</small></div><p class="muted">${p.description}</p>
          <form method="post" action="/s/${m.slug}/subscribe" class="stack subscribe-form" data-plan="${p.id}" data-slug="${m.slug}">
            <input type="hidden" name="plan_id" value="${p.id}">
            <div class="grid g2"><div><label for="n-${p.id}">Name</label><input id="n-${p.id}" name="name" type="text" maxlength="80"></div><div><label for="e-${p.id}">Email</label><input id="e-${p.id}" name="email" type="email"></div></div>
            ${clientId ? html`<div class="pp-button" id="pp-${p.id}"></div><button class="btn" type="submit">Or continue to PayPal</button>` : html`<button class="btn primary" type="submit">Subscribe with PayPal</button>`}
          </form></div>`)}
      </div>
      ${plans.length ? "" : html`<div class="empty">This shop hasn't published plans yet.</div>`}
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><h2>Our promise</h2><ul>${(policy ? describeRules(policy.rules) : ["Cancelling always works in one step."]).map((d) => html`<li>${d}</li>`)}</ul></div>
        <div class="card"><h2>For AI agents</h2><p>Your assistant can subscribe and manage this subscription for you through our agent endpoint (MCP):</p><div class="codebox">${config.appUrl}/s/${m.slug}/mcp</div><p style="margin-top:8px"><a href="/s/${m.slug}/llms.txt">llms.txt</a> · <a href="/agents">setup guide</a></p></div>
      </div>`));
  }));

  r.post("/s/:slug/subscribe", page(async (req, res) => {
    const m = await merchantBySlug(await getDb(), req.params.slug);
    if (!m) return res.status(404).send("Shop not found");
    try {
      const out = await svc.startSubscription(m, String(req.body.plan_id ?? ""), { name: req.body.name || null, email: req.body.email || null }, { kind: "web" }, newId("web"));
      if (req.header("accept")?.includes("application/json")) return res.json({ paypal_subscription_id: out.paypalSubscriptionId, ref: out.ref, approval_url: out.approvalUrl });
      res.redirect(out.approvalUrl ?? `/manage/${out.ref}`);
    } catch (e) {
      if (req.header("accept")?.includes("application/json")) return res.status(e instanceof KeptError ? e.status : 500).json({ error: errMsg(e) });
      back(res, `/s/${m.slug}`, errMsg(e), true);
    }
  }));

  r.get("/s/:slug/llms.txt", page(async (req, res) => {
    const db = await getDb();
    const m = await merchantBySlug(db, req.params.slug);
    if (!m) return res.status(404).type("text/plain").send("Not found");
    const plans = (await plansFor(db, m.id)).filter((p) => p.kind !== "promo");
    const policy = await currentPolicy(db, m.id);
    res.type("text/plain").send(`# ${m.name}\n\n> ${m.tagline}\n\nSubscriptions are billed through PayPal. Agents can subscribe and manage subscriptions for their users.\n\n## Agent endpoint\n\n- MCP (Streamable HTTP): ${config.appUrl}/s/${m.slug}/mcp\n- REST: ${config.appUrl}/api/v1/shops/${m.slug}\n\n## Plans\n\n${plans.map((p) => `- ${p.name} (plan_id ${p.id}): ${money(p.price)} ${m.currency} ${intervalWords(p)}. ${p.description}`).join("\n")}\n\n## Policies\n\n${(policy ? describeRules(policy.rules) : ["Cancelling always works in one step."]).map((d) => `- ${d}`).join("\n")}\n\n## Rules for agents\n\n- Subscribing returns a PayPal approval link; the human approves on PayPal. Agents never handle payment details.\n- cancel_subscription always cancels in one call. hear_offer=true is optional; declining or ignoring the offer cancels.\n`);
  }));

  r.get("/llms.txt", page(async (_req, res) => {
    const shops = await listMerchants(await getDb());
    res.type("text/plain").send(`# Kept\n\n> PayPal subscriptions that AI agents can manage, with fair retention for small shops.\n\n## Directory MCP endpoint\n\n- ${config.appUrl}/mcp (tool find_shops, then the subscription tools)\n\n## Shops\n\n${shops.map((m) => `- [${m.name}](${config.appUrl}/s/${m.slug}/llms.txt): ${m.tagline}`).join("\n")}\n\n## API\n\n- OpenAPI: ${config.appUrl}/openapi.yaml\n- Agent skill: ${config.appUrl}/skill.md\n\n## Guarantees\n\n- cancel_subscription cancels in one call; hear_offer=true returns at most one optional offer.\n- Every write returns run_id; get_trace(subscription_ref, run_id) shows each step and the gate's decision.\n- Moves the owner must approve return error "held" with approvalId; do not retry.\n- Owner read-only MCP at ${config.appUrl}/owner/mcp (Bearer owner key): shop_summary, ask, list_subscribers, recent_events, recent_runs, search_transactions, compliance_scorecard, fairness, pending_approvals.\n`);
  }));
  r.get("/skill.md", (_req, res) => {
    try {
      res.type("text/markdown").send(readFileSync(join(root, "skill", "SKILL.md"), "utf8"));
    } catch {
      res.status(404).send("No skill file.");
    }
  });

  /* ------------------------------------------------------------------ subscriber pages */
  r.get("/r/:ref", page(async (req, res) => {
    const s = await subscriberByRef(await getDb(), req.params.ref);
    if (!s) return res.status(404).send(layout({ title: "Not found" }, html`<h1>Subscription not found</h1>`));
    if (req.query.cancelled) return back(res, `/manage/${s.ref}`, "You didn't approve on PayPal, so nothing was set up or charged.", true);
    try {
      const after = await svc.syncSubscription(s.ref, "web");
      back(res, `/manage/${s.ref}`, after.status === "ACTIVE" ? (req.query.revised ? "Plan change approved on PayPal." : "You're subscribed. Bookmark this page to manage your subscription.") : `PayPal shows ${after.status}. If you just approved, refresh in a few seconds.`);
    } catch (e) {
      back(res, `/manage/${s.ref}`, errMsg(e), true);
    }
  }));

  r.get("/manage/:ref", page(async (req, res) => {
    const db = await getDb();
    const s = await subscriberByRef(db, req.params.ref);
    if (!s) return res.status(404).send(layout({ title: "Not found" }, html`<h1>Subscription not found</h1>`));
    const m = (await merchantById(db, s.merchant_id))!;
    const v = await svc.subscriptionView(s.ref);
    const plans = (await plansFor(db, m.id)).filter((p) => p.kind !== "promo" && p.id !== s.plan_id);
    const policy = await currentPolicy(db, m.id);
    const offer = await openOfferFor(db, s.id);
    const can = (a: string) => v.available_actions.includes(a);
    res.send(layout({ title: `Your ${m.name} subscription`, nav: "manage" }, html`
      <h1>Your ${m.name} subscription</h1>${flash(req)}
      ${s.is_sample ? html`<div class="banner info">This is a labelled sample subscriber for the demo; it has no PayPal subscription behind it.</div>` : ""}
      ${s.kept_state === "cancel_pending" || (s as any).cancel_requested_at ? html`<div class="banner warn" role="status"><b>Cancellation pending.</b> You asked to cancel${(s as any).cancel_requested_at ? ` on ${fmtDate((s as any).cancel_requested_at, true)}` : ""}. PayPal hasn't confirmed it yet; Kept keeps retrying and will tell you when it's done. You won't be charged for a renewal you asked to stop.</div>` : ""}
      ${v.notice ? html`<div class="banner warn">${v.notice}<form method="post" action="/manage/${s.ref}/payment-fixed" style="margin-top:8px"><button class="btn primary" type="submit">I've updated my payment method, retry now</button></form><form method="post" action="/manage/${s.ref}/promise" class="row" style="margin-top:8px"><label for="pd">Can't fix it today? I'll sort it by</label><input id="pd" type="date" name="date" required><button class="btn" type="submit">Pause reminders until then</button></form></div>` : ""}
      <div class="grid g2">
        <div class="card"><div class="spread"><h2>${v.plan?.name ?? "Plan"}</h2><span class="pill ${v.status}">${v.status}</span></div>
          ${v.plan ? html`<p class="price" style="font-size:1.5rem;font-weight:700">${fmtMoney(Number(v.plan.price), m.currency)} <small class="muted">${v.plan.billing}</small></p>` : ""}
          ${v.returns_to_plan ? html`<p>Discount until ${fmtDate(v.discount_until)}, then back to ${v.returns_to_plan}.</p>` : ""}
          <p class="muted">Next billing: ${fmtDate(v.next_billing_time)}${v.resumes_at ? html` · Resumes ${fmtDate(v.resumes_at, true)}` : ""}</p>
          ${v.approval_url ? html`<p><a class="btn primary" href="${v.approval_url}">Approve on PayPal</a></p>` : ""}
          <div class="row" style="margin-top:8px">
            ${can("skip_next") ? html`<form method="post" action="/manage/${s.ref}/skip" class="inline"><button class="btn" type="submit">Skip next renewal</button></form>` : ""}
            ${can("resume") ? html`<form method="post" action="/manage/${s.ref}/resume" class="inline"><button class="btn primary" type="submit">Resume now</button></form>` : ""}
          </div>
          ${can("pause") && policy?.rules.pause.enabled ? html`<form method="post" action="/manage/${s.ref}/pause" class="row" style="margin-top:10px"><select name="cycles" style="width:auto">${Array.from({ length: policy.rules.pause.maxCycles }, (_, i) => html`<option value="${i + 1}">${i + 1} cycle${i ? "s" : ""}</option>`)}</select><button class="btn" type="submit">Pause</button></form>` : ""}
          ${can("switch_plan") && plans.length ? html`<form method="post" action="/manage/${s.ref}/switch" class="row" style="margin-top:10px"><select name="plan_id" style="width:auto">${plans.map((p) => html`<option value="${p.id}">${p.name}: ${fmtMoney(p.price, m.currency)} ${intervalWords(p)}</option>`)}</select><button class="btn" type="submit">Switch plan</button></form>` : ""}
        </div>
        <div class="card">
          ${offer ? html`<div class="card offer"><h2>One offer before you go</h2><p>${offer.message}</p><p class="muted">Expires ${fmtDate(offer.expires_at, true)}. If it expires, your subscription is cancelled as you asked.</p>
              <div class="row"><form method="post" action="/offer/${offer.id}/accept" class="inline"><button class="btn primary" type="submit">Accept</button></form><form method="post" action="/offer/${offer.id}/decline" class="inline"><button class="btn danger" type="submit">No thanks, cancel now</button></form></div></div>`
            : can("cancel_subscription") ? html`<h2>Cancel</h2><p class="muted">Cancelling works in one step. You don't have to give a reason or hear an offer.</p>
              <form method="post" action="/manage/${s.ref}/cancel"><div class="field"><label for="reason">Reason (optional)</label><textarea id="reason" name="reason" style="min-height:70px" placeholder="e.g. too much coffee piling up"></textarea></div>
              <label class="check"><input type="checkbox" name="hear_offer" value="1"> Show me one offer before cancelling (optional)</label>
              <button class="btn danger" type="submit" style="margin-top:10px">Cancel subscription</button></form>`
            : html`<h2>Status</h2><p class="muted">${v.status === "CANCELLED" ? "This subscription is cancelled. You won't be charged again." : "No actions available right now."}</p><a href="/s/${m.slug}">Visit ${m.name}</a>`}
        </div>
      </div>
      <div class="card"><h2>Let your AI agent manage this</h2><p>Give your assistant this reference and the shop's endpoint:</p><div class="codebox">subscription_ref: ${s.ref}\nendpoint: ${config.appUrl}/s/${m.slug}/mcp</div></div>`));
  }));

  const manageAction = (path: string, fn: (ref: string, body: any) => Promise<string>) =>
    r.post(`/manage/:ref/${path}`, page(async (req, res) => {
      try {
        back(res, `/manage/${req.params.ref}`, await fn(req.params.ref, req.body));
      } catch (e) {
        back(res, `/manage/${req.params.ref}`, errMsg(e), true);
      }
    }));
  const web = { kind: "web" as const };
  manageAction("skip", async (ref) => `Next renewal skipped. Resumes ${fmtDate((await svc.skipNext(ref, web)).resumeAt, true)}.`);
  manageAction("pause", async (ref, b) => `Paused. Resumes ${fmtDate((await svc.pause(ref, Number(b.cycles ?? 1), web)).resumeAt, true)}.`);
  manageAction("resume", async (ref) => (await svc.resume(ref, web), "Resumed."));
  manageAction("switch", async (ref, b) => {
    const out = await svc.switchPlan(ref, String(b.plan_id ?? ""), web);
    return out.approvalUrl ? `PayPal needs you to approve the change: ${out.approvalUrl}` : out.confirmed ? `Switched to ${out.plan.name}.` : `Switch to ${out.plan.name} accepted; it applies from your next billing cycle.`;
  });
  manageAction("cancel", async (ref, b) => {
    const out = await svc.requestCancel(ref, { reason: b.reason ? String(b.reason) : undefined, hearOffer: b.hear_offer === "1" }, web);
    return out.status === "offer_open" ? "Here's one offer. Accept it, or decline to cancel straight away." : out.status === "cancel_pending" ? out.note : "Cancelled. You won't be charged again.";
  });
  manageAction("payment-fixed", async (ref) => (await svc.paymentFixed(ref, web)).note);
  manageAction("promise", async (ref, b) => {
    await svc.promisePayment(ref, String(b.date ?? ""), web);
    return `Thanks. No reminders until ${String(b.date)}. A promise doesn't move any money.`;
  });

  r.post("/offer/:id/:choice(accept|decline)", page(async (req, res) => {
    const db = await getDb();
    const o = await db.query<{ subscriber_id: string }>("SELECT subscriber_id FROM offers WHERE id = $1", [req.params.id]);
    const s = o.rows[0] ? (await db.query<{ ref: string }>("SELECT ref FROM subscribers WHERE id = $1", [o.rows[0].subscriber_id])).rows[0] : null;
    if (!s) return res.status(404).send("Offer not found");
    try {
      const out = await svc.respondToOffer(req.params.id, req.params.choice === "accept", web);
      back(res, `/manage/${s.ref}`, out.status === "kept" ? "Done. Thanks for staying." : out.status === "cancel_pending" ? "Cancellation requested. PayPal hasn't confirmed it yet; we keep retrying." : "Cancelled. You won't be charged again.");
    } catch (e) {
      back(res, `/manage/${s.ref}`, errMsg(e), true);
    }
  }));

  /* ------------------------------------------------------------------ agents guide */
  r.get("/agents", page(async (req, res) => {
    const shops = await listMerchants(await getDb());
    const ex = shops[0]?.slug ?? "your-shop";
    res.send(layout({ title: "Connect an AI agent · Kept", nav: "agents", owner: ownerNav(await ownerOf(req)) }, html`
      <h1>Connect an AI agent</h1><p class="lead muted">Kept speaks the Model Context Protocol (Streamable HTTP, stateless). Any MCP client can subscribe and manage subscriptions for its user.</p>
      <div class="grid g2">
        <div class="card"><h2>Endpoints</h2><p>All shops (directory):</p><div class="codebox">${config.appUrl}/mcp</div><p style="margin-top:10px">One shop:</p><div class="codebox">${config.appUrl}/s/${ex}/mcp</div><p style="margin-top:10px">Send an <code>X-Agent-Id</code> header so shops can see which agent acted.</p></div>
        <div class="card"><h2>Claude Code</h2><div class="codebox">claude mcp add --transport http kept ${config.appUrl}/mcp</div><h2 style="margin-top:14px">Claude Desktop</h2><p>Settings → Connectors → Add custom connector, with the URL above. Or in <code>claude_desktop_config.json</code>:</p><div class="codebox">${JSON.stringify({ mcpServers: { kept: { command: "npx", args: ["-y", "mcp-remote", `${config.appUrl}/mcp`] } } }, null, 2)}</div></div>
      </div>
      <div class="card"><h2>Tools</h2><table><tr><th>Tool</th><th>What it does</th></tr>
        ${[
          ["find_shops", "Search shops; returns plans and each shop's MCP URL (directory endpoint only)."],
          ["shop_info / list_plans / quote", "Plans, prices, billing intervals and the shop's policies."],
          ["start_subscription", "Creates the PayPal subscription and returns approval_url for the human."],
          ["get_subscription", "Status, next billing, open offer, payment notice and available actions (re-reads PayPal)."],
          ["skip_next / pause / resume", "Within the shop's rules; resumes automatically."],
          ["switch_plan", "PayPal revise; returns approval_url if PayPal needs consent."],
          ["cancel_subscription", "Cancels in one call. hear_offer=true returns one offer first."],
          ["respond_to_offer", "accept=true applies it; accept=false cancels immediately."],
          ["payment_fixed", "After a failed renewal, Kept collects the outstanding balance."],
        ].map(([t, d]) => html`<tr><td><code>${t}</code></td><td>${d}</td></tr>`)}
      </table><p class="muted" style="margin-top:10px">Every write accepts <code>idempotency_key</code>. Repeating a key returns the first result and never acts twice.</p></div>
      <div class="card"><h2>REST, for non-MCP agents</h2><p>The same operations are under <code>${config.appUrl}/api/v1</code>. OpenAPI: <a href="/openapi.yaml">/openapi.yaml</a>.</p></div>`));
  }));

  return r;
}

