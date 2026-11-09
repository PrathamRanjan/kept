/* Evaluates the exported LightGBM JSON (dump_model) in plain JS. No dependency. Returns probability of risk. */
export function makeRiskScorer(dump) {
  const feats = dump.features; const trees = dump.model.tree_info;
  function walk(node, x) {
    while (node.left_child !== undefined || node.right_child !== undefined) {
      const v = x[node.split_feature]; let goLeft;
      if (v === undefined || v === null || Number.isNaN(v)) goLeft = node.default_left;
      else if (node.decision_type === "<=") goLeft = v <= node.threshold;
      else if (node.decision_type === "==") goLeft = String(node.threshold).split("||").includes(String(v));
      else goLeft = v <= node.threshold;
      node = goLeft ? node.left_child : node.right_child;
    }
    return node.leaf_value;
  }
  return {
    features: feats,
    score(obj) {
      const x = feats.map((f) => (obj[f] === undefined ? NaN : Number(obj[f])));
      let raw = 0; for (const t of trees) raw += walk(t.tree_structure, x);
      return 1 / (1 + Math.exp(-raw));
    },
  };
}
