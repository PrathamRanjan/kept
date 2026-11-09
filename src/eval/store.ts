/** eval_runs rows and per-suite summaries for the explorer and the markdown reports. */
import { getDb, type Queryable } from "../db.js";
import { newId } from "../lib/ids.js";

export interface EvalRowInput {
  suite: string;
  arm: string;
  caseId: string;
  expected: unknown;
  actual: unknown;
  correct: boolean;
  trap?: boolean;
  trapKind?: string | null;
  naivePaidCents?: number;
  oursPaidCents?: number;
  costUsd?: number;
  latencyMs?: number;
  detail?: unknown;
}

export async function recordEval(r: EvalRowInput, q?: Queryable) {
  const db = q ?? (await getDb());
  await db.query("INSERT INTO eval_runs (id, suite, arm, case_id, expected, actual, correct, trap, naive_paid_cents, ours_paid_cents, cost_usd, latency_ms, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [
    newId("ev"), r.suite, r.arm, r.caseId, JSON.stringify(r.expected), JSON.stringify(r.actual), r.correct, r.trap ?? false, Math.round(r.naivePaidCents ?? 0), Math.round(r.oursPaidCents ?? 0), r.costUsd ?? 0, Math.round(r.latencyMs ?? 0), JSON.stringify({ ...((r.detail as object) ?? {}), trap_kind: r.trapKind ?? null }),
  ]);
}

export async function clearSuite(suite: string, q?: Queryable) {
  const db = q ?? (await getDb());
  await db.query("DELETE FROM eval_runs WHERE suite = $1", [suite]);
}

export interface ArmSummary {
  arm: string;
  cases: number;
  correct: number;
  traps: number;
  traps_caught: number;
  naive_usd: number;
  ours_usd: number;
  cost_usd: number;
  p50_ms: number;
  p95_ms: number;
}

const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export async function summarise(suite: string, q?: Queryable): Promise<ArmSummary[]> {
  const db = q ?? (await getDb());
  const rows = (await db.query<any>("SELECT arm, case_id, correct, trap, naive_paid_cents, ours_paid_cents, cost_usd, latency_ms, detail FROM eval_runs WHERE suite = $1 ORDER BY arm, case_id", [suite])).rows;
  const by = new Map<string, any[]>();
  for (const r of rows) (by.get(r.arm) ?? by.set(r.arm, []).get(r.arm)!).push(r);
  const out: ArmSummary[] = [];
  for (const [arm, rs] of by) {
    const lat = rs.map((r) => Number(r.latency_ms)).sort((a, b) => a - b);
    const traps = rs.filter((r) => r.trap);
    out.push({
      arm,
      cases: rs.length,
      correct: rs.filter((r) => r.correct).length,
      traps: traps.length,
      traps_caught: traps.filter((r) => parse(r.detail)?.trap_caught === true).length,
      naive_usd: rs.reduce((s, r) => s + Number(r.naive_paid_cents), 0) / 100,
      ours_usd: rs.reduce((s, r) => s + Number(r.ours_paid_cents), 0) / 100,
      cost_usd: rs.reduce((s, r) => s + Number(r.cost_usd), 0),
      p50_ms: lat.length ? lat[Math.floor(lat.length / 2)] : 0,
      p95_ms: lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] : 0,
    });
  }
  return out;
}

export async function evalRows(suite: string, filter: { arm?: string; outcome?: "correct" | "wrong"; trap?: string } = {}, limit = 500, q?: Queryable) {
  const db = q ?? (await getDb());
  const rows = (await db.query<any>("SELECT * FROM eval_runs WHERE suite = $1 ORDER BY case_id, arm LIMIT $2", [suite, limit])).rows.map((r: any) => ({ ...r, expected: parse(r.expected), actual: parse(r.actual), detail: parse(r.detail) }));
  return rows.filter((r: any) => (!filter.arm || r.arm === filter.arm) && (!filter.outcome || (filter.outcome === "correct") === Boolean(r.correct)) && (!filter.trap || (filter.trap === "trap" ? r.trap : filter.trap === "plain" ? !r.trap : r.detail?.trap_kind === filter.trap)));
}

export function toCsv(rows: any[]): string {
  const cols = ["suite", "arm", "case_id", "expected", "actual", "correct", "trap", "naive_paid_cents", "ours_paid_cents", "cost_usd", "latency_ms"];
  const cell = (v: unknown) => `"${String(typeof v === "object" ? JSON.stringify(v) : v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n");
}
