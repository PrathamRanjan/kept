/**
 * Grounding and quarantine helpers (roadmap B.1). A model may only report a value it can point at in the
 * source text; anything it cannot quote is dropped and flagged. Instruction-shaped text found inside a cancel
 * reason or a message is quarantined: shown to the owner, never forwarded to any tool or offer step.
 */
export interface Grounded<T> {
  value: T | null;
  quote: string | null;
  grounded: boolean;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[“”"']/g, "").trim();

/** Keeps `value` only when `quote` (the model's own citation) appears in the source text. */
export function ground<T>(value: T | null, quote: string | null | undefined, sourceText: string): Grounded<T> {
  if (value === null || value === undefined) return { value: null, quote: null, grounded: false };
  if (!quote || !quote.trim()) return { value: null, quote: null, grounded: false };
  const ok = norm(sourceText).includes(norm(quote));
  return ok ? { value, quote, grounded: true } : { value: null, quote, grounded: false };
}

const INSTRUCTION_PATTERNS = [
  /\b(ignore|disregard|forget|skip|bypass|override)\b.{0,40}\b(instructions?|rules?|policy|policies|above|previous|limits?|checks?|eligibility)\b/i,
  /\b(give|apply|grant|offer|make)\b.{0,30}\b(\d{1,3}\s?%|free|discount|refund)\b.{0,40}\b(now|immediately|regardless|anyway|without)\b/i,
  /\b(you are|act as|pretend|system prompt|assistant|as an ai|language model|developer mode)\b/i,
  /\b(mark|set|treat|consider)\b.{0,30}\b(as (approved|accepted|cancelled|paid|eligible|verified|owner))\b/i,
  /\b(system|assistant|developer|owner)\s*:/i,
  /\b(the owner|merchant|shop) (said|agreed|approved|authori[sz]ed)\b.{0,40}\b(discount|refund|free|%)/i,
  /\bcancel (someone else'?s|another|all) subscription/i,
];

/** Lines of a message that read as instructions to a reader or a machine rather than as data. */
export function quarantine(text: string): { clean: string; quarantined: string[] } {
  const quarantined: string[] = [];
  const kept: string[] = [];
  for (const line of text.split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/)) {
    if (INSTRUCTION_PATTERNS.some((re) => re.test(line))) quarantined.push(line.trim());
    else kept.push(line);
  }
  return { clean: kept.join(" ").replace(/\s+/g, " ").trim(), quarantined };
}
