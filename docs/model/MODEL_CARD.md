# Guard-lab model card (draft, 9 Nov 2026)

Two models, trained on the author's laptop (Apple M4 Pro, MPS), exported for the browser. Numbers below are from
`reports/*.json`; every figure that comes from author-written or synthetic data says so.

## 1. Scam text model
- **Base**: `sentence-transformers/all-MiniLM-L6-v2` (22M params). SetFit contrastive fine-tune on scam vs not, then
  linear heads: 3-way label (genuine / marketing / scam) and nine tactic sigmoids. Multilingual MiniLM-L12 was trained
  as well and matched it on accuracy at five times the size, so the English model ships.
- **Training data**: about 80k deduplicated messages. Real SMS, Telegram and email spam/scam corpora (see
  `SOURCES.md`); tactic labels for five tactics come from the ScamShield 86k corpus, four more are **weak labels** from
  regex seeds; 600 **author-written** business-scam/hard-genuine rows (template split).
- **Export**: ONNX, int8 per-channel dynamic quantisation, 23 MB. Heads are refit on the quantised graph's own
  embeddings so the browser and Python agree (parity test in `browser/parity.test.mjs`).
- **Threshold**: chosen so 1% of genuine validation messages are held.

Round-2 results (10k fine-tune rows, business templates in training, heads refit on the int8 ONNX graph's own
embeddings; `reports/text_minilm-l6-r2_onnxheads.json`), AUC unless stated:

| Frozen set | n | AUC | Catch rate at 1% genuine held | Note |
|---|---|---|---|---|
| ScamShield 86k test | 8,188 | 0.988 | 75% | real SMS, in-distribution (round 1: 0.984 / 64%) |
| ScamShield eval sets | 1,574 | 0.979 | 67% | real + hand-written |
| Singlish genuine slice | 600 | n/a | 1.0% held | real Singaporean SMS |
| Business templates (held-out templates) | 200 | 0.85 | 11% | author-written; 0% of hard-genuine held |
| Dialogue transcripts | 640 | 0.72 | 7% | AI-written phone dialogues: out of distribution |
| BEC seed emails | 200 | 0.58 | 25% (15% genuine held) | hand-written business emails: **effectively unlearned** |

Browser parity (`browser/parity.test.mjs`, 200 messages, same int8 graph in onnxruntime-node vs Python
onnxruntime 1.31.1): token ids identical; hold/clear decision flips 3/200, caused by int8 kernel differences
between runtimes, not by the model. Treat a score within ±0.05 of the threshold as "caution", never as a hard verdict.

Known weaknesses: catch rate at a strict 1% hold budget is about two thirds; long dialogues and business email are
weak; four of nine tactics are weak-labelled with low precision. None of this model's outputs can approve a payment;
it only raises the hold level that the money gate then enforces.

## 2. Payment-risk model
- LightGBM, 300 trees, monotone constraints: every scam-tactic feature and "details changed" can only raise risk.
- **Training data is synthetic**, generated from scenario parameters in `scripts/train_risk.py` that follow the mix
  Legacy Protection documented from FTC / FBI IC3 reports. There is no real payment-fraud data in this project.
- Exported as JSON (`models/risk/risk_lgbm.json`), evaluated in plain JavaScript (`browser/risk-client.js`),
  monotonicity re-checked in JS. Any AUC quoted for this model is on synthetic data and says nothing about real fraud.

## 3. What is not here
No voice-scam audio model (transcripts are scored as text). No Southeast Asian scam-language data beyond genuine
Singlish. No real payment-risk data. No prompt-injection classifier (the apps quarantine untrusted text in code).
