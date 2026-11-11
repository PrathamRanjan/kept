# Kept

**PayPal subscriptions that AI agents can manage, and that small shops can keep fairly.**

Kept gives a small subscription business (a coffee club, meal-prep kitchen, farm box, gym or newsletter) an agent endpoint for its PayPal subscriptions. A buyer's AI agent can subscribe, skip, pause, switch plans or cancel in one call. Before a cancel, the shop's own agent may make **one** fair offer within rules the owner wrote in plain words. **Cancelling is never blocked.** Failed renewals are chased and collected, and everything is reconciled with PayPal.

Built for the PayPal AI Hackathon. Runs on the **PayPal sandbox**; no real money moves.

## For judges: try it in 60 seconds

Open **https://pph-kept.onrender.com/judge** and press **Start my demo shop**. You get a private copy of the demo coffee shop, with no sign-in. It has real PayPal sandbox subscriptions while the approval pool has some, and about 40 labelled sample members. Then pick a path. Each step ticks itself when the server sees you do it.

| Path | Time | PayPal login | What you see |
|---|---|---|---|
| Be the member's assistant | 2 min | no | An AI assistant calls Kept's MCP tools to read, pause and resume a real member's subscription. Each call and its rule appear on the work rail, and code reads PayPal back after each change. |
| Cancel in one step yourself | 1 min | no | At most one offer, and only if you ask for one. Code decides whether an offer applies. Saying no cancels the subscription on PayPal at once. |
| Run the shop | 2 min | no | The owner's Ask runs as an agent with read tools, one of them PayPal's own MCP server. A rule the law forbids is refused with its citation. The 10 Nov scam message is held by all three checks. |

| Judging criterion | Where to look |
|---|---|
| Use of PayPal | `/paypal`: every PayPal API Kept uses, when it last used each one, and the latest sandbox id |
| Use of AI | `/ai`: the last 20 model calls in the showcase shop, with inputs, tools, outputs, time and cost. `/proof`: every evaluation case |
| Safety | `/who-can-move-money`: no model can call PayPal. `/proof`: the scam check, adversarial and fairness sets |
| Accessibility | `/accessibility`: what was tested, how and when, and what was not |

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

### 2. A1 private demo workspaces, A2.2 the approval pool

