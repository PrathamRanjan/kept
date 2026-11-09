/**
 * Compliance scorecard (roadmap K2). A rules table per jurisdiction for negative-option subscriptions: the US
 * federal ROSCA baseline, California, Colorado and New York, with the EU and UK as informational. The owner's
 * compiled policy is scored against it; any failing rule blocks the offer step in code (src/guard/dryrun.ts).
 *
 * The legal summaries are paraphrases for a product scorecard, not legal advice. Each row cites its source in
 * docs/compliance.md with a [verify] mark where the wording should be checked against the statute before launch.
 * The FTC's 2024 "click-to-cancel" rule was vacated by the Eighth Circuit on 8 July 2025, so the federal baseline
 * here is ROSCA and FTC Act section 5 enforcement, not that rule.
 */
import type { Rules } from "./rules.js";

export type Jurisdiction = "US_FEDERAL" | "US_CA" | "US_CO" | "US_NY" | "EU" | "UK";
export const JURISDICTIONS: { id: Jurisdiction; name: string; kind: "enforced" | "informational"; note: string }[] = [
  { id: "US_FEDERAL", name: "United States (federal)", kind: "enforced", note: "ROSCA (15 U.S.C. §8401 et seq.) and FTC Act §5. The 2024 FTC negative-option rule was vacated on 8 July 2025; a new ANPRM opened in 2026 [verify]." },
  { id: "US_CA", name: "California", kind: "enforced", note: "Automatic Renewal Law, Bus. & Prof. Code §17600 to §17606, as amended through 2025 [verify]." },
  { id: "US_CO", name: "Colorado", kind: "enforced", note: "Automatic renewal provisions in the Colorado Consumer Protection Act (HB21-1239) [verify]." },
  { id: "US_NY", name: "New York", kind: "enforced", note: "General Business Law §527-a (automatic renewal) [verify]." },
  { id: "EU", name: "European Union", kind: "informational", note: "Consumer Rights Directive 2011/83/EU and the Unfair Commercial Practices Directive; member-state law varies. Informational only." },
  { id: "UK", name: "United Kingdom", kind: "informational", note: "Digital Markets, Competition and Consumers Act 2024 subscription provisions; commencement in stages [verify]. Informational only." },
];

export type RuleStatus = "pass" | "fail" | "info";
export interface ComplianceRule {
  id: string;
  jurisdiction: Jurisdiction;
  title: string;
  requirement: string;
  /** Returns pass/fail (or info for jurisdictions Kept only reports on) plus what Kept checked. */
  check: (rules: Rules, ctx: CheckContext) => { status: RuleStatus; evidence: string };
  source: string;
}
export interface CheckContext {
  /** Plan descriptions shown at enrolment; used for the disclosure check. */
  disclosure: { price: boolean; interval: boolean; cancelTerms: boolean };
  /** Whether any plan bills yearly or longer (reminder rules bite there). */
  hasAnnualPlans: boolean;
}
export const DEFAULT_CTX: CheckContext = { disclosure: { price: true, interval: true, cancelTerms: true }, hasAnnualPlans: false };

const reminderDays = (r: Rules) => r.renewalReminderDays ?? 0;
const offersBeforeCancel = (r: Rules) => r.offersBeforeCancel ?? 1;

function symmetric(r: Rules) {
  // One call cancels; hearing an offer is optional; an offer never blocks. All three are literals in RulesSchema
  // and checked here again so a hand-edited policy row cannot slip through.
  return r.neverBlockCancel === true && offersBeforeCancel(r) <= 1;
}

