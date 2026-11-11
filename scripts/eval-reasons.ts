/** Runs the cancel-reason eval (rules / model / oracle arms) on the held-out split and writes eval/results.md. */
import { mkdirSync, writeFileSync } from "node:fs";
import { renderReasonReport, runReasonEval } from "../src/eval/reasons.js";
const split = (process.argv[2] as "dev" | "heldout" | "all") || "heldout";
const r = await runReasonEval({ split });
const md = renderReasonReport(r);
mkdirSync("eval", { recursive: true });
writeFileSync("eval/results.md", md);
// Spec A5.6: every case for /proof (model arm when a model ran, otherwise the rules arm, labelled).
{
  const { getDb } = await import("../src/db.js");
  const { config } = await import("../src/config.js");
  const arm = r.modelArm ? "model" : "rules";
  const rows = (await (await getDb()).query<any>("SELECT case_id, expected, actual, correct, detail FROM eval_runs WHERE suite = 'reasons' AND arm = $1 ORDER BY case_id", [arm])).rows;
  const parse = (v: any) => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return v; } };
  const rulesRows = (await (await getDb()).query<any>("SELECT correct FROM eval_runs WHERE suite = 'reasons' AND arm = 'rules'")).rows;
  writeFileSync("eval/reasons.json", JSON.stringify({
    suite: "reasons",
    title: "Cancel reason label (members' own words)",
    about: `Split: ${r.split}. Each case is a member's cancel reason; the label decides whether any offer may apply (a quality complaint never gets one). Arm shown: ${arm}. The rules arm (no model) got ${rulesRows.filter((x) => x.correct).length} of ${rulesRows.length} for comparison.`,
    model: r.modelArm ? config.ai.models.classify : null,
    runner: r.modelArm ? "real model calls" : "rules only: no model key",
    run_at: new Date().toISOString(),
    cases: rows.map((x) => { const d = parse(x.detail) ?? {}; return { id: x.case_id, split: d.split, input: d.text, expected: parse(x.expected), actual: parse(x.actual), pass: x.correct, note: d.trap_caught === false ? "trap not caught" : undefined }; }),
    not_measured: ["Members' reasons in languages other than English.", "Real members' words: the cases are written for this project."],
  }, null, 1));
}
console.log(md);
process.exit(0);
