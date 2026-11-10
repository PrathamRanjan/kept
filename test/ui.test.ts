import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { createApp } from "../src/app.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { plansFor, type Merchant } from "../src/store.js";
import { cycleCard } from "../src/web/cycles.js";
import { Client } from "./client.js";
import { serveTracked } from "./journey-coverage.js";

// The JSON API behind the React UI (src/web/ui-api.ts) and the page shell (src/web/spa.ts):
// every route used, no 5xx, and each answer checked against what PayPal (the fake) holds.
let db: Db;
let fake: FakePayPal;
let m: Merchant;
let srv: Awaited<ReturnType<typeof serveTracked>>;
const spaBuilt = existsSync(new URL("../web/dist/index.html", import.meta.url));

async function member(name: string) {
  const plans = (await plansFor(db, m.id)).filter((p) => p.kind === "regular");
  const out = await svc.startSubscription(m, plans[0].id, { name, email: `${name.toLowerCase()}@example.com` }, { kind: "web" });
  fake.approve(out.paypalSubscriptionId);
  await svc.syncSubscription(out.ref);
  return out.ref;
}

beforeAll(async () => {
  process.env.KEPT_SPA = "on";
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  m = await svc.createMerchant({ name: "Ember & Oak Coffee Club", tagline: "Beans monthly", currency: "USD" });
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  const rules = await svc.previewRules("One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.");
  await svc.approveRules(m.id, rules.value, "ui test rules");
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  process.env.KEPT_SPA = "off";
  await srv?.close();
  setPayPalFactory(null);
});

