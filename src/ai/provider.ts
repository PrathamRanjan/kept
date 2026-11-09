/**
 * AI provider layer (roadmap B.1). OpenAI Responses API with strict JSON-schema outputs, a model chain
 * (primary -> fallback -> replayed answer to the identical input -> rules), a per-call audit record, and the
 * guard helpers every caller must use: forbidden-field schema checks and grounding.
 *
 * In Kept the model drafts plans and rules from the owner's words, classifies a cancel reason, words an offer
 * the code has already chosen, explains a failed renewal and answers the owner's questions. Eligibility,
 * offer choice, prices sent to PayPal and every PayPal call are code. `assertSafeSchema` enforces at call time
 * that no money or PayPal-id field can come out of a model; the structural test enforces it at build time.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { getDb } from "../db.js";

export type Purpose = "draft_plans" | "draft_rules" | "classify_reason" | "word_offer" | "explain_failure" | "owner_answer" | "eval";

export interface TextPart {
  type: "text";
  text: string;
}
export interface ImagePart {
  type: "image";
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  data: Buffer;
}
export type Part = TextPart | ImagePart;

export interface StructuredCall<T> {
  purpose: Purpose;
  /** "read" for drafting and judging, "classify" for cheap labels and wording. */
  tier: "read" | "classify" | "vision";
  system: string;
  parts: Part[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens?: number;
  allowReplay?: boolean;
  runId?: string | null;
  parse?: (raw: unknown) => T;
}

export interface CallResult<T> {
  output: T;
  model: string;
  via: "primary" | "fallback" | "replay";
  inputHash: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  auditId: number | null;
}

export class NoModelError extends Error {
  constructor(msg = "No model available") {
    super(msg);
  }
}

let fetchImpl: typeof fetch = (i, init) => fetch(i, init);
/** Tests intercept model calls here. */
export function setProviderFetch(f: typeof fetch | null) {
  fetchImpl = f ?? ((i, init) => fetch(i, init));
}

export const hasOpenAI = () => config.ai.provider === "openai" && Boolean(config.ai.openaiKey);
export const providerLabel = () => (hasOpenAI() ? `openai (${config.ai.models.read} for drafting, ${config.ai.models.classify} for labels and wording)` : "rules only (no model key)");

/** Fields a model output schema may never contain. Money and PayPal identifiers are produced by code. */
export const FORBIDDEN_FIELDS = [/^amount/i, /_cents$/i, /^fee$/i, /^fee_/i, /^price_to_pay$/i, /^new_price$/i, /^payout/i, /^capture/i, /^refund/i, /^invoice_id$/i, /^subscription_id$/i, /^paypal_/i, /^plan_id$/i, /^payment_token/i, /^payer_id$/i, /^receiver_email$/i, /^I-[A-Z0-9]+$/];
/** Read-only observations a schema may carry even though they look like money: quoted from the owner's own text. */
export const ALLOWED_OBSERVATIONS = new Set(["price_quote", "price_seen"]);

export function assertSafeSchema(schema: Record<string, unknown>, path = "$"): void {
  const props = (schema.properties ?? {}) as Record<string, any>;
  for (const [k, v] of Object.entries(props)) {
    if (!ALLOWED_OBSERVATIONS.has(k) && FORBIDDEN_FIELDS.some((re) => re.test(k))) throw new Error(`Unsafe model schema: field ${path}.${k} looks like a money or PayPal id field`);
    if (v && typeof v === "object") {
      if (v.properties) assertSafeSchema(v, `${path}.${k}`);
      if (v.items?.properties) assertSafeSchema(v.items, `${path}.${k}[]`);
    }
  }
}

