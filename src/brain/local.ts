import { DEFAULT_RULES, refundCapFrom, Rules } from "../policy/rules.js";
import { offerTemplate, paymentFailureTemplate, type Lang } from "../i18n.js";
import { FORBIDDEN_PHRASES } from "../policy/compliance.js";
import type { EligibleOffer } from "../policy/eligibility.js";
import type { IntervalUnit } from "../paypal/types.js";
import { Brain, Draft, DraftPlan, OfferChoice, ReasonCategory, ShopStats } from "./types.js";

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, once: 1, single: 1, two: 2, twice: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

function num(token: string | undefined, dflt: number): number {
  if (!token) return dflt;
  const t = token.toLowerCase().trim();
  if (/^\d+$/.test(t)) return Number(t);
  return WORD_NUMBERS[t] ?? dflt;
}

const NUM = String.raw`(\d+|a|an|one|once|single|two|twice|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

function periodDays(word: string, count = 1): number {
  const w = word.toLowerCase();
  if (w.startsWith("day")) return count;
  if (w.startsWith("week")) return 7 * count;
  if (w.startsWith("month")) return 30 * count;
  if (w.startsWith("quarter")) return 90 * count;
  if (w.startsWith("year") || w.startsWith("annual")) return 365 * count;
  return 30 * count;
}

function detectInterval(line: string): { unit: IntervalUnit; count: number; words: string } | null {
  const l = line.toLowerCase();
  const every = l.match(new RegExp(String.raw`every\s+${NUM}\s+(day|week|month|year)s?`));
  if (every) return { unit: every[2].toUpperCase() as IntervalUnit, count: num(every[1], 1), words: every[0] };
  if (/\b(fortnight(ly)?|bi-?weekly|every other week)\b/.test(l)) return { unit: "WEEK", count: 2, words: "every 2 weeks" };
  if (/\b(daily|per day|a day|\/day|each day|every day)\b/.test(l)) return { unit: "DAY", count: 1, words: "daily" };
  if (/\b(weekly|per week|a week|\/wk|\/week|each week|every week)\b/.test(l)) return { unit: "WEEK", count: 1, words: "weekly" };
  if (/\b(quarterly|per quarter|every quarter)\b/.test(l)) return { unit: "MONTH", count: 3, words: "every 3 months" };
  if (/\b(yearly|annual(ly)?|per year|a year|\/yr|\/year|each year|every year)\b/.test(l)) return { unit: "YEAR", count: 1, words: "yearly" };
  if (/\b(monthly|per month|a month|\/mo|\/month|each month|every month|month)\b/.test(l)) return { unit: "MONTH", count: 1, words: "monthly" };
  return null;
}

const LITE_WORDS = /\b(lite|light|half|mini|small|smaller|basic|starter|essential|single)\b/i;

const REASON_PATTERNS: [ReasonCategory, RegExp][] = [
  ["payment", /\b(card|payment (failed|issue|problem)|bank|declin|expired card|billing (issue|problem))\b/i],
  ["competitor", /\b(switch(ing)? to|cheaper (elsewhere|somewhere)|another (brand|company|service|shop)|competitor|found a better|going with)\b/i],
  ["price", /\b(expensive|afford|money|cost|costs|price|pricey|budget|tight|too much money|save money|broke|cheaper)\b/i],
  ["too_much", /\b(too much|piling|pile|backlog|have enough|surplus|stockpile|not using|don't use|dont use|unused|too many|leftover|can't keep up|cant keep up)\b/i],
  ["away", /\b(travel|travelling|traveling|moving|move house|away|vacation|holiday|trip|relocat|abroad|out of town)\b/i],
  ["quality", /\b(quality|taste|tastes|stale|broken|not good|disappoint|bad|worse|damaged|late deliver|arrived late)\b/i],
  ["no_need", /\b(don't need|dont need|no longer|not needed|stopped|quit|gave up|done with|diet)\b/i],
];

const OFFER_PREFERENCE: Record<ReasonCategory, string[]> = {
  price: ["discount", "switch_plan", "skip", "pause"],
  too_much: ["skip", "pause", "switch_plan"],
  away: ["pause", "skip"],
  competitor: ["discount", "switch_plan"],
  no_need: ["pause"],
  other: ["pause", "skip", "switch_plan", "discount"],
  quality: [],
  payment: [],
};

const RATIONALE: Record<ReasonCategory, string> = {
  price: "The reason is cost, so a cheaper option comes first.",
  too_much: "They have more than they use, so skipping or pausing fits better than a discount.",
  away: "They are away for a while, so a pause fits.",
  competitor: "They are comparing on price, so the best permitted price comes first.",
  no_need: "They no longer need it; at most a pause, in case that changes.",
  other: "No clear reason, so the lightest-touch option comes first.",
  quality: "The problem is quality. A discount would not fix it, so no offer is made and the feedback goes to the owner.",
  payment: "The problem is payment, not the product, so the payment fix is offered instead of a retention offer.",
};

function fmt(n: number, currency: string) {
  const sym = currency === "USD" ? "$" : currency === "SGD" ? "S$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : "";
  return sym ? `${sym}${n.toFixed(2)}` : `${n.toFixed(2)} ${currency}`;
}

export class LocalBrain implements Brain {
  readonly name = "local (deterministic)";
  lastVia() {
    return "rules";
  }

  async draftPlans(text: string, currency: string): Promise<Draft<DraftPlan[]>> {
    return this.draftPlansSync(text, currency);
  }

  draftPlansSync(text: string, currency: string): Draft<DraftPlan[]> {
    const understood: string[] = [];
    const warnings: string[] = [];
    const lines = text
      .split(/\n|;|(?<=\d)\s*,\s*(?=[A-Za-z])/)
      .map((l) => l.trim().replace(/^[-*•\d.)\s]+(?=[A-Za-z$£€])/, ""))
      .filter(Boolean);
    const plans: DraftPlan[] = [];
    for (const line of lines) {
      // Prefer a number with a currency sign or word; otherwise a bare number that isn't a quantity (340g, 2kg, 12oz, 3 pack).
      const priceM =
        line.match(/(?:US\$|S\$|A\$|\$|£|€)\s*(\d{1,5}(?:\.\d{1,2})?)/i) ||
        line.match(/(\d{1,5}(?:\.\d{1,2})?)\s*(?:usd|sgd|aud|eur|gbp|dollars?)\b/i) ||
        line.match(/(?<![\d.])(\d{1,5}(?:\.\d{1,2})?)(?!\s*(?:g|kg|ml|l|oz|lb|lbs|pack|pk|x|%|cups?|bags?|items?|pcs|meals?)\b)(?![\d.])/i);
      if (!priceM || !/[a-z]/i.test(line)) {
        warnings.push(`Skipped "${line}": no price found.`);
        continue;
      }
      const price = Number(priceM[1]);
      if (!(price >= 1 && price <= 10000)) {
        warnings.push(`Skipped "${line}": price ${price} is outside 1 to 10,000.`);
        continue;
      }
      const iv = detectInterval(line);
      if (!iv) warnings.push(`"${line}": no billing interval found, so it bills monthly.`);
      const interval = iv ?? { unit: "MONTH" as IntervalUnit, count: 1, words: "monthly" };
      let name = line
        .slice(0, priceM.index)
        .replace(/\b(for|at|costs?|is|priced|plan|:|-|–|—)\s*$/i, "")
        .replace(/[:\-–—,]+\s*$/, "")
        .trim();
      if (!name) name = line.slice((priceM.index ?? 0) + priceM[0].length).replace(detectInterval(line)?.words ?? "", "").replace(/^[\s,:\-–—]+|(per|a|every|each)\s*$/gi, "").trim();
      if (!name) name = `Plan ${plans.length + 1}`;
      name = name.replace(/\b(monthly|weekly|yearly|annual|daily)\b\s*$/i, (m) => m).slice(0, 60);
      name = name.charAt(0).toUpperCase() + name.slice(1);
      plans.push({ name, description: line.slice(0, 120), price, intervalUnit: interval.unit, intervalCount: interval.count, kind: LITE_WORDS.test(name) ? "lite" : "regular" });
    }
    if (plans.length >= 2 && !plans.some((p) => p.kind === "lite")) {
      const cheapest = [...plans].sort((a, b) => a.price - b.price)[0];
      const same = plans.filter((p) => p.intervalUnit === cheapest.intervalUnit && p.intervalCount === cheapest.intervalCount);
      if (same.length >= 2) {
        cheapest.kind = "lite";
        understood.push(`"${cheapest.name}" is the cheapest, so it is used as the lighter plan subscribers can switch to.`);
      }
    }
    for (const p of plans) {
      understood.push(`${p.name}: ${fmt(p.price, currency)} ${p.intervalCount > 1 ? `every ${p.intervalCount} ${p.intervalUnit.toLowerCase()}s` : `per ${p.intervalUnit.toLowerCase()}`}${p.kind === "lite" ? " (lighter plan)" : ""}.`);
    }
    if (!plans.length) warnings.push("No plans found. Try one per line, like \"Monthly bag $24\".");
    return { value: plans, understood, warnings };
  }

  async draftRules(text: string): Promise<Draft<Rules>> {
    return this.draftRulesSync(text);
  }

  draftRulesSync(text: string): Draft<Rules> {
    const t = " " + text.toLowerCase().replace(/\s+/g, " ") + " ";
    const r: Rules = JSON.parse(JSON.stringify(DEFAULT_RULES));
    const understood: string[] = [];
    const warnings: string[] = [];

    // Skips: "one skip per quarter", "2 skips a year", "can skip a delivery"
    const skipM = t.match(new RegExp(String.raw`${NUM}\s+skips?\s+(?:per|a|an|every|each)\s+(?:(\d+)\s+)?(day|week|month|quarter|year)s?`)) || t.match(new RegExp(String.raw`skip\w*\s+(?:up to\s+)?${NUM}\s+(?:times?|renewals?|deliveries|delivery|months?)?\s*(?:per|a|an|every|each)\s+(?:(\d+)\s+)?(day|week|month|quarter|year)s?`));
    if (skipM) {
      r.skip = { enabled: true, maxPerPeriod: Math.min(12, Math.max(1, num(skipM[1], 1))), periodDays: Math.min(366, Math.max(7, periodDays(skipM[3], skipM[2] ? Number(skipM[2]) : 1))) };
      understood.push(`Skips: ${r.skip.maxPerPeriod} per ${r.skip.periodDays} days.`);
    } else if (/\bskip/.test(t) && !/\bno skip|\bnever skip|\bdon'?t (allow|offer) skip/.test(t)) {
      r.skip = { enabled: true, maxPerPeriod: 1, periodDays: 90 };
      understood.push("Skips: allowed; no limit given, so 1 per 90 days.");
    }

    // Pause: "pause up to 2 months", "pause for a month"
    const pauseM = t.match(new RegExp(String.raw`pause\w*\s+(?:for\s+)?(?:up to\s+|at most\s+|max(?:imum)?\s+)?${NUM}\s+(month|week|cycle|billing cycle|delivery|deliveries|renewal)s?`));
    if (pauseM) {
      r.pause = { enabled: true, maxCycles: Math.min(6, Math.max(1, num(pauseM[1], 1))) };
      understood.push(`Pauses: up to ${r.pause.maxCycles} cycle${r.pause.maxCycles > 1 ? "s" : ""}.`);
    } else if (/\bpaus/.test(t) && !/\bno paus|\bnever paus|\bdon'?t (allow|offer) paus/.test(t)) {
      r.pause = { enabled: true, maxCycles: 1 };
      understood.push("Pauses: allowed; no length given, so 1 cycle.");
    }

    // Switch to the lighter plan.
    if (/\b(switch|downgrade|move|drop)\w*\b.{0,30}\b(lite|light|half|smaller|cheaper|lower|basic|mini)\b/.test(t) || /\b(lite|half|smaller) plan\b/.test(t)) {
      r.switchToLite = { enabled: true };
      understood.push("Switching to the lighter plan: allowed.");
    }

    // Discounts: "at most 20% off for 3 months", "15% off for 2 months"
    const discM = t.match(new RegExp(String.raw`(?:(?:at most|up to|max(?:imum)?|no more than)\s+)?(\d{1,2})\s?%\s*(?:off|discount)(?:\s+for\s+(?:up to\s+)?${NUM}\s+(month|week|cycle|renewal|billing cycle)s?)?`));
    if (discM && !/\bno discount|\bnever discount|\bdon'?t (offer|give) discount/.test(t)) {
      const pct = Math.min(50, Math.max(1, Number(discM[1])));
      const cycles = Math.min(12, Math.max(1, num(discM[2], 1)));
      r.discount = { enabled: true, percent: pct, cycles };
      r.maxDiscountPercent = pct;
      understood.push(`Discount: ${pct}% off for ${cycles} cycle${cycles > 1 ? "s" : ""}, then back to full price.`);
      if (Number(discM[1]) > 50) warnings.push("Discounts are capped at 50%.");
      if (!discM[2]) warnings.push("No discount length given, so it lasts 1 cycle.");
    }

    // Tenure: "only for subscribers of 3 months or more", "after 2 months"
    const tenM = t.match(new RegExp(String.raw`(?:subscribers? (?:of|for)|after|at least|more than)\s+${NUM}\s+(month|week|day)s?`));
    if (tenM && r.discount.enabled) {
      r.minTenureDaysForDiscount = Math.min(730, periodDays(tenM[2], num(tenM[1], 1)));
      understood.push(`Discount only for subscribers of at least ${r.minTenureDaysForDiscount} days.`);
    }

    // Cooldown: "one offer per year", "once every 6 months"
    const coolM = t.match(new RegExp(String.raw`(?:one|1|a single)\s+offer\s+(?:per|a|an|every|each)\s+(?:(\d+)\s+)?(month|quarter|year)s?`)) || t.match(new RegExp(String.raw`offers?\s+(?:at most\s+)?once\s+(?:per|a|an|every|each)\s+(?:(\d+)\s+)?(month|quarter|year)s?`));
    if (coolM) {
      r.offerCooldownDays = Math.min(730, periodDays(coolM[2], coolM[1] ? Number(coolM[1]) : 1));
      understood.push(`At most one offer per subscriber every ${r.offerCooldownDays} days.`);
    } else {
      understood.push(`At most one offer per subscriber every ${r.offerCooldownDays} days (default).`);
    }

    if (/\b(make it hard|block|prevent|stop them|don'?t let them) (to )?cancel/.test(t) || /\bcan'?t cancel\b/.test(t)) {
      warnings.push("Kept never makes cancelling harder. Cancelling always works in one step, so that part was ignored.");
    }
    // Anything the law forbids is refused with its citation (compliance scorecard, roadmap K2).
    for (const f of FORBIDDEN_PHRASES) if (f.re.test(text) && !warnings.some((w) => w.includes(f.ruleId))) warnings.push(`[${f.ruleId}] ${f.message}`);

    // Renewal reminders: "remind people 10 days before", "no reminders"
    const remM = t.match(new RegExp(String.raw`remind\w*\s+(?:people|them|subscribers)?\s*(?:(\d{1,2}|${NUM.slice(1, -1)})\s+days?\s+before)`));
    if (remM) {
      r.renewalReminderDays = Math.min(60, Math.max(1, num(remM[1], 7)));
      understood.push(`Renewal reminder ${r.renewalReminderDays} days before each charge.`);
    } else if (/\b(no|without|skip)\s+(renewal\s+)?reminders?\b/.test(t)) {
      r.renewalReminderDays = 0;
      understood.push("No renewal reminders (allowed only while no plan bills yearly or longer).");
    }
    // Refund of the unused part on cancel: "refund the unused part of the month on cancel, up to $10"
    const refCap = refundCapFrom(t);
    if (refCap !== null && refCap > 0) {
      r.refundUnused = { enabled: true, maxAmount: refCap };
      understood.push(`On cancel, refund the unused part of the current cycle, up to ${r.refundUnused.maxAmount.toFixed(2)}.`);
    }
    // Jurisdiction: "my customers are in California", "New York law", "we sell in the EU"
    const jur: [RegExp, Rules["jurisdiction"]][] = [[/\bcalifornia\b|\bca law\b/, "US_CA"], [/\bcolorado\b/, "US_CO"], [/\bnew york\b|\bny law\b/, "US_NY"], [/\b(eu|european union|europe)\b/, "EU"], [/\b(uk|united kingdom|britain)\b/, "UK"]];
    for (const [re, j] of jur) if (re.test(t)) { r.jurisdiction = j; understood.push(`Scored against ${j.replace("US_", "")} rules on the compliance page.`); break; }
    understood.push("Cancelling always works in one step; hearing an offer is optional.");
    if (!r.skip.enabled && !r.pause.enabled && !r.switchToLite.enabled && !r.discount.enabled) {
      warnings.push("No retention options found, so cancels go through with no offer. Try: \"one skip per quarter; pause up to 2 months; switch to Lite; at most 15% off for 3 months\".");
    }
    return { value: r, understood, warnings };
  }

  async classifyReason(text: string): Promise<ReasonCategory> {
    return this.classifyReasonSync(text);
  }

  classifyReasonSync(text: string): ReasonCategory {
    if (!text || !text.trim()) return "other";
    for (const [cat, re] of REASON_PATTERNS) if (re.test(text)) return cat;
    return "other";
  }

  pickOffer(eligible: EligibleOffer[], category: ReasonCategory): OfferChoice {
    const order = OFFER_PREFERENCE[category];
    for (const type of order) {
      const candidates = eligible.filter((o) => o.type === type).sort((a, b) => b.keptValue3 - a.keptValue3);
      if (candidates[0]) return { key: candidates[0].key, rationale: RATIONALE[category] };
    }
    return { key: null, rationale: eligible.length ? RATIONALE[category] : "No offer is allowed for this subscriber right now." };
  }

  async wordOffer(offer: EligibleOffer, ctx: { merchantName: string; currency: string; category: ReasonCategory; subscriberName?: string | null; lang?: Lang }): Promise<string> {
    return this.wordOfferSync(offer, ctx);
  }

  wordOfferSync(offer: EligibleOffer, ctx: { merchantName: string; currency: string; category: ReasonCategory; subscriberName?: string | null; lang?: Lang }): string {
    if (ctx.lang && ctx.lang !== "en") return offerTemplate(offer, ctx, ctx.lang, () => "");
    const hi = ctx.subscriberName ? `${ctx.subscriberName.split(" ")[0]}, ` : "";
    const lead: Record<ReasonCategory, string> = {
      price: "Understood, money matters.",
      too_much: "Makes sense if it's piling up.",
      away: "Safe travels.",
      competitor: "Fair enough to shop around.",
      no_need: "Understood.",
      other: "Understood.",
      quality: "Thanks for telling us.",
      payment: "Thanks for letting us know.",
    };
    const body = (() => {
      switch (offer.type) {
        case "pause":
          return `we can pause your ${ctx.merchantName} subscription for ${offer.terms.cycles} billing cycle${(offer.terms.cycles ?? 1) > 1 ? "s" : ""} instead, with nothing charged until it restarts.`;
        case "skip":
          return `we can skip just your next renewal, so you aren't charged for it, and carry on after that.`;
        case "switch_plan":
          return `we can move you to ${offer.terms.toPlanName} at ${fmt(offer.terms.newPrice ?? 0, ctx.currency)} per cycle instead.`;
        case "discount":
          return `we can take ${offer.terms.percent}% off for the next ${offer.terms.cycles} cycle${(offer.terms.cycles ?? 1) > 1 ? "s" : ""} (${fmt(offer.terms.newPrice ?? 0, ctx.currency)} each), then it returns to the usual price.`;
      }
    })();
    return `${lead[ctx.category]} ${hi}${body} If you'd rather cancel, say no and it's cancelled straight away.`;
  }

  async explainPaymentFailure(ctx: { merchantName: string; amount: number; currency: string; attempts: number; manageUrl: string; lang?: Lang }): Promise<string> {
    return this.explainPaymentFailureSync(ctx);
  }

  explainPaymentFailureSync(ctx: { merchantName: string; amount: number; currency: string; attempts: number; manageUrl: string; lang?: Lang }): string {
    if (ctx.lang && ctx.lang !== "en") return paymentFailureTemplate(ctx, ctx.lang, () => "");
    return `Your ${ctx.merchantName} renewal of ${fmt(ctx.amount, ctx.currency)} didn't go through (attempt ${ctx.attempts}). This usually means the card or bank linked to PayPal has expired or changed. Update your payment method in your PayPal account, then use ${ctx.manageUrl} to retry. Nothing else changes; if you'd rather stop, you can cancel from the same page.`;
  }

  async answer(question: string, s: ShopStats): Promise<string> {
    return this.answerSync(question, s);
  }

  answerSync(question: string, s: ShopStats): string {
    const q = question.toLowerCase();
    const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
    const money = (n: number) => fmt(n, s.currency);
    const reasonLabel: Record<ReasonCategory, string> = {
      price: "cost", too_much: "too much product", away: "being away", quality: "quality", competitor: "switching to someone else", no_need: "no longer needed", payment: "payment problems", other: "other or no reason",
    };
    if (/\b(why|reason|leav|cancel|churn|quit)/.test(q)) {
      const total = s.reasons.reduce((a, r) => a + r.count, 0);
      if (!total) return "No cancellation reasons recorded yet.";
      const top = [...s.reasons].sort((a, b) => b.count - a.count).slice(0, 3);
      const lines = top.map((r) => `${reasonLabel[r.category]}: ${r.count} of ${total} (${pct(r.count, total)}%)${r.examples[0] ? `, e.g. "${r.examples[0]}"` : ""}`);
      const tip = top[0].category === "quality" ? "Quality is the top reason; offers can't fix that, so it's worth looking at the product or delivery." : top[0].category === "price" ? "Cost is the top reason; a lighter plan or a short discount is your best lever." : top[0].category === "too_much" ? "People have too much; promoting skips or a lighter plan may help." : "";
      return `Top reasons people gave for cancelling: ${lines.join("; ")}. ${tip}`.trim();
    }
    if (/\b(kept|saved|retain|revenue|money|mrr|earn)/.test(q)) {
      return `Monthly recurring revenue is about ${money(s.mrr)} from ${s.active} active subscribers. Accepted offers kept about ${money(s.revenueKept3)} over the next three cycles compared with cancelling. ${s.offersAccepted} of ${s.offersMade} offers were accepted (${pct(s.offersAccepted, s.offersMade)}%).`;
    }
    if (/\b(offer|accept)/.test(q)) {
      return `${s.offersMade} offers made, ${s.offersAccepted} accepted (${pct(s.offersAccepted, s.offersMade)}%). ${s.cancelsHonoured} cancels went through, all in one step.`;
    }
    if (/\b(agent|ai|channel|bot)/.test(q)) {
      return `${s.agentShare}% of subscriber actions came from AI agents; the rest came from people on the web.`;
    }
    if (/\b(risk|fail|overdue|outstanding|unpaid|payment)/.test(q)) {
      if (!s.failing.length) return "No subscribers have a failed payment right now.";
      return `${s.failing.length} subscriber${s.failing.length > 1 ? "s have" : " has"} an unpaid renewal: ${s.failing.slice(0, 5).map((f) => `${f.name} (${money(f.outstanding)})`).join(", ")}. Kept has sent each a fix link and will collect the balance once their payment method works.`;
    }
    if (/\b(renew|upcoming|next week|calendar)/.test(q)) {
      return `${s.upcomingRenewals7d} renewal${s.upcomingRenewals7d === 1 ? "" : "s"} due in the next 7 days.`;
    }
    return `${s.merchantName}: ${s.active} active, ${s.suspended} paused or suspended, ${s.cancelled} cancelled. MRR about ${money(s.mrr)}. Offers accepted ${s.offersAccepted} of ${s.offersMade}. Ask me why people cancel, how much was kept, or who has a failed payment.`;
  }
}
