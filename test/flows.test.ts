import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openDb, setDb, Db } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { createApp } from "../src/app.js";
import { tick } from "../src/worker.js";
import { Merchant, subscriberByRef, planById, plansFor } from "../src/store.js";

let db: Db;
let fake: FakePayPal;
let m: Merchant;
let server: Server;
let base: string;
const agent = { kind: "agent" as const, agentId: "test-agent" };

async function sub(ref: string) {
  return (await subscriberByRef(db, ref))!;
}

async function activeSubscriber(name = "Ada", planIdx = 0) {
  const plans = (await plansFor(db, m.id)).filter((p) => p.kind === "regular");
  const out = await svc.startSubscription(m, plans[planIdx].id, { name, email: `${name.toLowerCase()}@example.com` }, agent);
  fake.approve(out.paypalSubscriptionId);
  await svc.syncSubscription(out.ref);
  return out.ref;
}

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  m = await svc.createMerchant({ name: "Test Roasters", tagline: "Beans monthly", currency: "USD" });
  const drafts = (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value;
  await svc.createPlans(m.id, drafts);
  const rules = await svc.previewRules("One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.");
  expect(rules.valid).toBe(true);
  await svc.approveRules(m.id, rules.value, "test rules");
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  server?.close();
  setPayPalFactory(null);
});

describe("setup", () => {
  it("created PayPal plans including the discount plan", async () => {
    const plans = await plansFor(db, m.id, true);
    expect(plans.map((p) => p.kind).sort()).toEqual(["lite", "promo", "promo", "regular"]);
    expect(plans.every((p) => p.paypal_plan_id?.startsWith("P-"))).toBe(true);
    const promo = plans.find((p) => p.kind === "promo" && p.price === 20.4);
    expect(promo).toBeTruthy();
  });
});

describe("subscribe and change", () => {
  it("subscribes, needs approval, then reads ACTIVE back from PayPal", async () => {
    const plans = (await plansFor(db, m.id)).filter((p) => p.kind === "regular");
    const out = await svc.startSubscription(m, plans[0].id, { name: "Bea", email: "bea@example.com" }, agent);
    expect(out.approvalUrl).toMatch(/sandbox\.paypal\.com/);
    expect((await sub(out.ref)).status).toBe("APPROVAL_PENDING");
    fake.approve(out.paypalSubscriptionId);
    const s = await svc.syncSubscription(out.ref);
    expect(s.status).toBe("ACTIVE");
    expect(s.started_at).toBeTruthy();
  });

  it("skips one renewal, enforces the allowance, and resumes on schedule", async () => {
    const ref = await activeSubscriber("Cy");
    const out = await svc.skipNext(ref, agent);
    expect(out.sub.status).toBe("SUSPENDED");
    await expect(svc.resume(ref, agent)).resolves.toBeTruthy();
    await expect(svc.skipNext(ref, agent)).rejects.toThrow(/Skip limit/);
    // pause, then let the scheduler resume it
    const p = await svc.pause(ref, 1, agent);
    expect(p.sub.status).toBe("SUSPENDED");
    await db.query("UPDATE jobs SET run_at = now() - interval '1 minute' WHERE dedupe_key = $1", [`reactivate:${(await sub(ref)).id}`]);
    await tick();
    expect((await sub(ref)).status).toBe("ACTIVE");
  });

  it("refuses a pause longer than the rules allow", async () => {
    const ref = await activeSubscriber("Dee");
    await expect(svc.pause(ref, 5, agent)).rejects.toThrow(/1 to 2 cycles/);
  });

  it("switches plan via PayPal revise", async () => {
    const ref = await activeSubscriber("Eve");
    const lite = (await plansFor(db, m.id)).find((p) => p.kind === "lite")!;
    const out = await svc.switchPlan(ref, lite.id, agent);
    expect(out.confirmed).toBe(true);
    expect((await sub(ref)).plan_id).toBe(lite.id);
  });

  it("returns PayPal's approval link when a plan change needs consent", async () => {
    const ref = await activeSubscriber("Fay");
    const lite = (await plansFor(db, m.id)).find((p) => p.kind === "lite")!;
    fake.reviseNeedsConsent = true;
    const out = await svc.switchPlan(ref, lite.id, agent);
    fake.reviseNeedsConsent = false;
    expect(out.approvalUrl).toMatch(/update/);
    expect((await sub(ref)).kept_state).toBe(`switch_pending:${lite.id}`);
  });
});

