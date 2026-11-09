/**
 * Agent trace (roadmap B.2). Every run is a row in agent_runs; every tool call, policy check and money gate is
 * a step in agent_trace. No PayPal write happens outside a run: the structural test checks every executor call
 * in the service sits behind the gate, and the gate records its decision as a step before anything is sent.
 */
import type { Queryable } from "./db.js";
import { getDb } from "./db.js";
import { newId } from "./lib/ids.js";
import { esc, html, raw, type Raw } from "./web/html.js";

export type Actor = "model" | "code" | "paypal" | "agent" | "owner" | "subscriber" | "worker" | "guard" | "system";

export interface TraceStep {
  step: number;
  actor: Actor;
  tool: string;
  args?: unknown;
  policy?: string | null;
  gate?: "allowed" | "dry_run_refused" | "held" | "denied" | "n/a" | null;
  result?: unknown;
  pp_request_id?: string | null;
  pp_debug_id?: string | null;
  duration_ms?: number | null;
  at?: Date;
}

const SECRET_KEYS = /(secret|token|password|authorization|api[_-]?key|cookie|credential)/i;
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Buffer.isBuffer(v)) return `[${v.length} bytes]`;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(val, depth + 1);
    return out;
  }
  if (typeof v === "string" && v.length > 2000) return v.slice(0, 2000) + "…";
  return v;
}

export class Run {
  private n = 0;
  constructor(readonly id: string, private readonly q: Queryable) {}

  async step(s: Omit<TraceStep, "step">): Promise<number> {
    this.n += 1;
    await this.q.query(
      `INSERT INTO agent_trace (run_id, step, actor, tool, args, policy, gate, result, pp_request_id, pp_debug_id, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [this.id, this.n, s.actor, s.tool, s.args === undefined ? null : JSON.stringify(redact(s.args)), s.policy ?? null, s.gate ?? null, s.result === undefined ? null : JSON.stringify(redact(s.result)), s.pp_request_id ?? null, s.pp_debug_id ?? null, s.duration_ms ?? null],
    );
    return this.n;
  }

  /** Times a function and records it as one step. */
  async timed<T>(s: Omit<TraceStep, "step" | "duration_ms" | "result">, fn: () => Promise<T>, summarise: (r: T) => unknown = (r) => r): Promise<T> {
    const t0 = Date.now();
    try {
      const r = await fn();
      await this.step({ ...s, result: summarise(r), duration_ms: Date.now() - t0 });
      return r;
    } catch (e) {
      await this.step({ ...s, gate: s.gate ?? "denied", result: { error: (e as Error).message.slice(0, 300) }, duration_ms: Date.now() - t0 });
      throw e;
    }
  }

  async end(status: "done" | "failed" | "held" = "done") {
    await this.q.query("UPDATE agent_runs SET status = $2, ended_at = now() WHERE id = $1", [this.id, status]);
  }
}

export async function startRun(input: { actor: Actor; agentId?: string | null; merchantId?: string | null; subject: string; entity?: string; entityId?: string }, q?: Queryable): Promise<Run> {
  const db = q ?? (await getDb());
  const id = newId("run");
  await db.query("INSERT INTO agent_runs (id, actor, agent_id, merchant_id, subject, entity, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, input.actor, input.agentId ?? null, input.merchantId ?? null, input.subject, input.entity ?? null, input.entityId ?? null]);
  return new Run(id, db);
}

export async function loadRun(runId: string): Promise<{ run: any; steps: TraceStep[] } | null> {
  const db = await getDb();
  const run = (await db.query("SELECT * FROM agent_runs WHERE id = $1", [runId])).rows[0];
  if (!run) return null;
  const steps = (await db.query<TraceStep>("SELECT step, actor, tool, args, policy, gate, result, pp_request_id, pp_debug_id, duration_ms, at FROM agent_trace WHERE run_id = $1 ORDER BY step", [runId])).rows;
  return { run, steps };
}

export async function runsFor(entity: string, entityId: string, limit = 10) {
  const db = await getDb();
  return (await db.query("SELECT r.*, (SELECT count(*) FROM agent_trace t WHERE t.run_id = r.id) AS steps FROM agent_runs r WHERE entity = $1 AND entity_id = $2 ORDER BY started_at DESC LIMIT $3", [entity, entityId, limit])).rows as any[];
}

export async function recentRuns(merchantId: string | null, limit = 50) {
  const db = await getDb();
  return (
    await db.query(
      `SELECT r.*, (SELECT count(*) FROM agent_trace t WHERE t.run_id = r.id) AS steps,
              (SELECT count(*) FROM agent_trace t WHERE t.run_id = r.id AND t.actor = 'paypal') AS paypal_calls,
              (SELECT count(*) FROM agent_trace t WHERE t.run_id = r.id AND t.gate IN ('denied','held','dry_run_refused')) AS blocked
       FROM agent_runs r WHERE ($1::text IS NULL OR r.merchant_id = $1) ORDER BY started_at DESC LIMIT $2`,
      [merchantId, limit],
    )
  ).rows as any[];
}

const GATE_CLASS: Record<string, string> = { allowed: "good", dry_run_refused: "warn", held: "warn", denied: "bad" };

/** Server-rendered trace component used on the owner's pages and the judge page. */
export function renderTrace(steps: TraceStep[], opts: { title?: string; compact?: boolean } = {}): Raw {
  if (!steps.length) return html`<div class="muted small">No agent steps recorded.</div>`;
  const rows = steps
    .map((s) => {
      const gate = s.gate && s.gate !== "n/a" ? `<span class="pill ${GATE_CLASS[s.gate] ?? ""}">${esc(s.gate.replace(/_/g, " "))}</span>` : "";
      const pp = s.pp_request_id || s.pp_debug_id ? `<div class="small muted mono">${s.pp_request_id ? `request ${esc(s.pp_request_id)}` : ""}${s.pp_debug_id ? ` · debug ${esc(s.pp_debug_id)}` : ""}</div>` : "";
      const detail = opts.compact ? "" : `<details><summary class="small muted">arguments and result</summary><pre class="small">${esc(JSON.stringify({ args: s.args ?? null, result: s.result ?? null }, null, 1))}</pre></details>`;
      return `<li class="trace-step actor-${esc(s.actor)}"><div class="trace-head"><span class="trace-n">${s.step}</span><span class="pill">${esc(s.actor)}</span><strong>${esc(s.tool)}</strong>${s.policy ? `<span class="small muted">rule: ${esc(s.policy)}</span>` : ""}${gate}<span class="small muted right">${s.duration_ms ?? "–"} ms</span></div>${pp}${detail}</li>`;
    })
    .join("");
  return html`<section class="trace">${opts.title ? html`<h3>${opts.title}</h3>` : ""}<ol class="trace-list">${raw(rows)}</ol></section>`;
}