- **Built:** "Try the live demo" (or any demo-owner button, or Judge Mode) creates a private copy of the showcase shop for that visitor: same PayPal sandbox product and plans, same rules and limits, 40 labelled sample members with relative dates (skips, pauses, failed renewals, cancellations, reasons, offers, one held approval that needs the owner now), and up to three real sandbox subscriptions claimed from the pre-approved pool. Each claim is re-read from PayPal, tagged at PayPal with `custom_id = "<shop>:<member>"` and recorded in `paypal_refs`. Routes: `POST /demo/start` (5 per address per hour, 300 live), `GET /demo/status`, `GET /demo/join/<token>` (QR code on the demo page and the owner bar), `POST /demo/reset` (real subscriptions move to the new copy), `POST /demo/pool/claim`. Idle expiry after 48 hours cancels each real subscription at PayPal, reads it back, and deletes the shop's rows. The showcase is read-only to visitors (no subscribing, no demo sign-in), feeds the landing preview, and is rebuilt nightly through the same seeder. Admin pages: `/admin/pool`, `/admin/workspaces`. Scripts: `scripts/pool-refill.mjs`, `scripts/sandbox-approver.mjs` (the owner runs it with the sandbox password in their own shell).
- **Isolation fixes found by the audit:** PayPal plan lookups are per shop (every copy shares the showcase's plan ids); audit rows carry the shop and each shop sees only its own; owner kill switches are scoped to the shop ("all agents" means this shop's agents; the switch for every shop is admin-only); Transaction Search shows only the shop's own subscriptions (the sandbox account is shared); the scam inbox and channel counts are per shop; running the evals is admin-only; the directory, `llms.txt` and `find_shops` leave private shops out; redirects with a backslash are refused; a daily allowance of 60 model calls per visitor shop. Sample rows are excluded from every "confirmed by PayPal" figure (members, billed, kept by offers, cancels, collected); the old boot-time purge of samples is now a one-time migration.
- **Tests:** 99 vitest (new: two workspaces side by side with every list endpoint checked for the other's rows, webhook routing, reset, admin and idle expiry with PayPal read-back, showcase rebuild, pool refill/sync/claim, rate limit, model allowance) and 16 Playwright.
- **Live check (commit `8977539`, 10 Nov 17:09–17:13 UTC): passed, with one gap.**
  - Admin rebuild of the showcase moved its one live subscription (`I-69VG1KHRR1U7`) into the pool and removed the test residue ("QC Redesign Run", Priya, and Sam's old row); the showcase now holds only the 40 labelled samples.
  - Two separate clients started demos at the same time: shops `ember-oak-6zbhek` (A) and `ember-oak-v6ojfh` (B), 40 samples each. A claimed the pool's one real subscription (read back ACTIVE, live members 1, billed $24, collected $24 from PayPal's own payment history); B got none and said so: "the pre-approved pool is empty (0 waiting for the sandbox buyer's approval). Subscribe on PayPal's own page…". Both showed the held sample approval with its Sample chip; sample figures stayed out of the live numbers.
  - Isolation: none of A's member ref, PayPal id or shop slug appeared in any of B's pages or endpoints (today, audit, kill switches, safety, guard, members, `llms.txt`).
  - An action in A: skip, then resume, on `I-69VG1KHRR1U7`. PayPal's own verified webhooks (`UPDATED` from the custom_id tag, `SUSPENDED`, `ACTIVATED`) landed in A's log and not in B's.
  - Landing preview reads the showcase (`ember-oak-coffee-club`); subscribing on the showcase returns 409 "read-only showcase".
  - Admin-forced expiry of B: 401 without the key; with it, B's shop, owner session and join link return 404 and only A and the showcase remain.
  - **Gap:** the pool held one approved subscription, so only the first visitor gets a real member. Nine more were created on the $1 daily plan and wait for the sandbox buyer's approval on `/admin/pool` (owner step; Kept never types the password). Idle expiry of a workspace that holds a real subscription was verified in tests only, so the one real pool item was not cancelled on live.

### 3. A4 Hosting: health, keep-warm, clocks

- **Built:** `/healthz` runs a query on the database and returns its latency, the commit id Render built (`RENDER_GIT_COMMIT`) and uptime, with `Cache-Control: no-store`; it returns 503 when the database does not answer. Every response carries a `Server-Timing: app;dur=…` header. Indexes for the owner list queries (offers, feedback, payments, approvals, agent runs by shop) went in with item 2. `.github/workflows/keep-warm.yml` requests `/healthz` every 10 minutes, but only once the repository variable `KEEP_WARM` is `true`. The demo rate limit now reads the client address through Express's `trust proxy` (a client can no longer pick its own address with a header).
- **Clocks:** no calendar date is written in the seed, the React pages or the server pages (searched for `2026-`/`2025-` and quoted dates). Sample dates are relative to each workspace's creation; sample offers are already decided and the one open sample item (a held approval) has no deadline. The only real-time deadline in Kept is a real offer's 60-minute window, which belongs to the product. Subscriptions renew on PayPal's own clock, so a per-workspace "+1 day" clock does not apply to Kept.
- **Live check (commit `af2ebcf`, 10 Nov 17:14 UTC):** `/healthz` returned `{"ok":true,"db":{"ok":true,"kind":"postgres","ms":1},"commit":"af2ebcf5eb39…","uptimeSec":27}`, `Server-Timing: app;dur=1.2`, `Cache-Control: no-store`. Warm first byte: `/` 0.16 s, `/demo` 0.07 s, `/s/ember-oak-coffee-club` 0.05 s, `/ui/session` 0.06 s.
- **Failed, needs the owner:** the A4 acceptance ("first byte under 2 seconds after 12 idle hours, no Render splash") cannot pass while the service is on Render's **free** plan, which sleeps after 15 idle minutes. Moving it to an always-on instance type is a purchase only the owner can make. The keep-warm workflow is committed but switched off: pinging a free service keeps it awake all month and uses up the free instance hours that all eight apps share. Turn it on with the repository variable `KEEP_WARM=true` after the upgrade.

#### Item 4: A11 no fallbacks, A5.1 model switch, A5.4 structured output, A5.5 failure state (live 5749a9b, 11 Nov 2026)

- **Passed live** (fresh workspace `ember-oak-rgzcbx`):
  - Ask is answered by `gpt-6.1-sol` and says so (4.4 s).
  - The owner rule "make it hard to cancel" is refused, citing ROSCA-1; cancelling stays one step.
  - The scam-link message is held.
  - Telegram is hidden (`ready: false`).
  - The buyer MCP `list_plans` shows about-per-month prices: the daily plan is about 30.44/month, so the Lite plan (12/month) is marked cheapest.
  - Production refuses to start without its keys (checked locally); it now runs on Render with NODE_ENV=production.
- **B5 set through the production code path** (`npm run eval:b5`, real model, in-memory PayPal): 7 of 8 passed (`eval/b5.md`).
  - Passed: the cancels with "don't try to keep me" (both with and without `hear_offer`), the burnt-coffee cancel (read as quality, no offer), the 4-cycle pause (refused, then 2 cycles accepted), and the cheapest-plan switch (to Lite).
- **Failed:** the $27 question. The answer contains the code field name `sampleRows`, and it cannot name eligible members. Item 5 (K3) fixes this.
- **Not verified live:**
  - The member cancel lines on a real member: the approval pool has 0 ready, with 9 waiting for the owner's approval.
  - The model-down failure state on the live site. It is covered by `test/ai-failure.test.ts`: 503 with a plain sentence, an unreadable reason gets no offer and the cancel goes through, and template-worded offers are labelled "code".
- **Item 4 follow-up: model-down state verified live (11 Nov 2026).** I set the model names on Render to a model that does not exist, redeployed, checked, then removed them and redeployed again.
  - Owner Ask returned 503 with "I couldn't answer that just now. Try again in a moment." in 0.5 s. No error text leaked and no rules answer was shown.
  - The rules draft page said "I couldn't read those rules just now. Try again in a moment. Press "Draft and backtest" again to retry".
  - After the models were restored, Ask answered from `gpt-6.1-sol`.

#### Item 5: K3, Ask on plain-word facts with code words rejected (live 05a7a0f, 11 Nov 2026)

- **Passed live** (fresh workspace `ember-oak-o63qax`, 40 samples, 0 real members): 5 owner questions, all answered by `gpt-6.1-sol` in 2.0–4.0 s.
  - No answer contains a backtick, camelCase or snake_case word.
  - Real and sample figures are kept apart in every answer ("these are demo results, not real retained revenue").
  - The $27 question is now answered from code-computed eligibility: "Raising Signature bag from $24 to $27 would not change who qualifies… 0 real members and 30 sample members could receive an offer… The data does not show who would stay after a price increase."
- **Tests:**
  - The model gets numbered facts, never the statistics object.
  - A code-like answer goes to the backup model; when every answer is code-like, the owner gets the failure sentence.
  - `npm run eval:b5` passes 8 of 8 with the real model.
- **Also changed:** a shop with no time zone set no longer gets the odd-hour scam signal guessed from UTC; the signal is skipped until the owner sets one.

#### Follow-up fixes after Wave 1 (live 85993fc, 11 Nov 2026)

Each fix below closes a finding from `docs/STATE_OF_THE_UNION.md` (10 Nov) or a Wave 1 gap. Each was checked on the live site.

- **Expiry no longer throws away approved subscriptions.** Expiring a demo shop now returns a still-live real subscription to the pool instead of cancelling it.
  - Live: the workspace holding `I-69VG1KHRR1U7` was expired.
  - PayPal read it back ACTIVE, and it went back to the pool as ready.
  - A fresh visitor claimed it.
  - Pause, then resume, on that real member each read back from PayPal (SUSPENDED, then ACTIVE).
- **Old showcase owner key retired.** The key was replaced on the live site; the admin page confirms "the old key no longer signs in". The old key itself wasn't available, so it was not retried.
- **Scam check.**
  - Kept's own renewal reminder (a link to this shop's own member page) is now **clear**.
  - The same text with a look-alike host still gets **caution**.
  - "Send my refund to my son's account" is now **held**.
