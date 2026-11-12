import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { checkWallet } from "../src/demo/wallet.js";
import { ensureShowcase, expireIdle, workspaceById } from "../src/demo/workspaces.js";
import { waitForClaims } from "../src/web/demo.js";
import * as svc from "../src/service.js";
import { plansFor, type Merchant } from "../src/store.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { Client } from "./client.js";
import { isWave1Route, serveTracked } from "./journey-coverage.js";

// Wave 1 of the master improvement spec: saved demo wallet (A2.1), admin pages. Later sections add the
// private demo workspaces (A1), the approval pool (A2.2), health (A4) and the no-fallback AI rules (A11).
let db: Db;
let fake: FakePayPal;
let srv: Awaited<ReturnType<typeof serveTracked>>;
let showcaseShop: Merchant;
let legacyRef = "";
const savedAdmin = config.adminKey;
const savedToken = config.paypal.demoVaultToken;

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  (config as any).adminKey = "admin-test-key-0123456789";
  // The showcase shop, as `npm run seed` makes it, with one real member from before workspaces existed.
  showcaseShop = await svc.createMerchant({ name: "Ember & Oak Coffee Club", tagline: "Beans monthly", currency: "USD" });
  await svc.createPlans(showcaseShop.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly\nDaily demo bag $1 daily", "USD")).value);
  const rules = await svc.previewRules("One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.");
  await svc.approveRules(showcaseShop.id, rules.value, "wave1 rules");
  const daily = (await plansFor(db, showcaseShop.id)).find((p) => p.interval_unit === "DAY")!;
  const legacy = await svc.startSubscription(showcaseShop, daily.id, { name: "Sam Rivera", email: "sam@example.com" }, { kind: "web" });
  fake.approve(legacy.paypalSubscriptionId!);
  await svc.syncSubscription(legacy.ref);
  legacyRef = legacy.ref;
  await db.query("UPDATE merchants SET paypal_webhook_id = 'WH-SHOWCASE' WHERE id = $1", [showcaseShop.id]);
  await ensureShowcase(db);
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  (config as any).adminKey = savedAdmin;
  config.paypal.demoVaultToken = savedToken;
  await srv.close();
  setPayPalFactory(null);
});

describe("A2.1 saved demo wallet", () => {
  it("reads the token from PayPal and reports when it is gone", async () => {
    fake.vault.set("PT-DEMO1", { id: "PT-DEMO1", customerId: "C-1", payerEmail: "buyer@example.com" });
    config.paypal.demoVaultToken = "PT-DEMO1";
    const ok = await checkWallet();
    expect(ok.ok).toBe(true);
    expect(ok.token).toBe("PT-…MO1");
    expect(fake.calls.some((c) => c.method === "getPaymentToken" && c.args[0] === "PT-DEMO1")).toBe(true);
    fake.vault.delete("PT-DEMO1");
    const gone = await checkWallet();
    expect(gone.ok).toBe(false);
    expect(gone.detail).toMatch(/re-approval/);
  });

  it("admin pages need the admin key; re-approval exchanges and reads back the new token", async () => {
    const anon = new Client(srv.base);
    expect((await anon.get("/admin")).status).toBe(401);
    expect((await anon.get("/admin/paypal/wallet.json", { accept: "application/json" })).status).toBe(401);
    expect((await anon.req("POST", "/admin/login", { form: { key: "wrong", next: "/admin" } })).status).toBe(401);
    const admin = new Client(srv.base);
    const login = await admin.req("POST", "/admin/login", { form: { key: config.adminKey, next: "/admin/paypal/wallet" } });
    expect(login.status).toBe(302);
    expect((await admin.get("/admin")).status).toBe(200);
    const page = await admin.get("/admin/paypal/wallet");
    expect(page.text).toMatch(/APPROVAL_PENDING/);
    const check = await admin.req("POST", "/admin/paypal/wallet/check");
    expect(check.location).toMatch(/err=/); // the token was deleted above
    const start = await admin.req("POST", "/admin/paypal/wallet/start");
    expect(start.location).toMatch(/sandbox\.paypal\.com/);
    const st = [...fake.setupTokens.values()].at(-1)!;
    expect((await admin.get(`/admin/paypal/wallet/return?approval_token_id=${st.id}`)).location).toMatch(/err=/); // not approved yet
    st.approved = true;
    const done = await admin.get(`/admin/paypal/wallet/return?approval_token_id=${st.id}`);
    expect(done.location).toMatch(/ok=Saved/);
    const j = await new Client(srv.base).get("/admin/paypal/wallet.json?check=1", { authorization: `Bearer ${config.adminKey}` });
    expect(j.json.ok).toBe(true);
    expect(JSON.stringify(j.json)).not.toMatch(/PT-[0-9A-F]{12}/); // masked
    expect((await admin.req("POST", "/admin/logout")).status).toBe(302);
  });
});


