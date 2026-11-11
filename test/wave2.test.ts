import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { ensureShowcase } from "../src/demo/workspaces.js";
import { TICKS } from "../src/demo/checklist.js";
import { latestNightly, runNightly } from "../src/eval/nightly.js";
import { waitForClaims } from "../src/web/demo.js";
import { setPayPalMcp } from "../src/paypal/mcp.js";
import * as svc from "../src/service.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { setBrain } from "../src/brain/index.js";
import { LocalBrain } from "../src/brain/local.js";
import { Client } from "./client.js";
import { stubAgent } from "./agent-stub.js";
import { isWave2Route, serveTracked } from "./journey-coverage.js";

// Wave 2 (spec items 8 and 9): the judge page's three paths tick themselves from what the server sees; the
// public proof, AI, PayPal, roles and accessibility pages read real records; the member's assistant and the
// owner's Ask stream their steps. Models are stubbed; the routes, ticks and records are real.

let db: Db;
let fake: FakePayPal;
let srv: Awaited<ReturnType<typeof serveTracked>>;
let restore: () => void = () => {};
const ip = { "x-forwarded-for": "203.0.113.77" };

const sse = (text: string) =>
  text.split("\n\n").filter(Boolean).map((b) => {
    const ev = /^event: (.*)$/m.exec(b)?.[1];
    const data = /^data: (.*)$/m.exec(b)?.[1];
    return { event: ev, data: data ? JSON.parse(data) : null };
  });

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  setBrain(new LocalBrain());
  setPayPalMcp(async (_tool, args: any) => ({ id: args.subscription_id, status: "ACTIVE" }));
  const sc = await svc.createMerchant({ name: "Ember & Oak Coffee Club", tagline: "Beans monthly", currency: "USD" });
  await svc.createPlans(sc.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  await svc.approveRules(sc.id, (await svc.previewRules("One skip per quarter. Pause up to 2 months.")).value, "wave2 rules");
  await ensureShowcase(db);
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  restore();
  setPayPalMcp(null);
  await srv.close();
  setPayPalFactory(null);
});

describe("item 8: the judge page", () => {
  it("before a workspace: no buttons, the paths and an honest accounts note", async () => {
    const j = (await new Client(srv.base).get("/api/public/judge")).json;
    expect(j.workspace).toBeNull();
    expect(j.paths.map((p: any) => p.id)).toEqual(["assistant", "cancel", "owner"]);
    expect(j.paths.find((p: any) => p.id === "owner").paypalLogin).toBe(false);
    expect(j.accounts.every((a: any) => a.email === null || typeof a.email === "string")).toBe(true);
    if (!process.env.JUDGE_BUYER_EMAIL) expect(j.accounts.map((a: any) => a.note).join(" ")).toMatch(/not set|none/i);
    expect(j.liveTable.length).toBeGreaterThan(3);
  });

  it("each step ticks itself when the server sees it happen, once, in the visitor's workspace only", async () => {
    const v = new Client(srv.base);
    const st = (await v.req("POST", "/demo/start", { json: {}, headers: ip })).json;
    await waitForClaims();
    const shop = (await v.get(`/ui/shop/${st.shop.slug}`)).json;
    const sub = (await v.postJson(`/ui/shop/${st.shop.slug}/subscribe`, { plan_id: shop.plans[0].id, name: "Jo Judge", email: "jo@example.com", key: "jk" })).json;
    const pp = (await db.query<any>("SELECT paypal_subscription_id AS pp FROM subscribers WHERE ref = $1", [sub.ref])).rows[0].pp;
    fake.approve(pp);
    await svc.syncSubscription(sub.ref);
    const ticks = async () => ((await db.query<any>("SELECT checklist FROM workspaces WHERE id = $1", [st.workspace.id])).rows[0].checklist?.ticks ?? {}) as Record<string, string>;

    let j = (await v.get("/api/public/judge")).json;
    expect(j.workspace.id).toBe(st.workspace.id);
    expect(j.paths.flatMap((p: any) => p.steps).every((s: any) => !s.done)).toBe(true);
    expect(j.paths.find((p: any) => p.id === "owner").steps.every((s: any) => s.button?.href)).toBe(true);

    expect((await v.get(`/ui/manage/${sub.ref}`)).status).toBe(200);
    expect(Object.keys(await ticks())).toContain("member_opened");
    const first = (await ticks()).member_opened;
    await v.get(`/ui/manage/${sub.ref}`);
    expect((await ticks()).member_opened).toBe(first); // first time only

    // Owner path: Ask (streamed), the scam check, a refused rule, the proof page.
    restore = stubAgent({ tool: "shop_overview" });
    const ask = sse((await v.postJson("/ui/owner/ask/stream", { question: "How is my shop doing?" })).text);
    expect(ask.filter((e) => e.event === "step").map((e) => e.data.kind)).toEqual(expect.arrayContaining(["model", "tool", "answer"]));
    expect(ask.at(-1)!.event).toBe("answer");
    expect(ask.at(-1)!.data.sentences[0].grounded).toBe(true);
    expect((await v.postJson("/dashboard/safety/scan", { text: "Hi, we've moved banks. Please send this month's payment to new-account@gmail.com" })).json.level).toBe("hold");
    const refused = await svc.previewRules("make it hard to cancel", (await db.query<any>("SELECT tenant_id FROM workspaces WHERE id = $1", [st.workspace.id])).rows[0].tenant_id);
    expect(refused.warnings.join(" ")).toMatch(/ROSCA/);
    const proof = (await v.get("/api/public/proof")).json;
    expect(Object.keys(await ticks())).toEqual(expect.arrayContaining(["owner_asked", "scam_checked", "rule_refused", "proof_opened"]));
    j = (await v.get("/api/public/judge")).json;
    const owner = j.paths.find((p: any) => p.id === "owner");
    expect(owner.steps.every((s: any) => s.done && s.at)).toBe(true);

    // Assistant path: the member's assistant pauses through Kept's MCP tools, and code reads PayPal back.
    restore();
    restore = stubAgent({ tool: "pause", args: { cycles: 1 }, text: "Paused for one cycle." });
    const as = sse((await v.postJson(`/ui/manage/${sub.ref}/assistant/stream`, { message: "pause me for a month" })).text);
    const names = as.filter((e) => e.event === "step").map((e) => e.data.name);
    expect(names).toEqual(expect.arrayContaining(["pause", "get_subscription"]));
    expect(as.at(-1)!.event).toBe("answer");
    expect(as.at(-1)!.data.readBack).toMatch(/SUSPENDED|paused/i);
    expect(fake.sub(pp).status).toBe("SUSPENDED");
    expect(Object.keys(await ticks())).toEqual(expect.arrayContaining(["assistant_acted", "assistant_readback"]));
    expect((await v.postJson(`/ui/manage/${sub.ref}/assistant/stream`, { message: "" })).status).toBe(422);
    expect((await v.postJson(`/ui/manage/nope/assistant/stream`, { message: "hi" })).status).toBe(404);
    restore();
    restore = () => {};

    // Every tick key the server writes is one the judge page knows.
    for (const k of Object.keys(await ticks())) expect(TICKS as readonly string[]).toContain(k);
    expect(proof.suites.length).toBeGreaterThan(0);
  });

  it("ticks never land on the showcase or on another visitor's workspace", async () => {
    const other = new Client(srv.base);
    const st = (await other.req("POST", "/demo/start", { json: {}, headers: { "x-forwarded-for": "203.0.113.78" } })).json;
    const t = (await db.query<any>("SELECT checklist FROM workspaces WHERE id = $1", [st.workspace.id])).rows[0].checklist?.ticks ?? {};
    expect(Object.keys(t)).toEqual([]);
    const sc = (await db.query<any>("SELECT checklist FROM workspaces WHERE kind = 'showcase'")).rows[0];
    expect(Object.keys(sc?.checklist?.ticks ?? {})).toEqual([]);
  });
});