describe("cancelling is never blocked", () => {
  it("cancels in one call with no offer by default", async () => {
    const ref = await activeSubscriber("Gus");
    const out = await svc.requestCancel(ref, { reason: "money is tight" }, agent);
    expect(out.status).toBe("cancelled");
    expect((await sub(ref)).status).toBe("CANCELLED");
  });

  it("makes one offer when asked, and accepting a pause keeps the subscriber", async () => {
    const ref = await activeSubscriber("Hal");
    const out = await svc.requestCancel(ref, { reason: "travelling for a while", hearOffer: true }, agent);
    expect(out.status).toBe("offer_open");
    expect(out.offer?.type).toBe("pause");
    const res = await svc.respondToOffer(out.offer!.offer_id, true, agent);
    expect(res.status).toBe("kept");
    const s = await sub(ref);
    expect(s.status).toBe("SUSPENDED");
    expect(s.resume_at).toBeTruthy();
  });

  it("declining the offer cancels immediately", async () => {
    const ref = await activeSubscriber("Ivy");
    const out = await svc.requestCancel(ref, { reason: "money is tight", hearOffer: true }, agent);
    expect(out.status).toBe("offer_open");
    // new subscriber: discount needs no tenure in these rules, so price → discount
    expect(out.offer?.type).toBe("discount");
    const res = await svc.respondToOffer(out.offer!.offer_id, false, agent);
    expect(res.status).toBe("cancelled");
    expect((await sub(ref)).status).toBe("CANCELLED");
  });

  it("an expired offer cancels as originally asked", async () => {
    const ref = await activeSubscriber("Jo");
    const out = await svc.requestCancel(ref, { reason: "", hearOffer: true }, agent);
    expect(out.status).toBe("offer_open");
    await db.query("UPDATE jobs SET run_at = now() - interval '1 minute' WHERE dedupe_key = $1", [`offer:${out.offer!.offer_id}`]);
    await tick();
    expect((await sub(ref)).status).toBe("CANCELLED");
  });

  it("a PayPal failure never reports success: the cancellation stays pending and is retried until PayPal confirms", async () => {
    const ref = await activeSubscriber("Lou");
    fake.failNext = "cancelSubscription";
    const out = await svc.requestCancel(ref, { reason: "moving abroad" }, agent);
    expect(out.status).toBe("cancel_pending");
    const s1 = await sub(ref);
    expect(s1.status).toBe("ACTIVE");
    expect(s1.kept_state).toBe("cancel_pending");
    await db.query("UPDATE jobs SET run_at = now() - interval '1 minute' WHERE dedupe_key = $1", [`cancel:${s1.id}`]);
    await tick();
    const s2 = await sub(ref);
    expect(s2.status).toBe("CANCELLED");
    expect(s2.kept_state).toBeNull();
  });

  it("a direct cancel overrides an open offer instead of being blocked by it", async () => {
    const ref = await activeSubscriber("Max");
    const first = await svc.requestCancel(ref, { reason: "money is tight", hearOffer: true }, agent);
    expect(first.status).toBe("offer_open");
    const out = await svc.requestCancel(ref, { reason: "just cancel please" }, agent);
    expect(out.status).toBe("cancelled");
    expect((await sub(ref)).status).toBe("CANCELLED");
    expect((await db.query<any>("SELECT status FROM offers WHERE id = $1", [first.offer!.offer_id])).rows[0].status).toBe("declined");
  });

  it("declining an offer when PayPal fails leaves a pending cancellation, not a false success", async () => {
    const ref = await activeSubscriber("Ned");
    const o = await svc.requestCancel(ref, { reason: "money is tight", hearOffer: true }, agent);
    fake.failNext = "cancelSubscription";
    const res = await svc.respondToOffer(o.offer!.offer_id, false, agent);
    expect(res.status).toBe("cancel_pending");
    const s1 = await sub(ref);
    await db.query("UPDATE jobs SET run_at = now() - interval '1 minute' WHERE dedupe_key = $1", [`cancel:${s1.id}`]);
    await tick();
    expect((await sub(ref)).status).toBe("CANCELLED");
  });

  it("quality complaints get no offer and cancel at once", async () => {
    const ref = await activeSubscriber("Kim");
    const out = await svc.requestCancel(ref, { reason: "the beans tasted stale", hearOffer: true }, agent);
    expect(out.status).toBe("cancelled");
  });

  it("an accepted discount moves to the discount plan and is scheduled to revert", async () => {
    const ref = await activeSubscriber("Lou");
    const out = await svc.requestCancel(ref, { reason: "too expensive", hearOffer: true }, agent);
    expect(out.offer?.type).toBe("discount");
    await svc.respondToOffer(out.offer!.offer_id, true, agent);
    const s = await sub(ref);
    const plan = await planById(db, s.plan_id!);
    expect(plan?.kind).toBe("promo");
    expect(s.promo_until).toBeTruthy();
    await db.query("UPDATE jobs SET run_at = now() - interval '1 minute' WHERE dedupe_key = $1", [`revert:${s.id}`]);
    await tick();
    const after = await sub(ref);
    expect((await planById(db, after.plan_id!))?.kind).toBe("regular");
  });

  it("a discount that needs the subscriber's PayPal approval starts (and counts as kept) only once PayPal confirms it", async () => {
    const ref = await activeSubscriber("Moe");
    const out = await svc.requestCancel(ref, { reason: "too expensive", hearOffer: true }, agent);
    fake.reviseNeedsConsent = true;
    const res = await svc.respondToOffer(out.offer!.offer_id, true, agent);
    fake.reviseNeedsConsent = false;
    expect((res as any).approvalUrl).toBeTruthy();
    const s1 = await sub(ref);
    expect(s1.promo_until).toBeNull();
    expect(s1.kept_state).toMatch(/^switch_pending:/);
    expect((await db.query("SELECT 1 FROM jobs WHERE dedupe_key = $1", [`revert:${s1.id}`])).rows).toHaveLength(0);
    expect((await db.query<any>("SELECT consent_pending FROM offers WHERE id = $1", [out.offer!.offer_id])).rows[0].consent_pending).toBe(true);
    // The subscriber approves at PayPal; the next sync sees the promo plan.
    const promoId = s1.kept_state!.split(":")[1];
    const promo = await planById(db, promoId);
    (fake as any).subs.get(s1.paypal_subscription_id).plan_id = promo!.paypal_plan_id;
    await svc.syncSubscription(ref);
    const s2 = await sub(ref);
    expect(s2.promo_until).toBeTruthy();
    expect((await db.query("SELECT 1 FROM jobs WHERE dedupe_key = $1", [`revert:${s1.id}`])).rows).toHaveLength(1);
    expect((await db.query<any>("SELECT consent_pending FROM offers WHERE id = $1", [out.offer!.offer_id])).rows[0].consent_pending).toBe(false);
  });

  it("the cooldown stops a second offer", async () => {
    const ref = await activeSubscriber("Max");
    const first = await svc.requestCancel(ref, { reason: "too much coffee piling up", hearOffer: true }, agent);
    await svc.respondToOffer(first.offer!.offer_id, true, agent);
    await svc.resume(ref, agent).catch(() => undefined);
    const second = await svc.requestCancel(ref, { reason: "too much coffee piling up", hearOffer: true }, agent);
    expect(second.status).toBe("cancelled");
  });
});

