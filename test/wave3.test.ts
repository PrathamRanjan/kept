import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { setProviderFetch } from "../src/ai/provider.js";
import { issueMandate, mandateById, refuses } from "../src/ask/mandate.js";
import { runAssistant } from "../src/ask/assistant.js";
import { setBrain } from "../src/brain/index.js";
import { LocalBrain } from "../src/brain/local.js";
import { OpenAIBrain } from "../src/brain/openai.js";
import { buildBuyerServer, STAMP_CARD_SKYBRIDGE, STAMP_CARD_URI } from "../src/mcp/tools.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import { DEFAULT_RULES, loosens, type Rules } from "../src/policy/rules.js";
import * as svc from "../src/service.js";
import { plansFor, subscriberByRef, type Merchant } from "../src/store.js";
import { processWebhook } from "../src/webhooks.js";
import { stubAgent } from "./agent-stub.js";
import { Client } from "./client.js";
import { isWave3Route, serveTracked } from "./journey-coverage.js";

// Wave 3 item 11 (spec B5 differentiators): what this loosens, the honest exchange, win-back, the cancel widget,
// the signed mandate, Kept as an app in chat clients, and the partial-refund remedy. PayPal is the fake; models
// are stubbed where they would run; every rule and every check is the production code.
let db: Db;
let fake: FakePayPal;
let m: Merchant;
let srv: Awaited<ReturnType<typeof serveTracked>>;
const saved = { brain: config.brain, provider: config.ai.provider, key: config.ai.openaiKey };

async function member(name: string, days = 5) {
  const plan = (await plansFor(db, m.id)).find((p) => p.kind === "regular")!;
  const x = await svc.startSubscription(m, plan.id, { name, email: `${name.split(" ")[0].toLowerCase()}@example.com` }, { kind: "web" });
  fake.approve(x.paypalSubscriptionId!);
  await svc.syncSubscription(x.ref);
  await db.query("UPDATE payments SET paid_at = now() - ($2 || ' days')::interval WHERE subscriber_id = (SELECT id FROM subscribers WHERE ref = $1)", [x.ref, String(days)]);
  return x;
}

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  setBrain(new LocalBrain());
  m = await svc.createMerchant({ name: "Wave Three Roasters", tagline: "Beans", currency: "USD" });
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  const text = "One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year. Refund the unused part of the month on cancel, up to $10.";
  await svc.approveRules(m.id, (await svc.previewRules(text)).value, text);
  srv = await serveTracked(createApp());
});
afterAll(async () => {
  (config as any).brain = saved.brain;
  (config.ai as any).provider = saved.provider;
  (config.ai as any).openaiKey = saved.key;
  setProviderFetch(null);
  await srv.close();
  setPayPalFactory(null);
});

describe("what this loosens (code, not the model)", () => {
  it("lists every way new rules give members more, and nothing when they tighten", () => {
    const before: Rules = { ...DEFAULT_RULES, pause: { enabled: true, maxCycles: 1 }, discount: { enabled: true, percent: 10, cycles: 1 }, maxDiscountPercent: 10, minTenureDaysForDiscount: 60 };
    const after: Rules = { ...before, pause: { enabled: true, maxCycles: 3 }, discount: { enabled: true, percent: 20, cycles: 1 }, maxDiscountPercent: 20, minTenureDaysForDiscount: 0, skip: { enabled: true, maxPerPeriod: 1, periodDays: 90 } };
    const l = loosens(before, after).join(" ");
    expect(l).toMatch(/Longer pauses: up to 1 cycle becomes up to 3 cycles/);
    expect(l).toMatch(/Bigger discount: 10% becomes 20%/);
    expect(l).toMatch(/newer members: 60 days/);
    expect(l).toMatch(/Skips are allowed now/);
    expect(loosens(after, before)).toEqual([]);
  });
  it("the preview compares against the approved rules", async () => {
    const p = await svc.previewRules("One skip per quarter. Pause up to 4 months. Switch to the Lite plan.", m.id);
    expect(p.comparedTo).toBe("your approved rules");
    expect(p.loosens.join(" ")).toMatch(/Longer pauses: up to 2 cycles becomes up to 4 cycles/);
    expect(p.loosens.join(" ")).not.toMatch(/discount/i);
  });
});

