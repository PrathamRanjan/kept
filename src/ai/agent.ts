/**
 * Spec A5.3: an agent loop with visible work. The Responses API with function tools, in a loop the server
 * controls (at most 8 model turns, 45 seconds), on gpt-6.1-sol. Every tool call is a step in agent_trace and is
 * handed to `onStep` so the browser can show it as it happens (server-sent events, the "AI work rail").
 *
 * Tools are plain functions the caller supplies. Each tool returns facts, each with an id ("F3"); the final
 * answer is a list of sentences, each citing the fact ids it rests on, and code checks every citation exists.
 * Tool results that carry other people's words are wrapped as data. No tool given to this loop moves money:
 * the owner's tools are read-only; the member's assistant (src/ask/assistant.ts) acts only on that member's own
 * subscription, through the same gate as the member page. The structural test checks the tool lists.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { newId } from "../lib/ids.js";
import { Run } from "../trace.js";
import { audit, estimateCost, hasOpenAI, NoModelError, providerFetch } from "./provider.js";

export interface Fact {
  id: string;
  text: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON schema for the arguments (strict mode: every property required, nullable where optional). */
  parameters: Record<string, unknown>;
  /** "read" never changes anything; "member_action" changes only the member's own subscription through the gate. */
  kind: "read" | "member_action";
  /** Who answers, for the rail: Kept's own records, PayPal's MCP server, or a Kept action. */
  source: "kept" | "paypal_mcp" | "kept_action";
  /** `after` are steps code took on its own once the tool ran (a PayPal read-back), shown after the tool's step. */
  run: (args: any, ctx: { fact: (text: string) => Fact }) => Promise<{ summary: string; facts?: Fact[]; data?: unknown; after?: Omit<RailStep, "n">[] }>;
}

export interface RailStep {
  n: number;
  kind: "tool" | "model" | "answer" | "error";
  name: string;
  source?: AgentTool["source"];
  args?: string;
  summary: string;
  ms: number;
  facts?: Fact[];
}

export interface Sentence {
  text: string;
  facts: string[];
  /** Code's check: every cited id was returned by a tool in this run. */
  grounded: boolean;
}

export interface AgentResult {
  sentences: Sentence[];
  answer: string;
  facts: Fact[];
  steps: RailStep[];
  model: string;
  runId: string;
  toolCalls: number;
  ms: number;
}

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    sentences: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" }, facts: { type: "array", items: { type: "string" } } }, required: ["text", "facts"], additionalProperties: false },
    },
  },
  required: ["sentences"],
  additionalProperties: false,
};

const MAX_TURNS = 8;
const DEADLINE_MS = 45_000;

