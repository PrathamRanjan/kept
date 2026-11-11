/**
 * Spec A5.2 / A6: calibrate the scam-check thresholds and publish every case.
 *
 *   npm run calibrate            asks Decisions about every case in eval/scam/cases.json (real model, real key)
 *   npm run calibrate -- --replay  reuses eval/scam/answers.json (the answers from the last real run)
 *
 * Picks (clear_below, hold_above) for "any tactic" and for names_a_payment_destination on the tuning half only,
 * from the cost of a miss (5) against a false hold (1). Then scores every case, tuning and held-out, through the
 * same combine code the live check uses (rules + code reader + Decisions), and writes:
 *   eval/scam/answers.json     the raw Decisions probabilities per case, with the model and date
 *   eval/scam/thresholds.json  the thresholds (loaded into decision_thresholds at boot)
 *   eval/scam/results.json     every case: input, expected, each reader, final level, pass or fail
 * The version-1 check (rules only) is scored on the same cases for the before-and-after.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { openDb, setDb } from "../src/db.js";
import { decide } from "../src/ai/decisions.js";
import { config } from "../src/config.js";
import { assessMessage, stripOwnLinks } from "../src/safety/index.js";
import { combineReaders, readDecisions, SCAM_QUESTIONS, TACTIC_QUESTIONS, wrapAsData } from "../src/safety/readers.js";
import { DEFAULTS, pickThresholds, type Threshold } from "../src/safety/thresholds.js";

type Case = { id: string; text: string; scam: boolean; destination: boolean; split: "tune" | "held" };
const DIR = "eval/scam";
const cases = (JSON.parse(readFileSync(`${DIR}/cases.json`, "utf8")).cases as Case[]);
const replay = process.argv.includes("--replay");

async function main() {
  setDb(await openDb({ memory: true }));
  // Score the cases as the live site would: Kept's own member links point at the live host.
  (config as any).appUrl = "https://pph-kept.onrender.com";
  let answers: { model: string; at: string; runner: string; byCase: Record<string, Record<string, number | "not decided">>; latencyMs: Record<string, number> };
  if (replay) {
    if (!existsSync(`${DIR}/answers.json`)) throw new Error("No eval/scam/answers.json to replay; run without --replay first.");
    answers = JSON.parse(readFileSync(`${DIR}/answers.json`, "utf8"));
    answers.runner = `replayed on ${new Date().toISOString().slice(0, 10)} from the real run of ${answers.at.slice(0, 10)}`;
  } else {
    answers = { model: config.ai.models.decide, at: new Date().toISOString(), runner: "real Decisions calls", byCase: {}, latencyMs: {} };
    for (const c of cases) {
      const r = await decide(wrapAsData(stripOwnLinks(c.text).text), SCAM_QUESTIONS, { purpose: "calibrate", summary: `calibration case ${c.id}` });
      answers.model = r.model;
      answers.byCase[c.id] = Object.fromEntries(SCAM_QUESTIONS.map((q) => [q.name, r.answers[q.name]?.refused || typeof r.answers[q.name]?.probability !== "number" ? "not decided" : Math.round(r.answers[q.name].probability! * 100) / 100]));
      answers.latencyMs[c.id] = r.latencyMs;
      process.stdout.write(".");
    }
    process.stdout.write("\n");
    writeFileSync(`${DIR}/answers.json`, JSON.stringify(answers, null, 1));
  }

  const num = (v: number | "not decided" | undefined) => (typeof v === "number" ? v : 1);
  const tacticP = (id: string) => Math.max(...TACTIC_QUESTIONS.map((t) => num(answers.byCase[id][t.name])));
  const tune = cases.filter((c) => c.split === "tune");
  const at = new Date().toISOString().slice(0, 10);
  const scamPick = pickThresholds(tune.map((c) => ({ p: tacticP(c.id), positive: c.scam })));
  const destPick = pickThresholds(tune.map((c) => ({ p: num(answers.byCase[c.id].names_a_payment_destination), positive: c.destination || c.scam })), 3, 0.1);
  const rows: Omit<Threshold, "set_at" | "source">[] = [
    { name: "scam_tactic", clear_below: scamPick.clear_below, hold_above: scamPick.hold_above, calibrated_on: `eval/scam/cases.json tuning half, ${at}`, n: tune.length, precision_at_hold: round(scamPick.precision), recall_at_hold: round(scamPick.recall) },
    // The destination question only ever raises clear to amber, so its hold line is not used; clear_below is what matters.
    { name: "names_a_payment_destination", clear_below: destPick.clear_below, hold_above: destPick.hold_above, calibrated_on: `eval/scam/cases.json tuning half, ${at}`, n: tune.length, precision_at_hold: round(destPick.precision), recall_at_hold: round(destPick.recall) },
  ];
  const th: Record<string, Threshold> = Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, { name: k, ...d, calibrated_on: "not calibrated", n: 0, precision_at_hold: null, recall_at_hold: null, set_at: null, source: "default" as const }]));
  for (const r of rows) th[r.name] = { ...r, set_at: new Date().toISOString(), source: "calibrated" };
  writeFileSync(`${DIR}/thresholds.json`, JSON.stringify({ about: "Written by scripts/calibrate.ts. Loaded into decision_thresholds at boot.", model: answers.model, thresholds: rows }, null, 1));

  const expectedFor = (c: Case) => (c.scam ? (c.id === "nov10" ? "hold" : "hold or caution") : c.destination ? "clear or caution" : "clear");
  const passes = (c: Case, level: string) => (c.scam ? (c.id === "nov10" ? level === "hold" : level !== "clear") : c.destination ? level !== "hold" : level === "clear");
  const results = cases.map((c) => {
    const dec = readDecisions(answers.byCase[c.id], th, answers.model, answers.latencyMs[c.id]);
    const v2 = combineReaders(c.text, dec, th, { shopName: "Ember & Oak Coffee Club", shopEmail: null });
    const v1 = assessMessage(c.text).level;
    return {
      id: c.id,
      split: c.split,
      input: c.text,
      expected: expectedFor(c),
      level: v2.level,
      pass: passes(c, v2.level),
      v1_level: v1,
      v1_pass: passes(c, v1),
      readers: { rules: v2.readers.rules.level, code: v2.readers.code.level, decisions: v2.readers.decisions.level },
      never_green: v2.neverGreen,
      top_reason: v2.reasons[0] ?? null,
      decisions: answers.byCase[c.id],
    };
  });
  const sum = (split: string) => {
    const r = results.filter((x) => split === "all" || x.split === split);
    const s = r.filter((x) => cases.find((c) => c.id === x.id)!.scam);
    const g = r.filter((x) => !cases.find((c) => c.id === x.id)!.scam);
    return { cases: r.length, passed: r.filter((x) => x.pass).length, scams_not_cleared: s.filter((x) => x.level !== "clear").length, scams: s.length, genuine_held: g.filter((x) => x.level === "hold").length, genuine_amber: g.filter((x) => x.level === "caution").length, genuine: g.length, v1_passed: r.filter((x) => x.v1_pass).length, v1_scams_not_cleared: s.filter((x) => x.v1_level !== "clear").length };
  };
  const out = { suite: "scam_check", model: answers.model, runner: answers.runner, answers_at: answers.at, run_at: new Date().toISOString(), thresholds: rows, summary: { tune: sum("tune"), held: sum("held"), all: sum("all") }, results, not_measured: ["The on-device model is not part of this run (it runs in the browser); its own frozen-set figures are on /proof from MODEL_CARD.md.", "48 hand-written cases is a small set: treat the rates as a smoke test, not a measured catch rate.", "No real member messages; Kept has none to test on."] };
  writeFileSync(`${DIR}/results.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ thresholds: rows.map((r) => [r.name, r.clear_below, r.hold_above]), summary: out.summary }, null, 1));
  for (const r of results.filter((x) => !x.pass)) console.log("FAIL", r.id, r.split, r.level, "expected", r.expected, "|", r.top_reason);
}
const round = (x: number) => Math.round(x * 100) / 100;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
