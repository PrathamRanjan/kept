/**
 * Scam protection inside the flow: the card that appears on the screen where money moves, and the flag on a message.
 * A hold shows its reasons in plain words and, when an approval is waiting, Approve and Decline right there.
 * Hand-copied into each app's src/web/safetyui.ts.
 */
import { html, raw, type Raw } from "./html.js";
import { icon } from "./icons.js";
import { scanText, TACTIC_WORDS } from "../safety/rules.js";

export interface GuardView { level: string; reasons: string[] }

const HEAD: Record<string, [string, string]> = {
  hold: ["shieldAlert", "Paused for your safety"],
  caution: ["alert", "Check before you pay"],
  clear: ["shieldCheck", "Checked: no scam signals"],
};

/** The in-flow card. `approve` posts to `${approve}/approve|decline` with `next` so the owner stays on this screen. */
export function guardCard(a: GuardView, opts: { approve?: string | null; next?: string; doText?: string; showClear?: boolean; title?: string } = {}): Raw {
  if (a.level === "clear" && !opts.showClear) return raw("");
  const [ic, title] = HEAD[a.level] ?? HEAD.caution;
  const reasons = a.reasons.filter(Boolean).slice(0, 4);
  const doText = opts.doText ?? (a.level === "hold" ? "Confirm with the other person on a phone number you already have, not one from the message. If it's genuine, approve it here." : a.level === "caution" ? "Nothing is stopped, but read this before you continue." : "");
  return html`<div class="guard-card ${a.level}" role="${a.level === "hold" ? "alert" : "status"}"><div class="gc-head">${raw(icon(ic))}${opts.title ? html`<span>${opts.title}<small class="gc-level">${title}</small></span>` : title}</div>${reasons.length ? html`<ul>${reasons.map((r) => html`<li>${r}</li>`)}</ul>` : ""}${doText ? html`<p class="gc-do">${doText}</p>` : ""}${opts.approve ? html`<div class="row"><form method="post" action="${opts.approve}/approve" class="inline"><input type="hidden" name="next" value="${opts.next ?? ""}"><button class="btn small primary" type="submit">I've checked: approve</button></form><form method="post" action="${opts.approve}/decline" class="inline"><input type="hidden" name="next" value="${opts.next ?? ""}"><button class="btn small" type="submit">Cancel the payment</button></form></div>` : ""}</div>`;
}

const INJECTION = /\b(ignore|disregard|forget)\b[^.]{0,30}\b(previous|prior|above|earlier|all)\b[^.]{0,20}\b(instructions?|rules|prompts?)\b|\bsystem prompt\b|\byou are now\b|\bact as (the )?(owner|admin|operator)\b/i;

/** A flag shown on a message as it is displayed: the tactics it uses, in plain words. Empty when the message is clean. */
export function messageFlag(text: string, context = "Only pay through the app; nothing in a message changes where money goes."): Raw {
  const s = scanText(text ?? "");
  const words: string[] = s.fired.map((t) => TACTIC_WORDS[t]);
  // Text that tries to instruct the software ("ignore previous instructions…") is shown as information only.
  const injection = INJECTION.test(text ?? "");
  if (injection) words.push("tries to give the app instructions, which it ignores");
  if (!words.length) return raw("");
  const serious = injection || s.fired.some((t) => ["changed_details", "off_platform", "gift_cards_crypto", "fee_to_release", "overpay_refund", "otp_or_link"].includes(t));
  return html`<div class="msg-flag ${serious ? "" : "caution"}" role="note">${raw(icon(serious ? "shieldAlert" : "alert"))}<span><b>${serious ? (injection && !s.fired.length ? "Suspicious:" : "Possible scam:") : "Careful:"}</b> this message ${words.join(", and ")}. ${context}</span></div>`;
}

/** Safe redirect target from a form's `next` field. */
export const nextOf = (v: unknown, fallback: string) => {
  const n = String(v ?? "");
  return n.startsWith("/") && !n.startsWith("//") ? n : fallback;
};
