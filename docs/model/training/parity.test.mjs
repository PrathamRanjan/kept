// Node parity test: the browser scorer (onnxruntime-node here, same graph) must agree with Python on the hold decision for at least 97% of messages (int8 kernels differ between runtimes, so exact scores do not match).
import { readFileSync } from "node:fs";
import ort from "onnxruntime-node";
import { makeTokenizer } from "./wordpiece.js";
import { meanPool, applyHeads } from "./guard-client.js";
const tag = process.argv[2] || "minilm-l6"; const qdir = process.argv[3] || "onnx-int8-pc"; const maxLen = 256;
const heads = JSON.parse(readFileSync(`models/${tag}/heads.json`, "utf8"));
const tok = makeTokenizer(JSON.parse(readFileSync(`models/${tag}/${qdir}/tokenizer.json`, "utf8")), maxLen);
const session = await ort.InferenceSession.create(`models/${tag}/${qdir}/model_quantized.onnx`);
const sample = JSON.parse(readFileSync(`models/${tag}/parity_sample.json`, "utf8"));
let maxDiff = 0, n = 0, flips = 0; const t0 = Date.now();
for (const { text, p_scam } of sample) {
  const enc = tok.encode(text.slice(0, heads.max_chars));
  const ids = enc.ids, mask = enc.attentionMask, seq = ids.length;
  const feeds = { input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, seq]), attention_mask: new ort.Tensor("int64", BigInt64Array.from(mask.map(BigInt)), [1, seq]) };
  if (session.inputNames.includes("token_type_ids")) feeds.token_type_ids = new ort.Tensor("int64", new BigInt64Array(seq), [1, seq]);
  const out = await session.run(feeds); const h = out[session.outputNames[0]];
  const r = applyHeads(meanPool(h.data, mask, seq, h.dims[2]), heads);
  maxDiff = Math.max(maxDiff, Math.abs(r.p_scam - p_scam)); if ((r.p_scam >= heads.threshold) !== (p_scam >= heads.threshold)) flips++; n++;
}
console.log(JSON.stringify({ tag, qdir, maxLen, n, max_abs_diff_p_scam: +maxDiff.toFixed(5), hold_decision_flips: flips, ms_per_message: +((Date.now() - t0) / n).toFixed(1), pass: flips <= Math.ceil(n * 0.03) && maxDiff < 0.25 }));