- **Illegal rules get their citation when paraphrased.** "Show three retention offers before cancel" is refused with KEPT-OFFER (ROSCA §8403(3), Cal. §17602(d)).
- **Accessibility.** axe (WCAG 2.2 AA) found **0 violations** on the Guard, Safety and Compliance pages at 800 px, with no sideways scroll. The member page at 200% text has no sideways scroll, and the scam-check button wraps.
- **Compliance page.** No visible "[verify]" marks remain; they stay in `docs/compliance.md`.
- **Owner MCP.** Connections shows the owner MCP URL and a "Show owner key" button: 200 for the shop's own owner, 401 anonymous, `no-store`.
- **Judge Mode** marks the first-run tours seen, so they don't reopen afterwards.
- **Observed once, not explained.** Right after the claim, Kept's copy showed the subscription SUSPENDED while PayPal was ACTIVE: the gate's live read allowed a pause, which needs ACTIVE. The next read-back corrected it.

## Waves 2, 3 and 5 of the master improvement spec (11 Nov 2026): acceptance log

Each item was built, tested (`npm test`: 167 of 167; `npm run e2e`: 28 of 28), pushed to `main`, deployed by Render, and checked on the live site. "Not verified" means exactly that.

### Wave 2, items 6 and 7: Decisions scam check v2 and the agent loop (live 4576fdc, 6155d28)

