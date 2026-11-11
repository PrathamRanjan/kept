/**
 * Safety layer for Kept (SAFETY_ACCESSIBILITY_SPEC §4, §6 Kept row). The people at risk are subscribers, including
 * older people who forget: a fake "your subscription payment failed, pay here" message is the classic bait, and a
 * refund steered to a different account is the classic redirect. Kept never sends a pay-here link, so the rule is
 * simple to state; the gate pauses an agent's or the worker's refund when the subscriber's own messages ask for it to
 * go elsewhere, and protected mode (per merchant) holds every agent money move and offer for the owner.
 * Rules (A) and the synthetic-data risk model (C) run here; the browser text model (B) only explains messages.
 * Reads the database only; never imports the PayPal client or the service layer.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import { maxLevel, payeeRules, scanText, TACTIC_WORDS, type Level, type PayeeContext, type RuleResult, type Tactic } from "./rules.js";
import { riskLevel, riskScore } from "./risk.js";

export interface Assessment {
  level: Level;
  rule: string | null;
  reasons: string[];
  risk: number;
  tactics: Tactic[];
  summary: string;
}

const REDIRECT = /\b(refund|money|send|pay|transfer)\b[^.]{0,80}\b(other|different|new|another|my (friend|partner|husband|wife|son|daughter)'?s?)\s+(account|card|paypal|bank|number|email)/i;

/** Assess an agent's or the worker's capture, invoice, refund or offer for a subscriber. */
export async function assessMove(m: { action: string; merchantId: string; entity: string; entityId: string; cents: number }, q?: Queryable): Promise<Assessment> {
  const db = q ?? (await getDb());
  const subId = m.entity === "subscriber" ? m.entityId : m.entity === "offer" ? (await db.query<{ subscriber_id: string }>("SELECT subscriber_id FROM offers WHERE id = $1", [m.entityId])).rows[0]?.subscriber_id ?? null : null;
  const inbound = subId ? (await db.query<{ body: string }>("SELECT cm.body FROM channel_messages cm JOIN party_links pl ON pl.channel = cm.channel AND pl.address = cm.address WHERE cm.direction = 'in' AND pl.party = 'subscriber' AND pl.party_id = $1 ORDER BY cm.created_at DESC LIMIT 20", [subId])).rows.map((r) => r.body) : [];
  const feedback = subId ? (await db.query<{ text: string }>("SELECT text FROM feedback WHERE subscriber_id = $1 ORDER BY created_at DESC LIMIT 10", [subId]).catch(() => ({ rows: [] as { text: string }[] }))).rows.map((r) => r.text) : [];
  const text = [...inbound, ...feedback].join("\n");
  const ctx = await moveContext(db, m, subId);
  const res = payeeRules({ ...ctx, amountCents: Math.max(1, m.cents), text: text || null });
  const out = combine(res);
  // A subscriber's words carry tactics only as cautions; asking for the refund to go elsewhere holds the refund.
  if (out.level === "hold" && (out.rule?.startsWith("tactic_") || out.rule === "amount_vs_history")) out.level = "caution";
  if (m.action === "refund" && (REDIRECT.test(text) || res.scan.fired.includes("changed_details"))) {
    out.level = "hold";
    out.rule = "refund_to_other_account";
    out.reasons.unshift("The subscriber asked for the refund to go to a different account or card. Refunds go back to the PayPal payment they came from; a person should reply before anything moves.");
  }
  const prot = await protectedMode(m.merchantId, db);
  if (prot.on && out.level !== "hold") {
    out.level = "hold";
    out.rule = "protected_money";
    out.reasons.unshift(`Protected mode is on: every ${m.action} by an agent or the worker waits for the owner.`);
  }
  out.summary = out.level === "clear" ? `no scam signals; risk ${(out.risk * 100).toFixed(0)}%` : `${out.level}: ${out.reasons[0]} (risk ${(out.risk * 100).toFixed(0)}%)`;
  return out;
}

const MONEY_GATES = ["gate.refund", "gate.capture", "gate.invoice"];

/**
 * The payment-context inputs for the scam rules and the risk model, all read from this shop's own records:
 * - payee age: days since this member joined (refunds, captures and invoices all go to or from the member);
 * - history: the median of the shop's real (non-sample) completed payments;
 * - velocity: money moves this shop's gate saw in the last 10 minutes, and the last 24 h against its 30-day daily mean;
 * - hour: the hour now in the shop's time zone (merchants.time_zone). With no time zone set, the time-of-day
 *   signal is skipped (hour passed as midday, so the odd-hour rule cannot fire) rather than guessed.
 * Kept stores no payout details, so "details changed" is always null: a refund can only go back to the PayPal
 * payment it came from. Moves reach the gate from the owner, the worker or a signed-in agent, never from a
 * pasted message, so the request channel is trusted here; message text is scanned separately.
 */