describe("policy replay", () => {
  it("shows which past cancellation requests a draft policy would treat differently, before approval", async () => {
    const ref = await activeSubscriber("Pia");
    const out = await svc.requestCancel(ref, { reason: "travelling for a while", hearOffer: true }, agent);
    expect(out.offer?.type).toBe("pause");
    const m = (await db.query<any>("SELECT merchant_id FROM subscribers WHERE ref = $1", [ref])).rows[0].merchant_id;
    const draft = await svc.previewRules("One skip per quarter. One offer per year.");
    expect(draft.valid).toBe(true);
    const r = await svc.replayRules(m, draft.value);
    expect(r.cases).toBeGreaterThan(0);
    const row = r.rows.find((x) => x.reason === "travelling for a while")!;
    expect(row.before).toMatch(/[Pp]ause/);
    expect(row.after).not.toMatch(/[Pp]ause/);
    expect(row.changed).toBe(true);
  });
});

describe("failed payments", () => {
  it("records the failure, tells the subscriber, and collects once fixed", async () => {
    const ref = await activeSubscriber("Ned");
    const s = await sub(ref);
    fake.failRenewal(s.paypal_subscription_id!);
    await svc.handlePaymentFailed(s.id, "webhook");
    const view = await svc.subscriptionView(ref);
    expect(view.notice).toMatch(/didn't go through/);
    expect(view.available_actions).toContain("payment_fixed");
    const out = await svc.paymentFixed(ref, agent);
    expect(out.captured).toBe("24.00");
    expect((await sub(ref)).outstanding).toBe(0);
  });

  it("a payment promise pauses reminders until its date; after it passes, one follow-up goes out", async () => {
    const ref = await activeSubscriber("Ola");
    const s = await sub(ref);
    fake.failRenewal(s.paypal_subscription_id!);
    await svc.handlePaymentFailed(s.id, "webhook");
    const in3 = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    await expect(svc.promisePayment(ref, new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), agent)).rejects.toThrow(/14 days/);
    await svc.promisePayment(ref, in3, agent);
    const reminders = async () => (await db.query<any>("SELECT summary FROM event_log WHERE subscriber_id = $1 AND type = 'payment.reminder'", [s.id])).rows;
    await svc.paymentFollowup(s.id);
    expect(await reminders()).toHaveLength(0);
    await db.query("UPDATE subscribers SET promise_until = now() - interval '1 hour' WHERE id = $1", [s.id]);
    await svc.paymentFollowup(s.id);
    const r = await reminders();
    expect(r).toHaveLength(1);
    expect(r[0].summary).toMatch(/promised date passed/);
  });
});