/** OpenAI strict mode needs every property required and additionalProperties:false at every level. */
export function strictify(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const out: any = Array.isArray(schema) ? schema.map(strictify) : { ...schema };
  if (out.type === "object" || out.properties) {
    out.additionalProperties = false;
    out.properties = Object.fromEntries(Object.entries(out.properties ?? {}).map(([k, v]) => [k, strictify(v)]));
    out.required = Object.keys(out.properties);
  }
  if (out.items) out.items = strictify(out.items);
  if (out.anyOf) out.anyOf = out.anyOf.map(strictify);
  delete out.default;
  delete out.format;
  return out;
}

/** Rough list prices per million tokens (input, output); labelled "estimated" wherever shown. */
const PRICE: Record<string, [number, number]> = {
  "gpt-5.5": [5, 20],
  "gpt-5.4": [2.5, 10],
  "gpt-5.4-mini": [0.4, 1.6],
  "gpt-5.4-nano": [0.1, 0.4],
  "gpt-5.6-luna": [4, 16],
  "gpt-5.1": [1.25, 10],
  "gpt-5": [1.25, 10],
};
export function estimateCost(model: string, tin: number, tout: number): number {
  const p = PRICE[model] ?? [2, 8];
  return (tin * p[0] + tout * p[1]) / 1e6;
}

function chainFor(tier: StructuredCall<unknown>["tier"]): string[] {
  const m = config.ai.models;
  if (tier === "vision") return [m.vision, m.read];
  if (tier === "read") return [m.read, m.classify];
  return [m.classify, m.read];
}

export function hashInput(call: { system: string; parts: Part[]; schemaName: string }): string {
  const h = createHash("sha256");
  h.update(call.system).update("\u0000").update(call.schemaName).update("\u0000");
  for (const p of call.parts) {
    if (p.type === "text") h.update("t:").update(p.text);
    else h.update("i:").update(createHash("sha256").update(p.data).digest("hex"));
  }
  return h.digest("hex");
}

function toInput(parts: Part[]) {
  return parts.map((p) => (p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: `data:${p.mediaType};base64,${Buffer.from(p.data).toString("base64")}`, detail: "high" }));
}

/** The exact request body sent to OpenAI, exposed so the secret-leak test can inspect what a prompt contains. */
export function requestBody(model: string, call: StructuredCall<unknown>, schema: any) {
  return {
    model,
    instructions: call.system,
    input: [{ role: "user", content: toInput(call.parts) }],
    text: { format: { type: "json_schema", name: call.schemaName, strict: true, schema } },
    max_output_tokens: call.maxOutputTokens ?? 1200,
    store: false,
  };
}

