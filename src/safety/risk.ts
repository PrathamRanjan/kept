/**
 * Safety layer C: the payment-risk model (SAFETY_ACCESSIBILITY_SPEC §4.3). A LightGBM forest exported as JSON by
 * guard-lab/scripts/train_risk.py and walked here with no dependency. Monotone constraints in training mean adding a
 * scam signal can never lower the score. TRAINED ON SYNTHETIC DATA: the probability is a ranking signal with
 * plain-word reasons attached by the rules, not a measured fraud rate. It raises the level; it never approves.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Node { split_feature?: number; threshold?: number | string; decision_type?: string; default_left?: boolean; left_child?: Node; right_child?: Node; leaf_value?: number }
interface Dump { features: string[]; monotone: number[]; model: { tree_info: { tree_structure: Node }[] }; note?: string }

let cached: Dump | null = null;
export function loadRiskModel(path = join(process.cwd(), "public", "safety", "risk_lgbm.json")): Dump {
  if (!cached) cached = JSON.parse(readFileSync(path, "utf8")) as Dump;
  return cached;
}
export function setRiskModel(d: Dump | null) {
  cached = d;
}

function walk(node: Node, x: number[]): number {
  while (node.left_child !== undefined || node.right_child !== undefined) {
    const v = x[node.split_feature!];
    let goLeft: boolean;
    if (v === undefined || v === null || Number.isNaN(v)) goLeft = Boolean(node.default_left);
    else if (node.decision_type === "==") goLeft = String(node.threshold).split("||").includes(String(v));
    else goLeft = v <= Number(node.threshold);
    node = (goLeft ? node.left_child : node.right_child)!;
  }
  return node.leaf_value ?? 0;
}

/** Probability-shaped risk score in [0,1] from the feature vocabulary in the dump. Missing features follow the tree default. */
export function riskScore(features: Record<string, number>, dump = loadRiskModel()): number {
  const x = dump.features.map((f) => (features[f] === undefined ? NaN : Number(features[f])));
  let raw = 0;
  for (const t of dump.model.tree_info) raw += walk(t.tree_structure, x);
  return 1 / (1 + Math.exp(-raw));
}

/** Thresholds against the synthetic hold-out (probe rows: clean 0.001, one mild signal 0.055, stacked signals 0.95): under 0.1 nothing, 0.1 to 0.5 caution, above hold. */
export const riskLevel = (p: number): "clear" | "caution" | "hold" => (p >= 0.5 ? "hold" : p >= 0.1 ? "caution" : "clear");