const ip = (n: number) => ({ "x-forwarded-for": `203.0.113.${n}` });
const admin = () => ({ authorization: `Bearer ${config.adminKey}`, accept: "application/json" });

describe("A1 private workspaces and A2.2 the approval pool", () => {
  it("the showcase is rebuilt through the seeding path; its live member moves to the pool", async () => {
    const anon = new Client(srv.base);
    expect((await anon.req("POST", "/admin/showcase/rebuild", { headers: { accept: "application/json" } })).status).toBe(401);
    const out = (await new Client(srv.base).req("POST", "/admin/showcase/rebuild", { headers: admin() })).json;
    expect(out.pooled).toHaveLength(1);
    // A5.6: the daily showcase run, started by the admin. With no model it records failures, never passes.
    expect((await anon.req("POST", "/admin/showcase/eval", { headers: { accept: "application/json" } })).status).toBe(401);
    const ev = (await new Client(srv.base).req("POST", "/admin/showcase/eval", { headers: admin() })).json;
    expect(ev.trigger).toBe("admin");
    expect(ev.cases.find((c: any) => c.id === "ask").pass).toBe(false);
    const rows = (await db.query<any>("SELECT count(*) FILTER (WHERE is_sample)::int AS s, count(*) FILTER (WHERE NOT is_sample)::int AS r FROM subscribers WHERE merchant_id = $1", [showcaseShop.id])).rows[0];
    expect(rows.s).toBeGreaterThanOrEqual(40);
    expect(rows.r).toBe(0);
    expect((await anon.get(`/ui/manage/${legacyRef}`)).status).toBe(404);
    // The landing preview reads the showcase, and the showcase is read-only to visitors.
    expect((await anon.get("/ui/preview")).json.shop.slug).toBe(showcaseShop.slug);
    const shop = (await anon.get(`/ui/shop/${showcaseShop.slug}`)).json;
    expect(shop.showcase).toBe(true);
    const sub = await anon.postJson(`/ui/shop/${showcaseShop.slug}/subscribe`, { plan_id: shop.plans[0].id, name: "X", email: "x@example.com", key: "k1" });
    expect(sub.status).toBe(409);
    expect(sub.json.message).toMatch(/read-only showcase/);
    // The pool: admin creates two more for approval; only approved ones become ready.
    const c = new Client(srv.base);
    await c.req("POST", "/admin/login", { form: { key: config.adminKey, next: "/admin" } });
    expect((await c.get("/admin/pool")).text).toMatch(/1 ready/);
    expect((await c.post("/admin/pool/refill", { n: "2" })).location).toMatch(/ok=Created%202/);
    const waiting = (await c.get("/admin/pool.json")).json.items.filter((i: any) => i.status === "awaiting_approval");
    expect(waiting).toHaveLength(2);
    expect(waiting[0].approve_url).toMatch(/paypal/);
    fake.approve(waiting[0].paypal_id);
    expect((await c.req("POST", "/admin/pool/sync", { headers: { accept: "application/json" } })).json.ready).toBe(2);
    expect((await c.get("/admin/pool.json")).json.counts).toMatchObject({ ready: 2, awaiting: 1 });
    // PayPal's sandbox drops one nobody approved: the read-back retires it and the page stops offering its dead link.
    const dead = waiting[1];
    fake.subs.delete(dead.paypal_id);
    expect((await c.req("POST", "/admin/pool/sync", { headers: { accept: "application/json" } })).json).toMatchObject({ ready: 2, spent: 1, errors: 0 });
    expect((await c.get("/admin/pool.json")).json.counts).toMatchObject({ ready: 2, awaiting: 0, spent: 1 });
    const page = (await c.get("/admin/pool")).text;
    expect(page).not.toContain(dead.approve_url);
    expect(page).toMatch(/approval link is dead/);
    expect((await c.get("/demo/pool/approved?id=x")).text).toMatch(/Thank you/);
    expect((await c.get("/admin")).text).toMatch(/Approval pool/);
  });

  it("two visitors get separate shops: own counts, own actions, own webhooks, nothing shared", async () => {
    const a = new Client(srv.base);
    const b = new Client(srv.base);
    expect((await a.get("/demo/status")).json.workspace).toBeNull();
    const [sa, sb] = await Promise.all([a.req("POST", "/demo/start", { json: {}, headers: ip(1) }), b.req("POST", "/demo/start", { json: {}, headers: ip(2) })]);
    expect(sa.json.ok && sb.json.ok).toBe(true);
    expect(sa.json.shop.slug).not.toBe(sb.json.shop.slug);
    await waitForClaims();
    const stA = (await a.get("/demo/status")).json;
    const stB = (await b.get("/demo/status")).json;
    // Two ready pool items, three wanted each: whoever claimed first got both, the other got none and is told why.
    expect(stA.counts.realActive + stB.counts.realActive).toBe(2);
    const [rich, poor, richC, poorC] = stA.counts.realActive ? [stA, stB, a, b] : [stB, stA, b, a];
    expect(poor.pool.line).toMatch(/pool is empty/);
    expect(rich.pool.line).toMatch(/2 of 3 real PayPal sandbox subscriptions/);
    expect(rich.sampleNote).toMatch(/No PayPal money moved/);
    expect(rich.joinQr).toMatch(/<svg/);
    // Each claimed subscription was tagged at PayPal with "<shop>:<member>".
    const richShop = (await db.query<any>("SELECT tenant_id FROM workspaces WHERE id = $1", [rich.workspace.id])).rows[0].tenant_id;
    const claimed = (await db.query<any>("SELECT paypal_subscription_id AS pp, id FROM subscribers WHERE merchant_id = $1 AND NOT is_sample", [richShop])).rows;
    for (const s of claimed) expect((fake as any).sub(s.pp).custom_id).toBe(`${richShop}:${s.id}`);
    expect((await db.query("SELECT 1 FROM paypal_refs WHERE merchant_id = $1", [richShop])).rows.length).toBe(2);

    // Owner views: samples are chipped and kept out of the PayPal figures.
    const ta = (await richC.get("/ui/owner/today")).json;
    const tb = (await poorC.get("/ui/owner/today")).json;
    expect(ta.shop.slug).toBe(rich.shop.slug);
    expect(ta.stats.sampleRows).toBeGreaterThanOrEqual(40);
    expect(ta.stats.live.active).toBe(2);
    expect(tb.stats.live.active).toBe(0);
    expect(tb.stats.live.revenueKept3).toBe(0);
    expect(tb.stats.revenueKept3).toBeGreaterThan(0);
    expect(ta.stats.collected30).toBeGreaterThanOrEqual(0);
    expect(tb.stats.collected30).toBe(0); // only PayPal-reported payments count
    expect(tb.approvals.some((x: any) => x.member?.sample)).toBe(true); // the held sample approval: "needs you now"
    const realRef = ta.members.find((x: any) => !x.sample).ref;

    // An action in A appears in A only.
    expect((await richC.postJson(`/ui/manage/${realRef}/skip`, { key: "skip-1" })).status).toBeLessThan(300);
    const evA = JSON.stringify((await richC.get("/ui/owner/today")).json.events);
    const evB = JSON.stringify((await poorC.get("/ui/owner/today")).json.events);
    expect(evA).toMatch(/suspend|skip/i);
    // Nothing of A's shows anywhere in B: members, offers, events, approvals, audit, kills, money, safety.
    const leak = [realRef, ...claimed.map((x) => x.pp), richShop];
    const bodies = [JSON.stringify(tb), evB, (await poorC.get("/dashboard/guard/audit.json")).text, (await poorC.get("/dashboard/guard/kills.json")).text, (await poorC.get("/dashboard/money/transactions.json")).text, (await poorC.get("/dashboard/safety")).text, (await poorC.get("/dashboard/members")).text, (await poorC.get("/dashboard/guard")).text];
    for (const body of bodies) for (const l of leak) expect(body).not.toContain(l);
    // A member page of A is not reachable as B's owner member view.
    expect((await poorC.get(`/ui/owner/member/${realRef}`)).status).toBeGreaterThanOrEqual(400);

    // A PayPal webhook for A's subscription lands in A.
    const pp = claimed[0].pp;
    const event = { id: "WH-ws-1", event_type: "BILLING.SUBSCRIPTION.UPDATED", resource: { id: pp } };
    const wh = await fetch(`${srv.base}/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json", "paypal-transmission-sig": "valid-fake-signature" }, body: JSON.stringify(event) });
    expect(wh.status).toBe(200);
    const { tick } = await import("../src/worker.js");
    await tick();
    expect((await db.query("SELECT merchant_id FROM event_log WHERE type = 'webhook.BILLING.SUBSCRIPTION.UPDATED'")).rows.map((r: any) => r.merchant_id)).toEqual([richShop]);

    // Kill switches: an owner cannot stop every shop; "agents" means their own shop's agents.
    const g = await poorC.post("/dashboard/guard/kill", { scope: "global", engaged: "true", reason: "x" });
    expect(g.location).toMatch(/err=/);
    expect((await poorC.post("/dashboard/guard/kill", { scope: "agents", engaged: "true", reason: "test" })).location).toMatch(/ok=/);
    expect((await richC.get("/dashboard/guard/kills.json")).json.kills.filter((k: any) => k.engaged)).toEqual([]);
    await poorC.post("/dashboard/guard/kill", { scope: "agents", engaged: "false" });

    // The directory and find_shops leave private workspaces out.
    const dir = (await new Client(srv.base).get("/llms.txt")).text;
    expect(dir).toContain(showcaseShop.slug);
    expect(dir).not.toContain(rich.shop.slug);
    expect(dir).not.toContain(poor.shop.slug);

    // Second device: the join link opens the same shop.
    const phone = new Client(srv.base);
    const join = await phone.get(rich.joinUrl.replace(config.appUrl, ""));
    expect(join.location).toMatch(/\/demo\?joined=1/);
    expect((await phone.get("/ui/session")).json.owner.slug).toBe(rich.shop.slug);
    expect((await phone.get(`${rich.joinUrl.replace(config.appUrl, "")}?to=member`)).location).toMatch(/\/manage\//);
    expect((await phone.get("/demo/join/not-a-token")).status).toBe(404);

    // The pool is empty now: a claim says so and invents nothing.
    const claim = (await poorC.postJson("/demo/pool/claim", {})).json;
    expect(claim.poolEmpty).toBe(true);
    expect(claim.message).toMatch(/pool is empty/);
  });

  it("reset gives the visitor a fresh copy and carries their real subscriptions across", async () => {
    const v = new Client(srv.base);
    const start = (await v.req("POST", "/demo/start", { json: {}, headers: ip(3) })).json;
    await waitForClaims();
    // Give this workspace one real member through the visitor's own PayPal-page subscription.
    const shop = (await v.get(`/ui/shop/${start.shop.slug}`)).json;
    expect(shop.showcase).toBe(false);
    const sub = (await v.postJson(`/ui/shop/${start.shop.slug}/subscribe`, { plan_id: shop.plans[0].id, name: "Rita Reset", email: "rita@example.com", key: "rk" })).json;
    expect(sub.ref).toBeTruthy();
    const ppId = (await db.query<any>("SELECT paypal_subscription_id AS pp FROM subscribers WHERE ref = $1", [sub.ref])).rows[0].pp;
    expect((fake as any).sub(ppId).custom_id).toMatch(new RegExp(`^mer_[a-z0-9]+:sub_`));
    fake.approve(ppId);
    await svc.syncSubscription(sub.ref);
    const reset = (await v.req("POST", "/demo/reset", { json: {}, headers: ip(3) })).json;
    await waitForClaims();
    expect(reset.ok).toBe(true);
    expect(reset.workspace.id).not.toBe(start.workspace.id);
    expect(await workspaceById(start.workspace.id)).toBeNull();
    expect((await db.query("SELECT 1 FROM merchants WHERE slug = $1", [start.shop.slug])).rows).toHaveLength(0);
    const after = (await v.get("/demo/status")).json;
    expect(after.counts.realActive).toBe(1);
    expect(fake.sub(ppId).status).toBe("ACTIVE"); // moved, not cancelled
  });

  it("admin expiry and idle expiry return live subscriptions to the pool (read back), end nothing, and remove the rows", async () => {
    const v = new Client(srv.base);
    const st = (await v.req("POST", "/demo/start", { json: {}, headers: ip(4) })).json;
    const shop = (await v.get(`/ui/shop/${st.shop.slug}`)).json;
    const sub = (await v.postJson(`/ui/shop/${st.shop.slug}/subscribe`, { plan_id: shop.plans[0].id, name: "Ed Expire", email: "ed@example.com", key: "ek" })).json;
    const ppId = (await db.query<any>("SELECT paypal_subscription_id AS pp FROM subscribers WHERE ref = $1", [sub.ref])).rows[0].pp;
    fake.approve(ppId);
    expect((await new Client(srv.base).req("POST", `/admin/workspaces/${st.workspace.id}/expire`, { headers: { accept: "application/json" } })).status).toBe(401);
    const out = (await new Client(srv.base).req("POST", `/admin/workspaces/${st.workspace.id}/expire`, { headers: admin() })).json;
    expect(out.returned).toEqual([{ paypalId: ppId, status: "ACTIVE" }]);
    expect(out.cancelled).toEqual([]);
    expect(fake.sub(ppId).status).toBe("ACTIVE");
    const back = (await db.query<any>("SELECT id, status, claimed_by_ws FROM approval_pool WHERE paypal_id = $1", [ppId])).rows[0];
    expect(back).toMatchObject({ status: "ready", claimed_by_ws: null });
    expect((fake.sub(ppId) as any).custom_id).toBe(`pool:${back.id}`);
    const tenant = (await db.query<any>("SELECT id FROM merchants WHERE slug = $1", [st.shop.slug])).rows;
    expect(tenant).toHaveLength(0);
    const wsShop = (await db.query<any>("SELECT DISTINCT merchant_id FROM paypal_refs WHERE resource_id = $1", [ppId])).rows;
    expect(wsShop).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM subscribers WHERE ref = $1", [sub.ref])).rows).toHaveLength(0);
    expect((await v.get("/demo/status")).json.workspace).toBeNull();
    expect((await v.get(`/demo/join/${encodeURIComponent(st.joinUrl.split("/demo/join/")[1])}`)).status).toBe(404);

    // The next visitor gets that same real subscription from the pool.
    const next = new Client(srv.base);
    const st3 = (await next.req("POST", "/demo/start", { json: {}, headers: ip(6) })).json;
    await waitForClaims(st3.workspace.id);
    const claimed = (await db.query<any>("SELECT s.merchant_id FROM subscribers s JOIN workspaces w ON w.tenant_id = s.merchant_id WHERE s.paypal_subscription_id = $1 AND w.id = $2", [ppId, st3.workspace.id])).rows;
    expect(claimed).toHaveLength(1);
    expect((fake.sub(ppId) as any).custom_id).toMatch(new RegExp(`^${claimed[0].merchant_id}:`));

    // Idle expiry: 48 hours after the last visit.
    const w = new Client(srv.base);
    const st2 = (await w.req("POST", "/demo/start", { json: {}, headers: ip(5) })).json;
    await db.query("UPDATE workspaces SET expires_at = now() - interval '1 minute' WHERE id = $1", [st2.workspace.id]);
    const gone = await expireIdle();
    expect(gone.map((g) => g.workspace)).toContain(st2.workspace.id);
    expect(await workspaceById(st2.workspace.id)).toBeNull();
    // Admin pages list and manage what is left.
    const c = new Client(srv.base);
    await c.req("POST", "/admin/login", { form: { key: config.adminKey, next: "/admin" } });
    expect((await c.get("/admin/workspaces")).text).toMatch(/showcase/);
    expect((await c.get("/admin/workspaces.json")).json.workspaces.length).toBeGreaterThan(0);
    expect((await c.post("/admin/showcase/rotate-token")).location).toMatch(/ok=/);
  });

  it("limits: five demo shops per address per hour, and a daily model allowance per shop", async () => {
    for (let i = 0; i < 5; i++) expect((await new Client(srv.base).req("POST", "/demo/start", { json: {}, headers: ip(9) })).status).toBeLessThan(300);
    const sixth = await new Client(srv.base).req("POST", "/demo/start", { json: {}, headers: ip(9) });
    expect(sixth.status).toBe(429);
    const v = new Client(srv.base);
    const st = (await v.req("POST", "/demo/start", { json: {}, headers: ip(10) })).json;
    await db.query("INSERT INTO usage_counters (scope, day, kind, n) VALUES ($1,$2,'model',60)", [st.workspace.id, new Date().toISOString().slice(0, 10)]);
    const ask = await v.postJson("/ui/owner/ask", { question: "why do people leave?" });
    expect(ask.status).toBe(429);
    expect(ask.json.message).toMatch(/today's 60 model calls/);
    await waitForClaims();
  });
});

describe("A4 hosting", () => {
  it("/healthz checks the database and names the commit; every response carries server timing", async () => {
    const saved = config.commit;
    (config as any).commit = "abc1234";
    const h = await new Client(srv.base).get("/healthz");
    expect(h.status).toBe(200);
    expect(h.json).toMatchObject({ ok: true, db: { ok: true }, commit: "abc1234" });
    expect(h.headers.get("cache-control")).toBe("no-store");
    expect(h.headers.get("server-timing")).toMatch(/^app;dur=\d/);
    expect((await new Client(srv.base).get("/ui/session")).headers.get("server-timing")).toMatch(/app;dur=/);
    (config as any).commit = saved;
  });
});

describe("route coverage", () => {
  it("every Wave 1 route was reached and none failed", async () => {
    await new Client(srv.base).get("/healthz");
    expect(srv.failures).toEqual([]);
    expect(srv.missed((r) => !isWave1Route(r))).toEqual([]);
  });
});
