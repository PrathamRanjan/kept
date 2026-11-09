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
import { maxLevel, payeeRules, scanText, TACTIC_WORDS, type Level, type RuleResult, type Tactic } from "./rules.js";
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
  const history = (await db.query<{ c: string }>("SELECT amount_cents AS c FROM payments WHERE merchant_id = $1 AND kind = $2 AND status = 'succeeded'", [m.merchantId, m.action]).catch(() => ({ rows: [] as { c: string }[] }))).rows.map((r) => Number(r.c));
  const med = history.length ? history.slice().sort((a, b) => a - b)[Math.floor(history.length / 2)] : null;
  const res = payeeRules({ payeeAgeDays: null, detailsChangedDaysAgo: null, detailsChangeSource: null, amountCents: Math.max(1, m.cents), historyMedianCents: med, velocity10m: 0, velocity24hSumRatio: 1, requestChannelUntrusted: false, hourLocal: 12, text: text || null });
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

function combine(res: RuleResult): Assessment {
  let risk = 0;
  try {
    risk = riskScore(res.features);
  } catch {
    risk = 0;
  }
  const level = maxLevel(res.level, riskLevel(risk));
  const reasons = res.reasons.slice();
  const rule = res.rule ?? (level !== "clear" ? "risk_model" : null);
  if (res.level === "clear" && level !== "clear") reasons.push(`The payment-risk model scores this ${(risk * 100).toFixed(0)}% (synthetic training data; a ranking signal, not a fraud rate).`);
  const summary = level === "clear" ? `no scam signals; risk ${(risk * 100).toFixed(0)}%` : `${level}: ${reasons[0]} (risk ${(risk * 100).toFixed(0)}%)`;
  return { level, rule, reasons, risk, tactics: res.scan.fired, summary };
}

const FAKE_FAILED = /\b(subscription|membership|payment|renewal|direct debit|card)\b[\s\S]{0,80}\b(failed|declined|unsuccessful|could not be (taken|processed)|was not successful|has been suspended|will be cancelled)\b[\s\S]{0,200}\b(pay (here|now)|update your (card|payment|details)|re-?enter your card|click|tap|http|www\.|link)/i;

/** A message a subscriber or owner received or pasted. Rules only on the server; the browser adds the text model. */
export function assessMessage(text: string): Assessment & { words: string[] } {
  const scan = scanText(text);
  const res = payeeRules({ payeeAgeDays: null, detailsChangedDaysAgo: null, detailsChangeSource: null, amountCents: 1, historyMedianCents: null, velocity10m: 0, velocity24hSumRatio: 1, requestChannelUntrusted: true, hourLocal: 12, text });
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