describe("the partial-refund remedy", () => {
  it("drafts the rule from plain words and says so", async () => {
    const p = await svc.previewRules("Refund the unused part of the month on cancel, up to $10.", m.id);
    expect(p.value.refundUnused).toEqual({ enabled: true, maxAmount: 10 });
    expect(p.description.join(" ")).toMatch(/refunded, up to 10.00/);
  });
  it("with a model, the model only says a refund rule is there; code reads the cap from the owner's words", async () => {
    (config.ai as any).provider = "openai";
    (config.ai as any).openaiKey = "sk-test";
    const seen: any[] = [];
    setProviderFetch((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(body);
      const out = { skip_enabled: false, skip_max_per_period: 1, skip_period_days: 90, pause_enabled: true, pause_max_cycles: 1, switch_to_lite: false, discount_enabled: false, discount_percent: 10, discount_cycles: 1, min_tenure_days: 0, offer_cooldown_days: 180, renewal_reminder_days: 7, unused_part_back: true, jurisdiction: "US_FEDERAL", understood: ["refund"], could_not_express: [] };
      return new Response(JSON.stringify({ model: body.model, status: "completed", usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(out) }] }] }), { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const b = new OpenAIBrain();
      const a = await b.draftRules("Pause one month. Refund the unused part of the month on cancel, up to $12.");
      expect(b.lastVia()).not.toBe("rules");
      expect(a.value.refundUnused).toEqual({ enabled: true, maxAmount: 12 });
      expect(JSON.stringify(seen[0].text?.format?.schema ?? seen[0])).not.toMatch(/refund_/);
      const c = await b.draftRules("Pause one month. Give the unused part back when people cancel.");
      expect(c.value.refundUnused.enabled).toBe(false);
      expect(c.warnings.join(" ")).toMatch(/say the most to refund/);
    } finally {
      (config.ai as any).provider = saved.provider;
      (config.ai as any).openaiKey = saved.key;
      setProviderFetch(null);
    }
  });
  it("on cancel, refunds the unused part of the cycle, capped by the rule, and reads PayPal back", async () => {
    const x = await member("Rae Refund", 6); // 6 days into a 30-ish day cycle: about 80% unused of $24, capped at $10
    const out: any = await svc.requestCancel(x.ref, { reason: "moving" }, { kind: "web" });
    expect(out.status).toBe("cancelled");
    expect(out.refund.cents).toBe(1000);
    expect(out.note).toMatch(/10\.00 USD for the unused part/);
    expect([...fake.refunds.values()].some((r) => r.amount === "10.00")).toBe(true);
    const ev = (await db.query<any>("SELECT summary FROM event_log WHERE type = 'refund.made' AND subscriber_id = (SELECT id FROM subscribers WHERE ref = $1)", [x.ref])).rows;
    expect(ev[0].summary).toMatch(/PayPal shows refund REFUND-.* completed/);
  });
  it("refunds less than the cap when less is unused, and nothing when the cycle is used up", async () => {
    const late = await member("Lu Late", 27);
    const a: any = await svc.requestCancel(late.ref, {}, { kind: "web" });
    expect(a.refund.cents).toBeGreaterThan(0);
    expect(a.refund.cents).toBeLessThan(400);
    const spent = await member("Sam Spent", 40);
    const b: any = await svc.requestCancel(spent.ref, {}, { kind: "web" });
    expect(b.refund).toBeNull();
    expect(b.status).toBe("cancelled");
  });
  it("a refund failure never undoes the cancel", async () => {
    const x = await member("Fay Fail", 3);
    const orig = fake.refundSale.bind(fake);
    fake.refundSale = async () => { throw new Error("PayPal said no"); };
    try {
      const out: any = await svc.requestCancel(x.ref, {}, { kind: "web" });
      expect(out.status).toBe("cancelled");
      expect(out.refund).toBeNull();
      expect((await subscriberByRef(db, x.ref))!.status).toBe("CANCELLED");
    } finally {
      fake.refundSale = orig;
    }
  });
});

