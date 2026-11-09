/**
 * Safety layer A: deterministic rules (SAFETY_ACCESSIBILITY_SPEC §4.1). Pure functions, no I/O, no PayPal.
 * Every result is a level plus plain-word reasons; nothing here can approve a payment, it can only raise the level
 * the money gate then enforces. The tactic regexes are the same weak-label seeds the text model was trained with
 * (guard-lab/scripts/prepare.py), so the server and the browser model name tactics the same way.
 */
export type Level = "clear" | "caution" | "hold";
export const TACTICS = ["impersonation", "urgency_secrecy", "changed_details", "off_platform", "gift_cards_crypto", "fee_to_release", "otp_or_link", "overpay_refund", "too_good"] as const;
export type Tactic = (typeof TACTICS)[number];

const SEEDS: Record<Tactic, RegExp> = {
  changed_details: /\b(new|updated?|changed?)\b.{0,40}\b(bank|account|acct|iban|beneficiary|payout|payment details|paypal (email|address|account)|upi id)\b|\b(bank|account) (details|number) (has|have) changed/i,
  off_platform: /\b(whatsapp|telegram|signal|outside (of )?(paypal|the app|platform)|pay (me )?directly|bank transfer instead|cash ?app|zelle|western union|moneygram)\b/i,
  gift_cards_crypto: /\b(gift ?cards?|itunes|google play card|steam card|bitcoin|btc|usdt|crypto|wallet address)\b/i,
  fee_to_release: /\b(processing|release|clearance|delivery|customs|handling|admin|unlock|activation) fee\b|pay .{0,20}\bto (release|claim|unlock|receive)\b/i,
  otp_or_link: /\b(otp|one[- ]time (code|password)|verification code|passcode|pin)\b|https?:\/\/|\bclick (here|the link|below)\b|\bbit\.ly\b|\btinyurl\b/i,
  overpay_refund: /\b(over ?pa(id|yment)|sent (you )?too much|refund (the|me the) (difference|extra|excess)|paid extra by mistake)\b/i,
  too_good: /\b(congratulations|you (have )?won|winner|lottery|prize|jackpot|guaranteed (returns?|profit)|double your|free (money|gift|iphone)|100% (profit|return))\b/i,
  impersonation: /\b(officer|police|cbi|irs|hmrc|iras|cpf|dbs|ocbc|uob|paypal (security|team|support)|customs|court|arrest warrant|your (bank|account) (team|officer)|microsoft support|amazon security|from (the )?(government|ministry)|(ceo|director|managing director|finance (head|director)) (here|asked|needs))\b/i,
  urgency_secrecy: /\b(urgent(ly)?|immediately|within (24|12|48) hours|today only|final (notice|warning)|act now|last chance|do not (tell|share|inform)|keep (this|it) (confidential|secret|between us)|expires? (today|soon|in)|suspended|blocked|blacklist|before (the )?(end of day|eod|close of business))\b/i,
};

/** Plain words for each tactic, used on screen and in the owner's notification. */
export const TACTIC_WORDS: Record<Tactic, string> = {
  impersonation: "claims to be an authority, a bank or your boss",
  urgency_secrecy: "pushes you to act fast or keep it quiet",
  changed_details: "asks you to pay to new bank or PayPal details",
  off_platform: "asks to pay outside PayPal or move the chat elsewhere",
  gift_cards_crypto: "asks for gift cards or crypto",
  fee_to_release: "asks for a fee to release money or goods",
  otp_or_link: "asks for a code or sends a link to click",
  overpay_refund: "says they overpaid and want the difference back",
  too_good: "promises a prize or guaranteed profit",
};

/** A one-time code, password or card number mentioned anywhere is a hard stop (§4.1 last bullet). */
const SECRET_RE = /\b(otp|one[- ]time (code|password)|verification code|password|passcode|cvv|card number|full card)\b/i;

export interface TextScan {
  tactics: Record<Tactic, boolean>;
  fired: Tactic[];
  secretsRequested: boolean;
  /** Tactic flags as 0/1 features for the risk model (t_<tactic>). */
  features: Record<string, number>;
}

const TACTIC_FEATURE: Record<Tactic, string> = { impersonation: "t_impersonation", urgency_secrecy: "t_urgency", changed_details: "t_changed_details", off_platform: "t_off_platform", gift_cards_crypto: "t_gift_crypto", fee_to_release: "t_fee", otp_or_link: "t_otp_link", overpay_refund: "t_overpay", too_good: "t_too_good" };

export function scanText(text: string | null | undefined): TextScan {
  const t = (text ?? "").slice(0, 4000);
  const tactics = Object.fromEntries(TACTICS.map((k) => [k, SEEDS[k].test(t)])) as Record<Tactic, boolean>;
  const fired = TACTICS.filter((k) => tactics[k]);
  // Feature names match guard-lab/scripts/train_risk.py (the exported forest's vocabulary), not the tactic ids.
  const features = Object.fromEntries(TACTICS.map((k) => [TACTIC_FEATURE[k], tactics[k] ? 1 : 0]));
  return { tactics, fired, secretsRequested: SECRET_RE.test(t), features };
}

