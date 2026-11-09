# Kept: product brief

Labels: **[fact]** sourced, **[est]** a source's estimate or vendor claim, **[assume]** our assumption, to be validated. No customer quotes or market sizes are invented here; where we have none, we say so.

## The problem

A small subscription business (coffee club, meal kit, farm box, bakery box, newsletter, gym) bills through PayPal and loses members in two ways it cannot see well: people who leave because cancelling or changing is awkward, and people whose renewal quietly fails. **[assume]** The owner is also the roaster, packer and support desk; the moment it hurts is the evening inbox: "how do I pause?", "please cancel", "my payment failed?", answered one by one in PayPal's dashboard.

Two shifts make this sharper in 2026:
- **The law moved toward one-step cancel.** California's amended automatic renewal law (AB 2863) took effect 1 July 2025: online sign-ups need online cancellation, and a business may make one save attempt only while a cancel button stays in view **[fact, secondary law-firm summaries: [DWT](https://dwt.com/insights/2024/10/ab-2863-updates-california-automatic-renewal-law), [Fenwick](https://fenwick.com/insights/publications/california-tightens-requirements-for-automatically-renewing-subscriptions)]**. The FTC's federal click-to-cancel rule was vacated by the Eighth Circuit on 8 July 2025 **[fact: [Wiggin](https://www.wiggin.com/publication/ftcs-click-to-cancel-rule-has-been-vacated/), [Latham](https://www.lw.com/admin/upload/SiteAttachments/Eighth-Circuit-Vacates-FTC-Click-to-Cancel-Rule-Days-Before-Compliance-Deadline.pdf)]**, but ROSCA enforcement continues case by case **[fact, same sources]**. So the federal floor is uncertain and the strictest states set the bar.
- **Buyers' AI agents are starting to manage subscriptions.** PayPal launched agentic commerce services in October 2025, and its Agent Toolkit exposes subscription tools **[fact: [PayPal developer AI tools](https://developer.paypal.com/ai-tools/get-started), [PayPal developer blog](https://developer.paypal.com/community/blog/agentic-ready-services)]**. A shop with no agent-facing endpoint forces the agent back to a web form built for humans **[assume]**.

Failed payments matter as much as cancels: secondary sources put involuntary churn at roughly 20–40% of subscription churn, and higher at low price points **[est: [Flycode on Stripe data](https://docs.flycode.com/docs/involuntary-churn-hidden-revenue-killer), [PYMNTS](https://www.pymnts.com/subscriptions/2023/avoidable-failed-payments-cause-50-percent-subscription-churn/partial/); vendor-circulated, methodology not published]**.

## Who has it

**[assume]** Owner-operators with 30 to 2,000 subscribers, $8–$60 a month per member, billing on PayPal (not Shopify subscriptions), English-speaking markets first (US, UK, Australia, Singapore). Job title: founder. Device: phone between jobs, laptop at night.

## How they solve it today

| Option | What it costs | Why it falls short for this owner |
|---|---|---|
| PayPal dashboard + email by hand | Owner's evenings **[assume]** | No skip or pause rules, no agent endpoint, no reason capture |
| [Recharge](https://www.ringly.io/blog/recharge-subscriptions-pricing) (Shopify) | $99/mo + 1.49% + $0.19 per transaction; a $25 entry tier for new merchants since Feb 2026 **[est, third-party breakdown]** | Shopify-only; a whole billing stack to adopt |
| [Loop Subscriptions](https://www.loopwork.co/compare/recharge-alternative) | $99/mo + 1.0%; free under 50 subscriptions **[est, vendor page]** | Shopify-only |
| [Churnkey](https://churnkey.co/pricing.md) | Published tiers reported at $250–$825/mo, now possibly sales-led **[est, conflicting sources]** | Built for SaaS on Stripe/Chargebee; priced beyond a 200-member coffee club |
| [ProsperStack](https://toolradar.com/tools/prosperstack/pricing) | ~$200–$750/mo by cancel sessions **[est]** | Same: SaaS cancel-flow tool |
| [Chargebee Retention](https://www.chargebee.com/docs/retention/getting-started-guide/retention-workflow-session-fees-in-chargebee-retention) (ex-Brightback) | Usage-based; third-party listings from $250/mo **[est]** | Now folded into Chargebee Growth; needs Chargebee billing |
| [Paddle Retain](https://developer.paddle.com/build/retain/configure-cancellation-flows-surveys) | Included for Paddle Billing; standalone from ~$500/mo **[est]** | A five-step flow (reason, insight, salvage, offer, feedback) by design |

**The gap [assume, our positioning]:** every retention tool above sells a *save flow*, measured by how many cancels it stops. None is built for PayPal-billed small shops, none treats a buyer's AI agent as a first-class customer, and none makes "cancel in one step" a guarantee enforced in code.

Visual style of these products was not audited screen by screen in this session; the cancel-flow vendors broadly present as B2B SaaS dashboards **[assume]**. Kept should look like a tool a shopkeeper owns, not a growth-hacking console.

## Promise

**"Let people and their AI assistants change or cancel in one step, and keep the ones who'd rather pause."**

Three jobs it must make effortless:
1. **Members change their subscription themselves** (skip, pause, switch, cancel), by web or through their agent, within rules the owner wrote in plain words.
2. **The owner sees what needs them and nothing else**: held offers, failed renewals, and why people leave.
3. **Every change matches PayPal**: no "we think they cancelled"; a PayPal read-back, a trace and a timeline for each.

Proof points a sceptical owner needs before trusting it with money:
- It never moves money PayPal didn't approve; prices it sends come from the owner's own form, not a model.
- Cancelling can't be blocked, even by the owner's own rules (shown, with the law cited).
- A live sandbox run they can watch: subscribe, skip, switch, cancel, each with PayPal's status.
- What is real and what is simulated, labelled on one page.

## Who decides what (the trust pattern)

| AI proposes | Code decides | PayPal moves money |
|---|---|---|
| Reads plans and rules from plain words; labels a cancel reason; words the offer; answers "why are people leaving?" | Which offers a member is eligible for; prices and discount amounts; whether a move needs the owner (autonomy, compliance, kill switches); that a cancel always goes through | Creates plans and subscriptions; suspends, revises, cancels, captures; the subscriber approves on PayPal's own page |

This becomes a visible three-part strip in the UI: on every money screen and in every timeline step, the actor is shown as **AI**, **Rule** or **PayPal**.