describe("webhooks", () => {
  it("rejects unsigned events and processes verified ones", async () => {
    const ref = await activeSubscriber("Oz");
    const s = await sub(ref);
    const event = { id: "WH-1", event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: s.paypal_subscription_id } };
    const bad = await fetch(`${base}/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
    expect(bad.status).toBe(400);
    process.env.PAYPAL_WEBHOOK_ID = "WH-FAKE";
    const { config } = await import("../src/config.js");
    config.paypal.webhookId = "WH-FAKE";
    fake.subs.get(s.paypal_subscription_id!)!.status = "CANCELLED";
    const event2 = { ...event, id: "WH-2" };
    const good = await fetch(`${base}/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json", "paypal-transmission-sig": "valid-fake-signature" }, body: JSON.stringify(event2) });
    expect(good.status).toBe(200);
    await tick();
    expect((await sub(ref)).status).toBe("CANCELLED");
    const dup = await fetch(`${base}/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json", "paypal-transmission-sig": "valid-fake-signature" }, body: JSON.stringify(event2) });
    expect(dup.status).toBe(200);
  });
});

describe("MCP agent endpoint", () => {
  it("lets an agent find the shop, subscribe idempotently, and cancel in one call", async () => {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { "X-Agent-Id": "vitest-agent" } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["find_shops", "start_subscription", "cancel_subscription", "respond_to_offer"]));
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const found = parse(await client.callTool({ name: "find_shops", arguments: { query: "beans" } }));
    expect(found.shops[0].shop).toBe(m.slug);
    const planId = found.shops[0].plans[0].plan_id;
    const a = parse(await client.callTool({ name: "start_subscription", arguments: { shop: m.slug, plan_id: planId, subscriber_email: "agent-user@example.com", idempotency_key: "k-1" } }));
    const b = parse(await client.callTool({ name: "start_subscription", arguments: { shop: m.slug, plan_id: planId, subscriber_email: "agent-user@example.com", idempotency_key: "k-1" } }));
    expect(b.subscription_ref).toBe(a.subscription_ref);
    expect(b.replayed).toBe(true);
    expect(a.approval_url).toMatch(/paypal/);
    const s = await sub(a.subscription_ref);
    fake.approve(s.paypal_subscription_id!);
    const got = parse(await client.callTool({ name: "get_subscription", arguments: { subscription_ref: a.subscription_ref } }));
    expect(got.status).toBe("ACTIVE");
    const c = parse(await client.callTool({ name: "cancel_subscription", arguments: { subscription_ref: a.subscription_ref, reason: "moving abroad" } }));
    expect(c.status).toBe("cancelled");
    const bad = await client.callTool({ name: "get_subscription", arguments: { subscription_ref: "ref_doesnotexist" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });

  it("serves the owner's read-only server only with the owner key", async () => {
    const res = await fetch(`${base}/owner/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    const client = new Client({ name: "owner", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/owner/mcp`), { requestInit: { headers: { Authorization: `Bearer ${m.owner_token}` } } }));
    const r: any = await client.callTool({ name: "ask", arguments: { question: "why are people cancelling?" } });
    expect(JSON.parse(r.content[0].text).answer).toMatch(/reasons/i);
    await client.close();
  });
});

describe("REST API and pages", () => {
  it("serves shops, plans, llms.txt, the shop page and the dashboard behind sign-in", async () => {
    const shops = await (await fetch(`${base}/api/v1/shops`)).json();
    expect(shops.shops[0].plans.length).toBe(2);
    expect((await fetch(`${base}/s/${m.slug}`)).status).toBe(200);
    expect(await (await fetch(`${base}/s/${m.slug}/llms.txt`)).text()).toMatch(/cancel_subscription always cancels/);
    const dash = await fetch(`${base}/dashboard`, { redirect: "manual" });
    expect(dash.status).toBe(302);
    const login = await fetch(`${base}/login/token`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${m.owner_token}` });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const page = await fetch(`${base}/dashboard`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toMatch(/Kept by fair offers/);
    const cal = await (await fetch(`${base}/dashboard/calendar.json`, { headers: { cookie } })).json();
    expect(cal.resources.length).toBe(5);
    const stats = await (await fetch(`${base}/api/v1/owner/stats`, { headers: { authorization: `Bearer ${m.owner_token}` } })).json();
    expect(stats.offersMade).toBeGreaterThan(0);
  });
});

describe("safety details", () => {
  it("never puts the owner key in a redirect URL during onboarding", async () => {
    const res = await fetch(`${base}/onboard/shop`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "name=Key+Test&currency=USD&pp=env" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toMatch(/own_/);
    const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const page = await (await fetch(`${base}/onboard/plans`, { headers: { cookie: cookies } })).text();
    expect(page).toMatch(/Save your owner key now/);
  });

  it("treats sample rows as view-only", async () => {
    const id = "sub_sampletest";
    await db.query("INSERT INTO subscribers (id, merchant_id, ref, status, is_sample) VALUES ($1,$2,$3,'ACTIVE',true)", [id, m.id, "ref_sampletest000000"]);
    const v = await svc.subscriptionView("ref_sampletest000000");
    expect(v.available_actions).toEqual([]);
    await expect(svc.requestCancel("ref_sampletest000000", {}, agent)).rejects.toThrow(/sample/);
  });

  it("escapes shop text on public pages", async () => {
    const evil = await svc.createMerchant({ name: "<script>alert(1)</script> Shop", tagline: "<img src=x onerror=alert(1)>" });
    const page = await (await fetch(`${base}/s/${evil.slug}`)).text();
    expect(page).not.toMatch(/<script>alert/);
    expect(page).not.toMatch(/<img src=x/);
  });
});
