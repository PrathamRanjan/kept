# Kept integration and hard-coding audit

10 Nov 2026. Code at `main` 8b516fc plus the fixes below on the `redesign` branch. "Live" means run against the PayPal sandbox from this session, with the evidence named.

## 1. Integration matrix

| Integration | Status | Evidence |
|---|---|---|
| PayPal OAuth (client credentials) | Live-verified | Every call below |
| Catalog Products, Billing Plans create | Live-verified | Fresh shop "Rise Sourdough Club" created two new plans from plain words ($18.25 monthly, $7.50 every 2 weeks); local seed created P-9L298387VB698803CNLZBGQA and two more |
| Subscriptions create + approval | Live-verified | I-0KYH3B8BGX18, approved by the sandbox buyer; buyer activity shows "−$18.25 USD, 10 Nov, Automatic Payment" |
| Subscriptions suspend / activate (skip, resume) | Live-verified | Same subscription: SUSPENDED with resume 10 Dec 11:00 UTC, then ACTIVE |
| Subscriptions revise (switch) with PayPal consent | Live-verified | Switch to Starter kit returned a consent link; approved on PayPal; PayPal plan now P-8UJ66172GW551501TNLZBHEY |
| Subscriptions cancel (durable, read-back) | Live-verified | Run `run_7sfwebsvsvig7rui`; PayPal reads back CANCELLED at 2026-11-09T18:43:17Z (`scripts/pp-sub-check.mts`) |
| Subscriptions capture (outstanding) | Wired, tested on the fake; not run live this session | Needs a real failed renewal; sandbox can't force one on a card |
| Subscription transactions / reconcile | Live-verified | Reconcile ran at sign-up; last payment 18.25 read back |
| Transaction Search | Live-verified (read-only) | `/dashboard/money/transactions.json` on the live site returned sandbox transactions (e.g. 9HE16970CB351433P, $1.00, T0002) |
| Invoicing v2 | Wired; not exercised live (live page shows "No invoices yet") | Gated like a capture |
| Webhooks + signature verification | Live-verified on Render | Live event log: `BILLING.SUBSCRIPTION.ACTIVATED (verified)`, `PAYMENT.SALE.COMPLETED (verified)` on 9 Nov; an unsigned POST to `/webhooks/paypal` is rejected with 400 |
| PayPal JS SDK subscription buttons | Wired on the shop page | Used when the server app's client id is set |
| Log in with PayPal | Not wired on this deployment (`PAYPAL_LOGIN_ENABLED` off) | Needs the feature on the sandbox app |
| Payments v2 refund | Client method only; not exposed | — |
| Vault, Payouts, Disputes, Orders v2 authorize/capture/void/reauthorize | Not used by Kept (subscriptions product) | — |
| OpenAI (model brain) | Live on Render and locally | Fresh rules drafted by the model parsed correctly (skip 1/30 days, pause 3, 20% for 2 cycles, 30-day tenure, 180-day cooldown); cancel reason classified `price` via model (`run_7sfwebsvsvig7rui` step 1); live evidence page: 3/3 model calls ok |
| MCP server (buyer, directory, owner) | Live-verified | `tools/list` on the live shop returns 13 tools; `find_shops` returns the demo shop |
| Telegram | Bot token set on Render; evidence page "bot connected · 0 chats linked" | Outbound works once a chat is linked. The shared bot's webhook points at another service, so a member's Start tap reaches Kept only if that service forwards `kept-<code>`; not yet confirmed |
| Web push | VAPID keys set on Render; not driven this session | — |
| WhatsApp | Code present, no token | Not live (messages to WhatsApp would be logged "not sent") |
| Twilio, Channel3 | Not wired | — |
| AG Grid | Not used before the redesign | Added in the redesign for the members table (see REDESIGN_REPORT) |
| Bryntum Calendar | Live (trial build from jsDelivr) | Renewal calendar on the owner dashboard |
| APIMatic | `docs/openapi.yaml` only; no portal or SDK generated | — |
| Render | Live: one web service `pph-kept` (srv-dbopi3rm8hqs73elblcg) with the worker inline, shared Postgres | `render.yaml` describes web + worker + cron + Postgres, but the deployed service is a single web service; the cron is replaced by the inline worker's daily reconcile |

## 2. Hard-coding hunt