export async function moveContext(db: Queryable, m: { merchantId: string; cents: number }, subId: string | null): Promise<Omit<PayeeContext, "amountCents" | "text">> {
  const sub = subId ? (await db.query<{ started_at: Date | null; created_at: Date }>("SELECT started_at, created_at FROM subscribers WHERE id = $1", [subId])).rows[0] : undefined;
  const since = sub ? new Date(sub.started_at ?? sub.created_at).getTime() : null;
  const payeeAgeDays = since === null ? null : Math.max(0, (Date.now() - since) / 864e5);
  const history = (await db.query<{ a: string }>("SELECT amount AS a FROM payments WHERE merchant_id = $1 AND NOT is_sample AND upper(status) IN ('COMPLETED','SUCCEEDED') ORDER BY paid_at DESC LIMIT 200", [m.merchantId])).rows.map((r) => Math.round(Number(r.a) * 100)).sort((a, b) => a - b);
  const historyMedianCents = history.length ? history[Math.floor(history.length / 2)] : null;
  const v = (await db.query<{ m10: number; d1: number; d30: number }>(
    `SELECT count(*) FILTER (WHERE t.at > now() - interval '10 minutes')::int AS m10,
            count(*) FILTER (WHERE t.at > now() - interval '1 day')::int AS d1,
            count(*) FILTER (WHERE t.at > now() - interval '31 days' AND t.at <= now() - interval '1 day')::int AS d30
       FROM agent_trace t JOIN agent_runs r ON r.id = t.run_id
      WHERE r.merchant_id = $1 AND t.tool = ANY($2) AND t.at > now() - interval '31 days'`,
    [m.merchantId, MONEY_GATES],
  )).rows[0] ?? { m10: 0, d1: 0, d30: 0 };
  const dailyMean = Number(v.d30) / 30;
  const velocity24hSumRatio = dailyMean > 0 ? Number(v.d1) / dailyMean : Number(v.d1) > 3 ? Number(v.d1) : 1;
  const tz = (await db.query<{ time_zone: string | null }>("SELECT time_zone FROM merchants WHERE id = $1", [m.merchantId])).rows[0]?.time_zone ?? null;
  return { payeeAgeDays, detailsChangedDaysAgo: null, detailsChangeSource: null, historyMedianCents, velocity10m: Number(v.m10), velocity24hSumRatio, requestChannelUntrusted: false, hourLocal: tz ? hourIn(tz) : 12 };
}

export function hourIn(tz: string, at = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(at));
  } catch {
    return at.getUTCHours();
  }
}

function combine(res: RuleResult): Assessment {
  let risk = 0;
  let modelOk = true;
  try {
    risk = riskScore(res.features);
  } catch {
    modelOk = false;
  }
  // If the risk model can't score, the rules still decide, and the reasons say the model gave no score.
  const level = modelOk ? maxLevel(res.level, riskLevel(risk)) : res.level;
  const reasons = res.reasons.slice();
  if (!modelOk) reasons.push("The payment-risk model gave no score this time; only the rules decided.");
  const rule = res.rule ?? (level !== "clear" ? "risk_model" : null);
  if (res.level === "clear" && level !== "clear") reasons.push(`The payment-risk model scores this ${(risk * 100).toFixed(0)}% (synthetic training data; a ranking signal, not a fraud rate).`);
  const summary = level === "clear" ? `no scam signals; risk ${(risk * 100).toFixed(0)}%` : `${level}: ${reasons[0]} (risk ${(risk * 100).toFixed(0)}%)`;
  return { level, rule, reasons, risk, tactics: res.scan.fired, summary };
}

const FAKE_FAILED = /\b(subscription|membership|payment|renewal|direct debit|card)\b[\s\S]{0,80}\b(failed|declined|unsuccessful|could not be (taken|processed)|was not successful|has been suspended|will be cancelled)\b[\s\S]{0,200}\b(pay (here|now)|update your (card|payment|details)|re-?enter your card|click|tap|http|www\.|link)/i;

const MESSAGE_ONLY: Omit<PayeeContext, "text"> = { payeeAgeDays: null, detailsChangedDaysAgo: null, detailsChangeSource: null, amountCents: 1, historyMedianCents: null, velocity10m: 0, velocity24hSumRatio: 1, requestChannelUntrusted: true, hourLocal: 12 };

/** A message a subscriber or owner received or pasted. Rules only on the server; the browser adds the text model. */
export function assessMessage(text: string): Assessment & { words: string[] } {
  const scan = scanText(text);
  // A pasted message has no payment behind it, so the payment-context signals are switched off on purpose
  // (no payee, no amount, no velocity; hour set to midday so the odd-hour rule cannot fire). Only the words count.
  const res = payeeRules({ ...MESSAGE_ONLY, text });
  const out = combine(res);
  out.reasons = out.reasons.filter((r) => !r.startsWith("The request to pay arrived"));
  if (FAKE_FAILED.test(text)) {
    out.level = "hold";
    out.rule = "fake_failed_payment";
    out.reasons.unshift("The message says a payment failed and sends you somewhere to pay. Kept never sends a \"pay here\" link: a real failed payment shows on your own subscription page, reached from your bookmark or the shop's site, never from a message.");
  }
  if (out.reasons.length === 0) out.level = "clear";
  out.summary = out.level === "clear" ? "no scam signals" : `${out.level}: ${out.reasons[0]}`;
  return { ...out, words: scan.fired.map((t) => TACTIC_WORDS[t]) };
}

/** Protected mode (§4.5) per merchant. */
export async function protectedMode(merchantId: string, q?: Queryable): Promise<{ on: boolean; contacts: string[] }> {
  const db = q ?? (await getDb());
  const r = (await db.query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [`protected:${merchantId}`])).rows[0];
  if (!r) return { on: false, contacts: [] };
  try {
    return JSON.parse(r.value);
  } catch {
    return { on: false, contacts: [] };
  }
}
export async function setProtectedMode(merchantId: string, on: boolean, contacts: string[], q?: Queryable) {
  const db = q ?? (await getDb());
  await db.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [`protected:${merchantId}`, JSON.stringify({ on, contacts: contacts.filter(Boolean).slice(0, 2) })]);
}

/** Holds the safety layer created for this merchant, newest first. */
export async function safetyHolds(merchantId: string, q?: Queryable) {
  const db = q ?? (await getDb());
  return (await db.query<any>("SELECT * FROM approvals WHERE merchant_id = $1 AND payload->>'safety_rule' IS NOT NULL ORDER BY created_at DESC LIMIT 20", [merchantId])).rows.map((r) => ({ ...r, payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload }));
}