- Scam check: three readers (rules, Decisions questions, code that reads where money would go). Strictest wins, and a message that names somewhere to send money is never shown green. Live: the 10 Nov message is **held** by rules, code and Decisions.
- The owner's Ask runs as an agent with read tools, one of them PayPal's own MCP server. Live: 3 tool calls including `paypal_mcp`, and every sentence cites a fact that code checked.
- `/proof` scam set: 47 of 48 on the live server's result file.

### Wave 2, items 8 and 9: the judge page and the public pages (live b12331d, 01c511b)

- `/judge`: three paths whose steps tick themselves when the server sees them happen, in the visitor's own workspace only. No tour starts by itself.
- `/proof`, `/ai`, `/paypal`, `/who-can-move-money` and `/accessibility` read real records. `/proof` lists every case of every suite, plus a daily showcase run at 04:30 UTC (`nightly_runs`).
- Live:
  - The member's assistant paused and resumed a real sandbox subscription, and code read PayPal back each time (SUSPENDED, then ACTIVE).
  - The owner path ticked 4 of 4.
  - The daily run passed 7 of 8.
- **Not run live:** the cancel path. Saying no to the offer cancels the subscription on PayPal and uses up one of the owner's pre-approved pool subscriptions, so it is tested with the fake PayPal only (`test/wave2.test.ts`, `test/wave3.test.ts`).

### Wave 3, item 11: Kept's differentiators (live dbabe74, f623bd6)