async function openaiStructured(model: string, call: StructuredCall<unknown>, schema: any): Promise<{ raw: unknown; tokensIn: number; tokensOut: number; model: string }> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(`${config.ai.openaiBaseUrl}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody(model, call, schema)),
    });
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      last = new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    const msg = (data.output ?? []).find((o: any) => o.type === "message");
    const part = msg?.content?.find((c: any) => c.type === "output_text");
    if (!part?.text) {
      const refusal = msg?.content?.find((c: any) => c.type === "refusal");
      throw new Error(refusal ? `Model refused: ${String(refusal.refusal).slice(0, 200)}` : "Model returned no text");
    }
    return { raw: JSON.parse(part.text), tokensIn: data.usage?.input_tokens ?? 0, tokensOut: data.usage?.output_tokens ?? 0, model: data.model ?? model };
  }
  throw last;
}

async function audit(row: { purpose: string; model: string; via: string; inputHash: string; outputHash: string; tokensIn: number; tokensOut: number; costUsd: number; latencyMs: number; ok: boolean; error: string | null; output: unknown; runId: string | null }): Promise<number | null> {
  try {
    const db = await getDb();
    const r = await db.query<{ id: number }>(
      `INSERT INTO ai_calls (purpose, model, via, input_hash, output_hash, tokens_in, tokens_out, cost_usd, latency_ms, ok, error, output, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [row.purpose, row.model, row.via, row.inputHash, row.outputHash, row.tokensIn, row.tokensOut, row.costUsd, row.latencyMs, row.ok, row.error, row.ok ? JSON.stringify(row.output) : null, row.runId],
    );
    return r.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function replay(inputHash: string): Promise<{ output: unknown; model: string } | null> {
  try {
    const db = await getDb();
    const r = await db.query<{ output: unknown; model: string }>("SELECT output, model FROM ai_calls WHERE input_hash = $1 AND ok AND via <> 'replay' ORDER BY id DESC LIMIT 1", [inputHash]);
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * One structured call through the chain. Throws NoModelError when no model is configured or every step failed
 * and nothing can be replayed; callers then fall back to the local brain.
 */
export async function structured<T>(call: StructuredCall<T>): Promise<CallResult<T>> {
  assertSafeSchema(call.schema);
  const schema = strictify(call.schema);
  const inputHash = hashInput(call);
  const parse = call.parse ?? ((x: unknown) => x as T);
  const started = Date.now();
  if (!hasOpenAI()) {
    if (call.allowReplay !== false) {
      const r = await replay(inputHash);
      if (r) return { output: parse(r.output), model: r.model, via: "replay", inputHash, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - started, auditId: null };
    }
    throw new NoModelError("AI_PROVIDER is not openai or OPENAI_API_KEY is unset");
  }
  const chain = chainFor(call.tier);
  const errors: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    const t0 = Date.now();
    try {
      const r = await openaiStructured(model, call, schema);
      const output = parse(r.raw);
      const latencyMs = Date.now() - t0;
      const costUsd = estimateCost(r.model, r.tokensIn, r.tokensOut);
      const via = i === 0 ? "primary" : "fallback";
      const auditId = await audit({ purpose: call.purpose, model: r.model, via, inputHash, outputHash: createHash("sha256").update(JSON.stringify(r.raw)).digest("hex"), tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd, latencyMs, ok: true, error: null, output: r.raw, runId: call.runId ?? null });
      return { output, model: r.model, via, inputHash, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd, latencyMs, auditId };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      errors.push(`${model}: ${msg}`);
      await audit({ purpose: call.purpose, model, via: i === 0 ? "primary" : "fallback", inputHash, outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - t0, ok: false, error: msg, output: null, runId: call.runId ?? null });
    }
  }
  if (call.allowReplay !== false) {
    const r = await replay(inputHash);
    if (r) {
      await audit({ purpose: call.purpose, model: r.model, via: "replay", inputHash, outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - started, ok: true, error: null, output: r.output, runId: call.runId ?? null });
      return { output: parse(r.output), model: r.model, via: "replay", inputHash, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - started, auditId: null };
    }
  }
  throw new NoModelError(`Every model failed: ${errors.join(" | ")}`);
}

/** Summary for the evidence page. */
export async function aiUsageSummary(): Promise<{ calls: number; ok: number; cost_usd: number; by_purpose: { purpose: string; calls: number; cost_usd: number; p50_ms: number; replayed: number }[] }> {
  const db = await getDb();
  const tot = (await db.query<{ calls: string; ok: string; cost: string }>("SELECT count(*) AS calls, count(*) FILTER (WHERE ok) AS ok, coalesce(sum(cost_usd),0) AS cost FROM ai_calls")).rows[0];
  const by = (
    await db.query<{ purpose: string; calls: string; cost: string; p50: string; replayed: string }>(
      "SELECT purpose, count(*) AS calls, coalesce(sum(cost_usd),0) AS cost, coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms),0) AS p50, count(*) FILTER (WHERE via = 'replay') AS replayed FROM ai_calls WHERE ok GROUP BY purpose ORDER BY purpose",
    )
  ).rows;
  return {
    calls: Number(tot?.calls ?? 0),
    ok: Number(tot?.ok ?? 0),
    cost_usd: Number(tot?.cost ?? 0),
    by_purpose: by.map((r) => ({ purpose: r.purpose, calls: Number(r.calls), cost_usd: Number(r.cost), p50_ms: Math.round(Number(r.p50)), replayed: Number(r.replayed) })),
  };
}
