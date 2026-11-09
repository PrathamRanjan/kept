# Compliance scorecard: rules, sources and limits

Kept scores a shop's retention policy against subscription-law requirements, per jurisdiction, in code (`src/policy/compliance.ts`). The scorecard is informational for the owner and **enforced in the gate**: a failing rule for the buyer's jurisdiction blocks the offer step (the cancel still goes through). Plain-words rules that ask for something forbidden are refused at drafting time with the citation (`FORBIDDEN_PHRASES`).

Every source below is marked **[verify]**: the citations were written from general knowledge of the statutes and must be checked against the current text before this page is shown to a customer as legal guidance. Kept is not legal advice.

| Rule | Jurisdiction | Requirement checked | How Kept checks it | Source [verify] |
|---|---|---|---|---|
| ROSCA-1 | US federal | Simple cancellation, at least as easy as sign-up | `neverBlockCancel === true` and `offersBeforeCancel <= 1`; `cancel_subscription` is one call | 15 U.S.C. §8403(3); FTC Negative Option Rule / Amazon Prime settlement 2025 |
| ROSCA-2 | US federal | Clear disclosure of material terms before billing | plan price, interval and cancel terms present at enrolment (`CheckContext.disclosure`) | 15 U.S.C. §8403(1) |
| ROSCA-3 | US federal | Express informed consent before charging | PayPal approval step before any charge; nothing charged on `start_subscription` | 15 U.S.C. §8403(2) |
| KEPT-OFFER | Kept policy | At most one retention offer, optional, never blocking | `offersBeforeCancel` is a literal 1 in the schema | Kept design rule derived from ROSCA-1 and Cal. §17602(d) |
| CA-1 | California | Online cancellation for online sign-ups | no phone/chat requirement in rules; one-call cancel | Cal. Bus. & Prof. Code §17602(c) |
| CA-2 | California | Save offers must not obstruct | one optional offer, cancel proceeds immediately on decline | Cal. Bus. & Prof. Code §17602(d) |
| CA-3 | California | Renewal reminder for terms of a year or longer | `renewalReminderDays > 0` when any plan is annual | Cal. Bus. & Prof. Code §17602(b) |
| CO-1 | Colorado | Online cancellation | as CA-1 | Colo. Rev. Stat. §6-1-732 |
| CO-2 | Colorado | Renewal notice for annual terms | as CA-3 | Colo. Rev. Stat. §6-1-732 |
| NY-1 | New York | Renewal reminder for annual terms | as CA-3 | N.Y. Gen. Bus. Law §527-a |
| NY-2 | New York | Online cancellation | as CA-1 | N.Y. Gen. Bus. Law §527-a |
| EU-1 | EU (informational) | Right of withdrawal and clear pre-contract information | reported, not enforced: Kept does not implement the 14-day withdrawal flow | Consumer Rights Directive 2011/83/EU |
| UK-1 | UK (informational) | Subscription contract rules (reminders, easy exit) | reported, not enforced | Digital Markets, Competition and Consumers Act 2024 (subscription provisions) |

## Forbidden phrases (refused at drafting)

| Pattern | Refused as | Message |
|---|---|---|
| "three offers before cancel" | KEPT-OFFER | more than one offer before a cancel |
| "must call to cancel" | CA-1 | requiring a call/chat to cancel |
| "make it hard / block cancel" | ROSCA-1 | obstructing a cancel |
| "hide the cancel / price" | ROSCA-2 | hiding terms |
| "no renewal reminders" | NY-1 | only allowed where no plan bills yearly or longer |

## What the scorecard does not do

- It scores the **policy**, not the shop's website copy or email practice.
- Jurisdiction comes from the subscriber's stated jurisdiction when known, else the shop's default; Kept does not geolocate.
- EU and UK rows are informational: Kept reports them and does not block on them.
- Sources need legal review before the page is presented as compliance evidence to a merchant.
