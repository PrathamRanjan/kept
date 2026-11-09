/** Runs the cancel-reason eval (rules / model / oracle arms) on the held-out split and writes eval/results.md. */
import { mkdirSync, writeFileSync } from "node:fs";
import { renderReasonReport, runReasonEval } from "../src/eval/reasons.js";
const split = (process.argv[2] as "dev" | "heldout" | "all") || "heldout";
const r = await runReasonEval({ split });
const md = renderReasonReport(r);
mkdirSync("eval", { recursive: true });
writeFileSync("eval/results.md", md);
console.log(md);
process.exit(0);
