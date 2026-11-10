# Kept: redesign report (10 Nov 2026)

**Kept** lets a small subscription shop on PayPal give members, and their AI assistants, one-step skip, pause, switch and cancel, within rules the owner writes in plain words. A model drafts the wording and a code gate decides; PayPal moves the money and Kept believes only what PayPal reads back.

Live site: https://pph-kept.onrender.com · Source: https://github.com/PrathamRanjan/kept (branch `redesign`, merged to `main`).

## 1. What changed

| Area | Before | After |
|---|---|---|
| Identity | Shared kit (coffee-shop serif, copper accent), not derived from the product | "Stamp card": a subscription drawn as a loyalty card, one stamp per billing cycle. Paper and ink, one cobalt stamp colour, Schibsted Grotesk and IBM Plex. Cancel is never red. See `docs/DESIGN_BRIEF.md` |
| Front end | Server-rendered HTML forms | React 19, Vite, Tailwind v4 and shadcn in `web/`, built to static files and served by Express. Old pages remain the fallback (`KEPT_SPA=off`) and the tool pages are restyled with the same tokens |
| API for the UI | none | `src/web/ui-api.ts`: JSON endpoints built only on the existing services. No business logic is duplicated |
| Signature element | none | `src/web/cycles.ts` builds the cycle card from PayPal payments, skips, pauses, failures and the next billing time. It appears on the landing page, the member page, the owner screen and as an AG Grid column |
| Landing | Generic hero | Hero with the shop's live cycle card, three steps, the trust strip (AI proposes / Rule decides / PayPal moves money), a live preview, pricing marked illustrative, FAQ and a persona picker |
| Money screens | Text lists | Every member page and approval shows PayPal status and a timeline in which each step is labelled AI, Rule or PayPal. Approvals say what moves, to whom, why it waited and how to undo it |
| Tours | `/judge` page only, pointing at the wrong merchant | Driver.js: a first-run tour for each persona, plus Judge Mode, about 3 minutes over 6 pages including the live sandbox step. It starts from `?tour=judge`, "Take the tour" or `/judge`, survives page loads, and is backed by an honest demo ribbon with reset |
| Accessibility | "Display and help" panel | The panel is kept and restyled, and opens from every header. 44 px targets, focus on navigation, reduced motion, axe-checked in tests |
| Sponsor tools | Bryntum calendar | Bryntum kept (renewal calendar). AG Grid Community added for the members table, with the cycle card as a cell renderer, filters and sorting |

## 2. Integration matrix (summary; full evidence in `docs/AUDIT.md`)

**Live-verified on the sandbox:**
- Catalog products and billing plans
- Subscription create, approve, suspend and activate (skip, pause, resume)
- Revise with PayPal consent (switch)
- Durable cancel with read-back
- Transaction search
- Signature-verified webhooks
- MCP: 13 tools, reachable on the live site
- OpenAI model brain

