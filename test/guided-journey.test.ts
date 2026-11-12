import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { ensureShowcase } from "../src/demo/workspaces.js";
import { START, STEPS } from "../src/demo/journey.js";
import { waitForClaims } from "../src/web/demo.js";
import * as svc from "../src/service.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { setBrain } from "../src/brain/index.js";
import { LocalBrain } from "../src/brain/local.js";
import { Client } from "./client.js";
import { isGuidedRoute, serveTracked } from "./journey-coverage.js";

// The guided journey (src/demo/journey.ts, public/journey.js): its place lives in the visitor's workspace on the
// server, steps tick from what the visitor really does, and nothing about it moves money.

let db: Db;
let fake: FakePayPal;
let srv: Awaited<ReturnType<typeof serveTracked>>;
let n = 0;
const ip = () => ({ "x-forwarded-for": `198.51.100.${++n}` });

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  setBrain(new LocalBrain());
  const sc = await svc.createMerchant({ name: "Ember & Oak Coffee Club", tagline: "Beans monthly", currency: "USD" });
  await svc.createPlans(sc.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  await svc.approveRules(sc.id, (await svc.previewRules("One skip per quarter. Pause up to 2 months. At most 15% off for 3 months.")).value, "journey rules");
  await ensureShowcase(db);
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  await srv.close();
  setPayPalFactory(null);
});

const journey = async (c: Client, lang = "") => (await c.get(`/ui/journey${lang ? `?lang=${lang}` : ""}`)).json;
const start = async (c: Client, as: string) => (await c.req("POST", "/ui/journey", { json: { action: "start", as }, headers: ip() })).json;
const stepOf = (j: any, id: string) => j.steps.find((s: any) => s.id === id);

