# Kept: state of the union (11 Nov 2026)

Live: https://pph-kept.onrender.com · main at `da51529` (code `85993fc`) · submissions close 12 Nov 2026, 12:00 Pacific.

This replaces the 10 Nov report. Since then:
- Wave 1 of the master improvement spec has landed: saved wallet, private demo shops, the approval pool, health, no silent fallbacks, the GPT-6 model chain, honest failure states, and Ask on plain facts.
- Every finding from 10 Nov that needed no input from you has been fixed.

The live results for each item are logged in the README.

**Checks run for this pass:**
- Typecheck: clean.
- Unit and integration tests: **116 / 116**.
- Browser tests (Playwright, phone and desktop, with axe): **16 / 16**.
- Spec regression set with the real model: **8 / 8** (`eval/b5.md`).
- Live: axe at WCAG 2.2 AA with **0 violations** on the Guard, Safety and Compliance pages.

## 1. Verdict

**Kept is now safe to hand to a judge unsupervised.** Two caveats come first.
- **Only one real member, and only for the first judge.** One real PayPal subscription is in the pool (`I-69VG1KHRR1U7`), so only the **first** judge's demo shop gets a real member. Everyone after sees labelled sample members and the "subscribe on PayPal's page" path. The other 9 pool subscriptions are waiting for your approval.
- **Cold start.** The site is on Render's free plan, so the first visit after about 15 idle minutes waits for the service to wake.

**What is no longer a problem:**
- **Nothing a judge does reaches the next judge.** Each visitor gets a private copy of the shop, with 40 labelled sample members. Rules, kill switches, approvals and cancels stay in that copy.
- **The showcase can't be broken.** It is read-only.
- **Real subscriptions are reused, not burned.** When a demo shop expires (48 idle hours) or is reset, its real subscription returns to the pool; it is never cancelled.

## 2. The 10 Nov findings, now