export const RULES: ComplianceRule[] = [
  {
    id: "ROSCA-1", jurisdiction: "US_FEDERAL", title: "Simple cancellation", requirement: "A consumer can stop recurring charges through a simple mechanism, at least as easy as the one used to sign up.",
    check: (r) => ({ status: symmetric(r) ? "pass" : "fail", evidence: symmetric(r) ? "cancel_subscription is one call or one click; hearing an offer is optional; an offer never blocks a cancel" : "the policy asks for more than one offer or a blocked cancel" }),
    source: "15 U.S.C. §8403(3); FTC enforcement incl. Amazon Prime settlement (2025) [verify]",
  },
  {
    id: "ROSCA-2", jurisdiction: "US_FEDERAL", title: "Clear disclosure before billing", requirement: "Material terms (price, billing interval, how to cancel) are disclosed clearly before obtaining billing information.",
    check: (_r, ctx) => { const ok = ctx.disclosure.price && ctx.disclosure.interval && ctx.disclosure.cancelTerms; return { status: ok ? "pass" : "fail", evidence: ok ? "quote and start_subscription return price, interval and cancellation terms before the PayPal approval link" : "a plan is missing price, interval or cancellation terms at enrolment" }; },
    source: "15 U.S.C. §8403(1) [verify]",
  },
  {
    id: "ROSCA-3", jurisdiction: "US_FEDERAL", title: "Express informed consent", requirement: "Billing starts only after the consumer's express consent.",
    check: () => ({ status: "pass", evidence: "every subscription starts with the subscriber approving on PayPal's own page; agents never hold payment details" }),
    source: "15 U.S.C. §8403(2) [verify]",
  },
  {
    id: "KEPT-OFFER", jurisdiction: "US_FEDERAL", title: "One honest offer, never a hurdle", requirement: "At most one retention offer, only if the subscriber asks to hear one; declining or ignoring it cancels.",
    check: (r) => ({ status: offersBeforeCancel(r) <= 1 ? "pass" : "fail", evidence: `offers before cancel: ${offersBeforeCancel(r)}; offer expiry ${r.offerExpiryMinutes} minutes then the cancel proceeds` }),
    source: "FTC dark-pattern guidance (2022 staff report) and ROSCA §8403(3) [verify]",
  },
  {
    id: "CA-1", jurisdiction: "US_CA", title: "Online cancellation", requirement: "A subscription accepted online can be cancelled online, without extra steps that obstruct or delay.",
    check: (r) => ({ status: symmetric(r) ? "pass" : "fail", evidence: "the manage page and the API cancel in one step; no save-attempt is required" }),
    source: "Cal. Bus. & Prof. Code §17602(c) and (d) [verify]",
  },
  {
    id: "CA-2", jurisdiction: "US_CA", title: "Renewal reminder for annual terms", requirement: "For terms of a year or longer, a notice before renewal with the cancellation method.",
    check: (r, ctx) => (!ctx.hasAnnualPlans ? { status: "pass", evidence: "no plan bills yearly or longer" } : reminderDays(r) >= 15 && reminderDays(r) <= 45 ? { status: "pass", evidence: `renewal reminder ${reminderDays(r)} days before` } : { status: "fail", evidence: `renewal reminder is ${reminderDays(r)} days; needs 15 to 45 for annual plans` }),
    source: "Cal. Bus. & Prof. Code §17602(b) [verify exact window]",
  },
  {
    id: "CA-3", jurisdiction: "US_CA", title: "Offer presented once, cancellation still immediate", requirement: "A retention offer may be shown, but the consumer must be able to complete the cancellation without it.",
    check: (r) => ({ status: offersBeforeCancel(r) <= 1 && r.neverBlockCancel ? "pass" : "fail", evidence: "one optional offer; decline or silence cancels" }),
    source: "Cal. Bus. & Prof. Code §17602(d)(2) (2025 amendments) [verify]",
  },
  {
    id: "CO-1", jurisdiction: "US_CO", title: "Cancellation method matches sign-up", requirement: "Cancel in the same medium used to sign up; an online sign-up gets online cancellation.",
    check: (r) => ({ status: symmetric(r) ? "pass" : "fail", evidence: "web, REST and MCP all cancel in one step" }),
    source: "C.R.S. §6-1-732 (HB21-1239) [verify]",
  },
  {
    id: "CO-2", jurisdiction: "US_CO", title: "Annual renewal notice", requirement: "Notice before each automatic renewal of a term of a year or longer.",
    check: (r, ctx) => (!ctx.hasAnnualPlans ? { status: "pass", evidence: "no plan bills yearly or longer" } : reminderDays(r) >= 25 && reminderDays(r) <= 40 ? { status: "pass", evidence: `reminder ${reminderDays(r)} days before` } : { status: "fail", evidence: `reminder ${reminderDays(r)} days; needs 25 to 40 for annual plans` }),
    source: "C.R.S. §6-1-732(2) [verify exact window]",
  },
  {
    id: "NY-1", jurisdiction: "US_NY", title: "Annual renewal notice", requirement: "For terms of a year or longer, notice 15 to 45 days before renewal, with how to cancel.",
    check: (r, ctx) => (!ctx.hasAnnualPlans ? { status: "pass", evidence: "no plan bills yearly or longer" } : reminderDays(r) >= 15 && reminderDays(r) <= 45 ? { status: "pass", evidence: `reminder ${reminderDays(r)} days before` } : { status: "fail", evidence: `reminder ${reminderDays(r)} days; needs 15 to 45 for annual plans` }),
    source: "N.Y. Gen. Bus. Law §527-a(3) [verify]",
  },
  {
    id: "NY-2", jurisdiction: "US_NY", title: "Easy online cancellation", requirement: "Online sign-ups can cancel online, exclusively online if they wish.",
    check: (r) => ({ status: symmetric(r) ? "pass" : "fail", evidence: "one step on the manage page, over REST and over MCP" }),
    source: "N.Y. Gen. Bus. Law §527-a(4) [verify]",
  },
  {
    id: "EU-1", jurisdiction: "EU", title: "Withdrawal and clear pre-contract information", requirement: "14-day right of withdrawal from distance contracts and clear pre-contract terms; member-state rules on cancellation vary.",
    check: () => ({ status: "info", evidence: "informational: Kept shows price, interval and cancel terms before approval; withdrawal handling is the merchant's" }),
    source: "Directive 2011/83/EU arts. 6 and 9",
  },
  {
    id: "UK-1", jurisdiction: "UK", title: "Subscription reminders and easy exit", requirement: "Reminder notices before renewal and a straightforward way to end a subscription.",
    check: (r) => ({ status: "info", evidence: `informational: reminder ${reminderDays(r)} days; one-step cancel` }),
    source: "DMCC Act 2024, Part 4 Chapter 2 (commencement staged) [verify]",
  },
];

