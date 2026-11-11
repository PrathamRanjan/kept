import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { openDb, setDb, type Db } from "../src/db.js";
import { setProviderFetch } from "../src/ai/provider.js";
import { runAgent } from "../src/ai/agent.js";
import { askOwnerAgent, ownerTools } from "../src/ask/agent-ask.js";
import { callPayPalRead, READ_TOOLS, setPayPalMcp } from "../src/paypal/mcp.js";
import { setBrain } from "../src/brain/index.js";
import { LocalBrain } from "../src/brain/local.js";
import { setPayPalFactory } from "../src/paypal/index.js";
import { FakePayPal } from "../src/paypal/fake.js";
import * as svc from "../src/service.js";

// Spec A5.3: the agent loop with visible work. The model is stubbed; the loop, the tools and the checks are real.
let db: Db;
let m: any;
const saved = { provider: config.ai.provider, key: config.ai.openaiKey };
let script: { calls: { name: string; args: unknown }[][]; final: { text: string; facts: string[] }[] };
const bodies: any[] = [];

beforeAll(async () => {
  db = await openDb({ memory: true });
  setDb(db);
  setPayPalFactory(() => new FakePayPal());
  setBrain(new LocalBrain());
  m = await svc.createMerchant({ name: "Agent Test Roasters", currency: "USD" });
  await svc.createPlans(m.id, (await svc.previewPlans("Signature bag $24 monthly", "USD")).value);
  (config.ai as any).provider = "openai";
  (config.ai as any).openaiKey = "sk-test";
  setProviderFetch((async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const turn = body.input.filter((i: any) => i.type === "function_call").length ? Math.max(...body.input.filter((i: any) => i.type === "function_call").map((i: any) => Number(i.call_id.split("_")[1]))) + 1 : 0;
    const calls = script.calls[turn];
    if (calls && body.tools.length) return new Response(JSON.stringify({ model: body.model, status: "completed", usage: {}, output: calls.map((c, i) => ({ type: "function_call", call_id: `c_${turn}_${i}`, name: c.name, arguments: JSON.stringify(c.args) })) }));
    return new Response(JSON.stringify({ model: body.model, status: "completed", usage: {}, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ sentences: script.final }) }] }] }));
  }) as unknown as typeof fetch);
});
afterAll(async () => {
  setProviderFetch(null);
  setPayPalMcp(null);
  (config.ai as any).provider = saved.provider;
  (config.ai as any).openaiKey = saved.key;
  await db.close();
});

describe("structure", () => {
  it("every owner tool is read-only and no PayPal write tool is reachable", async () => {
    expect(ownerTools(m).every((t) => t.kind === "read")).toBe(true);
    expect(READ_TOOLS.every((t) => /^(show|get|list)_/.test(t))).toBe(true);
    for (const w of ["create_refund", "cancel_subscription", "update_subscription", "pay_order", "create_invoice", "send_invoice"]) await expect(callPayPalRead(w, {})).rejects.toThrow(/not a PayPal read tool/);
  });
});

describe("the loop", () => {
  it("runs two tools, records each step, and checks every citation", async () => {
    script = { calls: [[{ name: "members", args: { status: null, real_only: false } }, { name: "rules", args: {} }]], final: [{ text: "You have no members yet.", facts: ["F1"] }, { text: "A made-up claim.", facts: ["F99"] }] };
    const seen: string[] = [];
    const r = await askOwnerAgent(m, "How many members do I have?", (s) => seen.push(`${s.kind}:${s.name}`));
    expect(r.toolCalls).toBe(2);
    expect(seen).toEqual(expect.arrayContaining(["tool:members", "tool:rules", "answer:answer"]));
    expect(r.sentences[0].grounded).toBe(true);
    expect(r.sentences[1]).toMatchObject({ grounded: false, facts: [] });
    const trace = (await db.query<{ tool: string }>("SELECT tool FROM agent_trace WHERE run_id = $1 ORDER BY step", [r.runId])).rows.map((x) => x.tool);
    expect(trace).toEqual(["agent.tool.members", "agent.tool.rules", "agent.answer"]);
    expect(bodies.at(-1).model).toBe("gpt-6.1-sol");
  });
  it("PayPal's MCP server is asked with the subscription id from Kept's record, never one from the model", async () => {
    await db.query("INSERT INTO subscribers (id, merchant_id, ref, paypal_subscription_id, status, subscriber_name) VALUES ('sub_pp', $1, 'ref_pp', 'I-OWNEDBYSHOP1', 'ACTIVE', 'Ada Lovelace')", [m.id]);
    const asked: unknown[] = [];
    setPayPalMcp(async (tool, args) => {
      asked.push({ tool, args });
      return { id: args.subscription_id, status: "ACTIVE", billing_info: { failed_payments_count: 0, outstanding_balance: { value: "0.0", currency_code: "USD" } } };
    });
    script = { calls: [[{ name: "paypal_subscription", args: { member_name: "ada" } }]], final: [{ text: "PayPal shows Ada's subscription as active.", facts: ["F1"] }] };
    const r = await askOwnerAgent(m, "What does PayPal say about Ada?");
    expect(asked).toEqual([{ tool: "show_subscription_details", args: { subscription_id: "I-OWNEDBYSHOP1" } }]);
    expect(r.facts[0].text).toMatch(/PayPal says Ada Lovelace's subscription I-OWNEDBYSHOP1 is active/);
  });
  it("an answer with code-like words goes to the backup model, then fails honestly", async () => {
    script = { calls: [[{ name: "rules", args: {} }]], final: [{ text: "You have `sampleRows` 0.", facts: ["F1"] }] };
    await expect(askOwnerAgent(m, "How many?")).rejects.toMatchObject({ status: 503 });
    expect(bodies.slice(-2).map((b) => b.model)).toContain("gpt-6-sol");
  });
  it("stops after 8 turns", async () => {
    script = { calls: Array.from({ length: 20 }, () => [{ name: "rules", args: {} }]), final: [{ text: "Done.", facts: ["F1"] }] };
    const r = await runAgent({ purpose: "agent_ask", system: "x", question: "loop", tools: ownerTools(m), merchantId: m.id, actor: "model", subject: "loop test" });
    expect(r.toolCalls).toBeLessThanOrEqual(7);
  });
});