**Wired but not run live:** outstanding-balance capture and Invoicing v2 (the sandbox can't make a renewal fail on demand).

**Not wired:** Log in with PayPal (the feature is off on the sandbox app), WhatsApp (no token), Twilio, Channel3.

**APIMatic:** only `docs/openapi.yaml`; no portal or SDK was generated.

## 3. Hard-coding hunt: fixes

- **P0:** a pause offer was never made when the rules allowed more cycles than the owner's autonomy. It is now clamped, with test AU-1.
- **P1:** headline KPIs mixed labelled sample rows into live figures. The new `stats.live` is shown first and samples are counted apart.
- **P2:**
  - `/judge` picked the wrong shop.
  - The switch message printed a raw PayPal URL.
  - A cancel with "show me an offer" and no eligible offer didn't say why.
  - `render.yaml` defaulted to the rules-only brain.
- **Kept and labelled:** sample members, the "simulate failed renewal" button, the fault lab, the backtest history and the dark-pattern baseline.

## 4. Bugs found and fixed during the rebuild

- Judge Mode lost its place after the first page: the tour state was cleared before the next page could resume it.
- Judge Mode didn't know the demo member on a fresh page load, so it looped back to the shop.
- Finishing Judge Mode didn't always clear its saved state.
- The shop grid and dashboard grid scrolled sideways at 360 px.
- The phone "Take the tour" button had no accessible name.
- The PayPal button wrapper used `aria-label` without a role.
- Driver.js left popup ARIA attributes on highlighted sections.
- Responses were not compressed. Gzip is now on, with MCP and event streams excluded.

## 5. Checks

| Check | Result |
|---|---|
| Typecheck (server + web) | Clean |
| Unit and integration (`npm test`) | **84 / 84**: 75 before the work, 2 audit tests, 7 for the UI API and page shell (`test/ui.test.ts` reaches every new route, with no 5xx) |
| Browser (`npm run e2e`, Playwright on the real app with FakePayPal) | **16 / 16** (8 tests × phone 360 px and desktop 1440 px). Landing, new subscriber hand-off to PayPal, member skip/pause/resume/cancel with trace, offer-then-decline, owner today/ask/approvals/members, not-found, Judge Mode across all 6 pages, "Start Judge Mode". axe WCAG 2.2 AA: no serious or critical issues |
| Build | `npm ci && npm run build` from a clean clone builds `web/` then the server. The web lockfile carries the Linux binaries for rolldown, Tailwind oxide and lightningcss |
| Lighthouse mobile, **live** | Landing: performance 92, accessibility 100, best practices 100, SEO 100. Owner dashboard: performance 95, accessibility 100, best practices 100 (SEO 63 because owner pages are `noindex` on purpose). Shop: performance 96, accessibility 100 (91 before the fix in b6195b6), best practices 96 (PayPal's own permissions-policy warning inside its button frame) |
| Live QC (Render, after deploy) | 20 pages at 360 px and 1440 px: all 200, no sideways scroll, no console errors apart from the expected 404 for a made-up member and PayPal's own permissions-policy warning inside its frames |
| Screenshots | `docs/screenshots/`: 8 screens × 375/768/1440 × light/dark, 48 files, `npm run shots` |

**Live sandbox journey on the new UI:** see section 8.

## 6. Scores (strict, out of 10)

| Criterion | Before | After | Why |
|---|---|---|---|
| Technological implementation | 7.5 | 8.5 | Same deep PayPal surface, now with a typed JSON API, 100 tests including real-browser and accessibility checks, and the P0 fixed. Capture and invoicing are still unproven live, and the deployment is one web service, not the web/worker/cron `render.yaml` describes |
| Design | 4.5 | 8 | A distinct identity with a real signature element, in both themes, accessible and fast. Held back by the Bryntum trial watermark, the tool pages keeping their older layout under new styling, and an owner "Sign in first" state that should offer the demo owner directly |
| Potential impact | 6.5 | 7 | A real, regulated problem (negative-option rules; one-step cancel). The live-first KPIs make the retention story honest. The market claims in `PRODUCT_BRIEF.md` are labelled; no traction |
| Innovation / idea | 7 | 7.5 | Agent-manageable subscriptions with a code gate on every money move, and the cycle card as a shared language for owner, member and grid. The parts are known; the combination and the guard are new |
| Presentation | 5 | 7.5 | Judge Mode tells the whole story in about 3 minutes with a live sandbox step; demo ribbon; persona picker. Still no demo video, and the README isn't yet a visual walkthrough |

## 7. Tracks

| Track | Odds | Note |
|---|---|---|
| 1st / 2nd / 3rd overall | Long shot for 1st; contender for 2nd–3rd | Depth plus polish; a video would decide it |
| Most Creative | Long shot | The stamp card is fresh, the product category is not |
| Most Impactful | Long shot | Credible but niche (small subscription shops) |
| Best Demo Delivery | Contender | Judge Mode; needs the video |
| Best Use of PayPal + AI | **Contender (best odds)** | Model drafts rules and wording, code gates money, PayPal Subscriptions + webhooks + Transaction Search all live |
| Best Use of Agentic Commerce | Contender | Shop and directory MCP servers; agents subscribe and cancel; the owner MCP is read-only |
| Best Use of AG Grid | Contender for 2nd–3rd | One grid with a custom cycle-card renderer, set filters and sorting; not a grid-heavy product |
| APIMatic | Not eligible as it stands | Needs a generated portal or SDK from `docs/openapi.yaml` |
| Bryntum | Contender | The renewal calendar is used for real (renewals, pause resumes, discount ends, follow-ups); trial build |
| Channel3 | Not eligible | Not wired |
| Render | Contender | Deployed on Render with Postgres; `render.yaml` in the repo |

**Single best change:** record a 2–3 minute demo video that follows Judge Mode, including the live sandbox subscription and a one-step cancel read back from PayPal, and link it at the top of the README. It lifts Presentation and Best Demo Delivery, and helps every other track.

## 8. Live sandbox run on the new UI (10 Nov 2026, https://pph-kept.onrender.com, fresh data)

| Step (new UI) | Kept shows | PayPal reads back |
|---|---|---|
| Shop page → "Daily demo bag" $1.00/day, new subscriber "QC Redesign Run" → "Or continue on PayPal's page" → sandbox buyer approves | Member page: Active, $1.00 per day, one paid stamp (10 Nov), next payment 11 Nov | Subscription **I-5BRL6CY4FTUP** on plan P-18N2640841511520ANLYZ62Q, last payment **1.00 USD** |
| Skip next payment | Paused, starts again 11 Nov 11:00 UTC; skipped stamp; trace "Rule: allowed → PayPal: suspend → SUSPENDED" | SUSPENDED |
| Resume now | Active, next payment 11 Nov; trace "PayPal: activate → ACTIVE" | ACTIVE |
| Cancel, ticking "show me one offer" | One offer: pause for 2 billing cycles, open 60 minutes; trace "Rules allow: pause 2. Chose pause 2." (the audit's P0 fix working live: before it, this cancel got no offer) | ACTIVE (nothing moves while the offer is open) |
| "No thanks, cancel now" | Cancelled; the card ends with a closed "ended" stamp; run `run_8t6tcvtixfg3kr4r` | **CANCELLED at 2026-11-10T01:35:32Z** (`scripts/pp-sub-check.mts`) |

**Matched against the sandbox buyer's activity:**
- **Activity entry:** one "−$1.00 USD, 10 Nov, Automatic Payment" with buyer-side transaction **8FE839418E6501739**, item $1.00, total $1.00. It shows under "Test Store", the shared sandbox merchant's name.
- **PayPal's subscription-transactions API:** for I-5BRL6CY4FTUP it lists exactly one COMPLETED 1.00 USD payment, seller-side id **44200766TX384903F**, at 2026-11-10T01:34:01Z. That is the same second as Kept's paid stamp.
- **Why the ids differ:** PayPal gives the buyer's and seller's records of one payment different ids.
- **After the cancel:** no further charge.

## 9. Top 3 changes left

1. Demo video and a README with screenshots (see the single best change).
2. Generate an APIMatic portal or SDK from `docs/openapi.yaml` to enter that track. This needs an APIMatic account.
3. Product fixes:
   - Give the owner's "Sign in first" state a "Use the demo owner" button.
   - Licence or hide the Bryntum trial watermark.
   - Run a capture of an outstanding balance live when a sandbox renewal genuinely fails.

## 10. Not done

- Log in with PayPal, WhatsApp, Twilio and Channel3 are not wired.
- `eval:*` suites were not re-run (the server logic they cover is unchanged apart from the audit fix).
- Aceternity UI was not used. Magic UI is used only for the landing marquee (MIT).
