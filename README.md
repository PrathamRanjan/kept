# Kept

**PayPal subscriptions that AI agents can manage, and that small shops can keep fairly.**

Kept gives a small subscription business (a coffee club, meal-prep kitchen, farm box, gym or newsletter) an agent endpoint for its PayPal subscriptions. A buyer's AI agent can subscribe, skip, pause, switch plans or cancel in one call. Before a cancel, the shop's own agent may make **one** fair offer within rules the owner wrote in plain words. **Cancelling is never blocked.** Failed renewals are chased and collected, and everything is reconciled with PayPal.

Built for the PayPal AI Hackathon. Runs on the **PayPal sandbox**; no real money moves.

---

## Why

Buyer agents (Claude, ChatGPT and the rest) are starting to shop and manage accounts for people. Small merchants have no agent-facing way to handle subscriptions, and today's retention flows are web forms built for humans, many of them dark patterns. Kept is the merchant-side counterpart: a standard endpoint agents can use, with fairness enforced in code.

## What it does, end to end

| Step | Who | What happens | PayPal |
|---|---|---|---|
| 1. Set up | Owner | Types plans ("Signature bag $24 monthly; Half bag $12 monthly") and rules ("one skip per quarter; pause up to 2 months; at most 15% off for 3 months"). Kept shows exactly what it understood; the owner approves the exact version. | Catalog Products, Billing Plans (incl. discount plans) |
| 2. Subscribe | Buyer's agent → human | Agent finds the shop over MCP (`find_shops`), quotes a plan, calls `start_subscription` and gets a PayPal approval link. The human approves on PayPal's own page. | Subscriptions create, approval redirect, read-back |
| 3. Change | Agent or subscriber | `skip_next`, `pause`, `resume`, `switch_plan`, within the owner's rules. Skips and pauses resume automatically on schedule. | Subscriptions suspend / activate / revise |
| 4. Cancel fairly | Agent or subscriber | `cancel_subscription` cancels in one call. Only with `hear_offer=true` does the shop's agent make one offer; declining, ignoring or letting it expire cancels at once. | Subscriptions cancel / revise / suspend |
| 5. Failed renewal | Automatic | Verified `PAYMENT.FAILED` webhook → the subscriber (or their agent) is told how to fix it → `payment_fixed` collects the outstanding balance. | Webhooks + signature verification, capture outstanding |
| 6. Reconcile & report | Owner | Daily reconcile re-reads every live subscription and its transactions. Dashboard: MRR, revenue kept, offers, cancels honoured, agent share, Bryntum renewal calendar, and "ask your shop" answers. | Subscription transactions, Transaction Search |

## The fairness rules, enforced in code

- **One-call cancel.** `cancel_subscription` completes even if the offer step fails. There is no "are you sure" loop.
- **One offer, optional.** Offers are only made when asked for (`hear_offer=true`, or the subscriber ticks a box). One open offer at most, one accepted offer per cooldown period (default 180 days, owner-set).
- **The AI only chooses; code decides.** Eligible offers are computed deterministically from the approved rules, tenure, skip history and cooldown (`src/policy/eligibility.ts`). The brain may only pick one of those IDs and word it. It cannot invent offers or prices.
- **Quality complaints get no bribe.** If the reason is quality, no discount is offered; the feedback goes to the owner.
- **Owners can't write dark patterns.** `neverBlockCancel` is a literal `true` in the rules schema; "make it hard to cancel" is ignored with a warning.

## Architecture

```
Buyer agents ──MCP──┐
Owner dashboard ────┼──► Web service (Express): app, MCP (/mcp, /s/:slug/mcp, /owner/mcp), REST (/api/v1), webhooks
Owner's own agent ──┘            │
                                 ├──► Executor: the ONLY code that writes to PayPal; PayPal-Request-Id on every write;
                                 │    read-back after every write; only the read-back updates Kept's state
                                 ├──► Brain (proposes, never acts): drafts plans/rules, classifies reasons, picks among eligible offers
                                 └──► Postgres (PGlite locally): merchants, plans, policies, subscribers, offers, event log, jobs
Worker: verified webhooks, scheduled resumes, discount reverts, offer expiry, payment follow-ups
Cron: daily reconcile with PayPal
```

