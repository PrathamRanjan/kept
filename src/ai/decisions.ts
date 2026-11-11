/**
 * Spec A5.2: a Decisions client. One request carries every question about the same evidence; the answers are
 * probabilities, choices or scores. Thresholds that turn a probability into "hold" or "clear" live in code and
 * data (`decision_thresholds`, see src/safety/thresholds.ts), never in the model.
 *
 * `decide()` hides the vendor: callers pass questions and get answers keyed by name. An answer of type
 * `refusal` comes back as `{ refused: true }`, which callers treat as "not decided" and route to a person.
 * Every call is logged in `ai_calls` (purpose `decide_<purpose>`, the questions and answers in `output`).
 * With no key, or when the endpoint fails after retries, it throws NoModelError: there is no rules stand-in.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { audit, estimateCost, hasOpenAI, NoModelError, providerFetch } from "./provider.js";

export type Question =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] }
  | { type: "score"; name: string; instructions: string; levels: { label: string; description: string }[] };

export type InputPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string } | { type: "input_json"; json: unknown };

export interface Answer {
  probability?: number;
  choice?: string;
  probabilities?: { value: string | number; label?: string; probability: number }[];
  score?: number;
  confidence?: number;
  refused?: boolean;
}

export interface DecideResult {
  answers: Record<string, Answer>;
  model: string;
  latencyMs: number;
  tokensIn: number;
  costUsd: number;
  auditId: number | null;
}

/** The exact request body, exported so tests can check what is sent. Untrusted text is marked as data. */
export function decisionsBody(input: string | InputPart[], questions: Question[]) {
  if (questions.length < 1 || questions.length > 400) throw new Error("Decisions takes 1 to 400 questions per request");
  const names = new Set<string>();
  for (const q of questions) {
    if (names.has(q.name)) throw new Error(`Duplicate question name ${q.name}`);
    names.add(q.name);
    if (q.type === "choice" && !q.choices.some((c) => c.value === "other")) throw new Error(`Choice question ${q.name} needs an "other" option`);
  }
  return { model: config.ai.models.decide, input, questions };
}

export async function decide(input: string | InputPart[], questions: Question[], meta: { purpose: string; ws?: string | null; runId?: string | null; summary?: string }): Promise<DecideResult> {
  const body = decisionsBody(input, questions);
  if (!hasOpenAI()) throw new NoModelError("AI_PROVIDER is not openai or OPENAI_API_KEY is unset");
  const inputHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  const t0 = Date.now();
  let data: any;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await providerFetch()(`${config.ai.openaiBaseUrl}/v1/decisions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) {
        data = JSON.parse(text);
        break;
      }
      lastErr = `Decisions ${res.status}: ${text.slice(0, 200)}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastErr = (e as Error).message.slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  const latencyMs = Date.now() - t0;
  const purpose = `decide_${meta.purpose}`;
  if (!data) {
    await audit({ purpose, model: body.model, via: "primary", inputHash, outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs, ok: false, error: lastErr, output: null, runId: meta.runId ?? null, inputSummary: meta.summary ?? null });
    throw new NoModelError(`Decisions failed: ${lastErr}`);
  }
  const answers: Record<string, Answer> = {};
  for (const a of data.answers ?? []) {
    if (!a?.name) continue;
    if (a.type === "refusal") answers[a.name] = { refused: true };
    else answers[a.name] = { probability: a.probability, choice: a.choice, probabilities: a.probabilities, score: a.score, confidence: a.confidence };
  }
  // A question with no answer at all is "not decided", like a refusal.
  for (const q of questions) if (!answers[q.name]) answers[q.name] = { refused: true };
  const tokensIn = data.usage?.input_tokens ?? 0;
  const model = data.model ?? body.model;
  const costUsd = estimateCost(model, tokensIn, data.usage?.output_tokens ?? 0);
  const auditId = await audit({
    purpose,
    model,
    via: "primary",
    inputHash,
    outputHash: createHash("sha256").update(JSON.stringify(answers)).digest("hex"),
    tokensIn,
    tokensOut: data.usage?.output_tokens ?? 0,
    costUsd,
    latencyMs,
    ok: true,
    error: null,
    output: { questions: questions.map((q) => q.name), answers, ws: meta.ws ?? null },
    runId: meta.runId ?? null,
    inputSummary: meta.summary ?? null,
  });
  return { answers, model, latencyMs, tokensIn, costUsd, auditId };
}
