/** The public front door: what Kept does for a subscription shop and its members, why it's fair, and a persona picker. */
import type { Request, Response } from "express";
import { config } from "../config.js";
import { getDb } from "../db.js";
import { listPublicMerchants } from "../store.js";
import { html, layout, raw } from "./html.js";
import { icon } from "./icons.js";

const ic = (n: string) => raw(icon(n));

export async function landing(req: Request, res: Response) {
  const db = await getDb();
  const shops = await listPublicMerchants(db);
  const slug = process.env.KEPT_DEMO_SHOP || "ember-oak-coffee-club";
  const shop = shops.find((s) => s.slug === slug) ?? shops[0];
  // A live sandbox subscription (not a labelled sample row) that a visitor can skip, pause or cancel for real.
  const live = shop ? (await db.query<any>("SELECT ref, subscriber_name, status FROM subscribers WHERE merchant_id = $1 AND NOT is_sample AND paypal_subscription_id IS NOT NULL AND status IN ('ACTIVE','SUSPENDED') ORDER BY created_at DESC LIMIT 1", [shop.id])).rows[0] : undefined;
  const msg = typeof req.query.err === "string" ? req.query.err : "";
  const ownerBtn = (label: string, cls = "primary lg") => (config.demoMode ? html`<form method="post" action="/login/demo" class="inline"><button class="btn ${cls}" type="submit">${label} ${ic("arrowRight")}</button></form>` : html`<a class="btn ${cls}" href="/login">${label} ${ic("arrowRight")}</a>`);
  res.send(layout({ title: "subscriptions people can leave, and want to keep", nav: "home" }, html`
${msg ? html`<div class="wrap flash-wrap"><div class="banner bad" role="alert">${msg}</div></div>` : ""}
<section class="lp-hero"><div class="wrap lp-split">
  <div>
    <span class="lp-eyebrow"><b>For subscription shops</b> Coffee clubs, boxes, memberships</span>
    <h1 class="lp-title">Easy to leave. <em>Worth keeping.</em></h1>
    <p class="lp-lead">Kept runs your PayPal subscriptions so members, and the AI assistants that act for them, can skip, pause, switch or cancel in one step. Before a cancel, it can make one fair offer within rules you write. Saying no cancels straight away.</p>
    <div class="lp-cta">${ownerBtn("Try it as the shop")}<a class="btn lg" href="#how">How it works</a></div>
    <div class="lp-trust" style="margin-top:1.5rem"><span>${ic("checkCircle")}PayPal sandbox, no real money</span><span>${ic("checkCircle")}Cancel always works in one step</span><span>${ic("checkCircle")}At most one offer, never a maze</span></div>
  </div>
  <p class="small muted" style="margin:0 0 4px">Illustration of a member page</p><div class="mock" aria-hidden="true"><div class="mock-bar"><i></i><i></i><i></i><span>${shop?.name ?? "Ember & Oak Coffee Club"} · member page</span></div><div class="mock-body">
    <div class="mock-row"><span><b>Signature bag</b> · $24 monthly</span><span class="pill good">active</span></div>
    <div class="mock-row"><span>Away for a month? <b>Skip next delivery</b></span><span class="pill">one tap</span></div>
    <div class="offer-card card" style="margin:0;padding:0.9rem 1rem"><b style="font-family:var(--font-display);font-style:italic;font-size:1.15rem">One offer before you go</b><p class="small muted" style="margin:0.3rem 0 0.6rem">Half bag at $12 for three months, then back to normal. Or cancel now, no questions.</p><div class="row"><span class="btn small primary">Take the offer</span><span class="btn small">No thanks, cancel</span></div></div>
    <div class="mock-row"><span>Asked by <b>Claude</b> for Sam · cancel</span><span class="pill good">done in 1 call</span></div>
  </div></div>
</div></section>

<section class="lp-section alt" id="how"><div class="wrap">
  <p class="lp-kicker">How it works</p><h2 class="lp-h2">From first bag to fair goodbye, every step lands in PayPal.</h2>
  <p class="lp-sub">Kept reads each change back from PayPal before it tells anyone it's done.</p>
  <ol class="lp-steps">
    <li><h3>Write your plans and rules</h3><p>“Signature bag $24 monthly. One skip a quarter, pause up to two months, at most 15% off for three months.” Kept creates the PayPal plans.</p></li>
    <li><h3>Members subscribe</h3><p>On your shop page, or through their AI assistant. They approve on PayPal's own page; Kept never sees card details.</p></li>
    <li><h3>Changes take one step</h3><p>Skip, pause, resume or switch plan from the member page, a text reply, or an assistant's single call.</p></li>
    <li><h3>Cancel fairly, recover politely</h3><p>One optional offer, then the cancel goes through. Failed renewals are chased gently and collected once fixed.</p></li>
  </ol>
</div></section>

<section class="lp-section"><div class="wrap">
  <p class="lp-kicker">What's inside</p><h2 class="lp-h2">The retention desk a small shop never had.</h2>
  <div class="lp-features" style="margin-top:1.5rem">
    <div class="lp-feature"><span class="ic">${ic("bot")}</span><h3>Ready for AI assistants</h3><p>An agent endpoint (MCP and REST) lets a member's assistant subscribe, skip or cancel in one call.</p></div>
    <div class="lp-feature"><span class="ic">${ic("calendar")}</span><h3>Renewal calendar</h3><p>Renewals, pauses, resume dates, discount end dates and payment follow-ups in one view.</p></div>
    <div class="lp-feature"><span class="ic">${ic("chart")}</span><h3>Why people leave</h3><p>Cancel reasons grouped in plain words, with what each offer actually kept.</p></div>
    <div class="lp-feature"><span class="ic">${ic("shieldCheck")}</span><h3>You stay in charge</h3><p>Offers bigger than your limits, and large collections, wait for your approval on screen or on your phone.</p></div>
    <div class="lp-feature"><span class="ic">${ic("receipt")}</span><h3>Law-aware rules</h3><p>Rules that cancellation laws forbid, like “call us to cancel”, are refused with the citation.</p></div>
    <div class="lp-feature"><span class="ic">${ic("repeat")}</span><h3>Reconciled with PayPal</h3><p>Verified webhooks plus a read-back after every change, so the dashboard matches what PayPal holds.</p></div>
  </div>
</div></section>

<section class="lp-section alt" id="fair"><div class="wrap lp-split">
  <div><p class="lp-kicker">Fair by design</p><h2 class="lp-h2">No dark patterns. No fake “payment failed” texts.</h2>
  <p class="lp-sub">Subscription businesses are a favourite disguise for scammers: “your payment failed, update your card here”. Kept is built so members can tell the difference.</p>
  <ul class="stack" style="padding-left:1.1rem;color:var(--ui-muted-fg)"><li>A failed payment is only ever shown on the member's own page, never sent as a “pay here” link.</li><li>Members can paste any message on their page to check it for scam tactics.</li><li>A refund to an account other than the one that paid is held for the owner.</li><li>Cancelling is never blocked: not by an offer, a kill switch or a slow PayPal call.</li></ul></div>
  <div class="stack"><div class="guard-card hold"><div class="gc-head">${ic("shieldAlert")}Possible scam: fake failed payment</div><ul><li>Says your payment failed and asks you to pay through a link.</li><li>Asks for your card number by message.</li></ul><p class="gc-do">Ember &amp; Oak only shows payment problems on your member page. Don't use the link.</p></div>
  <div class="guard-card clear"><div class="gc-head">${ic("shieldCheck")}Cancelled in one step</div><p class="gc-do">Sam's assistant asked to cancel, heard one offer, said no. PayPal confirmed: CANCELLED.</p></div></div>
</div></section>

<section class="lp-section" id="access"><div class="wrap">
  <p class="lp-kicker">For everyone</p><h2 class="lp-h2">Make it comfortable before you start.</h2>
  <p class="lp-sub">These choices stay on this device and apply to every page, including member pages. Change them any time from <b>Display</b> at the top.</p>
  <div class="a11y-quick"><button class="btn" type="button" data-q="textScale:1.5">${ic("type")}Bigger text</button><button class="btn" type="button" data-q="contrast:high">${ic("eye")}High contrast</button><button class="btn" type="button" data-q="font:hyperlegible">Easier-to-read font</button><button class="btn" type="button" data-q="readAloud:true">${ic("volume")}Read pages aloud</button><button class="btn" type="button" data-q="simpleWords:true">Plain words</button><button class="btn" type="button" data-q="bigTargets:true">Bigger buttons</button><button class="btn" type="button" data-q="extraTime:true">${ic("clock")}More time</button></div>
</div></section>

<section class="lp-section alt" id="try"><div class="wrap">
  <p class="lp-kicker">Try it</p><h2 class="lp-h2">Pick who you want to be.</h2>
  <p class="lp-sub">${shop?.name ?? "A demo coffee club"}, a demo shop with real PayPal sandbox plans. When a PayPal page opens, sign in with the sandbox buyer account.</p>
  <div class="lp-personas">
    <div class="persona-card"><div class="who"><span class="avatar">${ic("coffee")}</span><span><b>The shop owner</b><span>${shop?.name ?? "Ember & Oak Coffee Club"}</span></span></div><p>See who renews this week, why people cancel, what offers kept, and approve anything waiting for you.</p>${ownerBtn("Continue as the owner", "primary")}</div>
    ${live ? html`<div class="persona-card"><div class="who"><span class="avatar">${(live.subscriber_name ?? "M")[0]}</span><span><b>${live.subscriber_name ?? "A member"}</b><span>Member · live sandbox subscription</span></span></div><p>Skip a delivery, pause, switch plan or cancel. Each change is made in PayPal and read back.</p><a class="btn" href="/manage/${live.ref}">Open the member page ${ic("arrowRight")}</a></div>` : ""}
    <div class="persona-card"><div class="who"><span class="avatar">N</span><span><b>A new member</b><span>Subscribing for the first time</span></span></div><p>Choose a plan on the shop page and approve it on PayPal. You land on your own member page.</p>${shop ? html`<a class="btn" href="/s/${shop.slug}">Open the shop page ${ic("arrowRight")}</a>` : html`<a class="btn" href="/onboard">Set up a shop first ${ic("arrowRight")}</a>`}</div>
    <div class="persona-card"><div class="who"><span class="avatar">${ic("bot")}</span><span><b>A member's AI assistant</b><span>Claude, or any MCP client</span></span></div><p>Connect to the agent endpoint and ask it to pause or cancel. One call, one optional offer.</p><a class="btn" href="/agents">Connect an assistant ${ic("arrowRight")}</a></div>
  </div>
</div></section>`));
}
