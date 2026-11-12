# Kept: Devpost submission (PayPal AI Hackathon)

Copy each block into the matching Devpost field. Lines marked **YOU FILL** are about you personally and are left for you.

---

## General info

**Project name** (56 of 60 characters)

```
Kept: fair PayPal subscriptions AI assistants can manage
```

**Elevator pitch** (195 of 200 characters)

```
Skip, pause or cancel a PayPal subscription in one step: by tap, in Telegram, hands-free or via your AI assistant. Code moves the money, PayPal confirms it, and a scam model runs in your browser.
```

---

## Project details

### About the project (Markdown)

```markdown
## Inspiration

Subscriptions are easy to start and hard to leave. In 2024 the FTC reviewed 642 subscription sites and apps and found that **76%** used at least one possible dark pattern. Complaints about hard-to-cancel subscriptions rose from 42 a day in 2021 to **nearly 70 a day** in 2024. People lose track too: in one survey they guessed they spent $86 a month on subscriptions, and the real total was **$219**.

Small shops are on the other side of this. A coffee club or a farm box can't afford to lose trust, but it also can't build a fair retention system on its own. Then a third party arrived: AI assistants. Generative-AI traffic to US retail sites rose **693%** in the 2025 holidays (Adobe). Soon your assistant will skip, pause and cancel subscriptions for you, and nothing today lets it do that safely without your login.

So we built **Kept**: fair PayPal subscriptions that people, shops and AI assistants can all manage.

## What it does

Kept sits on top of **PayPal Subscriptions** and serves three people:

- **The member** can skip, pause, switch or cancel in **one step**, from a page that needs no app and no password, or straight from a **Telegram** reminder with Skip and Keep buttons. Cancelling never takes more than one step. A shop may make at most one offer, and only if the member asks for it.
- **The owner** writes the shop's rules in plain words ("one skip per quarter, at most 15% off for 3 months"). Kept turns them into limits that **code enforces**. A rule that breaks consumer law is refused, with the law it breaks. Anything above the owner's limits waits for **Approve or Decline**, on the dashboard or in Telegram. The owner can ask the shop questions and get answers that cite their sources, from an AI agent that reads PayPal through **PayPal's own MCP server**.
- **The member's AI assistant** gets a **signed permission slip** for exactly one request, valid for 15 minutes, and acts through Kept's **MCP server** (14 tools). It never gets the member's login.

Every change goes to PayPal first and is **read back from PayPal** before anyone is told it's done. **Code decides every money move. AI models only read, choose among options code allows, or word things.**

## How we built it

- **PayPal, end to end:**
  - Subscriptions: create, get, suspend, activate, revise, cancel and capture
  - billing plans and catalog products
  - subscription transactions for a daily reconcile
  - **webhooks with signature verification**
  - the JavaScript SDK subscription buttons
  - **PayPal's MCP server** as a read tool for the owner's agent
  - One executor is the only code that writes to PayPal, with a `PayPal-Request-Id` on every write and a read-back after it.
- **AI on the server:**
  - OpenAI agents with tools (`gpt-6.1-sol`) for the owner's Ask and the member's assistant
  - the **OpenAI Decisions API** (`gpt-6-luna`) for yes/no checks
  - `gpt-live-1` for push-to-talk
  - If a model fails, Kept says so. It never falls back silently.
- **AI on the device:**
  - **A scam model we trained ourselves.** We fine-tuned MiniLM-L6 with SetFit on about 80,000 real scam, spam and genuine messages, then exported it to ONNX and quantised it to int8 (**23 MB**). It runs entirely in the browser with ONNX Runtime Web: the message never leaves the device. On 8,188 real test messages it scores **AUC 0.988** and catches 75% of scams while holding only 1% of genuine messages.
  - a LightGBM payment-risk model
  - **MediaPipe** face tracking for hands-free use
- **Stack:** TypeScript, Express, React 19 + Vite, Postgres (PGlite locally). **AG Grid** for members and a **Bryntum** renewal calendar. Deployed on **Render** from one blueprint: web service, worker, daily cron and Postgres.
- **Checked:**
  - 223 server tests against a fake PayPal that models the subscription state machine
  - 29 browser tests on phone and desktop, each with **axe** accessibility checks
  - a **robot judge** that walks the live site (15 of 15 on 13 Nov 2026)

## Accessibility and languages

- **Hands-free ("Look and Say"):** point with your head or eyes, and click by looking, speaking or winking. Face tracking runs on the device, and money controls need a spoken "yes".
- **Display and help:** larger text, more contrast, reduced motion, a clearer font, read-aloud, simpler words and bigger buttons.
- **WCAG 2.2 AA**, checked by axe on every page.
- **Four languages:** English, Hindi, Indonesian and Portuguese. **76%** of online shoppers prefer buying in their own language (CSA Research), and India, Indonesia and Brazil are three of the world's largest online populations.

## Challenges we ran into

- **PayPal sandbox approvals need a person.** A subscription has to be approved on PayPal's own page by a signed-in buyer, so a live demo can't create real members on its own. We built an **approval pool**: real sandbox subscriptions approved in advance, claimed by each visitor's private demo shop and cancelled at PayPal when the shop expires. We later found the sandbox **drops subscriptions that wait too long for approval** (`INVALID_RESOURCE_ID`), so Kept now retires those links instead of showing dead ones.
- **Making the browser and Python agree.** An int8 model gives slightly different numbers in onnxruntime-web than in Python. We refit the model's heads on the quantised graph's own outputs and added a parity test (identical tokens; 3 of 200 decisions flip, near the threshold).
- **Business email is hard.** Our model is weak on hand-written business emails (AUC 0.58), so it's **one of three independent checks**, alongside code rules and OpenAI Decisions. None of them can approve a payment; they can only hold one.
- **Showing the truth.** Every number on the site is read from PayPal or labelled as a sample. The proof pages (`/paypal`, `/ai`, `/proof`, `/accessibility`) show the evidence, including what we did **not** test.

## Accomplishments we're proud of

- An AI assistant can manage a real PayPal subscription **without ever holding the member's login**.
- A scam model **we trained**, small enough to run in a browser, that never sends the message anywhere.
- One-step cancel, fair offers and consumer-law checks **enforced in code**, not promised in a policy.
- A product people can use hands-free and in four languages.

## What we learned

- Agentic commerce needs **narrow, signed, short-lived permissions**, not shared logins.
- **Read-back beats trust**: PayPal is the source of truth, so Kept only says "done" after PayPal does.
- A small model on the device, honestly measured, plus code rules, beats one big model asked to be careful.

## What's next

- A screen-reader walk-through and testing with disabled people (only automated checks have run so far).
- Translating the guided tour's step text and the Telegram messages.
- Production PayPal credentials, and more business-email data for the scam model.
```

