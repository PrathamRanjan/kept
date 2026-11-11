import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { setProviderFetch, structured, requestBody } from "../src/ai/provider.js";
import { ModelUnavailable, OpenAIBrain } from "../src/brain/openai.js";
import { setBrain } from "../src/brain/index.js";
import { LocalBrain } from "../src/brain/local.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";
import { plansFor, subscriberByRef } from "../src/store.js";
import { createApp } from "../src/app.js";
import { codeLikeTokens, shopFacts } from "../src/ask/facts.js";
import type { AddressInfo } from "node:net";

// Spec A5.1 / A5.4 / A5.5 / A11: the model chain, one JSON repair, the backup model, and the honest failure
// state when nothing answers. The OpenAI endpoint is stubbed; every request body is the real one.
type Mode = "ok" | "broken_json_then_ok" | "primary_down" | "all_down" | "code_primary" | "code_all";
let mode: Mode = "ok";
const seen: { model: string; schema: string; repair: boolean }[] = [];

const reply = (model: string, payload: unknown, raw?: string) =>
  new Response(JSON.stringify({ model, status: "completed", usage: { input_tokens: 10, output_tokens: 5 }, output: [{ type: "message", content: [{ type: "output_text", text: raw ?? JSON.stringify(payload) }] }] }), { status: 200, headers: { "content-type": "application/json" } });

function answerFor(schema: string): unknown {
  if (schema === "cancel_reason") return { category: "price", confidence: 0.9 };
  if (schema === "offer_message") return { message: "We'd love to keep you, and this might help. If you'd rather cancel, saying no cancels straight away." };
  if (schema === "owner_answer") return { answer: "Most cancels this month were about price." };
  return {};
}

const stub = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  // The honest exchange at cancel (Decisions): a calm member with no complaint, unless every model is down.
  if (String(_url).endsWith("/v1/decisions")) {
    if (mode === "all_down") return new Response('{"error":{"message":"model not available"}}', { status: 400 });
    return new Response(JSON.stringify({ model: "gpt-6-luna", answers: body.questions.map((q: any) => (q.type === "choice" ? { type: "choice", name: q.name, choice: "too_expensive", probabilities: [], confidence: 0.9 } : { type: "predicate", name: q.name, probability: 0.02 })), usage: { input_tokens: 40 } }), { status: 200 });
  }
  const schema = body.text.format.name as string;
  const repair = String(body.instructions).startsWith("Return valid JSON");
  seen.push({ model: body.model, schema, repair });
  if (mode === "all_down") return new Response('{"error":{"message":"model not available"}}', { status: 400 });
  if (mode === "primary_down" && body.model === config.ai.models.read) return new Response('{"error":{"message":"model not available"}}', { status: 400 });
  if (mode === "primary_down" && body.model === config.ai.models.classify) return new Response('{"error":{"message":"model not available"}}', { status: 400 });
  if (schema === "owner_answer" && (mode === "code_all" || (mode === "code_primary" && body.model === config.ai.models.read))) return reply(body.model, { answer: "You have 0 sample rows (sampleRows: 0) and `mrr` is 12." });
  if (mode === "broken_json_then_ok" && !repair) return reply(body.model, null, '{"answer": "Most cancels were about price."');
  return reply(body.model, answerFor(schema));
}) as unknown as typeof fetch;

let db: Db;
let fake: FakePayPal;
let m: any;
const saved = { provider: config.ai.provider, key: config.ai.openaiKey, brain: config.brain };

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  fake = new FakePayPal();
  setPayPalFactory(() => fake);
  m = await svc.createMerchant({ name: "Model Test Roasters", currency: "USD" });
  setBrain(new LocalBrain());
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly\nHalf bag (Lite) $12 monthly", "USD")).value);
  const rules = "One skip per quarter. Pause up to 2 months. Switch to the Lite plan. At most 15% off for 3 months. One offer per year.";
  await svc.approveRules(m.id, (await svc.previewRules(rules)).value, rules);
  (config.ai as any).provider = "openai";
  (config.ai as any).openaiKey = "sk-test-not-a-real-key";
  (config as any).brain = "openai";
  setProviderFetch(stub);
  setBrain(new OpenAIBrain());
});
beforeEach(() => {
  mode = "ok";
  seen.length = 0;
});
afterAll(async () => {
  (config.ai as any).provider = saved.provider;
  (config.ai as any).openaiKey = saved.key;
  (config as any).brain = saved.brain;
  setProviderFetch(null);
  setBrain(null);
  setPayPalFactory(null);
  await db.close();
});

