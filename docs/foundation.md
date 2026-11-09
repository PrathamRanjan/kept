# Kept foundation and widening (roadmap Part B and C.5), November 2026

- **B.1 Model brain** `src/ai/provider.ts`, `src/brain/` (`KEPT_BRAIN=openai`: plan and rule drafting grounded to quotes, reason classification with quarantine, offer-wording check, owner Q&A); every call in `ai_calls`; forbidden-field list checked in `test/structural.test.ts`.
- **B.2 Traces** `src/trace.ts`; `/trace/:id`, `/dashboard/traces`, `/runs`, `/runs/:id`, `/subscriptions/:ref/runs`, `/api/v1/runs`, MCP `get_trace`.
- **B.3 Dry-run gate** `src/guard/dryrun.ts` (kill switches, integer money, provenance, owner rules, autonomy limits, compliance scorecard, live PayPal state); a cancel is never held or denied except by the global kill, and then retried.
- **B.4 / B.5 Evals** `src/eval/reasons.ts` (36 labelled reasons, held-out ids in `eval/reasons-heldout.json`, arms rules/model/oracle), `src/eval/adversarial.ts` (26 hostile moves), `src/eval/fairness.ts`; `/dashboard/eval` explorer with chips and `/dashboard/eval.csv`, `/dashboard/eval/:suite.md`, `POST /dashboard/eval/run`; `npm run eval:reasons`, `npm run eval:adversarial`.
- **B.6 Owner trust** `src/web/guard.ts` + `src/guard/` (`/dashboard/guard`: fairness scorecard, 90-day backtest with sliders, suggestions, approvals with passkey countersign above `KEPT_COUNTERSIGN_ABOVE_CENTS`, kill scopes, hash-chained audit at `/dashboard/guard/audit.json`).
- **B.7 PayPal depth** subscriptions and plans, failed-renewal recovery, capture, invoices (`POST /api/v1/subscriptions/:ref/invoice`, `/dashboard/money/invoices/check`), Transaction Search and balances (`/dashboard/money`), `PayPal-Mock-Response` negative tests, webhook simulator, reconcile.
- **B.8 Channels and PWA** `src/channels/` (Telegram, WhatsApp, simulator `/dashboard/channels`, web push), `/manifest.webmanifest`, `/sw.js`, `/push/*`.
- **B.9 Structural tests** `test/structural.test.ts`.
- **B.10 Evidence and judge mode** `/dashboard/evidence`, `/judge`, `/judge/reset`.
- **Agent surface** `src/mcp/` owner MCP (read-only additions `recent_runs`, `search_transactions`, `compliance_scorecard`, `fairness`, `pending_approvals`), storefront MCP; `/skill.md`, `/llms.txt`, per-shop `/s/:slug/llms.txt`; `npm run cli`.
- **C.5 Kept K1–K5** reasons eval, compliance scorecard per jurisdiction (`/dashboard/compliance`, sources in `docs/compliance.md` marked [verify]), earned autonomy, calendar (`/dashboard/calendar.json`), money desk.

Simulated or not built: chat delivery without tokens; push without VAPID keys; WebAuthn attestation; per-judge isolation beyond the session. Eval numbers are regression suites on labelled synthetic reasons; compliance sources need verification by a person.