export interface PayeeContext {
  /** Days since the payee record was created; null when unknown (legacy rows are treated as established). */
  payeeAgeDays: number | null;
  /** Days since the payee's payment details last changed; null when never changed. */
  detailsChangedDaysAgo: number | null;
  /** Where the latest detail change came from: the owner's own edit, or a message someone sent in. */
  detailsChangeSource: "owner" | "message" | null;
  amountCents: number;
  /** Median of this payee's previous payments, null when there is no history. */
  historyMedianCents: number | null;
  /** Payments to new payees in the last ten minutes, and the 24 h sum relative to a normal day. */
  velocity10m: number;
  velocity24hSumRatio: number;
  requestChannelUntrusted: boolean;
  /** Local hour 0-23 at the business. */
  hourLocal: number;
  text?: string | null;
}

export interface RuleResult {
  level: Level;
  /** The rule that set the level, for the policy tag (safety.<rule>). */
  rule: string | null;
  reasons: string[];
  scan: TextScan;
  /** Features in the risk model's vocabulary (train_risk.py FEATS). */
  features: Record<string, number>;
}

export function payeeRules(ctx: PayeeContext): RuleResult {
  const reasons: string[] = [];
  let level: Level = "clear";
  let rule: string | null = null;
  const raise = (to: Level, r: string, why: string) => {
    reasons.push(why);
    if (to === "hold" && level !== "hold") (level = "hold"), (rule = r);
    else if (to === "caution" && level === "clear") (level = "caution"), (rule = r);
  };
  const scan = scanText(ctx.text);
  const ratio = ctx.historyMedianCents && ctx.historyMedianCents > 0 ? ctx.amountCents / ctx.historyMedianCents : 1;

  if (ctx.detailsChangedDaysAgo !== null && ctx.detailsChangedDaysAgo <= 14) {
    if (ctx.detailsChangeSource === "message") raise("hold", "details_changed_from_message", `This payee's payment details were changed ${days(ctx.detailsChangedDaysAgo)} from a message someone sent in, not by you in the record.`);
    else raise("caution", "details_changed_recently", `This payee's payment details changed ${days(ctx.detailsChangedDaysAgo)}.`);
  }
  if (ctx.payeeAgeDays !== null && ctx.payeeAgeDays < 7) raise(ctx.amountCents >= 20000 ? "hold" : "caution", "new_payee", `First payment to a payee added ${days(ctx.payeeAgeDays)}.`);
  if (ctx.historyMedianCents && ratio >= 3) raise("hold", "amount_vs_history", `${(ratio).toFixed(1)}× this payee's usual payment.`);
  else if (ctx.historyMedianCents && ratio >= 2) raise("caution", "amount_vs_history", `${ratio.toFixed(1)}× this payee's usual payment.`);
  if (ctx.velocity10m >= 3) raise("hold", "velocity", `${ctx.velocity10m} payments to new payees in the last ten minutes.`);
  if (ctx.requestChannelUntrusted) raise("caution", "untrusted_channel", "The request to pay arrived through a pasted email or inbound message.");
  if (scan.secretsRequested) raise("hold", "secret_requested", "The message asks for a one-time code, password or card number. Nobody legitimate needs those.");
  if (scan.fired.includes("changed_details") && (ctx.requestChannelUntrusted || ctx.detailsChangeSource === "message")) raise("hold", "changed_details_in_message", "The message itself asks you to pay to new account details.");
  for (const t of scan.fired) if (!reasons.some((r) => r.includes(TACTIC_WORDS[t]))) raise(["gift_cards_crypto", "fee_to_release", "overpay_refund"].includes(t) ? "hold" : "caution", `tactic_${t}`, `The message ${TACTIC_WORDS[t]}.`);
  if (ctx.hourLocal < 6 || ctx.hourLocal >= 23) raise("caution", "odd_hour", "This is outside the business's usual hours.");

  const features: Record<string, number> = {
    amount_ratio_to_history: ratio,
    payee_age_days: ctx.payeeAgeDays ?? 365,
    details_changed_recently: ctx.detailsChangedDaysAgo !== null && ctx.detailsChangedDaysAgo <= 30 ? 1 : 0,
    request_channel_untrusted: ctx.requestChannelUntrusted ? 1 : 0,
    hour_local: ctx.hourLocal,
    velocity_10m: ctx.velocity10m,
    velocity_24h_sum_ratio: ctx.velocity24hSumRatio,
    method_new: ctx.detailsChangedDaysAgo !== null && ctx.detailsChangedDaysAgo <= 30 ? 1 : 0,
    ...scan.features,
  };
  return { level, rule, reasons, scan, features };
}

const days = (d: number) => (d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.round(d)} days ago`);

export const maxLevel = (...ls: Level[]): Level => (ls.includes("hold") ? "hold" : ls.includes("caution") ? "caution" : "clear");