describe("the honest exchange at cancel", () => {
  const decisions = (p: Record<string, number>, choice = "too_expensive") => {
    (config as any).brain = "openai";
    (config.ai as any).provider = "openai";
    (config.ai as any).openaiKey = "sk-test";
    setProviderFetch((async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (!String(url).endsWith("/v1/decisions")) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ model: "gpt-6-luna", answers: body.questions.map((q: any) => (q.type === "choice" ? { type: "choice", name: q.name, choice, probabilities: [], confidence: 0.9 } : { type: "predicate", name: q.name, probability: p[q.name] ?? 0.01 })), usage: { input_tokens: 50 } }), { status: 200 });
    }) as unknown as typeof fetch);
  };
  const reset = () => {
    (config as any).brain = saved.brain;
    (config.ai as any).provider = saved.provider;
    (config.ai as any).openaiKey = saved.key;
    setProviderFetch(null);
  };
  it("a quality complaint gets no offer and goes to the owner", async () => {
    const x = await member("Quinn Quality", 200);
    decisions({ is_quality_complaint: 0.92 });
    try {
      const out: any = await svc.requestCancel(x.ref, { reason: "the beans were stale, cancel", hearOffer: true }, { kind: "web" });
      expect(out.offer).toBeNull();
      expect(out.status).toBe("cancelled");
      const types = (await db.query<any>("SELECT type FROM event_log WHERE subscriber_id = (SELECT id FROM subscribers WHERE ref = $1)", [x.ref])).rows.map((r) => r.type);
      expect(types).toContain("complaint.quality");
    } finally {
      reset();
    }
  });
  it("a pressured member gets no offer", async () => {
    const x = await member("Pat Pressed", 200);
    decisions({ sounds_pressured: 0.8 });
    try {
      const out: any = await svc.requestCancel(x.ref, { reason: "please just let me go, I've asked three times", hearOffer: true }, { kind: "web" });
      expect(out.offer).toBeNull();
      const ev = (await db.query<any>("SELECT summary FROM event_log WHERE type = 'offer.none' AND subscriber_id = (SELECT id FROM subscribers WHERE ref = $1)", [x.ref])).rows;
      expect(ev[0].summary).toMatch(/sounded pressured/);
    } finally {
      reset();
    }
  });
  it("a calm price reason still gets the one offer the rules allow", async () => {
    const x = await member("Cal Calm", 200);
    decisions({});
    try {
      const out: any = await svc.requestCancel(x.ref, { reason: "it's a bit too expensive", hearOffer: true }, { kind: "web" });
      // The exchange let it through to the offer step (which may then make an offer, or hold it for the owner).
      const types = (await db.query<any>("SELECT type FROM event_log WHERE subscriber_id = (SELECT id FROM subscribers WHERE ref = $1)", [x.ref])).rows.map((r) => r.type);
      expect(types.some((t) => t === "offer.made" || t === "offer.held")).toBe(true);
      expect(out.status === "offer_open" || out.status === "cancelled").toBe(true);
    } finally {
      reset();
    }
  });
  it("when Decisions fails, no offer and the cancel goes ahead", async () => {
    const x = await member("Del Down", 200);
    decisions({});
    setProviderFetch((async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    try {
      const out: any = await svc.requestCancel(x.ref, { reason: "too expensive", hearOffer: true }, { kind: "web" });
      expect(out.offer).toBeNull();
      expect(out.status).toBe("cancelled");
    } finally {
      reset();
    }
  });
});

