import { randomBytes, createHash } from "node:crypto";

const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789";

/** Short random id with a readable prefix, e.g. sub_k3x9... */
export function newId(prefix: string, len = 16): string {
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Deterministic key for PayPal-Request-Id so a retried action never repeats at PayPal. */
export function requestKey(...parts: (string | number | undefined | null)[]): string {
  return createHash("sha256").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 36);
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "shop";
}
