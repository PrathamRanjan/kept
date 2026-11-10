# Kept: design brief

## Who we design for

An owner-operator checking their shop on a phone between jobs, and their members, some older, some arriving through an AI assistant's link. They need three answers on every screen: **what happened, what needs me, what happens next.** The product's moral centre is that cancelling is a right, not a failure. The design must make money states legible at a glance and make "cancel" look as ordinary as "skip".

## Three directions

| | A. Stamp card | B. Almanac | C. Receipt tape |
|---|---|---|---|
| Mood | A café loyalty card: paper stock, rubber-stamp ink, a shopkeeper's tool | A seasonal planner: large dates, calm, calendar-led | A thermal receipt: monospace, perforations, every change printed as a line |
| Palette | Warm paper, near-black ink, cobalt stamp-pad blue; green paid, amber paused, red only for failure | Off-white, slate, one seasonal accent | White, black, one highlighter yellow |
| Type | Sturdy grotesk display, humanist sans text, mono for refs | Serif display, sans text | Mono everywhere |
| Signature | **The cycle card**: every subscription drawn as a row of stamps, one per billing cycle | A big month grid | The receipt timeline |
| References outside fintech | Loyalty punch cards, library date-due cards, Field Notes, rail ticket punches | Weather almanacs, Things 3 | Teenage Engineering manuals, POS printers |
| Fit to brief (1–5): legibility on a phone / money states / trust / distinct from SaaS retention tools / owner warmth | 5 / 5 / 4 / 5 / 5 = **24** | 4 / 3 / 4 / 3 / 4 = 18 | 3 / 4 / 4 / 4 / 3 = 18 |

**Chosen: A, the stamp card.** A subscription *is* a punch card the shop and the member fill together: each cycle gets a stamp. Skips, pauses and discounts are visibly different stamps, and a cancel is a clean closed end, not a red error. Every small subscription shop already understands the object. Direction C's receipt idea survives in one place: the money timeline on approvals and member pages, printed as dated lines with the actor (AI, Rule, PayPal).

## Signature element: the cycle card

One stamp per billing cycle, oldest left, the next one marked "next":

| Stamp | Meaning | Drawing |
|---|---|---|
| Filled cobalt disc with a tick | Paid (PayPal payment read back) | solid |
| Outlined disc | Upcoming | 1.5px ring |
| Disc with a diagonal bar | Skipped | ring + slash |
| Dashed ring | Paused | dashed |
| Half-filled disc | Discounted cycle | left half filled |
| Red ring with "!" | Payment failed | red ring |
| A square end-cap after the last stamp | Cancelled (date under it) | ink tab |

Shown on the landing hero (stamping in, honouring reduced motion), on the member page (their own card, large), and as a compact column in the owner's members grid. Built from real data: payments, skip and pause events, resume date, discount end, cancel date and the plan's interval (`cycleCard()` on the server).

## Type

- Display: **Schibsted Grotesk** (variable, 500–800), headings and big money numbers.
- Text: **IBM Plex Sans** (400/500/600), chosen for small-size legibility; `font-variant-numeric: tabular-nums` on every amount, date and status.
- Mono: **IBM Plex Mono** for references, PayPal ids and endpoints.
- Scale (rem): 0.8125 / 0.875 / 1 / 1.125 / 1.375 / 1.75 / 2.25 / 3 (hero 3.5 on desktop). Body 1rem/1.55. Line length 60–72ch for prose. Weights: 400 body, 500 labels, 600 emphasis, 700 display.
- Self-hosted through Fontsource, `font-display: swap`.

## Tokens

| Token | Light | Dark | Contrast note |
|---|---|---|---|
| `--paper` (page) | #F6F3EC | #121417 | |
| `--card` | #FFFDF9 | #1A1D21 | |
| `--ink` (text, primary button) | #16181B | #EDE8DE | 16.9:1 on paper / 14.6:1 |
| `--ink-2` (secondary text) | #4B5058 | #A9ADB5 | 7.6:1 / 7.9:1 |
| `--rule` (borders) | #DCD4C4 | #2D3137 | non-text |
| `--stamp` (cobalt: motif, links, focus) | #2443C4 | #93A6FF | 7.4:1 / 7.6:1 |
| `--paid` | #1D7348 | #63C795 | 5.6:1 / 8.6:1 |
| `--pause` | #8F5A00 | #E6AE52 | 5.4:1 / 8.9:1 |
| `--fail` | #B42318 | #FF8F85 | 6.0:1 / 7.4:1 |
| `--stamp-wash` | #E7EBFA | #20264A | background for "next" and selected |

Contrast ratios are computed against `--paper` and checked again in the built CSS with axe in the Playwright run.

- Radius: 4 (inputs), 8 (buttons), 12 (cards); stamps are circles.
- Spacing: 4-px base; 8, 12, 16, 24, 32, 48, 72.
- Elevation: flat. Cards are separated by a 1px rule and a 0 1px 0 shadow; only sheets and dialogs float (0 12px 32px rgba(0,0,0,.18)).
- Motion: 120 ms (hover), 200 ms (stamp press: scale 1.12 → 1, rotate −4° → 0), 320 ms (sheets). All off under `prefers-reduced-motion` and under the "No motion" accessibility setting.

## Rules

- **Cancel is never red.** It is an outlined ink button with the same weight as Skip. Red means only "a payment failed" or "stop everything" (owner kill switch).
- **Every money screen shows the trust strip**: who proposed (AI), what rule decided (Rule), and what PayPal did (PayPal), each with its status and time.
- **Approvals** always show: what will move, to whom, why, and how to undo.
- No gradients, no glass, no bento, no emoji icons (Lucide line icons only), no stock logos, no invented stats. Sample data is labelled "sample" wherever it appears.
- Copy: short sentences, second person, verbs first. "Skip next delivery", not "Initiate skip".

## Components

shadcn/ui (new-york style, re-tokened) for the app: sidebar, sheet, dialog, tabs, badge, card, table, form inputs, toasts (sonner), command palette, skeletons, tooltip. AG Grid Community (MIT) for the owner's members grid on wide screens, with the cycle card as a cell renderer; cards on phones. Magic UI (MIT) is used once, on the landing page: its Marquee carries the kinds of shops Kept is for (coffee clubs, bakery boxes, farm boxes…), never fake activity or logos. Aceternity UI is not used: nothing in its catalogue fits a money tool better than our own stamp animation, and its licence terms for copied components would need a separate check. The landing hero uses our own stamp animation. Driver.js (MIT) for tours. Bryntum Calendar (trial build) stays for renewals.