| 10 Nov finding | Now | Proof |
|---|---|---|
| P0: one member, the first judge's cancel ends it for all | **Fixed**: private shops; real subscriptions come from a pool and return to it | Live: two shops isolated; expiry returned `I-69VG1KHRR1U7` ACTIVE; a new shop claimed it; pause and resume read back |
| P1: Scam page listed every shop's messages | **Fixed** (scoped to the shop) | Isolation test, live leak check |
| P1: any owner could hit the global kill switch | **Fixed** (own shop and agents only; global is admin-only) | Tests |
| P1: judges overwrite each other's rules and limits | **Fixed** (private shops, "Start over" reset) | Live |
| P1: owner MCP key not shown | **Fixed** ("Show owner key" in Connections, on request, `no-store`) | Live 200 / anonymous 401 |
| P2: dropped illegal rule shows no citation | **Fixed** (paraphrases matched) | Live: "three retention offers" cites KEPT-OFFER |
| P2: scam check flags Kept's own reminder | **Fixed** (exact-host match on Kept's own member links; look-alikes still flagged) | Live: clear / caution |
| P2: "send my refund to my son's account" passed | **Fixed** (held) | Live |
| P2: `kills.json` without sign-in; `/\` open redirect | **Fixed** | Tests |
| P2: Ask leaks field names | **Fixed** (plain facts; code rejects backticks, camelCase, snake_case) | Live: 5 questions, 0 leaks |
| P2: axe criticals on the legacy Guard, Safety and Compliance pages | **Fixed** | Live axe: 0 violations at 800 px |
| P2: sideways scroll at 200% text | **Fixed** | Live: overflow 0 |
| P2: "[verify]" marks visible | **Fixed** (kept in `docs/compliance.md` only) | Live: 0 |
| P3: copy, owner tour reopening | **Fixed** | — |
| Risk model fed fixed inputs | **Fixed** (member age, payment median, gate velocity, shop-local hour; no time zone means the hour signal is skipped, not guessed) | Tests |
| Old QC-pack owner key still worked | **Fixed** (showcase key rotated live) | Admin confirmation; the old key itself wasn't to hand to retry |
| Cancel-reason eval's model arm never run | **Fixed**: model 15/16, rules 11/16 | `eval/results.md` |
| "Rules fallback" behind the model | **Removed**: if neither model answers, the owner sees a plain sentence and "Try again"; production refuses to start without its keys | Live: models broken on purpose, then restored |

## 3. Still open

### Needs you (I can't do these: passwords, purchases or your accounts)

| # | What | Why it matters | How |
|---|---|---|---|
| 1 | **Approve the 9 pool subscriptions** | Only the first judge gets a real member today | Open `/admin/pool` and approve each link as the sandbox buyer, or run `scripts/sandbox-approver.mjs` with the buyer login in env vars. Then press Sync |
| 2 | **Always-on hosting** | Cold start after idle; the spec's 12-hour-idle check fails | Upgrade the Render service to a paid instance. The keep-warm job (`KEEP_WARM=true`) is the free alternative, but it would use most of the workspace's 750 free hours on its own, so decide that across all eight apps |
| 3 | **Judge access to the live PayPal step** | Without a sandbox buyer account, a judge can't subscribe on PayPal's page | Put a dedicated sandbox buyer's email and password in the submission notes, or rely on the pool (item 1) |
| 4 | **Demo video (2–3 min)** | Presentation score | Record it, or let me script the shots |
| 5 | **SMS to the end** | Reminders by text were never completed live | A fresh opt-in from your phone on a real member's page, then enter the code |
| 6 | Optional: Log in with PayPal, APIMatic portal, Kept's own Telegram bot | Extra tracks and channels | Enable or create each one; Telegram turns on with `KEPT_TELEGRAM=on` |

### Not verified live, and why

- **Capture and invoicing:** need a real failed renewal; the sandbox can't fail one on demand.
- **Passkey countersign at $200 or more:** needs a real authenticator.
- **Member cancels on a real member** ("don't try to keep me", "burnt coffee"): verified through the production code path with the real model (`eval:b5`). Not run live, because a cancel would use up the only real subscription.
- **Web push and WhatsApp:** no subscribed browser; no WhatsApp token.
- **Many judges at once:** not load-tested; one free instance.

### Known weaknesses (honest, not bugs)

- The payment-risk model is trained on **synthetic data**. It only raises a warning and never approves, and the page says so.
- A member's only credential is their unguessable page link (a bearer link). There is no step-up before a cancel or switch.
- The Bryntum calendar takes several seconds to load (trial build).
- One unexplained moment: right after a claim, Kept's copy showed a subscription as SUSPENDED while PayPal had it ACTIVE. The next read-back fixed it, and every money move reads PayPal live first, so nothing acted on the stale value.

## 4. Scores (strict, out of 10)

| Criterion | 10 Nov | Now | Why |
|---|---|---|---|
| Technological implementation | 8.0 | **8.5** | Private shops, the pool, honest failure states, production guards, real scam-check inputs. Capture and invoicing are still unproven live |
| Design | 7.5 | **8.0** | Owner screens are full (labelled samples), legacy pages pass axe, Ask reads like a person |
| Potential impact | 7.0 | **7.0** | Unchanged |
| Innovation | 7.5 | **7.5** | Unchanged |
| Presentation | 6.5 | **7.0** | Judges can't break the demo now. Still no video, and a cold start on the first visit |

## 5. Ready for a judge to sign in and try things?

**Yes, with the caveats in §1.**
- No hard-coded demo logic remains in money or AI paths.
- Every AI output says which model wrote it, or that code did.
- Sample rows are labelled and kept out of PayPal-confirmed figures.
- Judges can do everything without a password except the live PayPal approval step (§3, item 3).
- The biggest gains left are owner actions: approve the pool (item 1), always-on hosting (item 2), and the video (item 4).