### Built with (up to 25 tags)

```
paypal-subscriptions-api, paypal-webhooks, paypal-javascript-sdk, paypal-mcp-server, openai, openai-decisions-api, model-context-protocol, onnx-runtime-web, sentence-transformers, setfit, lightgbm, mediapipe, typescript, node.js, express, react, vite, tailwindcss, postgresql, pglite, ag-grid, bryntum, render, telegram-bot-api, playwright
```

### "Try it out" links

- Live demo: https://pph-kept.onrender.com
- Code: https://github.com/PrathamRanjan/kept (**the repo must be made public first**)
- Proof pages: https://pph-kept.onrender.com/proof and https://pph-kept.onrender.com/paypal

### Project media

Images (3:2 works best, under 5 MB each):

- `docs/media/kept_02.20s.png`
- `docs/media/kept_07.45s.png`
- `docs/media/kept_17.30s.png`
- `docs/media/kept_24.50s.png`

You could also add screenshots of the landing page, the guided tour card and the owner's dashboard.

Video (YouTube, public or unlisted, under 3 minutes): upload your demo video, or `docs/media/kept-film.mp4` (a 30-second film), and paste the link. **YOU FILL**

---

## Additional info

**Upload a file:** optional. A zip of the repo works if you want one.

**Submitter type:** **YOU FILL** (Individual / Team / Organization)

**Submitter country of residence:** **YOU FILL**