async function member(name: string) {
  const plan = (await plansFor(db, m.id)).find((p) => p.kind === "regular")!;
  const x = await svc.startSubscription(m, plan.id, { name }, { kind: "web" });
  fake.approve(x.paypalSubscriptionId!);
  await svc.syncSubscription(x.ref);
  // Old enough for every offer the rules allow.
  await db.query("UPDATE subscribers SET started_at = now() - interval '200 days' WHERE ref = $1", [x.ref]);
  return x.ref;
}

describe("model chain", () => {
  it("sends the read model with low reasoning effort and a 4000-token floor", () => {
    const b = requestBody(config.ai.models.read, { purpose: "owner_answer", tier: "read", system: "s", parts: [{ type: "text", text: "q" }], schemaName: "x", schema: {}, maxOutputTokens: 100 }, {});
    expect(b.model).toBe("gpt-6.1-sol");
    expect(b.reasoning).toEqual({ effort: "low" });
    expect(b.max_output_tokens).toBe(4000);
  });

  it("answers from the primary model and says which model it was", async () => {
    const r = await svc.askOwnerWithSource(m, "Why are people cancelling?");
    expect(r.answer).toMatch(/price/);
    expect(r.by).toBe("model");
    expect(r.model).toBe("gpt-6.1-sol");
  });

  it("repairs broken JSON once on the same model", async () => {
    mode = "broken_json_then_ok";
    const r = await svc.askOwnerWithSource(m, "Why are people cancelling?");
    expect(r.answer).toMatch(/price/);
    expect(seen.map((s) => [s.model, s.repair])).toEqual([["gpt-6.1-sol", false], ["gpt-6.1-sol", true]]);
    const row = (await db.query<any>("SELECT via FROM ai_calls WHERE purpose = 'owner_answer' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(row.via).toBe("primary+repair");
  });

  it("falls back to the backup model and labels it", async () => {
    mode = "primary_down";
    const r = await svc.askOwnerWithSource(m, "Why are people cancelling?");
    expect(r.by).toBe("backup");
    expect(r.model).toBe("gpt-6-sol");
  });

  it("when both models fail, Ask shows a plain sentence with a 503, never a rules answer", async () => {
    mode = "all_down";
    await expect(svc.askOwner(m, "Why are people cancelling?")).rejects.toBeInstanceOf(ModelUnavailable);
    const app = createApp();
    const srv = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const login = await fetch(`${base}/login/token`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${encodeURIComponent(m.owner_token)}` });
      const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
      const res = await fetch(`${base}/ui/owner/ask`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", cookie }, body: JSON.stringify({ question: "Why are people cancelling?" }) });
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.message).toBe("I couldn't answer that just now. Try again in a moment.");
      expect(JSON.stringify(body)).not.toMatch(/OpenAI|400|model not available/);
    } finally {
      srv.close();
    }
  });

  it("no model configured: structured() refuses instead of inventing an answer", async () => {
    (config.ai as any).openaiKey = "";
    try {
      await expect(structured({ purpose: "eval", tier: "read", system: "s", parts: [{ type: "text", text: "q" }], schemaName: "x", schema: { type: "object", properties: { a: { type: "string" } } } })).rejects.toThrow(/OPENAI_API_KEY/);
    } finally {
      (config.ai as any).openaiKey = "sk-test-not-a-real-key";
    }
  });
});

describe("K3: Ask reads plain facts and refuses code in answers", () => {
  it("the model sees numbered plain-word facts, not the statistics object", async () => {
    let sent = "";
    setProviderFetch((async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.text.format.name === "owner_answer") sent = body.input[0].content[0].text;
      return (stub as any)(url, init);
    }) as unknown as typeof fetch);
    try {
      await svc.askOwnerWithSource(m, "Which members could my rules keep with an offer?");
    } finally {
      setProviderFetch(stub);
    }
    expect(sent).toMatch(/^Facts:\n1\. Shop: Model Test Roasters/);
    expect(sent).toMatch(/Members the rules allow an offer to today/);
    expect(sent).toMatch(/not on the plan's price/);
    expect(sent).not.toMatch(/sampleRows|revenueKept3|"mrr"/);
    const facts = await shopFacts(m, await svc.computeStats(m));
    expect(facts.flatMap((f) => codeLikeTokens(f))).toEqual([]);
  });

  it("flags backticks, camelCase and snake_case, but not brand names", () => {
    expect(codeLikeTokens("You have `mrr` and sampleRows and offers_made")).toEqual(["`", "sampleRows", "offers_made"]);
    expect(codeLikeTokens("Members pay through PayPal on an iPhone.")).toEqual([]);
  });

  it("an answer with code in it goes to the backup model", async () => {
    mode = "code_primary";
    const r = await svc.askOwnerWithSource(m, "Why are people cancelling?");
    expect(r.by).toBe("backup");
    expect(r.answer).not.toMatch(/sampleRows|`/);
    const bad = (await db.query<any>("SELECT error FROM ai_calls WHERE purpose = 'owner_answer' AND NOT ok ORDER BY id DESC LIMIT 1")).rows[0];
    expect(bad.error).toMatch(/code-like tokens: `, sampleRows/);
  });

  it("if every answer has code in it, the owner sees the failure sentence instead", async () => {
    mode = "code_all";
    await expect(svc.askOwner(m, "Why are people cancelling?")).rejects.toBeInstanceOf(ModelUnavailable);
  });
});

describe("cancel when the model is down", () => {
  it("an unreadable reason gets no offer, and the cancel goes through", async () => {
    const ref = await member("Unread Reason");
    mode = "all_down";
    const out = await svc.requestCancel(ref, { reason: "too expensive for me", hearOffer: true }, { kind: "web" });
    expect(out.status).not.toBe("offer_open");
    const s: any = await subscriberByRef(db, ref);
    expect(["CANCELLED", "cancel_pending"]).toContain(s.status === "CANCELLED" ? "CANCELLED" : s.kept_state);
    const ev = (await db.query<any>("SELECT summary FROM event_log WHERE subscriber_id = $1 AND type = 'offer.none'", [s.id])).rows;
    expect(ev.map((e) => e.summary).join(" ")).toMatch(/couldn't read the reason/);
    const step = (await db.query<any>("SELECT t.actor, t.result FROM agent_trace t JOIN agent_runs r ON r.id = t.run_id WHERE r.entity_id = $1 AND t.tool = 'classify_reason'", [s.id])).rows[0];
    expect(step.actor).toBe("code");
    expect(step.result.via).toBe("unread");
  });

  it("if only the offer wording fails, the offer uses Kept's template and is labelled code", async () => {
    const ref = await member("Template Wording");
    // Reason reading works; the wording call returns a message that breaks the number check.
    const wordingBroken = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.text?.format?.name === "offer_message") return reply(body.model, { message: "Take 99% off forever! If you'd rather cancel, say no." });
      return (stub as any)(url, init);
    }) as unknown as typeof fetch;
    setProviderFetch(wordingBroken);
    try {
      const out: any = await svc.requestCancel(ref, { reason: "too expensive for me", hearOffer: true }, { kind: "web" });
      expect(out.status).toBe("offer_open");
      expect(out.offer.worded_by).toBe("code");
      expect(out.offer.message).not.toMatch(/99%/);
      const s: any = await subscriberByRef(db, ref);
      const step = (await db.query<any>("SELECT t.actor, t.result FROM agent_trace t JOIN agent_runs r ON r.id = t.run_id WHERE r.entity_id = $1 AND t.tool = 'word_offer'", [s.id])).rows[0];
      expect(step.actor).toBe("code");
      expect(step.result.by).toBe("code");
    } finally {
      setProviderFetch(stub);
    }
  });

  it("a readable reason with a working model gets a model-worded offer", async () => {
    const ref = await member("Model Wording");
    const out: any = await svc.requestCancel(ref, { reason: "too expensive for me", hearOffer: true }, { kind: "web" });
    expect(out.status).toBe("offer_open");
    expect(out.offer.worded_by).toBe("model");
  });
});