describe("win-back for a cancel made inside PayPal", () => {
  const webhook = async (id: string, ppId: string) => {
    await db.query("INSERT INTO webhook_events (id, event_type, resource_id, body, verified) VALUES ($1,'BILLING.SUBSCRIPTION.CANCELLED',$2,$3,true)", [id, ppId, JSON.stringify({ id, event_type: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: ppId } })]);
    await processWebhook(id);
  };
  it("sends one message with a link back, and never a second", async () => {
    const x = await member("Wyn Winback");
    fake.sub(x.paypalSubscriptionId!).status = "CANCELLED";
    await webhook("WH-wb-1", x.paypalSubscriptionId!);
    await webhook("WH-wb-2", x.paypalSubscriptionId!);
    const s = (await subscriberByRef(db, x.ref))!;
    expect(s.status).toBe("CANCELLED");
    const msgs = (await db.query<any>("SELECT body FROM channel_messages WHERE entity_id = $1 AND body LIKE '%cancelled your subscription in PayPal%'", [s.id])).rows;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].body).toMatch(/\/s\/wave-three-roasters\?rejoin=1/);
    expect(msgs[0].body).toMatch(/only message/);
    const types = (await db.query<any>("SELECT type FROM event_log WHERE subscriber_id = $1", [s.id])).rows.map((r) => r.type);
    expect(types.filter((t) => t === "winback.sent")).toHaveLength(1);
    expect(types).toContain("cancel.outside_kept");
  });
  it("sends nothing when Kept made the cancel", async () => {
    const x = await member("Kim Kept");
    await svc.requestCancel(x.ref, {}, { kind: "web" });
    await webhook("WH-wb-3", x.paypalSubscriptionId!);
    const s = (await subscriberByRef(db, x.ref))!;
    expect((await db.query("SELECT 1 FROM winbacks WHERE subscriber_id = $1", [s.id])).rows).toHaveLength(0);
  });
  it("one per email a year, even on a new subscription", async () => {
    const first = (await db.query<any>("SELECT subscriber_email FROM subscribers WHERE ref IN (SELECT ref FROM subscribers WHERE subscriber_name = 'Wyn Winback')")).rows[0].subscriber_email;
    const plan = (await plansFor(db, m.id)).find((p) => p.kind === "regular")!;
    const y = await svc.startSubscription(m, plan.id, { name: "Wyn Again", email: first }, { kind: "web" });
    fake.approve(y.paypalSubscriptionId!);
    await svc.syncSubscription(y.ref);
    fake.sub(y.paypalSubscriptionId!).status = "CANCELLED";
    expect((await svc.winBack((await subscriberByRef(db, y.ref))!.id)).sent).toBe(false);
  });
});