export interface Scorecard {
  jurisdiction: Jurisdiction;
  rules: (Pick<ComplianceRule, "id" | "jurisdiction" | "title" | "requirement" | "source"> & { status: RuleStatus; evidence: string })[];
  passed: number;
  failed: number;
  total: number;
}

/** Scores the owner's policy for one jurisdiction. Federal rules always apply to US states. */
export function scoreCompliance(rules: Rules, jurisdiction: Jurisdiction = "US_FEDERAL", ctx: CheckContext = DEFAULT_CTX): Scorecard {
  const applicable = RULES.filter((r) => r.jurisdiction === jurisdiction || (jurisdiction.startsWith("US_") && r.jurisdiction === "US_FEDERAL"));
  const rows = applicable.map((r) => ({ id: r.id, jurisdiction: r.jurisdiction, title: r.title, requirement: r.requirement, source: r.source, ...r.check(rules, ctx) }));
  const enforced = rows.filter((r) => r.status !== "info");
  return { jurisdiction, rules: rows, passed: enforced.filter((r) => r.status === "pass").length, failed: enforced.filter((r) => r.status === "fail").length, total: enforced.length };
}

/** Every jurisdiction at once, for the scorecard page. */
export function scoreAll(rules: Rules, ctx: CheckContext = DEFAULT_CTX): Scorecard[] {
  return JURISDICTIONS.map((j) => scoreCompliance(rules, j.id, ctx));
}

/** Phrases in an owner's plain-words rules that ask for something the law forbids; each is refused with its citation. */
export const FORBIDDEN_PHRASES: { re: RegExp; ruleId: string; message: string }[] = [
  { re: /\b(two|three|four|five|several|multiple|2|3|4|5)\s+offers?\b/i, ruleId: "KEPT-OFFER", message: "More than one offer before a cancel is refused: ROSCA §8403(3) and Cal. Bus. & Prof. Code §17602(d) require cancellation to be as simple as sign-up; Kept makes one optional offer." },
  { re: /\b(must|have to|need to|required to)\s+(call|phone|email|chat|speak|talk)\b.{0,30}\bcancel/i, ruleId: "CA-1", message: "Requiring a call or chat to cancel is refused: California §17602(c), Colorado §6-1-732 and New York §527-a require online cancellation for online sign-ups." },
  { re: /\b(make it hard|block|prevent|stop them|don'?t let them|no way)\b.{0,20}\bcancel/i, ruleId: "ROSCA-1", message: "Blocking or obstructing a cancel is refused under ROSCA §8403(3)." },
  { re: /\b(hide|bury|hidden)\b.{0,30}\b(cancel|price|renewal)/i, ruleId: "ROSCA-2", message: "Hiding the cancel path or the renewal terms is refused: ROSCA §8403(1) requires clear disclosure." },
  { re: /\b(no|skip|without)\s+(renewal\s+)?reminders?\b/i, ruleId: "NY-1", message: "Turning renewal reminders off is allowed only where no plan bills yearly or longer; New York §527-a, California §17602(b) and Colorado §6-1-732 require them for annual terms." },
];