| Spec B5 | What was built | Live check (11 Nov) |
|---|---|---|
| 1. Watch an assistant do it | The member page's assistant panel, streamed step by step | Pause: mandate, model, `pause`, read-back "status suspended, resumes 2026-12-10". Resume: read-back "status active". About 9 s each |
| 2. App inside ChatGPT and Claude | `get_subscription` returns the stamp card as an MCP Apps resource (`ui://kept/stamp-card.html`, `text/html;profile=mcp-app`) and a ChatGPT copy (`text/html+skybridge`); results carry `structuredContent`. `/agents` explains how to add it | Both resources are listed on the live `/s/<slug>/mcp`; the tool's `_meta` points at them; the card has the host bridge. **Not verified:** rendering inside ChatGPT or Claude, which needs the owner's developer mode |
| 3. One honest exchange at cancel | Decisions classifies the reason and asks `is_quality_complaint` and `sounds_pressured`; at 0.5 or more, code makes no offer. A quality complaint goes to the owner | `eval/exchange.json` on real Decisions calls: **17 of 17**, no offer where none should be. Calm reasons scored at most 0.11 pressured; pressured ones at least 0.88. **Not done:** the model asking one follow-up question |
| 4. Win-back | On a verified PayPal cancel that Kept did not make: one message with a rejoin link, never a second, at most one per email per shop per year | Tests only. A live run would cancel one of the owner's pool subscriptions |
| 5. Cancel widget | `/widget.js` (one script tag, opens the member page), with a copy button on the owner's dashboard | 200, JavaScript, `cross-origin-resource-policy: cross-origin`; no cookies, storage or fetch |
| 6. Failed renewal end to end | Real code from earlier waves (webhook, notice, outstanding-balance capture) | **Not verified live:** it needs PayPal to fail a real renewal, and there is no switch to fake one |
| 7. Partial-refund remedy | Rule "refund the unused part … up to $X"; on cancel, the unused share of the last payment, capped, refunded and read back from PayPal. A refund failure never undoes the cancel. Code reads the cap from the owner's words; the model only says that the rule is there | The real-model rules draft shows the refund line, up to 10.00. **Not run live:** the refund itself, which would cancel a pool subscription |
| 8. Phone line | Not built | The Twilio number belongs to Callback |
| 9. APIMatic portal | Not built | Needs the owner's APIMatic account |
| 10. Signed mandate | Code issues an HMAC-signed mandate from the member's words before the model runs. Its scope includes cancel only if the member asked to cancel; it expires after 15 minutes; code refuses any move outside it. Public check: `/api/public/mandate/:id` | Live mandate `mdt_5sc5cfuzbnkxqb7h`: valid, scope without cancel, one recorded use. A forced refusal is tested only, since the live model did not try to overstep |
| Also: what this loosens | Code compares new rules with the approved ones and lists every way members get more | Live on the guard page and the rules preview. It caught a loosening the owner did not write: the model's draft defaulted the offer cooldown from 365 to 180 days |

**Fixed during the live checks:**

- The rules-draft schema asked the model for `refund_unused_*` fields, which Kept's own money-field guard rejects. The model now answers yes or no, and code reads the amount.
- The public mandate view showed the member's private link ref inside the agent id. The agent id now uses the internal id, and older mandates are scrubbed.

### Wave 5

- **18. A6.4 retraining the on-device scam model: not done.** It runs in the shared guard lab, outside this app.
- **19. A7 accessibility (live dbabe74):**
  - Switches are named and announced.
  - Scrolling tables and code boxes can be reached by keyboard.
  - The marquee is read once.
  - Push-to-talk on the owner's Ask and the member's assistant. The live session is 120 s, `gpt-live-1`, with words by `gpt-4o-transcribe`; Kept's key never reaches the browser.
  - New Playwright checks: keyboard-only cancel, 200% text, reduced motion, switch names, voice fallback.
  - All of it, with dates, is on `/accessibility`. **Not verified:** dictation into a real microphone, and a screen reader in a person's hands.
- **20. A12, the robot judge and the quality gate (live 229a75f, 97a11a6):**
  - `npm run robot:judge` opens the live site in a browser and follows the `/judge` paths. It writes `eval/robot-judge.json`, which is also on `/proof`. It starts a shop with no pool subscriptions (`POST /demo/start {"pool": false}`) and never takes a visitor's demo slot.
  - Live run: **15 of 15 steps, 40 s** (public pages with axe and 200% text 6 s, owner path 23 s, assistant read 7 s).
  - Its first run found a real bug: an early click on "Check this message" reloaded the page instead of checking. The button now stays disabled until its handler is attached.
  - `.github/workflows/robot-judge.yml` runs it daily once the repository variable `ROBOT_JUDGE` is `true`.
  - Not covered by the robot: pause, resume and cancel on a real subscription (pool cost).

### Quality gate for a change to Kept

A change goes to `main` only when all of these pass. This is a checklist run by hand: there is no CI workflow that blocks a push.

1. `npm test`: all suites (167 tests today), including route coverage.
2. `cd web && npx tsc -b && npx vite build`.
3. `npm run e2e`: all browser tests on phone and desktop, axe with no serious or critical issues (28 today).
4. When AI behaviour changes, the eval sets on real models:
   - `eval:b5` 8/8, `eval:fairness` 19/19, `eval:adversarial` 26/26 and `eval:exchange` 17/17, none worse than before.
   - `eval:reasons` is at 32/36 today, with h10, r06, r14 and r18 missed.
5. After the deploy, `npm run robot:judge` on the live site, every step passing.