**Province (Canada):** **YOU FILL** ("N/A" if you don't live in Canada)

**Organization name:** **YOU FILL** ("N/A" if none)

**Is your project new, or did it exist before Oct 1, 2026 (9:15 am PT)?**

```
New
```

(The repository's first commit is from November 2026.)

**If it existed before, explain what already existed:**

```
N/A
```

**Explain how your project meets the main technology requirement.**

```
PayPal developer platform (sandbox):
- Subscriptions API: create (with the approval link), get (read-back after every change), suspend and activate (skip, pause, scheduled resume), revise (plan switch, discount offers and reverts), cancel (one-step cancel) and capture (collect the balance after a failed renewal).
- Billing Plans and Catalog Products: each shop's product, its regular, lighter, daily and discount plans.
- Subscription transactions: a daily reconcile and the money collected.
- Webhooks with verify-webhook-signature: verified events update Kept; unverified events are stored but never acted on.
- JavaScript SDK subscription buttons: checkout on each shop's page.
- PayPal MCP server (mcp.sandbox.paypal.com/sse): a read tool for the owner's AI agent, so it can answer questions from the shop's PayPal account.
- OAuth 2.0 client credentials for all server calls. One executor is the only code that writes to PayPal, with a PayPal-Request-Id on every write and a read-back after it.

AI:
- OpenAI gpt-6.1-sol with tool calling: the owner's "Ask your shop" agent (every sentence cites a fact), the member's AI assistant (acts through Kept's MCP tools within a signed 15-minute permission), and reading the owner's rules written in plain words.
- OpenAI Decisions API (/v1/decisions) with gpt-6-luna: yes/no checks, such as whether a message is a scam or a rule is lawful.
- OpenAI gpt-live-1 and gpt-4o-transcribe: push-to-talk for the owner and the member.
- Our own scam model: MiniLM-L6 fine-tuned with SetFit on about 80,000 messages, exported to ONNX int8 (23 MB) and run in the browser with ONNX Runtime Web (AUC 0.988 on 8,188 real test messages).
- A LightGBM payment-risk model and MediaPipe Face Landmarker (hands-free pointing), both running in the browser.
- Kept's own MCP server (14 tools) lets any AI assistant, such as Claude or ChatGPT, manage a subscription.
AI never moves money: models only read, choose among options computed by code, or word things.
```

**Which additional sponsor tools did you use?** Tick these:

- [x] **AG Grid**: the owner's Members grid
- [x] **Bryntum**: the owner's renewal calendar
- [x] **Render**: the whole app (web service, worker, cron, Postgres) from `render.yaml`
- [x] **Postman**: `docs/kept.postman_collection.json`, run with the Postman CLI against the live API
- [ ] APIMatic: not used (only an OpenAPI spec exists, no APIMatic portal or SDK)
- [ ] Astropods, Channel3, Elastic, KERNEL, Zapier: not used

**Public code repository URL:**

```
https://github.com/PrathamRanjan/kept
```

**Before you submit:** the repository is **private** today and must be made public. It has an MIT licence and a README with setup steps, PayPal and AI use, and sponsor tools.

**Working demo URL:**

```
https://pph-kept.onrender.com
```

**Testing instructions:**

```
No sign-up needed.

1. Open https://pph-kept.onrender.com and press "Start the guided demo" (or open /demo and press "Start the guided journey"). You get your own private copy of the demo coffee shop.
2. A card in the corner walks you through one story in about 8 minutes: the owner (approve or decline a held discount, ask the shop a question, try to add an unlawful rule, check a fake "new PayPal account" message with the in-browser scam model), then a member (subscribe buttons, skip next month, Telegram reminders, one-step cancel), then the member's AI assistant ("Pause my coffee for a month"), then the proof pages. Press "Fill it in for me" on any step that needs typing.
3. Real PayPal: while the pre-approved pool has subscriptions, your demo shop gets real PayPal sandbox members, so skip, pause and cancel change real sandbox subscriptions. If the pool is empty, members are labelled samples and the tour says nothing reaches PayPal.
4. Telegram: on the member's page press "Connect Telegram", scan the QR code (bot: @kept_paypal_demo_bot) and press Start. A reminder arrives with Skip and Keep buttons.
5. AI assistants: connect any MCP client to https://pph-kept.onrender.com/mcp
6. Evidence: /paypal (every PayPal API with its latest sandbox id), /ai (the last model calls), /proof (every test set), /accessibility.

The first page load may take up to a minute if the service has been idle.
```

**PayPal sandbox buyer** (only if you want judges to subscribe themselves on PayPal's page): add the email and password here yourself. **YOU FILL** if wanted

**How would you rate your overall experience integrating PayPal? (1–10):** **YOU FILL**

**Why (draft based on what we ran into; edit freely):**

```
The Subscriptions API covers the whole lifecycle well: suspend, activate, revise and cancel map cleanly onto skip, pause, switch and one-step cancel, and reading a subscription back after each write made it easy to treat PayPal as the source of truth. Webhook signature verification and PayPal-Request-Id idempotency worked as documented. PayPal's MCP server was a nice surprise: our owner's agent could read the shop's PayPal account without extra code.

Harder parts: a subscription only becomes active after a signed-in buyer approves it on PayPal's page, so a live demo can't create real members on its own. We built a pool of subscriptions approved in advance. The sandbox also drops subscriptions left unapproved for a while (INVALID_RESOURCE_ID), which we only found when approval links went dead. A sandbox-only way to approve a subscription by API, and clearer documentation of how long unapproved subscriptions last, would help a lot.
```

**Open to being contacted for feedback?** **YOU FILL**

**APIMatic Context Plugin experience:** leave blank (not used).

**AG Grid experience:**

```
We used AG Grid Community (ag-grid-react) for the owner's Members grid: one row per PayPal subscription with plan, status, next payment, pauses and offers. Sorting, filtering and column sizing worked out of the box, and the grid handled our 40+ member demo shops smoothly on phone and desktop. The main work was accessibility: keeping the grid keyboard-usable and passing axe alongside the rest of the page, and theming it for light and dark mode.
```

**Eligibility (age of majority, eligible jurisdiction, not a sponsor employee):** **YOU FILL**. Tick only if true.

**Which AI tools have you leveraged while working on this project?**

```
Claude Code (Claude Opus) for building, testing and deploying; OpenAI models inside the product (gpt-6.1-sol, gpt-6-luna with the Decisions API, gpt-live-1, gpt-4o-transcribe); sentence-transformers and SetFit to train our own scam model.
```

(Add any other tools you used yourself.)

**Level of learning:** **YOU FILL** (suggested: Significant)

**Did you gain AI value you can use in your career?** **YOU FILL**