async function post(body: unknown): Promise<any> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await providerFetch()(`${config.ai.openaiBaseUrl}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    last = `OpenAI ${res.status}: ${text.slice(0, 200)}`;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  throw new Error(last);
}

const short = (v: unknown, n = 120) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

export async function runAgent(opts: {
  purpose: "agent_ask" | "agent_assistant";
  system: string;
  question: string;
  tools: AgentTool[];
  merchantId: string;
  actor: "model" | "agent";
  subject: string;
  model?: string;
  onStep?: (s: RailStep) => void;
  q?: Queryable;
}): Promise<AgentResult> {
  if (!hasOpenAI()) throw new NoModelError("AI_PROVIDER is not openai or OPENAI_API_KEY is unset");
  const db = opts.q ?? (await getDb());
  const runId = newId("run");
  await db.query("INSERT INTO agent_runs (id, actor, merchant_id, subject) VALUES ($1,$2,$3,$4)", [runId, opts.actor, opts.merchantId, opts.subject.slice(0, 200)]);
  const run = new Run(runId, db);
  const t0 = Date.now();
  const model = opts.model ?? config.ai.models.agent;
  const steps: RailStep[] = [];
  const facts: Fact[] = [];
  const emit = (s: Omit<RailStep, "n">) => {
    const step = { ...s, n: steps.length + 1 };
    steps.push(step);
    opts.onStep?.(step);
    return step;
  };
  const fact = (text: string): Fact => {
    const f = { id: `F${facts.length + 1}`, text };
    facts.push(f);
    return f;
  };
  const tools = opts.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true }));
  const input: any[] = [{ role: "user", content: [{ type: "input_text", text: opts.question.slice(0, 600) }] }];
  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;
  let usedModel = model;
  const finish = async (status: string) => {
    await db.query("UPDATE agent_runs SET status = $2, ended_at = now() WHERE id = $1", [runId, status]);
    await audit({ purpose: opts.purpose, model: usedModel, via: "primary", inputHash: createHash("sha256").update(opts.system + opts.question).digest("hex"), outputHash: "", tokensIn, tokensOut, costUsd: estimateCost(usedModel, tokensIn, tokensOut), latencyMs: Date.now() - t0, ok: status === "done", error: status === "done" ? null : status, output: { steps: steps.map((s) => ({ name: s.name, summary: s.summary, ms: s.ms })) }, runId, inputSummary: opts.question.slice(0, 200), merchantId: opts.merchantId });
  };

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (Date.now() - t0 > DEADLINE_MS) throw new Error("The agent ran out of time (45 seconds)");
      const last = turn === MAX_TURNS - 1;
      const m0 = Date.now();
      const data = await post({
        model,
        instructions: opts.system,
        input,
        tools: last ? [] : tools,
        text: { format: { type: "json_schema", name: "cited_answer", strict: true, schema: ANSWER_SCHEMA } },
        reasoning: { effort: config.ai.effort },
        max_output_tokens: Math.max(4000, config.ai.minOutputTokens),
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      usedModel = data.model ?? model;
      tokensIn += data.usage?.input_tokens ?? 0;
      tokensOut += data.usage?.output_tokens ?? 0;
      const out: any[] = data.output ?? [];
      const calls = out.filter((o) => o.type === "function_call");
      input.push(...out);
      if (!calls.length) {
        const msg = out.find((o) => o.type === "message");
        const text = msg?.content?.find((c: any) => c.type === "output_text")?.text;
        if (!text) throw new Error(data.status === "incomplete" ? "The model stopped early" : "The model returned no answer");
        const parsed = JSON.parse(text) as { sentences: { text: string; facts: string[] }[] };
        const ids = new Set(facts.map((f) => f.id));
        const sentences: Sentence[] = parsed.sentences.filter((s) => s.text.trim()).map((s) => ({ text: s.text.trim(), facts: s.facts.filter((f) => ids.has(f)), grounded: s.facts.length > 0 && s.facts.every((f) => ids.has(f)) }));
        await run.step({ actor: "model", tool: "agent.answer", args: { model: usedModel }, result: { sentences: sentences.length, grounded: sentences.filter((s) => s.grounded).length }, duration_ms: Date.now() - m0 });
        emit({ kind: "answer", name: "answer", summary: `${sentences.length} sentence${sentences.length === 1 ? "" : "s"}, ${sentences.filter((s) => s.grounded).length} with a cited fact`, ms: Date.now() - m0 });
        await finish("done");
        return { sentences, answer: sentences.map((s) => s.text).join(" "), facts, steps, model: usedModel, runId, toolCalls, ms: Date.now() - t0 };
      }
      emit({ kind: "model", name: usedModel, summary: `asked for ${calls.map((c) => c.name).join(", ")}`, ms: Date.now() - m0 });
      for (const c of calls) {
        const tool = opts.tools.find((t) => t.name === c.name);
        const s0 = Date.now();
        let output: unknown;
        let summary: string;
        let got: Fact[] = [];
        let after: Omit<RailStep, "n">[] = [];
        try {
          if (!tool) throw new Error(`No tool called ${c.name}`);
          const args = JSON.parse(c.arguments || "{}");
          const r = await tool.run(args, { fact });
          got = r.facts ?? [];
          after = r.after ?? [];
          summary = r.summary;
          output = { facts: got, data: r.data ?? null };
          toolCalls++;
        } catch (e) {
          summary = `failed: ${(e as Error).message.slice(0, 140)}`;
          output = { error: (e as Error).message.slice(0, 300) };
        }
        const ms = Date.now() - s0;
        await run.step({ actor: tool?.source === "paypal_mcp" ? "paypal" : "code", tool: `agent.tool.${c.name}`, args: JSON.parse(c.arguments || "{}"), result: { summary, facts: got.map((f) => f.id) }, duration_ms: ms, gate: tool?.kind === "member_action" ? "allowed" : "n/a" });
        emit({ kind: "tool", name: c.name, source: tool?.source, args: short(c.arguments || "{}", 90), summary, ms, facts: got });
        for (const a of after) emit(a);
        input.push({ type: "function_call_output", call_id: c.call_id, output: JSON.stringify(output).slice(0, 12000) });
      }
    }
    throw new Error("The agent used all its steps without answering");
  } catch (e) {
    emit({ kind: "error", name: "error", summary: (e as Error).message.slice(0, 200), ms: Date.now() - t0 });
    await finish(`failed: ${(e as Error).message.slice(0, 120)}`).catch(() => null);
    throw new NoModelError(`Agent failed: ${(e as Error).message}`);
  }
}