Key files: `src/executor.ts` (PayPal writes + read-back), `src/service.ts` (every operation), `src/policy/` (rules schema and eligibility), `src/brain/local.ts` (the deterministic brain), `src/mcp/tools.ts` (agent tools), `src/paypal/client.ts` (typed PayPal REST client), `src/webhooks.ts`, `src/worker.ts`.

### PayPal APIs used

| API | Used for |
|---|---|
| OAuth 2.0 client credentials | All server calls (token cached) |
| Catalog Products `POST /v1/catalogs/products` | One product per shop |
| Billing Plans `POST /v1/billing/plans` | Regular, lighter and discount plans |
| Subscriptions create / get | Start, approval link, read-back after every change |
| Subscriptions suspend / activate | Skip, pause, scheduled resume |
| Subscriptions revise | Plan switch, discount offer, discount revert (returns PayPal's consent link when needed) |
| Subscriptions cancel | One-call cancel |
| Subscriptions capture | Collect the outstanding balance after a failed renewal |
| Subscription transactions | Reconciliation and "collected in 30 days" |
| Webhooks create / list / verify-webhook-signature | Verified events; unverified events are stored but never acted on |
| JavaScript SDK subscription buttons | Human checkout on the shop page (server-created subscription) |
| Log in with PayPal (OpenID Connect) | Optional owner sign-in (`KEPT_LIPP_ENABLED=true`, needs the return URL set on the PayPal app) |
| Payments sale refund | Client method for goodwill refunds (not yet exposed in the UI) |

### AI

The product calls **no model API** today, by design for this stage: `KEPT_BRAIN=local` is a deterministic implementation of the `Brain` interface (`src/brain/types.ts`). It reads plain-words plans and rules, classifies cancellation reasons, picks among code-computed eligible offers, words messages and answers owner questions from live stats. An LLM implementation can be dropped in behind the same interface (`KEPT_BRAIN=anthropic` is reserved). Either way the brain only proposes: code validates, the owner approves, the executor acts.

The **agent-facing** side is fully AI-native: any MCP client (Claude Desktop, Claude Code, other agents) can use the shop.

### Sponsor tools

- **Render:** `render.yaml` blueprint with a web service, a background worker, a daily cron job and Postgres.
- **Bryntum Calendar:** the owner's renewal calendar (renewals, pauses with resume dates, discount end dates, payment follow-ups). Uses the public trial build.
- **APIMatic:** `docs/openapi.yaml` is ready for APIMatic SDK and portal generation.
- **Postman:** `docs/kept.postman_collection.json` walks the REST flow.

## Run it locally

Requires Node 22+. No database to install: locally Kept uses PGlite (Postgres compiled to WebAssembly) in `./data`.

```bash
git clone <this repo> kept && cd kept
npm install
cp .env.example .env        # add your PayPal sandbox client id and secret
npm run seed                # creates the demo shop's real sandbox plans and rules (no sample members)
npm run build && npm start  # http://localhost:3000
```

Then:

1. Open http://localhost:3000 → **Open the demo shop dashboard**.
2. Open the shop page and subscribe with a PayPal **sandbox personal** account, or run the scripted buyer agent:
   ```bash
   npm run agent:demo -- start       # prints a PayPal approval link
   npm run agent:demo -- lifecycle   # after approving: skip, resume, switch, cancel with one offer
   ```
3. Connect a real agent: `claude mcp add --transport http kept http://localhost:3000/mcp`

Tests (in-memory Postgres and a fake PayPal that models the subscription state machine):

```bash
npm test
```

## Deploy on Render

1. Push this repo to GitHub.
2. Render → New → Blueprint → select the repo (uses `render.yaml`).
3. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `APP_URL` (the web service URL) in the `kept-shared` group.
4. Run `npm run webhook:register` with `APP_URL` set (or click **Register webhook** in the dashboard) and set `PAYPAL_WEBHOOK_ID`.
5. Open a Render shell on the web service and run `npm run seed` for the demo shop.

## What's live and what isn't

Nothing in Kept is simulated and there are no sample members: every member is a real PayPal sandbox subscription, and every number is read from them.

| Part | Status |
|---|---|
| Products, plans, subscriptions, approval, suspend, activate, revise, cancel | Live PayPal sandbox calls, read back after every write |
| Webhooks | Live and signature-verified; unsigned events are refused |
| Buyer agents | Real MCP clients |
| Renewals | Real; the demo shop has a $1 **daily** plan so a renewal happens within a day |
| Failed renewal, balance capture, invoices | Real code, run only when PayPal reports a failed renewal (verified `BILLING.SUBSCRIPTION.PAYMENT.FAILED` webhook or read-back). There is no switch to fake one |
| Backtest and fairness scorecard | Computed from the shop's own records; a new shop shows an empty history |
| Telegram | Live when `TELEGRAM_BOT_TOKEN` is set and a chat is linked from the member page |
| Web push | Live when VAPID keys are set and a browser turns notifications on |
| WhatsApp | Code present; not live without a WhatsApp Cloud API token |
| Log in with PayPal | Code present; off until the feature is enabled on the sandbox app (`PAYPAL_LOGIN_ENABLED`) |
| SMS (Twilio) | Renewal reminders, payment notices and owner approvals by text, each with a link back to the page. A number is linked only after the person types back a 6-digit code Kept texts them; STOP is honoured. Live when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM_NUMBER` are set. Replies reach Kept only if the number's messaging webhook points at `/webhooks/twilio` (signature-checked) |
| Phone calls | Not part of Kept |

## Licence

MIT

## Changes on 8 Nov 2026

From the six-product review and implementation plan (https://claude.ai/artifact/5sDaBKUfMziPvxnTwDfswc). 43 tests pass; each change below has a test on the fake PayPal; cancellation was re-run live (below).

- Cancellation is a durable command: if PayPal fails or doesn't confirm, the subscriber shows "cancellation pending" and a job retries with the same key until PayPal reads back CANCELLED. A direct cancel closes any open retention offer instead of being blocked by it.
- A discount that needs the subscriber's PayPal approval starts its promotion dates, and counts as kept, only after PayPal shows the new plan.
- New: policy replay. Previewing new rules shows which recent cancellation requests would get a different offer.
- New: payment promise. After a failed renewal the subscriber can pick a date (within 14 days); reminders pause until then and one follow-up goes out if it passes unpaid.

### Live rerun on the 8 Nov code (checked against the PayPal Subscriptions API with `scripts/pp-sub-check.mts`)

- The scripted buyer agent subscribed over MCP; the sandbox buyer approved; subscription `I-B6H0JEY58STE` ACTIVE ($1.00 first payment).
- Lifecycle over MCP: skip (SUSPENDED; replayed key did nothing more), resume (ACTIVE), switch to the Signature bag plan (`P-85C055441B925353UNLXC7VY`).
- Cancel with one offer (2-cycle pause), declined, cancelled through the new durable path; PayPal reads back **CANCELLED** (2026-11-08 09:34:59 UTC).
- Not run live: the consent-pending discount (needs a second subscriber approval) and the payment promise (no PayPal call).

## Review fixes (9 Nov 2026)

From the 8 Nov independent review: each defect its probes reproduced is fixed, and each probe is now a regression test that checks the correct behaviour (test/review.test.ts). 51 tests pass. These fixes are tested on the fake PayPal; they have not been re-run live on the sandbox yet.

- A cancellation intent is stored in its own column: a failed PayPal read can't erase it.
- Cancellation retries never stop (capped backoff); the owner is alerted after five failures.
- A failed offer acceptance keeps the offer's expiry, so the cancellation the subscriber asked for still happens.
- Policy replay uses the same cooldown and skips a real request saw at that moment.
- A promise-to-pay follow-up rescheduled during the quiet period is no longer marked done and lost (the job runner keeps a job its handler rescheduled).
- A scheduled discount counts as kept, and its period starts, only once PayPal shows the new plan.
- Starting twice with the same key returns the same subscription.
- The subscriber's own page shows "Cancellation pending" while PayPal hasn't confirmed it.

## Foundation and widening (9 Nov 2026)

Roadmap Parts B and C for Kept, all behind tests (`npm test`: 71 tests, including a foundation walk that touches every new route with no 5xx). Nothing here lets a model touch money: the model drafts, classifies and words; code decides and PayPal is only ever called from the executor behind the gate.

- **Model brain (B.1)**: `KEPT_BRAIN=openai` with `OPENAI_API_KEY` turns on model drafting of plans and rules (prices grounded to a quote from the owner's text), reason classification with instruction text quarantined first, offer wording checked for invented numbers, and owner Q&A. Every call is logged in `ai_calls` with cost and latency; without a key the deterministic rules brain runs and the evidence page says so. Schemas are checked against a forbidden-field list (`new_price`, `plan_id`, `paypal_*`…) in code and in a structural test.
- **Traces (B.2)**: every action is a run with steps (actor, tool, redacted args, rule hit, gate decision, PayPal request id, ms). `/trace/:id`, `/dashboard/traces`, `/api/v1/runs`, MCP `get_trace` (ownership checked). Writes return `run_id`.
- **Dry-run gate (B.3, K3)**: `src/guard/dryrun.ts`. Checks kill switches, integer money and provenance, the owner's rules, autonomy limits (discount %, pause cycles, capture threshold), the compliance scorecard, and live PayPal state before any write. Outcomes: allowed, denied, dry_run_refused, held (approval row, owner notified with Approve/Decline buttons). A cancel is never held or denied by rules, autonomy, an agent or merchant kill switch; only the global kill, and then it is marked pending and retried.
- **Earned autonomy and backtest (K3)**: `/dashboard/guard` shows the fairness scorecard (one-call cancel rate, offers made vs accepted, time to cancel, measured from the shop's own event log), a backtest that replays the shop's real cancellation requests from the last 90 days with what-if sliders (run / wait / deny, dollars kept automatically vs held), suggestions to raise limits after held moves kept being approved, pending approvals (passkey countersign above `KEPT_COUNTERSIGN_ABOVE_CENTS`), kill switches (global, merchant, agent, all agents), and a hash-chained audit log.
- **Compliance scorecard (K2)**: `/dashboard/compliance` scores the policy per jurisdiction (ROSCA, CA, CO, NY; EU/UK informational). A failing rule blocks the offer step in the gate. Plain-words rules that ask for the forbidden ("three offers before cancel", "must call to cancel") are refused with the citation. Sources are listed in `docs/compliance.md`, each marked [verify].
- **Evals (B.4, B.5, K1)**: `/dashboard/eval` and `npm run eval:reasons` (36 labelled cancel reasons with money-word, injection and mixed traps, held-out ids frozen in `eval/reasons-heldout.json`; arms rules / model / oracle; dollars a naive tool would wrongly give away vs Kept; cost; p50/p95) and `npm run eval:adversarial` (26 hostile moves through the gate and service layer; none reach PayPal; kill switches restored). CSV export and an explorer with chip filters.
- **Channels and PWA (B.8)**: Telegram and WhatsApp webhooks; every notice is also kept in the in-app message log at `/dashboard/channels`, and a channel without credentials is logged as "not sent"; subscribers get failed-renewal messages with "I fixed it" / "Cancel instead" buttons; owners get held approvals with Approve / Decline. `link subscriber:<ref>` / `link owner:<key>` binds a chat. Web manifest, service worker and push subscription (needs VAPID keys and a browser that turns notifications on).
- **Money desk (K5)**: `/dashboard/money`: Transaction Search and balances (read-only, also MCP `search_transactions`), Invoicing v2 for outstanding balances (`POST /api/v1/subscriptions/:ref/invoice`, status read back by the worker), `PayPal-Mock-Response` negative tests, the webhook simulator, renewal reminders (`renewalReminderDays`). Owner clicks are their own approval; agent-initiated captures and invoices above the threshold are held.
- **Judge mode (B.10)**: `/judge` walks six beats in an isolated session. **Evidence**: `/dashboard/evidence` labels each capability live, not configured or not wired, with counts.
- **Agent surface**: owner MCP adds `recent_runs`, `search_transactions`, `compliance_scorecard`, `fairness`, `pending_approvals` (all read-only); `/skill.md` and `/llms.txt` describe the guarantees; `npm run cli -- …` is a shell client over the API.

Waiting on keys (add to `.env`, nothing else to wire): `TELEGRAM_BOT_TOKEN`/`TELEGRAM_WEBHOOK_SECRET`, `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_ID`, `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `PAYPAL_LOGIN_ENABLED=true` once the sandbox app has Log in with PayPal. The APIMatic developer portal for `docs/openapi.yaml` is also parked until you have the account.

## Scam and fraud protection (9 Nov 2026)

The people at risk are subscribers, including older people who forget. Three layers, strictest wins, none can move money (`SAFETY_ACCESSIBILITY_SPEC.md` §4, Kept row of §6):

- **No "pay here" links, ever.** Kept never sends one, so the rule is simple: a message that says a payment failed and sends the reader somewhere to pay is named `fake_failed_payment` and explained in plain words. Every subscriber's manage page says so and links to a check page (`/manage/<ref>/check`) that scores a pasted message in their browser.
- **Rules in the gate** (`src/safety/index.ts`, called from `src/guard/dryrun.ts` step 3b for every agent or worker capture, invoice, refund and offer; never for a cancel or a person's own click): a subscriber asking for a refund to go to a different account holds the refund (`refund_to_other_account`) with the reason in the approval; protected mode (per merchant, `/dashboard/safety#protected`) holds every agent money move and offer and tells a trusted contact.
- **Scam text model in the browser** (`public/safety/`, 23 MB int8 ONNX, fine-tuned MiniLM) on the owner's and the subscriber's pages. Advisory; its score never reaches the gate. **Payment-risk model** (`public/safety/risk_lgbm.json`): monotone LightGBM, **trained on synthetic data**, a ranking signal shown with the rule reasons.

Tests: `test/safety.test.ts`; the model's measured results are on `/dashboard/safety/model-card`.

## Accessibility (9 Nov 2026)

`public/a11y.js` and `public/a11y.css` on every page, the subscriber's included: a **Display and help** button with text size, high contrast, Atkinson Hyperlegible, read-aloud, voice input (on-device where the browser supports it), plain words, bigger targets, more time and no motion. A first-visit card offers the same choices. The profile stays in this browser's `localStorage`; typing and buttons always work without it. Offers on the manage page carry no timers.

## Wave 1 of the master improvement spec (10 Nov 2026): acceptance log

Each item was built, tested, deployed to https://pph-kept.onrender.com and then checked on the live site. Results are recorded as they happened, including what failed or could not be verified.

### 1. A2.1 Saved demo wallet

- **Built:** Vault v3 calls (read a payment token, create a setup token, exchange it for a payment token), a daily `wallet_check` job, and `/admin/paypal/wallet` (admin key only) with "check with PayPal now" and a re-approval flow that reads the new token back before saving it. Settings: `PAYPAL_DEMO_VAULT_TOKEN`, `PAYPAL_DEMO_BUYER_EMAIL`, `KEPT_ADMIN_KEY` (local `.env` and Render; values never printed).
- **Live check (commit `ad4952b`, 10 Nov 14:06 UTC): passed.** `/admin` without the key returns 401. With the key, `/admin/paypal/wallet.json?check=1` read the token back from PayPal: `ok: true`, "PayPal has the token (usage MERCHANT)", buyer `sb-kw6yh45846125@personal.example.com`, token shown masked.
- **What the wallet cannot do in Kept (probed on the sandbox before building):** PayPal Subscriptions do not accept a vaulted wallet. Creating a subscription on the $1 daily plan with `payment_source.paypal.vault_id`, or with `subscriber.payment_source.token`, returned `201 APPROVAL_PENDING` with an approve link both times. So the spec's "main money loop with no login" (A2 acceptance) is met in Kept through the approval pool (item 2), which needs the owner to approve subscriptions ahead of time. Not met through the wallet.