describe("the cancel widget", () => {
  it("serves one cross-origin script that opens the member page", async () => {
    const r = await fetch(`${srv.base}/widget.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/javascript/);
    expect(r.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const js = await r.text();
    expect(js).toMatch(/\/manage\//);
    expect(js).not.toMatch(/document\.cookie|localStorage|fetch\(/);
  });
});

describe("the signed mandate", () => {
  it("scope comes from the member's words; code refuses anything outside it; tampering shows", async () => {
    const x = await member("Mo Mandate");
    const s = (await subscriberByRef(db, x.ref))!;
    const a = await issueMandate({ merchantId: m.id, shopName: m.name, subscriberId: s.id, memberName: "Mo", agent: "test", message: "pause me for a month", pauseMaxCycles: 2 });
    expect(a.mandate.scope).not.toContain("cancel_subscription");
    expect(refuses(a.mandate, a.signature, "pause", { cycles: 1 })).toBeNull();
    expect(refuses(a.mandate, a.signature, "pause", { cycles: 3 })).toMatch(/over the mandate's limit/);
    expect(refuses(a.mandate, a.signature, "cancel_subscription")).toMatch(/outside this mandate/);
    expect(refuses({ ...a.mandate, scope: [...a.mandate.scope, "cancel_subscription"] }, a.signature, "cancel_subscription")).toMatch(/signature does not match/);
    expect(refuses(a.mandate, a.signature, "pause", {}, new Date(Date.now() + 16 * 60_000))).toMatch(/expired/);
    const b = await issueMandate({ merchantId: m.id, shopName: m.name, subscriberId: s.id, memberName: "Mo", agent: "test", message: "cancel it, I'm moving", pauseMaxCycles: 2 });
    expect(b.mandate.scope).toContain("cancel_subscription");
    const pub = (await new Client(srv.base).get(`/api/public/mandate/${a.mandate.id}`)).json;
    expect(pub.valid).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(x.ref);
    expect((await new Client(srv.base).get("/api/public/mandate/nope")).json.found).toBe(false);
  });
  it("an assistant that tries to cancel when the member only asked to pause is stopped by code", async () => {
    const x = await member("Ari Assist");
    const undo = stubAgent({ tool: "cancel_subscription", args: { hear_offer: false, reason: null }, text: "Done." });
    try {
      const r = await runAssistant(x.ref, "pause my coffee for a month");
      expect(r.steps.find((s) => s.name === "cancel_subscription")!.summary).toMatch(/refused by the mandate/);
      expect((await subscriberByRef(db, x.ref))!.status).toBe("ACTIVE");
      expect(r.mandate).toMatch(/^mdt_/);
      const pub = await new Client(srv.base).get(`/api/public/mandate/${r.mandate}`);
      expect(pub.json.found).toBe(true);
      expect(pub.text).not.toContain(x.ref);
      expect(r.steps[0].name).toBe("mandate");
    } finally {
      undo();
    }
  });
});

describe("Kept as an app inside chat clients (MCP Apps)", () => {
  it("get_subscription points at the stamp card; the resource is served; results carry structured content", async () => {
    const x = await member("Cy Chat");
    const server = buildBuyerServer(m, "chat-test");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const c = new McpClient({ name: "chat", version: "1" });
    await c.connect(b);
    const res = await c.listResources();
    const uris = res.resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining([STAMP_CARD_URI, STAMP_CARD_SKYBRIDGE]));
    expect(res.resources.find((r) => r.uri === STAMP_CARD_URI)!.mimeType).toBe("text/html;profile=mcp-app");
    const html = await c.readResource({ uri: STAMP_CARD_URI });
    expect((html.contents[0] as any).text).toMatch(/tools\/call/);
    const tools = await c.listTools();
    const gs = tools.tools.find((t) => t.name === "get_subscription")!;
    expect((gs._meta as any).ui.resourceUri).toBe(STAMP_CARD_URI);
    expect((gs._meta as any)["openai/outputTemplate"]).toBe(STAMP_CARD_SKYBRIDGE);
    const out: any = await c.callTool({ name: "get_subscription", arguments: { subscription_ref: x.ref } });
    expect(out.structuredContent.subscription_ref).toBe(x.ref);
    expect(out.structuredContent.paid_cycles).toBe(1);
    await c.close();
  });
});

describe("push-to-talk voice", () => {
  it("needs a member or owner, says plainly when there is no model, and never returns Kept's own key", async () => {
    const x = await member("Vi Voice");
    const c = new Client(srv.base);
    expect((await c.postJson("/ui/voice/session", {})).status).toBe(403);
    const none = await c.postJson("/ui/voice/session", { ref: x.ref });
    if (!saved.key || saved.provider !== "openai") {
      expect(none.status).toBe(503);
      expect(none.json.message).toMatch(/Typing works/);
    }
    (config.ai as any).provider = "openai";
    (config.ai as any).openaiKey = "sk-kept-own-key";
    let sent: any = null;
    setProviderFetch((async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ value: "ek_short_lived", expires_at: 1900000000, session: { model: "gpt-live-1" } }), { status: 200 });
    }) as unknown as typeof fetch);
    try {
      const r = await c.postJson("/ui/voice/session", { ref: x.ref });
      expect(r.status).toBe(200);
      expect(r.json.secret).toBe("ek_short_lived");
      expect(r.json.callsUrl).toMatch(/\/v1\/realtime\/calls\?model=gpt-live-1/);
      expect(r.text).not.toContain("sk-kept-own-key");
      expect(sent.url).toMatch(/\/v1\/realtime\/client_secrets$/);
      expect(sent.body.session.audio.input.turn_detection).toBeNull();
      expect(sent.body.expires_after.seconds).toBeLessThanOrEqual(120);
    } finally {
      (config.ai as any).provider = saved.provider;
      (config.ai as any).openaiKey = saved.key;
      setProviderFetch(null);
    }
  });
});

describe("route coverage", () => {
  it("every Wave 3 route was reached", () => {
    expect(srv.missed((r) => !isWave3Route(r))).toEqual([]);
  });
});