describe("item 9: proof, AI, PayPal, roles and accessibility pages", () => {
  it("proof reads every result file with cases and says what is not measured", async () => {
    const p = (await new Client(srv.base).get("/api/public/proof")).json;
    for (const s of p.suites) {
      expect(s.file).toMatch(/^eval\//);
      const list = s.cases ?? s.results;
      expect(Array.isArray(list) && list.length > 0).toBe(true);
    }
    expect(p.thresholds.length).toBeGreaterThan(0);
    expect(p.notMeasured.length).toBeGreaterThan(0);
  });

  it("the daily showcase run with no model records failures, never passes", async () => {
    const r = await runNightly("script");
    expect(r.total).toBeGreaterThan(5);
    expect(r.cases.find((c) => c.id === "ask")!.pass).toBe(false);
    expect(r.cases.filter((c) => c.id.startsWith("r-")).every((c) => !c.pass)).toBe(true); // rules labels are not model labels
    expect(r.cases.find((c) => c.id === "scam-k01")!.pass).toBe(false); // no Decisions: never shown clear
    const latest = await latestNightly();
    expect(latest.id).toBe(r.id);
    expect((await new Client(srv.base).get("/api/public/proof")).json.nightly.id).toBe(r.id);
  });

  it("the daily showcase run with a model passes where code says it should", async () => {
    const undo = stubAgent({ tool: "members", args: { status: null, real_only: true }, text: "No real members yet." });
    try {
      const r = await runNightly("script");
      const byId = Object.fromEntries(r.cases.map((c) => [c.id, c]));
      expect(byId["scam-nov10"].pass).toBe(true);
      expect(byId["scam-k01"].pass).toBe(true);
    } finally {
      undo();
    }
  });

  it("AI, PayPal, roles and accessibility read real records and say so when empty", async () => {
    const c = new Client(srv.base);
    const ai = (await c.get("/api/public/ai")).json;
    expect(Array.isArray(ai.calls)).toBe(true);
    for (const x of ai.calls) expect(typeof x.purpose).toBe("string");
    expect(ai.calls.some((x: any) => /^decide_|agent_/.test(x.purpose))).toBe(true);
    const pp = (await c.get("/api/public/paypal")).json;
    expect(pp.apis.length).toBeGreaterThan(4);
    const roles = (await c.get("/api/public/roles")).json;
    expect(JSON.stringify(roles)).toMatch(/No model can call PayPal|cannot/i);
    const a11y = (await c.get("/api/public/accessibility")).json;
    expect(a11y.checks.length).toBeGreaterThan(0);
    expect(a11y.notTested.length).toBeGreaterThan(0);
  });

  it("serves each public page with its own title", async () => {
    const c = new Client(srv.base);
    for (const p of ["/proof", "/ai", "/paypal", "/who-can-move-money", "/accessibility"]) {
      const r = await c.get(p);
      if (r.status === 200) expect(r.text).toMatch(/<title>/);
      else expect(r.status).toBe(404); // the web build is absent in this checkout
    }
  });

  it("every Wave 2 route was reached and none failed", () => {
    expect(srv.missed((r) => !isWave2Route(r))).toEqual([]);
  });
});

void config;
