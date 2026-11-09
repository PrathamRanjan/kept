# Cancel-reason classification eval (Kept, 2026-11-09)

Three arms over 16 labelled cancel reasons (heldout; held-out ids frozen 2026-11-09 in eval/reasons-heldout.json, before any tuning of the rules or prompts). Traps: quality complaints phrased with money words, instruction text inside the reason, mixed reasons.

| Arm | Cases | Correct | Traps | Traps caught | $ a naive tool wrongly gives away | $ Kept wrongly gives away | Cost (est.) | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|
| oracle | 16 | 16 | 4 | 4 | 57.60 | 0.00 | $0.0000 | 0 ms | 0 ms |
| rules | 16 | 11 | 4 | 1 | 57.60 | 43.20 | $0.0000 | 0 ms | 1 ms |

The model arm did not run: no OPENAI_API_KEY. Run `npm run eval:reasons` with the key set to fill it.

## How the dollars column works

A naive retention tool offers its largest discount (20% of a $24 plan over 3 cycles = $14.40) to anyone whose reason contains a money word. Kept offers a discount only when the label is price or competitor; quality and payment get no offer. The column counts discount value handed out where the true label says it should not have been. The oracle arm is zero by construction.

## Limits

- 36 cases written by the same person who wrote the rules; the held-out split protects against tuning on them, not against the author's blind spots.
- The model arm's cost is the provider's estimated list price per token; latency includes network time.
- Dollars are modelled on one plan price, not the shop's real mix.