/* Browser-side scam scorer: MiniLM encoder (ONNX int8, via onnxruntime-web) + linear heads from heads.json.
   Pure function of the text; no network after the one-time model download. Copy this file by hand into each app. */
import { makeTokenizer } from "./wordpiece.js";
export async function loadGuard({ modelUrl, tokenizerUrl, headsUrl, ort }) {
  const [heads, tokJson] = await Promise.all([fetch(headsUrl).then((r) => r.json()), fetch(tokenizerUrl).then((r) => r.json())]);
  const tok = makeTokenizer(tokJson, 256);
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  return { heads, score: (text) => score(session, tok, heads, ort, text) };
}
export function meanPool(hidden, mask, seq, dim) {
  const out = new Float32Array(dim); let n = 0;
  for (let t = 0; t < seq; t++) { if (!mask[t]) continue; n++; for (let d = 0; d < dim; d++) out[d] += hidden[t * dim + d]; }
  let norm = 0; for (let d = 0; d < dim; d++) { out[d] /= Math.max(n, 1); norm += out[d] * out[d]; }
  norm = Math.sqrt(norm) || 1; for (let d = 0; d < dim; d++) out[d] /= norm;
  return out;
}
export function applyHeads(emb, heads) {
  const logits = heads.label.coef.map((w, i) => w.reduce((s, wj, j) => s + wj * emb[j], heads.label.intercept[i]));
  const m = Math.max(...logits); const ex = logits.map((l) => Math.exp(l - m)); const z = ex.reduce((a, b) => a + b, 0);
  const probs = Object.fromEntries(heads.label_classes.map((c, i) => [c, ex[i] / z]));
  const tactics = Object.fromEntries(Object.entries(heads.tactics).map(([k, h]) => [k, 1 / (1 + Math.exp(-(h.coef.reduce((s, wj, j) => s + wj * emb[j], h.intercept))))]));
  const p_scam = probs.scam;
  const level = p_scam >= heads.threshold ? "hold" : p_scam >= heads.threshold * 0.5 ? "caution" : "clear";
  return { probs, p_scam, tactics, level };
}
async function score(session, tok, heads, ort, text) {
  const enc = tok.encode(String(text).slice(0, heads.max_chars || 400));
  const ids = enc.ids; const mask = enc.attentionMask; const seq = ids.length;
  const feeds = {
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, seq]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(mask.map(BigInt)), [1, seq]),
  };
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(seq), [1, seq]);
  const out = await session.run(feeds);
  const hidden = out[session.outputNames[0]]; const dim = hidden.dims[2];
  return applyHeads(meanPool(hidden.data, mask, seq, dim), heads);
}
