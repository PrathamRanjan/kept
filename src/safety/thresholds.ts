/**
 * Spec A5.2: thresholds that turn a Decisions probability into clear, caution or hold live in code and data.
 * Defaults are below. `scripts/calibrate.ts` runs the labelled set (eval/scam/cases.json, tuning half), picks
 * the pair from the cost of a false hold versus a miss, and writes a `decision_thresholds` row; a row, when
 * present, wins over the default. `/proof` shows both, and which one is in force.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";

/** The committed calibration (written by scripts/calibrate.ts). Loaded into the table once per process. */
export const CALIBRATION_FILE = join(process.cwd(), "eval", "scam", "thresholds.json");
let synced = false;
async function syncFromFile(db: Queryable) {
  if (synced) return;
  synced = true;
  if (!existsSync(CALIBRATION_FILE)) return;
  try {
    const rows = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8")).thresholds as Omit<Threshold, "set_at" | "source">[];
    for (const r of rows) await writeThreshold(r, db);
  } catch {
    /* A broken file leaves the defaults in force; /proof shows which source each threshold came from. */
  }
}
export const resetThresholdSync = () => (synced = false);

export interface Threshold {
  name: string;
  clear_below: number;
  hold_above: number;
  calibrated_on: string;
  n: number;
  precision_at_hold: number | null;
  recall_at_hold: number | null;
  set_at: string | null;
  source: "default" | "calibrated";
}

/** Uncalibrated starting points: below 0.2 is clear, at or above 0.7 holds, between is caution. */
export const DEFAULTS: Record<string, { clear_below: number; hold_above: number }> = {
  scam_tactic: { clear_below: 0.2, hold_above: 0.7 },
  names_a_payment_destination: { clear_below: 0.2, hold_above: 0.6 },
  asks_for_payment: { clear_below: 0.2, hold_above: 0.6 },
};

export async function thresholds(q?: Queryable): Promise<Record<string, Threshold>> {
  const db = q ?? (await getDb());
  await syncFromFile(db);
  const rows = (await db.query<any>("SELECT * FROM decision_thresholds")).rows;
  const out: Record<string, Threshold> = {};
  for (const [name, d] of Object.entries(DEFAULTS)) out[name] = { name, ...d, calibrated_on: "not calibrated", n: 0, precision_at_hold: null, recall_at_hold: null, set_at: null, source: "default" };
  for (const r of rows) out[r.name] = { name: r.name, clear_below: Number(r.clear_below), hold_above: Number(r.hold_above), calibrated_on: r.calibrated_on, n: Number(r.n), precision_at_hold: r.precision_at_hold === null ? null : Number(r.precision_at_hold), recall_at_hold: r.recall_at_hold === null ? null : Number(r.recall_at_hold), set_at: new Date(r.set_at).toISOString(), source: "calibrated" };
  return out;
}

export async function writeThreshold(t: Omit<Threshold, "set_at" | "source">, q?: Queryable) {
  const db = q ?? (await getDb());
  await db.query(
    `INSERT INTO decision_thresholds (name, clear_below, hold_above, calibrated_on, n, precision_at_hold, recall_at_hold, set_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (name) DO UPDATE SET clear_below = EXCLUDED.clear_below, hold_above = EXCLUDED.hold_above, calibrated_on = EXCLUDED.calibrated_on, n = EXCLUDED.n, precision_at_hold = EXCLUDED.precision_at_hold, recall_at_hold = EXCLUDED.recall_at_hold, set_at = now()`,
    [t.name, t.clear_below, t.hold_above, t.calibrated_on, t.n, t.precision_at_hold, t.recall_at_hold],
  );
}

/**
 * Pick (clear_below, hold_above) for scores of labelled cases. A miss (a scam not held) costs `missCost`, a false
 * hold of a genuine message costs 1, and a caution on either costs `cautionCost`. Grid search on 0.05 steps.
 */
export function pickThresholds(cases: { p: number; positive: boolean }[], missCost = 5, cautionCost = 0.2) {
  let best = { clear_below: 0.2, hold_above: 0.7, cost: Infinity, precision: 0, recall: 0 };
  for (let c = 0.05; c <= 0.9001; c += 0.05) {
    for (let h = c; h <= 0.9501; h += 0.05) {
      let cost = 0;
      let tp = 0;
      let fp = 0;
      for (const x of cases) {
        const level = x.p >= h ? "hold" : x.p >= c ? "caution" : "clear";
        if (x.positive && level === "clear") cost += missCost;
        else if (x.positive && level === "caution") cost += cautionCost * 2;
        else if (!x.positive && level === "hold") cost += 1;
        else if (!x.positive && level === "caution") cost += cautionCost;
        if (level === "hold") x.positive ? tp++ : fp++;
      }
      const pos = cases.filter((x) => x.positive).length;
      if (cost < best.cost - 1e-9) best = { clear_below: round(c), hold_above: round(h), cost, precision: tp + fp ? tp / (tp + fp) : 0, recall: pos ? tp / pos : 0 };
    }
  }
  return best;
}
const round = (x: number) => Math.round(x * 100) / 100;