describe("the guided journey", () => {
  it("is off until started, and starting makes the visitor's own demo shop", async () => {
    const c = new Client(srv.base);
    expect((await journey(c)).on).toBe(false);
    const r = await c.req("POST", "/ui/journey", { json: { action: "start", as: "owner" }, headers: ip() });
    expect(r.status).toBe(200);
    expect(String(r.headers.get("set-cookie"))).toMatch(/kept_journey=1/);
    const j = r.json;
    expect(j.on).toBe(true);
    expect(j.i).toBe(0);
    expect(j.n).toBe(STEPS.length);
    expect(j.steps[0].role).toBe("owner");
    expect(j.steps[0].who).toBe("You are the owner of Ember & Oak Coffee Club");
    // The member is a labelled sample (no pool in this test), so steps that change PayPal say so.
    expect(j.member.real).toBe(false);
    expect(j.member.ref).toBeTruthy();
    expect(stepOf(j, "card").href).toBe(`/manage/${j.member.ref}`);
    expect(new RegExp(stepOf(j, "card").match).test(`/manage/${j.member.ref}`)).toBe(true);
    expect(stepOf(j, "change").sample).toMatch(/labelled sample member.*nothing reaches PayPal/);
    expect(stepOf(j, "card").sample).toBeNull();
    // Same place for the same workspace on the next read; a stranger has none.
    expect((await journey(c)).i).toBe(0);
    expect((await journey(new Client(srv.base))).on).toBe(false);
  });

  it("goes forward and back on the server, and stops cleanly", async () => {
    const c = new Client(srv.base);
    await start(c, "owner");
    const a = (await c.postJson("/ui/journey", { action: "go", i: 3 })).json;
    expect(a.i).toBe(3);
    expect(a.steps[3].id).toBe("rules");
    expect((await journey(c)).i).toBe(3);
    expect((await c.postJson("/ui/journey", { action: "go", i: 999 })).json.i).toBe(STEPS.length - 1);
    expect((await c.postJson("/ui/journey", { action: "go", i: -4 })).json.i).toBe(0);
    expect((await c.postJson("/ui/journey", { action: "go", i: "x" })).status).toBe(400);
    const stop = await c.postJson("/ui/journey", { action: "stop" });
    expect(stop.json.on).toBe(false);
    expect(String(stop.headers.get("set-cookie"))).toMatch(/kept_journey=;/);
    expect((await journey(c)).on).toBe(false);
  });

  it("starts at the member, or at the member's AI assistant", async () => {
    expect((await start(new Client(srv.base), "member")).i).toBe(START.member);
    expect((await start(new Client(srv.base), "assistant")).i).toBe(START.assistant);
    expect(STEPS[START.member].role).toBe("member");
    expect(STEPS[START.assistant].role).toBe("assistant");
    expect((await start(new Client(srv.base), "nonsense")).i).toBe(0);
  });

  it("ticks a step from what the visitor really does: the held approval, the member's own change", async () => {
    const c = new Client(srv.base);
    const st = (await c.req("POST", "/demo/start", { json: {}, headers: ip() })).json;
    await waitForClaims();
    // A real (fake-PayPal) member, so the journey follows them instead of a sample.
    const shop = (await c.get(`/ui/shop/${st.shop.slug}`)).json;
    const sub = (await c.postJson(`/ui/shop/${st.shop.slug}/subscribe`, { plan_id: shop.plans[0].id, name: "Rin Real", email: "rin@example.com", key: "jr1" })).json;
    fake.approve((await db.query<any>("SELECT paypal_subscription_id AS pp FROM subscribers WHERE ref = $1", [sub.ref])).rows[0].pp);
    await svc.syncSubscription(sub.ref);
    let j = await start(c, "owner");
    expect(j.member).toMatchObject({ ref: sub.ref, first: "Rin", real: true });
    expect(stepOf(j, "change").sample).toBeNull();
    expect(stepOf(j, "members").body).toMatch(/Rin is a real PayPal sandbox subscription/);
    expect(stepOf(j, "held").done).toBe(false);

    const today = (await c.get("/ui/owner/today")).json;
    expect(today.approvals.length).toBeGreaterThan(0);
    expect((await c.postJson(`/ui/owner/approvals/${today.approvals[0].id}/decline`, {})).status).toBe(200);
    j = await journey(c);
    expect(stepOf(j, "held").done).toBe(true);

    expect(stepOf(j, "change").done).toBe(false);
    expect((await c.postJson(`/ui/manage/${sub.ref}/skip`, { key: "jr-skip" })).status).toBe(200);
    j = await journey(c);
    expect(stepOf(j, "change").done).toBe(true);
    // The journey keeps following the same member after the change.
    expect(j.member.ref).toBe(sub.ref);
  });

  it("the card's buttons follow the visitor's language, and say the steps are in English", async () => {
    const c = new Client(srv.base);
    await start(c, "owner");
    const en = await journey(c);
    expect(en.words.next).toBe("Next");
    expect(en.words.note).toBe("");
    const pt = await journey(c, "pt-BR");
    expect(pt.words.next).toBe("Próximo");
    expect(pt.words.note).toMatch(/inglês/);
    expect(pt.steps[0].title).toBe(en.steps[0].title);
    expect(Object.keys((await journey(c, "hi-IN")).words).sort()).toEqual(Object.keys(en.words).sort());
  });

  it("every step names where it is; every why names a source with a link", () => {
    for (const s of STEPS) {
      expect(s.path.startsWith("/")).toBe(true);
      expect(() => new RegExp(s.match.replace("{member}", "ref_x"))).not.toThrow();
      if (s.why) {
        expect(s.why.url).toMatch(/^https:\/\//);
        expect(s.why.src.length).toBeGreaterThan(3);
        expect(s.why.fact).toMatch(/\d/);
      }
    }
    expect(new Set(STEPS.map((s) => s.id)).size).toBe(STEPS.length);
    expect(new Set(STEPS.map((s) => s.role))).toEqual(new Set(["owner", "member", "assistant", "proof"]));
  });

  it("every page loads the card's script; the server pages it visits have its targets", async () => {
    const c = new Client(srv.base);
    await start(c, "owner");
    const guard = await c.get(`/dashboard/guard?text=${encodeURIComponent("Show three retention offers before cancel.")}`);
    expect(guard.text).toContain("/static/journey.js");
    expect(guard.text).toContain('id="policy"');
    const safety = await c.get("/dashboard/safety");
    expect(safety.text).toContain('id="check"');
    const agents = await c.get("/agents");
    const slug = (await c.get("/ui/session")).json.demoShop;
    expect(agents.text).toContain(`/s/${slug}/mcp`);
    expect(stepOf(await journey(c), "byo").done).toBe(true);
    expect(stepOf(await journey(c), "rules").done).toBe(true);
    const js = await c.get("/static/journey.js");
    expect(js.status).toBe(200);
    expect(js.text).toContain("window.keptJourney");
  });

  it("used both journey routes with no server error", () => {
    expect(srv.missed((r) => !isGuidedRoute(r))).toEqual([]);
  });
});