| Finding | Where | Verdict | Action |
|---|---|---|---|
| ~30 seeded sample subscribers, offers, feedback | `scripts/seed.ts` | Was labelled scaffolding; still not real | **Removed** (10 Nov, e53e013): the seed script creates no members, and a startup migration deletes sample rows from Kept's schema. Every member is a real sandbox subscription |
| Headline KPIs (active members, monthly revenue) added sample rows to live rows | `svc.computeStats` | **Misleading** (P1): "$X a month" mixed labelled samples with PayPal-billed members | Fixed: stats now also return `live.{active,suspended,mrr}`; the new owner screen leads with the live figure and shows the sample count beside it |
| "Simulate failed renewal" button | `routes.ts`, `svc.simulateFailedPayment` | Recorded a failure PayPal never reported | **Removed** (10 Nov, e53e013) with its routes. Failures come only from the verified webhook or read-back |
| "Fail the next PayPal cancel" fault lab | `paypal/faults.ts` | Injected a fake PayPal error | **Removed** (10 Nov, e53e013); the durable-cancel retry is covered by tests using the fake client |
| Fake PayPal client | `paypal/fake.ts` | Tests only: reachable only through `setPayPalFactory`, which production never calls | No action |
| `KEPT_BRAIN=local` in `render.yaml` and `.env.example` defaults | config | The deployed service sets `KEPT_BRAIN=openai` with a key (evidence page says "live (OpenAI)"); `render.yaml` would deploy rules-only | Fixed `render.yaml` default to `openai` |
| 90-day backtest history | `guard/backtest.ts` | Invented requests | **Removed** (10 Nov, e53e013): the backtest replays only the shop's real cancellation requests from the last 90 days |
| Dark-pattern baseline on the fairness scorecard | `guard/backtest.ts` | Modelled, not measured | **Removed** (10 Nov, e53e013): the scorecard shows only measured figures |
| PayPal-Mock-Response negative tests, webhook simulator, in-app message simulator | `foundation.ts`, `paypal/client.ts` | Not real traffic | **Removed** (10 Nov, e53e013). Notices go to linked channels plus an in-app record; a channel without credentials is logged "not sent" |
| Fixed dates or frozen clock | none found outside tests | — | — |
| Canned AI outputs | `brain/local.ts` is a deterministic fallback, used only when the model call fails, and the trace says `via: rules` | Legitimate | — |
| `/judge` picks the oldest merchant, not the demo shop | `web/foundation.ts` | Bug (P2): if anyone onboards first on a fresh database the story points at the wrong shop | Fixed: uses `KEPT_DEMO_SHOP` / the demo slug first |
| **Pause offer never made when the rules allow more cycles than the owner's autonomy** | `policy/eligibility.ts` | **Wrong result (P0 for the core promise)**: the fresh shop's rule "pause up to 3" with the default 2-cycle autonomy meant the offer step always offered a 3-cycle pause, the gate held it, and the subscriber who asked to hear an offer got none (trace steps 2–3 of `run_7sfwebsvsvig7rui`) | Fixed: the pause offer is clamped to the owner's autonomy (`maxPauseCycles`); test `test/audit.test.ts` AU-1 |
| Switch flash message printed a raw PayPal URL as text | `/manage/:ref/switch` | P2 | The new member page shows an "Approve on PayPal" button instead |
| Cancel with `hear_offer` and no eligible offer said only "Cancelled" | member page | P2: the subscriber asked for an offer and was not told why none came | New member page says no offer applied, so it cancelled as asked |

## 3. Fresh-data test (10 Nov, local server on the PayPal sandbox)

New shop "Rise Sourdough Club" → plans typed in plain words ("Starter kit $7.50 every 2 weeks / Baker box $18.25 monthly") → model draft matched → two PayPal plans → rules typed in new words → model parse matched → approved → new subscriber "Imogen Fairweather" subscribed to Baker box → sandbox buyer approved → member page showed $18.25 per month, next payment 10 Dec 2026 → skip (SUSPENDED, resumes 10 Dec 11:00 UTC) → resume (ACTIVE) → switch to Starter kit (PayPal consent page showed $7.50; approved; member page shows "$7.50 every 2 weeks") → cancel with "pricey" and hear_offer → before the fix: no offer, cancelled; PayPal CANCELLED. Every screen used the new values. The defect it found is fixed above.

## 4. Checks

- `npm run typecheck`: clean before and after.
- `npm test`: 75/75 before; 77/77 after the audit tests (see REDESIGN_REPORT for the final count).
- `eval:*`: not re-run in this session (the live evidence page shows the stored results); the adversarial and reasons suites are unchanged by this work.
- `sandbox:check`: `scripts/pp-sub-check.mts` used for read-backs above.

## 5. Not live, and why (nothing is simulated)

Since e53e013 (10 Nov) Kept has no sample members, no fault switches, no mock PayPal responses, no webhook or message simulator, no seeded backtest history and no modelled baseline. What is still not live:

- **Failed renewal, balance capture, invoices:** the code is real, but it runs only when PayPal reports a failed renewal. The sandbox can't make one fail on demand.
- **Telegram:** the bot token is set and outbound works. No chat is linked yet, and linking depends on the shared bot forwarding `kept-<code>` to Kept.
- **Web push:** VAPID keys are set; it is live once a browser turns notifications on.
- **WhatsApp:** no WhatsApp Cloud API token.
- **Log in with PayPal:** the feature is off on the sandbox app.
- **SMS (Twilio):** live since ae0dfbb. A verification text to the demo phone was delivered (Twilio status `delivered`). Replies reach Kept only if the number's messaging webhook points at `/webhooks/twilio`; today it points at another app.
- **Phone calls, Channel3:** not part of Kept.