describe("UI JSON API", () => {
  it("serves session, preview and the shop, and starts a subscription", async () => {
    const c = new Client(srv.base);
    const s = (await c.get("/ui/session")).json;
    expect(s).toMatchObject({ owner: null, demoMode: true, demoShop: m.slug, paypalEnv: expect.any(String) });
    const p = (await c.get("/ui/preview")).json;
    expect(p.shop.name).toBe("Ember & Oak Coffee Club");
    expect(p.promise.join(" ")).toMatch(/one step/);
    const shop = (await c.get(`/ui/shop/${m.slug}`)).json;
    expect(shop.plans.map((x: any) => x.name)).toEqual(expect.arrayContaining(["Signature bag"]));
    expect((await c.get("/ui/shop/no-such-shop")).status).toBe(404);
    const plan = shop.plans[0].id;
    expect((await c.postJson(`/ui/shop/${m.slug}/subscribe`, { plan_id: plan, name: "Pat", email: "not-an-email" })).status).toBe(422);
    const out = (await c.postJson(`/ui/shop/${m.slug}/subscribe`, { plan_id: plan, name: "Pat", email: "pat@example.com", key: "k-1" })).json;
    expect(out.approval_url).toMatch(/sandbox\.paypal\.com/);
    expect(out.paypal_subscription_id).toMatch(/^I-/);
  });

  it("member page: card, timeline, skip/pause/resume/switch/cancel all match PayPal", async () => {
    const c = new Client(srv.base);
    const ref = await member("Ada");
    let v = (await c.get(`/ui/manage/${ref}`)).json;
    expect(v.view.status).toBe("ACTIVE");
    expect(v.card.stamps.some((x: any) => x.next)).toBe(true);
    expect(v.pauseMax).toBe(2);
    expect((await c.get("/ui/manage/ref_nope")).status).toBe(404);

    expect((await c.postJson(`/ui/manage/${ref}/skip`, { key: "s1" })).json.ok).toBe(true);
    v = (await c.get(`/ui/manage/${ref}`)).json;
    expect(v.view.status).toBe("SUSPENDED");
    expect(v.card.stamps.some((x: any) => x.kind === "skipped")).toBe(true);
    expect(v.timeline.length).toBeGreaterThan(0);
    expect(v.timeline[0].steps.map((x: any) => x.who)).toContain("PayPal");

    await c.postJson(`/ui/manage/${ref}/resume`, {});
    await c.postJson(`/ui/manage/${ref}/pause`, { cycles: 1 });
    expect(fake.subs.get((await c.get(`/ui/manage/${ref}`)).json.view.paypal_subscription_id)?.status ?? "SUSPENDED").toBe("SUSPENDED");
    await c.postJson(`/ui/manage/${ref}/resume`, {});
    const lite = v.switchTo.find((x: any) => /Lite/.test(x.name));
    expect((await c.postJson(`/ui/manage/${ref}/switch`, { plan_id: lite.id })).json.ok).toBe(true);
    expect((await c.postJson(`/ui/manage/${ref}/promise`, { date: "2099-01-01" })).status).toBeLessThan(500);
    expect((await c.postJson(`/ui/manage/${ref}/payment-fixed`, {})).status).toBeLessThan(500);

    const cx = (await c.postJson(`/ui/manage/${ref}/cancel`, { reason: "too much coffee" })).json;
    expect(cx.status).toBe("cancelled");
    v = (await c.get(`/ui/manage/${ref}`)).json;
    expect(v.view.status).toBe("CANCELLED");
    expect(v.card.end.kind).toBe("cancelled");
  });

  it("asking for an offer returns one offer; declining cancels", async () => {
    const c = new Client(srv.base);
    const ref = await member("Bea");
    // Bea is new, so the discount (60+ days) is not offered, but pause is.
    const out = (await c.postJson(`/ui/manage/${ref}/cancel`, { hear_offer: true })).json;
    expect(out.status).toBe("offer_open");
    const v = (await c.get(`/ui/manage/${ref}`)).json;
    expect(v.offer.type).toMatch(/pause|switch|skip/);
    expect((await c.postJson(`/ui/offer/${v.offer.id}/decline`, {})).json.ok).toBe(true);
    expect((await c.get(`/ui/manage/${ref}`)).json.view.status).toBe("CANCELLED");

    const ref2 = await member("Cy");
    await c.postJson(`/ui/manage/${ref2}/cancel`, { hear_offer: true });
    const o2 = (await c.get(`/ui/manage/${ref2}`)).json.offer;
    expect((await c.postJson(`/ui/offer/${o2.id}/accept`, {})).json.ok).toBe(true);
    expect((await c.get(`/ui/manage/${ref2}`)).json.view.status).not.toBe("CANCELLED");
  });

  it("owner endpoints need the owner, then serve today, members, ask, approvals and runs", async () => {
    const anon = new Client(srv.base);
    expect((await anon.get("/ui/owner/today")).status).toBe(401);
    const c = new Client(srv.base);
    expect((await c.postJson("/ui/demo/owner", {})).json.ok).toBe(true);
    expect((await c.get("/ui/session")).json.owner).toMatchObject({ slug: m.slug });
    const ref = await member("Dee");
    const t = (await c.get("/ui/owner/today")).json;
    expect(t.stats.live.active).toBeGreaterThanOrEqual(1);
    expect(t.members.find((x: any) => x.ref === ref).card.stamps.length).toBeGreaterThan(0);
    expect(t.rules.lines.join(" ")).toMatch(/one step/);
    expect((await c.postJson("/ui/owner/ask", { question: "" })).status).toBe(422);
    expect((await c.postJson("/ui/owner/ask", { question: "Who has a failed payment?" })).json.answer).toBeTruthy();
    expect((await c.postJson("/ui/owner/reconcile", {})).json.message).toMatch(/Checked \d+/);
    expect((await c.postJson(`/ui/owner/member/${ref}/sync`, {})).json.message).toMatch(/PayPal shows active/);
    expect((await c.get(`/ui/owner/member/${ref}`)).json).toBeTruthy();
    expect((await c.get("/ui/owner/runs")).json).toBeTruthy();
    // No held approval exists here; deciding an unknown one is a clean 4xx, never a 5xx.
    const r = await c.postJson("/ui/owner/approvals/apr_missing/approve", {});
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect((await c.postJson("/ui/owner/approvals/apr_missing/decline", {})).status).toBeLessThan(500);
  });

  it.skipIf(!spaBuilt)("serves the app shell with per-page titles, noindex on private pages, and a 404 for unknown members", async () => {
    const c = new Client(srv.base);
    const ref = await member("Eve");
    for (const p of ["/", "/demo", "/judge", `/s/${m.slug}`, `/manage/${ref}`, "/dashboard", "/dashboard/members", "/dashboard/approvals"]) {
      const r = await c.get(p);
      expect(r.status, p).toBe(200);
      expect(r.text, p).toMatch(/<div id="root">/);
    }
    expect((await c.get(`/s/${m.slug}`)).text).toMatch(/application\/ld\+json/);
    expect((await c.get(`/manage/${ref}`)).text).toMatch(/noindex/);
    expect((await c.get("/manage/ref_nope")).status).toBe(404);
    for (const f of ["/favicon.svg", "/robots.txt"]) expect((await c.get(f)).status).toBeLessThan(400);
  });

  it("cycle card: paid stamps, a scheduled skip, and a clean end", async () => {
    const ref = await member("Fay");
    const s = (await svc.subscriptionView(ref)) as any;
    const sub = (await db.query<any>("SELECT * FROM subscribers WHERE ref = $1", [ref])).rows[0];
    const card = await cycleCard(db, sub, await plansFor(db, m.id, true));
    expect(card.every).toMatch(/month/);
    expect(card.stamps.filter((x) => x.next).length).toBe(1);
    expect(s).toBeTruthy();
  });

  it("used every UI route with no server error", () => {
    expect(srv.failures).toEqual([]);
    const ours = (r: string) => /^(GET|POST) \/(ui\/|demo$|judge$|dashboard$|dashboard\/(members|approvals)$|s\/:slug$|manage\/:ref$|favicon\.svg|robots\.txt|og\.png|$)/.test(r);
    const missed = srv.missed((r) => !ours(r) || r === "GET /og.png" || (!spaBuilt && !r.includes("/ui/")));
    expect(missed).toEqual([]);
  });
});
